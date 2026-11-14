#!/usr/bin/env node
// The Landfall pack: a pinned "Landfall" dashboard (rate, errors and p95 of core-api, its error logs and spans) and a
// "Landfall errors" alert at sev2, created through Clickland's API. Idempotent: it finds both by name, creates what is
// missing and leaves what exists alone, so a dashboard someone edited keeps their edits.
//
//   node scripts/seed-landfall.mjs              # create what is missing
//   node scripts/seed-landfall.mjs --update     # also reset existing ones to the pack (editing an alert resets its state)
//   node scripts/seed-landfall.mjs --dry-run    # say what it would do, change nothing
//
// CLICKLAND_API_URL (default http://127.0.0.1:4710) is the API; CLICKLAND_API_KEY a key with `views:write` and
// `alerts:write` (leave it unset when the API runs without auth, as in development).

const API = (process.env.CLICKLAND_API_URL ?? 'http://127.0.0.1:4710').replace(/\/$/, '');
const KEY = process.env.CLICKLAND_API_KEY;
const update = process.argv.includes('--update');
const dryRun = process.argv.includes('--dry-run');

const SERVICE = 'core-api';

export const VIEW = {
  title: 'Landfall',
  description: "Landfall's core-api: traffic, errors and latency, with the error logs and spans behind them.",
  range: { lastMinutes: 60 },
  panels: [
    { type: 'timeseries', title: 'Requests', signal: 'traces', query: `service:${SERVICE} kind:server` },
    {
      type: 'timeseries',
      title: 'Errors',
      signal: 'traces',
      query: `service:${SERVICE} status:error`,
      groupBy: 'kind',
    },
    {
      type: 'metric',
      title: 'p95 latency (ms)',
      metric: 'http.server.duration',
      metricType: 'histogram',
      aggregation: 'p95',
      service: SERVICE,
    },
    { type: 'stat', title: 'Error log lines', signal: 'logs', query: `service:${SERVICE} level:error` },
    { type: 'logs', title: 'Latest errors', query: `service:${SERVICE} level:error`, limit: 25, width: 'full' },
    { type: 'spans', title: 'Error spans', query: `service:${SERVICE} status:error`, limit: 25 },
    { type: 'spans', title: 'Slow requests', query: `service:${SERVICE} kind:server duration:>500`, limit: 25 },
    {
      type: 'patterns',
      title: 'Error patterns',
      signal: 'logs',
      query: `service:${SERVICE} level:error`,
      width: 'full',
    },
  ],
};

export const ALERT = {
  name: 'Landfall errors',
  // Error spans: a burst of 5xx answers shows as server spans in error; the usual level is under 10 in 5 minutes.
  signal: 'traces',
  query: `service:${SERVICE} status:error`,
  groupBy: null,
  thresholdType: 'above',
  threshold: 20,
  windowMinutes: 5,
  intervalMinutes: 1,
  enabled: true,
  // sev2: Landflow's triage decides (only sev1 and `direct` alerts go to Landfall straight from Clickland).
  severity: 'sev2',
  direct: false,
  labels: { product: 'landfall' },
  runbookUrl: null,
};

async function api(method, path, body) {
  const headers = { accept: 'application/json' };
  if (KEY) headers.authorization = `Bearer ${KEY}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return json;
}

async function seedView() {
  const { views } = await api('GET', '/api/views?pinned=true');
  const existing = views.filter((v) => v.title === VIEW.title);
  if (existing.length > 1)
    console.warn(`  ${existing.length} pinned views are titled "${VIEW.title}"; using the oldest`);
  const view = existing.sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  if (!view) {
    if (dryRun) return console.log(`view "${VIEW.title}": would create (pinned)`);
    const created = await api('POST', '/api/views', { spec: VIEW, pinned: true });
    return console.log(`view "${VIEW.title}": created ${created.id} ${created.url}`);
  }
  if (!update) return console.log(`view "${VIEW.title}": exists ${view.id}, left as it is`);
  if (dryRun) return console.log(`view "${VIEW.title}": would reset ${view.id} to the pack`);
  const saved = await api('PUT', `/api/views/${view.id}`, { spec: VIEW, pinned: true });
  console.log(`view "${VIEW.title}": reset ${view.id} to the pack (version ${saved.version})`);
}

async function seedAlert() {
  const { alerts } = await api('GET', '/api/alerts');
  const alert = alerts.find((a) => a.name === ALERT.name);
  if (!alert) {
    if (dryRun) return console.log(`alert "${ALERT.name}": would create (${ALERT.severity})`);
    const created = await api('POST', '/api/alerts', ALERT);
    return console.log(`alert "${ALERT.name}": created ${created.id} (${created.severity})`);
  }
  if (!update) return console.log(`alert "${ALERT.name}": exists ${alert.id} (${alert.severity}), left as it is`);
  if (dryRun) return console.log(`alert "${ALERT.name}": would reset ${alert.id} to the pack`);
  await api('PUT', `/api/alerts/${alert.id}`, ALERT);
  console.log(`alert "${ALERT.name}": reset ${alert.id} to the pack`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    console.log(`Landfall pack → ${API}${dryRun ? ' (dry run)' : ''}`);
    await seedView();
    await seedAlert();
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  }
}
