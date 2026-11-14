# ClickHouse: query engine, server and cluster layer

Source: `upstream/clickhouse` at commit `1b7851acb7ca` (2026-11-14). All paths are relative to that directory. Claims come
from `src/` and `programs/` unless marked **[docs]**. Line numbers are for this commit and will drift. MergeTree storage on
disk, codecs, skip indexes, merges, TTL and disks are out of scope (another report covers them).

## Summary

A ClickHouse query is parsed into an AST, rewritten by the new analyzer into a typed query tree (the old interpreter can
no longer be selected), planned into a tree of `QueryPlan` steps, optimized, and then expanded into a graph of
processors that a small pool of threads drives by calling `prepare()` and `work()`. Data moves as `Chunk`s of whole
columns, so every function and aggregate runs over arrays of values, not rows. Aggregation uses a hash table picked by
key type, turns into a 256-bucket two-level table when it grows, and spills to disk when it crosses a memory share. An
aggregate state is a first-class value (`-State`, `-Merge`), which is what lets shards send partial results and lets a
table store pre-aggregated rollups. A Distributed table is a thin proxy: the initiator rewrites the query, sends it to
one replica per shard with the stage "with mergeable state", reads back aggregate states over the native protocol, and
merges them. Replication is a log of part-level operations in Keeper (a NuRaft-based ZooKeeper replacement); parts
themselves move between replicas over HTTP. The server already records what an observability system wants about itself
(`system.query_log`, `trace_log`, `metric_log`, `opentelemetry_span_log`, a Prometheus endpoint, W3C `traceparent`
propagation). For Clickland the advice is: run ClickHouse as-is as the store and query engine, do not reimplement any of
this, and put the effort into a query layer that writes queries that hit these mechanisms well: time-bucketed
`GROUP BY` on a `DateTime` key, sketches instead of exact distinct counts and quantiles, literal or grid-rounded time
bounds so the caches work, and per-user settings profiles, quotas and workloads to protect the cluster from the UI.

---

## 1. A query end to end

### How it works

1. **Entry.** Every protocol ends in `executeQuery`. HTTP calls the `ReadBuffer`/`WriteBuffer` overload
   (`src/Interpreters/executeQuery.cpp:4655`); TCP calls the one that returns `BlockIO` (`:4277`). Both go to
   `executeQueryImpl` (`:2495`).
2. **Parsing.** A hand-written recursive-descent parser. `Lexer` (`src/Parsers/Lexer.h:119`, `Lexer::nextToken`
   `src/Parsers/Lexer.cpp:116`) produces tokens; `ParserQuery::parseImpl` (`src/Parsers/ParserQuery.cpp:104`) dispatches
   to `ParserSelectQuery::parseImpl` (`src/Parsers/ParserSelectQuery.cpp:325`) and friends. `IParser::Pos`
   (`src/Parsers/IParser.h:124`) carries `max_depth` and `max_backtracks` guards. `parseQuery` is at
   `src/Parsers/parseQuery.cpp:700`. The result is an AST (`ASTSelectWithUnionQuery`).
3. **Admission.** The query is registered in the `ProcessList` (`executeQuery.cpp:3217`, `ProcessList::insert`
   `src/Interpreters/ProcessList.cpp:175`), which enforces `max_concurrent_queries*` and throws
   `TOO_MANY_SIMULTANEOUS_QUERIES` (`ProcessList.cpp:256`). The query result cache is probed here (section 3).
4. **Interpreter.** `InterpreterFactory` maps every SELECT form to `InterpreterSelectQueryAnalyzer`
   (`src/Interpreters/InterpreterFactory.cpp:141-153`). The old `InterpreterSelectQuery` still exists in the tree, but the
   setting `allow_experimental_analyzer`/`enable_analyzer` is documented as "Obsolete since v26.9: the analyzer cannot be
   disabled anymore" (`src/Core/Settings.cpp:10149`).
5. **Analyzer.** `buildQueryTreeAndRunPasses` (`src/Interpreters/InterpreterSelectQueryAnalyzer.cpp:420`) converts the
   AST into a query tree (`QueryNode`, `TableNode`, `FunctionNode`, `ColumnNode`, `ConstantNode`), then runs
   `QueryAnalysisPass`. `QueryAnalyzer::resolve` (`src/Analyzer/Resolve/QueryAnalyzer.cpp:437`) resolves identifiers
   (aliases, CTEs, parent scopes, tables: `tryResolveIdentifier` `:1813`), the join tree (`:7072`) and the query
   (`resolveQuery` `:7512`), assigns types, and folds constants. A constant keeps its source expression only for
   `EXPLAIN` and formatting (`src/Analyzer/ConstantNode.cpp:208-215`); the default AST conversion prints the literal
   (`use_source_expression_for_constants = false`, `src/Analyzer/IQueryTreeNode.h:85`). After resolution about 45
   rewrite passes run (`addQueryTreePasses`, `src/Analyzer/QueryTreePassManager.cpp:287`): for example
   `OptimizeDateOrDateTimeConverterWithPreimagePass`, `UniqToCountPass`, `RewriteAggregateFunctionWithIfPass`,
   `SumIfToCountIfPass`, `OptimizeGroupByFunctionKeysPass`, `TruncateOrderByAfterGroupByKeysPass`, `ConvertOrLikeChainPass`,
   `LikePerfectAffixRewritePass`, `LogicalExpressionOptimizerPass`. On a shard (`SECONDARY_QUERY`) only the resolve pass
   runs, because the rewrites could change the header the initiator expects (`InterpreterSelectQueryAnalyzer.cpp:439-448`).
6. **Planner.** `Planner::buildPlanForQueryNode` (`src/Planner/Planner.cpp:2995`) first builds the join tree plan
   (`buildJoinTreeQueryPlan`, `:3214`; storage reads in `src/Planner/PlannerJoinTree.cpp:2754-2866`). The storage tells
   the planner up to which stage it already processed the data (`from_stage`, `Planner.cpp:3221`). The planner then
   appends steps only for the stages that are left: `addAggregationStep` (`:990`, called at `:3336`),
   `addMergingAggregatedStep` (`:1065`, used when the source returns mergeable state, `:3277`, `:3427`), `addWindowSteps`
   (`:2045`), `addSortingStep` (`:1454`, used at `:3546`), `addLimitByStep` (`:1688`, `:3584`), `addWithFillStepIfNeeded`
   (`:1549`, `:3596`), `addLimitStep` (`:2123`).
7. **Plan optimization.** `QueryPlan::optimize` (`src/Processors/QueryPlan/QueryPlan.cpp:977`) runs
   `optimizeTreeFirstPass` (`src/Processors/QueryPlan/Optimizations/optimizeTree.cpp:123`), a rule loop over the list in
   `Optimizations.h:280-309` (push down limit, split/merge filters, push down filter, merge expressions, lift up array
   join, top-K, convert outer to inner join, and more, each gated by a setting). `optimizeTreeSecondPass` (`:291`) does
   the storage-aware work: primary key condition and limit (`:322`), `optimizePrewhere` (`:484`), lazy materialization
   (`:518`), `optimizeReadInOrder` (`:541`), aggregate projections (`:619`), aggregation in order (`:631`, `:678`). Last,
   `considerEnablingParallelReplicas` (`:1040`).
8. **Pipeline build.** `QueryPlan::buildQueryPipeline` (`QueryPlan.cpp:246`) asks each step to `transformPipeline`, which
   adds processors to a `QueryPipelineBuilder` (`src/QueryPipeline/QueryPipelineBuilder.h`). A source step decides the
   width (number of parallel streams, up to `max_threads`); steps like `AggregatingStep::transformPipeline`
   (`src/Processors/QueryPlan/AggregatingStep.cpp:595`) add one processor per stream plus a merging processor.
9. **Execution.** HTTP attaches the output format as the pipeline sink (`pipeline.complete(output_format)`,
   `executeQuery.cpp:5058`) and runs `CompletedPipelineExecutor` (`:5084`). TCP pulls blocks with
   `PullingAsyncPipelineExecutor` (`src/Server/TCPHandler.cpp:1777`) and sends each as a `Data` packet.
   Both use `PipelineExecutor` (`src/Processors/Executors/Runtime/V1/PipelineExecutor.cpp`).
10. **Logging.** `logQueryStart` (`executeQuery.cpp:584`, called at `:3758`) and `logQueryFinish` (`:1032`) /
    `logQueryException` (`:1094`) write `system.query_log` rows and charge quotas.

### Processors, ports and the executor

- `IProcessor` (`src/Processors/IProcessor.h`) has a `Status prepare()` (`:195`) that only looks at ports and returns
  `NeedData`, `PortFull`, `Finished`, `Ready` or `Async` (`:150-168`), and a `work()` (`:207`) that does the computation.
  `prepare` is cheap and runs under the graph's lock; `work` runs unlocked on any thread. `schedule()` (`:223`) returns a
  file descriptor for `Async` processors (remote reads).
- `InputPort` / `OutputPort` (`src/Processors/Port.h:283`, `:407`) hold at most one `Chunk` each. That is the only
  buffering; back-pressure is "the output port is full".
