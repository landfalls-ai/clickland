import type { ClickHouseClient } from '@clickhouse/client';
import type {
  LogRow,
  MetricQueryRequest,
  PatternResult,
  RangeInput,
  SearchResponse,
  SeriesResponse,
  ServiceSummary,
  Signal,
  SpanRow,
  TraceResponse,
} from '@clickland/contracts';
import {
  alignRange,
  buildTrace,
  chooseBucketSeconds,
  countQuery,
  facetsQuery,
  histogramQuantile,
  histogramQuery,
  logServicesQuery,
  metricNamesQuery,
  metricQuery,
  minePatterns,
  sampleQuery,
  SearchFieldError,
  SearchSyntaxError,
  searchRowsQuery,
  serviceLogErrorsQuery,
  serviceSeriesQuery,
  servicesQuery,
  SIGNALS,
  totalQuery,
  traceQuery,
  TRACES,
  type TimeRange,
} from '@clickland/query';
import { runQuery } from './clients.js';
import { ApiError, notFound } from './errors.js';

/** A range from optional bounds (default: the last hour) or a view's range. */
export function resolveRange(
  input: { from?: string | null; to?: string | null } | RangeInput | undefined,
  defaultMinutes = 60,
): TimeRange {
  const now = Date.now();
  if (input && 'lastMinutes' in input) return { from: new Date(now - input.lastMinutes * 60_000), to: new Date(now) };
  const to = input?.to ? new Date(input.to) : new Date(now);
  const from = input?.from ? new Date(input.from) : new Date(to.getTime() - defaultMinutes * 60_000);
  if (!(from < to)) throw new ApiError('bad_request', '"from" must be before "to"');
  return { from, to };
}

/** A search problem the user can fix is a 400, with where it is. */
export function wrapSearchErrors<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof SearchSyntaxError)
      throw new ApiError('bad_request', error.message, { position: error.position });
    if (error instanceof SearchFieldError) throw new ApiError('bad_request', error.message);
    throw error;
  }
}

const iso = (chTime: string) => `${chTime.replace(' ', 'T')}Z`;
/** ClickHouse DateTime64(9) text → ISO with milliseconds. */
const isoMs = (chTime: string) => new Date(iso(chTime.slice(0, 23))).toISOString();

type RawLog = {
  Timestamp: string;
  ServiceName: string;
  SeverityText: string;
  Body: string;
  TraceId: string;
  SpanId: string;
  LogAttributes: Record<string, string>;
  ResourceAttributes: Record<string, string>;
  cursor: string;
};
type RawSpan = {
  Timestamp: string;
  ServiceName: string;
  SpanName: string;
  SpanKind: string;
  Duration: number | string;
  StatusCode: string;
  StatusMessage: string;
  TraceId: string;
  SpanId: string;
  ParentSpanId: string;
  SpanAttributes: Record<string, string>;
  ResourceAttributes: Record<string, string>;
  cursor: string;
};

const toLog = (r: RawLog): LogRow => ({
  cursor: r.cursor,
  timestamp: isoMs(r.Timestamp),
  service: r.ServiceName,
  severity: r.SeverityText,
  body: r.Body,
  traceId: r.TraceId,
  spanId: r.SpanId,
  attributes: r.LogAttributes,
  resource: r.ResourceAttributes,
});

const toSpan = (r: RawSpan): SpanRow => ({
  cursor: r.cursor,
  timestamp: isoMs(r.Timestamp),
  service: r.ServiceName,
  name: r.SpanName,
  kind: r.SpanKind,
  durationMs: Number(r.Duration) / 1e6,
  status: r.StatusCode,
  statusMessage: r.StatusMessage,
  traceId: r.TraceId,
  spanId: r.SpanId,
  parentSpanId: r.ParentSpanId,
  attributes: r.SpanAttributes,
  resource: r.ResourceAttributes,
});

