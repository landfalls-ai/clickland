/**
 * AI agents and their business value (docs/agent-value.md): the wire contracts of /api/agents/* and /api/value/*.
 * Kept in its own file so the base contracts change in one line.
 */
import { z } from 'zod';

const isoTime = z.iso.datetime({ offset: true });
const fieldName = z
  .string()
  .regex(/^[A-Za-z_@][\w.\-@/]*$/, 'a field name')
  .max(200);
/** A service name, or a prefix ending in `*` (`demo-*`). */
const servicePattern = z
  .string()
  .regex(/^[\w.\-/*]+$/, 'a service name, optionally ending in *')
  .max(300);
const agentIdPattern = z.string().regex(/^ag_[A-Za-z0-9_-]+$/, 'an agent id (ag_…)');
const traceIdPattern = z.string().regex(/^[0-9a-fA-F]{1,64}$/, 'a hex trace id');

export const AgentFamily = z.enum(['landflow', 'a2a', 'landfall', 'claude_code', 'genai']);
export type AgentFamily = z.infer<typeof AgentFamily>;

/** The period of an agent question. Defaults to the last 7 days. */
export const AgentsQuery = z.object({
  from: isoTime.optional(),
  to: isoTime.optional(),
  service: servicePattern.optional(),
  family: AgentFamily.optional(),
});
export type AgentsQuery = z.infer<typeof AgentsQuery>;

export const AgentParams = z.object({ id: agentIdPattern });
export const RunGraphParams = z.object({ traceId: traceIdPattern });

export const ValueReportQuery = z.object({
  from: isoTime.optional(),
  to: isoTime.optional(),
  service: servicePattern.optional(),
  agent: agentIdPattern.optional(),
  team: z.string().max(200).optional(),
});
export type ValueReportQuery = z.infer<typeof ValueReportQuery>;

export const SafetyQuery = z.object({
  from: isoTime.optional(),
  to: isoTime.optional(),
  service: servicePattern.optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
});

// ---------------------------------------------------------------------------------------------------------------
// Value settings, prices and outcome definitions (Postgres)

export const ValueSettingsInput = z.object({
  hourlyRate: z.number().positive().max(100_000).optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, 'a three-letter currency code')
    .optional(),
  /** The span, log or metric attribute that names a team. Falls back to `service.namespace`. */
  teamAttribute: fieldName.optional(),
  /** Back-to-back calls of one tool that count as a loop. */
  loopThreshold: z.number().int().min(2).max(100).optional(),
});
export type ValueSettingsInput = z.infer<typeof ValueSettingsInput>;

export interface ValueSettings {
  hourlyRate: number;
  currency: string;
  teamAttribute: string;
  loopThreshold: number;
  updatedBy: string;
  updatedAt: string;
}

const perMTok = z.number().min(0).max(100_000);
export const ModelPriceInput = z.object({
  /** A model id (`claude-opus-5-5`) or a prefix ending in `*`. The longest match prices a model. */
  model: z
    .string()
    .regex(/^[\w.\-:/]+\*?$/, 'a model id, optionally ending in *')
    .max(200),
  provider: z.string().max(100).default(''),
  inputPerMTok: perMTok,
  outputPerMTok: perMTok,
  cacheReadPerMTok: perMTok.default(0),
  cacheWritePerMTok: perMTok.default(0),
  /** Where the price comes from, and the day it was read. */
  source: z.string().max(500).default(''),
  asOf: z.iso.date().nullish(),
  note: z.string().max(1000).default(''),
});
export type ModelPriceInput = z.infer<typeof ModelPriceInput>;

export interface ModelPrice extends z.output<typeof ModelPriceInput> {
  id: string;
  /** True for a row the seed wrote and nobody changed since. */
  seeded: boolean;
  /** Always true: every price can be changed. A changed seed row is never overwritten by the seed again. */
  editable: true;
  updatedBy: string;
  updatedAt: string;
}

export const OutcomeAttribution = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('trace') }),
  z.object({ mode: z.literal('correlate'), field: fieldName }),
  z.object({ mode: z.literal('field'), field: fieldName }),
  z.object({
    mode: z.literal('agent'),
    agent: z
      .string()
      .regex(/^[^/]+\/.+$/, 'an agent key: service/name')
      .max(500),
  }),
]);
export type OutcomeAttribution = z.infer<typeof OutcomeAttribution>;

