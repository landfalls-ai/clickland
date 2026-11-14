#!/usr/bin/env bash
# Build Craft Anything source graphs of the ClickStack packages into study/clickstack-source-graph/ (git-ignored: they
# copy string literals from upstream, including test fixtures that look like secrets).
set -euo pipefail
cd "$(dirname "$0")/.."
CLI=$(ls -d tools/craft-anything/craft-anything-cli-*/craft-anything-cli | tail -1)
mkdir -p study/clickstack-source-graph
for p in api app common-utils otel-collector cli; do
  "$CLI" --deep app-source-import --path "$PWD/upstream/clickstack-hyperdx/packages/$p" --respect-gitignore true \
    > "study/clickstack-source-graph/$p.json"
done
