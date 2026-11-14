# ClickHouse, Inc.: every product, and what Clickland does about each

An inventory of what ClickHouse, Inc. offers as of 14 November 2026, checked against Clickland's plan
([plan.md](../plan.md), option B: run open-source ClickHouse unchanged, build the observability layer on a
ClickStack-compatible schema). For each item: what it is, whether it is open source, and a verdict.

Sources, in order of weight:

- the ClickHouse docs, which now live in the server repository (`upstream/clickhouse/docs`, commit `1b7851a`,
  14 November 2026; the old `clickhouse-docs` repository is archived). This includes the Cloud docs, the Cloud
  changelog (`docs/resources/changelogs/cloud/2026.mdx`), ClickStack, Managed Postgres, BYOC and Agents. A URL below
  is `https://clickhouse.com/docs` plus the page's `slug`;
- the server source (`upstream/clickhouse`, Apache-2.0) and ClickStack (`upstream/clickstack-hyperdx` at `0096a35`,
  MIT);
- GitHub repository metadata (licences) read with `gh api`;
- clickhouse.com pages and blog posts, fetched without signing in.

Nothing contacted ClickHouse Cloud. The live list of Cloud previews is served by the console
(`console.clickhouse.cloud/previews.json`), so it was not read; previews below come from the docs and the changelog.

Verdicts:

- **build**: Clickland implements it in its own layer (module named).
- **run**: we get it by running OSS ClickHouse, ClickStack-compatible components or the OTel Collector.
- **defer**: does not apply to an internal single-company observability system yet (reason given).
- **n/a**: does not apply.

Tags: [marketing] = found only in marketing copy; [unconfirmed] = not confirmed in a primary source.

---

## Summary

- **The company now sells four things on one Cloud**: the ClickHouse database (Cloud, BYOC), Postgres (Managed
  Postgres, GA 11 Nov 2026), observability (ClickHouse Observability, public beta 10 Nov 2026, built on ClickStack) and
  AI engineering (Langfuse, acquired 16 January 2026). Two more are in private preview: ClickHouse Security (an
  agentic SIEM from the RunReveal acquisition, 16 September 2026) and Observability Apps. Acquisitions so far: chDB
  (team, March 2024), PeerDB (July 2024), HyperDX (March 2025), LibreChat (November 2025), Langfuse, RunReveal and Xata
  (Postgres branching, 9 November 2026). ClickHouse did not buy Mooncake (Databricks did).
- **ClickStack is still MIT and still the reference design.** The OSS repo (renamed `ClickHouse/ClickStack`) ships
  search, traces, metrics, session replay, alerts, dashboards with templates, service map, Kubernetes, ClickHouse and
  **LLM** dashboards, event patterns and deltas, an AI assistant (bring your own Anthropic or OpenAI key), a PromQL
  endpoint, an external API, a CLI/TUI (`hdx`), an MCP server and an MCP eval harness (`hdx-eval`).
- **The Cloud-only observability features are the AI and ML layer**: anomaly-detection alerts, AI Notebooks,
  Text-to-Dashboard, Observability Apps, fine-grained RBAC, and the managed OTLP and Datadog-compatible endpoints.
  These are what Clickland has to build itself if it wants them.
- **Open-source ClickHouse now embeds UIs.** Besides `/play` (now with tabs, notebooks and charts) and `/dashboard`,
  the server serves the ClickStack UI at `/clickstack` (not for production: no alerts, no persistence) and the Cloud
  SQL Console at `/ui` (experimental). `/webterminal` (a `clickhouse-client` shell over WebSocket) is **on by
  default**. Clickland gets an admin SQL console for free, and must keep the HTTP port private.
- **Agents**: ClickHouse Agents (Cloud, beta, Claude-powered, built on LibreChat) is a no-code agent builder with MCP
  servers, skills, subagents, memory and a marketplace. Landflow already does this job for the land family, so
  Clickland's part is a good MCP server and an agent persona in Landflow. The open-source "Agentic Data Stack"
  (ClickHouse + LibreChat + Langfuse + `mcp-clickhouse`, Apache-2.0) is the self-hosted version of the same idea.
- **Most of the rest does not apply**: ClickPipes, BYOC, marketplaces, tiers, autoscaling, idling, SharedMergeTree,
  Managed Postgres, the lakehouse catalogs and dbt are for a multi-tenant cloud or a data warehouse, not an internal
  observability system. The OSS equivalents (Kafka and S3Queue engines, ReplicatedMergeTree and Keeper, the
  Kubernetes operator, `BACKUP`) are there when we need them.
- **Build list, top five**: the search compiler and log search, the trace view, alerts that start Landflow workflows,
  the MCP server, and dashboards with templates. Then ClickHouse self-monitoring, the LLM/agent dashboard and backups.
  Full ranking below.

---

## Parity matrix

### Observability

