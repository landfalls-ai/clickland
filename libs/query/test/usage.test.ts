import { describe, expect, it } from 'vitest';
import {
  capacityQuery,
  DEPLOYMENT_FROM_POD,
  GAP_SECONDS,
  rollupSeries,
  STEP_SECONDS,
  usageFeeds,
  usageRollupQuery,
  volumeQuery,
  type Sample,
} from '../src/index.js';

const H = 3600;
const DAY = 86400;
/** 2026-11-14T00:00:00Z */
const T0 = Date.UTC(2026, 10, 14) / 1000;
const every30 = (from: number, n: number, value: (i: number) => number, st = 0): Sample[] =>
  Array.from({ length: n }, (_, i) => ({ t: from + i * 30, v: value(i), st }));
const only = (m: Map<number, unknown>) => [...m.values()][0];

describe('rollupSeries: gauges', () => {
  it('holds each value until the next sample: value × seconds', () => {
    const r = rollupSeries(
      every30(T0, 120, () => 2),
      { counter: false, from: T0, to: T0 + H, now: T0 + 2 * H, bucket: H },
    );
    // 120 samples × 30 s × 2 = 7200 value-seconds: two units for an hour.
    expect(only(r)).toMatchObject({ used: 7200, samples: 120, gap: 0 });
  });

  it('counts a step for a gap and reports the rest', () => {
    const samples = [
      { t: T0, v: 1 },
      { t: T0 + 30, v: 1 },
      { t: T0 + 30 + 600, v: 1 },
    ];
    const r = only(rollupSeries(samples, { counter: false, from: T0, to: T0 + H, now: T0 + 2 * H, bucket: H }));
    expect(r).toMatchObject({ used: 30 + STEP_SECONDS + STEP_SECONDS, gap: 600 - STEP_SECONDS });
    expect(GAP_SECONDS).toBe(90);
  });

  it('counts the last sample up to now, at most a step', () => {
    const r = only(rollupSeries([{ t: T0, v: 4 }], { counter: false, from: T0, to: T0 + H, now: T0 + 10, bucket: H }));
    expect(r).toMatchObject({ used: 40 });
  });

  it('gives an interval to the bucket of its start, so adjacent ranges count it once', () => {
    const samples = every30(T0 + H - 60, 4, () => 1); // two intervals before the hour, two after
    const all = rollupSeries(samples, { counter: false, from: T0, to: T0 + 2 * H, now: T0 + 3 * H, bucket: H });
    expect(all.get(T0)?.used).toBe(60);
    expect(all.get(T0 + H)?.used).toBe(60);
    const first = rollupSeries(samples, { counter: false, from: T0, to: T0 + H, now: T0 + 3 * H, bucket: H });
    const second = rollupSeries(samples, { counter: false, from: T0 + H, to: T0 + 2 * H, now: T0 + 3 * H, bucket: H });
    expect(first.get(T0)!.used + second.get(T0 + H)!.used).toBe(120);
  });

  it('requested is the request × the same seconds; allocated the larger per interval', () => {
    // Usage 1, 3, 1, 3 … against a request of 2: allocated = 2, 3, 2, 3 … per 30 s.
    const r = only(
      rollupSeries(
        every30(T0, 4, (i) => (i % 2 ? 3 : 1)),
        {
          counter: false,
          from: T0,
          to: T0 + H,
          now: T0 + 120,
          bucket: H,
          request: 2,
        },
      ),
    ) as { used: number; requested: number; allocated: number };
    expect(r.used).toBe((1 + 3 + 1 + 3) * 30);
    expect(r.requested).toBe(2 * 120);
    expect(r.allocated).toBe((2 + 3 + 2 + 3) * 30);
    // Not max(Σ request, Σ usage), which would be 240.
    expect(r.allocated).toBeGreaterThan(Math.max(r.used, r.requested));
  });

  it('with no request, allocated = used', () => {
    const r = only(
      rollupSeries(
        every30(T0, 10, () => 5),
        { counter: false, from: T0, to: T0 + H, now: T0 + H, bucket: H },
      ),
    ) as {
      used: number;
      allocated: number;
      requested: number;
    };
    expect(r.requested).toBe(0);
    expect(r.allocated).toBe(r.used);
  });
});

