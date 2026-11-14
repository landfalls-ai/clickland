/**
 * AI agents and what they are worth (docs/agent-value.md). Agents are read from telemetry on every call: GenAI spans
 * (Landflow, kagent over A2A, anything on the OpenTelemetry GenAI conventions), Landfall's investigator span, and
 * Claude Code's metrics and events. Nothing here is stored; only the settings, prices and outcome definitions are
 * (value.ts).
 */
import type { ClickHouseClient } from '@clickhouse/client';
import type {
  AgentAlertTemplate,
  AgentDetailResponse,
  AgentRunSummary,
  AgentsResponse,
  AgentSummary,
  ModelPrice,
  OutcomeInput,
  RunGraphResponse,
  SafetyFlag,
  SafetyResponse,
  ValueReportResponse,
  ValueSettings,
} from '@clickland/contracts';
import {
  agentContentQuery,
  agentKeyFromId,
  agentId,
  type AgentRun,
  agentSpansQuery,
  agentTraceQuery,
  attributeAgentRuns,
  buildRunGraph,
  buildValueReport,
  claudeCodeEventsQuery,
  claudeCodePromptsQuery,
  claudeCodeTotalsQuery,
  costOf,
  creditOutcome,
  evaluationFromAttributes,
  evaluationLogsQuery,
  metricTotalsQuery,
  type ModelUse,
  type OutcomeDefinitionLike,
  outcomeRowsQuery,
  outcomeUnitValue,
  type RawAgentSpan,
  runCost,
  SAFETY_DETECTORS,
  scanContent,
  summarizeAgents,
  type TimeRange,
  toAgentSpan,
  toOutcomeRows,
} from '@clickland/query';
import { runQuery } from './clients.js';
import { notFound } from './errors.js';
import { resolveRange, wrapSearchErrors } from './telemetry.js';
import { validateOutcome, type ValueStore } from './value.js';

const WEEK_MINUTES = 7 * 24 * 60;
/** Spans read per question. Past it the newest spans win and the answer says it was cut. */
const SPAN_LIMIT = 200_000;

export const VALUE_MODEL =
  'An outcome is a search over telemetry. Its value is minutes saved × the hourly rate ÷ 60, or a direct amount. ' +
  'Value is the outcomes credited to an agent × that value; net = value − cost; ROI = (value − cost) ÷ cost; ' +
  'cost per outcome = cost ÷ outcomes. This is Clickland’s own model: Datadog publishes no formula.';

type MetricRow = { service: string; metric: string; g: string[]; v: number };
type ClaudeEventRow = {
  service: string;
  event: string;
  model: string;
  tool: string;
  success: string;
  decision: string;
  source: string;
  mode: string;
  status: string;
  c: number;
  retries: number;
};
type ClaudeTotalsRow = {
  service: string;
  users: number;
  sessions: number;
  prompts: number;
  q: number[];
  firstMs: string;
  lastMs: string;
};
type EvaluationLogRow = { TraceId: string; SpanId: string; service: string; attrs: Record<string, string> };
type ContentRow = {
  TraceId: string;
  SpanId: string;
  service: string;
  name: string;
  atMs: string;
  agent: string;
  content: Record<string, string>;
};

const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;
const CLAUDE_CODE = 'Claude Code';

/** A thumbs-up or thumbs-down sent as an evaluation named like "feedback". */
const isFeedback = (name: string) => /feedback|thumb/i.test(name);
const isThumbsUp = (label: string, score: number | null) =>
  label ? /up|positive|good|like|yes|helpful/i.test(label) && !/down|un|not/i.test(label) : (score ?? 0) >= 0.5;

interface Fleet {
  range: TimeRange;
  settings: ValueSettings;
  prices: ModelPrice[];
  runs: AgentRun[];
  agents: AgentSummary[];
  /** Cost per team: the runs' teams, and Claude Code's by its team attribute. */
  teamCosts: Map<string, number>;
  truncated: boolean;
  spansRead: number;
}

export class Agents {
  constructor(
    private readonly ch: ClickHouseClient,
    private readonly store: ValueStore,
  ) {}

