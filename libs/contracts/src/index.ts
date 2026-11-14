/** The Clickland API's wire contracts. docs/reference/api.md describes them; these schemas are what the API enforces. */
import { z } from 'zod';

export * from './landfall.js';

export const Signal = z.enum(['logs', 'traces']);
export type Signal = z.infer<typeof Signal>;

const isoTime = z.iso.datetime({ offset: true });

/** A time range: absolute bounds, or the last N minutes (relative ranges move with the clock). */
export const RangeInput = z.union([
  z.object({ from: isoTime, to: isoTime }),
  z.object({
    lastMinutes: z
      .number()
      .int()
      .min(1)
      .max(60 * 24 * 90),
  }),
]);
export type RangeInput = z.infer<typeof RangeInput>;

const query = z.string().max(4000).default('');
const field = z
  .string()
  .regex(/^[A-Za-z_@][\w.\-@/]*$/, 'a field name')
  .max(200);

const bounds = { from: isoTime.optional(), to: isoTime.optional() };

export const SearchRequest = z.object({
  signal: Signal,
  query,
  ...bounds,
  limit: z.number().int().min(1).max(500).default(100),
  before: z
    .string()
    .regex(/^\d{1,20}$/)
    .nullish(),
});
export type SearchRequest = z.infer<typeof SearchRequest>;

export const HistogramRequest = z.object({ signal: Signal, query, ...bounds, groupBy: field.nullish() });
export type HistogramRequest = z.infer<typeof HistogramRequest>;

export const FacetsRequest = z.object({ signal: Signal, ...bounds });

export const MetricType = z.enum(['gauge', 'sum', 'histogram']);
export const MetricAggregation = z.enum(['avg', 'min', 'max', 'sum', 'rate', 'p50', 'p95', 'p99']);
export const MetricQueryRequest = z.object({
  metric: z.string().min(1).max(300),
  type: MetricType,
  aggregation: MetricAggregation,
  ...bounds,
  service: z.string().max(300).nullish(),
  groupBy: field.nullish(),
});
export type MetricQueryRequest = z.infer<typeof MetricQueryRequest>;

export const PatternsRequest = z.object({
  signal: Signal,
  query,
  ...bounds,
  sample: z.number().int().min(100).max(20000).default(5000),
});

/** How bad an alert is: Landfall's own scale (sev1 is the worst). Landfall's remote default is sev3. */
export const Severity = z.enum(['sev1', 'sev2', 'sev3', 'sev4']);
export type Severity = z.infer<typeof Severity>;

/** `key: value` labels on an alert (team, tier, …): they ride in the webhook and become Landfall entity hints. */
export const Labels = z
  .record(
    z
      .string()
      .regex(/^[A-Za-z_][\w.\-/]*$/, 'a label name')
      .max(100),
    z.string().max(300),
  )
  .refine((labels) => Object.keys(labels).length <= 30, 'at most 30 labels');

export const AlertInput = z.object({
  name: z.string().min(1).max(200),
  signal: Signal,
  query,
  groupBy: field.nullish(),
  thresholdType: z.enum(['above', 'below']),
  threshold: z.number(),
  windowMinutes: z.number().int().min(1).max(1440),
  intervalMinutes: z.number().int().min(1).max(1440).default(1),
  enabled: z.boolean().default(true),
  severity: Severity.default('sev3'),
  labels: Labels.default({}),
  runbookUrl: z
    .url({ protocol: /^https?$/ })
    .max(2000)
    .nullish(),
});
export type AlertInput = z.infer<typeof AlertInput>;

export const WebhookEvent = z.enum(['alert.firing', 'alert.resolved', 'note.created']);
export type WebhookEvent = z.infer<typeof WebhookEvent>;

export const WebhookInput = z.object({
  url: z.url({ protocol: /^https?$/ }),
  events: z.array(WebhookEvent).min(1),
  alertId: z.string().nullish(),
  description: z.string().max(500).default(''),
});
export type WebhookInput = z.infer<typeof WebhookInput>;

export const NoteInput = z.object({
  title: z.string().min(1).max(300),
  body: z.string().min(1).max(50_000),
  service: z.string().max(300).nullish(),
  tags: z.array(z.string().max(100)).max(30).default([]),
  traceIds: z
    .array(z.string().regex(/^[0-9a-fA-F]{1,64}$/))
    .max(50)
    .default([]),
  alertEventId: z.string().nullish(),
  author: z.string().max(200).nullish(),
});
export type NoteInput = z.infer<typeof NoteInput>;

export const KnowledgeSearchRequest = z.object({
  query: z.string().min(1).max(2000),
  ...bounds,
  limit: z.number().int().min(1).max(25).default(8),
});

export const ApiScope = z.enum(['read', 'alerts:write', 'webhooks:write', 'notes:write', 'views:write', 'admin']);
export type ApiScope = z.infer<typeof ApiScope>;
export const ApiKeyInput = z.object({ name: z.string().min(1).max(200), scopes: z.array(ApiScope).min(1) });

// ---------------------------------------------------------------------------------------------------------------
// Views (MCP UI) and dashboards