export class Telemetry {
  constructor(private readonly ch: ClickHouseClient) {}

  async search(input: {
    signal: Signal;
    query: string;
    from?: string | null;
    to?: string | null;
    limit: number;
    before?: string | null;
  }): Promise<SearchResponse> {
    const schema = SIGNALS[input.signal];
    const range = resolveRange(input);
    const q = wrapSearchErrors(() =>
      searchRowsQuery(schema, input.query, range, input.limit, input.before ?? undefined),
    );
    const result = await runQuery<RawLog & RawSpan>(this.ch, q);
    const rows = input.signal === 'logs' ? result.rows.map(toLog) : result.rows.map(toSpan);
    return {
      rows,
      nextCursor: rows.length === input.limit ? rows[rows.length - 1]!.cursor : null,
      stats: result.stats,
    };
  }

  async histogram(input: {
    signal: Signal;
    query: string;
    from?: string | null;
    to?: string | null;
    groupBy?: string | null;
    /** Internal: a fixed bucket (the Source Protocol's `step`), else one that draws the range in ~120 points. */
    bucketSeconds?: number;
  }): Promise<SeriesResponse> {
    const schema = SIGNALS[input.signal];
    const raw = resolveRange(input);
    const bucketSeconds = input.bucketSeconds ?? chooseBucketSeconds(raw);
    const range = alignRange(raw, bucketSeconds);
    const q = wrapSearchErrors(() =>
      histogramQuery(schema, input.query, range, bucketSeconds, input.groupBy ?? undefined),
    );
    const { rows } = await runQuery<{ t: string; k: string; c: number }>(this.ch, q);
    return {
      bucketSeconds,
      series: topSeries(
        rows.map((r) => ({ t: r.t, k: r.k, v: Number(r.c) })),
        10,
        'sum',
      ),
    };
  }

  async count(
    signal: Signal,
    query: string,
    range: TimeRange,
    groupBy?: string | null,
  ): Promise<{ key: string; count: number }[]> {
    const q = wrapSearchErrors(() => countQuery(SIGNALS[signal], query, range, groupBy));
    const { rows } = await runQuery<{ k: string; c: number }>(this.ch, q);
    return rows.map((r) => ({ key: r.k, count: Number(r.c) }));
  }

  async total(signal: Signal, query: string, range: TimeRange): Promise<number> {
    const q = wrapSearchErrors(() => totalQuery(SIGNALS[signal], query, range));
    const { rows } = await runQuery<{ c: number }>(this.ch, q);
    return Number(rows[0]?.c ?? 0);
  }

  async facets(input: { signal: Signal; from?: string | null; to?: string | null }) {
    const { rows } = await runQuery<{ field: string; value: string; c: number }>(
      this.ch,
      facetsQuery(SIGNALS[input.signal], resolveRange(input)),
    );
    const fields = new Map<string, { value: string; count: number }[]>();
    for (const r of rows) {
      const list = fields.get(r.field) ?? [];
      list.push({ value: r.value, count: Number(r.c) });
      fields.set(r.field, list);
    }
    return { fields: [...fields].map(([field, values]) => ({ field, values })) };
  }

  async trace(traceId: string): Promise<TraceResponse> {
    const q = wrapSearchErrors(() => traceQuery(TRACES, traceId));
    const { rows } = await runQuery<RawSpan>(this.ch, q);
    if (rows.length === 0) throw notFound('Trace');
    const spans = rows.map((r) => ({
      ...toSpan(r),
      startNs: BigInt(r.cursor),
      durationNs: BigInt(r.Duration),
      spanId: r.SpanId,
      parentSpanId: r.ParentSpanId,
    }));
    const tree = buildTrace(spans);
    return {
      traceId: traceId.toLowerCase(),
      spans: tree.ordered.map(({ span, depth }) => {
        const { startNs, durationNs: _d, ...row } = span;
        return { ...row, depth, offsetMs: Number(startNs - tree.startNs) / 1e6 };
      }),
      services: tree.services,
      durationMs: Number(tree.durationNs) / 1e6,
      errorCount: tree.errorCount,
      startedAt: new Date(Number(tree.startNs / 1_000_000n)).toISOString(),
    };
  }