- `ExecutingGraph` (`src/Processors/Executors/Runtime/V1/ExecutingGraph.cpp`) keeps the processor graph; `updateNode`
  (`:524`) walks from a processor whose ports changed, calls `prepare` on neighbours and pushes `Ready` ones into a task
  queue.
- `PipelineExecutor::initializeExecution` (`PipelineExecutor.cpp:693`) acquires CPU slots from `ConcurrencyControl`
  (`src/Common/ConcurrencyControl.h`), fills the task queue, and `spawnThreads` (`:729`) starts one thread per slot. Each
  thread runs `executeStepImpl` (`:417`): take a task, run `work`, update neighbours, prefer to keep running the next
  processor locally (cache-friendly), check the soft time limit (`checkTimeLimitSoft`) and spill notifications.
- Data units: `Block` (`src/Core/Block.h:32`) is columns with names and types (used for headers and at API edges);
  `Chunk` (`src/Processors/Chunk.h:62`) is just columns plus a row count plus `ChunkInfo` side data (for example the
  bucket number of two-level aggregation, or async insert info). The default block size is 65409 rows
  (`src/Core/Defines.h:33`).

### Diagram: SQL text to result blocks

```
 SQL text (HTTP body / native Query packet)
   |
   v
 executeQueryImpl ............................... src/Interpreters/executeQuery.cpp:2495
   |-- Lexer -> ParserQuery -> AST .............. src/Parsers/{Lexer,ParserQuery,ParserSelectQuery}.cpp
   |-- ProcessList::insert (limits, query_id) ... executeQuery.cpp:3217
   |-- query result cache probe ................. executeQuery.cpp:3439   (hit -> source from cache, done)
   `-- InterpreterSelectQueryAnalyzer
         |-- buildQueryTree(AST) -> query tree
         |-- QueryAnalysisPass: names, types, constant folding .. src/Analyzer/Resolve/QueryAnalyzer.cpp
         |-- ~45 rewrite passes ........................ src/Analyzer/QueryTreePassManager.cpp:287
         |-- Planner -> QueryPlan (tree of steps) ...... src/Planner/Planner.cpp:2995
         |      ReadFromMergeTree | ReadFromRemote
         |        -> Filter -> Expression -> Aggregating | MergingAggregated
         |        -> Sorting -> LimitBy -> Fill -> Limit
         |-- QueryPlan::optimize (rules, PREWHERE, read-in-order, projections)
         `-- buildQueryPipeline -> processors joined by ports
   |
   v
 BlockIO{QueryPipeline}
   |-- HTTP: pipeline.complete(OutputFormat) + CompletedPipelineExecutor
   `-- TCP : PullingAsyncPipelineExecutor -> Data packets
   |
   v
 PipelineExecutor: N threads (CPU slots), task queue, prepare()/work()
   |    source --Chunk--> transform --Chunk--> ... --Chunk--> sink
   v
 bytes on the socket; logQueryFinish -> system.query_log, quotas charged
