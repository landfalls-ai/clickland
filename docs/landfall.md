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

## Alerts straight to a war room (the direct route)

By default an alert reaches Landfall through Landflow: Landflow's Clickland trigger receives the signed webhook, its
triage decides, and its Landfall node opens the room. Two kinds of alert must not depend on Landflow, so Clickland
sends them itself: **sev1** alerts, and alerts marked **`direct: true`** (the ones about Landflow itself). Each alert
takes one route, so the room opens once.

1. Connect Clickland as a remote source (above): Landfall accepts a remote trigger only for a connection that exists
   and was last seen healthy.
2. In Landfall, issue the organisation's ingest token (`POST /o/:slug/triggers/ingest-token`, an admin).
3. In Clickland, add the destination:

   ```json
   POST /api/webhooks
   { "url": "http://127.0.0.1:3001/triggers", "events": ["alert.firing", "alert.resolved"], "format": "landfall",
     "landfall": { "ingestToken": "<token>", "connectionId": "<the remote-source connection id>" },
     "description": "Landfall, direct route" }
   ```

What happens then, for an alert on the direct route:

- **Firing**: Clickland posts `SourceTriggerPayload` (`kind: trigger`, the alert's severity, `dedupKey` = the alert
  and group, entity hints, a summary with the search and the runbook). Landfall opens a room, and the alert event
  keeps the link (`incident` in `GET /api/alerts/:id/events`).
- **Resolved**: Clickland posts `kind: recovery` with the same key. Landfall writes `trigger.recovered` on the room's
  timeline. **The room stays open**: only a person ends a room, for Clickland alerts too.
- **Firing again** while the room is open: the event shows the room at once (`pending`), and Landfall attaches the
  repeat to it (`attached`). After a person resolved the room, the same key opens a new one.

The standard webhook payload carries `data.route` (`direct` or `triage`), so a Landflow triage flow can skip opening a
room for an alert Clickland already sent.

## Postmortems as notes with the room's link

A note can point at the room it came from: `POST /api/notes` with `"links": [{ "label": "Landfall room", "url":
"<the room's workspaceUrl>" }]`. Knowledge search returns the links in the result's `metadata.links`, so the next
alert on that service finds the note and the room behind it (Landflow's postmortem-to-note flow can write these).

## The Landfall pack: a dashboard and an alert

`scripts/seed-landfall.mjs` creates them through the API:

```bash
node scripts/seed-landfall.mjs              # create what is missing
node scripts/seed-landfall.mjs --update     # also reset existing ones to the pack
node scripts/seed-landfall.mjs --dry-run    # say what it would do
```

`CLICKLAND_API_URL` (default `http://127.0.0.1:4710`) and `CLICKLAND_API_KEY` (a key with `views:write` and
`alerts:write`; unset when the API runs without auth). It finds both by name, so running it again changes nothing, and
a dashboard someone edited keeps their edits unless `--update` is given.

- **"Landfall"**, a pinned view (a dashboard) over the last hour of `service:core-api`: requests (server spans), errors
  (error spans by kind), p95 latency (`http.server.duration`, p95), the count of error log lines, the latest error
  logs, error spans, slow requests (server spans over 500 ms) and the error patterns.
- **"Landfall errors"**, an alert: more than 20 error spans from core-api in 5 minutes, `sev2`, label
  `product: landfall`, no runbook yet. A burst of 5xx answers shows as server spans in error. At `sev2` it takes the
  triage route (Landflow decides); mark it `direct: true` for the design's check where the burst opens a room with
  Landflow stopped.

## Limits

- **Not verified inside a running Landfall.** The Source Protocol face passed Landfall's own adapter and remote-source
  plugin code and its OpenAPI file, but no connection was created in a live Landfall, and the direct route was tested
  against an in-process stand-in for `POST /triggers`, not a real room.
- **Landflow must honour `data.route`.** A direct alert also reaches Landflow's standard webhook (with
  `route: "direct"`); until Landflow's triage skips those, the room could open twice.
- **Restart the API before adding a `landfall` webhook.** An API process older than the `landfall` format would send
  its deliveries as standard signed webhooks, without the ingest token.
- **Changing an alert's search forgets its rooms.** A `PUT` that changes `signal`, `query` or `groupBy` starts the
  groups again from `ok`, so the event that fires next carries no `pending` link; Landfall still attaches it by
  `dedupKey` if the room is open, and the link comes back with the answer.
- **Runbooks travel in the summary.** `SourceTriggerPayload` has no links field; Clickland writes the runbook into
  `summary`. An optional `links[]` there would be Landfall's change to make.