  /** Everything the agent questions share: the spans of the period turned into runs and per-agent figures. */
  private async fleet(
    input: { from?: string | null; to?: string | null; service?: string | null },
    correlateFields: string[] = [],
  ): Promise<Fleet> {
    const range = resolveRange(input, WEEK_MINUTES);
    const service = input.service ?? null;
    const [settings, prices] = await Promise.all([this.store.settings(), this.store.prices()]);
    const team = settings.teamAttribute;
    const [spans, events, totals, metrics, approvals, evaluationLogs] = await Promise.all([
      runQuery<RawAgentSpan>(
        this.ch,
        agentSpansQuery(range, { service, extraKeys: [team, ...correlateFields], limit: SPAN_LIMIT }),
      ),
      runQuery<ClaudeEventRow>(this.ch, claudeCodeEventsQuery(range, service)),
      runQuery<ClaudeTotalsRow>(this.ch, claudeCodeTotalsQuery(range, service)),
      runQuery<MetricRow>(
        this.ch,
        metricTotalsQuery({
          range,
          metrics: ['claude_code.*'],
          groupKeys: ['model', 'type', 'decision', team],
          service,
        }),
      ),
      runQuery<MetricRow>(
        this.ch,
        metricTotalsQuery({
          range,
          metrics: ['landflow.agent.approvals'],
          groupKeys: ['gen_ai.agent.name', 'gen_ai.tool.name', 'landflow.agent.approval.decision'],
          service,
        }),
      ),
      runQuery<EvaluationLogRow>(this.ch, evaluationLogsQuery(range, service)),
    ]);

    const { runs, spanToRun } = attributeAgentRuns(spans.rows.map(toAgentSpan), {
      loopThreshold: settings.loopThreshold,
      teamAttribute: team,
      correlateFields,
    });
    // Evaluations sent as log records join their run by span, else by trace, else by the agent's name.
    const firstInTrace = new Map<string, AgentRun>();
    for (const run of runs) if (!run.parentRunSpanId) firstInTrace.set(run.traceId, run);
    for (const log of evaluationLogs.rows) {
      const run =
        spanToRun.get(log.SpanId) ??
        firstInTrace.get(log.TraceId) ??
        runs.find((r) => r.name === log.attrs['gen_ai.agent.name']);
      run?.evaluations.push(evaluationFromAttributes(log.attrs));
    }

    const agents: AgentSummary[] = summarizeAgents(runs, prices).map((summary) => {
      const feedback = { up: 0, down: 0 };
      for (const evaluation of summary.evaluations.filter((e) => isFeedback(e.name))) {
        const labels = Object.entries(evaluation.labels);
        if (labels.length === 0) feedback[isThumbsUp('', evaluation.averageScore) ? 'up' : 'down'] += evaluation.count;
        for (const [label, n] of labels) feedback[isThumbsUp(label, null) ? 'up' : 'down'] += n;
      }
      const decided = approvals.rows.filter((r) => r.g[0] === summary.name);
      const sum = (decision: string) =>
        decided.filter((r) => r.g[2] === decision).reduce((total, r) => total + Number(r.v), 0);
      const needsApproval = [...new Set(decided.map((r) => r.g[1]!).filter(Boolean))];
      return {
        ...summary,
        runUnit: 'run',
        latencyOf: 'run',
        evaluations: summary.evaluations.filter((e) => !isFeedback(e.name)),
        feedback,
        approvals: { approved: sum('approved'), denied: sum('denied') },
        permissions: {
          tools: summary.tools.map((t) => {
            const rows = decided.filter((r) => r.g[1] === t.name);
            const denied = rows.filter((r) => r.g[2] === 'denied').reduce((total, r) => total + Number(r.v), 0);
            return { name: t.name, kind: t.kind, allowed: t.calls, denied, sources: {} };
          }),
          modes: [],
          needsApproval,
          note: 'The tools this agent called in the period. Tools it may use but did not call are not in telemetry.',
        },
        activity: {},
      };
    });

    const teamCosts = new Map<string, number>();
    for (const run of runs) teamCosts.set(run.team, (teamCosts.get(run.team) ?? 0) + runCost(run, prices));

    for (const claude of claudeCodeAgents(metrics.rows, events.rows, totals.rows, prices, range)) {
      for (const [teamName, cost] of claude.teamCosts) teamCosts.set(teamName, (teamCosts.get(teamName) ?? 0) + cost);
      const traced = agents.findIndex((a) => a.key === claude.summary.key);
      if (traced === -1) agents.push(claude.summary);
      else {
        // Claude Code with tracing on: its interaction spans give runs and latency, its metrics give tokens and cost.
        // The spans' own cost is taken back out, so the tokens are not paid for twice.
        const spansView = agents[traced]!;
        for (const run of runs.filter((r) => r.key === spansView.key))
          teamCosts.set(run.team, (teamCosts.get(run.team) ?? 0) - runCost(run, prices));
        agents[traced] = {
          ...claude.summary,
          runUnit: 'run',
          latencyOf: 'run',
          runs: spansView.runs,
          failedRuns: spansView.failedRuns,
          successRate: spansView.successRate,
          p50Ms: spansView.p50Ms,
          p95Ms: spansView.p95Ms,
          loops: spansView.loops,
        };
      }
    }
    agents.sort((x, y) => y.costUsd - x.costUsd || y.runs - x.runs);
    return {
      range,
      settings,
      prices,
      runs,
      agents,
      teamCosts,
      truncated: spans.rows.length >= SPAN_LIMIT,
      spansRead: spans.rows.length,
    };
  }