```

### Main settings

| Setting | Default | Where |
|---|---|---|
| `max_query_size` | 262144 bytes | `src/Core/Defines.h:100`, `Settings.cpp:480` |
| `max_parser_depth` | `DBMS_DEFAULT_MAX_PARSER_DEPTH` | `Settings.cpp:6350` |
| `max_threads` | 0 = auto | `Settings.cpp:406` |
| `max_block_size` | 65409 | `Settings.cpp:171` |
| `query_plan_enable_optimizations` | true | `Settings.cpp:7958` |
| `optimize_move_to_prewhere` | true | `Settings.cpp:1188` |
| `optimize_aggregation_in_order` | false | `Settings.cpp:5282` |
| `compile_expressions` / `min_count_to_compile_expression` | true / 3 | `Settings.cpp:1516-1520` |
| `use_concurrency_control` | true | `Settings.cpp:444` |
| `concurrent_threads_soft_limit_ratio_to_cores` (server) | 2 | `src/Core/ServerSettings.cpp:1098` |
| `concurrent_threads_scheduler` (server) | `max_min_fair` | `ServerSettings.cpp:1106` |

`EXPLAIN QUERY TREE`, `EXPLAIN PLAN` and `EXPLAIN PIPELINE` show each stage (`src/Interpreters/InterpreterExplainQuery.cpp`).

### What Clickland should take from this

Use ClickHouse's planner as-is; the Clickland query layer should generate SQL text (not plans) and use
`EXPLAIN PLAN`/`EXPLAIN PIPELINE` in its own debug view. Copy the push model (small `prepare`, bounded one-chunk ports)
only if Clickland ever needs its own streaming engine.

---

## 2. Vectorized execution

### Columns and functions

- `IColumn` (`src/Columns/IColumn.h:139`) is a copy-on-write column (`COW<IColumn>`). Operations work on whole columns:
  `filter` (`:504`) takes a byte mask, `permute` (`:520`) takes a permutation, `insertFrom` (`:307`) copies one value,
  `updateHashWithValue` (`:453`) feeds a hash. Concrete columns are flat arrays (`ColumnVector<T>`), `ColumnString`
  (chars + offsets), `ColumnArray` (data + offsets), `ColumnNullable` (nested + null map), `ColumnLowCardinality`
  (dictionary + indexes), `ColumnConst` (one value, logical size N), `ColumnMap` (`src/Columns/ColumnMap.h:13`, a nested
  `Array(Tuple(key, value))`), `ColumnObject` for JSON (`src/Columns/ColumnObject.h:18`).
- A function is resolved once per query (`IFunctionOverloadResolver`, `src/Functions/IFunction.h:469`) into an
  `IFunctionBase` (`:190`) for the argument types, and executed through `IExecutableFunction::execute`
  (`src/Functions/IFunction.cpp:667`). Implementors write `executeImpl(arguments, result_type, input_rows_count)`
  (`IFunction.h:75`), which receives whole columns and returns a whole column.
- The wrapper handles common cases so `executeImpl` does not have to: constant arguments
  (`defaultImplementationForConstantArguments`, `IFunction.cpp:173`; opt-in via `useDefaultImplementationForConstants`,
  `IFunction.h:105`), `Nullable` (`defaultImplementationForNulls`, `IFunction.cpp:304`; on by default, `IFunction.h:93`)
  and `LowCardinality` (`executeWithoutLowCardinalityColumns`, `IFunction.cpp:520`; on by default, `IFunction.h:111`).
  `isDeterministic()` (`IFunction.h:343`) feeds the query cache, and `isSuitableForConstantFolding()` (`:285`) feeds the
  analyzer.
- `ExpressionActions::execute` (`src/Interpreters/ExpressionActions.cpp:1006`, `executeAction` `:841`) runs a DAG of
  function calls over a block. `FilterTransform::doTransform` (`src/Processors/Transforms/FilterTransform.cpp:613`)
  evaluates the predicate column and calls `IColumn::filter` on every column. With `compile_expressions` the DAG can be
  JIT-compiled with LLVM after it has been seen 3 times.

### Aggregation

- `Aggregator` (`src/Interpreters/Aggregator.cpp`, `Params` in `Aggregator.h:129`). One `AggregatingTransform`
  (`src/Processors/Transforms/AggregatingTransform.h:159`, `consume` `.cpp:1744`) per stream feeds
  `Aggregator::executeOnBlock` (`Aggregator.cpp:2492`), which calls `executeImpl` (`:1192`/`:1253`) and the batch loops
  `executeImplBatch` (`:1629`, `:1652`). Each key maps to one `AggregateDataPtr`: a block of bytes in an arena that holds
  all aggregate states for that group, laid out back to back.
- **Hash table choice.** `AggregatedDataVariants::chooseMethod` (`src/Interpreters/AggregatedDataVariants.cpp:405`,
  called at `Aggregator.cpp:849`) picks one of about 90 variants from `APPLY_FOR_AGGREGATED_VARIANTS`
  (`src/Interpreters/AggregatedDataVariants.h:210`): `key8`/`key16` (direct lookup tables), `key32`/`key64` (open
  addressing on the number), `key_string`, `key_fixed_string`, `keys128`/`keys256` (several fixed-size keys packed into
  one 128/256-bit key), `serialized` (anything else, keys serialized into the arena), plus `nullable_*` and
  `low_cardinality_*` variants. A single `DateTime` key is 4 bytes and gets `key32` (`AggregatedDataVariants.cpp:565`).
  A GROUP BY with no aggregates gets a `*_void` table that stores only keys (`Aggregator.cpp:856-873`). `count()` alone
  is special-cased (`is_simple_count`, `:820-824`).
- **Two-level aggregation.** When a table passes `group_by_two_level_threshold` rows (100000) or
  `group_by_two_level_threshold_bytes` (50 MB) (`worthConvertToTwoLevel`, `Aggregator.cpp:125`;
  conversion at `:2716-2723`), it is converted to a two-level table: 256 sub-tables chosen by 8 bits of the hash
  (`src/Common/HashTable/TwoLevelHashTable.h:31`). Buckets can then be merged in parallel and streamed one by one. The
  threshold is 0 when only one thread aggregates.
- **Merging.** After all input is consumed, the per-thread tables are merged (`prepareVariantsToMerge`, `:5840`) and
  converted to chunks by `ConvertingAggregatedToChunksTransform` (`AggregatingTransform.cpp:801`) and its sources (one
  per bucket for two-level). On the initiator of a distributed query, `MergingAggregatedTransform`
  (`src/Processors/Transforms/MergingAggregatedTransform.h:16`) or, with `distributed_aggregation_memory_efficient`, the
  bucket-by-bucket `GroupingAggregatedTransform` / `MergingAggregatedBucketTransform`
  (`src/Processors/Transforms/MergingAggregatedMemoryEfficientTransform.h:70`, `:125`) merge states coming from shards.
- **Spilling.** `executeOnBlock` checks `checkLimits` (`:3674`; `max_rows_to_group_by`, `group_by_overflow_mode`) and,
  past the external threshold, calls `writeToTemporaryFile` (`:2785`). That forces two-level (`:2858`) and writes each
  bucket's states to a temporary file in Native format. The final merge then reads bucket N from every file and the
  in-memory table together, so memory holds one bucket at a time. There is also an "adaptive" path
  (`src/Interpreters/AdaptiveAggregation/`) that spills a learning table (`Aggregator.cpp:2700-2707`).
- Other built-in shortcuts: `GROUP BY ... LIMIT` top-K inside aggregation (`aggregationBucketTopK.cpp`,
  `optimizeGroupByTopK.cpp`), aggregation in order of the sorting key (`optimize_aggregation_in_order`), and reading
  from aggregate projections (`optimizeUseAggregateProjection.cpp`).

### Aggregate function states and combinators

- `IAggregateFunction` (`src/AggregateFunctions/IAggregateFunction.h:81`) has `create` (`:177`), `add` (`:243`),
  `mergeImpl` (`:269`), `serialize` (`:369`), `deserialize` (`:385`), `insertResultInto` (`:404`) and vectorized
  `addBatch` (`:457`) / `addBatchSinglePlace` (`:502`). The state is opaque bytes in the arena; `serialize` is a stable
  binary format.
- Combinators wrap a function (`src/AggregateFunctions/Combinators/`):
  - `-State` (`AggregateFunctionState.h:30`): `insertResultInto` writes the state itself, so the result type is
    `AggregateFunction(f, T)` (`src/DataTypes/DataTypeAggregateFunction.h:19`, column `ColumnAggregateFunction`,
    `src/Columns/ColumnAggregateFunction.h:53`). This is what shards return at "mergeable state" and what an
    `AggregatingMergeTree` stores.
  - `-Merge` (`AggregateFunctionMerge.h:21`): takes `AggregateFunction(f, T)` values as input and merges them.
    `-MergeState` keeps the result as a state. `finalizeAggregation(state)` turns a state into a value
    (`src/Functions/finalizeAggregation.cpp:23`).
  - `-If` (`AggregateFunctionIf.h:30`): an extra UInt8 argument; `add` skips rows where it is 0. The
    `RewriteAggregateFunctionWithIfPass` and `SumIfToCountIfPass` rewrite common forms.
  - Others: `-Array`, `-ForEach`, `-Map`, `-Distinct`, `-OrNull`/`-OrDefault`, `-Resample`, `-SimpleState`, `-Null`
    (wraps `Nullable` inputs automatically).

### Main settings

| Setting | Default | Where |
|---|---|---|
| `group_by_two_level_threshold` | 100000 | `Settings.cpp:1557` |
| `group_by_two_level_threshold_bytes` | 50000000 | `Settings.cpp:1560` |
| `max_bytes_before_external_group_by` | 0 (off) | `Settings.cpp:3905` |
| `max_bytes_ratio_before_external_group_by` | 0.5 (spill at half the available memory; on since 25.1) | `Settings.cpp:3923` |
| `max_bytes_ratio_before_external_sort` | 0.5 | `Settings.cpp:3982` |
| `max_rows_to_group_by` / `group_by_overflow_mode` | 0 / `throw` (`any` keeps existing groups) | `Settings.cpp:3887`, `:3896` |
| `distributed_aggregation_memory_efficient` | true | `Settings.cpp:1568` |
| `max_temporary_data_on_disk_size_for_query` | 0 | `Settings.cpp:4893` |

### What Clickland should take from this

Store rollups as `AggregateFunction` columns (`countState`, `uniqCombinedState`, `quantileTDigestState`) and read them
with `-Merge`; the same state format is what the cluster ships between nodes, so a rollup is just a saved mergeable
stage. Design dashboard GROUP BY keys to be one fixed-width column (a `DateTime` bucket, or bucket plus a
`LowCardinality` service name) so the fast hash table variants apply.

---

## 3. Functions an observability UI leans on

### Time bucketing: `toStartOfInterval`

`FunctionToStartOfInterval` (`src/Functions/toStartOfInterval.cpp:222`, `executeImpl` `:263`) dispatches once per block
on the time type (`Date`, `Date32`, `DateTime`, `DateTime64`, `:291-297`) and on the interval unit (`:362-394`), then
runs a tight loop over the column. It accepts an optional origin (`toStartOfInterval(t, INTERVAL n unit, origin [, tz])`,
`:52`) and a time zone. Calendar math goes through `DateLUTImpl`. The result of a `DateTime` input is a `DateTime`
(4 bytes), which is the ideal GROUP BY key. `OptimizeDateOrDateTimeConverterWithPreimagePass` rewrites comparisons on
date converters into ranges on the raw column so the primary key can be used. `toStartOfInterval` is monotonic, so
read-in-order and aggregation-in-order can use it when the table is sorted by time.

### Quantiles

| Function | State | Where |
|---|---|---|
| `quantile` | reservoir sample of 8192 values, non-deterministic | `src/AggregateFunctions/ReservoirSampler.h:36`, `AggregateFunctionQuantile.cpp:33` |
| `quantileDeterministic` | reservoir with a user hash | `AggregateFunctionQuantileDeterministic.cpp` |
| `quantileExact*` | all values | `QuantileExact.h` |
| `quantileTiming` | exact for small counts, histogram, values capped at 30000 (ms) | `QuantileTiming.h:41-63` |
| `quantileTDigest` | t-digest, `epsilon = 0.01`, up to 2048 centroids | `QuantileTDigest.h:44`, `:85-86` |
| `quantileDD` | DDSketch with a relative-accuracy parameter, binary compatible with DataDog's protobuf | `QuantileDD.h:15-31`, `DDSketch.h:24` |
| `quantileGK` | Greenwald-Khanna | `AggregateFunctionQuantileGK.cpp` |
| `quantileBFloat16` | histogram of bfloat16 values | `QuantileBFloat16Histogram.h` |
| `quantilePrometheusHistogram` | quantile from Prometheus-style bucket counts | `AggregateFunctionQuantilePrometheusHistogram.cpp` |

All have `quantiles(...)` forms that compute several levels from one state. For latency panels, `quantileTDigest` and
`quantileDD` are mergeable across shards and rollups with a fixed state size; the default `quantile` is not suitable for
rollups because the sample changes the answer.

### Distinct counts

- `uniq`: `UniquesHashSet` (`src/AggregateFunctions/UniquesHashSet.h:121`), an adaptive-sampling set of 32-bit hashes,
  at most 2^16 cells (`:76-79`). When it fills, it raises a skip degree and drops hashes whose low bits are not zero.
- `uniqCombined(K)`: `CombinedCardinalityEstimator` (`src/Common/CombinedCardinalityEstimator.h:45`): a small array,
  then a hash set, then HyperLogLog with 2^K registers (default K=17, with bias correction only at 17,
  `AggregateFunctionUniqCombined.h:112-125`). About 96 KiB per state at K=17 once it is in HLL mode.
- `uniqHLL12` (`AggregateFunctionUniq.h:81`), `uniqTheta` (Apache DataSketches), `uniqExact` (exact set,
  `UniqExactSet.h`, merged in parallel by two-level buckets).
- `UniqToCountPass` rewrites `uniq(x)` over a subquery that is already `GROUP BY x` or `DISTINCT x` into `count()`.

### Map and JSON access

- `Map(K, V)` is stored as `Array(Tuple(K, V))` (`ColumnMap.h:24`). `m['key']` is `arrayElement` on a map
  (`FunctionArrayElement::executeMap`, `src/Functions/array/arrayElement.cpp:2254`), which scans each row's key array. It
  reads the whole map column, keys and values. `m.keys` and `m.values` are subcolumns that can be read alone. Other map
  functions are in `src/Functions/map.cpp`.
- The `JSON` type (`DataTypeObject`, `src/DataTypes/DataTypeObject.h:13`) stores each path as its own subcolumn, up to
  `max_dynamic_paths` = 1024 per part (`:24`); the rest go to a shared data column. Each dynamic path holds up to 32
  types (`DataTypeDynamic.h:16`). `json.a.b` reads only that path's subcolumn. For JSON kept as a `String`,
  `JSONExtract*` and `simpleJSON*` parse per row (`src/Functions/FunctionsJSON.cpp`), which is much slower.

### Text search

- `hasToken(haystack, token)` (`src/Functions/hasToken.cpp`, `HasTokenImpl` `src/Functions/HasTokenImpl.h:22`) uses a
  Volnitsky substring search over the whole string column and checks that the match is bounded by non-alphanumeric
  characters. It is the function that bloom-filter token indexes and the new `text` index can answer
  (`src/Storages/MergeTree/MergeTreeIndexConditionText.cpp:395`, `MergeTreeIndexBloomFilterText.cpp:509`). The function
  docs now recommend `hasAnyTokens`/`hasAllTokens` for text indexes with non-default tokenizers (`hasToken.cpp:29-33`).
- `like`/`ilike`/`match` (`src/Functions/MatchImpl.h`): a `LIKE` pattern is converted to a regexp; constant substrings
  are found with Volnitsky first (`:101`) and RE2 runs only where needed (`:112`, `:237`). `ConvertOrLikeChainPass`
  turns `x LIKE a OR x LIKE b` into one `multiMatchAny`. `LikePerfectAffixRewritePass` turns `LIKE 'abc%'` into
  `startsWith`.
- `multiSearchAny/FirstIndex/...` (`src/Functions/MultiSearchImpl.h:28`) use a multi-needle Volnitsky.
  `multiMatchAny` and friends use Hyperscan/Vectorscan when built with it (`MultiMatchAnyImpl.h:85-92`).
- Without an index all of these scan every byte of the column in the time range. PREWHERE helps: it reads the cheap
  `ts` column first and the expensive `body` column only for rows that pass.

### arrayJoin, WITH FILL, LIMIT BY, window functions

- `arrayJoin(arr)` is a function in name only (`src/Functions/array/arrayJoin.cpp:20`); the planner turns it into an
  `ArrayJoinStep` (`src/Processors/QueryPlan/ArrayJoinStep.h:15`) and `ArrayJoinTransform`
  (`src/Processors/Transforms/ArrayJoinTransform.h:15`), which emits one row per element. `unnest` is an alias.
- `ORDER BY t WITH FILL FROM a TO b STEP s` adds a `FillingTransform` (`src/Processors/Transforms/FillingTransform.h:23`,
  `transform` `.cpp:1376`) after sorting. It inserts missing rows with default values (or `INTERPOLATE` expressions), and
  supports `STALENESS`. This removes gaps in time series without client code.
- `LIMIT n BY key` adds a `LimitByTransform` (`src/Processors/Transforms/LimitByTransform.h:34`, `transform` `.cpp:217`)
  that counts rows per key in a hash map. Useful for "top 5 errors per service".
- Window functions run in `WindowTransform` (`src/Processors/Transforms/WindowTransform.h:59`) after a sort by
  `PARTITION BY, ORDER BY`. Frames are `ROWS`, `GROUPS` or `RANGE` (`src/Interpreters/WindowDescription.h:36`). Built-in
  window functions (`src/WindowFunctions/`): `row_number`, `rank`, `denseRank`, `percentRank`, `cume_dist`, `ntile`,
  `nth_value`, `lag`/`lead`, `lagInFrame`/`leadInFrame`, `nonNegativeDerivative`, `exponentialTimeDecayed*`. Any
  aggregate function can also be used over a window. Rate-of-counter panels map to `nonNegativeDerivative` or `lagInFrame`.

### Query result cache and query condition cache

- **Query result cache** (`src/Interpreters/Cache/QueryResultCache.h:56`; on-disk variant
  `QueryResultCacheOnDisk.h`). Opt-in per query with `use_query_cache = 1`. Only for initial, non-internal SELECTs
  (`executeQuery.cpp:3392-3394`). The key is the AST hash, current database, a copy of the settings, user and roles
  (`QueryResultCache.h:60-106`). Entries expire after `query_cache_ttl` (60 s). By default entries are private to the user
  (`query_cache_share_between_users = false`) and compressed. It refuses non-`throw` overflow modes because a truncated
  result would be cached (`executeQuery.cpp:3403-3418`). Server capacity: 1 GiB and 1024 entries
  (`src/Core/Defines.h:166-167`, `ServerSettings.cpp:2134`). Visible in `system.query_cache`.
- **Important for dashboards:** `now()` is not deterministic (`src/Functions/now.cpp:95`), and
  `query_cache_nondeterministic_function_handling` defaults to `throw` (`Settings.cpp:7311`). So
  `WHERE ts > now() - INTERVAL 1 HOUR` with `use_query_cache = 1` fails unless the UI sets that to `save` (then the result
  is reused for the TTL even though "now" moved) or sends literal, rounded time bounds.
- **Live check (14 Nov 2026, ClickStack image, ClickHouse 26.10.3.7):** the `now()` query with `use_query_cache = 1`
  did *not* throw, and a literal-bound query was not cached either. ClickStack's `/etc/clickhouse-server/config.xml`
  sets `<query_cache><max_size_in_bytes>0</max_size_in_bytes></query_cache>`, which turns the cache off, so the setting
  is a no-op there. The `throw` behaviour above is from the code and has not yet been seen on a server with the cache on.
  ClickStack relies on the query condition cache (below) and rollup tables, not the result cache.
- **Query condition cache** (`src/Interpreters/Cache/QueryConditionCache.h:41`), on by default
  (`use_query_condition_cache = true`, `Settings.cpp:7406`). It remembers, per part, which granule ranges did not match a
  WHERE condition, and skips them next time. For conditions relative to `now()` it derives a deterministic key by
  rounding the folded constant onto a grid proportional to the distance from now, clamped to 1 s .. 1 day
  (`QueryConditionCacheTimeConditions.h:1-25`). Refreshing dashboards with `hasToken(body, 'error')` filters benefit from
  this without opting in.

### Main settings

| Setting | Default | Where |
|---|---|---|
| `use_query_cache` | false | `Settings.cpp:7246` |
| `query_cache_ttl` | 60 s | `Settings.cpp:7378` |
| `query_cache_min_query_runs` / `query_cache_min_query_duration` | 0 / 0 ms | `Settings.cpp:7348`, `:7355` |
| `query_cache_share_between_users` | false | `Settings.cpp:7385` |
| `query_cache_nondeterministic_function_handling` | `throw` | `Settings.cpp:7311` |
| `query_cache_system_table_handling` | `throw` | `Settings.cpp:7320` |
| `query_cache_max_size_in_bytes` (server) | 1 GiB | `ServerSettings.cpp:2134` |
| `use_query_condition_cache` | true | `Settings.cpp:7406` |

### What Clickland should take from this

The query layer should snap time ranges to the bucket size and emit literal bounds, which makes both caches and shard
results reusable; use `toStartOfInterval` + `WITH FILL` for every time chart, `quantileTDigest`/`quantileDD` and
`uniqCombined` for anything that is stored or merged, and push users to `JSON` subcolumns or materialized columns
instead of `Map` lookups or `JSONExtract` on strings for frequently filtered attributes.

---

## 4. The server

### Process and protocols

`programs/server/Server.cpp` (`Server::main` `:1106`) loads config, creates the global `Context`, the async insert queue
(`:3530`), system logs (`:3716`), then `createServers` (`:4463`) opens one listener per configured port. All handlers are
in `src/Server/`:

| Protocol | Port key | Handler | Notes |
|---|---|---|---|
| Native TCP | `tcp_port` (9000) | `TCPHandler` (`src/Server/TCPHandler.cpp`, `runImpl` `:396`) | Packets in `src/Core/Protocol.h:79-137`: client `Query`, `Data`, `Cancel`, `Ping`; server `Data`, `Progress`, `ProfileEvents`, `Log`, `Exception`, `EndOfStream`. Blocks travel in Native format, compressed. Used by shards, `clickhouse-client` and native drivers. |
| HTTP(S) | `http_port` (8123) | `HTTPHandler` (`src/Server/HTTPHandler.cpp`, `processQuery` `:284`) | Query in URL or body; settings as URL params; reserved params `query_id`, `session_id`, `session_timeout`, `session_check`, `wait_end_of_query`, `compress`, `buffer_size` (`:356-357`). Auth via `X-ClickHouse-User`/`X-ClickHouse-Key` or basic auth (`src/Server/HTTP/authenticateUserByHTTP.cpp:118`). `X-ClickHouse-Format` sets the output format (`:433`). Progress and summary headers (`X-ClickHouse-Progress`, `X-ClickHouse-Summary`, `src/Server/HTTP/WriteBufferFromHTTPServerResponse.cpp:71-76`). Custom handlers in `HTTPHandlerFactory.cpp`. |
| MySQL wire | `mysql_port` | `MySQLHandler.cpp` | Enough for BI tools; not every MySQL feature. |
| PostgreSQL wire | `postgresql_port` | `PostgreSQLHandler.cpp` | Same. |
| gRPC | `grpc_port` | `GRPCServer.cpp`, `src/Server/grpc_protos/clickhouse_grpc.proto:226-230` | `ExecuteQuery` with unary and streaming input/output. |
| Arrow Flight | `arrowflight_port` | `src/Server/ArrowFlight/` | Arrow record batches. |
| Prometheus | `prometheus.port` | `PrometheusRequestHandler.cpp` | Section 6. |
| Interserver HTTP | `interserver_http_port` (9009) | `InterserverIOHTTPHandler.cpp` | Part fetches between replicas. |

### Formats for ingest

Implemented in `src/Processors/Formats/Impl/`: `JSONEachRowRowInputFormat`, `NativeFormat.cpp`,
`BinaryRowInputFormat` (RowBinary and variants), `ProtobufRowInputFormat`/`ProtobufListInputFormat`, Arrow
(`ArrowBlockInputFormat`, `ArrowIPC/`), Parquet. Row formats are parsed in parallel chunks
(`input_format_parallel_parsing = true`, `src/Core/FormatFactorySettings.h:28`). Defaults worth noting:
`input_format_skip_unknown_fields = true` (`:78`), `date_time_input_format = best_effort` (`:813`),
`input_format_allow_errors_num/ratio = 0` (`:1470`, `:1481`). There is no OTLP input format; an OpenTelemetry pipeline
needs a collector exporter that writes JSONEachRow, Native or RowBinary.

### Sessions, settings profiles, users, RBAC

- `Session` (`src/Interpreters/Session.h:35`) authenticates (`Session::authenticate`, `Session.cpp:363`), then builds a
  session context (`makeSessionContext`, `:576`, `:619` for named HTTP sessions kept in `NamedSessionsStorage`, `:71`) and
  per-query contexts (`makeQueryContext`, `:692`). HTTP is stateless unless `session_id` is passed; then temporary
  tables and `SET` persist for `session_timeout`.
- Access entities (`src/Access/`): `User`, `Role`, `SettingsProfile`, `Quota`, `RowPolicy`, `MaskingPolicy`. Storage
  backends: `users.xml` (`UsersConfigAccessStorage`), local disk (`DiskAccessStorage`, enabled by SQL
  `CREATE USER ...`), replicated through Keeper (`ReplicatedAccessStorage`), LDAP. `AccessControl.cpp` combines them.
- `ContextAccess::checkAccessImpl` (`src/Access/ContextAccess.cpp:908`, `:914`) checks grants per database/table/column
  against `AccessRights` (a tree of flags). `RowPolicy` (`src/Access/RowPolicy.h:16`) adds a filter expression per
  table that the planner applies as an extra filter; this is the tool for per-team log isolation.
- Settings profiles (`SettingsProfileElement.h:24`) set values and constraints (`min`, `max`, `readonly`, `changeable_in_readonly`)
  enforced by `SettingsConstraints::check` (`src/Access/SettingsConstraints.cpp:205`). `readonly = 1/2` blocks writes and
  setting changes.
- Quotas (`src/Access/Common/QuotaDefs.h`) count `QUERIES`, `QUERY_SELECTS`, `ERRORS`, `RESULT_ROWS`, `RESULT_BYTES`,
  `READ_ROWS`, `READ_BYTES`, `EXECUTION_TIME`, `WRITTEN_*`, failed authentications and executions per normalized query
  over time intervals. The key can be user, IP, forwarded IP, a client-supplied `quota_key`, or the normalized query hash
  (`QuotaKeyType`, `:56-68`). Checked in `EnabledQuota::used`/`checkExceeded` (`src/Access/EnabledQuota.cpp:388`, `:568`).
  The default `users.xml` quota tracks but limits nothing (`programs/server/users.xml`).

### Resource limits

- Memory: every allocation goes through `MemoryTracker::allocImpl` (`src/Common/MemoryTracker.cpp:348`), with a
  hierarchy thread -> query -> user -> server. Per query `max_memory_usage` (default 0 = unlimited,
  `Settings.cpp:4729`), per user `max_memory_usage_for_user` (`:4761`), per server `max_server_memory_usage` (0) or
  `max_server_memory_usage_to_ram_ratio` (0.9, `ServerSettings.cpp:446`, `:483`). When the server is over the limit,
  `OvercommitTracker` picks a query to kill based on `memory_overcommit_ratio_denominator` (1 GiB) and waits up to
  `memory_usage_overcommit_max_wait_microseconds` (5 s) (`Settings.cpp:4754`, `:4832`). The shipped default profile sets
  no per-query memory limit.
- Time: `max_execution_time` (0 = unlimited, `Settings.cpp:4139`), `timeout_overflow_mode` (`throw`), `max_execution_time_leaf`
  for shards (`:4169`), `max_estimated_execution_time` (`:4230`) and `min_execution_speed` after
  `timeout_before_checking_execution_speed` (10 s). The executor checks the limit between tasks
  (`PipelineExecutor.cpp:452-456`).
- Volume: `max_rows_to_read`, `max_bytes_to_read` (`:3826`, `:3832`), `max_result_rows` (`:4086`) with `*_overflow_mode`.
- Concurrency: `max_concurrent_queries` (server, `ServerSettings.cpp:601`), `max_concurrent_select_queries` (`:626`),
  `max_concurrent_queries_for_user` (query setting, `Settings.cpp:2826`), `priority` (`:2697`), and the CPU slot limit
  from `concurrent_threads_soft_limit_*`.
- **Workload scheduling.** SQL `CREATE RESOURCE` and `CREATE WORKLOAD` (`src/Parsers/ParserCreateWorkloadQuery.cpp`,
  `ParserCreateResourceQuery.cpp`) build a tree of workloads; a query picks one with the `workload` setting (default
  `"default"`, `Settings.cpp:9098`). Each workload has `weight`, `priority`, `max_concurrent_threads`,
  `max_concurrent_queries`, `max_waiting_queries`, `max_memory`, `max_memory_before_spill`, `max_io_requests`,
  `max_bytes_inflight` and rate limits with bursts (`src/Common/Scheduler/WorkloadSettings.h:21-62`). Time-shared
  resources (CPU, IO) use fair/priority policies, semaphores and token-bucket throttlers
  (`src/Common/Scheduler/Nodes/TimeShared/`); memory is space-shared (`Nodes/SpaceShared/`). The executor threads run
  with a `WorkloadResources` handle and can be asked to spill (`PipelineExecutor.cpp:432-437`).

### Main settings

| Setting | Default | Where |
|---|---|---|
| `max_connections` (server) | 4096 | `ServerSettings.cpp:304` |
| `max_concurrent_queries` (server) | 0 | `ServerSettings.cpp:601` |
| `max_memory_usage` | 0 | `Settings.cpp:4729` |
| `max_server_memory_usage_to_ram_ratio` (server) | 0.9 | `ServerSettings.cpp:483` |
| `max_execution_time` | 0 | `Settings.cpp:4139` |
| `readonly` | 0 | `Settings.cpp:4369` |
| `workload` | `default` | `Settings.cpp:9098` |
| `send_progress_in_http_headers` / `http_headers_progress_interval_ms` | false / 100 | `Settings.cpp:3107`, `:3118` |
| `cancel_http_readonly_queries_on_client_close` | false | `Settings.cpp:5344` |

### What Clickland should take from this

Have the UI talk HTTP with `JSONEachRow`/`JSONCompact` output, a `query_id` it chooses (for cancel via `KILL QUERY` and
for joining to `system.query_log`), and `cancel_http_readonly_queries_on_client_close = 1`. Give the UI its own
read-only user with a settings profile (`max_execution_time`, `max_memory_usage`, `max_rows_to_read`, constraints so
users cannot raise them), a quota keyed by the end user (`quota_key`), a row policy per team, and its own workload so
ingest and merges keep their share.

---

## 5. The cluster

### Distributed tables and query fan-out

- A `Distributed` table (`src/Storages/StorageDistributed.cpp`) has no data. It names a cluster from `remote_servers`,
  a local table, and an optional sharding key.
- **Stage negotiation.** `StorageDistributed::getQueryProcessingStage` (`:670`) counts the nodes to query, applies
  `optimize_skip_unused_shards` if the WHERE pins the sharding key (`getOptimizedCluster`, `:2169`), and
  `chooseQueryProcessingStage` returns the stage the shards will run to: `Complete` for one node,
  `WithMergeableState` normally, `WithMergeableStateAfterAggregation[AndLimit]` when GROUP BY contains the sharding key
  or `distributed_group_by_no_merge` is set (`getOptimizedQueryProcessingStageAnalyzer`, `:918`). Stages are in
  `src/Core/QueryProcessingStage.h:16-28`.
- **Shard query.** `StorageDistributed::read` (`:1164`) builds the shard query tree (`buildQueryTreeDistributed`,
  `:1057`, `src/Storages/buildQueryTreeForShard.cpp:987`, which also rewrites `GLOBAL IN`/`JOIN`) and converts it to AST
  text (`queryNodeToDistributedSelectQuery`, `src/Planner/Utils.cpp:279`). Folded constants are sent as literals, so
  `now()` is evaluated once on the initiator. `ClusterProxy::executeQuery`
  (`src/Interpreters/ClusterProxy/executeQuery.cpp:569`) adjusts settings for shards
  (`updateSettingsAndClientInfoForCluster`, `:359`: per-user limits are cleared unless an interserver secret is used,
  `:380-391`; `max_execution_time_leaf` replaces `max_execution_time`, `:500`).
- **Per shard.** `SelectStreamFactory::createForShardImpl` (`src/Interpreters/ClusterProxy/SelectStreamFactory.cpp:101`)
  plans the local shard in-process (`createLocalPlan`, `prefer_localhost_replica`, `:199`) and every other shard as a
  `ReadFromRemote` step (`src/Processors/QueryPlan/ReadFromRemote.h:28`, `initializePipeline` `.cpp:1027`). Remote
  sources use `RemoteQueryExecutor` (`src/QueryPipeline/RemoteQueryExecutor.cpp`, `sendQuery` `:552`, `read` `:766`,
  async `readAsync` `:814`) over a connection pool, picking one replica per shard by `load_balancing` (default `random`),
  skipping replicas that lag more than `max_replica_delay_for_distributed_queries`.
- **Merge.** Back in the initiator's planner, `from_stage = WithMergeableState` makes it add `MergingAggregatedStep`
  (`Planner.cpp:3277`; `MergingAggregatedStep::transformPipeline` `src/Processors/QueryPlan/MergingAggregatedStep.cpp:123`)
  and then sorting, LIMIT and formatting. Without GROUP BY, shards send sorted, pre-limited rows and the initiator does a
  merge sort and the final LIMIT (`distributed_push_down_limit = 1`).
- **Inserts.** `DistributedSink` (`src/Storages/Distributed/DistributedSink.cpp`) evaluates the sharding key, maps
  `value % total_weight` to a shard through weighted slots (`createSelector` `:772`,
  `src/Interpreters/createBlockSelector.cpp:22-51`), scatters each column (`IColumn::scatter`, `:799`), and by default
  writes the pieces to local spool directories that a background queue sends
  (`DistributedAsyncInsertDirectoryQueue.cpp`; `distributed_foreground_insert = false`, `Settings.cpp:1112`). For
  Clickland it is simpler to insert into the local tables directly or use `rand()` as the sharding key.
- New in tree but not ready: `make_distributed_plan` (`PRIVATE_PREVIEW`, `Settings.cpp:11354`) plans a whole query across
  stateless workers with streaming exchanges (`src/Server/DistributedQuery/`, `src/QueryPipeline/DistributedPlanExecutor.h`,
  `Optimizations/makeDistributed.cpp`); `serialize_query_plan` (false) can send plans instead of SQL text
  (`Settings.cpp:8397`, client packet `QueryPlan = 13`, `Protocol.h:135`).

### ReplicatedMergeTree and its log in Keeper

- Keeper layout for a table (`StorageReplicatedMergeTree::createTableIfNotExistsAttempt`,
  `src/Storages/StorageReplicatedMergeTree.cpp:1072`): shared `/log`, `/blocks` and `/deduplication_hashes`
  (dedup), `/block_numbers`, `/mutations`, `/quorum`, `/leader_election`, `/metadata`, `/columns`, and per replica
  `/replicas/<r>/{queue, log_pointer, parts, is_lost, host, metadata_version}`.
- **Insert.** `ReplicatedMergeTreeSink` writes a part locally, allocates a block number in Keeper with dedup checks
  (`allocateBlockNumber`, `src/Storages/MergeTree/ReplicatedMergeTreeSink.cpp:948`), and in one Keeper multi-op adds the
  part to its replica's `parts` and appends a `GET_PART` entry to `/log/log-NNNN` (`:876-880`). Optional quorum
  (`insert_quorum`, default 0) waits for N replicas. `insert_deduplicate = true` uses hashes of the inserted blocks
  (window `replicated_deduplication_window`), so client retries are safe.
- **Replication.** Each replica's `queueUpdatingTask` (`StorageReplicatedMergeTree.cpp:4213`) copies new log entries into
  its own `/queue` (`ReplicatedMergeTreeQueue::pullLogsToQueue`, `src/Storages/MergeTree/ReplicatedMergeTreeQueue.cpp:833`).
  Background workers pick entries (`selectEntryToProcess`, `:2188`, `shouldExecuteLogEntry` `:1674`) and run them
  (`executeLogEntry`, `StorageReplicatedMergeTree.cpp:2585`). Entry types are in `ReplicatedMergeTreeLogEntry.h:29-42`:
  `GET_PART` (fetch over interserver HTTP, `fetchPart` `:5562`), `MERGE_PARTS`, `MUTATE_PART`, `DROP_RANGE`,
  `REPLACE_RANGE`, `ALTER_METADATA` and others. A replica that may lead (`replicated_can_become_leader`, default true; several can) selects merges
  (`mergeSelectingTask`, `:4445`) and writes them to the log, so all replicas produce the same parts; a replica may fetch
  the merged part instead of merging it.
- Only metadata goes through Keeper; data moves replica to replica. Writes can go to any replica (multi-leader).

### ClickHouse Keeper

- A ZooKeeper-compatible service in `src/Coordination/`, run inside `clickhouse-server` or as `clickhouse-keeper`
  (`programs/keeper`). Consensus is NuRaft (eBay's Raft library, `#include <libnuraft/...>`, `KeeperServer.h:7-9`); the
  library itself is in `contrib/`, which is empty in this clone.
