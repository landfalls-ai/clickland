/**
 * Clickland's Landfall Source Protocol face (`/v1/*`) without a database: routes, auth, errors, and every answer
 * validated against Landfall's OpenAPI file (when a Landfall checkout is next to this repository).
 */
import type { LogRow, SeriesResponse, SpanRow } from '@clickland/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createClients } from '../src/clients.js';
import { configFromEnv } from '../src/config.js';
import { createServices, type Services } from '../src/services.js';
import {
  bucketForStep,
  capabilities,
  logEntries,
  OPERATIONS,
  paramTime,
  parseExpr,
  SourceProtocol,
  spanEntries,
  toRawSeries,
} from '../src/source-protocol.js';
import { haveOpenApi, openApiRoutes, validateAgainst } from './landfall-openapi.js';

const KEY = 'ck_test_bootstrap_key_00000000000000';
const config = {
  ...configFromEnv({
    CLICKLAND_AUTH: 'dev',
    CLICKLAND_BOOTSTRAP_KEY: KEY,
    // Nothing listens here: these tests never reach a database.
    CLICKLAND_CH_URL: 'http://127.0.0.1:1',
    CLICKLAND_PG_URL: 'postgres://x:y@127.0.0.1:1/none',
  }),
  backgroundJobs: false,
};
const auth = { authorization: `Bearer ${KEY}` };
const tenant = { ref: 'opaque-ref' };

const conforms = (component: string, value: unknown) => {
  if (haveOpenApi) expect(validateAgainst(component, value)).toEqual([]);
};

describe.skipIf(!haveOpenApi)("Landfall's OpenAPI file", () => {
  it('is loaded, and its validator refuses an answer that does not conform', () => {
    expect(validateAgainst('HealthResponse', { ok: true })).toEqual([]);
    expect(validateAgainst('HealthResponse', { detail: 'no ok' })).not.toEqual([]);
    expect(
      validateAgainst('RawResult', { source: 's', operation: 'o', params: {}, fetchedAt: 'not a time' }),
    ).not.toEqual([]);
    expect(validateAgainst('RawSeries', { label: 'x', points: [{ t: '2026-11-14T15:00:00Z', v: 'NaN' }] })).not.toEqual(
      [],
    );
  });
});

describe('the expression form of metrics/range', () => {
  it('reads counts, service health and metrics', () => {
    expect(parseExpr('logs: service:core-api level:error')).toEqual({
      operation: 'countOverTime',
      params: { signal: 'logs', query: 'service:core-api level:error' },
    });
    expect(parseExpr('health(core-api)')).toEqual({ operation: 'serviceHealth', params: { service: 'core-api' } });
    expect(parseExpr('p95(http.server.duration{service="core-api"}) by (http.route)')).toEqual({
      operation: 'queryMetric',
      params: { metric: 'http.server.duration', aggregation: 'p95', service: 'core-api', groupBy: 'http.route' },
    });
    expect(parseExpr('v8js.memory.heap.used')).toEqual({
      operation: 'queryMetric',
      params: { metric: 'v8js.memory.heap.used' },
    });
  });

  it('takes a selector when the expression is empty', () => {
    expect(parseExpr('', { metric: 'm', aggregation: 'max' }).operation).toBe('queryMetric');
    expect(parseExpr('', { signal: 'traces', query: 'status:error' }).operation).toBe('countOverTime');
    expect(parseExpr('', { service: 'core-api' }).operation).toBe('serviceHealth');
    expect(parseExpr('', { operation: 'serviceHealth', service: 'x' }).operation).toBe('serviceHealth');
  });

  it('refuses what it cannot read, saying what it can', () => {
    expect(() => parseExpr('rate(http_requests_total[5m])')).toThrow(/Not a Clickland expression/);
    expect(() => parseExpr('p95(m')).toThrow(/Not a Clickland expression/);
    expect(() => parseExpr('m{route="/x"}')).toThrow(/Only service=/);
    expect(() => parseExpr('', {})).toThrow(/expr, or a selector/);
  });
});

describe('params', () => {
  it('reads times as ISO or epoch seconds, milliseconds or nanoseconds', () => {
    const iso = '2026-11-14T15:00:00.000Z';
    expect(paramTime(iso)).toBe(iso);
    expect(paramTime(1794668400)).toBe(iso);
    expect(paramTime('1794668400000')).toBe(iso);
    expect(paramTime(1794668400000000000)).toBe(iso);
    expect(paramTime(undefined)).toBeUndefined();
    expect(() => paramTime('yesterday')).toThrow(/Not a time/);
  });

  it('turns a step into the nearest Clickland bucket at or above it', () => {
    const hour = { from: new Date('2026-11-14T14:00:00Z'), to: new Date('2026-11-14T15:00:00Z') };
    expect(bucketForStep(hour, 60)).toBe(60);
    expect(bucketForStep(hour, 45)).toBe(60);
    expect(bucketForStep(hour, 1)).toBe(10);
    expect(bucketForStep(hour, undefined)).toBeUndefined();
  });
});