  async list(input: { from?: string; to?: string; service?: string; family?: string }): Promise<AgentsResponse> {
    const fleet = await this.fleet(input);
    return {
      from: fleet.range.from.toISOString(),
      to: fleet.range.to.toISOString(),
      agents: input.family ? fleet.agents.filter((a) => a.family === input.family) : fleet.agents,
      truncated: fleet.truncated,
      spansRead: fleet.spansRead,
    };
  }

  /** An agent by its id (`ag_…`) or, for people and models typing one, its name or key. */
  private find(fleet: Fleet, idOrName: string): AgentSummary {
    const key = agentKeyFromId(idOrName);
    const wanted = idOrName.toLowerCase();
    const agent =
      fleet.agents.find((a) => a.key === key) ??
      fleet.agents.find((a) => a.key.toLowerCase() === wanted || a.name.toLowerCase() === wanted);
    if (!agent) throw notFound('Agent');
    return agent;
  }

  async detail(id: string, input: { from?: string; to?: string; service?: string }): Promise<AgentDetailResponse> {
    const definitions = await this.store.outcomes({ enabled: true });
    const fleet = await this.fleet(input, correlateFieldsOf(definitions));
    const agent = this.find(fleet, id);
    const report = await this.report(fleet, definitions, { service: input.service, agent: agent.key });
    return {
      from: fleet.range.from.toISOString(),
      to: fleet.range.to.toISOString(),
      agent,
      recentRuns: fleet.runs
        .filter((r) => r.key === agent.key)
        .slice(0, 50)
        .map((run) => toRunSummary(run, fleet.prices)),
      value: report.agents.find((a) => a.key === agent.key) ?? null,
    };
  }

  async graph(traceId: string): Promise<RunGraphResponse> {
    const [settings, prices, spans] = await Promise.all([
      this.store.settings(),
      this.store.prices(),
      runQuery<RawAgentSpan>(this.ch, agentTraceQuery(traceId)),
    ]);
    if (spans.rows.length === 0) throw notFound('Trace');
    return buildRunGraph(spans.rows.map(toAgentSpan), prices, settings.loopThreshold);
  }

  async value(input: {
    from?: string;
    to?: string;
    service?: string;
    /** An agent id, key or name. */
    agent?: string;
    team?: string;
  }): Promise<ValueReportResponse> {
    const definitions = await this.store.outcomes({ enabled: true });
    const fleet = await this.fleet(input, correlateFieldsOf(definitions));
    const agent = input.agent ? this.find(fleet, input.agent).key : null;
    return this.report(fleet, definitions, { service: input.service, agent, team: input.team });
  }