| Item | What | Open source? | Verdict | Clickland module |
|---|---|---|---|---|
| ClickStack (HyperDX + ClickStack OTel Collector + ClickHouse) | The observability stack: OTel ingest, `otel_*` schema, Next.js UI and Express API, MongoDB for metadata. HyperDX was acquired in March 2025; ClickStack in Cloud went to private preview in Aug 2025 and got alerts in Nov 2025; the repo is now `ClickHouse/ClickStack`. | Yes, MIT | **run** (wave 1 bridge), then **build** our own layer on the same tables | `deploy/` bridge; plan option B |
| Log search | Lucene-style or SQL search, filter sidebar with facet counts, live tail, saved searches, row side panel, URL state. | Yes (MIT) | **build** | search compiler, console search view |
| Trace explorer | Trace waterfall, span side panel, related logs, trace breakdown. The MCP server exposes `trace/waterfall` and `trace/breakdown`. | Yes (MIT) | **build** | console trace view, MCP |
| Metrics and chart explorer | Charts over `otel_metrics_*` (gauge, sum, histogram, summary), chart explorer, SQL visualizations. | Yes (MIT) | **build** | chart compiler, console charts |
| PromQL source and Prometheus HTTP API | ClickStack serves `/api/prometheus/query`, `query_range`, `labels`; the server's own Prometheus API over a `TimeSeries` table is experimental in OSS and a private preview in Cloud (Sep 2026). | Yes (MIT; server Apache-2.0, experimental) | **defer**: needs the experimental `TimeSeries` engine; Clickland stores metrics in plain `otel_metrics_*` (research §5) | — |
| Session replay and browser RUM | rrweb recordings in `hyperdx_sessions`, linked to traces. New SDK `@clickhouse/clickstack-browser` (Oct 2026). | Yes (MIT; SDK Apache-2.0) | **defer**: the land family's users are staff; traces and logs answer most questions first; replay adds privacy work | — |
| Alerts | Saved-search alerts, dashboard-chart alerts and SQL-based chart alerts (May 2026), run every minute (`checkAlerts`), to Slack, PagerDuty, webhook, email. | Yes (MIT) | **build** | alerts (periodic SQL → Landflow workflow) |
| Anomaly-detection alerts | A detection mode on search and chart alerts that learns the expected range from recent history instead of a fixed threshold; backtest through MCP. | **Cloud only** (beta, "not available in ClickStack Open Source") | **build** (later) | alerts: baseline bands |
| Dashboards | Tiles from the chart builder or SQL, dashboard filters, variables, import/export, row-click drill-downs, release markers. | Yes (MIT) | **build** | dashboards |
| Dashboard templates | Prebuilt JSON dashboards: browser RUM, .NET, Go, JVM, Node.js, Python runtimes. | Yes (MIT) | **build** | dashboards: templates for Node.js (Landflow), Python, Go plugins |
| Services dashboard | Per-service RED view (rate, errors, duration) from spans. | Yes (MIT) | **build** | dashboards: service page |
| Service map | Graph of services and calls derived from parent/child spans. | Yes (MIT) | **build** | service map (wave 4) |
| Kubernetes dashboard | Pods, nodes, namespaces from `k8sattributes` and kubelet metrics. | Yes (MIT) | **build** (low) | dashboards: Kubernetes template; collector `k8sattributes` (run) |
| ClickHouse dashboard | ClickStack's page over the store itself (queries, inserts, merges, parts). | Yes (MIT) | **build** | self-monitoring page |
| LLM observability dashboard | ClickStack's `/llm` page over OTel `gen_ai.*` spans (and OpenInference): tokens, cost from a model price table, latency, errors, sessions, agent tool calls. | Yes (MIT) | **build** | dashboards: AI page for Landflow AI calls and Landfall agent turns |
| Event patterns | Drain log-template mining, grouping a search into patterns with counts. | Yes (MIT) | **build** | analysis: patterns (wave 4) |
| Event deltas | Compares attribute distributions between a selected outlier set and the baseline. | Yes (MIT) | **build** | analysis: deltas |
| Denoise and emerging signals | MCP query tools that hide high-volume repetitive patterns and surface patterns that are new in a window. | Yes (MIT, in `packages/api/src/mcp/tools/query`) | **build** | analysis + MCP |
| AI assistant: Text-to-Chart | Natural language to a chart config. OSS uses `AI_PROVIDER` (`anthropic` or `openai`) and `AI_API_KEY`; Cloud manages the model. | Yes (MIT; BYO key) | **build** | AI: via Landflow's model gateway |
| Text-to-Dashboard | Prompt → a saved dashboard with tiles. | **Cloud only** (ClickHouse Observability) | **build** (later) | AI + dashboards |
| AI Notebooks | Investigation notebooks: an agent queries logs, traces and metrics and adds tiles (charts, tables, searches, notes); you add your own; branch and share. | **Cloud only** (beta since Jun 2026) | **build** (later) | console notebooks driven by a Landflow agent |
| Observability Apps | Prompt-driven, shareable apps over live telemetry; generated code runs in a sandbox with read-only queries as the viewer. | **Cloud only** (private preview, Nov 2026) | **defer**: depends on notebooks and dashboards first | — |
| ClickStack MCP server | MCP at `/api/mcp` (Streamable HTTP, bearer token): search, SQL, timeseries, patterns, deltas, trace waterfall, service health, PromQL, and CRUD for dashboards, alerts, saved searches, webhooks, sources. Cloud version at `mcp.clickhouse.cloud/clickstack` (OAuth). | Yes (MIT); hosted version Cloud | **build** (and **run** in the bridge) | MCP server |
| `hdx-eval` | Eval harness: synthetic telemetry with planted anomalies, Claude Code as an SRE agent against any MCP, LLM-as-judge grading. | Yes (MIT) | **run** (as a test tool) | MCP tests |
| External API v2, IaC import manifest, Terraform for ClickStack | REST API for dashboards, alerts, sources; `iac/import-manifest`; ClickStack resources in the Cloud Terraform provider (Aug 2026). | API yes (MIT); Terraform Cloud only | **build** | API: dashboards and alerts as code (JSON in git) |
| `hdx` CLI/TUI | Terminal search, tail, charts and SQL against a HyperDX instance. | Yes (MIT) | **defer**: the console and MCP come first | — |
| OpAMP remote collector config | The API serves `/v1/opamp` to configure collectors remotely. | Yes (MIT) | **defer**: one collector, configured from git | — |
| ClickHouse Observability, fully managed | ClickHouse runs ingestion, schema, compute and tuning; managed OTLP endpoint and a Datadog-compatible endpoint; $0.10/GB logs and traces in beta. Formerly the "ClickStack Cloud" private preview (Jun 2026). | **Cloud only** (public beta, 10 Nov 2026) | **run** for the OTLP part (our collector); Datadog endpoint **n/a** | collector |
| ClickHouse Observability, self-managed (was "Managed ClickStack") | ClickStack UI hosted in the Cloud console against your own Cloud service, with Cloud sign-in. | **Cloud only** | **n/a**: we host our own | — |
| Observability RBAC | Custom roles with no-access/read/manage per resource type (dashboards, saved searches, sources, alerts, webhooks, notebooks) plus per-resource rules by name, tag or ID. | **Cloud only** (beta) | **build** | auth: roles from Landbright groups |
| ClickHouse Security | Agentic SIEM: 100+ source integrations, log pipelines, detections-as-code, AI alert triage and chat investigation. Built on RunReveal (acquired Sep 2026). | **Cloud only** (private preview, Nov 2026) | **defer**: security analytics is a different product; revisit once Landbright audit logs flow into Clickland | — |
| Instrumentation SDKs | ClickStack wrappers over OTel SDKs: browser, Node.js (`@clickhouse/clickstack-node`, Oct 2026), Python, Go, Java, Ruby, Elixir, Deno, Next.js, NestJS, React Native, AWS Lambda; "instrument with AI" guide. | Yes (MIT / Apache-2.0) | **run** (plain OTel SDKs already in Landflow and Landbright) | — |
| Migration guides and skills | Elastic and Datadog migration docs; `kb2cs` skill to convert Kibana dashboards. | Docs; skill Apache-2.0 | **n/a** (we come from Grafana LGTM, dev only) | — |

### Console and querying

