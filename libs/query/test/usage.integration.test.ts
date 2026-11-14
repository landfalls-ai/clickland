/**
 * The usage rollup's SQL against a real ClickHouse (pnpm dev:up && pnpm db:migrate), when CLICKLAND_INTEGRATION names
 * `db` or `all`: synthetic kubelet, k8s_cluster and Docker samples in 2030 (where nothing else is), checked against
 * the TypeScript reference (`rollupSeries`). Rows are deleted afterwards.
 */
import { createClient } from '@clickhouse/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  capacityQuery,
  GIB,
  rollupSeries,
  usageRollupQuery,
  volumeQuery,
  type CapacityQueryRow,
  type Query,
  type Sample,
  type UsageGroupKey,
  type UsageQueryRow,
  type VolumeQueryRow,
} from '../src/index.js';

const enabled = /\b(db|all)\b/.test(process.env.CLICKLAND_INTEGRATION ?? '');
const client = createClient({
  url: process.env.CLICKLAND_CH_URL ?? 'http://127.0.0.1:28123',
  username: 'clickland_admin',
  password: process.env.CLICKLAND_CH_ADMIN_PASSWORD ?? 'clickland-dev-admin',
  database: 'clickland',
  clickhouse_settings: { session_timezone: 'UTC', output_format_json_quote_64bit_integers: 0 },
});

const RUN = `usage-test-${Date.now()}`;
const NODE = `${RUN}-node`;
const H = 3600;
const T = Date.UTC(2030, 0, 1) / 1000;
const FROM = T;
const TO = T + 2 * H;
const NOW = T + 3 * H;
const at = (s: number) => new Date(s * 1000).toISOString().slice(0, 19).replace('T', ' ');

// Deterministic "random" steps.
let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

/** Samples every 30 s from T − 60 s to TO + 60 s (before and past the range, as real data would be). */
const times = Array.from({ length: (TO - T) / 30 + 5 }, (_, i) => T - 60 + i * 30);

const WEB = { pod: 'web-7d9f8b6c5d-x2kqz', ctr: 'app' };
const DB = { pod: 'db-0', ctr: 'pg' };
const CPU_REQUEST = 0.5;
const MEM_REQUEST = 512 * 1024 * 1024;

// web/app: CPU seconds with a reset at the 100th sample, started 5 s after T (so its first value counts).
const webStart = T + 5;
const webTimes = times.filter((t) => t >= webStart);
let acc = 3;
const webCpu: Sample[] = webTimes.map((t, i) => {
  if (i === 100) acc = 2;
  else if (i > 0) acc += rnd() * 30;
  return { t, v: acc, st: webStart };
});
// Memory around the request, with a 5-minute gap.
const webMem: Sample[] = webTimes
  .filter((t) => t < T + 1500 || t >= T + 1800)
  .map((t) => ({ t, v: MEM_REQUEST * (0.5 + rnd()) }));
const webFs: Sample[] = webTimes.map((t) => ({ t, v: GIB }));
// db/pg: no request, a StatefulSet.
let dbAcc = 1000;
const dbCpu: Sample[] = times.map((t) => ({ t, v: (dbAcc += rnd() * 10), st: T - 86400 }));
const dbMem: Sample[] = times.map((t) => ({ t, v: 2 * GIB * rnd() }));
// Docker: ns of CPU, bytes.
let dAcc = 5e12;
const dockerCpu: Sample[] = times.map((t) => ({ t, v: (dAcc += rnd() * 15e9) }));
const dockerMem: Sample[] = times.map((t) => ({ t, v: GIB * (1 + rnd()) }));
let rx = 1e9;
const dockerRx: Sample[] = times.map((t) => ({ t, v: (rx += rnd() * 1e7) }));

const k8sResource = (pod: string, ctr: string, extra: Record<string, string> = {}) => ({
  'service.name': 'kubernetes',
  'k8s.cluster.name': 'test-cluster',
  'k8s.namespace.name': RUN,
  'k8s.pod.name': pod,
  'k8s.pod.uid': `${RUN}-${pod}`,
  'k8s.container.name': ctr,
  ...extra,
});

function rows(
  metric: string,
  scope: string,
  service: string,
  resource: Record<string, string>,
  samples: Sample[],
  sum: boolean,
  attributes: Record<string, string> = {},
) {
  return samples.map((s) => ({
    ResourceAttributes: resource,
    ScopeName: scope,
    ServiceName: service,
    MetricName: metric,
    Attributes: attributes,
    StartTimeUnix: at(s.st ?? T - 86400),
    TimeUnix: at(s.t),
    Value: s.v,
    ...(sum ? { AggregationTemporality: 2, IsMonotonic: true } : {}),
  }));
}

