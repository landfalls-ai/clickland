# Study: what Craft Anything and the live stack recorded

Evidence behind `docs/research/`. Every folder here was written by a tool, not by hand.

| Folder | What | How it was made |
|---|---|---|
| `clickhouse-cloud-page/` | The ClickHouse Cloud campaign page: screenshots at 1440 and 390 px, design tokens, layout, visible text | Craft Anything `web_site_capture`, clean room (only what a visitor sees) |
| `clickstack-ui/<screen>/` | Every ClickStack screen (search, services, service map, chart explorer, dashboards, ClickHouse, Kubernetes, sessions, alerts, LLM) with synthetic data loaded | Craft Anything `web_site_capture`, Deep mode, against the local stack; `session.jsonl` is the raw MCP session |
| `clickstack-source-graph/` (git-ignored; `scripts/study-source-graph.sh`) | Source graphs of the HyperDX packages (api, app, common-utils, cli, otel-collector): every file with its sha256 and language, and for TypeScript its exports, imports and functions | Craft Anything `app_source_import` |
| `clickstack-live/probe.md` | How ClickHouse stored and indexed synthetic OTel data: parts, compression, `EXPLAIN indexes=1` for a log search and a trace lookup, changed server settings | `clickhouse-client` in the study container |

Re-run the live parts with `scripts/study-clickstack.sh` (starts `deploy/study/compose.yaml` as the `clickland-study`
compose project on OrbStack).
