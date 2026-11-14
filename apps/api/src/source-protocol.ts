/**
 * Clickland as a Landfall remote source: the Landfall Source Protocol v1 over HTTP, under `/v1/*`.
 *
 * Landfall connects a "Remote source" by URL, verifies it (`GET /v1/health`, then `GET /v1/capabilities`), stores the
 * capabilities, and from then on its investigator, its chart and log widgets and every agent that joins a room read
 * Clickland through `POST /v1/invoke` and the canonical calls (`/v1/metrics/*`, `/v1/logs/*`). Shaped `series` and
 * `entries` are what Landfall's widgets draw. Auth is a Clickland API key with the `read` scope, sent as
 * `Authorization: Bearer ck_…` (the connection's bearer token); this face never falls back to dev mode.
 *
 * docs/reference/api.md ("Landfall Source Protocol") describes the operations and docs/landfall.md how to connect;
 * the contract is Landfall's `libs/signals/protocol/source-protocol.openapi.yaml`.
 */
import {
  type CapabilitiesResponse,
  type HealthResponse,
  InvokeRequest,
  type LogEntry,
  LogsRangeRequest,
  LogsStreamsRequest,
  type LogRow,
  MetricAggregation,
  MetricsListRequest,
  MetricsRangeRequest,
  MetricType,
  type OperationDescriptor,
  type RawResult,
  type RawSeries,
  type SeriesResponse,
  Signal,
  SOURCE_PROTOCOL_VERSION,
  type SpanRow,
} from '@clickland/contracts';
import { chooseBucketSeconds } from '@clickland/query';
import type { FastifyInstance } from 'fastify';
import { type z } from 'zod';
import { authenticate, requireScope } from './auth.js';
import { ApiError } from './errors.js';
import { VERSION } from './mcp.js';
import type { Services } from './services.js';

/** The service's own source tag (Landfall shows it as the connection's source name). */
export const SOURCE_TAG = 'clickland';

const WINDOW = { start: 'from', end: 'to', format: 'iso' } as const;
const RANGE_HINTS = {
  from: 'range start, ISO 8601 (default: an hour before "to")',
  to: 'range end, ISO 8601 (default: now)',
};
const SEARCH_HINT =
  'a Clickland search: words, "phrases", field:value, field:>n, AND/OR/NOT; fields include service, level, trace_id, status, duration';

/** Every operation `POST /v1/invoke` accepts, in the order Landfall lists them. */
export const OPERATIONS: OperationDescriptor[] = [
  {
    operation: 'listMetrics',
    kind: 'metrics',
    canonical: 'list',
    description: 'Which OpenTelemetry metrics exist (name, type, unit, the services that send it), over the last day.',
    params: { match: 'optional substring of the metric name', service: 'optional service name' },
  },
  {
    operation: 'queryMetric',
    kind: 'metrics',
    canonical: 'range',
    window: WINDOW,
    description:
      'One OpenTelemetry metric over a window, per bucket, as series. Histograms take p50/p95/p99/avg, counters rate (per second) or sum, gauges avg/min/max/sum.',
    params: {
      metric: 'metric name from listMetrics, e.g. http.server.duration',
      aggregation:
        'avg | min | max | sum | rate | p50 | p95 | p99 (default: p95 for a histogram, rate for a counter, avg for a gauge)',
      type: 'optional gauge | sum | histogram (looked up when absent)',
      service: 'optional service name',
      groupBy: 'optional attribute to split by, e.g. http.route',
      ...RANGE_HINTS,
    },
  },
  {
    operation: 'countOverTime',
    kind: 'metrics',
    window: WINDOW,
    description: 'How many log rows or spans match a search, per bucket, optionally one series per value of a field.',
    params: { signal: 'logs | traces', query: SEARCH_HINT, groupBy: 'optional field, e.g. service', ...RANGE_HINTS },
  },
  {
    operation: 'serviceHealth',
    kind: 'metrics',
    window: WINDOW,
    description:
      "One service's health from its spans, per bucket: requests per minute, errors per minute and p95 latency in ms.",
    params: { service: 'service name, e.g. core-api', ...RANGE_HINTS },
  },
  {
    operation: 'listServices',
    kind: 'metrics',
    window: WINDOW,
    description: 'Every service with requests, error spans, error rate, p50/p95/p99 latency and error logs.',
    params: { ...RANGE_HINTS },
  },
  {
    operation: 'listStreams',
    kind: 'logs',
    canonical: 'streams',
    description: 'Which services wrote logs over the last day (a stream is a service), busiest first.',
    params: { prefix: 'optional prefix of the service name' },
  },
  {
    operation: 'searchLogs',
    kind: 'logs',
    canonical: 'range',
    window: WINDOW,
    description: 'Log lines that match a search, newest first in raw, as entries sorted by time.',
    params: { query: SEARCH_HINT, limit: 'optional, 1-500 (default 100)', ...RANGE_HINTS },
  },
  {
    operation: 'searchSpans',
    kind: 'logs',
    window: WINDOW,
    description: 'Spans that match a search (e.g. status:error service:checkout, duration:>500), as entries.',
    params: { query: SEARCH_HINT, limit: 'optional, 1-500 (default 100)', ...RANGE_HINTS },
  },
  {
    operation: 'getTrace',
    kind: 'logs',
    description: 'Every span of one trace in start order, with depth and offset, as entries.',
    params: { traceId: 'hexadecimal trace id' },
  },
  {
    operation: 'eventPatterns',
    kind: 'logs',
    window: WINDOW,
    description: 'The recurring message templates among matching log rows (or span names), with counts and shares.',
    params: { signal: 'logs | traces (default logs)', query: SEARCH_HINT, ...RANGE_HINTS },
  },
];

