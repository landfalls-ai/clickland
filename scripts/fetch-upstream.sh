#!/usr/bin/env bash
# Fetch the open-source projects Clickland studies into upstream/ (git-ignored).
# Pin to the commits the research was written against; pass --latest to take main.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p upstream
CLICKHOUSE_COMMIT=1b7851acb7ca9ef02dbd60bc8dd48a665078c56b   # 2026-11-14, ClickHouse 26.11 dev (Apache-2.0)
HYPERDX_COMMIT=0096a355c0f6fba3e691d2e8efe83228bc35751b      # 2026-11-14, ClickStack / HyperDX (MIT)
fetch() { # dir url commit
  if [ ! -d "upstream/$1/.git" ]; then
    git init -q "upstream/$1" && git -C "upstream/$1" remote add origin "$2"
  fi
  if [ "${LATEST:-}" = 1 ]; then git -C "upstream/$1" fetch -q --depth 1 --filter=blob:limit=5m origin HEAD
  else git -C "upstream/$1" fetch -q --depth 1 --filter=blob:limit=5m origin "$3"; fi
  git -C "upstream/$1" checkout -q FETCH_HEAD
  echo "$1 at $(git -C "upstream/$1" rev-parse --short HEAD)"
}
[ "${1:-}" = --latest ] && LATEST=1
fetch clickhouse https://github.com/ClickHouse/ClickHouse.git "$CLICKHOUSE_COMMIT"
fetch clickstack-hyperdx https://github.com/hyperdxio/hyperdx.git "$HYPERDX_COMMIT"
