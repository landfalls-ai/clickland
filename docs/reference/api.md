# Clickland API (v1)

The contract between Clickland and its clients: the console, Landflow's `clickland` plugin, agents over MCP. The zod
schemas in `libs/contracts/src` are the source of truth; this page describes them.

- Base URL: `http://127.0.0.1:4710` locally; `http://clickland-api.clickland-dev.svc.cluster.local:4710` on the
  OrbStack cluster.
- Bodies are JSON. Times are ISO 8601 strings in UTC (`2026-11-14T15:00:00.000Z`), durations are milliseconds.
- Errors: `{ "error": { "code": "bad_request" | "unauthorized" | "forbidden" | "not_found" | "conflict" |
  "query_failed" | "assistant_unavailable" | "internal", "message": "…" } }` with the matching HTTP status
  (`assistant_unavailable` is 503). A search syntax error is
  `400 bad_request` with `details.position`.

## Authentication

`Authorization: Bearer ck_<32 characters>`: an API key. Keys carry scopes:

| Scope | Allows |
|---|---|
| `read` | every `GET`, search, traces, metrics, patterns, services, knowledge search, the Landfall Source Protocol (`/v1`) |
| `alerts:write` | create, change, delete alerts |
| `webhooks:write` | create and delete webhook subscriptions |
| `notes:write` | add notes |
| `views:write` | save, change and delete dashboards (pinned views); creating an unpinned view only needs `read` |
| `admin` | everything, including API keys |

`CLICKLAND_BOOTSTRAP_KEY` (dev: `ck_dev_bootstrap_key_000000000000000`) is an `admin` key that exists while the
variable is set. The console signs in with OIDC (Landbright) and sends its session cookie instead; with
`CLICKLAND_AUTH=dev` (local only) the console needs no sign-in.

## Health

`GET /api/health` (no auth) → `{ "status": "ok", "clickhouse": "ok", "postgres": "ok", "version": "0.1.0" }`.

## Search

`POST /api/search`

```json
{ "signal": "logs", "query": "level:error timeout", "from": "…", "to": "…", "limit": 100, "before": null }
```