describe('shapes', () => {
  it('series: ISO points sorted by time, finite values, a label for the ungrouped series', () => {
    const response: SeriesResponse = {
      bucketSeconds: 60,
      series: [
        {
          key: '',
          points: [
            ['2026-11-14T15:01:00Z', 2],
            ['2026-11-14T15:00:00Z', 1],
            ['2026-11-14T15:02:00Z', Number.NaN],
          ],
        },
      ],
    };
    const series = toRawSeries(response, 'log rows', 'count');
    expect(series).toEqual([
      {
        label: 'log rows',
        unit: 'count',
        points: [
          { t: '2026-11-14T15:00:00.000Z', v: 1 },
          { t: '2026-11-14T15:01:00.000Z', v: 2 },
        ],
      },
    ]);
    for (const s of series) conforms('RawSeries', s);
  });

  it('entries: oldest first, labels without empty values', () => {
    const log = (t: string, body: string): LogRow => ({
      cursor: '1',
      timestamp: t,
      service: 'core-api',
      severity: 'error',
      body,
      traceId: '',
      spanId: '',
      attributes: {},
      resource: {},
    });
    const entries = logEntries([log('2026-11-14T15:00:02.000Z', 'b'), log('2026-11-14T15:00:01.000Z', 'a')]);
    expect(entries.map((e) => e.line)).toEqual(['a', 'b']);
    expect(entries[0]).toEqual({
      t: '2026-11-14T15:00:01.000Z',
      line: 'a',
      labels: { service: 'core-api', level: 'error' },
      stream: 'core-api',
    });
    const span: SpanRow = {
      cursor: '1',
      timestamp: '2026-11-14T15:00:00.000Z',
      service: 'core-api',
      name: 'GET /o/:slug',
      kind: 'Server',
      durationMs: 12.345,
      status: 'Error',
      statusMessage: 'boom',
      traceId: 'ab',
      spanId: 'cd',
      parentSpanId: '',
      attributes: {},
      resource: {},
    };
    expect(spanEntries([span])[0]!.line).toBe('GET /o/:slug 12.35 ms Error: boom');
    for (const e of [...entries, ...spanEntries([span])]) conforms('LogEntry', e);
  });
});

/** Services whose telemetry answers from memory, so each operation's RawResult can be checked without ClickHouse. */
function fakeServices(): Services {
  const series: SeriesResponse = {
    bucketSeconds: 60,
    series: [{ key: 'core-api', points: [['2026-11-14T15:00:00Z', 3]] }],
  };
  const logRow: LogRow = {
    cursor: '1',
    timestamp: '2026-11-14T15:00:00.000Z',
    service: 'core-api',
    severity: 'error',
    body: 'boom',
    traceId: 'ab',
    spanId: 'cd',
    attributes: {},
    resource: {},
  };
  const telemetry = {
    metricNames: async () => ({
      metrics: [
        { name: 'http.server.duration', type: 'histogram', unit: 'ms', description: '', services: ['core-api'] },
      ],
    }),
    metric: async () => series,
    histogram: async () => series,
    serviceSeries: async () => ({
      bucketSeconds: 60,
      series: [
        { key: 'requests per minute', points: [['2026-11-14T15:00:00Z', 10]] },
        { key: 'errors per minute', points: [['2026-11-14T15:00:00Z', 1]] },
        { key: 'p95 latency (ms)', points: [['2026-11-14T15:00:00Z', 420.5]] },
      ],
    }),
    services: async () => ({ services: [] }),
    logServices: async () => [{ service: 'core-api', rows: 12 }],
    search: async (input: { signal: string }) => ({
      rows: input.signal === 'logs' ? [logRow] : [],
      nextCursor: null,
      stats: { rowsRead: 1, bytesRead: 1, elapsedMs: 1 },
    }),
    trace: async () => ({ traceId: 'ab', spans: [], services: [], durationMs: 0, errorCount: 0, startedAt: '' }),
    patterns: async () => ({ patterns: [], sampled: 0, total: 0 }),
  };
  return { telemetry } as unknown as Services;
}