| Item | What | Open source? | Verdict | Clickland module |
|---|---|---|---|---|
| Cloud SQL console | Query editor with tabs, run selected or at cursor, table explorer with filter and sort that turns into SQL, cell inspector, saved and shared queries, result charts. | **Embedded in OSS** at `/ui` (experimental; bundle from `ClickHouse/clickhouse-sql-console`, Apache-2.0) | **run** (for admins) | `/ui` behind the private network |
| Play UI (`/play`) | The server's own single-file query UI: tabs, notebook mode (query and Markdown cells), result shaping, bar/heatmap cell colouring, `EXPLAIN` graphs, history, share, download. | Yes (Apache-2.0) | **run** | — |
| Built-in `/dashboard` | Server-hosted charts defined in `system.dashboards` (queries, merges, memory, CPU). Cloud's "Advanced dashboard" is this page. | Yes (Apache-2.0) | **run** | — |
| Other embedded pages | `/merges` (merge visualizer), `/schema`, `/binary`, `/jemalloc`, `/docs` (search over `system.documentation`), `/webterminal` (on by default), `/clickstack`. | Yes (Apache-2.0) | **run**, with `enable_webterminal = false` or the HTTP port private | `deploy/` config |
| Cloud dashboards | Dashboards from saved SQL queries, query parameters as filters, sharing; GA 2025. | Cloud only | **build** (same module as observability dashboards; SQL tiles) | dashboards |
| Query insights | Charts and tables over `system.query_log`: volume, latency p50/p90/p99, errors by kind, grouped by normalized hash; drill-down. Postgres version in private preview. | Cloud only (the data is OSS system tables) | **build** | self-monitoring: query insights page |
| Query API endpoints | Turn a saved query into an authenticated REST endpoint. | Cloud only | **build** (small) | API: saved-search endpoints for Landflow |
| Assistant (AI chat) | Console chat in Agent mode (multi-step over schema and metadata) or Docs AI mode; reads an `AGENTS.md` saved query as a semantic layer. | Cloud only | **build** in Landflow, not Clickland | Landflow persona + Clickland MCP + a Clickland `AGENTS.md`-style schema note served over MCP |
| AI SQL generation in the client | `clickhouse-client` and `clickhouse-local` turn natural language into SQL (25.7+, BYO Anthropic or OpenAI key). | Yes (Apache-2.0) | **run** | — |
| Service notifications and console monitoring | Email/console/Slack notices for service events (info, warning, critical); Service Health and Resource Utilization dashboards in the console (Apr 2026); admin emails for common issues. | Cloud only | **build** | alerts: built-in rule pack on ClickHouse health |
| Prometheus metrics endpoint | Cloud exposes metrics through its API; OSS serves `/metrics` from config. | Server endpoint yes (Apache-2.0) | **run** | collector scrapes it |
| `clickhousectl` | Official CLI: local ClickHouse versions and servers, local Postgres, Cloud services, ClickPipes, ClickStack resources, UDFs, keys, and installing agent skills. | Yes, Apache-2.0 | **run** (local commands only); Cloud commands **n/a** | — |
| SSH interface | `clickhouse-client` over SSH with a PTY. | Yes (experimental, not in Cloud) | **n/a** | — |
| Other protocols | HTTP, native TCP, gRPC, MySQL and Postgres wire, Arrow Flight, ADBC, ODBC/JDBC. | Yes | **run** | — |

### Ingest

| Item | What | Open source? | Verdict | Clickland module |
|---|---|---|---|---|
| OTel Collector (ClickStack distribution) | A custom OCB build with `clickhouseexporter`, memory limiter, transform, batch 10k/5s; OIDC bearer auth option. | Yes (MIT; exporter in collector-contrib, Apache-2.0) | **run** | `clickland-collector` |
| Ingestion API keys | ClickStack's per-team ingestion key on the collector. | Yes (MIT) | **build** | collector auth with Landbright-issued tokens |
| Ingest wizard / "Connect" flows | Cloud console "Connect" panel (drivers, MCP) and Data Sources tab; the current "upload a CSV" doc uses `clickhousectl`, so a console upload wizard is [unconfirmed]; ClickStack's install-instructions modal. | Cloud only (modal in OSS) | **build** (small) | console: "Add a source" page with OTLP env snippets |
| Vector integration | Ship logs with Vector into ClickHouse. | Docs | **defer**: the OTel Collector covers us | — |
| ClickPipes: Kafka (GA) | Managed Kafka ingest: Apache Kafka, Confluent, Redpanda, MSK, Google Managed Kafka, Event Hubs, WarpStream; schema registries, Avro/Protobuf, exactly-once (Jun 2026). | Cloud only | **defer**: no Kafka (research §9); OSS `Kafka` engine or Kafka Connect sink if needed | — |
| ClickPipes: Kinesis (GA), GCP Pub/Sub (private preview) | Managed stream ingest. | Cloud only | **n/a** | — |
| ClickPipes: object storage (GA) | S3 and S3-compatible (R2, Spaces, OVH), GCS, Azure Blob; continuous or one-time. | Cloud only | **defer**; OSS `S3Queue` engine is the equivalent | — |
| ClickPipes: Postgres CDC (GA 2025) | Postgres to ClickHouse CDC from RDS, Aurora, Cloud SQL, AlloyDB, Azure, Supabase, Neon, Crunchy, Timescale, PlanetScale, self-managed. Built on PeerDB (acquired July 2024). | Cloud only; PeerDB is AGPL-3.0 (was ELv2 until January 2026) | **defer**: telemetry does not come from Postgres | — |
| ClickPipes: MySQL/MariaDB CDC (GA Sep 2026), MongoDB CDC (GA Nov 2026), BigQuery (private preview) | Database CDC and warehouse loads. | Cloud only | **n/a** | — |
| WalShadow | Sub-second Postgres → ClickHouse replication from the physical WAL, for Managed Postgres. | AGPL-3.0 (`ClickHouse/walshadow`); Cloud integration private preview | **n/a** | — |
| `pg_stat_ch` | Postgres extension that exports raw per-query telemetry events to ClickHouse. | Apache-2.0 | **defer**: useful later to observe the land family's Postgres databases | — |
| Kafka Connect sink, Airflow provider, Fivetran, dbt | Connectors for data pipelines. | Apache-2.0 (sink, dbt); Fivetran vendor | **n/a** | — |

### Storage and operations

