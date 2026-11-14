/**
 * Metric `where` filters against a real ClickHouse (pnpm dev:up && pnpm db:migrate), when CLICKLAND_INTEGRATION names
 * `db` or `all`: gauge samples for two pods in a namespace of their own, in 2030 (where nothing else is), then
 * filtered by namespace and pod. Rows are deleted afterwards.
 */
import { createClient } from '@clickhouse/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { metricQuery, type Query } from '../src/index.js';

const enabled = /\b(db|all)\b/.test(process.env.CLICKLAND_INTEGRATION ?? '');
const client = createClient({
  url: process.env.CLICKLAND_CH_URL ?? 'http://127.0.0.1:28123',
  username: 'clickland_admin',
  password: process.env.CLICKLAND_CH_ADMIN_PASSWORD ?? 'clickland-dev-admin',
  database: 'clickland',
  clickhouse_settings: { session_timezone: 'UTC' },
});

const NS = `where-test-${Date.now()}`;
const T = Date.UTC(2030, 1, 1) / 1000;
const at = (s: number) => new Date(s * 1000).toISOString().slice(0, 19).replace('T', ' ');
const range = { from: new Date(T * 1000), to: new Date((T + 600) * 1000) };

/** Pod a: containers api (0.25 cores) and proxy (0.01); pod b: api (2 cores). Every 30 s for ten minutes. */
const samples = [
  ['a', 'api', 0.25],
  ['a', 'proxy', 0.01],
  ['b', 'api', 2],
] as const;

async function run(q: Query) {
  return (await client.query({ query: q.sql, query_params: q.params, format: 'JSONEachRow' })).json<{
    t: string;
    k: string;
    v: number;
  }>();
}

describe.skipIf(!enabled)('metric where filters (live ClickHouse)', () => {
  beforeAll(async () => {
    const values = samples.flatMap(([pod, container, v]) =>
      Array.from({ length: 20 }, (_, i) => ({
        TimeUnix: at(T + i * 30),
        ServiceName: 'kubernetes',
        MetricName: 'container.cpu.usage',
        Value: v,
        Attributes: {},
        ResourceAttributes: {
          'k8s.cluster.name': 'test-cluster',
          'k8s.namespace.name': NS,
          'k8s.pod.name': pod,
          'k8s.container.name': container,
        },
      })),
    );
    await client.insert({ table: 'otel_metrics_gauge', format: 'JSONEachRow', values });
  });

  afterAll(async () => {
    await client
      .command({
        query: `DELETE FROM otel_metrics_gauge WHERE ResourceAttributes['k8s.namespace.name'] = {ns:String}`,
        query_params: { ns: NS },
      })
      .catch(() => {});
    await client.close();
  });

  const query = (where: Record<string, string>, groupBy?: string) =>
    run(
      metricQuery({
        metric: 'container.cpu.usage',
        type: 'gauge',
        aggregation: 'avg',
        range,
        bucketSeconds: 60,
        service: 'kubernetes',
        groupBy,
        where,
      }),
    );

  it("keeps one pod's containers", async () => {
    const rows = await query({ 'k8s.namespace.name': NS, 'k8s.pod.name': 'a' }, 'k8s.container.name');
    expect(new Set(rows.map((r) => r.k))).toEqual(new Set(['api', 'proxy']));
    expect(rows.find((r) => r.k === 'api')!.v).toBeCloseTo(0.25);
    expect(rows).toHaveLength(20); // 10 one-minute buckets × 2 containers
  });

  it('keeps a namespace, split by pod', async () => {
    const rows = await query({ 'k8s.namespace.name': NS }, 'k8s.pod.name');
    expect(new Set(rows.map((r) => r.k))).toEqual(new Set(['a', 'b']));
  });

  it('matches nothing, and fails nothing, for a value that looks like SQL', async () => {
    expect(await query({ 'k8s.namespace.name': `${NS}' OR 1=1 --` })).toEqual([]);
  });
});