const panelBase = {
  id: z.string().max(64).optional(),
  title: z.string().min(1).max(200),
  width: z.enum(['half', 'full']).default('half'),
};

export const Panel = z.discriminatedUnion('type', [
  z.object({
    ...panelBase,
    type: z.literal('timeseries'),
    signal: Signal.default('logs'),
    query,
    groupBy: field.nullish(),
  }),
  z.object({ ...panelBase, type: z.literal('bar'), signal: Signal.default('logs'), query, groupBy: field }),
  z.object({ ...panelBase, type: z.literal('stat'), signal: Signal.default('logs'), query }),
  z.object({ ...panelBase, type: z.literal('logs'), query, limit: z.number().int().min(1).max(200).default(25) }),
  z.object({ ...panelBase, type: z.literal('spans'), query, limit: z.number().int().min(1).max(200).default(25) }),
  z.object({ ...panelBase, type: z.literal('trace'), traceId: z.string().regex(/^[0-9a-fA-F]{1,64}$/) }),
  z.object({ ...panelBase, type: z.literal('services') }),
  z.object({ ...panelBase, type: z.literal('patterns'), signal: Signal.default('logs'), query }),
  z.object({
    ...panelBase,
    type: z.literal('metric'),
    metric: z.string().min(1).max(300),
    metricType: MetricType,
    aggregation: MetricAggregation,
    service: z.string().max(300).nullish(),
    groupBy: field.nullish(),
  }),
  z.object({ ...panelBase, type: z.literal('markdown'), text: z.string().max(20_000) }),
]);
export type Panel = z.infer<typeof Panel>;
export type PanelInput = z.input<typeof Panel>;

export const ViewSpec = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  range: RangeInput.default({ lastMinutes: 60 }),
  panels: z.array(Panel).min(1).max(12),
});
export type ViewSpec = z.infer<typeof ViewSpec>;
export type ViewSpecInput = z.input<typeof ViewSpec>;

export const CreateViewRequest = z.object({ spec: ViewSpec, pinned: z.boolean().default(false) });
export const UpdateViewRequest = z.object({
  spec: ViewSpec.optional(),
  title: z.string().min(1).max(200).optional(),
  pinned: z.boolean().optional(),
  version: z.number().int().optional(),
});
export const AddPanelRequest = z.object({ panel: Panel, position: z.number().int().min(0).optional() });

export interface View {
  id: string;
  title: string;
  spec: ViewSpec;
  pinned: boolean;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export const viewMarker = (id: string) => `[[clickland:view:${id}]]`;
export const VIEW_MARKER = /\[\[clickland:view:(vw_[A-Za-z0-9]+)\]\]/g;

// ---------------------------------------------------------------------------------------------------------------
// Responses

export interface LogRow {
  cursor: string;
  timestamp: string;
  service: string;
  severity: string;
  body: string;
  traceId: string;
  spanId: string;
  attributes: Record<string, string>;
  resource: Record<string, string>;
}

export interface SpanRow {
  cursor: string;
  timestamp: string;
  service: string;
  name: string;
  kind: string;
  durationMs: number;
  status: string;
  statusMessage: string;
  traceId: string;
  spanId: string;
  parentSpanId: string;
  attributes: Record<string, string>;
  resource: Record<string, string>;
}

export interface SearchResponse<R = LogRow | SpanRow> {
  rows: R[];
  nextCursor: string | null;
  stats: { rowsRead: number; bytesRead: number; elapsedMs: number };
}

export interface Series {
  key: string;
  points: [string, number][];
}

export interface SeriesResponse {
  bucketSeconds: number;
  series: Series[];
}

export interface TraceResponse {
  traceId: string;
  spans: (SpanRow & { depth: number; offsetMs: number })[];
  services: string[];
  durationMs: number;
  errorCount: number;
  startedAt: string;
}

export interface ServiceSummary {
  name: string;
  requests: number;
  errors: number;
  errorRate: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  logErrors: number;
}

export interface PatternResult {
  template: string;
  count: number;
  share: number;
  example: string;
  services: string[];
}

export interface Alert extends AlertInput {
  id: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  states: { groupKey: string; state: 'ok' | 'firing'; value: number; changedAt: string }[];
}

export interface AlertEvent {
  id: string;
  alertId: string;
  groupKey: string;
  state: 'ok' | 'firing';
  value: number;
  threshold: number;
  windowStart: string;
  windowEnd: string;
  createdAt: string;
}

export interface Note extends Omit<NoteInput, 'author'> {
  id: string;
  author: string;
  createdAt: string;
}

export interface KnowledgeResult {
  pageContent: string;
  score: number;
  metadata: {
    kind: 'note' | 'alert' | 'pattern' | 'service' | 'log';
    title: string;
    service?: string;
    url?: string;
    id?: string;
  };
}

export interface ApiErrorBody {
  error: {
    code:
      | 'bad_request'
      | 'unauthorized'
      | 'forbidden'
      | 'not_found'
      | 'conflict'
      | 'query_failed'
      | 'assistant_unavailable'
      | 'internal';
    message: string;
    details?: unknown;
  };
}
