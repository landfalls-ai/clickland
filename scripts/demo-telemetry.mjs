#!/usr/bin/env node
// Sends realistic demo telemetry under demo-* service names (logs, traces, metrics) to the local collector over OTLP/HTTP JSON, so the console,
// alerts and the assistant have something to look at before the land services send their own.
//
//   node scripts/demo-telemetry.mjs                 # every 2 s until stopped
//   node scripts/demo-telemetry.mjs --once          # one batch
//   node scripts/demo-telemetry.mjs --incident      # payments starts timing out (checkout errors, slow spans)
//
// CLICKLAND_OTLP_URL (default http://127.0.0.1:24318) is the collector's OTLP/HTTP endpoint.
import { randomBytes } from 'node:crypto';

const OTLP = (process.env.CLICKLAND_OTLP_URL ?? 'http://127.0.0.1:24318').replace(/\/$/, '');
const once = process.argv.includes('--once');
const incident = process.argv.includes('--incident');

const hex = (n) => randomBytes(n).toString('hex');
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
const ns = (ms) => String(BigInt(Math.round(ms * 1e6)));
const attrs = (o) =>
  Object.entries(o).map(([key, v]) => ({
    key,
    value:
      typeof v === 'number'
        ? Number.isInteger(v)
          ? { intValue: String(v) }
          : { doubleValue: v }
        : { stringValue: String(v) },
  }));

const SERVICES = {
  'demo-web': { pod: 'demo-web-7c9d', ns: 'demo' },
  'demo-worker': { pod: 'demo-worker-5f2a', ns: 'demo' },
  'demo-auth': { pod: 'demo-auth-6b1e', ns: 'demo' },
  'demo-checkout': { pod: 'checkout-84d0', ns: 'demo' },
  'demo-payments': { pod: 'payments-3a77', ns: 'demo' },
};
const resource = (service) => ({
  attributes: attrs({
    'service.name': service,
    'service.version': '1.4.2',
    'deployment.environment': 'dev',
    'k8s.namespace.name': SERVICES[service].ns,
    'k8s.pod.name': SERVICES[service].pod,
    'k8s.container.name': service,
  }),
});

