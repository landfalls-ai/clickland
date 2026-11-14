# Live ClickStack probe (2026-11-14T14:13:29Z, clickhouse 26.10.3.7, image clickhouse/clickstack-local:latest)

Synthetic data: telemetrygen logs/traces/metrics, 50/s for 20 s each, service clickland-synthetic.

## Parts
```
   ┌─table─────────────────────┬─parts─┬─rows─┬─comp──────┬─raw────────┬─types───────┐
1. │ otel_metrics_gauge        │     1 │ 1166 │ 5.16 KiB  │ 243.25 KiB │ ['Compact'] │
2. │ otel_traces               │     1 │ 1002 │ 23.02 KiB │ 266.52 KiB │ ['Compact'] │
3. │ otel_logs                 │     1 │  992 │ 4.78 KiB  │ 120.75 KiB │ ['Compact'] │
4. │ otel_metrics_sum          │     3 │  132 │ 8.25 KiB  │ 64.18 KiB  │ ['Compact'] │
5. │ otel_logs_kv_rollup_15m   │     1 │   14 │ 523.00 B  │ 824.00 B   │ ['Compact'] │
6. │ otel_traces_kv_rollup_15m │     1 │    8 │ 392.00 B  │ 386.00 B   │ ['Compact'] │
7. │ otel_metrics_histogram    │     2 │    6 │ 3.58 KiB  │ 5.59 KiB   │ ['Compact'] │
   └───────────────────────────┴───────┴──────┴───────────┴────────────┴─────────────┘
```

## A log search: EXPLAIN indexes=1
```
Output: count()

Aggregating
│  Keys:
│  Aggregates: count()
│  Skip merging: 0
└──ReadFromMergeTree (default.otel_logs)
      Read type: Default
      Parts: 0 | Granules: 0
      Output: Empty
      Prewhere filter
      Prewhere filter column:  Timestamp > \'2026-11-14 13:13:29\' AND __text_index_idx_lower_body_hasAllTokens_7a02e1424e92c7c797c7533114563c62
      Indexes:
        Min-Max
          Keys:
            Timestamp
          Condition: (Timestamp in (\'1794662009\', +Inf))
          Parts: 1/1
          Granules: 1/1
        Partition
          Keys:
            toDate(Timestamp)
          Condition: (toDate(Timestamp) in [20771, +Inf))
          Parts: 1/1
          Granules: 1/1
        PrimaryKey
          Keys:
            toStartOfFiveMinutes(Timestamp)
            Timestamp
          Condition: and((toStartOfFiveMinutes(Timestamp) in [1794661800, +Inf)), (Timestamp in (\'1794662009\', +Inf)))
          Parts: 1/1
          Granules: 1/1
          Search Algorithm: generic exclusion search
        Skip
          Name: idx_lower_body
          Description: text GRANULARITY 100000000
          Condition: (mode: All; tokens: ["test"])
          Parts: 0/1
          Granules: 0/1
        Ranges: 0
```

## A trace lookup by TraceId
```
Output: Timestamp, TraceId, SpanId, ParentSpanId, TraceState, SpanName, SpanKind, ServiceName, ResourceAttributes, ScopeName, ScopeVersion, SpanAttributes, Duration, StatusCode, StatusMessage, Events.Timestamp, Events.Name, Events.Attributes, Links.TraceId, Links.SpanId, Links.TraceState, Links.Attributes

ReadFromMergeTree (default.otel_traces)
   Read type: Default
   Parts: 1 | Granules: 1
   Output: Timestamp, TraceId, SpanId, ParentSpanId, TraceState, SpanName, SpanKind, ServiceName, ResourceAttributes, ScopeName, ScopeVersion, SpanAttributes, Duration, StatusCode, StatusMessage, Events.Timestamp, Events.Name, Events.Attributes, Links.TraceId, Links.SpanId, Links.TraceState, Links.Attributes
   Prewhere filter
   Prewhere filter column:  CAST(__text_index_idx_trace_id_equals_5bec1e2b91b0fb1b8d0e67f5ee5b3c10 AS Nullable(UInt8))
   Indexes:
     Min-Max
       Condition: true
       Parts: 1/1
       Granules: 1/1
     Partition
       Condition: true
       Parts: 1/1
       Granules: 1/1
     PrimaryKey
       Condition: true
       Parts: 1/1
       Granules: 1/1
     Skip
       Name: idx_trace_id
       Description: text GRANULARITY 100000000
       Condition: (mode: All; tokens: ["e44d8185d8655e87d6482712fb6c6eaf"])
       Parts: 1/1
       Granules: 1/1
     Ranges: 1
```

## Server settings that differ from defaults
```
max_connections	4096
default_database	default
max_concurrent_queries	100
uncompressed_cache_size	0
mark_cache_size	0
keep_alive_timeout	64
path	/var/lib/clickhouse/
user_files_path	/var/lib/clickhouse/user_files/
interserver_http_host	ch-server
interserver_http_port	9009
tmp_path	/var/lib/clickhouse/tmp/
format_schema_path	/var/lib/clickhouse/format_schemas/
mlock_executable	0
listen_try	1
query_cache.max_size_in_bytes	0
logger.level	error
logger.log	/var/log/clickhouse-server/clickhouse-server.log
logger.errorlog	/var/log/clickhouse-server/clickhouse-server.err.log
logger.console	0
distributed_ddl.path	/clickhouse/task_queue/ddl
config-file	/etc/clickhouse-server/config.xml
```
