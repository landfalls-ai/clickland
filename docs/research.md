# Clickland: research

What reverse-engineering ClickHouse and ClickStack taught us, and what Clickland takes from it. Gathered on
14 November 2026 from:

- the ClickHouse source (`upstream/clickhouse`, commit `1b7851acb7ca`, Apache-2.0), read subsystem by subsystem;
- the ClickStack / HyperDX source (`upstream/clickstack-hyperdx`, commit `0096a355`, MIT);
- ClickStack running locally (`clickhouse/clickstack-local`, ClickHouse 26.10.3.7) with synthetic OTel data;
- Craft Anything 0.6.1: captures of the ClickHouse Cloud page and every ClickStack screen, and ClickStack's source
  graphs (`study/`).

The detail is in three reports: [storage](research/clickhouse-storage.md),
[query and cluster](research/clickhouse-query-and-cluster.md), [ClickStack](research/clickstack.md). Claims the live
stack confirmed are marked **[live]**; claims from docs only are marked [docs] in the reports.

---

## 1. The finding that decides the design

ClickHouse's value is its engine: immutable parts, sparse primary index, per-column codecs, skip and text indexes,
vectorized aggregation with mergeable states, background merges, replication through Keeper. ClickHouse's own
observability product, ClickStack, reimplements none of it. ClickStack is a schema, a search-to-SQL compiler, pattern
mining, alerts and a UI, about 20k lines of TypeScript in `packages/common-utils` plus the API and app.

**So Clickland runs ClickHouse unchanged and builds the observability layer above it.** Rebuilding the store (plan
option C) would take years to reach what ClickHouse already is, and nothing in the goal needs it. The plan
([plan.md](plan.md)) compares adopting ClickStack (A) with building our own layer on its schema (B).

## 2. How a log row lives in ClickHouse

1. **Ingest.** The OTel Collector batches (ClickStack: 10,000 rows or 5 s) and inserts. Async inserts are **on by
   default** since 26.2 **[live]**: the server also batches many small inserts, flushing after 50–200 ms or 10 MiB, and
   with `wait_for_async_insert = 1` the acknowledgement means the data is written. ClickHouse has no OTLP input format,
   so a collector is always needed.
2. **A part.** Each flush is split by partition (one per day), sorted by `ORDER BY` and written as an immutable part.
   Small parts are *compact* (all columns in one file), large ones *wide* (a file per column). **[live]**: 1,000
   synthetic logs became one compact part, 120 KiB raw stored in 4.8 KiB.
3. **Granules and marks.** Rows are grouped into granules of at most 8,192 rows or 10 MiB **[live]**. The primary index
   keeps one key per granule in memory; marks map each granule to an offset in a compressed block.
4. **Compression.** Defaults: LZ4 under 100 MiB, ZSTD(3) above. Per column: `Delta, ZSTD` for timestamps, `T64` for
   integers, `Gorilla`/`FPC` for float gauges, and `LowCardinality` for service, level and the like.
5. **Merges.** Background merges combine parts inside a partition (never across). Inserts slow down at 1,000 active
   parts in a partition and fail at 3,000 **[live]**. Active parts per partition is the health metric to alert on.
6. **Retention.** Daily partitions plus `TTL … ttl_only_drop_parts = 1` drop whole parts with no rewrite.

## 3. How a search finds it

Pruning runs in a fixed order: partition min/max → primary key → skip indexes → read. **[live]** `EXPLAIN indexes=1`
for a body search on `otel_logs` showed exactly that cascade, with the `text` index on `lower(Body)` cutting the last
granule (0/1 read). Consequences:

- The **text index** (inverted: a token dictionary and posting lists) has been generally available since 26.2 and is on
  by default **[live]**. It serves `hasToken`, `hasAllTokens`, `LIKE` and map keys and values, and it is merged rather
  than rebuilt. It replaces the older `tokenbf_v1` bloom filters for log search. ClickStack uses it on the body, the
  trace id, map keys and `key=value` items.
- **The sort key is a real choice.** ClickStack sorts logs by `(toStartOfFiveMinutes(Timestamp), ServiceName,
  Timestamp)`, so any time range prunes with or without a service filter. The storage report argues for
  `(ServiceName, SeverityText, Timestamp)`, which prunes harder when the service is given. Clickland starts with
  ClickStack's key (compatibility, and most searches start from a time range) and benchmarks both in wave 1.
- **Facet counts** (the filter sidebar) come from a materialized view into a `SummingMergeTree` rollup, not from
  scanning logs.
- **Caches.** The query *condition* cache is on by default: it remembers granules that failed a WHERE and rounds
  `now()`-relative bounds to a grid, so refreshing dashboards gets faster on their own. The query *result* cache is
  opt-in, and ClickStack turns it off on the server (`query_cache.max_size_in_bytes = 0`) **[live]**.

## 4. How a chart is computed

- The analyzer is now the only query path. The planner sends each shard the work up to a "mergeable state"; shards
  return aggregate states and the initiator merges them. `now()` is fixed once on the initiator, so every shard uses the
  same time bound.
- Aggregation picks a hash table by key type (a `DateTime` bucket gets one of the fastest), turns into a two-level
  table with 256 buckets as it grows, and spills to disk past half of the available memory.
