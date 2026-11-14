# The console

Clickland's web app: React 19, Vite, Tailwind and TanStack Query, in `apps/console`. It talks only to Clickland's API
(`/api`, proxied to `CLICKLAND_API_PORT`, default 4710) and serves on `CLICKLAND_CONSOLE_PORT` (default 4711).

```bash
pnpm --filter @clickland/views build   # the MCP App the console and the API serve
pnpm --filter @clickland/console serve # http://127.0.0.1:4711
```

## Pages

| Group | Page | What it shows |
|---|---|---|
| Explore | Search | Logs and traces: the search language, a histogram, facets, rows that open a trace |
| | Services | Every service: requests, error rate, p50/p95/p99, log errors; each opens its own page |
| | Metrics | Any metric, aggregated and grouped by an attribute (container memory by `container.name`, pod memory by `k8s.pod.name`) |
| | Patterns | Log lines grouped by Drain |
| Watch | Alerts | Rules, their state and events; a rule's page tests it and lists its firings |
| | Dashboards | Saved views: open, edit panels, pin from the assistant |
| | Notes | Notes by service, searchable |
| Ask | Assistant | Clickland's observability agent (a Landflow chat flow): answers stream, tools show as steps, views it names render inline |
| | Settings | API keys, webhooks, theme |

On a phone, Search, Services, Dashboards and Assistant sit on a bottom bar and the rest under More; desktop keeps the
sidebar.

## Views are MCP Apps

Dashboards and the assistant's views are one MCP App, `ui://clickland/view` (`apps/views`, built to
`apps/views/dist/view.html`). The API serves it as a resource of its MCP server, so the same view renders in the
console, in Claude and in any MCP Apps host. The console is a host itself (`src/lib/mcp-host.ts`): one MCP client to
`/api/mcp` with the browser's session; each panel fetches its own data through the host's tool calls.

Shared panels, charts and tables live in `libs/ui`.

## Screens

`study/console-screens/` holds every page at 1440 and 390 px, taken against live data on 2026-11-14.

## Known gaps

The API does not yet have: a count-only search (`POST /api/search/count`), a test of an unsaved alert rule, a
histogram that aggregates a field (p95 of duration), the view's url in `get_view`/`update_view` results, or a redirect
from `/api/auth/logout`. In dev, `/api/auth/me` has no email.
