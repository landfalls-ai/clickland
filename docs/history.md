# History

Every change, in order, with the decisions along the way.

| Date | Change | Notes |
|---|---|---|
| 2026-11-14 | The study: project skeleton; ClickHouse (`1b7851a`) and ClickStack (`0096a35`) pinned in `scripts/fetch-upstream.sh`; Craft Anything 0.6.1 fetched and verified (checksum, Developer ID signature); the Cloud page captured in clean room; ClickStack run locally (`clickland-study`) with synthetic OTel data, probed with `EXPLAIN indexes=1` and captured screen by screen in Deep mode; three research reports and `research.md`; `plan.md` proposed | Decision: run ClickHouse as-is, build the observability layer (option B, plan pending approval). Live checks confirmed async inserts and the text index on by default, the 1000/3000 part limits, and the text index pruning a log search; they corrected one claim (ClickStack turns the query result cache off on the server) |