- `KeeperServer` (`KeeperServer.cpp`; `buildRaftParams` `:586`, `startup` `:803`, writes via `putRequestBatch` `:933`,
  local reads `putLocalReadRequests` `:923`) wraps the Raft server. `KeeperStateMachine` applies committed entries
  (`pre_commit` `KeeperStateMachine.cpp:818`, `commit` `:1424`), snapshots (`create_snapshot` `:1897`, `apply_snapshot`
  `:1544`; optionally to S3, `KeeperSnapshotManagerS3.cpp`). The tree lives in `KeeperStorage` (in-memory, or LSM-backed
  `KeeperLSMTNodesStorage.cpp`). The Raft log is `Changelog.cpp` / `KeeperLogStore.cpp`. Sessions and ephemeral nodes
  expire through `SessionExpiryQueue.cpp`. Four-letter-word commands (`mntr`, `stat`, ...) are in `FourLetterCommand.cpp`.
- Reads are served locally by default (`quorum_reads = false`), so a follower can lag the leader.
- Defaults (`src/Coordination/CoordinationSettings.cpp:31-72`): `heart_beat_interval_ms` 500,
  `election_timeout_lower/upper_bound_ms` 1000/2000, `snapshot_distance` 100000, `reserved_log_items` 100000,
  `force_sync` true, `compress_logs` false.

