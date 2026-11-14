import { describe, expect, it } from 'vitest';
import { METRIC_WHERE_LIMIT, metricQuery, metricWhere, SearchFieldError } from '../src/index.js';

const range = { from: new Date('2026-11-14T12:00:00Z'), to: new Date('2026-11-14T13:00:00Z') };
const base = { metric: 'container.cpu.usage', type: 'gauge', aggregation: 'avg', range, bucketSeconds: 60 } as const;

describe('metric where filters', () => {
  it('adds one parameterized condition per key, resource attribute as the fallback', () => {
    const q = metricQuery({ ...base, where: { 'k8s.namespace.name': 'shop', 'k8s.pod.name': 'api-7d9c' } });
    expect(q.sql).toContain(
      'if(mapContains(Attributes, {w0k:String}), Attributes[{w0k:String}], ResourceAttributes[{w0k:String}]) = {w0v:String}',
    );
    expect(q.sql).toContain('= {w1v:String}');
    expect(q.params).toMatchObject({
      w0k: 'k8s.namespace.name',
      w0v: 'shop',
      w1k: 'k8s.pod.name',
      w1v: 'api-7d9c',
    });
  });

  it('never puts a value in the SQL text', () => {
    const evil = "x' OR 1=1 --";
    const q = metricQuery({ ...base, where: { 'k8s.pod.name': evil } });
    expect(q.sql).not.toContain(evil);
    expect(q.sql).not.toContain('OR 1=1');
    expect(q.params.w0v).toBe(evil);
  });

  it('applies to sums and histograms too, inside every inner query', () => {
    for (const q of [
      metricQuery({ ...base, type: 'sum', aggregation: 'rate', where: { 'k8s.node.name': 'n1' } }),
      metricQuery({ ...base, type: 'histogram', aggregation: 'p95', where: { 'k8s.node.name': 'n1' } }),
      metricQuery({ ...base, type: 'histogram', aggregation: 'avg', where: { 'k8s.node.name': 'n1' } }),
    ]) {
      expect(q.sql).toContain('= {w0v:String}');
      expect(q.params.w0v).toBe('n1');
    }
  });

  it('reads `service` as the service name', () => {
    const params = {};
    expect(metricWhere({ service: 'kubernetes' }, params)).toEqual(['ServiceName = {w0v:String}']);
    expect(params).toEqual({ w0v: 'kubernetes' });
  });

  it('refuses keys that are not attribute names, and too many filters', () => {
    for (const key of ["a'b", 'a b', 'a)', '', '1abc', 'x{y}'])
      expect(() => metricWhere({ [key]: 'v' }, {})).toThrow(SearchFieldError);
    const many = Object.fromEntries(Array.from({ length: METRIC_WHERE_LIMIT + 1 }, (_, i) => [`k${i}`, 'v']));
    expect(() => metricWhere(many, {})).toThrow(/At most/);
  });

  it('changes nothing without filters', () => {
    expect(metricQuery({ ...base }).sql).toBe(metricQuery({ ...base, where: {} }).sql);
  });
});