| Item | What | Open source? | Verdict | Clickland module |
|---|---|---|---|---|
| MergeTree engine, codecs, text index, TTL, tiered S3 disks | The store (research §2–§5). Text index GA 10 Mar 2026 (26.2, also 26.3 LTS). Lightweight `UPDATE` (patch parts) is in OSS too. | Yes, Apache-2.0 | **run** | schema migrations |
| SharedMergeTree, SharedCatalog | Cloud's compute/storage split with no manual sharding; shared metadata. | Cloud only | **n/a**; ReplicatedMergeTree + Keeper when needed | — |
| ClickHouse Keeper | Raft coordination for replication (ZooKeeper replacement). | Yes, Apache-2.0 | **run** (wave 5 only) | `deploy/` |
| Kubernetes operator | ClickHouse Inc's own operator for ClickHouse and Keeper clusters (CRDs, storage, TLS, scaling; Helm, kubectl, OLM). Young: v0.0.8 (Sep 2026), API `v1alpha1`. Altinity's operator (Apache-2.0, 0.27.x) is older and more mature but is not a ClickHouse Inc product; nor is Altinity's `clickhouse-backup`. | Yes, Apache-2.0 (`ClickHouse/clickhouse-operator`) | **run** (when we move to the `clickland-dev` namespace) | `deploy/k8s` |
| Backups | Cloud: daily by default with 24 h retention; on Scale and Enterprise, retention 1–45 days and frequency 6–48 h; export to your own S3, GCS or Azure bucket (Oct 2025). OSS has `BACKUP`/`RESTORE` to disk or S3. | Cloud scheduling only; `BACKUP` OSS | **build** (small) | ops: scheduled `BACKUP` to local MinIO + a restore drill |
| Vertical and horizontal autoscaling, scheduled scaling, make-before-break | Cloud resizes replicas and replica count by load or schedule. Horizontal autoscaling is "Beta" on its page but "private preview" in the Jun 2026 changelog, and cannot run with vertical autoscaling. | Cloud only | **defer**: one node at our volume | — |
| Idling | Services stop when idle and wake on query. | Cloud only | **n/a**: telemetry arrives all the time | — |
| Warehouses (compute-compute separation) | Several compute groups over the same storage; read-only groups; idling primaries. | Cloud only | **defer**; OSS answer is a separate read user, settings profile and `CREATE WORKLOAD` (ClickStack "isolating read/write" guide) | ClickHouse users and profiles (D8) |
| Parallel replicas | Split one query's reads across replicas. | Yes (Apache-2.0) | **defer** (cluster only) | — |
| Replica-aware routing, sticky routing, on-demand compute, index sharding | Cloud routing and elastic compute features (public beta / private previews in 2026). | Cloud only | **n/a** | — |
| Executable UDFs in Cloud | Python or binary UDFs deployed to Cloud (GA Oct 2026). OSS has had executable UDFs for years. | OSS feature; Cloud deploy is Cloud only | **defer**: an example is `llm-token-udf` (token counting for LLM spans) | — |
| Users, roles, row policies, quotas, settings profiles | RBAC in the server. | Yes | **run** | readonly UI user, quota per end user (D8) |
| SSO, SAML, approved domains, console roles | Cloud console identity. | Cloud only | **build** | console sign-in through Landbright OIDC |
| JWT authentication to services | Ephemeral users from signed JWT claims (GA Sep 2026). | **Cloud only** (`CloudOnlyBadge`) | **build** | API maps the Landbright user to the readonly ClickHouse user and `quota_key` |
| Audit logging | Console audit log (Audit tab, CSV export, API `activity` endpoint); database audit through `system.session_log` and `system.query_log`. | Console log Cloud only; system tables OSS | **build** | API audit table (who ran which search, changed which alert) |
| Private networking, IP access lists, CMEK/TDE, HIPAA/PCI, regions, uptime SLA | Cloud security and compliance. | Cloud only | **n/a** | — |

### AI and agents

| Item | What | Open source? | Verdict | Clickland module |
|---|---|---|---|---|
| `mcp-clickhouse` | Open-source MCP server (stdio or streamable HTTP) with a query tool, `list_databases`, `list_tables`, and a chDB query tool when enabled; read-only unless `CLICKHOUSE_ALLOW_WRITE_ACCESS` is set. v0.7.0 (Sep 2026). | Yes, Apache-2.0 | **run** (for admin agents, with the readonly user) | — |
| Remote MCP server (Cloud) | Hosted MCP at `mcp.clickhouse.cloud/mcp`, OAuth or API key, all tools read-only: queries, schema, services, backups, ClickPipes, billing, Postgres slow queries and metrics. Launched in beta with Ask AI around September 2025; current status not stated [unconfirmed]. | Cloud only | **build** (the observability subset) | MCP server behind Landflow's MCP gateway |
| ClickHouse Agents | Claude-powered agent platform (`ai.clickhouse.cloud`): no-code Agent Builder, MCP servers, skills, subagents, code interpreter, web search, memory, prompt library, marketplace, scheduled chats (Oct 2026); built on LibreChat (acquired Nov 2025). Public beta Jun 2026, no extra charge in beta. Its forerunners were the AgentHouse demo (Apr 2025) and the internal DWAINE agent. | Cloud only | **build in Landflow** (a Clickland SRE persona), not in Clickland | Landflow agents + Clickland MCP |
| Agentic Data Stack | Self-hosted ClickHouse + LibreChat + Langfuse + `mcp-clickhouse` in one compose. | Yes, Apache-2.0 (`ClickHouse/agentic-data-stack`) | **n/a**: Landflow is our agent platform | — |
| Langfuse | LLM engineering platform: tracing, sessions, evals, prompt and skill management, datasets, experiments; stores traces in ClickHouse, metadata in Postgres, queue in Redis, payloads in S3. Acquired 16 January 2026. | MIT outside the `ee/` directories (SCIM, extended audit log, data retention need a licence key); Langfuse Cloud is SaaS | **defer**: Clickland's LLM dashboard covers tracing; evals and prompt management belong to Landflow if anywhere | — |
| Langfuse AI Gateway | Routes model requests (OpenAI, Anthropic, then Bedrock, Azure, Google, OpenRouter) to trace usage and cost per user, key and model without code changes; written in Rust. | MIT core per Langfuse's changelog, self-hostable; public beta 4 Nov 2026 | **n/a**: Landflow already brokers model calls | — |
| AI SQL functions | `aiGenerate`, `aiClassify`, `aiExtract`, `aiTranslate` (26.4), `aiEmbed` (26.6), `aiFilter`, `aiRedact`, `aiSimilarity` (26.8), with quotas, retries, an `AI FUNCTIONS` grant and credentials in named collections. | Yes (beta in OSS). The reference page says not available in Cloud; the launch blog says private preview in Cloud | **defer**: cost and prompt-injection risk; maybe `aiClassify` for log triage later | — |
| Vector search | `vector_similarity` index (HNSW; GA from 25.8) and the `QBit` type for precision chosen at query time (experimental in 25.10; later GA [unconfirmed]); quantized codec experimental. | Yes, Apache-2.0 | **defer**: no embedding search in scope | — |
| Agent skills | Official skills for ClickHouse and Cloud for coding agents; also plugins for Cursor (ClickStack) and Grok. | Yes, Apache-2.0 | **run** (install into Claude Code for Clickland development) | — |
| `loom` | Shared long-term memory, document search and code index for agents, on ClickHouse, with an MCP server. | Yes, Apache-2.0 | **n/a**: Landflow has its own notebook and brain | — |
| `data-agent-mnist` | Turns a warehouse and real questions into a benchmark for analytical agents. | Yes, Apache-2.0 | **defer**: a model for testing Clickland's agent answers | — |
| Docs AI | Docs Q&A mode of the console assistant; `llms.txt`-style docs. | Cloud | **n/a** | — |

### Developer tools

