/**
 * AI agents in telemetry (docs/agent-value.md): which spans are agents, model calls and tool calls, the queries that
 * fetch them, and the pure functions that turn spans into runs, per-agent figures and a run's decision path.
 *
 * Agents are found by the OpenTelemetry GenAI conventions (`gen_ai.operation.name` = invoke_agent / chat /
 * execute_tool), plus a short list of span names from emitters that don't follow them yet.
 */
import { type ParamValue } from './compile.js';
import { chTime, type Query, type TimeRange } from './queries.js';
import { buildTrace, isErrorStatus, type SpanLike, type TraceNode } from './trace.js';

// ---------------------------------------------------------------------------------------------------------------
// What a span is

export type StepKind = 'agent' | 'model' | 'tool' | 'other';
export type AgentFamily = 'landflow' | 'a2a' | 'landfall' | 'claude_code' | 'genai';

/** Spans that are an agent run although they carry no `gen_ai.*` attributes. The emitter stays unaware of Clickland. */
export const KNOWN_AGENT_SPANS: Record<string, { name: string; family: AgentFamily }> = {
  'diagnosis.run': { name: 'Landfall investigator', family: 'landfall' },
  'claude_code.interaction': { name: 'Claude Code', family: 'claude_code' },
};
/**
 * Landflow node types that are an agent: the AI Agent node and the agent-team node of a workflow. Their `node.execute`
 * span is the run (named by the node), since a workflow's agent node opens no `invoke_agent` span.
 */
export const AGENT_NODE_TYPES = ['core.aiAgent', 'core.runTeam'];
const AGENT_NODE_SPANS = AGENT_NODE_TYPES.map((type) => `node.execute ${type}`);
const isAgentNode = (span: { name: string; attributes: Record<string, string> }) =>
  AGENT_NODE_SPANS.includes(span.name) || AGENT_NODE_TYPES.includes(span.attributes['landflow.node.type'] ?? '');
const KNOWN_MODEL_SPANS = new Set(['claude_code.llm_request']);
const KNOWN_TOOL_SPANS = new Set(['claude_code.tool']);

const AGENT_OPERATIONS = new Set(['invoke_agent', 'invoke_workflow']);
const MODEL_OPERATIONS = new Set(['chat', 'text_completion', 'generate_content', 'embeddings']);

/** Attributes that hold prompts, answers and tool payloads. Only present when the emitter captures content. */
export const CONTENT_KEYS = [
  'gen_ai.input.messages',
  'gen_ai.output.messages',
  'gen_ai.system_instructions',
  'gen_ai.tool.definitions',
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result',
  'gen_ai.prompt',
  'gen_ai.completion',
];

/** Span attributes the agent queries keep besides `gen_ai.*` (never the content keys). */
const KEPT_PREFIXES = ['gen_ai.', 'landflow.agent.', 'landflow.ai.', 'landflow.a2a.', 'landflow.evaluation.'];
const KEPT_KEYS = [
  'error.type',
  'http.response.status_code',
  'landflow.node.source',
  'landflow.node.type',
  'landflow.node.name',
  'landflow.workflow.name',
  'landflow.teams.user',
  'user.id',
  'user.email',
  'enduser.id',
  'session.id',
  'incident.id',
  'a2a.task.state',
  'model',
  'tool_name',
];
const RESOURCE_KEYS = ['service.namespace', 'service.version', 'deployment.environment', 'deployment.environment.name'];

export interface AgentSpan extends SpanLike {
  traceId: string;
  name: string;
  statusMessage: string;
  attributes: Record<string, string>;
  resource: Record<string, string>;
  /** Span events whose name starts with `gen_ai.` (evaluation results). */
  events: { name: string; attributes: Record<string, string> }[];
  /** A hash of the tool call's arguments when content capture is on, so repeats can be told apart from retries. */
  argsHash: string;
}

export function stepKind(span: { name: string; attributes: Record<string, string> }): StepKind {
  const op = span.attributes['gen_ai.operation.name'];
  if (op && AGENT_OPERATIONS.has(op)) return 'agent';
  if (KNOWN_AGENT_SPANS[span.name] || isAgentNode(span)) return 'agent';
  if (op === 'execute_tool' || KNOWN_TOOL_SPANS.has(span.name) || span.attributes['landflow.node.source'] === 'ai_tool')
    return 'tool';
  if ((op && MODEL_OPERATIONS.has(op)) || KNOWN_MODEL_SPANS.has(span.name)) return 'model';
  return 'other';
}

/**
 * A tool span inside a tool call is that call's plumbing, not a second call (Landflow's `execute_tool` wraps the
 * `node.execute` that does the work, and both say they are a tool). The same holds for a model call inside a model
 * call (Landflow's `gen_ai.chat` wraps the SDK's own `anthropic.messages.create`).
 */
const nestedKind = (kind: StepKind, inside: StepKind | null): StepKind =>
  (kind === 'tool' || kind === 'model') && inside === kind ? 'other' : kind;
/** What a span's children are inside of: the nearest tool or model step, cleared by an agent. */
const insideOf = (kind: StepKind, inside: StepKind | null): StepKind | null =>
  kind === 'agent' ? null : kind === 'tool' || kind === 'model' ? kind : inside;