  async services(input: { from?: string | null; to?: string | null }): Promise<{ services: ServiceSummary[] }> {
    const range = resolveRange(input);
    const [spans, logs] = await Promise.all([
      runQuery<{ service: string; requests: number; errors: number; q: number[] }>(this.ch, servicesQuery(range)),
      runQuery<{ service: string; c: number }>(this.ch, serviceLogErrorsQuery(range)),
    ]);
    const logErrors = new Map(logs.rows.map((r) => [r.service, Number(r.c)]));
    const byName = new Map<string, ServiceSummary>();
    for (const r of spans.rows) {
      const requests = Number(r.requests);
      const errors = Number(r.errors);
      const round = (n: number | undefined) => Math.round((n ?? 0) * 100) / 100;
      byName.set(r.service, {
        name: r.service,
        requests,
        errors,
        errorRate: requests ? errors / requests : 0,
        p50Ms: round(r.q[0]),
        p95Ms: round(r.q[1]),
        p99Ms: round(r.q[2]),
        logErrors: logErrors.get(r.service) ?? 0,
      });
    }
    for (const [name, count] of logErrors) {
      if (!byName.has(name))
        byName.set(name, {
          name,
          requests: 0,
          errors: 0,
          errorRate: 0,
          p50Ms: 0,
          p95Ms: 0,
          p99Ms: 0,
          logErrors: count,
        });
    }
    return { services: [...byName.values()].sort((a, b) => b.requests - a.requests || b.logErrors - a.logErrors) };
  }

  async metricNames(input: { from?: string | null; to?: string | null }) {
    const { rows } = await runQuery<{
      name: string;
      type: 'gauge' | 'sum' | 'histogram';
      unit: string;
      description: string;
      services: string[];
    }>(this.ch, metricNamesQuery(resolveRange(input, 24 * 60)));
    return { metrics: rows };
  }

  async metric(input: MetricQueryRequest & { bucketSeconds?: number }): Promise<SeriesResponse> {
    const raw = resolveRange(input);
    const bucketSeconds = input.bucketSeconds ?? chooseBucketSeconds(raw);
    const range = alignRange(raw, bucketSeconds);
    const q = wrapSearchErrors(() =>
      metricQuery({
        metric: input.metric,
        type: input.type,
        aggregation: input.aggregation,
        range,
        bucketSeconds,
        service: input.service ?? undefined,
        groupBy: input.groupBy ?? undefined,
        where: input.where ?? undefined,
      }),
    );
    if (input.type === 'histogram' && input.aggregation.startsWith('p')) {
      const quantile = Number(input.aggregation.slice(1)) / 100;
      const { rows } = await runQuery<{ t: string; k: string; counts: number[]; bounds: number[] }>(this.ch, q);
      const points = rows.map((r) => ({
        t: r.t,
        k: r.k,
        v: histogramQuantile(quantile, r.counts.map(Number), r.bounds.map(Number)),
      }));
      return {
        bucketSeconds,
        series: topSeries(
          points.filter((p) => Number.isFinite(p.v)),
          10,
          'max',
        ),
      };
    }
    const { rows } = await runQuery<{ t: string; k: string; v: number }>(this.ch, q);
    return {
      bucketSeconds,
      series: topSeries(
        rows.map((r) => ({ t: r.t, k: r.k, v: Number(r.v) })).filter((p) => Number.isFinite(p.v)),
        10,
        'max',
      ),
    };
  }