- `signal`: `logs` or `traces`. `query`: the search language ([search.md](../search.md)); empty matches everything.
- `limit`: 1–500 (default 100). `before`: a cursor (the last row's `cursor`) for the next page, newest first.

→ `{ "rows": [Row], "nextCursor": "…" | null, "stats": { "rowsRead": 0, "bytesRead": 0, "elapsedMs": 0 } }`

A log `Row`: `{ cursor, timestamp, service, severity, body, traceId, spanId, attributes: {…}, resource: {…} }`.
A span `Row`: `{ cursor, timestamp, service, name, kind, durationMs, status, statusMessage, traceId, spanId,
parentSpanId, attributes: {…}, resource: {…} }`.

`POST /api/search/histogram` — same body without `limit`/`before`, plus optional `groupBy` (a field) →
`{ "bucketSeconds": 60, "series": [{ "key": "api", "points": [["2026-11-14T15:00:00.000Z", 12]] }] }`.
At most 10 series (the rest are summed into `"other"`).

`POST /api/facets` — `{ signal, from, to }` → `{ "fields": [{ "field": "ServiceName", "values": [{ "value": "api",
"count": 120 }] }] }`, read from the 15-minute rollups.

## Traces

`GET /api/traces/:traceId` → `{ "traceId", "spans": [SpanRow], "services": ["api"], "durationMs", "errorCount",
"startedAt" }`; spans sorted by start time. `404` when no span has that id.

## Services

`GET /api/services?from=…&to=…` → `{ "services": [{ "name", "requests", "errors", "errorRate", "p50Ms", "p95Ms",
"p99Ms", "logErrors" }] }`, from spans of kind `Server`/`Consumer` (or all root spans when there are none) and log
rows with severity `error` or worse.

## Metrics

`GET /api/metrics/names?from=…&to=…` → `{ "metrics": [{ "name", "type": "gauge" | "sum" | "histogram", "unit",
"description", "services": [] }] }`.

`POST /api/metrics/query` — `{ "metric", "type", "aggregation": "avg" | "min" | "max" | "sum" | "rate" | "p50" |
"p95" | "p99", "from", "to", "service"?, "groupBy"? (an attribute key) }` → the histogram shape above.

## Patterns

`POST /api/patterns` — `{ signal, query, from, to, sample? (default 5000, max 20000) }` →
`{ "patterns": [{ "template": "Connection to <*> refused after <NUM> ms", "count": 812, "share": 0.41,
"example": "…", "services": ["api"] }], "sampled": 5000, "total": 9120 }`. Drain over a sample of the newest rows.

## Alerts

An alert counts the rows that match a search in a sliding window, optionally per value of a field, and compares the
count with a threshold.

```json
{ "name": "API errors", "signal": "logs", "query": "service:api level:error", "groupBy": null,
  "thresholdType": "above", "threshold": 10, "windowMinutes": 5, "intervalMinutes": 1, "enabled": true,
  "severity": "sev2", "direct": false, "labels": { "team": "core" },
  "runbookUrl": "https://runbooks.example/api-errors" }
```

- `severity`: `sev1` (the worst) to `sev4`, Landfall's own scale; default `sev3`, which is also what Landfall assumes
  for a remote trigger without one.
- `labels`: up to 30 `name: value` pairs (a name is a field name: letters, digits, `_ . - /`). They ride in the
  webhook and become Landfall entity hints (`team:core`).
- `runbookUrl`: an `http(s)` link, or `null`.
- `direct`: the alert's **route**. Alerts reach Landfall through Landflow's triage by default (`route: "triage"`); a
  `sev1` alert, or one with `direct: true` (meant for alerts about Landflow itself), takes the direct route
  (`route: "direct"`): Clickland posts it to the `landfall` webhooks itself ([../landfall.md](../landfall.md)).
- All four are optional. A create without them takes `sev3`, `false`, `{}` and `null`; a `PUT` without them keeps
  the stored values (`"runbookUrl": null` clears the link), so a client that predates them does not erase them.

- `GET /api/alerts` → `{ "alerts": [Alert] }`, each with `states: [{ groupKey, state, value, changedAt, incident }]`.
- `POST /api/alerts` (`alerts:write`) → `201 Alert`. `GET|PUT|DELETE /api/alerts/:id`. A `PUT` that changes the
  search (`signal`, `query` or `groupBy`) starts every group again from `ok`; any other change keeps the groups'
  states and their Landfall rooms.
- `GET /api/alerts/:id/events?limit=` → `{ "events": [AlertEvent] }` (newest first). An `AlertEvent` is `{ id, alertId,
  groupKey, state, value, threshold, windowStart, windowEnd, createdAt, incident }`.
- `POST /api/alerts/:id/test` → `{ "groups": [{ "groupKey", "value", "wouldFire" }] }` without changing state.

The evaluator runs every alert when it is due, and on each change of a group's state (`ok` → `firing`, `firing` →
`ok`) it records an `AlertEvent` and sends `alert.firing` or `alert.resolved` to the matching webhooks.

`incident` is the Landfall room a direct-route event went to, or `null`:
`{ "system": "landfall", "id": "…", "url": "http://localhost:5173/o/…/incidents/…", "outcome", "at" }`. `outcome` is
Landfall's answer: `opened` (a new room), `attached` (a repeat on the open room), `recorded` (a recovery on it),
`ignored` or `suppressed`; `pending` until Landfall answers. A group's state keeps its room, so the next firing of
that group shows the room at once and Landfall attaches it there (same dedup key). Editing an alert starts its groups
again from `ok` and forgets their rooms.

## Webhooks

- `POST /api/webhooks` (`webhooks:write`) — `{ "url", "events": ["alert.firing", "alert.resolved", "note.created"],
  "alertId": null, "description": "", "format": "standard" }` → `201 { "id": "wh_…", "secret": "whsec_…", … }`. The
  secret is returned only here.