const KNOWN = new Set(OPERATIONS.map((o) => o.operation));

export function capabilities(): CapabilitiesResponse {
  return {
    protocolVersion: SOURCE_PROTOCOL_VERSION,
    source: SOURCE_TAG,
    kinds: [...new Set(OPERATIONS.map((o) => o.kind))],
    operations: OPERATIONS,
  };
}

/** An unknown operation: 404 with the protocol's `{ error }` body. */
class UnknownOperation extends Error {}

/** A time from a param: ISO 8601, or epoch seconds, milliseconds or nanoseconds (as a number or digits). */
export function paramTime(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n =
    typeof value === 'number' ? value : typeof value === 'string' && /^\d+(\.\d+)?$/.test(value) ? Number(value) : NaN;
  const date = Number.isFinite(n)
    ? new Date(n < 1e11 ? n * 1000 : n < 1e14 ? n : n / 1e6)
    : typeof value === 'string'
      ? new Date(value)
      : new Date(NaN);
  if (Number.isNaN(date.getTime())) throw new ApiError('bad_request', `Not a time: ${String(value)}`);
  return date.toISOString();
}

const str = (params: Record<string, unknown>, key: string): string | undefined => {
  const v = params[key];
  return typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined;
};

const range = (params: Record<string, unknown>) => ({ from: paramTime(params.from), to: paramTime(params.to) });

const limitOf = (value: unknown, fallback = 100) => {
  const n = Number(value ?? fallback);
  return Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), 1), 500) : fallback;
};

/** Clickland's series → the protocol's: ISO points, sorted, finite values only. */
export function toRawSeries(response: SeriesResponse, name: string, unit?: string): RawSeries[] {
  return response.series.map((s) => ({
    label: s.key || name,
    ...(unit ? { unit } : {}),
    points: s.points
      .filter(([, v]) => Number.isFinite(v))
      .map(([t, v]) => ({ t: new Date(t).toISOString(), v }))
      .sort((a, b) => a.t.localeCompare(b.t)),
  }));
}

const labels = (pairs: Record<string, string | undefined>) =>
  Object.fromEntries(Object.entries(pairs).filter((kv): kv is [string, string] => Boolean(kv[1])));

/** Log rows → entries, oldest first (the protocol's order). */
export function logEntries(rows: LogRow[]): LogEntry[] {
  return rows
    .map((r) => ({
      t: r.timestamp,
      line: r.body,
      labels: labels({ service: r.service, level: r.severity, traceId: r.traceId, spanId: r.spanId }),
      stream: r.service,
    }))
    .sort((a, b) => a.t.localeCompare(b.t));
}

/** Spans → entries: `name 12.3 ms Error: message`, oldest first. */
export function spanEntries(rows: SpanRow[]): LogEntry[] {
  return rows
    .map((r) => ({
      t: r.timestamp,
      line: `${r.name} ${Math.round(r.durationMs * 100) / 100} ms${r.status && r.status !== 'Unset' ? ` ${r.status}` : ''}${r.statusMessage ? `: ${r.statusMessage}` : ''}`,
      labels: labels({ service: r.service, kind: r.kind, status: r.status, traceId: r.traceId, spanId: r.spanId }),
      stream: r.service,
    }))
    .sort((a, b) => a.t.localeCompare(b.t));
}

