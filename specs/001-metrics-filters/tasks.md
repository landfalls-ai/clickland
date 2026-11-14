# Tasks 001: Metric filters

All done on 2026-11-14.

- [x] T001 `MetricWhere` and `where` in `@clickland/contracts`; contract tests in `apps/api/test/units.test.ts`.
- [x] T002 `metricWhere` and `metricQuery`'s `where` in `@clickland/query`; unit tests
      (`libs/query/test/metric-where.test.ts`): parameters, no value in the SQL, every metric type, `service`, bad
      keys, the limit, no change without filters.
- [x] T003 The API and the MCP tool pass it on.
- [x] T004 Live test (`metric-where.integration.test.ts`, `CLICKLAND_INTEGRATION=db`): two pods in a namespace of
      their own, filtered by namespace and pod, and a value shaped like SQL.
- [x] T005 Docs: `reference/api.md`, `sources.md` ("Try it"), `history.md`.