### Parallel replicas

With `enable_parallel_replicas` (`allow_experimental_parallel_reading_from_replicas`, default 0, `Settings.cpp:9910`) and
`max_parallel_replicas` (1000), one query reads a single shard's data on several replicas. Replicas announce their parts
and the initiator's `ParallelReplicasReadingCoordinator` (`src/Storages/MergeTree/ParallelReplicasReadingCoordinator.cpp`,
`DefaultCoordinator` `:266`, `InOrderCoordinator` `:969`, `handleRequest` `:1306`) hands out mark ranges by consistent hash
and lets idle replicas steal leftovers (`MergeTreeAllRangesAnnouncement` / `MergeTreeReadTaskRequest` packets,
`Protocol.h:96-97`). Entry: `executeQueryWithParallelReplicas` (`ClusterProxy/executeQuery.cpp:1138`). Settings:
`parallel_replicas_mode` (`read_tasks`), `cluster_for_parallel_replicas` (empty), `parallel_replicas_local_plan` (true),
`parallel_replicas_min_number_of_rows_per_replica`, `automatic_parallel_replicas_mode` (0).

### SharedMergeTree (ClickHouse Cloud)

Not in the open code: the engine and the shared catalog are behind `#if CLICKHOUSE_CLOUD`
(`src/Storages/MergeTree/registerStorageMergeTree.cpp:46-47`). The docs describe it as a replacement for
ReplicatedMergeTree on object storage where replicas do not talk to each other; all coordination and part metadata go
through Keeper and the shared store, replication is "asynchronous leaderless", hundreds of replicas per table are
possible "without shards", and `system.virtual_parts` / `system.shared_merge_tree_fetches` replace the replication queue
tables **[docs]** (`docs/products/cloud/features/infrastructure/shared-merge-tree.mdx`). The open parts that point that
way are object-storage disks (`s3_plain_rewritable`, `src/Disks/DiskObjectStorage/`), zero-copy replication settings,
parallel replicas and the stateless-worker distributed plan.