/**
 * The metrics range call's `expr`, Clickland's small expression form:
 * - `logs: <search>` or `traces: <search>`: matching rows per bucket (`countOverTime`);
 * - `health(<service>)`: requests, errors and p95 from the service's spans (`serviceHealth`);
 * - `[agg(]metric[{service="x"}][)] [by (attribute)]`: one OpenTelemetry metric (`queryMetric`).
 * With an empty `expr`, `selector` holds one of those operations' params (and may name it as `operation`).
 */
export function parseExpr(
  expr: string,
  selector: Record<string, unknown> = {},
): { operation: 'queryMetric' | 'countOverTime' | 'serviceHealth'; params: Record<string, unknown> } {
  const e = expr.trim();
  if (!e) {
    const named = selector.operation;
    if (named === 'queryMetric' || named === 'countOverTime' || named === 'serviceHealth')
      return { operation: named, params: selector };
    if (selector.metric) return { operation: 'queryMetric', params: selector };
    if (selector.signal || selector.query !== undefined) return { operation: 'countOverTime', params: selector };
    if (selector.service) return { operation: 'serviceHealth', params: selector };
    throw new ApiError('bad_request', 'Give an expr, or a selector with metric, signal or service');
  }
  const count = e.match(/^(logs|traces)\s*:(.*)$/s);
  if (count) return { operation: 'countOverTime', params: { ...selector, signal: count[1], query: count[2]!.trim() } };
  const health = e.match(/^health\(\s*"?([^")]+?)"?\s*\)$/);
  if (health) return { operation: 'serviceHealth', params: { ...selector, service: health[1] } };
  const metric = e.match(
    /^(?:(avg|min|max|sum|rate|p50|p95|p99)\(\s*)?([A-Za-z_][\w.\-/]*)\s*(?:\{([^}]*)\})?\s*(\))?\s*(?:by\s*\(\s*([\w.\-@/]+)\s*\))?$/,
  );
  if (!metric || Boolean(metric[1]) !== Boolean(metric[4]))
    throw new ApiError(
      'bad_request',
      `Not a Clickland expression: ${e}. Use logs: <search>, traces: <search>, health(<service>), or p95(metric{service="x"}) by (attribute)`,
    );
  const params: Record<string, unknown> = { ...selector, metric: metric[2] };
  if (metric[1]) params.aggregation = metric[1];
  if (metric[5]) params.groupBy = metric[5];
  for (const part of (metric[3] ?? '').split(',').filter((p) => p.trim())) {
    const label = part.match(/^\s*([\w.]+)\s*=\s*"([^"]*)"\s*$/);
    if (!label || !['service', 'service.name', 'service_name'].includes(label[1]!))
      throw new ApiError('bad_request', `Only service="…" can filter a metric, not ${part.trim()}`);
    params.service = label[2];
  }
  return { operation: 'queryMetric', params };
}

/** The bucket for a requested step: the smallest of Clickland's buckets that is at least `step`. */
export function bucketForStep(window: { from: Date; to: Date }, step?: number): number | undefined {
  if (!step) return undefined;
  const seconds = Math.max(1, (window.to.getTime() - window.from.getTime()) / 1000);
  return chooseBucketSeconds(window, Math.max(1, Math.min(1440, Math.floor(seconds / step))));
}

/** The seven protocol calls over Clickland's services. Each read answers `RawResult`. */
export class SourceProtocol {
  constructor(private readonly services: Services) {}

  async health(): Promise<HealthResponse> {
    try {
      await this.services.clients.ch.query({ query: 'SELECT 1' }).then((r) => r.close());
      return { ok: true, detail: `Clickland ${VERSION}: ClickHouse answers` };
    } catch (error) {
      return { ok: false, detail: `ClickHouse: ${error instanceof Error ? error.message.split('\n')[0] : 'down'}` };
    }
  }

  /** Runs one read; a problem Clickland can name (a bad search, a failed query) is a partial result, never a silent empty. */
  private async read(
    operation: string,
    params: Record<string, unknown>,
    run: () => Promise<{ raw: unknown; series?: RawSeries[]; entries?: LogEntry[] }>,
  ): Promise<RawResult> {
    const base = { source: SOURCE_TAG, operation, params };
    try {
      const out = await run();
      return {
        ...base,
        fetchedAt: new Date().toISOString(),
        raw: out.raw,
        ...(out.series ? { series: out.series } : {}),
        ...(out.entries ? { entries: out.entries } : {}),
      };
    } catch (error) {
      if (error instanceof UnknownOperation) throw error;
      if (!(error instanceof ApiError) || error.code === 'internal') throw error;
      return { ...base, fetchedAt: new Date().toISOString(), raw: null, partial: true, error: error.message };
    }
  }

