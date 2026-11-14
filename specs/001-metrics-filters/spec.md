# Feature 001: Metric filters

**Status**: implemented 2026-11-14 · **Plan**: [plan.md](plan.md) · **Tasks**: [tasks.md](tasks.md)

## Why

`POST /api/metrics/query` can narrow a metric to one service and split it by one attribute, but not narrow it to one
namespace, pod or node. Landlens (the land family's Kubernetes IDE) draws a pod's CPU and memory per container from
the kubelet stats Clickland stores under service `kubernetes`; without a filter it would have to fetch every pod's
series and keep one, and the API keeps only the top ten series, so a small pod would never come back at all.

## User stories

1. **As Landlens**, I ask for `container.cpu.usage` where `k8s.namespace.name` is `landlens-dev` and `k8s.pod.name` is
   `catalog-api-…`, split by `k8s.container.name`, and get that pod's containers only.
2. **As an agent over MCP**, `query_metric` takes the same filters.
3. **As an operator**, no filter value can change the SQL: it travels as a ClickHouse query parameter.

## Acceptance

- `where` is an optional object of attribute name → string value; every pair must match. A key is a data-point
  attribute, else a resource attribute of that name (as `groupBy` reads them); `service` means the service name.
- Keys must look like attribute names (`^[A-Za-z_@][\w.\-@/]*$`, at most 200 characters); at most ten filters;
  values are strings of at most 500 characters. Anything else is `400 bad_request`.
- Keys and values are both query parameters; the SQL text never holds them. A value such as `x' OR 1=1 --` matches
  nothing and fails nothing.
- Gauges, sums (rate and plain) and histograms (avg and quantiles) all take it.
- A request without `where` is answered exactly as before.
