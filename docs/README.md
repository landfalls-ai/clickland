# Clickland docs

| Page | What it covers |
|---|---|
| [research.md](research.md) | The findings in one page, and the decisions they lead to |
| [research/clickhouse-storage.md](research/clickhouse-storage.md) | ClickHouse storage: MergeTree parts, granules and marks, codecs, skip and text indexes, inserts, merges, TTL, types, disks |
| [research/clickhouse-query-and-cluster.md](research/clickhouse-query-and-cluster.md) | ClickHouse queries and clusters: parser → analyzer → planner → pipeline, vectorized execution, aggregation, the server and protocols, Distributed, replication, Keeper, system tables |
| [research/clickstack.md](research/clickstack.md) | ClickStack (HyperDX): the OTel schema, the collector, the search-to-SQL compiler, patterns, alerts, MCP |
| [research/clickhouse-products.md](research/clickhouse-products.md) | Every ClickHouse, Inc. product as of November 2026, a parity matrix with a verdict for each, and the ranked build list |
| [plan.md](plan.md) | The proposed architecture and waves |
| [landfall.md](landfall.md) | Clickland and Landfall: Clickland as a remote source, alerts straight to a war room, the Landfall dashboard and alert pack |
| [reference/api.md](reference/api.md) | The API contract, including Landfall's Source Protocol face (`/v1`) |
| [history.md](history.md) | Every change, in order |
| [../study/README.md](../study/README.md) | The evidence: Craft Anything captures, source graphs, live probes |
- [console.md](console.md): the web app's pages, its MCP App views, and the API gaps it still has
- [sources.md](sources.md): what sends data to Clickland (the land apps, Docker, Kubernetes) and how
- [research/land-family-integrations.md](research/land-family-integrations.md): how each land project connects to Clickland (Landfall's war room first), with a phased plan and open questions
- [agent-value.md](agent-value.md): AI agents from visibility to business value: the inventory, operations, a run's decision path, the value model (outcomes, ROI), quality and safety, alerts, Claude Code's telemetry, and the console spec
- [reference/api.md](reference/api.md): the API contract, with `/api/agents/*` and `/api/value/*`
