# Plan 001: Metric filters

## Where it goes

- `libs/contracts/src/index.ts`: `MetricWhere` (a zod record with the key pattern, the value length and the
  ten-filter limit) and `where` on `MetricQueryRequest`. The MCP tool `query_metric` uses the same schema, so it gains
  the field with no other change.
- `libs/query/src/queries.ts`: `metricWhere(where, params)` returns one condition per key and fills `w<i>k` and
  `w<i>v` parameters; `metricQuery` adds them to its `WHERE` list, which every variant (gauge, sum, rate, histogram
  avg and quantiles) already shares.
- `apps/api/src/telemetry.ts`: passes `where` through.

## Checked against the source

- `groupBy` already reads `if(mapContains(Attributes, k), Attributes[k], ResourceAttributes[k])` with the key as a
  parameter (`queries.ts`, `metricQuery`), so filters read attributes the same way: kubelet stats carry
  `k8s.namespace.name`, `k8s.pod.name`, `k8s.container.name` and `k8s.cluster.name` on the resource.
- The `where` list is interpolated into each inner `SELECT` of the sum and histogram queries, so one change covers
  them all.
- `topSeries` (ten series plus `other`) runs after the query, so a filter is what lets a small series through.

## Not in this feature

Inequality, `IN` lists and wildcards; filters on the other routes (search has its own query language).