### Main settings

| Setting | Default | Where |
|---|---|---|
| `prefer_localhost_replica` | true | `Settings.cpp:5213` |
| `load_balancing` | `random` | `Settings.cpp:1290` |
| `skip_unavailable_shards` | false | `Settings.cpp:1711` |
| `optimize_skip_unused_shards` | false | `Settings.cpp:1877` |
| `distributed_group_by_no_merge` | 0 | `Settings.cpp:1776` |
| `distributed_push_down_limit` | 1 | `Settings.cpp:1814` |
| `distributed_product_mode` | `deny` | `Settings.cpp:2782` |
| `distributed_foreground_insert` | false | `Settings.cpp:1112` |
| `insert_quorum` / `insert_deduplicate` | 0 / true | `Settings.cpp:2886`, `:2866` |

### What Clickland should take from this

For a small company, start with one shard and two replicas (ReplicatedMergeTree plus a three-node Keeper) and no
Distributed table; add shards only when one node's disk or CPU is not enough, and then shard by `rand()` or trace id.
Never reimplement replication or Raft; treat Keeper as infrastructure with its own monitoring.

---

## 6. Self-observability

### System tables and logs

- `SystemLog<T>` (`src/Interpreters/SystemLog.cpp`) is a background-flushed queue per log table. Defaults
  (`src/Common/SystemLogBase.h:265-272`): flush every 7500 ms, queue up to 1048576 rows, partition by
  `toYYYYMM(event_date)`, order by `event_date, event_time`; no TTL unless configured. Flushes happen in
  `savingThreadFunction` / `flushImpl` (`SystemLog.cpp:873`, `:908`). When the schema changes after an upgrade, the old
  table is renamed to `<name>_N` and a new one created (`prepareTable`, `:1030`, rename at about `:1092-1118`).
