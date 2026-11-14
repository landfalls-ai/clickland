import { compileSearch, quoteIdentifier, SearchFieldError, type ParamValue } from './compile.js';
import { type SignalSchema } from './signals.js';

/** A query ready for the ClickHouse client: SQL with `{name:Type}` placeholders and their values. */
export interface Query {
  sql: string;
  params: Record<string, ParamValue>;
}

export interface TimeRange {
  from: Date;
  to: Date;
}

const BUCKETS = [10, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 604800];

/** The smallest bucket that draws the range in at most `maxBuckets` points. */
export function chooseBucketSeconds(range: TimeRange, maxBuckets = 120): number {
  const seconds = Math.max(1, (range.to.getTime() - range.from.getTime()) / 1000);
  return BUCKETS.find((b) => seconds / b <= maxBuckets) ?? BUCKETS[BUCKETS.length - 1]!;
}

/**
 * Rounds a range out to whole buckets. Bounds that repeat let ClickHouse's query condition cache (on by default) and the
 * result cache serve a refreshing dashboard (research.md §3).
 */
export function alignRange(range: TimeRange, bucketSeconds: number): TimeRange {
  const ms = bucketSeconds * 1000;
  return {
    from: new Date(Math.floor(range.from.getTime() / ms) * ms),
    to: new Date(Math.ceil(range.to.getTime() / ms) * ms),
  };
}

/** ClickHouse DateTime64 text in UTC (the client runs with session_timezone = 'UTC'). */
export const chTime = (d: Date) => d.toISOString().replace('T', ' ').replace('Z', '');

function timeFilter(schema: SignalSchema, range: TimeRange): Query {
  const ts = quoteIdentifier(schema.timestamp);
  return {
    sql: `${ts} >= {from:DateTime64(9)} AND ${ts} < {to:DateTime64(9)}`,
    params: { from: chTime(range.from), to: chTime(range.to) },
  };
}

/** The SQL expression for a field used as a group or a column: native, materialized, or a map key. */
export function fieldExpression(
  schema: SignalSchema,
  field: string,
  params: Record<string, ParamValue>,
  name = 'g',
): string {
  const native = schema.native[field];
  if (native) return quoteIdentifier(native.column);
  const materialized = schema.materialized[field];
  if (materialized) return quoteIdentifier(materialized.column);
  for (const map of schema.maps) {
    const prefix = map.prefixes.find((p) => field.startsWith(`${p}.`));
    if (prefix) {
      params[name] = field.slice(prefix.length + 1);
      return `${quoteIdentifier(map.column)}[{${name}:String}]`;
    }
  }
  if (!/^[\w.\-@/]+$/.test(field)) throw new SearchFieldError(`Not a field: ${field}`);
  params[name] = field;
  // The first map that has the key.
  const parts = schema.maps.map((m) => `${quoteIdentifier(m.column)}[{${name}:String}]`);
  return parts.length === 1 ? parts[0]! : `coalesce(${parts.map((p) => `nullIf(${p}, '')`).join(', ')}, '')`;
}

const LOG_COLUMNS = [
  'Timestamp',
  'ServiceName',
  'SeverityText',
  'SeverityNumber',
  'Body',
  'TraceId',
  'SpanId',
  'LogAttributes',
  'ResourceAttributes',
];
const SPAN_COLUMNS = [
  'Timestamp',
  'ServiceName',
  'SpanName',
  'SpanKind',
  'Duration',
  'StatusCode',
  'StatusMessage',
  'TraceId',
  'SpanId',
  'ParentSpanId',
  'SpanAttributes',
  'ResourceAttributes',
];

export const rowColumns = (schema: SignalSchema) => (schema.signal === 'logs' ? LOG_COLUMNS : SPAN_COLUMNS);

/**
 * The newest rows that match, one page. `before` is the previous page's last timestamp (nanoseconds as text).
 * Logs sort by the sort key's prefix so ClickHouse can read in order and stop early.
 */
