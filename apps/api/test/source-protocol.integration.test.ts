/**
 * The Source Protocol face against the local stack, every answer validated against Landfall's OpenAPI file:
 * CLICKLAND_INTEGRATION=db pnpm --filter @clickland/api test:integration
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createClients } from '../src/clients.js';
import { configFromEnv } from '../src/config.js';
import { createServices } from '../src/services.js';
import { haveOpenApi, validateAgainst } from './landfall-openapi.js';

const enabled = (process.env.CLICKLAND_INTEGRATION ?? '').split(',').includes('db');
const config = { ...configFromEnv({ CLICKLAND_AUTH: 'keys' }), backgroundJobs: false };
const tenant = { ref: 'integration-test' };

const conforms = (component: string, value: unknown) => {
  if (haveOpenApi) expect(validateAgainst(component, value)).toEqual([]);
};

describe.skipIf(!enabled)('Source Protocol (live stack)', () => {
  const clients = createClients(config);
  const services = createServices(config, clients);
  let app: Awaited<ReturnType<typeof buildApp>>;
  const keyIds: string[] = [];
  let read: Record<string, string>;
  let notesOnly: Record<string, string>;
  let service = 'core-api';
  const window = { fromMs: Date.now() - 6 * 3600_000, toMs: Date.now() };

  beforeAll(async () => {
    app = await buildApp(services, { viewHtmlPath: '/nonexistent' });
    const r = await services.keys.create({ name: 'test-source-read', scopes: ['read'] });
    const n = await services.keys.create({ name: 'test-source-notes', scopes: ['notes:write'] });
    keyIds.push(r.id, n.id);
    read = { authorization: `Bearer ${r.key}` };
    notesOnly = { authorization: `Bearer ${n.key}` };
    const busiest = (await services.telemetry.services({})).services[0];
    if (busiest) service = busiest.name;
  });
  afterAll(async () => {
    for (const id of keyIds) await clients.pg`DELETE FROM api_keys WHERE id = ${id}`;
    await app.close();
    await clients.close();
  });

  const post = (url: string, payload: unknown, headers = read) =>
    app.inject({ method: 'POST', url, headers, payload: payload as Record<string, unknown> });

  it('verifies like Landfall does: health, then capabilities, with a read key', async () => {
    const health = await app.inject({ url: '/v1/health', headers: read });
    expect(health.json()).toMatchObject({ ok: true });
    conforms('HealthResponse', health.json());
    const caps = await app.inject({ url: '/v1/capabilities', headers: read });
    expect(caps.json().protocolVersion).toBe('1');
    conforms('CapabilitiesResponse', caps.json());
  });

  it('refuses a wrong key (401) and a key without read (403)', async () => {
    const wrong = await app.inject({
      url: '/v1/capabilities',
      headers: { authorization: 'Bearer ck_not_a_real_key_00000000000000000' },
    });
    expect(wrong.statusCode).toBe(401);
    expect((await app.inject({ url: '/v1/capabilities', headers: notesOnly })).statusCode).toBe(403);
  });

  it('metrics: list, and a range as series (service health, counts, an OTel metric)', async () => {
    const list = await post('/v1/metrics/list', { tenant });
    expect(list.statusCode).toBe(200);
    conforms('RawResult', list.json());
    for (const expr of [`health(${service})`, `traces: service:"${service}"`, 'logs: level:error']) {
      const res = await post('/v1/metrics/range', { expr, window, step: 300, tenant });
      expect(res.statusCode).toBe(200);
      expect(res.json().partial).toBeUndefined();
      expect(Array.isArray(res.json().series)).toBe(true);
      conforms('RawResult', res.json());
    }
    const metric = list.json().raw.metrics[0] as { name: string } | undefined;
    if (metric) {
      const res = await post('/v1/metrics/range', { expr: metric.name, window, tenant });
      expect(res.json().partial).toBeUndefined();
      conforms('RawResult', res.json());
    }
  });

  it('logs: streams, and a range as entries sorted by time', async () => {
    const streams = await post('/v1/logs/streams', { tenant });
    conforms('RawResult', streams.json());
    const res = await post('/v1/logs/range', { query: '', window, limit: 20, tenant });
    expect(res.statusCode).toBe(200);
    const entries = (res.json().entries ?? []) as { t: string }[];
    expect(entries.map((e) => e.t)).toEqual([...entries.map((e) => e.t)].sort());
    conforms('RawResult', res.json());
  });

  it('invoke: every advertised operation answers a conforming RawResult', async () => {
    const caps = (await app.inject({ url: '/v1/capabilities', headers: read })).json() as {
      operations: { operation: string }[];
    };
    const from = new Date(window.fromMs).toISOString();
    const to = new Date(window.toMs).toISOString();
    const spans = await post('/v1/invoke', {
      operation: 'searchSpans',
      params: { query: `service:"${service}"`, from, to, limit: 1 },
      tenant,
    });
    const traceId = (spans.json().raw?.rows?.[0]?.traceId as string | undefined) ?? 'ab';
    const params: Record<string, Record<string, unknown>> = {
      queryMetric: { metric: 'http.server.duration', from, to },
      countOverTime: { signal: 'traces', query: `service:"${service}"`, groupBy: 'status', from, to },
      serviceHealth: { service, from, to },
      searchLogs: { query: 'level:error', from, to, limit: 10 },
      searchSpans: { query: `service:"${service}"`, from, to, limit: 10 },
      getTrace: { traceId },
      eventPatterns: { query: '', from, to },
    };
    for (const { operation } of caps.operations) {
      const res = await post('/v1/invoke', { operation, params: params[operation] ?? { from, to }, tenant });
      expect(res.statusCode, operation).toBe(200);
      conforms('RawResult', res.json());
    }
  });

  it('a bad search is a partial result with the reason, not an empty one', async () => {
    const res = await post('/v1/logs/range', { query: '"open', window, tenant });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ partial: true, raw: null });
    expect(res.json().error).toMatch(/quote/);
    conforms('RawResult', res.json());
  });
});