- `system.query_log` (`src/Interpreters/QueryLog.cpp`): one row at start and one at finish or exception per query, with
  type, times, `query_duration_ms`, read/written/result rows and bytes, `memory_usage`, query text, normalized hash,
  databases/tables/columns touched, user, client info, `initial_query_id` (links shard rows to the initiator),
  `ProfileEvents` and `Settings` maps, functions and formats used, `query_cache_usage`, `log_comment`. Control:
  `log_queries` (true), `log_query_settings` (true), `log_query_threads` (false).
- `system.part_log` (`PartLog.cpp`): new, merged, mutated, downloaded and removed parts with durations.
- `system.trace_log` (`TraceLog.cpp`): stack samples with `trace_type` (`Real`, `CPU`, `Memory`, `MemorySample`,
  `MemoryPeak`, `ProfileEvent`, `JemallocSample`, `Instrumentation`; `src/Common/TraceSender.h:21`), `query_id`, thread,
  symbolized lines.
- `system.metric_log` (`MetricLog.cpp`, `stepFunction` `:165`; `BucketedMetricLog.cpp`, the default schema is
  "bucketed", `SystemLog.cpp:143`) samples every `CurrentMetrics` gauge and `ProfileEvents` counter delta every second
  (`SystemLog.cpp:183`). `system.asynchronous_metric_log` stores `AsynchronousMetrics::update`
  (`src/Common/AsynchronousMetrics.cpp:1425`) values: OS, memory, disks, network, every
  `asynchronous_metrics_update_period_s` (1).
- `system.opentelemetry_span_log` (`OpenTelemetrySpanLog.cpp`): `trace_id`, `span_id`, `parent_span_id`,
  `operation_name`, `kind`, start/finish, status, attributes.
- `system.text_log` (`TextLog.h:49`): the server's own log lines, level set by `text_log.level`
  (`src/Loggers/Loggers.cpp:287`).
- Live state: `system.processes` (`src/Storages/System/StorageSystemProcesses.cpp`), `system.parts`
  (`StorageSystemParts.cpp`), `system.merges` (`StorageSystemMerges.cpp`), `system.metrics`, `system.events`,
  `system.asynchronous_metrics`, `system.replication_queue`, `system.query_cache`. Others in the same directory include
  `processors_profile_log` (per-processor timing, `log_processors_profiles = true`), `query_metric_log`,
  `asynchronous_insert_log`, `session_log`, `error_log`. The shipped config can add `system.all_*` views across rotated
  tables and replicas (`programs/server/config.xml`).

### Prometheus endpoint

`PrometheusRequestHandler` with `PrometheusMetricsWriter` (`src/Server/PrometheusMetricsWriter.cpp:82-86`) exposes
`ClickHouseProfileEvents_*`, `ClickHouseMetrics_*`, `ClickHouseAsyncMetrics_*`, `ClickHouseErrorMetric_*`,
`ClickHouseHistogramMetrics_*`, with optional constant labels. Enabled by a `<prometheus>` section (port 9363, endpoint
`/metrics`), commented out in the shipped `config.xml`. The same handler can accept Prometheus remote-write and
remote-read into a `TimeSeries` table and answer the Prometheus HTTP query API (`/api/v1/query`, `query_range`, `series`,
`labels`; `PrometheusRequestHandler.cpp:354`, `:407`, `:475`) with a PromQL-to-SQL translator
(`src/Storages/TimeSeries/PrometheusQueryToSQL/`). The `TimeSeries` engine is `PRIVATE_PREVIEW` behind
`enable_time_series_table` (`Settings.cpp:10957`).

### OpenTelemetry context propagation

`TracingContext` (`src/Common/OpenTelemetryTraceContext.h`, `parseTraceparentHeader` `.cpp:338`,
`composeTraceparentHeader` `:399`). HTTP reads `traceparent`/`tracestate` (`src/Server/HTTPHandler.cpp:1671-1681`). The
native protocol carries trace id and span id in `ClientInfo` (`src/Interpreters/ClientInfo.cpp:284-291`), and
`Connection` forwards the current context to shards (`src/Client/Connection.cpp:1022-1027`). Outbound `url()` requests add
a `traceparent` header (`src/Storages/StorageURL.cpp:313`). `SpanHolder` (`OpenTelemetryTraceContext.h:240`) is a RAII
span written to `opentelemetry_span_log` at the end. If the client does not send a context, the server starts its own trace
with probability `opentelemetry_start_trace_probability` (0, `Settings.cpp:3660`). `opentelemetry_trace_processors`
(false) adds a span per processor.

### Sampling profiler

`QueryProfilerReal` and `QueryProfilerCPU` (`src/Common/QueryProfiler.h:101`, `:112`) create a per-thread POSIX timer
(`timer_create` on `CLOCK_MONOTONIC` or the thread CPU clock, `QueryProfiler.cpp:157-182`). The signal handler captures a
stack trace and `TraceSender::send` (`src/Common/TraceSender.cpp:32`) writes it to a pipe; `TraceCollector::run`
(`src/Interpreters/TraceCollector.cpp:161`) reads the pipe and inserts into `trace_log`. Default period is 1 s for both
(`QUERY_PROFILER_DEFAULT_SAMPLE_RATE_NS = 1000000000`, `src/Core/Defines.h:176`; `query_profiler_real_time_period_ns`,
`query_profiler_cpu_time_period_ns`, `Settings.cpp:3612`, `:3634`). Memory sampling: `memory_profiler_step` (4 MiB,
`:4794`), `total_memory_profiler_step` and `total_memory_tracker_sample_probability` (server). `trace_log` plus
`arrayJoin(trace)` and `addressToSymbol` gives flame graphs per `query_id`.

### What Clickland should take from this

Copy the model, not the code: a per-request row with ids (`query_id`, `initial_query_id`, `trace_id`), timings, volume and
a counter map; per-second gauge and counter snapshots; spans in a span table; logs in a log table; all of them in the same
store with `toYYYYMM(event_date)` partitions and a TTL. Clickland should also ingest ClickHouse's own `query_log`,
`metric_log` and `/metrics` into itself, so the system can monitor its own backend.

---

## 7. Integrations for an ingest pipeline

### HTTP with async inserts

- `async_insert` is **on by default since 26.2** (`Settings.cpp:8722-8725`), with `wait_for_async_insert = true`. An
  `INSERT` from a client is pushed into `AsynchronousInsertQueue` (`src/Interpreters/AsynchronousInsertQueue.h:42`,
  `pushQueryWithBlock` / `pushDataChunk` `.cpp:682`, `:709`) instead of creating a part. Inserts are grouped by a key
  made of the normalized query (table, columns, format), settings, user, roles and credential limits
  (`InsertQuery`, `.h:88-120`). A batch is flushed when it reaches `async_insert_max_data_size` (10 MiB),
  `async_insert_max_query_number` (450, only with dedup), or a timeout that adapts between
  `async_insert_busy_timeout_min_ms` (50) and `async_insert_busy_timeout_max_ms` (200)
  (`getBusyWaitTimeoutMs`, `.cpp:931`; `processBatchDeadlines` `:1168`; `processData` `:1275`). Flushing parses all
  queued payloads and writes one part. With `wait_for_async_insert = 1` the client gets its answer after the flush, so the
  insert is durable when acknowledged; with `0` it is fire-and-forget. `async_insert_deduplicate` is false by default.
  `async_insert_threads` (16) per server. Every flush is logged in `system.asynchronous_insert_log`.
- This replaces most of the buffering a collector would do. Many small HTTP clients posting `JSONEachRow` batches is a
  supported pattern; the limit becomes parts per partition (`parts_to_throw_insert`, `max_partitions_per_insert_block`
  = 100) rather than request count.

### Kafka engine