- **Aggregate states are values**: `countState`, `uniqCombinedState`, `quantileTDigestState` are stored in an
  `AggregatingMergeTree` and finished with `-Merge`. That is the rollup mechanism for metrics and long-range charts. The
  default `quantile` samples randomly and must not go in stored rollups.

## 5. Running it

- **Isolation and limits exist**: settings profiles with constraints, quotas per end user (`quota_key`), row policies
  (per-team isolation), `CREATE WORKLOAD` scheduling, and `max_memory_usage` / `max_execution_time` /
  `max_rows_to_read`. The shipped default profile sets no per-query memory limit, so Clickland sets one for its UI user.
- **Cluster**: Distributed tables, ReplicatedMergeTree with its log in Keeper, and Keeper itself (Raft through NuRaft)
  are open source and production-proven. SharedMergeTree (Cloud's compute and storage split, behind "no manual
  sharding" on the Cloud page) is not in the open code. Zero-copy replication on S3 is marked "don't use in production".
  Start with one node, and go to one shard with two replicas and three Keeper nodes only when needed.
- **Tiering**: a hot local volume with `TTL … TO VOLUME` onto an S3 disk (our local MinIO) behind the filesystem cache.
- **ClickHouse watches itself**: `system.query_log`, `part_log`, `trace_log`, `metric_log`, `opentelemetry_span_log`, a
  Prometheus endpoint and W3C `traceparent` propagation. Clickland ingests these too, as the "ClickHouse" service.
- **Experimental**: the `TimeSeries` engine and PromQL that ClickStack uses for its PromQL source still need an
  experimental flag. Clickland stores metrics in the plain `otel_metrics_*` tables.

## 6. What the Cloud page and the ClickStack screens add

- The **Cloud page** (`study/clickhouse-cloud-page/`, clean room) sells what the open code lacks: automatic
  replication with no manual sharding (SharedMergeTree), a SQL console with a table explorer, an ingestion wizard,
  multi-zone availability, upgrades, backups and disaster recovery. Inside the land family we need none of these at
  first except backups.
- The **ClickStack screens** (`study/clickstack-ui/`, ten captures with data) are the product checklist: search with
  a SQL/Lucene toggle and live tail, the filter sidebar, event patterns and denoising, the chart explorer, dashboards,
  service, Kubernetes, ClickHouse and LLM dashboards, client sessions, a service map, alerts.

## 7. What the land family already provides

- **Telemetry**: Landflow (host and every plugin) and Landbright already export OTLP/HTTP with W3C trace context
  (`landflow/docs/observability.md`). Today it goes to `landflow-lgtm`, a development-only Grafana LGTM pod in an
  `emptyDir` that loses everything on restart (`landflow/docs/specs/08-durable-telemetry.md`). Clickland only needs
  `OTEL_EXPORTER_OTLP_ENDPOINT` changed, and `LANDFLOW_TRACE_URL` to link Run Trace to a Clickland trace.
- **Identity**: Landbright is an OIDC provider. Clickland's console signs in through it. ClickStack's collector can also
  require an OIDC bearer token on the OTLP receiver (`docker/otel-collector/config.standalone.oidc.yaml`), so
  Landbright-issued tokens can authenticate telemetry senders.
- **Actions**: Landflow workflows can take an alert's webhook and do the rest (Slack, approvals, Run Trace), and its
  MCP gateway can expose Clickland's MCP tools to agents.
- **Look**: `@land/tokens` (Landbright's `libs/tokens`) carries Landflow's design tokens.

## 8. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | Run ClickHouse as-is (single node first), never fork it | §1, and both reports' "run as-is" sections |
| D2 | Keep ClickStack's `otel_*` schema and names | The stock collector exporter and ClickStack's UI work on our data from day one; proven sort keys, codecs, text indexes |
| D3 | A stock OTel Collector (contrib) with memory_limiter → transform → batch 10k/5s, plus server async inserts | §2; no ingest service of our own |
| D4 | The search compiler is Clickland's core code, and its tests check `EXPLAIN indexes=1` | §3: speed comes from SQL that hits the text index, materialized columns and rollups |
| D5 | Facets and long-range charts read rollups (`SummingMergeTree`, `AggregatingMergeTree` with `-State`) | §3, §4 |
| D6 | Alerts are periodic SQL; firing starts a Landflow workflow | ClickStack does the same (`checkAlerts`); Landflow already has Slack, approvals and Run Trace |
| D7 | Metadata in Postgres, identity from Landbright, the look from `@land/tokens` | §7 |
| D8 | A readonly ClickHouse user for the UI with a settings profile (memory, time and rows-read limits) and a quota per end user | §5 |
| D9 | Retention by daily partitions and `ttl_only_drop_parts` | §2 |

## 9. Still open

- The text index's size and merge cost at our volume, against `tokenbf_v1` (benchmark in wave 1).
- The log sort key (ClickStack's against the storage report's; benchmark in wave 1).
- The result cache with literal, bucket-rounded bounds: worth turning on, or is the condition cache enough?
- Whether Kafka is ever needed. Today, no: the collector plus async inserts covers our volume.
- See also each report's "Open questions".
