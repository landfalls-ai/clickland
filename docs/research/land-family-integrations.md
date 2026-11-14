# Clickland and the land family: integrations

Status: **proposed, 14 November 2026.** A design, not a build. No code in any repository was changed to write it.

Paths are relative to `~/WorkSpace`. "Landfall" below means the `dev` branch at `21d88f7a`; "Landflow" means `main`
unless the `landflow-clickland` worktree (branch `clickland-integration`) is named.

## The short version

- **Landfall already has every door Clickland needs.** A token ingest route with dedup and recovery, a "remote source"
  protocol, a generic MCP-server source, a timeline API and artifacts. Nothing has to be invented on its side.
- **Landflow already joins the two.** It has a Landfall plugin on `main` and a Clickland plugin on a branch, and its
  triage flow already reads Clickland alerts and opens Landfall rooms. That path has never run against the real
  products.
- **One step needs no code at all:** connect Clickland's MCP server to Landfall as an "MCP server" integration.
  Landfall's investigator and every agent that joins a room then get Clickland's 13 read tools.
- **Clickland's own work is three contract changes:** a severity on alerts, a Landfall Source Protocol face
  (`/v1/*`), and a Landfall destination for alert webhooks that keeps the room's link.
- **Rejected for now:** resolving a room automatically, live Clickland views embedded inside the room, a new trigger
  provider in Landfall, OTel from the Edge app, and Clickland as a source inside the agent kit.

## 1. The family, one line each

- **Clickland** (`clickland/`): observability on ClickHouse. Surfaces: the collector (OTLP gRPC `127.0.0.1:24317`,
  HTTP `24318`, `deploy/compose.infra.yml`), the API on `4710`, signed webhooks, notes, knowledge search, views, and
  MCP at `/api/mcp` (`docs/reference/api.md`).
- **Landfall** (`landfall/`): the incident war room. Surfaces: `POST /triggers` and `POST /triggers/<provider>`
  (`apps/core-api/src/triggers/`), telemetry sources (`libs/signals/src/plugins/`), the timeline
  (`POST /o/:slug/incidents/:id/events`), artifacts, a hosted MCP connector (`libs/mcp-gateway/src/tools.ts`), per-org
  OIDC and a SCIM 2.0 server (`apps/core-api/src/scim/`).
- **Landflow** (`landflow/`): the workflow platform. Surfaces: plugins (`plugins/landfall`, `plugins/triage`, and
  `plugins/clickland` on the branch), webhook and poll triggers, agents with knowledge bases, the MCP gateway, Run
  Trace (`docs/README.md` feature map).
- **Landbright** (`landbright/`, branch `wave-1-identity-core`): the identity provider. Surfaces: OIDC at
  `http://localhost:4402/oidc` (`apps/idp/src/oidc/provider.ts`), applications API (`apps/control/src/applications/`),
  signed event subscriptions (`docs/events.md`). SCIM is planned, not built (`docs/roadmap.md`, wave 2).
- **landfall-agent-kit**: the shared Go core of Landfall's agents (protocol client, buffer, redaction). A library,
  not a deployable (`README.md`, `docs/protocol.md`).
- **landfall-cluster-agent**: a read-only Kubernetes agent built as an OTel Collector; answers 7 `k8s.*` operations
  Landfall asks for (`internal/k8sops/`, `config/agent.yaml`).
- **landfall-mysql-agent**: the same shape for MySQL; 8 `mysql.*` operations from `performance_schema`
  (`internal/mysqlops/module.go`).