`StorageKafka` (`src/Storages/Kafka/StorageKafka.cpp`) is a consumer, not a store: background threads
(`threadFunc` `:613`) poll librdkafka, parse with any input format, and push blocks into the materialized views attached
to the table (`streamToViews` `:693`), then commit offsets (`:775`). Delivery is at-least-once: a crash between the view
insert and the commit replays messages. Settings (`KafkaSettings.cpp:29-46`): `kafka_num_consumers` (1),
`kafka_max_block_size`, `kafka_flush_interval_ms`, `kafka_poll_timeout_ms`, `kafka_thread_per_consumer` (false),
`kafka_handle_error_mode` (`default`; `stream` keeps bad messages in virtual columns). `StorageKafka2` keeps offsets in
Keeper (`kafka_keeper_path`, `StorageKafka2.cpp:1281`, `:1395`) for exactly-once with replicated tables; it is
`EXPERIMENTAL` (`Settings.cpp:7601`).

### S3, URL and queues

- `s3(...)`, `url(...)`, `azureBlobStorage`, `hdfs`, `file` table functions (`src/TableFunctions/TableFunctionObjectStorage.cpp`,
  `TableFunctionURL.cpp`) read or write any format with globs and schema inference
  (`src/Storages/ObjectStorage/StorageObjectStorage.cpp`, `StorageURL.cpp`). `s3Cluster`/`urlCluster`
  (`TableFunctionObjectStorageCluster.cpp`, `StorageObjectStorageStableTaskDistributor.cpp`) spread files across a
  cluster using `ReadTaskRequest`/`ReadTaskResponse` packets.
- `S3Queue`/`AzureQueue` (`src/Storages/ObjectStorageQueue/StorageObjectStorageQueue.cpp`) tail a bucket prefix and track
  processed files in Keeper (ordered or unordered mode), feeding materialized views like Kafka does. This is the
  simplest durable pipeline for archive or backfill: collector writes files to object storage, S3Queue loads them.
- `remote(...)`/`cluster(...)` (`TableFunctionRemote.cpp`) query other servers ad hoc.

### What Clickland should take from this

The default ingest path should be: OpenTelemetry Collector (or Vector) -> HTTP `INSERT ... FORMAT JSONEachRow` with
`async_insert = 1, wait_for_async_insert = 1` into ReplicatedMergeTree tables; add Kafka or S3Queue only when a durable
buffer between producers and ClickHouse is required, and accept at-least-once with dedup in queries.

---

## Walk-through: the reference query on a 3-shard cluster

```sql
SELECT toStartOfInterval(ts, INTERVAL 1 MINUTE) t, count()
FROM logs
WHERE ts > now() - INTERVAL 1 HOUR AND hasToken(body, 'error')
GROUP BY t ORDER BY t
```

Assume `logs` is `Distributed(c3, default, logs_local, rand())`, each shard has two replicas of a ReplicatedMergeTree
`logs_local ORDER BY (ts, ...)`, and the UI sends the query over HTTP to node A (shard 1).

1. **HTTP.** `HTTPHandler::handleRequest` (`HTTPHandler.cpp:1643`) authenticates, reads `traceparent`, builds a query
   context from the user's settings profile plus URL settings, and calls `executeQuery` (`:1523`).
2. **Parse and admit.** The lexer and `ParserSelectQuery` produce the AST. `ProcessList::insert` checks concurrency
   limits and registers the query for `system.processes`. `use_query_cache` is off, so no cache probe. (If it were on,
   `now()` would raise an error unless `query_cache_nondeterministic_function_handling = 'save'`.)
3. **Analyze.** `logs` resolves to `StorageDistributed`. `now() - INTERVAL 1 HOUR` is folded into one `DateTime`
   constant. `toStartOfInterval` resolves to `FunctionToStartOfInterval` with result type `DateTime`; `t` is an alias;
   `count()` is an aggregate. Rewrite passes run (`TruncateOrderByAfterGroupByKeysPass`, `LogicalExpressionOptimizerPass`,
   and so on).
4. **Plan on the initiator.** `PlannerJoinTree` asks the storage for its stage. `ts` is not the sharding key, so no
   shard is skipped; three nodes means `WithMergeableState`. `StorageDistributed::read` turns the query tree into SQL with
   the time bound as a literal and calls `ClusterProxy::executeQuery`. Shard 1 is local, so it gets an in-process plan
   (`createLocalPlan`) that stops at mergeable state; shards 2 and 3 become `ReadFromRemote` steps. On top, the planner
   adds `MergingAggregatedStep`, an expression step, `SortingStep` on `t`, and the output.
5. **Shard work** (same on each shard, run as a `SECONDARY_QUERY` to stage `WithMergeableState`):
   - `ReadFromMergeTree` uses the primary key on `ts` to select only granules of the last hour (storage report covers
     this). `optimizePrewhere` moves the conditions to PREWHERE: `ts` is read and checked first, then `body` only for
     granules that survive. If a token or text index exists on `body`, it drops granules without `error` before reading;
     the query condition cache drops granules known not to match from earlier runs.
   - Each of up to `max_threads` streams runs `FilterTransform` (`hasToken` scans each `body` value with Volnitsky and a
     token-boundary check), then `ExpressionTransform` (`toStartOfInterval` over the `ts` column), then
     `AggregatingTransform` with a `key32` hash table and a `count` state per minute. Sixty keys at most, so no two-level
     and no spill.
   - The per-thread tables are merged and returned as about 60 rows: `t DateTime`, `count()` as
     `AggregateFunction(count)` state, sent in Native `Data` packets, with `Progress` and `ProfileEvents` packets on the
     side.
6. **Merge on the initiator.** `RemoteQueryExecutor` reads the shards' packets asynchronously.
   `MergingAggregatedTransform` merges up to 180 rows into 60, finalizes `count`, `SortingStep` sorts 60 rows, the output
   format writes them to the HTTP response, and `X-ClickHouse-Summary` carries the totals.
7. **Records.** The initiator writes a `QueryStart` and `QueryFinish` row to `system.query_log` with
   `is_initial_query = 1`; each shard writes rows with `is_initial_query = 0` and the same `initial_query_id`. Spans go to
   `system.opentelemetry_span_log` if tracing is on, and `trace_log` gets samples if the query runs longer than a profiler
   period.

The cost is almost all in step 5: reading and scanning `body` for the hour. The UI layer's levers are the time range,
an index on `body`, and caching; everything after the shard aggregation is tiny.

---

## Run as-is or reimplement

| Area | Decision for Clickland |
|---|---|
| Parser, analyzer, planner, executor, functions, aggregation | Run as-is. Years of work; no reason to touch. |
| Server protocols, formats, RBAC, quotas, workloads | Run as-is; configure. |
| Distributed tables, ReplicatedMergeTree, Keeper | Run as-is; start with one shard, two replicas. |
| Query result cache | Use selectively; the UI should also cache at its own layer keyed by rounded time range. |
| Ingest | Use async inserts over HTTP; reuse an existing collector instead of writing one. |
| Self-observability | Ingest ClickHouse's own tables; copy their schemas as the template for Clickland's own telemetry. |
| What Clickland builds | A query layer: a small typed query model (time range, bucket, filters, group-by, aggregation) compiled to SQL; query ids, cancel, progress; per-user profiles and quotas; result shaping for charts. |

---

## Open questions

1. How mature is the `text` full-text index for `hasToken`/`hasAnyTokens` on log bodies, and what does it cost at insert
   time? (Storage report; it decides whether log search scans or seeks.)
2. Should the UI rely on `query_cache_nondeterministic_function_handling = 'save'`, or always send literal time bounds
   rounded to the bucket? The second makes the cache key change once per bucket, which looks better, but needs testing
   with the query condition cache's own rounding.
3. Async inserts are on by default since 26.2. What is the right `async_insert_busy_timeout_max_ms` for our volume, and do
   we want `async_insert_deduplicate` for collector retries?
4. One shard with replicas, or several shards from day one? This depends on expected daily volume and retention, which
   we have not measured.
5. Is workload scheduling (`CREATE WORKLOAD`) stable enough to separate UI, ingest and merges, or should we rely on
   settings profiles and `max_concurrent_queries_for_user` only? No stability tier was found on the workload settings;
   needs a test.
6. Do we want ClickHouse's Prometheus remote-write and PromQL API for metrics? The `TimeSeries` engine is
   `PRIVATE_PREVIEW`, so probably not yet; plain tables plus our own query layer are safer.
7. `make_distributed_plan` and stateless workers (private preview) look like the open-source path toward compute/storage
   separation. Worth watching, not worth depending on.
8. The Kafka engine is at-least-once unless the experimental Keeper-offset variant is used. Do we need Kafka at all, or is
   HTTP plus async inserts plus collector retries enough?
9. The default `quantile` is a non-deterministic reservoir. Should the query layer forbid it in favour of
   `quantileTDigest` or `quantileDD`, and which relative accuracy for `quantileDD`?
10. Line numbers here are for commit `1b7851acb7ca`. If we pin a release instead of `master`, the references need a
    refresh.