function batch() {
  const now = Date.now();
  const logs = new Map();
  const spans = new Map();
  const log = (service, severity, body, extra = {}, trace = {}) => {
    const list = logs.get(service) ?? [];
    list.push({
      timeUnixNano: ns(now - Math.random() * 1500),
      severityText: severity,
      severityNumber: { DEBUG: 5, INFO: 9, WARN: 13, ERROR: 17 }[severity],
      body: { stringValue: body },
      attributes: attrs(extra),
      traceId: trace.traceId ?? '',
      spanId: trace.spanId ?? '',
    });
    logs.set(service, list);
  };
  const span = (service, s) => {
    const list = spans.get(service) ?? [];
    list.push(s);
    spans.set(service, list);
  };

  // Checkout requests: checkout -> payments -> landbright token check.
  for (let i = 0; i < 6; i++) {
    const traceId = hex(16);
    const start = now - 2000 + i * 200;
    const slow = incident && Math.random() < 0.6;
    const payMs = slow ? 2500 + Math.random() * 2000 : 40 + Math.random() * 60;
    const failed = slow && payMs > 3000;
    const root = hex(8);
    const pay = hex(8);
    const auth = hex(8);
    const route = pick(['/api/checkout', '/api/cart', '/api/checkout']);
    const total = payMs + 30 + Math.random() * 20;
    span('demo-checkout', {
      traceId,
      spanId: root,
      parentSpanId: '',
      name: `POST ${route}`,
      kind: 2,
      startTimeUnixNano: ns(start),
      endTimeUnixNano: ns(start + total),
      attributes: attrs({
        'http.request.method': 'POST',
        'http.route': route,
        'http.response.status_code': failed ? 502 : 200,
      }),
      status: failed ? { code: 2, message: 'payments timed out' } : { code: 1 },
    });
    span('demo-payments', {
      traceId,
      spanId: pay,
      parentSpanId: root,
      name: 'charge card',
      kind: 2,
      startTimeUnixNano: ns(start + 10),
      endTimeUnixNano: ns(start + 10 + payMs),
      attributes: attrs({ 'payment.provider': 'stripe-sandbox', 'db.system': 'postgresql' }),
      status: failed ? { code: 2, message: 'context deadline exceeded' } : { code: 1 },
    });
    span('demo-auth', {
      traceId,
      spanId: auth,
      parentSpanId: pay,
      name: 'POST /oauth/introspect',
      kind: 2,
      startTimeUnixNano: ns(start + 12),
      endTimeUnixNano: ns(start + 12 + 8 + Math.random() * 6),
      attributes: attrs({
        'http.request.method': 'POST',
        'http.route': '/oauth/introspect',
        'http.response.status_code': 200,
      }),
      status: { code: 1 },
    });
    log(
      'demo-checkout',
      'INFO',
      `Checkout started for cart ${hex(4)}`,
      { 'http.route': route },
      { traceId, spanId: root },
    );
    if (failed) {
      log(
        'demo-payments',
        'ERROR',
        `Connection to payments-db refused after ${Math.round(payMs)} ms`,
        { 'db.system': 'postgresql', 'error.type': 'timeout' },
        { traceId, spanId: pay },
      );
      log(
        'demo-checkout',
        'ERROR',
        `Upstream payments failed: context deadline exceeded (order ${hex(4)})`,
        { 'http.response.status_code': 502 },
        { traceId, spanId: root },
      );
    } else {
      log(
        'demo-payments',
        'INFO',
        `Charged ${(10 + Math.random() * 90).toFixed(2)} EUR for order ${hex(4)}`,
        { 'payment.provider': 'stripe-sandbox' },
        { traceId, spanId: pay },
      );
    }
    if (slow && !failed)
      log(
        'demo-payments',
        'WARN',
        `Slow query on payments-db: ${Math.round(payMs)} ms`,
        { 'db.system': 'postgresql' },
        { traceId, spanId: pay },
      );
  }

  // Workflow runs and sign-ins.
  for (let i = 0; i < 4; i++) {
    const traceId = hex(16);
    const start = now - 1800 + i * 300;
    const root = hex(8);
    const flow = pick(['clickland-alert-triage', 'nightly-tomorrow-sync', 'sdlc-velocity', 'brain-ingest']);
    const ms = 200 + Math.random() * 800;
    span('demo-web', {
      traceId,
      spanId: root,
      parentSpanId: '',
      name: 'POST /api/workflows/:id/run',
      kind: 2,
      startTimeUnixNano: ns(start),
      endTimeUnixNano: ns(start + ms + 20),
      attributes: attrs({
        'http.request.method': 'POST',
        'http.route': '/api/workflows/:id/run',
        'landflow.workflow': flow,
      }),
      status: { code: 1 },
    });
    span('demo-worker', {
      traceId,
      spanId: hex(8),
      parentSpanId: root,
      name: `run ${flow}`,
      kind: 1,
      startTimeUnixNano: ns(start + 10),
      endTimeUnixNano: ns(start + 10 + ms),
      attributes: attrs({ 'landflow.workflow': flow, 'landflow.nodes': 3 + Math.floor(Math.random() * 6) }),
      status: { code: 1 },
    });
    log(
      'demo-worker',
      'INFO',
      `Run of ${flow} finished in ${Math.round(ms)} ms`,
      { 'landflow.workflow': flow },
      { traceId, spanId: root },
    );
  }
  for (let i = 0; i < 3; i++) {
    const user = pick(['alice', 'bob', 'carol', 'dan']);
    if (Math.random() < 0.15)
      log('demo-auth', 'WARN', `Sign-in failed for ${user}: invalid password`, {
        'enduser.id': user,
        'auth.method': 'password',
      });
    else
      log('demo-auth', 'INFO', `User ${user} signed in`, {
        'enduser.id': user,
        'auth.method': pick(['password', 'passkey', 'oidc']),
      });
  }
  if (Math.random() < 0.3) log('demo-web', 'DEBUG', `Cache hit for workspace ${hex(3)}`, {});

  const resourceLogs = [...logs].map(([service, logRecords]) => ({
    resource: resource(service),
    scopeLogs: [{ scope: { name: 'demo' }, logRecords }],
  }));
  const resourceSpans = [...spans].map(([service, list]) => ({
    resource: resource(service),
    scopeSpans: [{ scope: { name: 'demo' }, spans: list }],
  }));

  // Metrics: request duration histograms, a request counter, and a gauge.
  const bounds = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
  const counts = (center) => {
    const c = new Array(bounds.length + 1).fill(0);
    for (let i = 0; i < 50; i++) {
      const v = center * (0.5 + Math.random());
      const at = bounds.findIndex((b) => v <= b);
      c[at === -1 ? bounds.length : at]++;
    }
    return c;
  };
  const resourceMetrics = Object.keys(SERVICES).map((service) => {
    const center =
      service === 'demo-payments' ? (incident ? 3000 : 70) : service === 'demo-checkout' ? (incident ? 3100 : 110) : 30;
    const c = counts(center);
    return {
      resource: resource(service),
      scopeMetrics: [
        {
          scope: { name: 'demo' },
          metrics: [
            {
              name: 'http.server.request.duration',
              unit: 'ms',
              description: 'Duration of HTTP server requests',
              histogram: {
                aggregationTemporality: 1,
                dataPoints: [
                  {
                    startTimeUnixNano: ns(now - 2000),
                    timeUnixNano: ns(now),
                    count: '50',
                    sum: center * 50,
                    bucketCounts: c.map(String),
                    explicitBounds: bounds,
                    attributes: attrs({ 'http.route': '/api' }),
                  },
                ],
              },
            },
            {
              name: 'http.server.requests',
              unit: '{request}',
              description: 'HTTP requests served',
              sum: {
                aggregationTemporality: 1,
                isMonotonic: true,
                dataPoints: [
                  {
                    startTimeUnixNano: ns(now - 2000),
                    timeUnixNano: ns(now),
                    asInt: String(40 + Math.floor(Math.random() * 20)),
                  },
                ],
              },
            },
            {
              name: 'process.memory.usage',
              unit: 'By',
              description: 'Resident memory',
              gauge: { dataPoints: [{ timeUnixNano: ns(now), asDouble: (180 + Math.random() * 40) * 1024 * 1024 }] },
            },
          ],
        },
      ],
    };
  });
  return { resourceLogs, resourceSpans, resourceMetrics };
}

async function post(path, body) {
  const res = await fetch(`${OTLP}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
}

async function send() {
  const b = batch();
  await Promise.all([
    post('/v1/logs', { resourceLogs: b.resourceLogs }),
    post('/v1/traces', { resourceSpans: b.resourceSpans }),
    post('/v1/metrics', { resourceMetrics: b.resourceMetrics }),
  ]);
}

if (once) await send();
else {
  console.log(
    `Sending demo telemetry to ${OTLP} every 2 s${incident ? ' (incident: payments is timing out)' : ''}. Ctrl-C stops.`,
  );
  for (;;) {
    await send().catch((e) => console.error(e.message));
    await new Promise((r) => setTimeout(r, 2000));
  }
}