  async invoke(operation: string, params: Record<string, unknown>): Promise<RawResult> {
    if (!KNOWN.has(operation)) throw new UnknownOperation(`unknown operation "${operation}"`);
    return this.read(operation, params, () => this.run(operation, params));
  }

  private async run(
    operation: string,
    params: Record<string, unknown>,
    bucketSeconds?: number,
  ): Promise<{ raw: unknown; series?: RawSeries[]; entries?: LogEntry[] }> {
    const { telemetry } = this.services;
    switch (operation) {
      case 'listMetrics': {
        const match = str(params, 'match')?.toLowerCase();
        const service = str(params, 'service') ?? str(params, 'namespace');
        const { metrics } = await telemetry.metricNames(range(params));
        return {
          raw: {
            metrics: metrics.filter(
              (m) => (!match || m.name.toLowerCase().includes(match)) && (!service || m.services.includes(service)),
            ),
          },
        };
      }
      case 'queryMetric': {
        const metric = str(params, 'metric');
        if (!metric) throw new ApiError('bad_request', 'queryMetric needs a metric (see listMetrics)');
        const type = MetricType.safeParse(params.type).data ?? (await this.metricType(metric));
        const fallback = type === 'histogram' ? 'p95' : type === 'sum' ? 'rate' : 'avg';
        const aggregation = MetricAggregation.safeParse(params.aggregation).data ?? fallback;
        const raw = await telemetry.metric({
          metric,
          type,
          aggregation,
          ...range(params),
          service: str(params, 'service') ?? null,
          groupBy: str(params, 'groupBy') ?? null,
          bucketSeconds,
        });
        return { raw, series: toRawSeries(raw, `${aggregation}(${metric})`) };
      }
      case 'countOverTime': {
        const signal = Signal.safeParse(params.signal ?? 'logs');
        if (!signal.success) throw new ApiError('bad_request', 'signal is logs or traces');
        const raw = await telemetry.histogram({
          signal: signal.data,
          query: str(params, 'query') ?? '',
          ...range(params),
          groupBy: str(params, 'groupBy') ?? null,
          bucketSeconds,
        });
        return { raw, series: toRawSeries(raw, signal.data === 'logs' ? 'log rows' : 'spans', 'count') };
      }
      case 'serviceHealth': {
        const service = str(params, 'service');
        if (!service) throw new ApiError('bad_request', 'serviceHealth needs a service');
        const raw = await telemetry.serviceSeries(service, { ...range(params), bucketSeconds });
        const units: Record<string, string> = {
          'requests per minute': 'req/min',
          'errors per minute': 'err/min',
          'p95 latency (ms)': 'ms',
        };
        return {
          raw,
          series: toRawSeries(raw, service).map((s) => ({
            ...s,
            label: `${service} ${s.label}`,
            unit: units[s.label],
          })),
        };
      }
      case 'listServices':
        return { raw: await telemetry.services(range(params)) };
      case 'listStreams': {
        const prefix = str(params, 'prefix');
        const streams = await telemetry.logServices({ ...range(params), from: range(params).from ?? dayAgo() });
        return { raw: { streams: streams.filter((s) => !prefix || s.service.startsWith(prefix)) } };
      }
      case 'searchLogs':
      case 'searchSpans': {
        const signal = operation === 'searchLogs' ? 'logs' : 'traces';
        const raw = await telemetry.search({
          signal,
          query: str(params, 'query') ?? '',
          ...range(params),
          limit: limitOf(params.limit),
        });
        const entries = signal === 'logs' ? logEntries(raw.rows as LogRow[]) : spanEntries(raw.rows as SpanRow[]);
        return { raw, entries };
      }
      case 'getTrace': {
        const traceId = str(params, 'traceId');
        if (!traceId || !/^[0-9a-fA-F]{1,64}$/.test(traceId))
          throw new ApiError('bad_request', 'getTrace needs a hexadecimal traceId');
        const raw = await telemetry.trace(traceId);
        return { raw, entries: spanEntries(raw.spans) };
      }
      case 'eventPatterns': {
        const signal = Signal.safeParse(params.signal ?? 'logs');
        if (!signal.success) throw new ApiError('bad_request', 'signal is logs or traces');
        return {
          raw: await telemetry.patterns({
            signal: signal.data,
            query: str(params, 'query') ?? '',
            ...range(params),
            sample: 5000,
          }),
        };
      }
      default:
        throw new UnknownOperation(`unknown operation "${operation}"`);
    }
  }