describe('rollupSeries: counters', () => {
  it('counts the differences, and a drop as a reset', () => {
    const samples = [10, 20, 35, 5, 15].map((v, i) => ({ t: T0 + i * 30, v }));
    const r = only(rollupSeries(samples, { counter: true, from: T0, to: T0 + H, now: T0 + H, bucket: H }));
    // 10 + 15 + 5 (after the reset, all new) + 10
    expect(r).toMatchObject({ used: 40, samples: 5 });
  });

  it('counts the first value of a Kubernetes series that started in the range', () => {
    const samples = every30(T0 + 100, 3, (i) => 6 + i, T0 + 90);
    const counted = rollupSeries(samples, {
      counter: true,
      countFirst: true,
      from: T0,
      to: T0 + H,
      now: T0 + H,
      bucket: H,
    });
    const not = rollupSeries(samples, { counter: true, from: T0, to: T0 + H, now: T0 + H, bucket: H });
    expect(only(counted)).toMatchObject({ used: 6 + 2 });
    expect(only(not)).toMatchObject({ used: 2 });
    // A series that started before the range: only the differences.
    const before = every30(T0 + 100, 3, (i) => 6 + i, T0 - 10);
    expect(
      only(rollupSeries(before, { counter: true, countFirst: true, from: T0, to: T0 + H, now: T0 + H, bucket: H })),
    ).toMatchObject({ used: 2 });
  });

  it('allocates the larger of request × interval and the CPU used in it', () => {
    // 0.5 core requested; the container runs 0.25 core, then 1 core.
    const samples = [0, 7.5, 37.5].map((v, i) => ({ t: T0 + i * 30, v }));
    const r = only(
      rollupSeries(samples, { counter: true, from: T0, to: T0 + H, now: T0 + H, bucket: H, request: 0.5 }),
    ) as {
      used: number;
      requested: number;
      allocated: number;
    };
    expect(r.used).toBe(37.5);
    expect(r.requested).toBe(0.5 * 60);
    expect(r.allocated).toBe(15 + 30);
  });

  it('uses the lookahead past the range for the last interval', () => {
    const samples = every30(T0 + DAY - 30, 2, (i) => i * 3);
    const r = rollupSeries(samples, { counter: true, from: T0, to: T0 + DAY, now: T0 + 2 * DAY, bucket: DAY });
    expect(r.get(T0)?.used).toBe(3);
    expect(r.size).toBe(1);
  });
});

describe('usageRollupQuery', () => {
  const base = { from: new Date(T0 * 1000), to: new Date((T0 + DAY) * 1000), granularity: 'day' as const };

  it('reads container metrics from the kubelet and leaves Kubernetes containers out of Docker', () => {
    const feeds = usageFeeds(['kubernetes', 'docker']);
    expect(feeds.filter((f) => f.source === 'kubernetes').map((f) => f.metric)).toEqual([
      'container.cpu.time',
      'container.memory.working_set',
      'container.filesystem.usage',
    ]);
    for (const f of feeds.filter((f) => f.source === 'docker'))
      expect(f.where).toContain("NOT (ResourceAttributes['k8s.pod.name'] != '')");
  });

  it('passes pod label keys as parameters, never in the SQL', () => {
    const q = usageRollupQuery({
      ...base,
      groupBy: ['k8s.namespace.name', "k8s.pod.label.team'--"],
      sources: ['kubernetes', 'docker'],
    });
    expect(q.params.l1).toBe("k8s.pod.label.team'--");
    expect(q.sql).toContain('pi_labels[{l1:String}]');
    expect(q.sql).not.toContain("team'--");
  });

  it('joins requests and pod owners only when Kubernetes is read', () => {
    const k = usageRollupQuery({ ...base, groupBy: ['k8s.workload.name'], sources: ['kubernetes'] });
    expect(k.sql).toContain("'k8s.container.cpu_request'");
    expect(k.sql).toContain('AS pi_deployment');
    const d = usageRollupQuery({ ...base, groupBy: ['compose.project'], sources: ['docker'] });
    expect(d.sql).not.toContain('k8s.container.cpu_request');
    expect(d.sql).toContain('CROSS JOIN');
  });

  it('buckets by hour or day, with the lookahead in the fetch', () => {
    const q = usageRollupQuery({ ...base, granularity: 'hour', groupBy: [], sources: ['docker'] });
    expect(q.sql).toContain('toStartOfHour');
    expect(q.params.fetch_to).toBe('2026-11-15 00:01:30.000');
    expect(capacityQuery(base).sql).toContain('k8s.node.allocatable_cpu');
    expect(volumeQuery(base).sql).toContain("k8s.persistentvolumeclaim.name'] != ''");
  });

  it('finds a Deployment in a pod name', () => {
    const re = new RegExp(DEPLOYMENT_FROM_POD);
    expect('landflow-host-c4bd87f4f-4jrg7'.match(re)?.[1]).toBe('landflow-host');
    expect('plugin-attio-5f864c76cb-9xqgv'.match(re)?.[1]).toBe('plugin-attio');
    expect('clickland-node-logs-x7k2p'.match(re)).toBeNull();
    expect('postgres-0'.match(re)).toBeNull();
  });
});