- `format`: `standard` (default; Clickland's payload, signed) or `landfall`. A `landfall` webhook posts Landfall's
  `SourceTriggerPayload` to Landfall's `POST /triggers` (`url`, e.g. `http://127.0.0.1:3001/triggers`) with
  `Authorization: Bearer <ingest token>`, only for alert events on the direct route, and takes only `alert.firing`
  and `alert.resolved`. It needs `"landfall": { "ingestToken", "connectionId" }`: the organisation's ingest token
  (`POST /o/:slug/triggers/ingest-token` in Landfall) and the id of Clickland's remote-source connection there. The
  token is never returned; its `secret` is unused.
- `GET /api/webhooks` → `{ "webhooks": [{ id, url, events, alertId, description, format, landfall: { connectionId } |
  null, createdAt }] }`.
  `GET /api/webhooks/:id` → one, or `404`. `DELETE /api/webhooks/:id` → `204` (`404` when already gone).
- `GET /api/webhooks/:id/deliveries` → `{ "deliveries": [{ id, eventId, type, status, attempts, lastError, createdAt,
  deliveredAt }] }` (newest 50).

Deliveries follow [Standard Webhooks](https://www.standardwebhooks.com/):

- Headers: `webhook-id` (the event id, stable across retries: use it as the idempotency key), `webhook-timestamp`
  (Unix seconds), `webhook-signature: v1,<base64 HMAC-SHA256(key, "<id>.<timestamp>.<raw body>")>`, where `key` is
  the base64-decoded part of the secret after `whsec_`.
- Retries on a non-2xx answer or a timeout (10 s): after 5 s, 30 s, 2 min, 10 min, 30 min, then the delivery is
  `failed`.

```json
{
  "type": "alert.firing",
  "id": "evt_01JD…",
  "timestamp": "2026-11-14T15:03:00.000Z",
  "data": {
    "alert": { "id": "al_…", "name": "API errors", "signal": "logs", "query": "service:api level:error",
               "groupBy": null, "thresholdType": "above", "threshold": 10, "windowMinutes": 5,
               "severity": "sev2", "labels": { "team": "core" }, "runbookUrl": "https://runbooks.example/api-errors" },
    "eventId": "ae_…",
    "status": "firing",
    "route": "triage",
    "groupKey": "",
    "value": 42,
    "fingerprint": "al_…:",
    "window": { "from": "…", "to": "…" },
    "url": "http://127.0.0.1:4711/alerts/al_…",
    "searchUrl": "http://127.0.0.1:4711/search?signal=logs&query=…&from=…&to=…",
    "samples": [LogRow],
    "incident": null
  }
}
```

`samples` holds up to 5 matching rows from the window. `route` is `direct` for an alert Clickland also sends straight
to Landfall: a Landflow triage flow should not open a second room for it. `incident` is the group's Landfall room
when it has one (see Alerts). `note.created` has `data: { "note": Note }`.

A `landfall` webhook's body, for the same event (a resolve sends `"kind": "recovery"`, which Landfall records on the
room as `trigger.recovered`; it never closes a room):

```json
{ "landfallSource": "remote", "connectionId": "…", "title": "API errors", "severity": "sev2",
  "occurredAt": "2026-11-14T15:03:00.000Z", "entityHints": ["service:api", "team:core"], "dedupKey": "al_…:",
  "summary": "42 matching log rows in the last 5 min (alert when above 10 in 5 min).\nSearch: service:api level:error\nOpen in Clickland: http://127.0.0.1:4711/search?…\nRunbook: https://runbooks.example/api-errors",
  "url": "http://127.0.0.1:4711/alerts/al_…", "kind": "trigger" }
```

`entityHints` hold the service (the group when grouped by service, else the search's `service:` term, else a
sample's), the group when grouped by another field, then the labels. Landfall's answer (`TriggerResult`) is stored
as the event's `incident`; a refusal (for example `422` when the connection is not healthy) stays on the delivery's
`lastError` and is retried.

## Views (MCP UI)

A view is a screen built on demand: a title, a time range and up to 12 live panels. The `ui://clickland/view` MCP App
([MCP Apps](https://github.com/modelcontextprotocol/ext-apps), `text/html;profile=mcp-app`) draws any view and fetches
each panel's data through Clickland's MCP tools, so a view renders the same in Clickland's console, in Claude and in
any other MCP Apps host. Dashboards are pinned views.

```json
{
  "title": "Checkout latency",
  "description": "p95 went up at 14:05",
  "range": { "lastMinutes": 60 },
  "panels": [
    { "type": "timeseries", "title": "Errors by service", "signal": "logs", "query": "level:error", "groupBy": "service" },
    { "type": "metric", "title": "p95 latency", "metric": "http.server.duration", "metricType": "histogram", "aggregation": "p95", "service": "checkout" },
    { "type": "stat", "title": "Error spans", "signal": "traces", "query": "status:error service:checkout" },
    { "type": "logs", "title": "Latest errors", "query": "service:checkout level:error", "limit": 20, "width": "full" },
    { "type": "spans", "title": "Slow spans", "query": "service:checkout duration:>500" },
    { "type": "trace", "title": "A slow trace", "traceId": "4bf92f3577b34da6a3ce929d0e0e4736", "width": "full" },
    { "type": "services", "title": "Services" },
    { "type": "patterns", "title": "Error patterns", "query": "level:error" },
    { "type": "markdown", "title": "Finding", "text": "Timeouts to **payments** since 14:05." },
    { "type": "agent_value", "title": "What the agents are worth", "team": "platform", "width": "full" },
    { "type": "agents", "title": "Agents", "service": "landflow-host" },
    { "type": "run_graph", "title": "A run's decision path", "traceId": "4bf92f3577b34da6a3ce929d0e0e4736" }
  ]
}
```

- `range`: `{ "lastMinutes": n }` (relative, refreshes) or `{ "from", "to" }`.
- Panel `width`: `"half"` (default) or `"full"`. `timeseries` takes `signal`, `query`, `groupBy`; `stat` counts `query`.
- The agent panels ([AI agents](#ai-agents)): `agents` (`service?`), `agent_value` (`agent?`: an agent id or name,
  `team?`, `service?`) and `run_graph` (`traceId`). The view app does not draw them yet
  ([the spec](../agent-value.md#console-spec)).

Endpoints:

- `POST /api/views` (`read`) — `{ "spec": View, "pinned": false }` → `201 { "id": "vw_…", "url":
  "http://127.0.0.1:4711/views/vw_…", "resourceUri": "ui://clickland/view", "marker": "[[clickland:view:vw_…]]" }`.
  The spec is validated (`400` with the path of the first problem).
- `GET /api/views?pinned=true` → `{ "views": [{ id, title, pinned, createdAt, createdBy }] }`; `GET /api/views/:id`
  → `{ id, spec, pinned, … }`; `PUT /api/views/:id` — `{ spec?, pinned?, title? }`; `DELETE /api/views/:id`.

A chat answer that contains `[[clickland:view:<id>]]` shows that view inline in Clickland's assistant panel.

### Dashboards

A dashboard is a saved view (`pinned: true`) with a name. The console lists dashboards in its navigation; opening one
draws it live, and its editor adds, removes, reorders and resizes panels and changes each panel's query, title and
type (every save is a `PUT` of the whole spec). Saving a view from the assistant's chat ("Save as dashboard") pins it.

- `POST /api/views` with `"pinned": true` creates a dashboard directly.
- `PUT /api/views/:id` — `{ "spec"?, "pinned"?, "title"? }` → the updated view; `version` increases on each change, and
  a `PUT` that sends `"version": n` fails with `409 conflict` when someone saved in between.
- `POST /api/views/:id/panels` — `{ "panel": Panel, "position"? }` → the updated view (append, or insert at
  `position`); `DELETE /api/views/:id/panels/:index`. These let an agent change a dashboard without resending it.
- MCP: `render_view` (create, optionally `pinned`), `update_view` (`{ id, spec?, title?, pinned? }`), `add_panel`
  (`{ id, panel, position? }`), `remove_panel`, `list_dashboards`, `get_view`.

## AI agents

Every AI agent seen in telemetry, how it runs, and what it is worth. [agent-value.md](../agent-value.md) defines each
figure. Nothing is stored: every answer is computed from spans, logs and metrics. All of these take `from` and `to`
(default: the last 7 days) and `service` (a name, or a prefix ending in `*`, e.g. `demo-*`). All need `read`.

- `GET /api/agents?family=` → `{ "from", "to", "agents": [AgentSummary], "truncated", "spansRead" }`. `family` is
  `landflow`, `a2a`, `landfall`, `claude_code` or `genai`. `truncated` is true when the period held more than 200,000
  spans: the figures then cover the newest.
- `GET /api/agents/:id` → `{ "from", "to", "agent": AgentSummary, "recentRuns": [AgentRunSummary] (newest 50),
  "value": ValueAgentRow | null }`. `404` when the agent has no telemetry in the period.
- `GET /api/agents/runs/:traceId/graph` → the run's decision path:
  `{ "traceId", "startedAt", "durationMs", "nodes": [RunGraphNode], "edges": [{ "from", "to" }], "summary", "loops" }`.
  `404` for an unknown trace.
- `GET /api/agents/value?agent=&team=` → the value report (below). `agent` is an agent id; `team` is a team name, or
  `unassigned`.
- `GET /api/agents/safety?limit=` → `{ "contentCaptured", "scanned", "flags": [SafetyFlag], "totals": { "pii",
  "secret", "prompt_injection" }, "detectors", "note" }`. Scans the newest `limit` (default 500, max 2000) spans that
  carry captured content. A flag's `sample` is masked.
- `GET /api/agents/alert-templates` → `{ "templates": [{ "key", "kind": "cost" | "errors" | "quality", "title",
  "description", "alert": AlertInput }] }`; `POST /api/agents/alert-templates/:key/install` (`alerts:write`) →
  `201 Alert`, a normal alert.

An `AgentSummary`:

```json
{
  "id": "ag_bGFuZGZsb3ctaG9zdC9TdXBwb3J0IHRyaWFnZQ", "key": "landflow-host/Support triage",
  "service": "landflow-host", "name": "Support triage", "family": "landflow",
  "sources": ["schedule", "slack"], "teams": ["platform"],
  "runUnit": "run", "runs": 5, "subAgentRuns": 0, "failedRuns": 0, "successRate": 1,
  "p50Ms": 3506, "p95Ms": 3506, "latencyOf": "run",
  "modelCalls": 12, "toolCalls": 6, "stepErrors": 1, "rateLimits": 1, "retries": 1, "loops": 0,
  "inputTokens": 9500, "outputTokens": 2320, "cacheReadTokens": 0, "cacheWriteTokens": 0,
  "costUsd": 0.0422,
  "costHow": "claude-sonnet-5-5: 9,500 input × $2/MTok + 2,320 output × $10/MTok = $0.0422 (price claude-sonnet-5-5*)",
  "unpricedModels": [],
  "models": [{ "model": "claude-sonnet-5-5", "calls": 12, "inputTokens": 9500, "outputTokens": 2320,
               "cacheReadTokens": 0, "cacheWriteTokens": 0, "costUsd": 0.0422,
               "costSource": "priced", "reportedCostUsd": 0.0426, "how": "…" }],
  "tools": [{ "name": "search_logs", "kind": "node", "calls": 3, "errors": 0 }],
  "evaluations": [{ "name": "relevance", "count": 1, "averageScore": 0.9, "labels": { "pass": 1 } }],
  "feedback": { "up": 1, "down": 1 }, "approvals": { "approved": 0, "denied": 0 },
  "permissions": { "tools": [{ "name": "search_logs", "kind": "node", "allowed": 3, "denied": 0, "sources": {} }],
                   "modes": [], "needsApproval": [], "note": "…" },
  "endReasons": { "done": 5 }, "users": 2, "sessions": 5, "activity": {},
  "firstSeen": "2026-11-14T16:35:08.000Z", "lastSeen": "2026-11-14T16:35:46.000Z"
}
```

- `costSource`: `priced` (tokens × the price table), `reported` (the emitter's own figure, used when the model has no
  price), `unpriced` (tokens and no price: cost 0) or `none` (no tokens).
- For Claude Code, `runUnit` is `prompt` (or `session` when its events are not exported), `latencyOf` is
  `model call`, `successRate` is `null`, and `activity` holds `commits`, `pullRequests`, `linesAdded`, `linesRemoved`,
  `activeSeconds`, `sessionsStarted`, `editsAccepted`, `editsRejected`.

A `RunGraphNode`: `{ "id" (the span id), "parentId", "kind": "agent" | "subagent" | "model" | "tool" | "span",
"label", "service", "spanName", "depth", "offsetMs", "durationMs", "status": "ok" | "error", "errorType",
"statusMessage", "model", "inputTokens", "outputTokens", "costUsd", "costHow", "tool", "toolKind", "agent", "retry",
"loop", "hiddenSpans" }`. Nodes come in tree order. Spans that are not a step are folded into the step above
(`hiddenSpans`), except the root and any span that failed.

The value report:

```json
{
  "from": "…", "to": "…", "currency": "USD", "hourlyRate": 60,
  "model": "An outcome is a search over telemetry. …",
  "totals": { "value": 185, "cost": 0.8519, "net": 184.15, "roi": 216.16, "outcomes": 14, "costPerOutcome": 0.0609,
              "how": { "net": "$185.00 value − $0.85 cost = $184.15",
                       "roi": "($185.00 − $0.85) ÷ $0.85 = 21616%",
                       "costPerOutcome": "$0.85 ÷ 14 outcomes = $0.06" } },
  "agents": [{ "key": "landflow-host/Support triage", "name": "Support triage", "service": "landflow-host",
               "family": "landflow", "seen": true,
               "value": 25, "cost": 0.0422, "net": 24.96, "roi": 591.42, "outcomes": 5, "costPerOutcome": 0.0084,
               "how": { "net": "…", "roi": "…", "costPerOutcome": "…" }, "costHow": "…",
               "lines": [{ "outcomeId": "oc_…", "name": "Landflow agent run completed", "count": 5,
                           "unitValue": 5, "value": 25, "how": "5 × $5.00 = $25.00" }],
               "adoption": { "users": 2, "sessions": 5, "runs": 5, "runUnit": "run" },
               "quality": { "successRate": 1, "evaluations": [], "feedback": { "up": 1, "down": 1 },
                            "approvals": { "approved": 0, "denied": 0 } } }],
  "teams": [{ "team": "platform", "value": 125, "cost": 0.7544, "net": 124.25, "roi": 164.69, "outcomes": 10,
              "costPerOutcome": 0.0754, "how": { } }],
  "outcomes": [{ "id": "oc_…", "name": "Landflow agent run completed", "signal": "traces",
                 "search": "traces: gen_ai.operation.name:invoke_agent …", "attribution": { "mode": "field", "field": "gen_ai.agent.name" },
                 "unitValue": 5, "unitHow": "5 min saved × $60.00/h ÷ 60 = $5.00 each",
                 "credited": 5, "unattributed": 0, "value": 25, "unattributedValue": 0,
                 "how": "5 credited × $5.00 = $25.00" }],
  "unattributed": { "outcomes": 1, "value": 10, "note": "…" },
  "truncated": false
}
```

`roi` is `(value − cost) ÷ cost` as a ratio (`216.16` is 21616%), and `null` when no cost was recorded. Outcomes that
matched but that no agent took part in are in `unattributed` and in no total. With `team`, the agent rows show value
only (their cost is not split by team) and the totals use the team's cost; with `agent`, the team rows show that
agent's value only.

### Value settings, prices and outcomes

What the figures are computed from. Reading needs `read`; changing needs `admin`.

- `GET /api/value/settings` → `{ "hourlyRate": 60, "currency": "USD", "teamAttribute": "team.id", "loopThreshold": 5,
  "updatedBy", "updatedAt" }`; `PUT /api/value/settings` — any of `hourlyRate`, `currency` (three letters),
  `teamAttribute` (the attribute that names a team; `service.namespace` when a row has none) and `loopThreshold`
  (2–100).
- `GET /api/value/prices` → `{ "prices": [ModelPrice] }`; `POST /api/value/prices` → `201`; `PUT /api/value/prices/:id`;
  `DELETE /api/value/prices/:id`. A price: `{ "model": "claude-opus-5-5*", "provider": "anthropic", "inputPerMTok": 4,
  "outputPerMTok": 20, "cacheReadPerMTok": 0.2, "cacheWritePerMTok": 5, "source": "https://…", "asOf": "2026-11-14",
  "note" }` (USD per million tokens). `model` is an id or a prefix ending in `*`; the longest match prices a model.
  The response adds `id`, `seeded` (the seed wrote it and nobody changed it), `editable: true`, `updatedBy`,
  `updatedAt`. `409` when the model already has a price.
- `GET /api/value/outcomes` → `{ "outcomes": [OutcomeDefinition] }`; `POST /api/value/outcomes` → `201`;
  `GET`, `PUT`, `DELETE /api/value/outcomes/:id`. An outcome:

  ```json
  {
    "name": "Alert triaged", "description": "…",
    "signal": "traces",
    "query": "name:workflow.execute landflow.execution.status:success landflow.workflow.name:*riage*",
    "metricFilter": {},
    "attribution": { "mode": "trace" },
    "valueKind": "minutes", "minutesSaved": 15, "amount": 0,
    "rationale": "First look at an alert by an on-call engineer.", "enabled": true
  }
  ```

  - `signal`: `traces` or `logs` (the rows a search matches are counted) or `metric` (`query` is a counter's name,
    summed; `metricFilter` keeps only data points with those attribute values).
  - `attribution`: `{ "mode": "trace" }` (the agents in the row's trace share it), `{ "mode": "correlate", "field":
    "incident.id" }` (the agents whose runs carry the same value), `{ "mode": "field", "field": "gen_ai.agent.name" }`
    (the row names its agent) or `{ "mode": "agent", "agent": "claude-code/Claude Code" }` (one agent; found by name
    when it reports under another service). A metric takes `field` or `agent`.
  - `valueKind`: `minutes` (`minutesSaved` × the hourly rate ÷ 60) or `amount` (`amount` each).
  - A search that does not compile is `400` with `details.position`, as in search.
- `POST /api/value/outcomes/preview` (`read`) — `{ "outcome": Outcome, "from"?, "to"?, "service"? }` → `{ "search",
  "matched", "credited", "unattributed", "unitValue", "unitHow", "value", "agents": [{ "key", "count", "value" }] }`:
  what an outcome would count before it is saved.
- `POST /api/value/seed` (`admin`) → `{ "prices": { "added", "refreshed", "kept" }, "outcomes": { … } }`: writes
  Anthropic's list prices for the Claude models and the starting outcomes. Safe to repeat: a row a person edited is
  kept. `node scripts/seed-agent-value.mjs` calls it.

## Notes

What people and agents learned about an incident or a service: Clickland's long-term knowledge.

- `GET /api/notes?service=&q=&limit=` → `{ "notes": [Note] }`.
- `POST /api/notes` (`notes:write`) — `{ "title", "body" (Markdown), "service"?, "tags": [], "traceIds": [],
  "alertEventId"?, "author"?, "links": [{ "label", "url" }] }` → `201 Note` (`{ id, …, createdAt }`).
- `links`: up to 20 `{ label, url }` (`http(s)`), where the note points: the Landfall room a postmortem came from, a
  dashboard, a pull request. MCP's `add_note` takes them too.

## Knowledge search

`POST /api/knowledge/search` — `{ "query": "why does checkout time out?", "from"?, "to"? (default: the last
24 hours), "limit"? (default 8, max 25) }` →

```json
{ "results": [{ "pageContent": "…", "score": 0.83,
                "metadata": { "kind": "note" | "alert" | "pattern" | "service" | "log",
                              "title": "…", "service": "api", "url": "…", "id": "…",
                              "links": [{ "label": "Landfall room", "url": "…" }] } }] }
```

A note's result carries its `links` in `metadata` (only when it has some) and lists them in `pageContent`.
It searches notes (Postgres full text), recent alert events, log patterns among the log rows matching the question's
words, and the services the question names. The shape is what Landflow's knowledge-base tools return
(`pageContent`, `metadata`, `score`).

## MCP

`POST /api/mcp`: a stateless Streamable HTTP MCP server, same API keys and scopes. Tools: `search_logs`, `search_traces`,
`histogram`, `count`, `get_trace`, `list_services`, `query_metric`, `list_metrics`, `event_patterns`, `list_alerts`, `search_knowledge`,
`add_note`, `render_view`, `update_view`, `add_panel`, `remove_panel`, `list_dashboards`, `get_view`, and for AI agents
`list_agents`, `get_agent`, `agent_value` and `run_graph`. Each takes the matching endpoint's body; the agent tools
take `{ "lastDays"? (default 7), "from"?, "to"?, "service"? }`, `get_agent` and `agent_value` also `agent` (an id or a
name), `agent_value` also `team`, and `run_graph` takes `{ "traceId" }`. `agent_value` answers in words with the
arithmetic, and carries the whole report as structured content. The server supports the MCP Apps extension
(`io.modelcontextprotocol/ui`): `render_view`, `search_logs`, `search_traces`, `get_trace`, `list_services` and
`query_metric` declare `ui://clickland/view` as their UI, so a host that supports MCP Apps draws the result as a live
view; other hosts get the same structured content as JSON text.

## Landfall Source Protocol (`/v1`)

Clickland is a Landfall **remote source**: it implements Landfall's Source Protocol v1 over HTTP, exactly as
Landfall's `libs/signals/protocol/source-protocol.openapi.yaml` defines it, so a Landfall organisation can connect it
by URL (Integrations → Remote source, transport `http`, base URL `http://127.0.0.1:4710` locally) and its investigator,
chart and log widgets and joining agents read Clickland. How to connect: [../landfall.md](../landfall.md).

- Auth: `Authorization: Bearer ck_…`, a key with the `read` scope (the connection's bearer token). `/v1` always needs a
  key, also with `CLICKLAND_AUTH=dev`. A wrong key is `401`, a key without `read` is `403`.
- Errors answer the protocol's shape, `{ "error": "…" }`: `400` for a body that does not match the protocol, `404`
  for an unknown operation or route. A problem Clickland can name while reading (a search syntax error, a missing
  param, an unknown metric, a failed query) is a `200` `RawResult` with `partial: true`, `error` and `raw: null`, so
  Landfall shows the reason instead of an empty panel.
- Every read answers a `RawResult`: `{ source: "clickland", operation, params, fetchedAt, raw, partial?, error?,
  series?, entries? }`. `raw` is the matching Clickland API answer; `series` (`{ label, unit?, points: [{ t, v }] }`)
  and `entries` (`{ t, line, labels, stream }`) are sorted by time and are what Landfall's widgets draw.
- `tenant.ref` is accepted and ignored (Clickland has one tenant).

| Route | Answers |
|---|---|
| `GET /v1/health` | `{ ok, detail }`: whether ClickHouse answers (`ok: false` when it does not) |
| `GET /v1/capabilities` | `{ protocolVersion: "1", source: "clickland", kinds: ["metrics", "logs"], operations }` |
| `POST /v1/invoke` | `{ operation, params, tenant }` → one operation below |
| `POST /v1/metrics/list` | `listMetrics`; `namespace` is a service, `match` a substring of the name |
| `POST /v1/metrics/range` | `{ expr, selector?, window: { fromMs, toMs }, step? }` → `series` (the expression form below) |
| `POST /v1/logs/streams` | `listStreams`; a stream is a service that wrote logs in the last day |
| `POST /v1/logs/range` | `{ query, window, limit? }` → `searchLogs` with `entries`; `query` is a Clickland search |

Operations (`POST /v1/invoke`; every windowed one names its window `from`/`to` in ISO 8601, so Landfall fills them;
epoch seconds, milliseconds and nanoseconds are read too):

| Operation | Kind | Params | Shaped |
|---|---|---|---|
| `listMetrics` (canonical list) | metrics | `match?`, `service?` | |
| `queryMetric` (canonical range) | metrics | `metric`, `aggregation?` (default p95 / rate / avg by type), `type?`, `service?`, `groupBy?` | `series` |
| `countOverTime` | metrics | `signal` (`logs`, `traces`), `query`, `groupBy?` | `series` |
| `serviceHealth` | metrics | `service` | `series`: requests per minute, errors per minute, p95 latency (ms) |
| `listServices` | metrics | | |
| `listStreams` (canonical streams) | logs | `prefix?` | |
| `searchLogs` (canonical range) | logs | `query`, `limit?` (1–500, default 100) | `entries` |
| `searchSpans` | logs | `query`, `limit?` | `entries` (`name 12.3 ms Error: message`) |
| `getTrace` | logs | `traceId` | `entries`, one per span |
| `eventPatterns` | logs | `signal?`, `query` | |

`metrics/range` reads `expr` in a small Clickland form, or, when `expr` is empty, `selector` as one operation's params
(optionally naming it as `operation`):

- `health(core-api)`: `serviceHealth`;
- `logs: service:core-api level:error`, `traces: status:error`: `countOverTime`;
- `http.server.duration`, `p95(http.server.duration{service="core-api"}) by (http.route)`: `queryMetric` (only
  `service="…"` filters a metric).

`step` (seconds) picks the smallest Clickland bucket at least that long; without it a window is drawn in about 120
points.

## Assistant

`POST /api/assistant/chat` (`read`) — `{ "sessionId", "message" }` → `text/event-stream` of
`{ "type": "text", "delta" }`, `{ "type": "tool", "name", "status": "started" | "done" | "failed" }`, `{ "type": "done",
"runId"? }` and `{ "type": "error", "message" }`. Clickland forwards the message to the Landflow chat flow of the
observability assistant (`CLICKLAND_ASSISTANT_URL`, e.g. `http://landflow-host.landflow-dev.svc.cluster.local:3000/chat/clickland-assistant`;
`CLICKLAND_ASSISTANT_BASIC_AUTH=clickland:<password>` for the chat trigger's Basic Auth, or `CLICKLAND_ASSISTANT_SECRET`
in the `CLICKLAND_ASSISTANT_AUTH_HEADER` header) and passes its answer through. Each person gets their own Landflow
chat session (`<principal>:<sessionId>`); Landflow's analysts show up as `tool` events; `503 assistant_unavailable` when it is not
configured or does not answer. The answer's `[[clickland:view:…]]` markers are views the panel draws inline.

`GET /api/auth/me` → `{ "user": { "name", "email", "roles" }, "authMode", "scopes" }` (`401` when not signed in).

## API keys

`GET /api/keys`, `POST /api/keys` (`{ name, scopes }` → `201 { id, key, … }`, the key shown once),
`DELETE /api/keys/:id`. All `admin`.