  private async report(
    fleet: Fleet,
    definitions: (OutcomeDefinitionLike & { enabled?: boolean })[],
    filter: { service?: string | null; agent?: string | null; team?: string | null },
  ): Promise<ValueReportResponse> {
    const outcomes = await Promise.all(
      definitions.map(async (definition) => ({
        definition,
        credits: await this.credit(fleet, definition, filter.service),
        search: searchOf(definition),
      })),
    );
    // An unassigned team is shown as "unassigned" and selected by that word.
    const team = filter.team == null ? null : filter.team === 'unassigned' ? '' : filter.team;
    const report = buildValueReport({
      settings: fleet.settings,
      outcomes,
      agents: fleet.agents.map((a) => ({
        key: a.key,
        name: a.name,
        service: a.service,
        family: a.family,
        cost: a.costUsd,
        costHow: a.costHow,
      })),
      teamCosts: [...fleet.teamCosts].map(([name, cost]) => ({ team: name, cost })),
      agent: filter.agent,
      team,
    });
    const byKey = new Map(fleet.agents.map((a) => [a.key, a]));
    return {
      from: fleet.range.from.toISOString(),
      to: fleet.range.to.toISOString(),
      model: VALUE_MODEL,
      ...report,
      agents: report.agents.map((row) => {
        const summary = byKey.get(row.key);
        if (!summary) return row;
        return {
          ...row,
          adoption: { users: summary.users, sessions: summary.sessions, runs: summary.runs, runUnit: summary.runUnit },
          quality: {
            successRate: summary.successRate,
            evaluations: summary.evaluations,
            feedback: summary.feedback,
            approvals: summary.approvals,
          },
        };
      }),
      truncated: fleet.truncated,
    };
  }

  private async credit(fleet: Fleet, definition: OutcomeDefinitionLike, service?: string | null) {
    const query = wrapSearchErrors(() =>
      outcomeRowsQuery(definition, fleet.range, fleet.settings.teamAttribute, service),
    );
    const { rows } = await runQuery<Record<string, unknown>>(this.ch, query);
    return creditOutcome(definition, toOutcomeRows(definition, rows), fleet.runs, fleet.agents);
  }

  /** Counts an outcome that is not saved yet, so its author sees what it would be worth before keeping it. */
  async preview(input: { outcome: OutcomeInput; from?: string; to?: string; service?: string }) {
    validateOutcome(input.outcome);
    const definition = { ...input.outcome, id: 'preview' };
    const fleet = await this.fleet(input, correlateFieldsOf([definition]));
    const credits = await this.credit(fleet, definition, input.service);
    const unit = outcomeUnitValue(definition, fleet.settings);
    const credited = credits.filter((c) => c.agent !== null);
    const total = credited.reduce((sum, c) => sum + c.count, 0);
    const byAgent = new Map<string, number>();
    for (const credit of credited) byAgent.set(credit.agent!, (byAgent.get(credit.agent!) ?? 0) + credit.count);
    return {
      from: fleet.range.from.toISOString(),
      to: fleet.range.to.toISOString(),
      search: searchOf(definition),
      matched: round(credits.reduce((sum, c) => sum + c.count, 0)),
      credited: round(total),
      unattributed: round(credits.filter((c) => c.agent === null).reduce((sum, c) => sum + c.count, 0)),
      unitValue: round(unit.value, 4),
      unitHow: unit.how,
      value: round(total * unit.value),
      agents: [...byAgent].map(([key, count]) => ({ key, count: round(count), value: round(count * unit.value) })),
    };
  }