  private async metricType(metric: string): Promise<z.infer<typeof MetricType>> {
    const { metrics } = await this.services.telemetry.metricNames({});
    const found = metrics.find((m) => m.name === metric);
    if (!found) throw new ApiError('bad_request', `No metric named ${metric} in the last day (see listMetrics)`);
    return found.type;
  }

  async metricsList(req: MetricsListRequest): Promise<RawResult> {
    const params = { ...(req.match ? { match: req.match } : {}), ...(req.namespace ? { service: req.namespace } : {}) };
    return this.read('listMetrics', params, () => this.run('listMetrics', params));
  }

  async metricsRange(req: MetricsRangeRequest): Promise<RawResult> {
    const window = { from: new Date(req.window.fromMs), to: new Date(req.window.toMs) };
    const provenance = { expr: req.expr, ...(req.selector ? { selector: req.selector } : {}), window: req.window };
    let parsed: ReturnType<typeof parseExpr>;
    try {
      parsed = parseExpr(req.expr, req.selector);
    } catch (error) {
      return this.read('metrics/range', provenance, () => Promise.reject(error));
    }
    const { operation } = parsed;
    const params = { ...parsed.params, expr: req.expr, from: window.from.toISOString(), to: window.to.toISOString() };
    return this.read(operation, params, () => this.run(operation, params, bucketForStep(window, req.step)));
  }

  async logsStreams(req: LogsStreamsRequest): Promise<RawResult> {
    const params = req.prefix ? { prefix: req.prefix } : {};
    return this.read('listStreams', params, () => this.run('listStreams', params));
  }

  async logsRange(req: LogsRangeRequest): Promise<RawResult> {
    const params = {
      query: req.query,
      from: new Date(req.window.fromMs).toISOString(),
      to: new Date(req.window.toMs).toISOString(),
      ...(req.limit ? { limit: req.limit } : {}),
    };
    return this.read('searchLogs', params, () => this.run('searchLogs', params));
  }
}

const dayAgo = () => new Date(Date.now() - 24 * 3600_000).toISOString();

/** A protocol request body: a schema problem is a 400 with the protocol's `{ error }` body. */
function body<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value ?? {});
  if (result.success) return result.data;
  const issue = result.error.issues[0]!;
  throw new ApiError('bad_request', `${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}`);
}

/** Registers `/v1/*`. Errors answer `{ "error": "…" }`, the protocol's shape, not the rest of the API's. */
export async function registerSourceProtocol(app: FastifyInstance, services: Services): Promise<void> {
  const protocol = new SourceProtocol(services);
  await app.register(
    async (v1) => {
      v1.setErrorHandler((error, request, reply) => {
        if (error instanceof UnknownOperation) return reply.status(404).send({ error: error.message });
        if (error instanceof ApiError) return reply.status(error.status).send({ error: error.message });
        const e = error as { statusCode?: number; message: string };
        if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: e.message });
        request.log.error(error);
        return reply.status(500).send({ error: 'Something went wrong in Clickland' });
      });
      v1.setNotFoundHandler((request, reply) =>
        reply.status(404).send({ error: `no such route: ${request.method} ${request.url.split('?')[0]}` }),
      );
      // Always a key: the protocol is machine to machine, so CLICKLAND_AUTH=dev does not open it.
      v1.addHook('onRequest', async (request) => {
        if (!request.headers.authorization) throw new ApiError('unauthorized', 'Send a Clickland API key: Bearer ck_…');
        request.principal = await authenticate(services.clients.pg, services.config, request.headers.authorization);
        requireScope(request.principal, 'read');
      });
      v1.get('/capabilities', async () => capabilities());
      v1.get('/health', async () => protocol.health());
      v1.post('/invoke', async (r) => {
        const req = body(InvokeRequest, r.body);
        return protocol.invoke(req.operation, req.params);
      });
      v1.post('/metrics/list', async (r) => protocol.metricsList(body(MetricsListRequest, r.body)));
      v1.post('/metrics/range', async (r) => protocol.metricsRange(body(MetricsRangeRequest, r.body)));
      v1.post('/logs/streams', async (r) => protocol.logsStreams(body(LogsStreamsRequest, r.body)));
      v1.post('/logs/range', async (r) => protocol.logsRange(body(LogsRangeRequest, r.body)));
    },
    { prefix: '/v1' },
  );
}