describe('every operation answers a RawResult', () => {
  const protocol = new SourceProtocol(fakeServices());
  const from = '2026-11-14T14:00:00.000Z';
  const to = '2026-11-14T15:00:00.000Z';
  const params: Record<string, Record<string, unknown>> = {
    queryMetric: { metric: 'http.server.duration', service: 'core-api', from, to },
    countOverTime: { signal: 'logs', query: 'level:error', from, to },
    serviceHealth: { service: 'core-api', from, to },
    searchLogs: { query: 'service:core-api', from, to, limit: 5 },
    searchSpans: { query: 'service:core-api', from, to },
    getTrace: { traceId: 'ab' },
    eventPatterns: { query: 'level:error', from, to },
  };

  for (const op of OPERATIONS) {
    it(op.operation, async () => {
      const result = await protocol.invoke(op.operation, params[op.operation] ?? {});
      expect(result).toMatchObject({ source: 'clickland', operation: op.operation });
      expect(result.partial).toBeUndefined();
      if (op.operation === 'queryMetric' || op.operation === 'countOverTime' || op.operation === 'serviceHealth')
        expect(result.series?.length).toBeGreaterThan(0);
      if (op.operation === 'searchLogs') expect(result.entries).toHaveLength(1);
      conforms('RawResult', result);
    });
  }

  it('a missing param is a partial result that says what is missing', async () => {
    const result = await protocol.invoke('serviceHealth', {});
    expect(result).toMatchObject({ partial: true, error: 'serviceHealth needs a service', raw: null });
    conforms('RawResult', result);
  });

  it('serviceHealth labels each series with the service and a unit', async () => {
    const result = await protocol.invoke('serviceHealth', params.serviceHealth!);
    expect(result.series?.map((s) => [s.label, s.unit])).toEqual([
      ['core-api requests per minute', 'req/min'],
      ['core-api errors per minute', 'err/min'],
      ['core-api p95 latency (ms)', 'ms'],
    ]);
  });

  it('metrics/range runs the expression over the window', async () => {
    const result = await protocol.metricsRange({
      expr: 'health(core-api)',
      window: { fromMs: Date.parse(from), toMs: Date.parse(to) },
      tenant,
    });
    expect(result.operation).toBe('serviceHealth');
    expect(result.params).toMatchObject({ service: 'core-api', from, to, expr: 'health(core-api)' });
    conforms('RawResult', result);
    const bad = await protocol.metricsRange({ expr: 'sum(rate(x[5m]))', window: { fromMs: 0, toMs: 1 }, tenant });
    expect(bad).toMatchObject({ operation: 'metrics/range', partial: true });
    conforms('RawResult', bad);
  });
});

describe('the /v1 routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const clients = createClients(config);

  beforeAll(async () => {
    app = await buildApp(createServices(config, clients), { viewHtmlPath: '/nonexistent' });
  });
  afterAll(async () => {
    await app.close();
    await clients.close();
  });

  it('serves every path and method in the OpenAPI file', async () => {
    const routes = haveOpenApi
      ? openApiRoutes()
      : [
          'GET /v1/capabilities',
          'GET /v1/health',
          'POST /v1/invoke',
          'POST /v1/metrics/list',
          'POST /v1/metrics/range',
          'POST /v1/logs/streams',
          'POST /v1/logs/range',
        ];
    expect(routes).toHaveLength(7);
    for (const route of routes) {
      const [method, url] = route.split(' ') as ['GET' | 'POST', string];
      expect(app.hasRoute({ method, url })).toBe(true);
    }
  });

  it('answers capabilities that list every operation, and conform', async () => {
    const res = await app.inject({ url: '/v1/capabilities', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(capabilities());
    expect(res.json().kinds).toEqual(['metrics', 'logs']);
    conforms('CapabilitiesResponse', res.json());
    // A kind implies its canonical calls (the protocol's rule).
    const canonical = (kind: string) =>
      OPERATIONS.filter((o) => o.kind === kind && o.canonical)
        .map((o) => o.canonical)
        .sort();
    expect(canonical('metrics')).toEqual(['list', 'range']);
    expect(canonical('logs')).toEqual(['range', 'streams']);
  });

  it('reports itself unhealthy, in the protocol shape, when ClickHouse does not answer', async () => {
    const res = await app.inject({ url: '/v1/health', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(false);
    conforms('HealthResponse', res.json());
  });

  it('needs a key even in dev mode, and answers { error } like the protocol', async () => {
    const res = await app.inject({ url: '/v1/capabilities' });
    expect(res.statusCode).toBe(401);
    expect(typeof res.json().error).toBe('string');
  });

  it('refuses an unknown operation with 404 and a bad body with 400', async () => {
    const unknown = await app.inject({
      method: 'POST',
      url: '/v1/invoke',
      headers: auth,
      payload: { operation: 'dropTables', params: {}, tenant },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: 'unknown operation "dropTables"' });
    const bad = await app.inject({ method: 'POST', url: '/v1/logs/range', headers: auth, payload: { tenant } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/^query: /);
    const nowhere = await app.inject({ url: '/v1/nope', headers: auth });
    expect(nowhere.statusCode).toBe(404);
    expect(typeof nowhere.json().error).toBe('string');
  });
});