  /** Personal data, secrets and prompt-injection phrases in captured prompts, answers and tool payloads. */
  async safety(input: { from?: string; to?: string; service?: string; limit: number }): Promise<SafetyResponse> {
    const range = resolveRange(input, WEEK_MINUTES);
    const options = { service: input.service, limit: input.limit };
    const [spans, prompts] = await Promise.all([
      runQuery<ContentRow>(this.ch, agentContentQuery(range, options)),
      runQuery<ContentRow>(this.ch, claudeCodePromptsQuery(range, options)),
    ]);
    const rows = [...spans.rows, ...prompts.rows];
    const flags: SafetyFlag[] = [];
    const totals = { pii: 0, secret: 0, prompt_injection: 0 };
    for (const row of rows) {
      for (const [attribute, text] of Object.entries(row.content)) {
        for (const finding of scanContent(text)) {
          totals[finding.kind] += finding.count;
          flags.push({
            ...finding,
            attribute,
            traceId: row.TraceId,
            spanId: row.SpanId,
            service: row.service,
            agent: row.agent,
            at: new Date(Number(row.atMs)).toISOString(),
          });
        }
      }
    }
    return {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      contentCaptured: rows.length > 0,
      scanned: rows.length,
      flags: flags.slice(0, 500),
      totals,
      detectors: SAFETY_DETECTORS,
      note:
        rows.length > 0
          ? 'Pattern checks over the newest spans that carry content. They miss what only a model would catch.'
          : 'No span in this period carries prompts or answers, so there was nothing to scan. Content capture is opt-in at the emitter.',
    };
  }

  alertTemplates(): AgentAlertTemplate[] {
    return ALERT_TEMPLATES;
  }

  alertTemplate(key: string): AgentAlertTemplate {
    const template = ALERT_TEMPLATES.find((t) => t.key === key);
    if (!template) throw notFound('Alert template');
    return template;
  }
}

const correlateFieldsOf = (definitions: Pick<OutcomeDefinitionLike, 'attribution'>[]) => [
  ...new Set(definitions.flatMap((d) => (d.attribution.mode === 'correlate' ? [d.attribution.field] : []))),
];

const searchOf = (d: Pick<OutcomeDefinitionLike, 'signal' | 'query' | 'metricFilter'>) => {
  if (d.signal !== 'metric') return `${d.signal}: ${d.query}`;
  const filter = Object.entries(d.metricFilter)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  return `sum of metric ${d.query}${filter ? ` where ${filter}` : ''}`;
};

function toRunSummary(run: AgentRun, prices: ModelPrice[]): AgentRunSummary {
  return {
    traceId: run.traceId,
    spanId: run.spanId,
    parentRunSpanId: run.parentRunSpanId,
    startedAt: run.startedAt,
    durationMs: round(run.durationMs),
    status: run.error ? 'error' : 'ok',
    errorType: run.errorType,
    endReason: run.endReason,
    source: run.source,
    user: run.user,
    team: run.team,
    conversationId: run.conversationId,
    modelCalls: run.modelCalls,
    toolCalls: run.toolCalls.length,
    inputTokens: run.models.reduce((sum, m) => sum + m.inputTokens, 0),
    outputTokens: run.models.reduce((sum, m) => sum + m.outputTokens, 0),
    costUsd: round(runCost(run, prices), 6),
    retries: run.retries,
    rateLimits: run.rateLimits,
    loops: run.loops.map((l) => ({ tool: l.tool, count: l.count })),
  };
}

/**
 * Claude Code as an agent, one per service name it reports under. Its metrics give tokens, cost and activity; its
 * events (log records) give prompts, tool calls, permission decisions and API errors.
 */