| Item | What | Open source? | Verdict | Clickland module |
|---|---|---|---|---|
| `clickhouse-local` | The full engine as a CLI over local files, no server. | Yes, Apache-2.0 | **run** (compile-and-run tests for the search compiler) | compiler tests |
| `clickhouse-client`, `clickhouse-format`, `clickhouse-benchmark`, `clickhouse-disks`, `clickhouse-obfuscator`, `clickhouse-keeper-client` | Server-side tools in the same binary. | Yes, Apache-2.0 | **run** | — |
| chDB | ClickHouse as an in-process library (Python v4.4, pandas-compatible DataStore API; bindings for Node, Go, Rust); also a Postgres extension. The team joined ClickHouse in March 2024. | Yes, Apache-2.0 | **defer**: useful for offline analysis notebooks | — |
| Client libraries | `clickhouse-js`, `clickhouse-connect` (Python, v1.0 May 2026, now 1.12 with async), `clickhouse-go`, `clickhouse-java` (with JDBC), `clickhouse-rs`, `clickhouse-cs` (.NET, native TCP in v1.5, Oct 2026), `clickhouse-cpp`, ODBC. | Yes (Apache-2.0; .NET MIT) | **run** (`@clickhouse/client` in clickland-api) | API driver |
| Grafana plugin | ClickHouse data source for Grafana, with OTel log and trace views. | Yes, Apache-2.0 (Grafana Labs) | **defer**: only if we keep Grafana during migration | — |
| BI connectors (Metabase, now in Metabase core; Superset via clickhouse-connect; Tableau; Power BI) | Visualization integrations. | Mixed | **n/a** | — |
| Terraform provider | Manages Cloud services, ClickPipes, ClickStack resources. | Apache-2.0, but Cloud API only | **n/a** | — |
| `pg_clickhouse` | Postgres FDW that pushes queries down to ClickHouse. | Yes, Apache-2.0 | **defer**: Landflow could read Clickland through Postgres, but MCP and the API come first | — |
| SQL tooling: `clickhouse-lexer` (WASM, npm), `clickhouse-parser` (WASM) | Lexer and parser for editors. | Yes, Apache-2.0 | **run** (syntax highlighting and validation in the console's SQL mode) | console SQL editor |
| `ggsql` | SQL extension for declarative charts (grammar of graphics). | MIT [unconfirmed status] | **n/a** | — |

### Lakehouse and warehouse

| Item | What | Open source? | Verdict | Clickland module |
|---|---|---|---|---|
| Iceberg, Delta Lake, Hudi, Paimon | Table engines and functions over open table formats. Iceberg reads GA (pruning, schema evolution, time travel, deletes), Iceberg `INSERT` beta (26.2+); Delta reads GA, `INSERT` beta (26.7+); Hudi read-only; Paimon experimental. | Yes, Apache-2.0 | **defer**: telemetry lives in MergeTree; Parquet export on MinIO is enough for archives | — |
| `DataLakeCatalog` database engine and catalogs | A catalog appears as a database: AWS Glue, BigLake, Lakekeeper, OneLake, Nessie, Polaris, Horizon, REST, Unity (Iceberg and Delta), Hive, Delta Sharing. Mostly beta, read-only; Unity and OneLake also write (May 2026). | Yes (OSS engine, beta/experimental settings); Cloud "Data sources" UI beta | **defer** | — |
| Data warehousing use case, dbt adapter v2 / dbt Platform, dbt Fusion adapter (alpha) | ClickHouse as a warehouse; "bring your own catalog" [marketing]. | Apache-2.0 (adapter) | **n/a** | — |

### Business and cloud only

| Item | What | Open source? | Verdict | Clickland module |
|---|---|---|---|---|
| ClickHouse Cloud tiers | Basic (1 TB, one zone, daily backup kept a day, no scaling); Scale (2+ zones, configurable backups, autoscaling, warehouses, private networking); Enterprise (CMEK/TDE, HIPAA, PCI, SAML, SCIM, scheduled upgrades, custom hardware, replica-aware routing). Since January 2025. | Cloud only | **n/a** | — |
| ClickHouse Private, ClickHouse Government | Self-deployed packaged editions, sold through sales. | Not open source | **n/a** | — |
| Billing, spend alerts, prepaid credits, usage breakdown, marketplaces (AWS, GCP, Azure) | Commercial features. | Cloud only | **n/a** | — |
| BYOC | Cloud-managed data plane in your own AWS (GA Feb 2025), GCP (GA Apr 2026) or Azure account (Azure Marketplace private offer, Jun 2026); needs a committed contract; no SQL console, ClickPipes or autoscaling. A new connector (`clicklink`) for Kubernetes clusters you operate is in private preview. | Cloud only | **n/a**: no cloud (local-only rule) | — |
| Managed Postgres | NVMe-backed Postgres built with Ubicloud: up to two standbys, PgBouncer, read replicas, PITR and branching from backups, CDC into ClickHouse, `pg_clickhouse` and `chdb` extensions, its own MCP tools. Preview Jan 2026, public beta May 2026, GA on AWS 9–11 Nov 2026; GCP private preview. "Up to 10x faster" is [marketing]. | Cloud only (extensions Apache-2.0) | **n/a**: Clickland's metadata uses our own Postgres (D7) | — |
| Xata (acquired Nov 2026) | Agent-native Postgres; for branching, cloning, scale-to-zero on the Managed Postgres roadmap. | — | **n/a** | — |
| Support, uptime SLA, regions | Commercial support and availability. | Cloud only | **n/a** | — |

---

## Previews (November 2026)

From the docs and the Cloud changelog. The console's own list was not read (see the top of the page).

- **Private preview**: ClickHouse Security; Observability Apps; `remoteSecure` between services; On-Demand Compute;
  PromQL over `TimeSeries`; BigQuery and Pub/Sub ClickPipes; Postgres query insights; WalShadow; Managed Postgres on
  GCP; index sharding; sticky replica routing over HTTPS; unified user identity; network-access UDFs; ClickHouse in
  dbt Platform; the BYOC connector (`clicklink`). ClickStack Cloud (Jun 2026) became the ClickHouse Observability beta.
- **Beta or public preview**: ClickHouse Agents; ClickHouse Observability (fully managed); AI Notebooks; anomaly
  detection; Observability RBAC; Langfuse AI Gateway; replica-aware routing; data catalogs; horizontal autoscaling
  (status conflicts, above); approved domains; dbt v2 adapter; ClickStack in Terraform; Fivetran destination.
- **Experimental settings** cannot be turned on in Cloud.

## Launch timeline, 2025–2026

| Date | Launch |
|---|---|
| Jan 2025 | Cloud tiers (Basic, Scale, Enterprise); warehouses GA; horizontal scaling GA; configurable backups |
| Feb 2025 | BYOC on AWS GA |
| Mar 2025 | HyperDX acquired; ClickStack follows |
| Apr 2025 | AgentHouse demo (LibreChat + Claude + MCP) |
| May–Jun 2025 | Postgres CDC ClickPipe GA; Cloud dashboards GA |
| Jul 2025 | SharedCatalog on new services; MySQL CDC public beta |
| Aug 2025 | ClickStack in Cloud, private preview |
| Sep 2025 | Ask AI agent and remote MCP server, public beta [date unconfirmed] |
| Oct 2025 | Backups to your own bucket |
| Nov 2025 | LibreChat acquired; Agentic Data Stack; ClickStack alerts in Cloud |
| Jan 2026 | Langfuse acquired with the Series D; Managed Postgres announced; Glue and Unity catalogs; MongoDB CDC public beta |
| Feb 2026 | BigQuery ClickPipe private preview |
| Mar 2026 | Text index (full-text search) GA in 26.2 |
| Apr 2026 | BYOC on GCP GA; Iceberg REST and OneLake catalogs; `clickhousectl` public beta; Cloud monitoring dashboards |
| May 2026 | Spend alerts GA; primary-service idling GA; SQL-based charts and alerts in ClickStack; Python client v1.0 |
| Jun 2026 (Open House) | ClickHouse Agents public beta; Managed Postgres public beta; ClickStack Cloud private preview; AI Notebooks beta; ClickStack MCP server (open source); horizontal autoscaling; Pub/Sub ClickPipe; BYOC on Azure Marketplace |
| Aug 2026 | ClickStack resources in Terraform; Langfuse traces from Agents |
| Sep 2026 | RunReveal acquired; JWT auth GA; MySQL CDC GA; PromQL and On-Demand Compute private previews; AI SQL functions blog (26.4–26.8) |
| Oct 2026 | Executable UDFs GA in Cloud; Kafka exactly-once; Agents scheduled chats |
| Nov 2026 | Managed Postgres GA (AWS); Xata acquired; ClickHouse Observability public beta; Observability Apps and ClickHouse Security private previews; Langfuse AI Gateway public beta; MongoDB CDC GA |

Not found: a Snowflake ClickPipe (none exists), `pg_duckdb` (not a ClickHouse product), a Mooncake acquisition
(Databricks bought it).

---

## Build list

Ranked by value for an internal observability system. Items 1–5 are plan waves 2–3; the rest follow.

| # | Build item | Module | Acceptance check |
|---|---|---|---|
| 1 | Search compiler and log search (Lucene-style and SQL, facets from rollups, live tail, saved searches) | search compiler, console search | A search for an error string over a day of Landflow logs returns in under 1 s and `EXPLAIN indexes=1` shows the text index skipping granules. |
| 2 | Trace view (waterfall, span panel, logs of the trace) | console trace view | A Landflow run opened from Run Trace via `LANDFLOW_TRACE_URL` shows every plugin span and its logs. |
| 3 | Alerts (saved-search, chart and SQL alerts) that start a Landflow workflow | alerts | An alert on Landflow plugin errors fires within two evaluation periods and posts to Slack through a Landflow flow. |
| 4 | MCP server (search, SQL through the readonly user, trace waterfall, patterns, service health, dashboards and alerts CRUD) | MCP | An agent behind Landflow's MCP gateway answers "why did run X fail" with the failing span and its error log, and `hdx-eval` scores it against a planted anomaly. |
| 5 | Dashboards and chart compiler, with templates (services RED, Node.js, Python, Go runtime) | dashboards, chart compiler | A long-range chart (30 days) reads an `AggregatingMergeTree` rollup, not raw rows, and the services dashboard shows rate, errors and p95 per Landflow service. |
| 6 | ClickHouse self-monitoring: query insights page and a built-in health rule pack (active parts per partition, disk, failed merges, query errors) | self-monitoring, alerts | Pushing a partition past 300 active parts in a soak raises an alert before inserts are throttled at 1,000. |
| 7 | LLM and agent dashboard over `gen_ai.*` spans (tokens, cost, latency, errors, sessions, tool calls) | dashboards: AI | Each Landflow AI call and Landfall agent turn shows model, tokens and cost, and totals per day match Landflow's own usage ledger. |
| 8 | Backups: scheduled `BACKUP` to local MinIO and a restore drill | ops | A restore into a fresh `clickland-dev` ClickHouse from last night's backup returns the same row counts per table and day. |
| 9 | Access: Landbright OIDC sign-in, roles from Landbright groups, readonly user with quotas per end user, audit table | auth, API | A user without the admin group cannot edit alerts, and every search they run is in the audit table with their `quota_key`. |
| 10 | Event patterns, event deltas, denoise | analysis | Patterns group a day of Landflow logs into templates with counts, and a delta view names the attribute that separates slow spans from normal ones. |
| 11 | Service map from spans | service map | The map shows Landflow host → plugins → Landbright edges with call counts and error rates that match the services dashboard. |
| 12 | Anomaly-detection mode on alerts (baseline band from recent history, backtest) | alerts | A backtest over 7 days of Landflow error counts reports which past spikes would have fired, and an injected spike fires in a soak. |
| 13 | AI investigation: Text-to-Chart, then notebooks driven by a Landflow agent | AI, console notebooks | "Error counts by service over the last 3 days" produces the same chart a person builds by hand, and a notebook keeps every generated query visible and editable. |
| 14 | Dashboards, alerts and saved searches as code (export/import JSON, API) | API | Exporting all dashboards and importing them into an empty instance recreates them exactly. |
| 15 | "Add a source" page | console | A new service sends its first span using only the snippet on that page. |
| 16 | Saved-search endpoints for Landflow | API | A Landflow node fetches a saved search's results over HTTP with a Landbright token. |
| 17 | Kubernetes dashboard template | dashboards | Once the collector runs in `clickland-dev`, the template shows pod restarts and CPU per Landflow pod. |

Not on the list because running OSS covers them: the SQL console (`/ui`), Play (`/play`), the built-in `/dashboard`,
Keeper and the operator, the clients, `clickhouse-local`, `mcp-clickhouse` and the agent skills.

---

## Findings worth acting on now

1. **Disable or fence the web terminal.** `enable_webterminal` defaults to `true` in 26.x
   (`src/Core/ServerSettings.cpp:1784`): any HTTP port serves a `clickhouse-client` shell to anyone with a password.
   Clickland's ClickHouse config should set it to `false` or keep port 8123 off every network but the cluster's.
2. **The embedded `/clickstack` UI is a cheaper wave-1 bridge than the full ClickStack stack**, but it has no alerts,
   no saved dashboards or searches and no event patterns. Keep the full ClickStack (with MongoDB) as the bridge if we
   want alerts before Clickland's own.
3. **`/ui` gives Clickland an admin SQL console with no work.** The console's own SQL mode can wait (build item
   dropped from the list), unless end users who are not admins need SQL.
