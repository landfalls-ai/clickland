/**
 * How a search's field names map onto the ClickStack-compatible tables (libs/schema migrations 0002-0004).
 * Everything the compiler emits comes from here, so a field name typed by a user never reaches SQL as text.
 */

export type Signal = 'logs' | 'traces';

export interface NativeColumn {
  column: string;
  kind: 'string' | 'number' | 'datetime';
  /** A `text` index exists on this column (exact token matches use it). */
  textIndexed?: boolean;
}

export interface MapColumn {
  column: string;
  /** The ALIAS Array(String) of `key=value` items with a text index (`has(items, 'k=v')` uses it). */
  items: string;
  /** Prefixes that address this map explicitly: `resource.k8s.pod.name`, `ResourceAttributes.k8s.pod.name`. */
  prefixes: string[];
}

export interface SignalSchema {
  signal: Signal;
  table: string;
  timestamp: string;
  /** The column a bare word searches, and the expression its text index is built on. */
  implicit: { column: string; indexedExpression: string };
  native: Record<string, NativeColumn>;
  /** Searched in this order for a field that is neither native nor prefixed. */
  maps: MapColumn[];
  /** `MATERIALIZED` columns that hold one map key: reading them is much cheaper than reading the map. */
  materialized: Record<string, { map: string; key: string; column: string }>;
  /** The 15-minute key/value rollup the facets read. */
  rollup: string;
}

const resourceMap: MapColumn = {
  column: 'ResourceAttributes',
  items: 'ResourceAttributeItems',
  prefixes: ['resource', 'ResourceAttributes'],
};

const k8sMaterialized = (prefix: string) =>
  Object.fromEntries(
    [
      'k8s.cluster.name',
      'k8s.container.name',
      'k8s.deployment.name',
      'k8s.namespace.name',
      'k8s.node.name',
      'k8s.pod.name',
      'k8s.pod.uid',
      'deployment.environment.name',
    ].map((key) => [key, { map: 'ResourceAttributes', key, column: `${prefix}${key}` }]),
  );

export const LOGS: SignalSchema = {
  signal: 'logs',
  table: 'otel_logs',
  timestamp: 'Timestamp',
  implicit: { column: 'Body', indexedExpression: 'lower(Body)' },
  native: {
    timestamp: { column: 'Timestamp', kind: 'datetime' },
    service: { column: 'ServiceName', kind: 'string' },
    'service.name': { column: 'ServiceName', kind: 'string' },
    ServiceName: { column: 'ServiceName', kind: 'string' },
    level: { column: 'SeverityText', kind: 'string' },
    severity: { column: 'SeverityText', kind: 'string' },
    SeverityText: { column: 'SeverityText', kind: 'string' },
    severity_number: { column: 'SeverityNumber', kind: 'number' },
    SeverityNumber: { column: 'SeverityNumber', kind: 'number' },
    body: { column: 'Body', kind: 'string' },
    Body: { column: 'Body', kind: 'string' },
    trace_id: { column: 'TraceId', kind: 'string', textIndexed: true },
    TraceId: { column: 'TraceId', kind: 'string', textIndexed: true },
    span_id: { column: 'SpanId', kind: 'string' },
    SpanId: { column: 'SpanId', kind: 'string' },
    scope: { column: 'ScopeName', kind: 'string' },
    ScopeName: { column: 'ScopeName', kind: 'string' },
    event: { column: 'EventName', kind: 'string' },
    EventName: { column: 'EventName', kind: 'string' },
  },
  maps: [
    { column: 'LogAttributes', items: 'LogAttributeItems', prefixes: ['attributes', 'attr', 'LogAttributes'] },
    resourceMap,
    { column: 'ScopeAttributes', items: 'ScopeAttributeItems', prefixes: ['scope_attributes', 'ScopeAttributes'] },
  ],
  materialized: {
    ...k8sMaterialized('__hdx_materialized_'),
    'session.id': { map: 'LogAttributes', key: 'session.id', column: '__hdx_materialized_session.id' },
  },
  rollup: 'otel_logs_kv_rollup_15m',
};

export const TRACES: SignalSchema = {
  signal: 'traces',
  table: 'otel_traces',
  timestamp: 'Timestamp',
  implicit: { column: 'SpanName', indexedExpression: 'SpanName' },
  native: {
    timestamp: { column: 'Timestamp', kind: 'datetime' },
    service: { column: 'ServiceName', kind: 'string' },
    'service.name': { column: 'ServiceName', kind: 'string' },
    ServiceName: { column: 'ServiceName', kind: 'string' },
    name: { column: 'SpanName', kind: 'string' },
    span: { column: 'SpanName', kind: 'string' },
    SpanName: { column: 'SpanName', kind: 'string' },
    kind: { column: 'SpanKind', kind: 'string' },
    SpanKind: { column: 'SpanKind', kind: 'string' },
    status: { column: 'StatusCode', kind: 'string' },
    StatusCode: { column: 'StatusCode', kind: 'string' },
    status_message: { column: 'StatusMessage', kind: 'string' },
    StatusMessage: { column: 'StatusMessage', kind: 'string' },
    duration: { column: 'Duration', kind: 'number' },
    Duration: { column: 'Duration', kind: 'number' },
    trace_id: { column: 'TraceId', kind: 'string', textIndexed: true },
    TraceId: { column: 'TraceId', kind: 'string', textIndexed: true },
    span_id: { column: 'SpanId', kind: 'string' },
    SpanId: { column: 'SpanId', kind: 'string' },
    parent_span_id: { column: 'ParentSpanId', kind: 'string' },
    ParentSpanId: { column: 'ParentSpanId', kind: 'string' },
  },
  maps: [
    { column: 'SpanAttributes', items: 'SpanAttributeItems', prefixes: ['attributes', 'attr', 'SpanAttributes'] },
    resourceMap,
  ],
  materialized: {
    'rum.sessionId': { map: 'ResourceAttributes', key: 'rum.sessionId', column: '__hdx_materialized_rum.sessionId' },
  },
  rollup: 'otel_traces_kv_rollup_15m',
};

export const SIGNALS: Record<Signal, SignalSchema> = { logs: LOGS, traces: TRACES };

/** `duration` on traces is in nanoseconds in storage; searches take milliseconds (`duration:>500`). */
export const DURATION_NS_PER_MS = 1_000_000;