  async patterns(input: {
    signal: Signal;
    query: string;
    from?: string | null;
    to?: string | null;
    sample: number;
  }): Promise<{ patterns: PatternResult[]; sampled: number; total: number }> {
    const schema = SIGNALS[input.signal];
    const range = resolveRange(input);
    const [sample, total] = await Promise.all([
      runQuery<{ text: string; service: string }>(
        this.ch,
        wrapSearchErrors(() => sampleQuery(schema, input.query, range, input.sample)),
      ),
      this.total(input.signal, input.query, range),
    ]);
    const patterns = minePatterns(sample.rows);
    const sampled = sample.rows.length;
    return {
      patterns: patterns.slice(0, 50).map((p) => ({ ...p, share: sampled ? p.count / sampled : 0 })),
      sampled,
      total,
    };
  }

  /** One service's requests and errors per minute and p95 latency per bucket, from its spans. */
  async serviceSeries(
    service: string,
    input: { from?: string | null; to?: string | null; bucketSeconds?: number },
  ): Promise<SeriesResponse> {
    const raw = resolveRange(input);
    const bucketSeconds = input.bucketSeconds ?? chooseBucketSeconds(raw);
    const range = alignRange(raw, bucketSeconds);
    const { rows } = await runQuery<{ t: string; requests: number; errors: number; p95: number }>(
      this.ch,
      serviceSeriesQuery(service, range, bucketSeconds),
    );
    const perMinute = 60 / bucketSeconds;
    const at = (t: string) => iso(t.slice(0, 19));
    const round = (n: number) => Math.round(n * 1000) / 1000;
    return {
      bucketSeconds,
      series: [
        { key: 'requests per minute', points: rows.map((r) => [at(r.t), round(Number(r.requests) * perMinute)]) },
        { key: 'errors per minute', points: rows.map((r) => [at(r.t), round(Number(r.errors) * perMinute)]) },
        {
          key: 'p95 latency (ms)',
          points: rows.filter((r) => Number.isFinite(Number(r.p95))).map((r) => [at(r.t), round(Number(r.p95))]),
        },
      ],
    };
  }

  /** The services that wrote logs in the range, busiest first. */
  async logServices(input: { from?: string | null; to?: string | null }): Promise<{ service: string; rows: number }[]> {
    const { rows } = await runQuery<{ service: string; c: number }>(this.ch, logServicesQuery(resolveRange(input)));
    return rows.map((r) => ({ service: r.service, rows: Number(r.c) }));
  }

  async sampleRows(signal: Signal, query: string, range: TimeRange, limit: number): Promise<LogRow[] | SpanRow[]> {
    const schema = SIGNALS[signal];
    const { rows } = await runQuery<RawLog & RawSpan>(
      this.ch,
      wrapSearchErrors(() => searchRowsQuery(schema, query, range, limit)),
    );
    return signal === 'logs' ? rows.map(toLog) : rows.map(toSpan);
  }
}

/** Keeps the `limit` biggest series and folds the rest into "other" (the series' key order is by size). */
export function topSeries(
  points: { t: string; k: string; v: number }[],
  limit: number,
  rank: 'sum' | 'max',
): SeriesResponse['series'] {
  const size = new Map<string, number>();
  for (const p of points)
    size.set(p.k, rank === 'sum' ? (size.get(p.k) ?? 0) + p.v : Math.max(size.get(p.k) ?? -Infinity, p.v));
  const keep = new Set(
    [...size]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([k]) => k),
  );
  const series = new Map<string, Map<string, number>>();
  for (const p of points) {
    const key = keep.has(p.k) ? p.k : 'other';
    const byTime = series.get(key) ?? new Map<string, number>();
    byTime.set(p.t, (byTime.get(p.t) ?? 0) + p.v);
    series.set(key, byTime);
  }
  const order = [...keep, 'other'];
  return [...series]
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([key, byTime]) => ({
      key,
      points: [...byTime].sort().map(([t, v]) => [iso(t.slice(0, 19)), v] as [string, number]),
    }));
}
