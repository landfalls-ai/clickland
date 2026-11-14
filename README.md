# Clickland

The land family's internal observability system, designed from a reverse-engineering study of
[ClickHouse](https://github.com/ClickHouse/ClickHouse) and [ClickStack](https://github.com/hyperdxio/hyperdx), done
with [Craft Anything](https://github.com/storytold/craft-anything).

Status: **study done, plan proposed.** Start at [docs/research.md](docs/research.md), then [docs/plan.md](docs/plan.md).

```bash
scripts/fetch-upstream.sh      # ClickHouse + ClickStack sources into upstream/ (pinned)
scripts/fetch-tools.sh         # the Craft Anything CLI, checksum and signature checked
scripts/study-clickstack.sh    # run ClickStack locally, load synthetic OTel data, capture it all into study/
```
