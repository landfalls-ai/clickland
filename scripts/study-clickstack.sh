#!/usr/bin/env bash
# Re-run the live study of ClickStack: start the reference stack, send synthetic telemetry, record how ClickHouse
# stored and indexed it, and capture every UI screen with Craft Anything.
# Local only: the OrbStack Docker engine, compose project clickland-study.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
DOCKER="docker --context orbstack"
CLI=$(ls -d tools/craft-anything/craft-anything-cli-*/craft-anything-cli | tail -1)
OUT=${1:-study}

COMPOSE_BAKE=false $DOCKER compose -p clickland-study -f deploy/study/compose.yaml up -d
until curl -sf -o /dev/null http://127.0.0.1:18080; do sleep 3; done

TG=ghcr.io/open-telemetry/opentelemetry-collector-contrib/telemetrygen:latest
for kind in logs traces metrics; do
  $DOCKER run --rm --network clickland-study_default "$TG" "$kind" --otlp-endpoint clickstack:4317 --otlp-insecure \
    --duration 20s --rate 50 --service clickland-synthetic >/dev/null 2>&1
done
sleep 8

q() { $DOCKER exec clickland-study-clickstack-1 clickhouse-client -q "$1"; }
mkdir -p "$OUT/clickstack-live"
{
  echo "# Live ClickStack probe ($(date -u +%FT%TZ), clickhouse $(q 'SELECT version()'))"
  echo; echo '## Parts'; echo '```'
  q "SELECT table, count() parts, sum(rows) rows, formatReadableSize(sum(data_compressed_bytes)) comp,
       formatReadableSize(sum(data_uncompressed_bytes)) raw, groupUniqArray(part_type) types
     FROM system.parts WHERE active AND database='default' GROUP BY table ORDER BY rows DESC FORMAT PrettyCompactMonoBlock"
  echo '```'; echo; echo '## A log search: EXPLAIN indexes=1'; echo '```'
  q "EXPLAIN indexes=1 SELECT count() FROM otel_logs WHERE Timestamp > now() - INTERVAL 1 HOUR
     AND hasAllTokens(lower(Body), ['test'])"
  echo '```'; echo; echo '## A trace lookup by TraceId'; echo '```'
  q "EXPLAIN indexes=1 SELECT * FROM otel_traces WHERE TraceId = (SELECT any(TraceId) FROM otel_traces)"
  echo '```'
} > "$OUT/clickstack-live/probe.md"

steps=$(mktemp)
python3 -I - "$steps" "$ROOT/$OUT/clickstack-ui" <<'EOF'
import json, sys
path, out = sys.argv[1], sys.argv[2]
steps = []
for route in ["search", "services", "service-map", "chart", "dashboards", "clickhouse", "kubernetes", "sessions",
              "alerts", "llm"]:
    steps += [{"tool": "web_site_open", "args": {"url": f"http://localhost:18080/{route}", "settle_ms": 6000}},
              {"tool": "web_site_capture", "args": {"output_directory": f"{out}/{route}", "widths": [1440],
                                                    "include_html": False}},
              {"tool": "web_site_close", "args": {}}]
json.dump(steps, open(path, "w"))
EOF
rm -rf "$OUT/clickstack-ui"; mkdir -p "$OUT/clickstack-ui"
python3 -I tools/craft-anything/mcp_session.py "$CLI" "$steps" --deep --allow-run > "$OUT/clickstack-ui/session.jsonl"
rm -f "$steps"
# Keep the evidence free of this machine's paths.
sed -i '' "s#$ROOT/#./#g; s#$ROOT#.#g" "$OUT"/clickstack-ui/session.jsonl
echo "Study written to $OUT/clickstack-live and $OUT/clickstack-ui"
