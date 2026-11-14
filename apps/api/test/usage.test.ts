import { UsageRollupRequest } from '@clickland/contracts';
import { describe, expect, it } from 'vitest';
import { requireScope } from '../src/auth.js';
import { quantity, usageMissing } from '../src/usage.js';

const principal = (scopes: string[]) => ({ scopes }) as unknown as Parameters<typeof requireScope>[0];

describe('usage rollup', () => {
  it('writes quantities as six-decimal strings', () => {
    expect(quantity(1.4923)).toBe('1.492300');
    expect(quantity(0)).toBe('0.000000');
    expect(quantity(-0.0000001)).toBe('0.000000');
    expect(quantity(12.3456789)).toBe('12.345679');
  });

  it('takes fixed keys and pod labels, once each, and a bounded range', () => {
    const ok = UsageRollupRequest.parse({
      from: '2026-11-14T00:00:00Z',
      to: '2026-11-15T00:00:00Z',
      granularity: 'day',
      groupBy: ['k8s.cluster.name', 'k8s.workload.kind', 'k8s.pod.label.app.kubernetes.io/name'],
    });
    expect(ok.source).toBe('all');
    const bad = (body: object) =>
      UsageRollupRequest.safeParse({
        from: '2026-11-14T00:00:00Z',
        to: '2026-11-15T00:00:00Z',
        granularity: 'day',
        ...body,
      }).success;
    expect(bad({ groupBy: ['k8s.pod.label.'] })).toBe(false);
    expect(bad({ groupBy: ["k8s.pod.label.x' OR 1"] })).toBe(false);
    expect(bad({ groupBy: ['host.name'] })).toBe(false);
    expect(bad({ groupBy: ['k8s.namespace.name', 'k8s.namespace.name'] })).toBe(false);
    expect(bad({ to: '2026-11-14T00:00:00Z' })).toBe(false);
    expect(bad({ granularity: 'hour', to: '2026-12-16T00:00:00Z' })).toBe(false);
  });

  it('is open to usage:read, read and admin keys only', () => {
    expect(() => requireScope(principal(['usage:read']), 'usage:read')).not.toThrow();
    expect(() => requireScope(principal(['read']), 'usage:read')).not.toThrow();
    expect(() => requireScope(principal(['admin']), 'usage:read')).not.toThrow();
    expect(() => requireScope(principal(['views:write']), 'usage:read')).toThrow(/usage:read/);
    // usage:read grants nothing else.
    expect(() => requireScope(principal(['usage:read']), 'read')).toThrow(/read/);
  });

  it('lists what is missing: always egress; the rest when it applies', () => {
    const none = usageMissing({ groupBy: [] }, ['docker'], [], 0, 0).map((m) => m.field);
    expect(none).toEqual(['networkEgressGB']);
    const k8s = usageMissing(
      { groupBy: ['k8s.workload.name', 'k8s.pod.label.team'] },
      ['kubernetes'],
      [{ source: 'kubernetes', unowned: 2, no_labels: 3, no_cluster: 0, net_samples: 0 }],
      10,
      0,
    );
    expect(k8s.map((m) => m.field)).toEqual([
      'networkEgressGB',
      'networkRxGB, networkTxGB (kubernetes)',
      'k8s.workload.kind, k8s.workload.name',
      'k8s.pod.label.*',
      'volumes',
    ]);
    expect(k8s[2]!.reason).toMatch(/^2 pod/);
    expect(k8s[4]!.fix).toMatch(/volume/);
  });
});