export function agentIdentity(span: { name: string; service: string; attributes: Record<string, string> }): {
  name: string;
  family: AgentFamily;
} {
  const known = KNOWN_AGENT_SPANS[span.name];
  if (known) return known;
  const a = span.attributes;
  if (isAgentNode(span))
    return { name: a['landflow.node.name'] || span.name.replace(/^node\.execute /, ''), family: 'landflow' };
  const op = a['gen_ai.operation.name'] ?? '';
  const fromSpanName = span.name.startsWith(`${op} `) ? span.name.slice(op.length + 1) : '';
  const name = a['gen_ai.agent.name'] || fromSpanName || a['gen_ai.agent.id'] || span.service;
  const family: AgentFamily =
    a['gen_ai.provider.name'] === 'a2a' || a['landflow.a2a.caller']
      ? 'a2a'
      : Object.keys(a).some((k) => k.startsWith('landflow.'))
        ? 'landflow'
        : 'genai';
  return { name, family };
}

/** An agent's stable key, and the path-safe id the API uses for it (`ag_` + base64url of the key). */
export const agentKey = (service: string, name: string) => `${service}/${name}`;
export function agentId(key: string): string {
  const bytes = new TextEncoder().encode(key);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return `ag_${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}
export function agentKeyFromId(id: string): string | null {
  if (!/^ag_[A-Za-z0-9_-]+$/.test(id)) return null;
  try {
    const binary = atob(id.slice(3).replace(/-/g, '+').replace(/_/g, '/'));
    const key = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
    return key.includes('/') ? key : null;
  } catch {
    return null;
  }
}

const num = (v: string | undefined) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : 0;
};

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const emptyUsage = (): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

export function addUsage(into: TokenUsage, from: TokenUsage): TokenUsage {
  into.inputTokens += from.inputTokens;
  into.outputTokens += from.outputTokens;
  into.cacheReadTokens += from.cacheReadTokens;
  into.cacheWriteTokens += from.cacheWriteTokens;
  return into;
}

/** A span's token counts by the GenAI conventions (both spellings of the cache attributes). */
export function spanUsage(a: Record<string, string>): TokenUsage {
  return {
    inputTokens: num(a['gen_ai.usage.input_tokens']),
    outputTokens: num(a['gen_ai.usage.output_tokens']),
    cacheReadTokens: num(a['gen_ai.usage.cache_read.input_tokens'] ?? a['gen_ai.usage.cache_read_input_tokens']),
    cacheWriteTokens: num(
      a['gen_ai.usage.cache_creation.input_tokens'] ?? a['gen_ai.usage.cache_creation_input_tokens'],
    ),
  };
}

export const spanModel = (a: Record<string, string>) => a['gen_ai.response.model'] || a['gen_ai.request.model'] || '';
/** What the emitter said the call cost, when it says. */
export const spanReportedCost = (a: Record<string, string>) =>
  num(a['landflow.ai.cost_usd'] ?? a['gen_ai.usage.cost'] ?? a['gen_ai.usage.cost_usd']);

export function isRateLimit(span: { status: string; statusMessage?: string; attributes: Record<string, string> }) {
  if (!isErrorStatus(span.status)) return false;
  const a = span.attributes;
  return (
    a['http.response.status_code'] === '429' ||
    /rate.?limit|too.?many.?requests|overloaded|\b429\b|\b529\b/i.test(
      `${a['error.type'] ?? ''} ${span.statusMessage ?? ''}`,
    )
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Queries

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** `demo-*` → a LIKE pattern; a plain name matches exactly. */
export function serviceFilter(service: string | null | undefined, params: Record<string, ParamValue>): string {
  if (!service) return '';
  params.service = service.split('*').map(likeEscape).join('%');
  return ' AND ServiceName LIKE {service:String}';
}

const timeParams = (range: TimeRange) => ({ from: chTime(range.from), to: chTime(range.to) });
const SPAN_TIME = 'Timestamp >= {from:DateTime64(9)} AND Timestamp < {to:DateTime64(9)}';

/** Which spans start an agent trace: anything with a GenAI operation, or a known agent span name. */
const AGENT_TRACE_FILTER = `(mapContains(SpanAttributes, 'gen_ai.operation.name') OR SpanName IN {known:Array(String)})`;

const keptAttributes = `mapFilter((k, v) -> (${KEPT_PREFIXES.map((p) => `startsWith(k, '${p}')`).join(' OR ')} OR has({kept:Array(String)}, k)) AND NOT has({content:Array(String)}, k), SpanAttributes)`;

const AGENT_SPAN_COLUMNS = `TraceId, SpanId, ParentSpanId, ServiceName, SpanName, StatusCode, StatusMessage,
  toString(toUnixTimestamp64Nano(Timestamp)) AS startNs, toString(Duration) AS durationNs,
  ${keptAttributes} AS attrs,
  mapFilter((k, v) -> has({rkept:Array(String)}, k), ResourceAttributes) AS res,
  arrayFilter(n -> startsWith(n, 'gen_ai.'), \`Events.Name\`) AS eventNames,
  arrayFilter((a, n) -> startsWith(n, 'gen_ai.'), \`Events.Attributes\`, \`Events.Name\`) AS eventAttrs,
  if(mapContains(SpanAttributes, 'gen_ai.tool.call.arguments'), toString(cityHash64(SpanAttributes['gen_ai.tool.call.arguments'])), '') AS argsHash`;

const agentSpanParams = (extraKeys: string[]) => ({
  known: [...Object.keys(KNOWN_AGENT_SPANS), ...AGENT_NODE_SPANS],
  kept: [...KEPT_KEYS, ...extraKeys],
  rkept: [...RESOURCE_KEYS, ...extraKeys],
  content: CONTENT_KEYS,
});

/**
 * Every span of every trace that holds an agent, with only the attributes the agent figures need. The whole trace
 * comes back (not just its GenAI spans) so a model call is credited to the agent it ran under, through whatever
 * spans sit between them.
 */
export function agentSpansQuery(
  range: TimeRange,
  options: { service?: string | null; extraKeys?: string[]; limit?: number } = {},
): Query {
  const params: Record<string, ParamValue> = {
    ...timeParams(range),
    ...agentSpanParams(options.extraKeys ?? []),
    limit: options.limit ?? 200_000,
  };
  const service = serviceFilter(options.service, params);
  return {
    sql: `SELECT ${AGENT_SPAN_COLUMNS}
FROM otel_traces
WHERE ${SPAN_TIME}${service}
  AND TraceId IN (
    SELECT DISTINCT TraceId FROM otel_traces
    WHERE ${SPAN_TIME}${service} AND ${AGENT_TRACE_FILTER}
  )
ORDER BY Timestamp DESC
LIMIT {limit:UInt32}`,
    params,
  };
}

/** One trace in the same slim shape (the run graph keeps content out of its nodes too). */
export function agentTraceQuery(traceId: string, extraKeys: string[] = []): Query {
  if (!/^[0-9a-fA-F]{1,64}$/.test(traceId)) throw new Error('A trace id is hexadecimal');
  return {
    sql: `SELECT ${AGENT_SPAN_COLUMNS}
FROM otel_traces
WHERE TraceId = {trace:String}
ORDER BY Timestamp
LIMIT 10000`,
    params: { ...agentSpanParams(extraKeys), trace: traceId.toLowerCase() },
  };
}

export interface RawAgentSpan {
  TraceId: string;
  SpanId: string;
  ParentSpanId: string;
  ServiceName: string;
  SpanName: string;
  StatusCode: string;
  StatusMessage: string;
  startNs: string;
  durationNs: string;
  attrs: Record<string, string>;
  res: Record<string, string>;
  eventNames: string[];
  eventAttrs: Record<string, string>[];
  argsHash: string;
}

export const toAgentSpan = (r: RawAgentSpan): AgentSpan => ({
  traceId: r.TraceId,
  spanId: r.SpanId,
  parentSpanId: r.ParentSpanId,
  service: r.ServiceName,
  name: r.SpanName,
  status: r.StatusCode,
  statusMessage: r.StatusMessage,
  startNs: BigInt(r.startNs),
  durationNs: BigInt(r.durationNs),
  attributes: r.attrs,
  resource: r.res,
  events: r.eventNames.map((name, i) => ({ name, attributes: r.eventAttrs[i] ?? {} })),
  argsHash: r.argsHash,
});

/**
 * A sum metric's total over a range, per group. Delta series add up; a cumulative series contributes its growth in the
 * range (its last value when it started inside the range). Group keys read the data point's attributes, then the
 * resource's.
 */
export function metricTotalsQuery(input: {
  range: TimeRange;
  /** Exact metric names, or one prefix ending in `*`. */
  metrics: string[];
  groupKeys?: string[];
  filter?: Record<string, string>;
  service?: string | null;
}): Query {
  const params: Record<string, ParamValue> = {
    from: chTime(input.range.from).slice(0, 19),
    to: chTime(input.range.to).slice(0, 19),
  };
  let names: string;
  if (input.metrics.length === 1 && input.metrics[0]!.endsWith('*')) {
    params.prefix = input.metrics[0]!.slice(0, -1);
    names = 'startsWith(MetricName, {prefix:String})';
  } else {
    params.metrics = input.metrics;
    names = 'MetricName IN {metrics:Array(String)}';
  }
  const groups = (input.groupKeys ?? []).map((key, i) => {
    params[`g${i}`] = key;
    return `if(mapContains(Attributes, {g${i}:String}), Attributes[{g${i}:String}], ResourceAttributes[{g${i}:String}])`;
  });
  const filters = Object.entries(input.filter ?? {}).map(([key, value], i) => {
    params[`fk${i}`] = key;
    params[`fv${i}`] = value;
    return ` AND if(mapContains(Attributes, {fk${i}:String}), Attributes[{fk${i}:String}], ResourceAttributes[{fk${i}:String}]) = {fv${i}:String}`;
  });
  const service = serviceFilter(input.service, params);
  return {
    sql: `SELECT service, metric, g, sum(v) AS v
FROM (
  SELECT ServiceName AS service, MetricName AS metric, [${groups.map((g) => `toString(${g})`).join(', ')}]::Array(String) AS g,
    if(AggregationTemporality = 2,
       if(StartTimeUnix >= {from:DateTime}, max(Value), max(Value) - min(Value)),
       sum(Value)) AS v
  FROM otel_metrics_sum
  WHERE TimeUnix >= {from:DateTime} AND TimeUnix < {to:DateTime} AND ${names}${service}${filters.join('')}
  GROUP BY service, metric, g, Attributes, StartTimeUnix, AggregationTemporality
)
GROUP BY service, metric, g
ORDER BY v DESC
LIMIT 20000`,
    params,
  };
}

const LOG_TIME = 'Timestamp >= {from:DateTime64(9)} AND Timestamp < {to:DateTime64(9)}';
const CLAUDE_CODE_LOGS = `(startsWith(EventName, 'claude_code.') OR startsWith(Body, 'claude_code.'))`;
const CLAUDE_CODE_EVENT = `replaceOne(if(startsWith(EventName, 'claude_code.'), EventName, Body), 'claude_code.', '')`;
const CLAUDE_CODE_USER = `coalesce(nullIf(LogAttributes['user.email'], ''), nullIf(LogAttributes['user.account_uuid'], ''), LogAttributes['user.id'])`;

/** Claude Code's events (it exports them as log records), counted by what the operations figures need. */
export function claudeCodeEventsQuery(range: TimeRange, service?: string | null): Query {
  const params: Record<string, ParamValue> = { ...timeParams(range) };
  return {
    sql: `SELECT ServiceName AS service, ${CLAUDE_CODE_EVENT} AS event,
  LogAttributes['model'] AS model, LogAttributes['tool_name'] AS tool, LogAttributes['success'] AS success,
  LogAttributes['decision'] AS decision, LogAttributes['source'] AS source,
  LogAttributes['permission_mode'] AS mode, LogAttributes['status_code'] AS status,
  count() AS c, countIf(toUInt32OrZero(LogAttributes['attempt']) > 1) AS retries
FROM otel_logs
WHERE ${LOG_TIME} AND ${CLAUDE_CODE_LOGS}${serviceFilter(service, params)}
GROUP BY service, event, model, tool, success, decision, source, mode, status
LIMIT 20000`,
    params,
  };
}

/** Claude Code's people, sessions, prompts and model-call latency per service. */
export function claudeCodeTotalsQuery(range: TimeRange, service?: string | null): Query {
  const params: Record<string, ParamValue> = { ...timeParams(range) };
  return {
    sql: `SELECT ServiceName AS service,
  uniqExactIf(${CLAUDE_CODE_USER}, ${CLAUDE_CODE_USER} != '') AS users,
  uniqExactIf(LogAttributes['session.id'], LogAttributes['session.id'] != '') AS sessions,
  countIf(${CLAUDE_CODE_EVENT} = 'user_prompt') AS prompts,
  quantilesIf(0.5, 0.95)(toFloat64OrZero(LogAttributes['duration_ms']), ${CLAUDE_CODE_EVENT} = 'api_request') AS q,
  toString(toUnixTimestamp64Milli(min(Timestamp))) AS firstMs, toString(toUnixTimestamp64Milli(max(Timestamp))) AS lastMs
FROM otel_logs
WHERE ${LOG_TIME} AND ${CLAUDE_CODE_LOGS}${serviceFilter(service, params)}
GROUP BY service`,
    params,
  };
}

/** Evaluation results sent as log records (`gen_ai.evaluation.result`), newest first. */
export function evaluationLogsQuery(range: TimeRange, service?: string | null, limit = 20_000): Query {
  const params: Record<string, ParamValue> = { ...timeParams(range), limit };
  return {
    sql: `SELECT TraceId, SpanId, ServiceName AS service,
  mapFilter((k, v) -> startsWith(k, 'gen_ai.'), LogAttributes) AS attrs
FROM otel_logs
WHERE ${LOG_TIME} AND (EventName = 'gen_ai.evaluation.result' OR LogAttributes['event.name'] = 'gen_ai.evaluation.result')${serviceFilter(service, params)}
ORDER BY Timestamp DESC
LIMIT {limit:UInt32}`,
    params,
  };
}

/** The newest spans that carry captured content, each value cut to `maxChars`, for the safety scan. */
export function agentContentQuery(
  range: TimeRange,
  options: { service?: string | null; limit?: number; maxChars?: number } = {},
): Query {
  const params: Record<string, ParamValue> = {
    ...timeParams(range),
    content: CONTENT_KEYS,
    limit: options.limit ?? 500,
    max: options.maxChars ?? 20_000,
  };
  return {
    sql: `SELECT TraceId, SpanId, ServiceName AS service, SpanName AS name,
  toString(toUnixTimestamp64Milli(Timestamp)) AS atMs, SpanAttributes['gen_ai.agent.name'] AS agent,
  mapApply((k, v) -> (k, substring(v, 1, {max:UInt32})), mapFilter((k, v) -> has({content:Array(String)}, k), SpanAttributes)) AS content
FROM otel_traces
WHERE ${SPAN_TIME}${serviceFilter(options.service, params)} AND hasAny(mapKeys(SpanAttributes), {content:Array(String)})
ORDER BY Timestamp DESC
LIMIT {limit:UInt32}`,
    params,
  };
}

/** Claude Code prompts, present only when the person turned `OTEL_LOG_USER_PROMPTS` on. */
export function claudeCodePromptsQuery(
  range: TimeRange,
  options: { service?: string | null; limit?: number; maxChars?: number } = {},
): Query {
  const params: Record<string, ParamValue> = {
    ...timeParams(range),
    limit: options.limit ?? 200,
    max: options.maxChars ?? 20_000,
  };
  return {
    sql: `SELECT TraceId, SpanId, ServiceName AS service, 'claude_code.user_prompt' AS name,
  toString(toUnixTimestamp64Milli(Timestamp)) AS atMs, 'Claude Code' AS agent,
  map('prompt', substring(LogAttributes['prompt'], 1, {max:UInt32})) AS content
FROM otel_logs
WHERE ${LOG_TIME} AND ${CLAUDE_CODE_LOGS} AND ${CLAUDE_CODE_EVENT} = 'user_prompt'
  AND LogAttributes['prompt'] NOT IN ('', '<REDACTED>')${serviceFilter(options.service, params)}
ORDER BY Timestamp DESC
LIMIT {limit:UInt32}`,
    params,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Spans → runs

export interface ModelUse extends TokenUsage {
  model: string;
  calls: number;
  /** What the emitter reported for these calls, in USD (0 when it reports none). */
  reportedCostUsd: number;
}

export interface ToolCall {
  spanId: string;
  name: string;
  kind: string;
  error: boolean;
  argsHash: string;
}

export interface Loop {
  tool: string;
  count: number;
  spanIds: string[];
}

export interface EvaluationResult {
  name: string;
  score: number | null;
  label: string;
}

export interface AgentRun {
  traceId: string;
  spanId: string;
  /** The run this one was called from (a sub-agent), or null. */
  parentRunSpanId: string | null;
  key: string;
  service: string;
  name: string;
  family: AgentFamily;
  /** Where the run came from, when the emitter says (Landflow: test, schedule, telegram, slack, workflow, agent). */
  source: string;
  startedAt: string;
  durationMs: number;
  error: boolean;
  errorType: string;
  endReason: string;
  conversationId: string;
  user: string;
  team: string;
  models: ModelUse[];
  toolCalls: ToolCall[];
  modelCalls: number;
  /** Model and tool steps that ended in an error. */
  stepErrors: number;
  rateLimits: number;
  retries: number;
  loops: Loop[];
  evaluations: EvaluationResult[];
  /** Values of the correlation fields outcomes join on (e.g. `incident.id`), seen on any span of the run. */
  correlate: Record<string, string>;
}

export interface AttributionOptions {
  /** Consecutive calls of one tool (with the same arguments, when captured) that count as a loop. */
  loopThreshold?: number;
  /** The attribute that names a team; falls back to `service.namespace`. */
  teamAttribute?: string;
  correlateFields?: string[];
}

export const DEFAULT_LOOP_THRESHOLD = 5;

/** Runs of one tool with one set of arguments, back to back, at least `threshold` long. */
export function detectLoops(calls: ToolCall[], threshold = DEFAULT_LOOP_THRESHOLD): Loop[] {
  const loops: Loop[] = [];
  let start = 0;
  for (let i = 1; i <= calls.length; i++) {
    const same =
      i < calls.length && calls[i]!.name === calls[start]!.name && calls[i]!.argsHash === calls[start]!.argsHash;
    if (same) continue;
    if (i - start >= threshold)
      loops.push({ tool: calls[start]!.name, count: i - start, spanIds: calls.slice(start, i).map((c) => c.spanId) });
    start = i;
  }
  return loops;
}

export const evaluationsOf = (events: { name: string; attributes: Record<string, string> }[]): EvaluationResult[] =>
  events.filter((e) => e.name === 'gen_ai.evaluation.result').map((e) => evaluationFromAttributes(e.attributes));

export function evaluationFromAttributes(a: Record<string, string>): EvaluationResult {
  const raw = a['gen_ai.evaluation.score.value'];
  const score = raw !== undefined && raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : null;
  return { name: a['gen_ai.evaluation.name'] || 'evaluation', score, label: a['gen_ai.evaluation.score.label'] ?? '' };
}

const toolName = (s: AgentSpan) =>
  s.attributes['gen_ai.tool.name'] ||
  s.attributes['tool_name'] ||
  s.attributes['landflow.node.name'] ||
  s.name.replace(/^(execute_tool|node\.execute) /, '');

interface OpenRun {
  run: AgentRun;
  usageByModel: Map<string, ModelUse>;
  own: { model: string; usage: TokenUsage; cost: number };
  /** The last model or tool step by label, to spot a retry after an error. */
  lastStep: Map<string, boolean>;
}

/**
 * Turns the spans of agent traces into runs. Every model call, tool call and evaluation is credited to the innermost
 * agent span above it; a sub-agent's work stays with the sub-agent.
 */
export function attributeAgentRuns(
  spans: AgentSpan[],
  options: AttributionOptions = {},
): { runs: AgentRun[]; spanToRun: Map<string, AgentRun> } {
  const threshold = options.loopThreshold ?? DEFAULT_LOOP_THRESHOLD;
  const teamKey = options.teamAttribute || 'team.id';
  const correlate = options.correlateFields ?? [];
  const byTrace = new Map<string, AgentSpan[]>();
  for (const span of spans) {
    const list = byTrace.get(span.traceId) ?? [];
    list.push(span);
    byTrace.set(span.traceId, list);
  }
  const runs: AgentRun[] = [];
  const spanToRun = new Map<string, AgentRun>();

  for (const traceSpans of byTrace.values()) {
    const tree = buildTrace(traceSpans);
    const seen = new Set<string>();
    const walk = (
      node: TraceNode<AgentSpan>,
      open: OpenRun | null,
      inside: StepKind | null,
      outer: ModelUse | null,
    ) => {
      const span = node.span;
      if (seen.has(span.spanId)) return;
      seen.add(span.spanId);
      const raw = stepKind(span);
      const kind = nestedKind(raw, inside);
      let model: ModelUse | null = outer;
      const a = span.attributes;
      let current = open;
      if (kind === 'agent') {
        const identity = agentIdentity(span);
        const run: AgentRun = {
          traceId: span.traceId,
          spanId: span.spanId,
          parentRunSpanId: open?.run.spanId ?? null,
          key: agentKey(span.service, identity.name),
          service: span.service,
          name: identity.name,
          family: identity.family,
          source: a['landflow.agent.source'] ?? (isAgentNode(span) ? 'workflow' : ''),
          startedAt: new Date(Number(span.startNs / 1_000_000n)).toISOString(),
          durationMs: Number(span.durationNs) / 1e6,
          error: isErrorStatus(span.status),
          errorType: a['error.type'] ?? '',
          endReason: a['landflow.agent.end_reason'] ?? a['gen_ai.response.finish_reasons'] ?? '',
          conversationId: a['gen_ai.conversation.id'] ?? a['session.id'] ?? '',
          user: a['user.email'] || a['landflow.teams.user'] || a['user.id'] || a['enduser.id'] || '',
          team: a[teamKey] || span.resource[teamKey] || span.resource['service.namespace'] || '',
          models: [],
          toolCalls: [],
          modelCalls: 0,
          stepErrors: 0,
          rateLimits: 0,
          retries: 0,
          loops: [],
          evaluations: [],
          correlate: {},
        };
        current = {
          run,
          usageByModel: new Map(),
          own: { model: spanModel(a), usage: spanUsage(a), cost: spanReportedCost(a) },
          lastStep: new Map(),
        };
        if (isRateLimit(span)) run.rateLimits++;
        runs.push(run);
        // A step called by the parent run is still the parent's step (a sub-agent is the parent's tool).
      } else if (current && (kind === 'model' || kind === 'tool')) {
        const failed = isErrorStatus(span.status);
        const label = kind === 'model' ? `model:${spanModel(a)}` : `tool:${toolName(span)}:${span.argsHash}`;
        if (current.lastStep.get(label) === true) current.run.retries++;
        current.lastStep.set(label, failed);
        if (failed) current.run.stepErrors++;
        if (isRateLimit(span)) current.run.rateLimits++;
        if (kind === 'model') {
          current.run.modelCalls++;
          const name = spanModel(a) || 'unknown';
          const use = current.usageByModel.get(name) ?? { model: name, calls: 0, reportedCostUsd: 0, ...emptyUsage() };
          use.calls++;
          addUsage(use, spanUsage(a));
          use.reportedCostUsd += spanReportedCost(a);
          current.usageByModel.set(name, use);
          // Tokens found only on the SDK's span inside this one are still this call's tokens.
          const usage = spanUsage(a);
          model = usage.inputTokens + usage.outputTokens > 0 ? null : use;
        } else {
          current.run.toolCalls.push({
            spanId: span.spanId,
            name: toolName(span),
            kind: a['landflow.agent.tool.kind'] ?? a['gen_ai.tool.type'] ?? '',
            error: failed,
            argsHash: span.argsHash,
          });
        }
      }
      if (current && raw === 'model' && kind === 'other' && outer) {
        addUsage(outer, spanUsage(a));
        outer.reportedCostUsd += spanReportedCost(a);
        model = null;
      }
      if (current) {
        spanToRun.set(span.spanId, current.run);
        current.run.evaluations.push(...evaluationsOf(span.events));
        for (const field of correlate) {
          const value = a[field] || span.resource[field];
          if (value && !current.run.correlate[field]) current.run.correlate[field] = value;
        }
        if (!current.run.user)
          current.run.user = a['user.email'] || a['landflow.teams.user'] || a['user.id'] || a['enduser.id'] || '';
      }
      // A tool span that is not an agent keeps the run open for what it calls; a model call under a tool still
      // belongs to the run.
      for (const child of node.children)
        walk(child, current, insideOf(kind, inside), kind === 'agent' || kind === 'tool' ? null : model);
      if (kind === 'agent' && current) {
        const { run, usageByModel, own } = current;
        const counted = [...usageByModel.values()];
        const hasTokens = counted.some((m) => m.inputTokens + m.outputTokens > 0);
        // An agent span that carries the usage itself (a remote agent's reply) is used when its model calls carry none.
        if (!hasTokens && own.usage.inputTokens + own.usage.outputTokens > 0)
          run.models = [
            {
              model: own.model || 'unknown',
              calls: Math.max(run.modelCalls, 1),
              reportedCostUsd: own.cost,
              ...own.usage,
            },
          ];
        else run.models = counted;
        run.loops = detectLoops(run.toolCalls, threshold);
      }
    };
    for (const root of tree.roots) walk(root, null, null, null);
  }
  runs.sort((x, y) => (x.startedAt < y.startedAt ? 1 : -1));
  return { runs, spanToRun };
}

// ---------------------------------------------------------------------------------------------------------------
// Prices and cost

export interface ModelPrice {
  /** A model id, or a prefix ending in `*` (`claude-opus-5-5*`). The longest match wins. */
  model: string;
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
}

/** `global.anthropic.claude-opus-5-5[1m]` → `claude-opus-5-5`: cloud prefixes and context suffixes don't change the price. */
export function normalizeModel(model: string): string {
  const lower = model
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, '');
  const at = lower.indexOf('claude-');
  return at > 0 ? lower.slice(at) : lower;
}

export function matchPrice<P extends ModelPrice>(model: string, prices: P[]): P | null {
  const id = normalizeModel(model);
  let best: P | null = null;
  let bestLength = -1;
  for (const price of prices) {
    const pattern = price.model.toLowerCase();
    const prefix = pattern.endsWith('*');
    const stem = prefix ? pattern.slice(0, -1) : pattern;
    if (prefix ? !id.startsWith(stem) : id !== stem) continue;
    // An exact id beats any prefix; among prefixes the longest wins.
    const length = prefix ? stem.length : Number.MAX_SAFE_INTEGER;
    if (length > bestLength) {
      best = price;
      bestLength = length;
    }
  }
  return best;
}

const usd = (n: number) => `$${n.toFixed(n !== 0 && Math.abs(n) < 1 ? 4 : 2)}`;
const count = (n: number) => (Number.isInteger(n) ? n.toLocaleString('en-US') : n.toFixed(1));

/**
 * Tokens × the price table. `gen_ai.usage.input_tokens` includes cached tokens by the conventions, so cache reads and
 * writes are taken out of the input before it is priced (never below zero).
 */
export function priceUsage(usage: TokenUsage, price: ModelPrice): { usd: number; how: string } {
  const plainInput = Math.max(0, usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens);
  const parts: [number, number, string][] = [
    [plainInput, price.inputPerMTok, 'input'],
    [usage.outputTokens, price.outputPerMTok, 'output'],
    [usage.cacheReadTokens, price.cacheReadPerMTok, 'cache read'],
    [usage.cacheWriteTokens, price.cacheWritePerMTok, 'cache write'],
  ];
  const total = parts.reduce((sum, [tokens, rate]) => sum + (tokens * rate) / 1e6, 0);
  const how = parts
    .filter(([tokens]) => tokens > 0)
    .map(([tokens, rate, label]) => `${count(tokens)} ${label} × $${rate}/MTok`)
    .join(' + ');
  return { usd: total, how: `${how || 'no tokens'} = ${usd(total)}` };
}

export type CostSource = 'priced' | 'reported' | 'unpriced' | 'none';

/** A model's cost: the price table when it has the model, else what the emitter reported, else nothing (and it says so). */
export function costOf(use: ModelUse, prices: ModelPrice[]): { usd: number; source: CostSource; how: string } {
  const price = matchPrice(use.model, prices);
  const tokens = use.inputTokens + use.outputTokens + use.cacheReadTokens + use.cacheWriteTokens;
  if (price && tokens > 0) {
    const priced = priceUsage(use, price);
    return { usd: priced.usd, source: 'priced', how: `${use.model}: ${priced.how} (price ${price.model})` };
  }
  if (use.reportedCostUsd > 0)
    return {
      usd: use.reportedCostUsd,
      source: 'reported',
      how: `${use.model}: ${usd(use.reportedCostUsd)} reported by the emitter`,
    };
  if (tokens > 0)
    return { usd: 0, source: 'unpriced', how: `${use.model}: ${count(tokens)} tokens, no price for this model` };
  return { usd: 0, source: 'none', how: `${use.model}: no tokens reported` };
}

// ---------------------------------------------------------------------------------------------------------------
// Runs → per-agent figures

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (position - low);
}

const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;

export function summarizeAgents(runs: AgentRun[], prices: ModelPrice[]) {
  const byKey = new Map<string, AgentRun[]>();
  for (const run of runs) {
    const list = byKey.get(run.key) ?? [];
    list.push(run);
    byKey.set(run.key, list);
  }
  return [...byKey.entries()].map(([key, list]) => {
    const first = list[0]!;
    const models = new Map<string, ModelUse>();
    const tools = new Map<string, { name: string; kind: string; calls: number; errors: number }>();
    const evaluations = new Map<
      string,
      { name: string; count: number; scored: number; sum: number; labels: Record<string, number> }
    >();
    for (const run of list) {
      for (const use of run.models) {
        const into = models.get(use.model) ?? { model: use.model, calls: 0, reportedCostUsd: 0, ...emptyUsage() };
        into.calls += use.calls;
        into.reportedCostUsd += use.reportedCostUsd;
        addUsage(into, use);
        models.set(use.model, into);
      }
      for (const call of run.toolCalls) {
        const into = tools.get(call.name) ?? { name: call.name, kind: call.kind, calls: 0, errors: 0 };
        into.calls++;
        if (call.error) into.errors++;
        tools.set(call.name, into);
      }
      for (const result of run.evaluations) {
        const into = evaluations.get(result.name) ?? { name: result.name, count: 0, scored: 0, sum: 0, labels: {} };
        into.count++;
        if (result.score !== null) {
          into.scored++;
          into.sum += result.score;
        }
        if (result.label) into.labels[result.label] = (into.labels[result.label] ?? 0) + 1;
        evaluations.set(result.name, into);
      }
    }
    const modelRows = [...models.values()]
      .map((use) => {
        const cost = costOf(use, prices);
        return { ...use, costUsd: round(cost.usd, 6), costSource: cost.source, how: cost.how };
      })
      .sort((x, y) => y.costUsd - x.costUsd || y.calls - x.calls);
    const durations = list.map((r) => r.durationMs).sort((x, y) => x - y);
    const failed = list.filter((r) => r.error).length;
    const tokens = modelRows.reduce((sum, m) => addUsage(sum, m), emptyUsage());
    const costUsd = modelRows.reduce((sum, m) => sum + m.costUsd, 0);
    const distinct = (values: string[]) => [...new Set(values.filter(Boolean))];
    return {
      id: agentId(key),
      key,
      service: first.service,
      name: first.name,
      family: first.family,
      sources: distinct(list.map((r) => r.source)),
      teams: distinct(list.map((r) => r.team)),
      runs: list.length,
      subAgentRuns: list.filter((r) => r.parentRunSpanId).length,
      failedRuns: failed,
      successRate: list.length ? round(1 - failed / list.length, 4) : null,
      p50Ms: round(quantile(durations, 0.5)),
      p95Ms: round(quantile(durations, 0.95)),
      modelCalls: list.reduce((sum, r) => sum + r.modelCalls, 0),
      toolCalls: list.reduce((sum, r) => sum + r.toolCalls.length, 0),
      stepErrors: list.reduce((sum, r) => sum + r.stepErrors, 0),
      rateLimits: list.reduce((sum, r) => sum + r.rateLimits, 0),
      retries: list.reduce((sum, r) => sum + r.retries, 0),
      loops: list.reduce((sum, r) => sum + r.loops.length, 0),
      ...tokens,
      costUsd: round(costUsd, 6),
      costHow: modelRows.length ? modelRows.map((m) => m.how).join('; ') : 'no model calls with token counts',
      unpricedModels: modelRows.filter((m) => m.costSource === 'unpriced').map((m) => m.model),
      models: modelRows,
      tools: [...tools.values()].sort((x, y) => y.calls - x.calls),
      evaluations: [...evaluations.values()].map((e) => ({
        name: e.name,
        count: e.count,
        averageScore: e.scored ? round(e.sum / e.scored, 4) : null,
        labels: e.labels,
      })),
      endReasons: list.reduce<Record<string, number>>((into, r) => {
        if (r.endReason) into[r.endReason] = (into[r.endReason] ?? 0) + 1;
        return into;
      }, {}),
      users: distinct(list.map((r) => r.user)).length,
      sessions: distinct(list.map((r) => r.conversationId)).length,
      firstSeen: list[list.length - 1]!.startedAt,
      lastSeen: first.startedAt,
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// A run's decision path

export type GraphNodeKind = 'agent' | 'subagent' | 'model' | 'tool' | 'span';

/**
 * The decision path of a trace: agents, their model calls, tool calls and sub-agents as nodes, with an edge from each
 * step to the step that called it. Spans in between (HTTP, RPC, database) are folded into the step above them, except
 * the root and any span that failed, so a failure is never hidden.
 */
export function buildRunGraph(spans: AgentSpan[], prices: ModelPrice[] = [], loopThreshold = DEFAULT_LOOP_THRESHOLD) {
  const tree = buildTrace(spans);
  const { runs, spanToRun } = attributeAgentRuns(spans, { loopThreshold });
  const looping = new Set(runs.flatMap((r) => r.loops.flatMap((l) => l.spanIds)));
  type Node = {
    id: string;
    parentId: string | null;
    kind: GraphNodeKind;
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
    agent: string;
    retry: boolean;
    loop: boolean;
    hiddenSpans: number;
  };
  const nodes: Node[] = [];
  const lastStep = new Map<string, boolean>();

  const walk = (
    node: TraceNode<AgentSpan>,
    parent: Node | null,
    underAgent: boolean,
    inside: StepKind | null,
    depth: number,
  ) => {
    const span = node.span;
    const kind = nestedKind(stepKind(span), inside);
    const failed = isErrorStatus(span.status);
    const keep = kind !== 'other' || parent === null || failed;
    let self = parent;
    let nowUnderAgent = underAgent;
    if (keep) {
      const a = span.attributes;
      const run = spanToRun.get(span.spanId);
      const model = kind === 'model' || kind === 'agent' ? spanModel(a) : '';
      const usage = kind === 'model' ? spanUsage(a) : emptyUsage();
      const cost =
        kind === 'model'
          ? costOf({ model: model || 'unknown', calls: 1, reportedCostUsd: spanReportedCost(a), ...usage }, prices)
          : { usd: 0, how: '' };
      const tool = kind === 'tool' ? toolName(span) : '';
      const label =
        kind === 'agent'
          ? agentIdentity(span).name
          : kind === 'model'
            ? model || span.name
            : kind === 'tool'
              ? tool
              : span.name;
      // The same step again right after it failed, under the same parent, is a retry.
      const stepKey = `${parent?.id ?? ''}|${kind}|${label}|${span.argsHash}`;
      const retry = kind !== 'other' && kind !== 'agent' && lastStep.get(stepKey) === true;
      if (kind !== 'other') lastStep.set(stepKey, failed);
      self = {
        id: span.spanId,
        parentId: parent?.id ?? null,
        kind: kind === 'agent' ? (underAgent ? 'subagent' : 'agent') : kind === 'other' ? 'span' : kind,
        label,
        service: span.service,
        spanName: span.name,
        depth,
        offsetMs: round(Number(span.startNs - tree.startNs) / 1e6),
        durationMs: round(Number(span.durationNs) / 1e6),
        status: failed ? 'error' : 'ok',
        errorType: a['error.type'] ?? '',
        statusMessage: span.statusMessage.slice(0, 500),
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUsd: round(cost.usd, 6),
        costHow: cost.how,
        tool,
        toolKind: kind === 'tool' ? (a['landflow.agent.tool.kind'] ?? a['gen_ai.tool.type'] ?? '') : '',
        agent: run?.name ?? '',
        retry,
        loop: looping.has(span.spanId),
        hiddenSpans: 0,
      };
      nodes.push(self);
      if (kind === 'agent') nowUnderAgent = true;
    } else if (parent) parent.hiddenSpans++;
    for (const child of node.children)
      walk(child, self, nowUnderAgent, insideOf(kind, inside), keep ? depth + 1 : depth);
  };
  for (const root of tree.roots) walk(root, null, false, null, 0);

  const steps = nodes.filter((n) => n.kind !== 'span');
  return {
    traceId: spans[0]?.traceId ?? '',
    startedAt: new Date(Number(tree.startNs / 1_000_000n)).toISOString(),
    durationMs: round(Number(tree.durationNs) / 1e6),
    nodes,
    edges: nodes.filter((n) => n.parentId).map((n) => ({ from: n.parentId!, to: n.id })),
    summary: {
      agents: [...new Set(runs.map((r) => r.name))],
      agentRuns: runs.length,
      modelCalls: steps.filter((n) => n.kind === 'model').length,
      toolCalls: steps.filter((n) => n.kind === 'tool').length,
      inputTokens: steps.reduce((sum, n) => sum + n.inputTokens, 0),
      outputTokens: steps.reduce((sum, n) => sum + n.outputTokens, 0),
      costUsd: round(
        steps.reduce((sum, n) => sum + n.costUsd, 0),
        6,
      ),
      errors: nodes.filter((n) => n.status === 'error').length,
      retries: nodes.filter((n) => n.retry).length,
      spans: spans.length,
      services: tree.services,
    },
    loops: runs.flatMap((r) => r.loops.map((l) => ({ agent: r.name, ...l }))),
  };
}