export function searchRowsQuery(
  schema: SignalSchema,
  query: string,
  range: TimeRange,
  limit: number,
  before?: string,
): Query {
  const filter = compileSearch(schema, query);
  const time = timeFilter(schema, range);
  const params: Record<string, ParamValue> = { ...filter.params, ...time.params, limit };
  let cursor = '';
  if (before) {
    if (!/^\d{1,20}$/.test(before)) throw new SearchFieldError('Bad cursor');
    params.before = before;
    cursor = ' AND toUnixTimestamp64Nano(Timestamp) < {before:Int64}';
  }
  const order = schema.signal === 'logs' ? 'toStartOfFiveMinutes(Timestamp) DESC, Timestamp DESC' : 'Timestamp DESC';
  return {
    sql: `SELECT ${rowColumns(schema).map(quoteIdentifier).join(', ')}, toString(toUnixTimestamp64Nano(Timestamp)) AS cursor
FROM ${quoteIdentifier(schema.table)}
WHERE ${time.sql}${cursor} AND (${filter.sql})
ORDER BY ${order}
LIMIT {limit:UInt32}`,
    params,
  };
}

/** Matching rows per bucket, optionally per value of a field (the caller keeps the top series). */
export function histogramQuery(
  schema: SignalSchema,
  query: string,
  range: TimeRange,
  bucketSeconds: number,
  groupBy?: string,
): Query {
  const filter = compileSearch(schema, query);
  const time = timeFilter(schema, range);
  const params: Record<string, ParamValue> = { ...filter.params, ...time.params, bucket: bucketSeconds };
  const group = groupBy ? fieldExpression(schema, groupBy, params) : "''";
  return {
    sql: `SELECT toStartOfInterval(Timestamp, toIntervalSecond({bucket:UInt32})) AS t, toString(${group}) AS k, count() AS c
FROM ${quoteIdentifier(schema.table)}
WHERE ${time.sql} AND (${filter.sql})
GROUP BY t, k
ORDER BY t
LIMIT 50000`,
    params,
  };
}

/** The count an alert compares with its threshold: one row per group. */
export function countQuery(schema: SignalSchema, query: string, range: TimeRange, groupBy?: string | null): Query {
  const filter = compileSearch(schema, query);
  const time = timeFilter(schema, range);
  const params: Record<string, ParamValue> = { ...filter.params, ...time.params };
  const group = groupBy ? fieldExpression(schema, groupBy, params) : "''";
  return {
    sql: `SELECT toString(${group}) AS k, count() AS c
FROM ${quoteIdentifier(schema.table)}
WHERE ${time.sql} AND (${filter.sql})
GROUP BY k
ORDER BY c DESC
LIMIT 1000`,
    params,
  };
}

/** Top values per field from the 15-minute rollup (never a scan of the raw rows). */
export function facetsQuery(schema: SignalSchema, range: TimeRange, perField = 10): Query {
  return {
    sql: `SELECT Key AS field, Value AS value, sum(count) AS c
FROM ${quoteIdentifier(schema.rollup)}
WHERE Timestamp >= toStartOfFifteenMinutes({from:DateTime64(9)}) AND Timestamp < {to:DateTime64(9)} AND Value != ''
GROUP BY field, value
ORDER BY field, c DESC
LIMIT {per:UInt32} BY field`,
    params: { from: chTime(range.from), to: chTime(range.to), per: perField },
  };
}

export function traceQuery(schema: SignalSchema, traceId: string): Query {
  if (!/^[0-9a-fA-F]{1,64}$/.test(traceId)) throw new SearchFieldError('A trace id is hexadecimal');
  return {
    sql: `SELECT ${SPAN_COLUMNS.map(quoteIdentifier).join(', ')}, toString(toUnixTimestamp64Nano(Timestamp)) AS cursor
FROM ${quoteIdentifier(schema.table)}
WHERE TraceId = {trace:String}
ORDER BY Timestamp
LIMIT 10000`,
    params: { trace: traceId.toLowerCase() },
  };
}

/** Request, error and latency figures per service from server/consumer spans (root spans when a service has none). */
export function servicesQuery(range: TimeRange): Query {
  return {
    sql: `SELECT ServiceName AS service,
  count() AS requests,
  countIf(StatusCode = 'Error') AS errors,
  quantiles(0.5, 0.95, 0.99)(Duration / 1e6) AS q
FROM otel_traces
WHERE Timestamp >= {from:DateTime64(9)} AND Timestamp < {to:DateTime64(9)}
  AND (SpanKind IN ('Server', 'Consumer', 'SPAN_KIND_SERVER', 'SPAN_KIND_CONSUMER') OR ParentSpanId = '')
GROUP BY service
ORDER BY requests DESC
LIMIT 500`,
    params: { from: chTime(range.from), to: chTime(range.to) },
  };
}