const KUBELET = 'github.com/open-telemetry/opentelemetry-collector-contrib/receiver/kubeletstatsreceiver';
const CLUSTER = 'github.com/open-telemetry/opentelemetry-collector-contrib/receiver/k8sclusterreceiver';
const DOCKER = 'github.com/open-telemetry/opentelemetry-collector-contrib/receiver/dockerstatsreceiver';

async function run<T>(q: Query): Promise<T[]> {
  return (await client.query({ query: q.sql, query_params: q.params, format: 'JSONEachRow' })).json<T>();
}

const GROUP: UsageGroupKey[] = [
  'k8s.cluster.name',
  'k8s.namespace.name',
  'k8s.workload.kind',
  'k8s.workload.name',
  'k8s.container.name',
  'compose.project',
  'compose.service',
  'k8s.pod.label.team',
];

const ref = (samples: Sample[], counter: boolean, extra: { countFirst?: boolean; request?: number } = {}) =>
  rollupSeries(samples, { counter, from: FROM, to: TO, now: NOW, bucket: H, ...extra });

describe.skipIf(!enabled)('usage rollup (live ClickHouse)', () => {
  let result: UsageQueryRow[] = [];

  beforeAll(async () => {
    const webRes = k8sResource(WEB.pod, WEB.ctr, { 'k8s.pod.label.team': 'pay' });
    const dbRes = k8sResource(DB.pod, DB.ctr, { 'k8s.statefulset.name': 'db' });
    const dockerRes = { 'compose.project': RUN, 'compose.service': 'cache', 'container.name': `${RUN}-cache-1` };
    // The same container Docker sees for a Kubernetes pod: must not be counted.
    const dup = { 'compose.project': RUN, 'compose.service': 'dup', 'k8s.pod.name': WEB.pod };
    const node = { 'k8s.cluster.name': 'test-cluster', 'k8s.node.name': NODE, 'service.name': 'kubernetes' };
    const volume = {
      ...k8sResource(DB.pod, ''),
      'k8s.volume.name': 'data',
      'k8s.volume.type': 'persistentVolumeClaim',
      'k8s.persistentvolumeclaim.name': 'data',
    };
    const flat = (t: number) => times.map((x) => ({ t: x, v: t }));
    const sums = [
      ...rows('container.cpu.time', KUBELET, 'kubernetes', webRes, webCpu, true),
      ...rows('container.cpu.time', KUBELET, 'kubernetes', dbRes, dbCpu, true),
      ...rows('container.cpu.usage.total', DOCKER, 'docker', dockerRes, dockerCpu, true),
      ...rows('container.memory.usage.total', DOCKER, 'docker', dockerRes, dockerMem, true),
      ...rows('container.network.io.usage.rx_bytes', DOCKER, 'docker', dockerRes, dockerRx, true, {
        interface: 'eth0',
      }),
      ...rows('container.cpu.usage.total', DOCKER, 'docker', dup, dockerCpu, true),
    ];
    const gauges = [
      ...rows('container.memory.working_set', KUBELET, 'kubernetes', webRes, webMem, false),
      ...rows('container.filesystem.usage', KUBELET, 'kubernetes', webRes, webFs, false),
      ...rows('container.memory.working_set', KUBELET, 'kubernetes', dbRes, dbMem, false),
      ...rows('k8s.container.cpu_request', CLUSTER, 'kubernetes', webRes, flat(CPU_REQUEST), false),
      ...rows('k8s.container.memory_request', CLUSTER, 'kubernetes', webRes, flat(MEM_REQUEST), false),
      ...rows('k8s.node.allocatable_cpu', CLUSTER, 'kubernetes', node, flat(4), false),
      ...rows('k8s.node.allocatable_memory', CLUSTER, 'kubernetes', node, flat(8 * GIB), false),
      ...rows('k8s.volume.capacity', KUBELET, 'kubernetes', volume, flat(5 * GIB), false),
      ...rows('k8s.volume.available', KUBELET, 'kubernetes', volume, flat(4 * GIB), false),
      // The claim is on the node's disk (local-path): the kubelet reports the same capacity for both.
      ...rows('k8s.node.filesystem.capacity', KUBELET, 'kubernetes', node, flat(5 * GIB), false),
    ];
    await client.insert({ table: 'otel_metrics_sum', format: 'JSONEachRow', values: sums });
    await client.insert({ table: 'otel_metrics_gauge', format: 'JSONEachRow', values: gauges });
    const all = await run<UsageQueryRow>(
      usageRollupQuery({
        from: new Date(FROM * 1000),
        to: new Date(TO * 1000),
        granularity: 'hour',
        groupBy: GROUP,
        sources: ['kubernetes', 'docker'],
        now: new Date(NOW * 1000),
      }),
    );
    result = all.filter((r) => r.g[1] === RUN || r.g[5] === RUN);
  });

  afterAll(async () => {
    for (const table of ['otel_metrics_sum', 'otel_metrics_gauge'])
      await client
        .command({
          query: `DELETE FROM ${table} WHERE ResourceAttributes['k8s.namespace.name'] = {r:String}
            OR ResourceAttributes['compose.project'] = {r:String} OR ResourceAttributes['k8s.node.name'] = {n:String}`,
          query_params: { r: RUN, n: NODE },
        })
        .catch(() => {});
    await client.close();
  });

  const row = (b: number, match: (g: string[]) => boolean) => result.find((r) => r.b === b && match(r.g));
  const hours = [T, T + H];

  it('matches the reference for a Kubernetes container with requests, owner and label', () => {
    const cpu = ref(webCpu, true, { countFirst: true, request: CPU_REQUEST });
    const mem = ref(webMem, false, { request: MEM_REQUEST });
    const fs = ref(webFs, false);
    for (const b of hours) {
      const r = row(b, (g) => g[4] === 'app');
      expect(r, `bucket ${b}`).toBeDefined();
      expect(r!.g).toEqual(['test-cluster', RUN, 'Deployment', 'web', 'app', '', '', 'pay']);
      expect(r!.cpu).toBeCloseTo(cpu.get(b)!.used / 3600, 9);
      expect(r!.cpu_req).toBeCloseTo(cpu.get(b)!.requested / 3600, 9);
      expect(r!.cpu_alloc).toBeCloseTo(cpu.get(b)!.allocated / 3600, 9);
      expect(r!.mem).toBeCloseTo(mem.get(b)!.used / GIB / 3600, 9);
      expect(r!.mem_req).toBeCloseTo(mem.get(b)!.requested / GIB / 3600, 9);
      expect(r!.mem_alloc).toBeCloseTo(mem.get(b)!.allocated / GIB / 3600, 9);
      expect(r!.fs).toBeCloseTo(fs.get(b)!.used / GIB / 3600, 9);
      expect(Number(r!.gap)).toBe(mem.get(b)!.gap);
      expect(Number(r!.unrequested)).toBe(0);
    }
    // The gap and the reset are in the first hour; the request and allocation differ from usage.
    expect(mem.get(T)!.gap).toBeGreaterThan(0);
    expect(row(T, (g) => g[4] === 'app')!.cpu_alloc).toBeGreaterThan(row(T, (g) => g[4] === 'app')!.cpu);
  });

  it('gives a container without a request allocated = used, and its owner from the attribute', () => {
    const cpu = ref(dbCpu, true, { countFirst: true });
    for (const b of hours) {
      const r = row(b, (g) => g[4] === 'pg')!;
      expect(r.g.slice(2, 4)).toEqual(['StatefulSet', 'db']);
      expect(r.cpu).toBeCloseTo(cpu.get(b)!.used / 3600, 9);
      expect(r.cpu_req).toBe(0);
      expect(r.cpu_alloc).toBeCloseTo(r.cpu, 12);
      expect(r.mem_alloc).toBeCloseTo(r.mem, 12);
      expect(Number(r.unrequested)).toBe(1);
      expect(Number(r.no_labels)).toBe(1);
    }
  });

  it('counts Docker once: Kubernetes-labelled containers are left out', () => {
    const cpu = ref(dockerCpu, true);
    const mem = ref(dockerMem, false);
    const rxr = ref(dockerRx, true);
    for (const b of hours) {
      const r = row(b, (g) => g[6] === 'cache')!;
      expect(r.source).toBe('docker');
      expect(r.cpu).toBeCloseTo(cpu.get(b)!.used / 1e9 / 3600, 9);
      expect(r.mem).toBeCloseTo(mem.get(b)!.used / GIB / 3600, 9);
      expect(r.rx).toBeCloseTo(rxr.get(b)!.used / 1e9, 9);
      expect(r.cpu_req).toBe(0);
      expect(r.cpu_alloc).toBeCloseTo(r.cpu, 12);
    }
    expect(result.some((r) => r.g[6] === 'dup')).toBe(false);
  });

  it('integrates node capacity and claim size per hour', async () => {
    const range = {
      from: new Date(FROM * 1000),
      to: new Date(TO * 1000),
      granularity: 'hour' as const,
      now: new Date(NOW * 1000),
    };
    const cap = (await run<CapacityQueryRow>(capacityQuery(range))).filter((c) => c.node === NODE);
    expect(cap.map((c) => c.b)).toEqual(hours);
    for (const c of cap) {
      expect(c.cpu).toBeCloseTo(4, 9);
      expect(c.mem).toBeCloseTo(8, 9);
    }
    const vol = (await run<VolumeQueryRow>(volumeQuery(range))).filter((v) => v.ns === RUN);
    expect(vol.map((v) => [v.b, v.claim])).toEqual(hours.map((b) => [b, 'data']));
    for (const v of vol) {
      expect(v.capacity).toBeCloseTo(5, 9);
      expect(v.capacity - v.available).toBeCloseTo(1, 9);
      expect(Number(v.shared_samples)).toBe(Number(v.capacity_samples));
    }
  });
});