export const OutcomeInput = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).default(''),
    /** `traces` and `logs` count the rows a search matches; `metric` sums a counter. */
    signal: z.enum(['traces', 'logs', 'metric']),
    /** A Clickland search, or (for a metric) the metric's name. */
    query: z.string().min(1).max(4000),
    /** For a metric: only data points with these attribute values. */
    metricFilter: z.record(z.string().max(200), z.string().max(500)).default({}),
    attribution: OutcomeAttribution,
    valueKind: z.enum(['minutes', 'amount']),
    minutesSaved: z.number().min(0).max(100_000).default(0),
    amount: z.number().min(0).max(1_000_000_000).default(0),
    /** Why this value: shown next to every number that uses it. */
    rationale: z.string().max(2000).default(''),
    enabled: z.boolean().default(true),
  })
  .refine((o) => (o.valueKind === 'minutes' ? o.minutesSaved > 0 : o.amount > 0), {
    message: 'Set minutesSaved for a minutes outcome, or amount for an amount outcome',
    path: ['valueKind'],
  })
  .refine((o) => o.signal !== 'metric' || o.attribution.mode === 'agent' || o.attribution.mode === 'field', {
    message: 'A metric outcome is credited to one agent, or to the agent a label names',
    path: ['attribution', 'mode'],
  });
export type OutcomeInput = z.infer<typeof OutcomeInput>;