export function claudeCodeAgents(
  metrics: MetricRow[],
  events: ClaudeEventRow[],
  totals: ClaudeTotalsRow[],
  prices: ModelPrice[],
  range: TimeRange,
): { summary: AgentSummary; teamCosts: Map<string, number> }[] {
  const services = new Set([...metrics, ...events, ...totals].map((r) => r.service));
  return [...services].map((service) => {
    // metric rows: g = [model, type, decision, team]
    const uses = new Map<string, Map<string, ModelUse>>(); // team → model → use
    const use = (team: string, model: string) => {
      const models = uses.get(team) ?? new Map<string, ModelUse>();
      uses.set(team, models);
      const row = models.get(model) ?? {
        model,
        calls: 0,
        reportedCostUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      models.set(model, row);
      return row;
    };
    const activity: Record<string, number> = {};
    const bump = (name: string, by: number) => (activity[name] = round((activity[name] ?? 0) + by, 4));
    for (const row of metrics.filter((r) => r.service === service)) {
      const [model = '', type = '', decision = '', team = ''] = row.g;
      const value = Number(row.v);
      switch (row.metric) {
        case 'claude_code.token.usage': {
          const into = use(team, model || 'unknown');
          // Claude Code reports uncached input; the GenAI conventions (and priceUsage) count cached tokens as input too.
          if (type === 'input') into.inputTokens += value;
          else if (type === 'output') into.outputTokens += value;
          else if (type === 'cacheRead') {
            into.cacheReadTokens += value;
            into.inputTokens += value;
          } else if (type === 'cacheCreation') {
            into.cacheWriteTokens += value;
            into.inputTokens += value;
          }
          break;
        }
        case 'claude_code.cost.usage':
          use(team, model || 'unknown').reportedCostUsd += value;
          break;
        case 'claude_code.commit.count':
          bump('commits', value);
          break;
        case 'claude_code.pull_request.count':
          bump('pullRequests', value);
          break;
        case 'claude_code.lines_of_code.count':
          bump(type === 'removed' ? 'linesRemoved' : 'linesAdded', value);
          break;
        case 'claude_code.active_time.total':
          bump('activeSeconds', value);
          break;
        case 'claude_code.session.count':
          bump('sessionsStarted', value);
          break;
        case 'claude_code.code_edit_tool.decision':
          bump(decision === 'reject' ? 'editsRejected' : 'editsAccepted', value);
          break;
      }
    }

    const mine = events.filter((r) => r.service === service);
    const of = (event: string) => mine.filter((r) => r.event === event);
    const total = (rows: ClaudeEventRow[]) => rows.reduce((sum, r) => sum + Number(r.c), 0);
    for (const row of of('api_request'))
      for (const models of uses.values()) {
        const into = models.get(row.model);
        if (into) {
          into.calls += Number(row.c);
          break;
        }
      }
    const tools = new Map<string, { name: string; kind: string; calls: number; errors: number }>();
    for (const row of of('tool_result')) {
      const tool = tools.get(row.tool) ?? { name: row.tool, kind: '', calls: 0, errors: 0 };
      tool.calls += Number(row.c);
      if (row.success === 'false') tool.errors += Number(row.c);
      tools.set(row.tool, tool);
    }
    const permissions = new Map<
      string,
      { name: string; kind: string; allowed: number; denied: number; sources: Record<string, number> }
    >();
    const approvals = { approved: 0, denied: 0 };
    for (const row of of('tool_decision')) {
      const tool = permissions.get(row.tool) ?? { name: row.tool, kind: '', allowed: 0, denied: 0, sources: {} };
      const n = Number(row.c);
      if (row.decision === 'reject') {
        tool.denied += n;
        approvals.denied += n;
      } else {
        tool.allowed += n;
        if (row.source.startsWith('user_')) approvals.approved += n;
      }
      if (row.source) tool.sources[row.source] = (tool.sources[row.source] ?? 0) + n;
      permissions.set(row.tool, tool);
    }
    const errors = of('api_error');
    const toolErrors = [...tools.values()].reduce((sum, t) => sum + t.errors, 0);

    const teamCosts = new Map<string, number>();
    const merged = new Map<string, ModelUse>();
    for (const [team, models] of uses) {
      for (const row of models.values()) {
        teamCosts.set(team, (teamCosts.get(team) ?? 0) + costOf(row, prices).usd);
        const into = merged.get(row.model) ?? {
          ...row,
          calls: 0,
          reportedCostUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        };
        into.calls += row.calls;
        into.reportedCostUsd += row.reportedCostUsd;
        into.inputTokens += row.inputTokens;
        into.outputTokens += row.outputTokens;
        into.cacheReadTokens += row.cacheReadTokens;
        into.cacheWriteTokens += row.cacheWriteTokens;
        merged.set(row.model, into);
      }
    }
    const models = [...merged.values()]
      .map((row) => {
        const cost = costOf(row, prices);
        return {
          ...row,
          reportedCostUsd: round(row.reportedCostUsd, 6),
          costUsd: round(cost.usd, 6),
          costSource: cost.source,
          how: cost.how,
        };
      })
      .sort((x, y) => y.costUsd - x.costUsd);

    const seen = totals.find((t) => t.service === service);
    const prompts = Number(seen?.prompts ?? 0);
    const sessionsStarted = activity.sessionsStarted ?? 0;
    const key = `${service}/${CLAUDE_CODE}`;
    const summary: AgentSummary = {
      id: agentId(key),
      key,
      service,
      name: CLAUDE_CODE,
      family: 'claude_code',
      sources: [],
      teams: [...uses.keys()].filter(Boolean),
      runUnit: prompts > 0 ? 'prompt' : 'session',
      runs: prompts > 0 ? prompts : sessionsStarted,
      subAgentRuns: 0,
      failedRuns: 0,
      // Whether a prompt succeeded is not in Claude Code's metrics or events; its tracing (beta) gives interactions.
      successRate: null,
      p50Ms: round(Number(seen?.q?.[0] ?? 0)),
      p95Ms: round(Number(seen?.q?.[1] ?? 0)),
      latencyOf: 'model call',
      modelCalls: total(of('api_request')),
      toolCalls: [...tools.values()].reduce((sum, t) => sum + t.calls, 0),
      stepErrors: total(errors) + toolErrors,
      rateLimits: total(errors.filter((r) => r.status === '429' || r.status === '529')),
      retries: errors.reduce((sum, r) => sum + Number(r.retries), 0),
      loops: 0,
      inputTokens: models.reduce((sum, m) => sum + m.inputTokens, 0),
      outputTokens: models.reduce((sum, m) => sum + m.outputTokens, 0),
      cacheReadTokens: models.reduce((sum, m) => sum + m.cacheReadTokens, 0),
      cacheWriteTokens: models.reduce((sum, m) => sum + m.cacheWriteTokens, 0),
      costUsd: round(
        models.reduce((sum, m) => sum + m.costUsd, 0),
        6,
      ),
      costHow: models.length ? models.map((m) => m.how).join('; ') : 'No token or cost metrics in the period',
      unpricedModels: models.filter((m) => m.costSource === 'unpriced').map((m) => m.model),
      models,
      tools: [...tools.values()].sort((x, y) => y.calls - x.calls),
      evaluations: [],
      feedback: { up: 0, down: 0 },
      approvals,
      permissions: {
        tools: [...permissions.values()].sort((x, y) => y.allowed + y.denied - (x.allowed + x.denied)),
        modes: [
          ...new Set(
            of('tool_decision')
              .map((r) => r.mode)
              .filter(Boolean),
          ),
        ],
        needsApproval: [...permissions.values()]
          .filter((t) => Object.keys(t.sources).some((s) => s.startsWith('user_')))
          .map((t) => t.name),
        note: 'From Claude Code’s tool_decision events: each tool, how often it was allowed or rejected, and by what (config, hook, or the person).',
      },
      endReasons: {},
      users: Number(seen?.users ?? 0),
      sessions: Number(seen?.sessions ?? 0) || sessionsStarted,
      activity,
      firstSeen: seen ? new Date(Number(seen.firstMs)).toISOString() : range.from.toISOString(),
      lastSeen: seen ? new Date(Number(seen.lastMs)).toISOString() : range.to.toISOString(),
    };
    return { summary, teamCosts };
  });
}

/**
 * Alerts for agents, as ready bodies for the existing alert machinery (a search, a count, a threshold). An alert counts
 * rows, so spend is watched through its proxies: calls that are expensive on their own, and call volume.
 */
const ALERT_TEMPLATES: AgentAlertTemplate[] = [
  {
    key: 'agent-run-errors',
    kind: 'errors',
    title: 'Agent runs failing',
    description: 'More than 3 failed runs of one agent in 15 minutes.',
    alert: {
      name: 'Agent runs failing',
      signal: 'traces',
      query: 'gen_ai.operation.name:invoke_agent status:error',
      groupBy: 'gen_ai.agent.name',
      thresholdType: 'above',
      threshold: 3,
      windowMinutes: 15,
      intervalMinutes: 1,
      enabled: true,
    },
  },
  {
    key: 'agent-rate-limits',
    kind: 'errors',
    title: 'Model rate limits',
    description:
      'More than 5 model calls refused for rate limits (or an overloaded provider) in 10 minutes, per model.',
    alert: {
      name: 'Model rate limits',
      signal: 'traces',
      query:
        'gen_ai.operation.name:* status:error (http.response.status_code:429 OR error.type:*rate_limit* OR error.type:*overloaded*)',
      groupBy: 'gen_ai.request.model',
      thresholdType: 'above',
      threshold: 5,
      windowMinutes: 10,
      intervalMinutes: 1,
      enabled: true,
    },
  },
  {
    key: 'agent-tool-errors',
    kind: 'errors',
    title: 'Agent tool calls failing',
    description: 'More than 10 failed tool calls of one tool in 15 minutes.',
    alert: {
      name: 'Agent tool calls failing',
      signal: 'traces',
      query: 'gen_ai.operation.name:execute_tool status:error',
      groupBy: 'gen_ai.tool.name',
      thresholdType: 'above',
      threshold: 10,
      windowMinutes: 15,
      intervalMinutes: 1,
      enabled: true,
    },
  },
  {
    key: 'agent-expensive-calls',
    kind: 'cost',
    title: 'Expensive model calls',
    description: 'More than 10 model calls that each wrote over 20,000 output tokens in an hour, per model.',
    alert: {
      name: 'Expensive model calls',
      signal: 'traces',
      query: 'gen_ai.operation.name:chat gen_ai.usage.output_tokens:>20000',
      groupBy: 'gen_ai.request.model',
      thresholdType: 'above',
      threshold: 10,
      windowMinutes: 60,
      intervalMinutes: 5,
      enabled: true,
    },
  },
  {
    key: 'agent-call-volume',
    kind: 'cost',
    title: 'Model call volume',
    description: 'More than 2,000 model calls by one service in an hour: an agent that runs away spends here first.',
    alert: {
      name: 'Model call volume',
      signal: 'traces',
      query: 'gen_ai.operation.name:chat',
      groupBy: 'service',
      thresholdType: 'above',
      threshold: 2000,
      windowMinutes: 60,
      intervalMinutes: 5,
      enabled: true,
    },
  },
  {
    key: 'claude-code-expensive-requests',
    kind: 'cost',
    title: 'Claude Code requests over $1',
    description: 'More than 20 Claude Code API requests that cost over $1 each in an hour.',
    alert: {
      name: 'Claude Code requests over $1',
      signal: 'logs',
      query: 'event.name:api_request cost_usd:>1',
      groupBy: null,
      thresholdType: 'above',
      threshold: 20,
      windowMinutes: 60,
      intervalMinutes: 5,
      enabled: true,
    },
  },
  {
    key: 'agent-low-evaluation-scores',
    kind: 'quality',
    title: 'Low evaluation scores',
    description: 'More than 3 evaluation results under 0.5 in an hour, per evaluator.',
    alert: {
      name: 'Low evaluation scores',
      signal: 'logs',
      query: 'event:gen_ai.evaluation.result gen_ai.evaluation.score.value:<0.5',
      groupBy: 'gen_ai.evaluation.name',
      thresholdType: 'above',
      threshold: 3,
      windowMinutes: 60,
      intervalMinutes: 5,
      enabled: true,
    },
  },
  {
    key: 'landflow-flagged-evaluations',
    kind: 'quality',
    title: 'Landflow flagged a low score',
    description: 'Landflow’s online evaluation flagged more than 3 low scores in an hour (works today, from its logs).',
    alert: {
      name: 'Landflow flagged a low score',
      signal: 'logs',
      query: '"online evaluation flagged a low score"',
      groupBy: 'landflow.evaluation.target',
      thresholdType: 'above',
      threshold: 3,
      windowMinutes: 60,
      intervalMinutes: 5,
      enabled: true,
    },
  },
];