export function serviceLogErrorsQuery(range: TimeRange): Query {
  return {
    sql: `SELECT ServiceName AS service, count() AS c
FROM otel_logs
WHERE Timestamp >= {from:DateTime64(9)} AND Timestamp < {to:DateTime64(9)}
  AND (SeverityNumber >= 17 OR lower(SeverityText) IN ('error', 'fatal', 'critical', 'emergency', 'alert'))
GROUP BY service`,
    params: { from: chTime(range.from), to: chTime(range.to) },
  };
}

export type MetricType = 'gauge' | 'sum' | 'histogram';
export const METRIC_TABLES: Record<MetricType, string> = {
  gauge: 'otel_metrics_gauge',
  sum: 'otel_metrics_sum',
  histogram: 'otel_metrics_histogram',
};

export function metricNamesQuery(range: TimeRange): Query {
  const part = (type: MetricType) =>
    `SELECT MetricName AS name, '${type}' AS type, any(MetricUnit) AS unit, any(MetricDescription) AS description,
       groupUniqArray(20)(ServiceName) AS services
     FROM ${METRIC_TABLES[type]}
     WHERE TimeUnix >= {from:DateTime64(9)} AND TimeUnix < {to:DateTime64(9)}
     GROUP BY MetricName`;
  return {
    sql: `${(['gauge', 'sum', 'histogram'] as const).map(part).join('\nUNION ALL\n')}\nORDER BY name LIMIT 5000`,
    params: { from: chTime(range.from), to: chTime(range.to) },
  };
}

export type MetricAggregation = 'avg' | 'min' | 'max' | 'sum' | 'rate' | 'p50' | 'p95' | 'p99';

export interface MetricQueryInput {
  metric: string;
  type: MetricType;
  aggregation: MetricAggregation;
  range: TimeRange;
  bucketSeconds: number;
  service?: string;
  groupBy?: string;
}

/**
 * A metric per bucket.
 * - gauge: avg/min/max/sum of the values.
 * - sum: `rate` is the per-second increase per series (cumulative counters are differenced with a window, resets
 *   count as zero), summed over series; avg/min/max/sum read the values as they are.
 * - histogram: avg = Δsum/Δcount; p50/p95/p99 come back as summed bucket counts and bounds per bucket, and
 *   `histogramQuantile` finishes them (linear inside the bucket, like Prometheus).
 */
