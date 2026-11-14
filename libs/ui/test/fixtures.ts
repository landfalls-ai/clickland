import type { LogRow, SpanRow, TraceResponse } from '@clickland/contracts';
import type { DataSource } from '../src/data';

export const T0 = '2026-11-14T15:00:00.000Z';
const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();

export function span(id: string, parent: string, offsetMs: number, durationMs: number, extra: Partial<SpanRow> = {}) {
  return {
    cursor: id,
    timestamp: at(offsetMs),
    service: 'api',
    name: `op-${id}`,
    kind: 'Server',
    durationMs,
    status: 'Ok',
    statusMessage: '',
    traceId: 'abc123',
    spanId: id,
    parentSpanId: parent,
    attributes: {},
    resource: {},
    depth: 0,
    offsetMs,
    ...extra,
  } satisfies SpanRow & { depth: number; offsetMs: number };
}

export function trace(spans: ReturnType<typeof span>[]): TraceResponse {
  return {
    traceId: 'abc123',
    spans,
    services: [...new Set(spans.map((s) => s.service))],
    durationMs: Math.max(...spans.map((s) => s.offsetMs + s.durationMs)),
    errorCount: spans.filter((s) => /error/i.test(s.status)).length,
    startedAt: T0,
  };
}

export const logRow = (i: number, extra: Partial<LogRow> = {}): LogRow => ({
  cursor: String(1000 - i),
  timestamp: at(i * 1000),
  service: i % 2 ? 'api' : 'worker',
  severity: i % 3 === 0 ? 'ERROR' : 'INFO',
  body: `log line ${i}`,
  traceId: i === 1 ? 'abc123' : '',
  spanId: '',
  attributes: { 'http.method': 'GET' },
  resource: { 'service.name': 'api' },
  ...extra,
});

/** A data source that answers from fixtures and records every call. */
export function fakeData(overrides: Partial<DataSource> = {}) {
  const calls: Array<[string, unknown]> = [];
  const series = {
    bucketSeconds: 60,
    series: [
      { key: 'api', points: [[T0, 4], [at(60_000), 6]] as [string, number][] },
      { key: 'worker', points: [[T0, 1]] as [string, number][] },
    ],
  };
  const data: DataSource = {
    search: async (req) => {
      calls.push(['search', req]);
      return req.signal === 'logs'
        ? { rows: [logRow(1), logRow(2)], nextCursor: null, stats: { rowsRead: 2, bytesRead: 10, elapsedMs: 1 } }
        : { rows: [span('s1', '', 0, 120)], nextCursor: null, stats: { rowsRead: 1, bytesRead: 10, elapsedMs: 1 } };
    },
    histogram: async (req) => {
      calls.push(['histogram', req]);
      return series;
    },
    trace: async (id) => {
      calls.push(['trace', id]);
      return trace([span('root', '', 0, 100), span('child', 'root', 10, 50)]);
    },
    services: async (range) => {
      calls.push(['services', range]);
      return [
        { name: 'api', requests: 1200, errors: 12, errorRate: 0.01, p50Ms: 12, p95Ms: 80, p99Ms: 200, logErrors: 3 },
      ];
    },
    metric: async (req) => {
      calls.push(['metric', req]);
      return series;
    },
    patterns: async (req) => {
      calls.push(['patterns', req]);
      return {
        patterns: [
          { template: 'Connection to <*> refused after <NUM> ms', count: 812, share: 0.41, example: 'Connection to db refused after 30 ms', services: ['api'] },
        ],
        sampled: 5000,
        total: 9120,
      };
    },
    total: async (req) => {
      calls.push(['total', req]);
      return 4321;
    },
    ...overrides,
  };
  return { data, calls };
}
