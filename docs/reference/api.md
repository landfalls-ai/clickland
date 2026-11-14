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
| `read` | every `GET`, search, traces, metrics, patterns, services, knowledge search |
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
  "thresholdType": "above", "threshold": 10, "windowMinutes": 5, "intervalMinutes": 1, "enabled": true }
```

- `GET /api/alerts` → `{ "alerts": [Alert] }`, each with `states: [{ groupKey, state, value, changedAt }]`.
- `POST /api/alerts` (`alerts:write`) → `201 Alert`. `GET|PUT|DELETE /api/alerts/:id`.
- `GET /api/alerts/:id/events?limit=` → `{ "events": [AlertEvent] }` (newest first).
- `POST /api/alerts/:id/test` → `{ "groups": [{ "groupKey", "value", "wouldFire" }] }` without changing state.

The evaluator runs every alert when it is due, and on each change of a group's state (`ok` → `firing`, `firing` →
`ok`) it records an `AlertEvent` and sends `alert.firing` or `alert.resolved` to the matching webhooks.

## Webhooks

- `POST /api/webhooks` (`webhooks:write`) — `{ "url", "events": ["alert.firing", "alert.resolved", "note.created"],
  "alertId": null, "description": "" }` → `201 { "id": "wh_…", "secret": "whsec_…", … }`. The secret is returned
  only here.
- `GET /api/webhooks` → `{ "webhooks": [{ id, url, events, alertId, description, createdAt }] }`.
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
               "groupBy": null, "thresholdType": "above", "threshold": 10, "windowMinutes": 5 },
    "status": "firing",
    "groupKey": "",
    "value": 42,
    "fingerprint": "al_…:",
    "window": { "from": "…", "to": "…" },
    "url": "http://127.0.0.1:4711/alerts/al_…",
    "searchUrl": "http://127.0.0.1:4711/search?signal=logs&query=…&from=…&to=…",
    "samples": [LogRow]
  }
}
```

`samples` holds up to 5 matching rows from the window. `note.created` has `data: { "note": Note }`.

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
    { "type": "markdown", "title": "Finding", "text": "Timeouts to **payments** since 14:05." }
  ]
}
```

- `range`: `{ "lastMinutes": n }` (relative, refreshes) or `{ "from", "to" }`.
- Panel `width`: `"half"` (default) or `"full"`. `timeseries` takes `signal`, `query`, `groupBy`; `stat` counts `query`.

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

## Notes

What people and agents learned about an incident or a service: Clickland's long-term knowledge.

- `GET /api/notes?service=&q=&limit=` → `{ "notes": [Note] }`.
- `POST /api/notes` (`notes:write`) — `{ "title", "body" (Markdown), "service"?, "tags": [], "traceIds": [],
  "alertEventId"?, "author"? }` → `201 Note` (`{ id, …, createdAt }`).

## Knowledge search

`POST /api/knowledge/search` — `{ "query": "why does checkout time out?", "from"?, "to"? (default: the last
24 hours), "limit"? (default 8, max 25) }` →

```json
{ "results": [{ "pageContent": "…", "score": 0.83,
                "metadata": { "kind": "note" | "alert" | "pattern" | "service" | "log",
                              "title": "…", "service": "api", "url": "…", "id": "…" } }] }
```

It searches notes (Postgres full text), recent alert events, log patterns among the log rows matching the question's
words, and the services the question names. The shape is what Landflow's knowledge-base tools return
(`pageContent`, `metadata`, `score`).

## MCP

`POST /api/mcp`: a stateless Streamable HTTP MCP server, same API keys and scopes. Tools: `search_logs`, `search_traces`,
`histogram`, `count`, `get_trace`, `list_services`, `query_metric`, `list_metrics`, `event_patterns`, `list_alerts`, `search_knowledge`,
`add_note`, `render_view`, `update_view`, `add_panel`, `remove_panel`, `list_dashboards`, `get_view`. Each takes the matching endpoint's body. The server supports the MCP Apps extension
(`io.modelcontextprotocol/ui`): `render_view`, `search_logs`, `search_traces`, `get_trace`, `list_services` and
`query_metric` declare `ui://clickland/view` as their UI, so a host that supports MCP Apps draws the result as a live
view; other hosts get the same structured content as JSON text.

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