export function metricQuery(input: MetricQueryInput): Query {
  const params: Record<string, ParamValue> = {
    metric: input.metric,
    from: chTime(input.range.from),
    to: chTime(input.range.to),
    bucket: input.bucketSeconds,
  };
  const where = [
    'MetricName = {metric:String}',
    'TimeUnix >= {from:DateTime64(9)}',
    'TimeUnix < {to:DateTime64(9)}',
    ...(input.service ? ['ServiceName = {service:String}'] : []),
  ];
  if (input.service) params.service = input.service;
  let group = "''";
  if (input.groupBy) {
    if (!/^[\w.\-@/]+$/.test(input.groupBy)) throw new SearchFieldError(`Not an attribute: ${input.groupBy}`);
    params.g = input.groupBy;
    group = input.groupBy === 'service' ? 'ServiceName' : 'Attributes[{g:String}]';
  }
  const table = METRIC_TABLES[input.type];
  const bucket = 'toStartOfInterval(TimeUnix, toIntervalSecond({bucket:UInt32}))';
  const series = 'cityHash64(ServiceName, Attributes, ResourceAttributes)';
  const agg = input.aggregation;

  if (input.type === 'gauge' || (input.type === 'sum' && agg !== 'rate')) {
    if (!['avg', 'min', 'max', 'sum'].includes(agg))
      throw new SearchFieldError(`${input.type} takes avg, min, max or sum`);
    return {
      sql: `SELECT ${bucket} AS t, toString(${group}) AS k, ${agg}(Value) AS v
FROM ${table} WHERE ${where.join(' AND ')}
GROUP BY t, k ORDER BY t LIMIT 50000`,
      params,
    };
  }
  if (input.type === 'sum') {
    return {
      sql: `SELECT t, k, sum(inc) / {bucket:UInt32} AS v FROM (
  SELECT t, k, if(temporality = 1, last, greatest(last - lagInFrame(last, 1, last) OVER (PARTITION BY s ORDER BY t), 0.)) AS inc
  FROM (
    SELECT ${series} AS s, ${bucket} AS t, toString(${group}) AS k, any(AggregationTemporality) AS temporality,
      if(any(AggregationTemporality) = 1, sum(Value), argMax(Value, TimeUnix)) AS last
    FROM ${table} WHERE ${where.join(' AND ')}
    GROUP BY s, t, k
  )
)
GROUP BY t, k ORDER BY t LIMIT 50000`,
      params,
    };
  }
  // histogram
  if (agg === 'avg') {
    return {
      sql: `SELECT t, k, if(sum(dc) = 0, nan, sum(ds) / sum(dc)) AS v FROM (
  SELECT t, k,
    if(temporality = 1, cnt, greatest(cnt - lagInFrame(cnt, 1, cnt) OVER (PARTITION BY s ORDER BY t), 0.)) AS dc,
    if(temporality = 1, total, greatest(total - lagInFrame(total, 1, total) OVER (PARTITION BY s ORDER BY t), 0.)) AS ds
  FROM (
    SELECT ${series} AS s, ${bucket} AS t, toString(${group}) AS k, any(AggregationTemporality) AS temporality,
      toFloat64(if(any(AggregationTemporality) = 1, sum(Count), argMax(Count, TimeUnix))) AS cnt,
      if(any(AggregationTemporality) = 1, sum(Sum), argMax(Sum, TimeUnix)) AS total
    FROM ${table} WHERE ${where.join(' AND ')}
    GROUP BY s, t, k
  )
)
GROUP BY t, k ORDER BY t LIMIT 50000`,
      params,
    };
  }
  if (!['p50', 'p95', 'p99'].includes(agg)) throw new SearchFieldError('A histogram takes avg, p50, p95 or p99');
  return {
    sql: `SELECT t, k, sumForEach(d) AS counts, any(bounds) AS bounds FROM (
  SELECT t, k, bounds,
    if(temporality = 1, cur,
       arrayMap((a, b) -> greatest(a - b, toInt64(0)), cur, lagInFrame(cur, 1, cur) OVER (PARTITION BY s ORDER BY t))) AS d
  FROM (
    SELECT ${series} AS s, ${bucket} AS t, toString(${group}) AS k, any(AggregationTemporality) AS temporality,
      any(ExplicitBounds) AS bounds,
      arrayMap(x -> toInt64(x), if(any(AggregationTemporality) = 1, sumForEach(BucketCounts), argMax(BucketCounts, TimeUnix))) AS cur
    FROM ${table} WHERE ${where.join(' AND ')}
    GROUP BY s, t, k
  )
)
GROUP BY t, k ORDER BY t LIMIT 50000`,
    params,
  };
}

/** The q-quantile of a histogram from its bucket counts and upper bounds (the last bucket is +Inf). */
export function histogramQuantile(q: number, counts: number[], bounds: number[]): number {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return Number.NaN;
  const rank = q * total;
  let seen = 0;
  for (let i = 0; i < counts.length; i++) {
    const c = counts[i]!;
    if (seen + c >= rank && c > 0) {
      const lower = i === 0 ? 0 : bounds[i - 1]!;
      const upper = i < bounds.length ? bounds[i]! : (bounds[bounds.length - 1] ?? lower);
      if (i >= bounds.length) return upper; // the +Inf bucket: the last finite bound
      return lower + ((upper - lower) * (rank - seen)) / c;
    }
    seen += c;
  }
  return bounds[bounds.length - 1] ?? Number.NaN;
}

/** The newest matching rows' text, for pattern mining (Drain) and alert samples. */
export function sampleQuery(schema: SignalSchema, query: string, range: TimeRange, limit: number): Query {
  const filter = compileSearch(schema, query);
  const time = timeFilter(schema, range);
  const text = schema.signal === 'logs' ? 'Body' : 'SpanName';
  return {
    sql: `SELECT ${quoteIdentifier(text)} AS text, ServiceName AS service
FROM ${quoteIdentifier(schema.table)}
WHERE ${time.sql} AND (${filter.sql})
ORDER BY Timestamp DESC
LIMIT {limit:UInt32}`,
    params: { ...filter.params, ...time.params, limit },
  };
}

export function totalQuery(schema: SignalSchema, query: string, range: TimeRange): Query {
  const filter = compileSearch(schema, query);
  const time = timeFilter(schema, range);
  return {
    sql: `SELECT count() AS c FROM ${quoteIdentifier(schema.table)} WHERE ${time.sql} AND (${filter.sql})`,
    params: { ...filter.params, ...time.params },
  };
}
