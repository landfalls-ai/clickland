/**
 * Landfall's generic interfaces, as Clickland speaks them. Landfall stays agnostic of Clickland (the user's decision,
 * docs/research/land-family-integrations.md §5): these mirror Landfall's Source Protocol v1 and its
 * `SourceTriggerPayload` (Landfall `libs/signals/src/protocol/schema.ts`, rendered as
 * `libs/signals/protocol/source-protocol.openapi.yaml`). The API's tests validate Clickland's answers against that
 * OpenAPI file when a Landfall checkout is next to this repository.
 */
import { z } from 'zod';

export const SOURCE_PROTOCOL_VERSION = '1';

export const SourceKind = z.enum(['metrics', 'logs', 'changes', 'chat']);
export type SourceKind = z.infer<typeof SourceKind>;

const TenantRef = z.object({ ref: z.string().min(1) });
const WindowBounds = z.object({ fromMs: z.number().int().nonnegative(), toMs: z.number().int().nonnegative() });

export const InvokeRequest = z.object({
  operation: z.string().min(1),
  params: z.record(z.string(), z.unknown()),
  tenant: TenantRef,
});
export type InvokeRequest = z.infer<typeof InvokeRequest>;

export const MetricsListRequest = z.object({
  namespace: z.string().optional(),
  match: z.string().optional(),
  tenant: TenantRef,
});
export type MetricsListRequest = z.infer<typeof MetricsListRequest>;

export const MetricsRangeRequest = z.object({
  expr: z.string(),
  selector: z.record(z.string(), z.unknown()).optional(),
  window: WindowBounds,
  step: z.number().positive().optional(),
  tenant: TenantRef,
});
export type MetricsRangeRequest = z.infer<typeof MetricsRangeRequest>;

export const LogsStreamsRequest = z.object({
  prefix: z.string().optional(),
  label: z.string().optional(),
  tenant: TenantRef,
});
export type LogsStreamsRequest = z.infer<typeof LogsStreamsRequest>;

export const LogsRangeRequest = z.object({
  query: z.string(),
  window: WindowBounds,
  limit: z.number().int().positive().optional(),
  tenant: TenantRef,
});
export type LogsRangeRequest = z.infer<typeof LogsRangeRequest>;

/** How an operation names its time-range params (Landfall fills them when it draws a widget). */
export interface WindowSpec {
  start: string;
  end: string;
  step?: string;
  format: 'date' | 'iso' | 'epoch-s' | 'epoch-ms' | 'epoch-ns' | 'grafana';
  stepFormat?: 'seconds' | 'duration';
  minStepSeconds?: number;
}

export interface OperationDescriptor {
  operation: string;
  description: string;
  params: Record<string, string>;
  kind: SourceKind;
  canonical?: 'list' | 'range' | 'streams';
  window?: WindowSpec;
}

export interface CapabilitiesResponse {
  protocolVersion: string;
  source: string;
  kinds: SourceKind[];
  operations: OperationDescriptor[];
}

export interface HealthResponse {
  ok: boolean;
  detail?: string;
}

/** One named series with real timestamps, sorted by `t`: what a Landfall chart widget draws. */
export interface RawSeries {
  label: string;
  unit?: string;
  points: { t: string; v: number }[];
}

/** One log line with its timestamp: what a Landfall log widget draws. */
export interface LogEntry {
  t: string;
  line: string;
  labels?: Record<string, string>;
  stream?: string;
}

/** The envelope every read returns: the verbatim payload (`raw`) and, optionally, its shaped form. */
export interface RawResult {
  source: string;
  operation: string;
  params: Record<string, unknown>;
  fetchedAt: string;
  raw: unknown;
  partial?: boolean;
  error?: string;
  series?: RawSeries[];
  entries?: LogEntry[];
}

/** What Clickland posts to Landfall's `POST /triggers` to open a room, or to record a recovery. */
export const SourceTriggerPayload = z.object({
  landfallSource: z.literal('remote'),
  connectionId: z.string().min(1),
  title: z.string().min(1),
  severity: z.enum(['sev1', 'sev2', 'sev3', 'sev4']),
  occurredAt: z.iso.datetime({ offset: true }).optional(),
  entityHints: z.array(z.string()).optional(),
  dedupKey: z.string().min(1).optional(),
  summary: z.string().optional(),
  url: z.url().optional(),
  kind: z.enum(['trigger', 'recovery']).optional(),
});
export type SourceTriggerPayload = z.infer<typeof SourceTriggerPayload>;

/** Landfall's answer to a trigger: whether a room opened, the repeat attached, or the recovery was recorded. */
export interface TriggerResult {
  outcome: 'opened' | 'attached' | 'recorded' | 'ignored' | 'suppressed';
  reason?: string;
  incidentId: string;
  workspaceUrl: string;
  proposedSeverity?: string;
}
