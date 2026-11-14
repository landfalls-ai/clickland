# Clickland and Landfall

Landfall is the land family's incident war room. Clickland meets it only through Landfall's generic interfaces, so
Landfall stays agnostic of Clickland (the user's decision, [research/land-family-integrations.md](research/land-family-integrations.md)
§5): the Source Protocol, the remote trigger (`SourceTriggerPayload` to `POST /triggers`) and the MCP-server source.
Landfall needs no Clickland code.

## Clickland as a remote source

What it gives a room: Landfall's investigator, its chart and log widgets and every agent that joins can read Clickland's
logs, spans, metrics and service health, drawn natively from the `series` and `entries` Clickland returns. The routes
and operations are in [reference/api.md](reference/api.md#landfall-source-protocol-v1).

1. Make a key that can only read: `POST /api/keys` with `{ "name": "landfall-source", "scopes": ["read"] }` (admin).
2. In Landfall: Integrations → **Remote source**: base URL `http://127.0.0.1:4710` (locally; Landfall allows plain
   http to loopback only in development), transport `http`, bearer token the `ck_…` key.
3. Landfall verifies it (`GET /v1/health`, then `GET /v1/capabilities`) and stores the ten operations. The connection
   shows as connected; its id is the `connectionId` the direct alert route needs.

Examples of what an agent or a widget asks:

- `serviceHealth` with `service: core-api`: requests and errors per minute and p95 latency from core-api's spans.
- `searchLogs` with `query: service:core-api level:error`: the error lines as a log panel.
- `metrics/range` with `expr: p95(http.server.duration{service="core-api"})`: the HTTP p95 from OpenTelemetry metrics.