export interface OutcomeDefinition extends z.output<typeof OutcomeInput> {
  id: string;
  seeded: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export const OutcomePreviewRequest = z.object({
  outcome: OutcomeInput,
  from: isoTime.optional(),
  to: isoTime.optional(),
  service: servicePattern.optional(),
});

// ---------------------------------------------------------------------------------------------------------------
// Responses

export interface AgentModelUse {
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  /** `priced`: tokens × the price table. `reported`: the emitter's own figure. `unpriced`: tokens but no price. */
  costSource: 'priced' | 'reported' | 'unpriced' | 'none';
  reportedCostUsd: number;
  /** The arithmetic behind `costUsd`. */
  how: string;
}

export interface AgentToolUse {
  name: string;
  kind: string;
  calls: number;
  errors: number;
}

export interface AgentEvaluation {
  name: string;
  count: number;
  averageScore: number | null;
  labels: Record<string, number>;
}

/** What the telemetry says an agent may do: its tools, how each call was allowed, and who had to approve. */
export interface AgentPermissions {
  tools: { name: string; kind: string; allowed: number; denied: number; sources: Record<string, number> }[];
  /** Permission modes seen (Claude Code: default, acceptEdits, plan, bypassPermissions…). */
  modes: string[];
  /** Tools a person was asked about at least once. */
  needsApproval: string[];
  note: string;
}

export interface AgentSummary {
  id: string;
  /** `service/name`. */
  key: string;
  service: string;
  name: string;
  family: AgentFamily;
  sources: string[];
  teams: string[];
  /** What one run is: an agent invocation, or (Claude Code) a prompt or a session. */
  runUnit: 'run' | 'prompt' | 'session';
  runs: number;
  subAgentRuns: number;
  failedRuns: number;
  successRate: number | null;
  /** Of a run, or (Claude Code) of a model call: see `latencyOf`. */
  p50Ms: number;
  p95Ms: number;
  latencyOf: 'run' | 'model call';
  modelCalls: number;
  toolCalls: number;
  stepErrors: number;
  rateLimits: number;
  retries: number;
  loops: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  costHow: string;
  unpricedModels: string[];
  models: AgentModelUse[];
  tools: AgentToolUse[];
  evaluations: AgentEvaluation[];
  feedback: { up: number; down: number };
  approvals: { approved: number; denied: number };
  permissions: AgentPermissions;
  endReasons: Record<string, number>;
  users: number;
  sessions: number;
  /** Extra counters the emitter sends (Claude Code: commits, pullRequests, linesAdded, linesRemoved, activeSeconds). */
  activity: Record<string, number>;
  firstSeen: string;
  lastSeen: string;
}

export interface AgentsResponse {
  from: string;
  to: string;
  agents: AgentSummary[];
  /** True when the span limit cut the period short: the figures cover the newest spans only. */
  truncated: boolean;
  spansRead: number;
}

export interface AgentRunSummary {
  traceId: string;
  spanId: string;
  parentRunSpanId: string | null;
  startedAt: string;
  durationMs: number;
  status: 'ok' | 'error';
  errorType: string;
  endReason: string;
  source: string;
  user: string;
  team: string;
  conversationId: string;
  modelCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  retries: number;
  rateLimits: number;
  loops: { tool: string; count: number }[];
}

export interface AgentDetailResponse {
  from: string;
  to: string;
  agent: AgentSummary;
  recentRuns: AgentRunSummary[];
  value: ValueAgentRow | null;
}

export type RunGraphNodeKind = 'agent' | 'subagent' | 'model' | 'tool' | 'span';

export interface RunGraphNode {
  /** The span id. */
  id: string;
  parentId: string | null;
  kind: RunGraphNodeKind;
  label: string;
  service: string;
  spanName: string;
  depth: number;
  offsetMs: number;
  durationMs: number;
  status: 'ok' | 'error';
  errorType: string;
  statusMessage: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  costHow: string;
  tool: string;
  toolKind: string;
  /** The agent this step ran under. */
  agent: string;
  /** The same step again right after it failed. */
  retry: boolean;
  /** Part of a detected loop. */
  loop: boolean;
  /** Spans folded into this node (HTTP, RPC, database). */
  hiddenSpans: number;
}

export interface RunGraphResponse {
  traceId: string;
  startedAt: string;
  durationMs: number;
  nodes: RunGraphNode[];
  edges: { from: string; to: string }[];
  summary: {
    agents: string[];
    agentRuns: number;
    modelCalls: number;
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    errors: number;
    retries: number;
    spans: number;
    services: string[];
  };
  loops: { agent: string; tool: string; count: number; spanIds: string[] }[];
}

export interface ValueFigures {
  value: number;
  cost: number;
  net: number;
  /** (value − cost) ÷ cost; null when no cost was recorded. */
  roi: number | null;
  outcomes: number;
  costPerOutcome: number | null;
  how: { net: string; roi: string; costPerOutcome: string };
}

export interface ValueAgentRow extends ValueFigures {
  key: string;
  name: string;
  service: string;
  family: string;
  /** False when outcomes name an agent that has no runs in the period. */
  seen: boolean;
  costHow: string;
  lines: { outcomeId: string; name: string; count: number; unitValue: number; value: number; how: string }[];
  adoption?: { users: number; sessions: number; runs: number; runUnit: string };
  quality?: {
    successRate: number | null;
    evaluations: AgentEvaluation[];
    feedback: { up: number; down: number };
    approvals: { approved: number; denied: number };
  };
}

export interface ValueReportResponse {
  from: string;
  to: string;
  currency: string;
  hourlyRate: number;
  /** The model in one line, so a reader never has to guess what a number means. */
  model: string;
  totals: ValueFigures;
  agents: ValueAgentRow[];
  teams: (ValueFigures & { team: string })[];
  outcomes: {
    id: string;
    name: string;
    signal: 'traces' | 'logs' | 'metric';
    search: string;
    attribution: OutcomeAttribution;
    unitValue: number;
    unitHow: string;
    credited: number;
    unattributed: number;
    value: number;
    unattributedValue: number;
    how: string;
  }[];
  unattributed: { outcomes: number; value: number; note: string };
  truncated: boolean;
}

export interface SafetyFlag {
  kind: 'pii' | 'secret' | 'prompt_injection';
  detector: string;
  /** Masked: the matched value never leaves ClickHouse whole. */
  sample: string;
  count: number;
  /** The attribute it was found in (`gen_ai.input.messages`…). */
  attribute: string;
  traceId: string;
  spanId: string;
  service: string;
  agent: string;
  at: string;
}

export interface SafetyResponse {
  from: string;
  to: string;
  /** False when no span in the period carries prompts or answers: there was nothing to scan. */
  contentCaptured: boolean;
  scanned: number;
  flags: SafetyFlag[];
  totals: Record<'pii' | 'secret' | 'prompt_injection', number>;
  detectors: { kind: string; detector: string }[];
  note: string;
}

export interface AgentAlertTemplate {
  key: string;
  kind: 'cost' | 'errors' | 'quality';
  title: string;
  description: string;
  /** A ready body for POST /api/alerts. */
  alert: {
    name: string;
    signal: 'logs' | 'traces';
    query: string;
    groupBy: string | null;
    thresholdType: 'above' | 'below';
    threshold: number;
    windowMinutes: number;
    intervalMinutes: number;
    enabled: boolean;
  };
}