- **landfall-wt-\*, landfall-worktrees/**: git worktrees of Landfall. `landfall-wt-source-sdk` is on a later fix
  branch (`20260908-core-api-mcp-sdk-zod-mismatch`); the Source SDK itself is merged to `dev`.
- **landflow-clickland**: the Landflow worktree with the Clickland work (4 commits ahead of `main`).
- **landflow-bb**: backend-refactor work folders (B08–B15). Not an integration surface.
- **trade**: a personal trading system in Python. Not part of the family; ignore. It could send OTel later.
- **workflow-examples**: a clone of Vercel's Workflow DevKit examples. Reference only; ignore.

What is live today (checked on this machine, `GET /api/services` over the last 6 hours): `core-api` (Landfall),
`landbright-idp`, `landbright-control`, `landflow-host` and three Landflow plugins. Landfall shows as plain
**`core-api`** with zero error logs counted, which matters in §2.6.

## 2. Landfall ↔ Clickland

### 2.1 What Landfall offers (the real mechanisms)

**Opening rooms from alerts**

- `POST /triggers` with `Authorization: Bearer <ingest token>` (`triggers.controller.ts`, `ingest-token.guard.ts`).
  The token is per organisation, issued by `POST /o/:slug/triggers/ingest-token`.
- The body is sniffed by an ordered list of providers (`libs/contracts/src/trigger-sources.ts`): cloudwatch, datadog,
  coralogix, sentry, pagerduty, opsgenie, github, alertmanager, buzz, grafana, **remote**, cortex-xdr.
- **`remote`** is the one meant for us (`providers/remote.provider.ts`). Its body is `SourceTriggerPayload`
  (`libs/signals/src/protocol/schema.ts:177`):
  `{ landfallSource: 'remote', connectionId, title, severity: sev1..sev4, occurredAt?, entityHints?, dedupKey?,
  summary?, url?, kind?: 'trigger' | 'recovery' }`.
- A remote trigger is accepted only for a **remote-source connection** that exists, is installed and was last seen
  healthy; otherwise 422 (`triggers.service.ts`, `assertRemoteConnection`).
- The answer is a `TriggerResult`: `outcome: opened | attached | recorded | ignored | suppressed`, `incidentId`,
  `workspaceUrl`. HTTP 201 only when a room opened.
- Dedup: a repeat with the same `dedupKey` attaches to the open room as `trigger.repeated`. After a person resolves
  the room, the same key opens a new one (`ingestIdentityBearing`).
- Recovery: `kind: 'recovery'` writes `trigger.recovered` on the timeline. **It never closes the room.** That is a
  product rule, not a gap (`specs/20260904-090804-alert-dedup-recovery/spec.md`: "resolving the incident stays a
  human decision").
- `POST /triggers/alertmanager` takes Alertmanager's v4 webhook with a shared header secret. It is the only door that
  also carries links: `runbook_url` and `generatorURL` (`providers/alertmanager.provider.ts`, `alertmanagerLinks`).

**Telemetry sources (what the investigator can read)**

- A source is a `SourcePlugin` (`libs/signals/src/plugins/plugin.ts`). Bundled: cloudwatch, datadog, coralogix,
  prometheus, loki, grafana, sentry, azure, gcp, kubernetes, mysql and more. No ClickHouse or OTLP source.
- **Generic MCP server source** (`libs/integrations/src/mcp-server-adapter.ts`,
  `libs/signals/src/plugins/mcp/mcp-source-plugin.ts`): any Streamable HTTP MCP server plus a bearer token. Only tools
  annotated `readOnlyHint: true` are offered. Every tool is filed under kind `metrics`, and results pass through raw.
- **Remote source by URL** (`libs/integrations/src/remote-source-adapter.ts`,
  `libs/signals/src/plugins/remote/`): a service that speaks the Landfall Source Protocol
  (`docs/architecture/data-source-sdk.md`, `libs/signals/protocol/source-protocol.openapi.yaml`):
  `GET /v1/capabilities`, `GET /v1/health`, `POST /v1/invoke`, `/v1/metrics/list`, `/v1/metrics/range`,
  `/v1/logs/streams`, `/v1/logs/range`. Responses may carry shaped `series` and `entries`, which is what lets
  Landfall's own widgets draw them.
- Who reads the catalog: Beacon (Landfall's investigator), the Edge tool server, the hosted connector and the CLI,
  all through `get_signal_catalog` and `query_signals`.
- URL rules: Landfall refuses plain http and loopback in production (`libs/net-policy/`). A dev-only exemption
  (`dev-exemption.ts`) allows loopback locally, so `http://127.0.0.1:4710` works on this machine only.

**The war room**

- Timeline: `POST /o/:slug/incidents/:id/events` (`incidents.controller.ts`). A member or an API key
  (`lf_key_…`) can post `chat.message` and other open types. It refuses server-only, agent-only and human-only
  types.
- Context attachments: `POST …/context/attachments`: a repository, a map component, a telemetry source, a time
  window, an artifact or a past incident (`specs/20260921-101054-war-room-chat-context/spec.md`, FR-022).
- Artifacts: `POST /o/:slug/incidents/:incidentId/artifacts` (`apps/core-api/src/artifacts/`).
- Canvas widgets: nine typed, data-only widgets (stat, chart, table, logView, timeline, geo, codeFinding, events,
  graph; `libs/widget-catalog/src/widget-type-table.cjs`). They read through sources, not through embedded pages.
- Runbooks: links on the triggering alert are read when the investigation starts
  (`apps/core-api/src/diagnosis/runbook-reader.service.ts`). The remote payload has one `url` and no links list.
- Postmortem: `GET|POST /o/:slug/incidents/:incidentId/postmortem` (`scribe/scribe.controller.ts`); learning:
  `GET …/learning` (`org-memory/org-learning.controller.ts`).
- Outbound: Landfall has **no generic outbound webhook** for incident events (searched `apps/core-api/src` and
  `libs/`). Outside systems poll, as Landflow's Landfall Trigger does.

### 2.2 Alerts open, update and resolve rooms

Clickland sends `alert.firing` and `alert.resolved` only on a state change, with `data.fingerprint`
(`al_…:<groupKey>`, `apps/api/src/alerts.ts:287`), `value`, `window`, `url`, `searchUrl` and up to 5 `samples`.

**The mapping (the same on either route)**

- `dedupKey` = `data.fingerprint`. One room per alert and group while it stays open.
- `kind` = `trigger` for `alert.firing`, `recovery` for `alert.resolved`.
- `severity` = the alert's severity. **Clickland alerts have none today**; until they do, everything is the
  default (Landfall's remote default is sev3; Landflow's triage uses its own Default Severity).
- `entityHints` = `service:<name>` from the group key when grouped by service, else from a `service:` term in the
  query, else from a sample. Landflow's Normalize Alert already does exactly this
  (`landflow-clickland/plugins/triage/README.md`, "Clickland").
- `title` = the alert name plus the group key. `summary` = value, threshold, window and the search link.
  `url` = the alert page.

**Route A: through a Landflow flow. Accept, as the default.**

- Built on the branch: Clickland Alert Trigger (a Standard Webhooks subscription made on publish) → Normalize Alert
  (`format: clickland`) → Triage Rules → AI verdict → **Landfall: Open From Alert** or **Recover**
  (`landflow/docs/triage.md`, `landflow/plugins/landfall/README.md`).
- For it: no code in Clickland or Landfall. Noise is filtered before a room opens. sev1 is never held. It fails
  open. A runbook from an earlier room is linked. Every decision is a row and a Run Trace.
- Against it: Landflow is in the path. If Landflow is down, or is the thing that broke, no room opens. Landflow's
  heartbeat flow (`plugins/landfall/flows/landflow-heartbeat.json`) covers "Landflow is silent", not "Landflow is
  slow".
- Not yet true: it has only run against fakes. `landflow-clickland/docs/limitations.md` says "built against the
  contract, not a running Clickland".

**Route B: Clickland posts `SourceTriggerPayload` to `POST /triggers` itself. Accept, for a short list.**

- Use it for alerts that must never depend on Landflow: sev1, and alerts about Landflow itself.
- Needs two things in Clickland (§2.9): a "Landfall" webhook destination that sends the mapped body with the ingest
  token, and a Source Protocol face so Landfall has a healthy connection to attribute the trigger to.
- The alert event should keep Landfall's answer (`incidentId`, `workspaceUrl`, `outcome`) so Clickland's alert page
  can say "War room open" with a link.
- **One alert takes one route.** The two routes use different connections, so the same alert sent both ways would
  open two rooms (`externalRef.system` is `remote:<connectionId>`). Clickland's webhooks already filter by `alertId`,
  which is enough to keep them apart.

**Route C: Clickland pretends to be Alertmanager (`/triggers/alertmanager`). Reject.**

- It works with no connection and carries runbook links. But the room would say the source is Alertmanager, the
  identity is a `groupKey` we would have to fake, and that route's own capability says `recovery: false` on the
  generic path.

**Route D: a new `clickland` trigger provider in Landfall that verifies Standard Webhooks. Reject.**

- Landfall built the remote protocol so that it would not need a provider per product. A thirteenth provider is
  Landfall work with nothing gained over Route B.

**Resolve on `alert.resolved`: accept as "recovery recorded", reject as "room closed".** Landfall decided that
only a person ends a room. Clickland should not ask for an exception.

**Updates while firing: defer.** Clickland sends nothing between firing and resolved. If a re-notify interval is
added later, Landfall already records repeats as `trigger.repeated`.

### 2.3 The room shows Clickland evidence

**a. Clickland as an MCP-server source. Accept. No code.**

- In Landfall: Integrations → MCP server, URL `http://127.0.0.1:4710/api/mcp`, bearer token a `read`-scope `ck_`
  key.
- Clickland's MCP tools default to `readOnlyHint: true`; `add_note`, `render_view`, `update_view`, `add_panel` and
  `remove_panel` are marked not read-only (`apps/api/src/mcp.ts`), so Landfall hides exactly the writes.
- Result: `search_logs`, `search_traces`, `histogram`, `count`, `get_trace`, `list_services`, `query_metric`,
  `list_metrics`, `event_patterns`, `list_alerts`, `search_knowledge`, `list_dashboards`, `get_view` appear in the
  signal catalog of every room.
- Limits: everything is labelled `metrics`, and results are raw JSON. I could not verify how well the canvas draws
  them. [unverified]

**b. Clickland as a remote source (Source Protocol). Accept. Clickland builds it.**

- A small face on the API: `/v1/health`, `/v1/capabilities`, `/v1/logs/range` (with `entries`), `/v1/logs/streams`
  (services), `/v1/metrics/list`, `/v1/metrics/range` (with `series`), and `/v1/invoke` for traces, patterns and
  services.
- This is what gives the room real charts and log panels: Landfall's `chart`, `stat`, `table`, `logView` and
  `timeline` widgets are built from sources by kind, and shaped `series` and `entries` are what they draw.
- **The "service health" panel is this**, not a new Landfall feature: a `services` operation plus the metric range,
  shown as stat and chart widgets for the service in the room's entity hints.
- It is also the connection Route B needs. One piece of work, two uses.
- Landfall ships a reference server and a conformance fixture (`libs/signals/src/protocol/reference-server.ts`) to
  test against.

**c. Links and samples on the timeline. Accept. A Landflow flow.**

- When a room opens from a Clickland alert, the flow renders one view (error patterns, the failing trace, the
  service's rates) with **Clickland → View → Render** and posts **Landfall → Timeline → Add Note** with the view's
  URL, the top pattern and the trace id. Both nodes exist.
- The trigger's `summary` already carries the count, the window and the search link.

**d. Live Clickland views embedded in the room. Reject for now.**

- Landfall is an MCP Apps *server* (`ui://landfall/canvas.html`, `libs/mcp-gateway/src/ui-resource.ts`), not a
  host. Showing `ui://clickland/view` inside the room means a sandboxed frame host in `libs/warroom-ui`, a content
  security policy, and a Clickland session inside Landfall. That is large, and (b) gives the same charts natively,
  behind Landfall's own credential wall.
- In an MCP host such as Claude, both products' views already render side by side with nothing built.

**e. The failing trace as an artifact. Defer.**

- Landfall has the upload route; Landflow's Landfall node has no artifact operation yet. A link in a note is enough
  to start.

**f. Pinning the Clickland source and the alert's window as room context. Defer.**

- The route exists (`…/context/attachments`). Whether an API-key principal may attach is [unverified].

### 2.4 Landfall's AI investigation uses Clickland

- **Accept; it falls out of 2.3a and 2.3b.** Beacon and every joining agent read sources through the catalog, so
  no investigator code changes.
- `search_knowledge` is a read tool, so earlier notes reach the investigation with (a) alone.
- **Runbook and dashboard links: a small Landfall change.** Add an optional `links[]` to `SourceTriggerPayload`
  (additive in v1) so a Clickland alert's runbook is read at investigation start like an Alertmanager one. Owner:
  Landfall. Until then Landflow posts the runbook as a note, as it does today.

### 2.5 Postmortems become Clickland notes

- **Accept. A Landflow flow; no product code needed to start.**
- Landflow's **Landfall Trigger** already emits `incident.ended`, and `learn-from-closed-rooms.json` already turns a
  closed room into a runbook. Add a branch: read the room's postmortem and learning, then **Clickland → Note →
  Create** with `service`, `tags` (`incident`, `landfall`, the severity), `traceIds`, and a body of summary, cause,
  fix and the room's URL.
- Knowledge search then returns it as `kind: note` for the next alert on that service, and Landflow's triage agent
  already searches Clickland knowledge first.
- Use the postmortem and the learning review, not raw chat: Landfall only lets *admitted* findings into its own
  memory (`specs/20260904-095747-main-context-integrity/`), and the note should follow the same rule.
- Gaps: Landflow's Landfall node has no Postmortem operation (an HTTP Request node works meanwhile). Clickland's
  note has no link field, so the room's URL sits in the body.
- The other direction needs nothing: Landfall's own memory learns from its rooms by itself.

### 2.6 The agents and OTel

- **Cluster and MySQL agents sending their own telemetry: defer.** They are OTel Collector builds with internal
  telemetry set to `level: none` and no `OTEL_*` variables (`landfall-cluster-agent/config/agent.yaml:62-67`,
  `landfall-mysql-agent/internal/configgen/configgen.go:231-233`). They run in a customer's network and speak
  outbound only to Landfall. For our own lab, an `otlp` exporter can be added through Helm `extraConfig`; whether
  that can also switch on the collector's own telemetry is [unverified].
- **Edge sending OTel: reject.** The Edge daemon has no OTLP path on purpose
  (`landfall/apps/edge/src/daemon/verify/health.ts:79-88`).
- **Clickland as a data source inside the agent kit: reject.** The kit's only plug point is a Go `Module` with a
  fixed list of read operations (`landfall-agent-kit/agent/module.go:38-54`), and Landfall's server accepts only
  those operation ids. Clickland belongs in `libs/signals` (2.3), where Edge's `query_signals` reaches it too.
- **Worth taking from the agents:** the cluster agent's `k8s_cluster` and `k8s_objects` receivers are what
  Clickland's planned Kubernetes dashboard needs. Clickland can run the same receivers in its own collector.

### 2.7 Landfall's local observability stack

Landfall's compose file has an `observability` profile: its own collector on 4317/4318, Tempo, Prometheus,
Alertmanager, Loki, Promtail and Grafana on 3300 (`landfall/deploy/docker/docker-compose.yml:257-376`,
`deploy/observability/`).

- **Accept, locally only:** stop using that profile on this machine and point Landfall at Clickland's collector
  (`OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:24318`, `OTEL_METRICS_EXPORTER=otlp`). The brief says this is
  already how core-api runs; the live check agrees.
- **Do not delete the files.** The AWS deployment uses the same stack from templates. It is out of scope and must
  not be touched or run.
- What the old stack did that Clickland must cover:
  - **RED metrics from spans** (the collector's `spanmetrics` connector): Clickland computes these from spans
    already (`GET /api/services`).
  - **Logs**: Promtail tailed files into Loki. Landfall's logger does not emit OTel logs
    (`libs/observability/src/logging/structured-logger.ts`), so today a stdout shipper stands in. The fix is an
    OTel log bridge in Landfall, as Landbright has (`landbright/libs/platform/src/log-bridge.ts`). Owner: Landfall.
  - **Self-monitoring**: 7 Prometheus rules and 1 Loki rule go to Alertmanager, which posts to
    `/triggers/alertmanager`, so Landfall opens a room about itself (`deploy/observability/prometheus-rules.yml`,
    `loki-rules.yml`, `alertmanager.yml`). Four of the eight watch Landfall's own collector and disappear with it.
    The error-rate and error-log rules map to Clickland alerts over traces and logs. The latency rule needs
    either a span query (`duration:>…`) or metric alerts, which Clickland does not have (alerts count log or
    trace rows only).
  - **The Grafana dashboard** (`grafana/provisioning/dashboards/landfall-overview.json`): rebuild as a pinned
    Clickland view.
- **Naming:** Landfall reports as `core-api` (`apps/core-api/src/main.ts:54`), which will collide the day another
  product has a core-api. Add `service.namespace=landfall` as a resource attribute rather than renaming, because
  Landfall's own rules and dashboards key on `core-api`. Whether `OTEL_RESOURCE_ATTRIBUTES` is honoured by
  Landfall's setup is [unverified]; the resource is built by hand in `libs/observability/src/telemetry.ts:113`.

### 2.8 Shared identity

- **Landbright** has a working OIDC provider (authorization code with PKCE, client credentials, `roles` and
  `groups` claims holding group names). It has no roles of its own; each app maps group names. SCIM is planned as
  an outbound *client*, with no spec yet. No SAML.
- **Landfall** already federates each organisation to its own OIDC provider
  (`specs/043-tenant-idp-federation/`, `apps/core-api/src/tenant-idp/`) and already has a SCIM 2.0 server at
  `/scim/v2/:orgSlug` with Users, Groups and a stored group-to-role mapping (`specs/594-scim-onboarding/`,
  implemented in PR #2209). Keycloak is for Landfall's own staff and production.
- **Clickland** plans to be an OIDC relying party and to host a SCIM server. Neither is built; `apps/api/src/app.ts`
  only has the hook for such routes.
- **Accept:** locally, both sign in through Landbright. Landfall needs configuration only (set the local
  organisation's provider to Landbright's issuer). Clickland needs its relying party built.
- **Accept:** Clickland's SCIM server should copy Landfall's surface (Users create, read, patch, delete; Groups
  create and patch; ServiceProviderConfig, Schemas, ResourceTypes; a bearer token). Then Landbright's wave 2 client
  is written once against two real servers.
- The practical gain: one sign-in, and the same person (by email) in both products, so a link from a room to a
  Clickland search opens without a second login.
- Defer: replacing the static `ck_` keys and the ingest token with Landbright client-credentials tokens.

### 2.9 Who owns what

**Clickland changes (this repository)**

1. Alerts gain `severity` (`sev1`–`sev4`, Landfall's own vocabulary), `labels`, and `runbookUrl`; all three ride in
   the webhook's `data.alert`. Landflow's triage already looks for `severity`.
2. A Source Protocol face under `/v1/*` (2.3b), authenticated with a `read` key.
3. A webhook destination of kind `landfall` (`baseUrl`, `ingestToken`, `connectionId`) that sends
   `SourceTriggerPayload`, and stores Landfall's `TriggerResult` on the alert event.
4. Alert events and the alert page show an incident link (`{ system: 'landfall', id, url, outcome }`).
5. Notes gain `links` (label and URL) so a note can point at the room it came from; knowledge search returns it.
6. Later: metric alerts and a "below / no data" rule pack, for the self-monitoring parity in 2.7.

**Landfall changes (none are needed for phases 0 to 3)**

1. Optional `links[]` on `SourceTriggerPayload`.
2. An OTel log bridge, and `service.namespace=landfall`.
3. A note in its docs on running locally without the `observability` profile.
4. Local configuration only: the MCP-server connection, the remote-source connection, the ingest token, the
   organisation's sign-in through Landbright.

Nobody is known to be working in Landfall right now. Its `CLAUDE.md` describes merges to `dev` as "all deployed",
so any change there must be additive and off by default, and needs your go-ahead (question 5).

**Landflow changes (route to the Landflow session; the Clickland work is in `landflow-clickland`)**

1. Run the alert-to-room flow against the real Clickland and the real Landfall.
2. The postmortem-to-note branch and the evidence note (2.5, 2.3c).
3. Landfall node: Postmortem → Get, Artifact → Upload.

**Landbright changes (route to the Landbright session)**

1. Register Clickland and the local Landfall organisation as applications (API calls, no code).
2. Wave 2: write the SCIM client's spec against Landfall's existing server and Clickland's planned one.

## 3. The other pairs

### Landflow ↔ Clickland

Built, on branch `clickland-integration` (not merged):

- The `clickland` plugin: every read and write as a node and an agent tool, a signed alert webhook trigger and a
  poll trigger (`landflow-clickland/plugins/clickland/README.md`).
- Clickland as an agent's knowledge base (`docs/agents.md#knowledge-bases-from-a-plugin`).
- Two flows: alert triage into Slack, and the observability assistant behind Clickland's Assistant panel
  (`docs/features/clickland.md`).
- Telemetry: the `orbstack-clickland` overlay; live on the cluster through `kubectl set env`
  (`clickland/docs/history.md`).

Missing:

- A run against the real Clickland. Everything was tested on a fake.
- The overlay was rendered, not applied (`landflow-clickland/docs/limitations.md`).
- `LANDFLOW_TRACE_URL` pointing Run Trace at a Clickland trace (Clickland plan, wave 2).
- Landflow's Grafana dashboard ("agent runs") has no Clickland equivalent.
- The assistant's auth is a shared secret over Basic Auth.
- Clickland's MCP server is not yet registered in Landflow's MCP gateway.

### Landbright ↔ Clickland

Built: Landbright sends traces, metrics and logs to Clickland's collector (`landbright/docs/development.md`,
commit `1ee0fa5`).

Missing:

- Clickland is not registered as an application, and has no sign-in code yet.
- SCIM on both sides (Landbright's client, Clickland's server).
- Landbright's audit events as a Clickland source. Its signed event subscriptions could feed them; defer, since the
  OTel logs already arrive.
- Group names to agree on (for example `Clickland Admins`, `Clickland Editors`, `Clickland Viewers`).

### Landflow ↔ Landfall

Built, on `main`:

- The `landfall` plugin: Open From Alert, Recover, Open Manually, Declare, Get, Get Room, Get Many, timeline
  events and notes, runbook link, applied-externally, heartbeat ping; a poll trigger for opened, ended and new
  events; and a minimal Source Protocol face so Landfall accepts its triggers (`landflow/plugins/landfall/README.md`).
- Seven triage flows, including alert triage into a war room, Landflow's own failures into a room, the heartbeat,
  and runbooks from closed rooms (`landflow/docs/triage.md`, `docs/runbooks.md`).

Missing:

- Landfall cannot query Landflow (the face advertises no operations).
- No postmortem or artifact operations on the node.
- Landfall has no push, so Landflow polls every 30 seconds.
- Whether these flows have run against the real local Landfall is [unverified]; the README describes a fake.

## 4. Build plan

Each slice is small and has a local check. S is under a day, M is one to three days, L is more.

**Phase 0: prove what exists (no product code)**

1. **Clickland MCP as a Landfall source.** Landfall, configuration only. S.
   Check: `GET /o/<slug>/plugins` lists an `mcp-server` entry with 13 operations; a `query_signals` call to
   `list_services` returns `core-api`.
2. **Alert to room through Landflow, live.** Landflow session, in `landflow-clickland`. S to M.
   Check: run Clickland's `scripts/demo-telemetry.mjs` incident. One room opens; a second firing answers
   `attached`; the resolve answers `recorded` and the timeline shows `trigger.recovered`.

**Phase 1: Clickland's contract**

3. **Alert severity, labels and runbook URL.** Clickland. S.
   Check: the webhook body carries `data.alert.severity`; the room from slice 2 opens at that severity.
4. **Source Protocol face.** Clickland. M.
   Check: a remote-source connection in Landfall verifies as `connected`; a chart widget in a room draws a
   Clickland metric; a log widget shows Clickland rows. Test against Landfall's OpenAPI file.
5. **Landfall webhook destination and the incident link.** Clickland. M. Needs slice 4.
   Check: with Landflow stopped, the demo incident opens a room; Clickland's alert event shows the room's URL;
   the resolve is recorded.

**Phase 2: knowledge both ways**

6. **Evidence note on open.** Landflow session. S.
   Check: the new room has a note with a view link that opens in Clickland's console.
7. **Postmortem to note.** Landflow session. S.
   Check: end a room; `POST /api/knowledge/search` for that service returns the note first.
8. **Note links.** Clickland. S.
   Check: the note's knowledge result carries the room's URL in `metadata`.

**Phase 3: Landfall's telemetry, cleaned up**

9. **OTel logs and the namespace attribute.** Landfall, by whoever you assign. S to M.
   Check: with the stdout shipper off, `service:core-api level:error` in Clickland returns rows with a `traceId`.
10. **Landfall dashboard and alert pack.** Clickland. S.
    Check: a pinned "Landfall" view shows rate, errors and p95; an injected 5xx burst fires an alert and, through
    slice 5, opens a room about Landfall in Landfall.
11. **Local Landfall without its `observability` profile.** Landfall docs and local env. S.
    Check: `docker ps` shows no Landfall Tempo, Loki, Prometheus or Grafana, and slices 9 and 10 still pass.

**Phase 4: identity**

12. **Clickland signs in through Landbright.** Clickland, plus one registration call to Landbright. M.
    Check: the console signs in at `http://localhost:4402/oidc`; `GET /api/auth/me` shows roles from groups.
13. **Local Landfall organisation signs in through Landbright.** Configuration. S.
    Check: one Landbright session opens both products.
14. **Clickland's SCIM server.** Clickland. M.
    Check: SCIM calls copied from Landfall's tests create, patch and deactivate a user.
15. **Landbright's SCIM client (wave 2).** Landbright session. L.
    Check: removing a person from a group in Landbright removes their access in Clickland and Landfall.

**Later, only if wanted:** `links[]` on Landfall's trigger payload (S), the trace as an artifact (S), metric
alerts in Clickland (M), embedded views in the room (L), agent telemetry in the lab (S).

## 5. Questions for you

1. **The default route for alerts.** Landflow triage for everything, with a direct Clickland-to-Landfall route only
   for sev1 and for alerts about Landflow itself (my recommendation)? Or direct for everything, with Landflow as
   an optional step?
2. **Recovery never closes a room.** That is Landfall's rule today. Keep it for Clickland alerts too?
3. **Views inside the room.** Are native Landfall widgets fed by Clickland, plus links, enough? Or do you want
   Clickland's live views embedded, which is a large Landfall change?
4. **Sign-in.** Should the local Landfall organisation sign in through Landbright, leaving Keycloak for production?
5. **Who changes Landfall, and when.** Its `dev` branch deploys. Should the small Landfall changes (log bridge,
   namespace, `links[]`) wait, go through a Landfall session you start, or be proposed as pull requests from here?
6. **Agent telemetry.** Do you want the cluster and MySQL agents' own telemetry in Clickland for the local lab, or
   leave them as they are?

## What I could not verify

- Nothing in this plan was run end to end. Only Clickland's health and service list were called.
- How Landfall's canvas renders raw results from an MCP-server source.
- Whether a Landfall API key may post context attachments.
- Whether Landfall's telemetry setup honours `OTEL_RESOURCE_ATTRIBUTES`.
- That Clickland has no sign-in or SCIM code: I saw only the route hook in `apps/api/src/app.ts`, and did not read
  the untracked `apps/console`.
- The stdout log shipper for Landfall comes from the brief; I did not find it.
- Landfall's `PRODUCT_PLAN.md`, `EDGE_AGENT_INTEGRATION.md` and `PAGERDUTY_OPSGENIE_ANALYSIS.md` were skimmed, not
  read in full. The three agent repositories and Landbright were read by helper agents, and I did not re-open every
  file they cite.
- "landflow-d2" is not a folder in `~/WorkSpace`; I took it to mean the other Landflow session.