4. **The OSS ClickStack MCP server is the spec for ours.** Its tool list (`packages/api/src/mcp/tools`) and
   `hdx-eval` give a ready test: run the same eval against ClickStack's MCP and Clickland's.

---

## Sources

Local (authoritative; read 14 November 2026):

- `upstream/clickhouse/docs/resources/changelogs/cloud/2026.mdx` and `archive/2025.mdx` — the Cloud changelog
  (https://clickhouse.com/docs/whats-new/changelog/cloud, https://clickhouse.com/docs/whats-new/cloud/2025).
- `upstream/clickhouse/src/Server/HTTPHandlerFactory.cpp` (embedded UIs: `/play`, `/dashboard`, `/merges`,
  `/schema`, `/binary`, `/jemalloc`, `/docs`, `/js/`, `/webterminal`, `/clickstack`, `/ui`), `programs/server/*.html`,
  `src/Core/ServerSettings.cpp:1784`, `.gitmodules` (`contrib/clickstack`, `contrib/sql-console`).
- `upstream/clickstack-hyperdx`: `packages/api/src/mcp/tools/`, `packages/api/src/routers/api/{ai,iac,prometheus}.ts`,
  `packages/api/src/config.ts:97`, `packages/app/src/llm/`, `packages/app/src/dashboardTemplates/`,
  `packages/cli/README.md`, `packages/hdx-eval/README.md`.
- Clickland's own reports: [clickstack.md](clickstack.md), [clickhouse-query-and-cluster.md](clickhouse-query-and-cluster.md),
  [clickhouse-storage.md](clickhouse-storage.md).

ClickHouse docs pages (local file under `upstream/clickhouse/docs/`, URL `https://clickhouse.com/docs<slug>`):

| Topic | Page |
|---|---|
| SQL console | https://clickhouse.com/docs/cloud/get-started/sql-console |
| Query insights | https://clickhouse.com/docs/cloud/get-started/query-insights |
| Cloud dashboards | https://clickhouse.com/docs/cloud/manage/dashboards |
| Query API endpoints | https://clickhouse.com/docs/cloud/features/query-api-endpoints |
| UDFs in Cloud | https://clickhouse.com/docs/cloud/features/user-defined-functions |
| ClickStack in the Cloud console | https://clickhouse.com/docs/cloud/manage/clickstack |
| AI and agents in Cloud | https://clickhouse.com/docs/cloud/features/ai-ml |
| Remote MCP server | https://clickhouse.com/docs/cloud/features/ai-ml/remote-mcp |
| Langfuse | https://clickhouse.com/docs/cloud/features/ai-ml/langfuse |
| Previews page | https://clickhouse.com/docs/products/cloud/features/self-service-previews |
| Backups | https://clickhouse.com/docs/cloud/features/backups |
| Scaling, idling, horizontal and scheduled scaling | https://clickhouse.com/docs/manage/scaling, https://clickhouse.com/docs/cloud/features/autoscaling/idling, https://clickhouse.com/docs/cloud/features/autoscaling/horizontal-autoscaling, https://clickhouse.com/docs/cloud/features/autoscaling/scheduled-scaling |
| Warehouses, SharedMergeTree, SharedCatalog | https://clickhouse.com/docs/cloud/reference/warehouses, https://clickhouse.com/docs/cloud/reference/shared-merge-tree, https://clickhouse.com/docs/cloud/reference/shared-catalog |
| On-demand compute, replica-aware routing | https://clickhouse.com/docs/cloud/features/on-demand-compute, https://clickhouse.com/docs/manage/replica-aware-routing |
| Monitoring: advanced dashboard, notifications, Prometheus | https://clickhouse.com/docs/cloud/manage/monitor/advanced-dashboard, https://clickhouse.com/docs/cloud/notifications, https://clickhouse.com/docs/integrations/prometheus |
| Cloud CLI and `clickhousectl` | https://clickhouse.com/docs/cloud/features/cli, https://clickhouse.com/docs/interfaces/cli |
| Data catalogs | https://clickhouse.com/docs/manage/data-catalogs, https://clickhouse.com/docs/integrations/data-catalogs, https://clickhouse.com/docs/engines/database-engines/datalakecatalog |
| Tiers, security, audit log, JWT | https://clickhouse.com/docs/cloud/manage/cloud-tiers, https://clickhouse.com/docs/cloud/security, https://clickhouse.com/docs/cloud/security/audit-logging, https://clickhouse.com/docs/operations/external-authenticators/jwt |
| Marketplaces, spend alerts | https://clickhouse.com/docs/cloud/marketplace/marketplace-billing, https://clickhouse.com/docs/cloud/manage/billing/spend-alerts |
| Managed Postgres, WalShadow, `pg_clickhouse`, `chdb` extension | https://clickhouse.com/docs/cloud/managed-postgres, https://clickhouse.com/docs/cloud/managed-postgres/walshadow, https://clickhouse.com/docs/cloud/managed-postgres/extensions/pg_clickhouse, https://clickhouse.com/docs/cloud/managed-postgres/extensions/chdb |
| Kubernetes operator | https://clickhouse.com/docs/clickhouse-operator/overview |
| BYOC | https://clickhouse.com/docs/cloud/reference/byoc/architecture, https://clickhouse.com/docs/products/bring-your-own-cloud/connector/overview |
| ClickHouse Agents, Assistant | https://clickhouse.com/docs/agents, https://clickhouse.com/docs/agents/builder, https://clickhouse.com/docs/agents/marketplace, https://clickhouse.com/docs/agents/memory, https://clickhouse.com/docs/use-cases/AI_ML/AIChat, https://clickhouse.com/docs/use-cases/AI_ML/AIChat/semantic-layer |
| ClickStack overview and ClickHouse Observability | https://clickhouse.com/docs/use-cases/observability/clickstack/overview, https://clickhouse.com/docs/clickstack/observability/overview |
| ClickStack features | https://clickhouse.com/docs/use-cases/observability/clickstack/search, https://clickhouse.com/docs/use-cases/observability/clickstack/alerts, https://clickhouse.com/docs/use-cases/observability/clickstack/dashboards, https://clickhouse.com/docs/use-cases/observability/clickstack/dashboards/dashboard-templates, https://clickhouse.com/docs/use-cases/observability/clickstack/dashboards/release-markers, https://clickhouse.com/docs/use-cases/observability/clickstack/session-replay, https://clickhouse.com/docs/use-cases/observability/clickstack/event_patterns, https://clickhouse.com/docs/use-cases/observability/clickstack/event_deltas, https://clickhouse.com/docs/use-cases/observability/clickstack/service-maps, https://clickhouse.com/docs/use-cases/observability/clickstack/integrations/kubernetes |
| ClickStack Cloud-only features | https://clickhouse.com/docs/clickstack/observability/features/anomaly-detection, https://clickhouse.com/docs/clickstack/observability/notebooks, https://clickhouse.com/docs/clickstack/observability/text-to-dashboard, https://clickhouse.com/docs/clickstack/observability/text-to-chart, https://clickhouse.com/docs/clickstack/observability/managing/rbac |
| ClickStack MCP | https://clickhouse.com/docs/use-cases/observability/clickstack/mcp, https://clickhouse.com/docs/clickstack/observability/mcp |
| ClickStack embedded in the server | https://clickhouse.com/docs/use-cases/observability/clickstack/deployment/clickhouse-embedded |
| ClickStack collector, SDKs, read/write isolation | https://clickhouse.com/docs/use-cases/observability/clickstack/ingesting-data/otel-collector, https://clickhouse.com/docs/use-cases/observability/clickstack/sdks, https://clickhouse.com/docs/clickstack/self-configured/managing/isolating-read-write |
| ClickPipes | https://clickhouse.com/docs/integrations/clickpipes (connector list in `snippets/_clickpipes_connectors.mdx`), https://clickhouse.com/docs/integrations/clickpipes/kafka, https://clickhouse.com/docs/integrations/clickpipes/postgres, https://clickhouse.com/docs/integrations/clickpipes/bigquery/overview, https://clickhouse.com/docs/integrations/clickpipes/pubsub |
| Server UIs and interfaces | https://clickhouse.com/docs/interfaces/sql-console, https://clickhouse.com/docs/interfaces/web-sql, https://clickhouse.com/docs/interfaces/web-ui-notebook, https://clickhouse.com/docs/interfaces/web-terminal, https://clickhouse.com/docs/interfaces/documentation-search, https://clickhouse.com/docs/interfaces/prometheus, https://clickhouse.com/docs/interfaces/prometheus-metrics, https://clickhouse.com/docs/interfaces/mcp |
| Tools | https://clickhouse.com/docs/operations/utilities/clickhouse-local, https://clickhouse.com/docs/chdb |
| AI features in the server | https://clickhouse.com/docs/use-cases/AI/ai-powered-sql-generation, https://clickhouse.com/docs/sql-reference/functions/ai-functions, https://clickhouse.com/docs/engines/table-engines/mergetree-family/annindexes, https://clickhouse.com/docs/use-cases/AI/qbit-vector-search, https://clickhouse.com/docs/use-cases/AI/MCP/librechat |

Blog posts:

- Announcing the ClickHouse platform's largest expansion (9 Nov 2026): Managed Postgres GA, ClickHouse Observability
  public beta, ClickHouse Security private preview, Langfuse AI Gateway public beta, Xata acquisition; RunReveal
  acquired in September and Langfuse in January —
  https://clickhouse.com/blog/announcing-clickhouse-platform-largest-expansion
- Announcing ClickHouse Observability (10 Nov 2026) — https://clickhouse.com/blog/announcing-clickhouse-observability
- Managed Postgres GA and the Xata acquisition — https://clickhouse.com/blog/managed-postgres-ga-xata-acquisition
- ClickHouse welcomes RunReveal (16 Sep 2026) — https://clickhouse.com/blog/clickhouse-welcomes-runreveal
- Langfuse joins ClickHouse (16 Jan 2026) — https://langfuse.com/blog/joining-clickhouse
- ClickHouse acquires LibreChat (4 Nov 2025) — https://clickhouse.com/blog/clickhouse-acquires-librechat
- HyperDX acquisition press release (13 Mar 2025) — https://www.businesswire.com/news/home/20250313954782/en/
- ClickHouse acquires PeerDB (30 Jul 2024) — https://clickhouse.com/blog/clickhouse-acquires-peerdb-to-boost-real-time-analytics-with-postgres-cdc-integration
- chDB joins ClickHouse (6 Mar 2024) — https://clickhouse.com/blog/chdb-joins-clickhouse-family
- ClickHouse Agents beta (9 Jun 2026) — https://clickhouse.com/blog/clickhouse-agents-beta
- Ask AI agent and remote MCP server beta (2025) — https://clickhouse.com/blog/agentic-analytics-ask-ai-agent-and-remote-mcp-server-beta-launch
- AgentHouse demo (24 Apr 2025) — https://clickhouse.com/blog/agenthouse-demo-clickhouse-llm-mcp
- Open House 2026 day 1 recap — https://clickhouse.com/blog/open-house-2026-day-1
- ClickStack AI notebooks — https://clickhouse.com/blog/clickstack-ai-notebooks
- LLM observability with ClickStack and MCP — https://clickhouse.com/blog/llm-observability-clickstack-mcp
- AI functions in ClickHouse (11 Sep 2026) — https://clickhouse.com/blog/ai-functions-in-clickhouse
- Full-text search GA (10 Mar 2026) — https://clickhouse.com/blog/full-text-search-ga-release
- Introducing `pg_clickhouse` — https://clickhouse.com/blog/introducing-pg_clickhouse
- Data lake support matrix — https://clickhouse.com/docs/use-cases/data-lake/support-matrix
- Langfuse AI Gateway public beta (4 Nov 2026) — https://langfuse.com/changelog/2026-11-04-ai-gateway-public-beta

Blog page metadata dates on clickhouse.com are unreliable (many show July 2026); dates above come from the post text
or a second source.

GitHub (licences from `gh api repos/<repo>`, 14 November 2026):

| Repository | Licence |
|---|---|
| https://github.com/ClickHouse/ClickHouse | Apache-2.0 |
| https://github.com/ClickHouse/ClickStack (was `hyperdxio/hyperdx`) | MIT |
| https://github.com/ClickHouse/mcp-clickhouse | Apache-2.0 |
| https://github.com/ClickHouse/agentic-data-stack | Apache-2.0 |
| https://github.com/ClickHouse/agent-skills | Apache-2.0 |
| https://github.com/ClickHouse/clickhousectl | Apache-2.0 |
| https://github.com/ClickHouse/clickhouse-operator | Apache-2.0 |
| https://github.com/ClickHouse/clickhouse-sql-console | Apache-2.0 |
| https://github.com/ClickHouse/clickstack-browser, https://github.com/ClickHouse/clickstack-node | Apache-2.0 |
| https://github.com/ClickHouse/pg_clickhouse, https://github.com/ClickHouse/pg_stat_ch | Apache-2.0 |
| https://github.com/ClickHouse/walshadow | AGPL-3.0 |
| https://github.com/PeerDB-io/peerdb | AGPL-3.0 (since 13 Jan 2026; ELv2 before) |
| https://github.com/LibreChat-AI/LibreChat | MIT |
| https://github.com/chdb-io/chdb | Apache-2.0 |
| https://github.com/langfuse/langfuse | MIT outside `ee/` directories; `ee/` under its own licence |
| https://github.com/ClickHouse/clickhouse-js, clickhouse-connect, clickhouse-go, clickhouse-java, clickhouse-rs | Apache-2.0 |
| https://github.com/ClickHouse/clickhouse-cs | MIT |
| https://github.com/ClickHouse/clickhouse-kafka-connect, terraform-provider-clickhouse, dbt-clickhouse | Apache-2.0 |
| https://github.com/grafana/clickhouse-datasource | Apache-2.0 |
| https://github.com/ClickHouse/loom, data-agent-mnist, llm-token-udf, kb2cs, clickhouse-lexer, clickhouse-parser | Apache-2.0 |
