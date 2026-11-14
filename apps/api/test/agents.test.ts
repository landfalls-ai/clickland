import {
  AlertInput,
  OutcomeInput,
  Panel,
  ModelPriceInput,
  ViewSpec,
  type ValueReportResponse,
} from '@clickland/contracts';
import { compileSearch, SIGNALS } from '@clickland/query';
import { describe, expect, it } from 'vitest';
import { valueText } from '../src/agent-tools.js';
import { Agents, claudeCodeAgents } from '../src/agents.js';
import { ApiError } from '../src/errors.js';
import { SEED_OUTCOMES, SEED_PRICES, validateOutcome } from '../src/value.js';

const outcome = (o: object) =>
  OutcomeInput.safeParse({
    name: 'Outcome',
    signal: 'traces',
    query: 'name:workflow.execute',
    attribution: { mode: 'trace' },
    valueKind: 'minutes',
    minutesSaved: 5,
    ...o,
  });

describe('outcome definitions', () => {
  it('fill their defaults', () => {
    expect(outcome({}).data).toMatchObject({ enabled: true, amount: 0, metricFilter: {}, rationale: '' });
  });

  it('need a value that matches their kind', () => {
    expect(outcome({ minutesSaved: 0 }).success).toBe(false);
    expect(outcome({ valueKind: 'amount', amount: 0 }).success).toBe(false);
    expect(outcome({ valueKind: 'amount', amount: 12.5, minutesSaved: 0 }).success).toBe(true);
  });

  it('credit a metric to one agent or to a label, never by trace', () => {
    const metric = { signal: 'metric', query: 'claude_code.commit.count' };
    expect(outcome(metric).success).toBe(false);
    expect(outcome({ ...metric, attribution: { mode: 'correlate', field: 'incident.id' } }).success).toBe(false);
    expect(outcome({ ...metric, attribution: { mode: 'agent', agent: 'claude-code/Claude Code' } }).success).toBe(true);
    expect(outcome({ ...metric, attribution: { mode: 'agent', agent: 'no-slash' } }).success).toBe(false);
  });

  it('with a search that does not compile are a 400', () => {
    const bad = outcome({ query: '"open' }).data!;
    expect(() => validateOutcome(bad)).toThrow(ApiError);
    try {
      validateOutcome(bad);
    } catch (error) {
      expect((error as ApiError).status).toBe(400);
    }
    expect(() =>
      validateOutcome(
        outcome({ signal: 'metric', query: 'not a metric', attribution: { mode: 'agent', agent: 's/a' } }).data!,
      ),
    ).toThrow(/metric’s name/);
  });
});

describe('the seeds', () => {
  it('prices: one row per model pattern, all valid, dated and sourced', () => {
    expect(new Set(SEED_PRICES.map((p) => p.model)).size).toBe(SEED_PRICES.length);
    expect(new Set(SEED_PRICES.map((p) => p.seedKey)).size).toBe(SEED_PRICES.length);
    for (const price of SEED_PRICES) {
      expect(ModelPriceInput.safeParse(price).success, price.model).toBe(true);
      expect(price.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(price.source).toMatch(/^https:\/\//);
      expect(price.outputPerMTok).toBeGreaterThan(price.inputPerMTok);
      expect(price.cacheReadPerMTok).toBeLessThan(price.inputPerMTok);
    }
    expect(SEED_PRICES.find((p) => p.model === 'claude-opus-5-5*')).toMatchObject({
      inputPerMTok: 4,
      outputPerMTok: 20,
    });
  });

  it('outcomes: every one parses, compiles and says why it is worth what it is', () => {
    expect(new Set(SEED_OUTCOMES.map((o) => o.seedKey)).size).toBe(SEED_OUTCOMES.length);
    for (const seed of SEED_OUTCOMES) {
      const parsed = OutcomeInput.safeParse(seed);
      expect(parsed.success, seed.name).toBe(true);
      expect(() => validateOutcome(parsed.data!), seed.name).not.toThrow();
      expect(seed.rationale.length, seed.name).toBeGreaterThan(20);
      expect(seed.minutesSaved, seed.name).toBeLessThanOrEqual(60);
    }
    expect(SEED_OUTCOMES.map((o) => o.seedKey)).toEqual(
      expect.arrayContaining([
        'landflow-agent-run',
        'alert-triaged',
        'landfall-incident-resolved',
        'claude-code-commit',
        'claude-code-pr',
      ]),
    );
  });
});

describe('panel types', () => {
  it('accept the agent panels in a view', () => {
    expect(Panel.parse({ type: 'agents', title: 'Agents' })).toMatchObject({ type: 'agents', width: 'half' });
    expect(Panel.parse({ type: 'agent_value', title: 'Value', team: 'platform' })).toMatchObject({ team: 'platform' });
    expect(Panel.safeParse({ type: 'run_graph', title: 'Run', traceId: 'not-hex' }).success).toBe(false);
    const spec = ViewSpec.parse({
      title: 'AI this week',
      range: { lastMinutes: 10080 },
      panels: [
        { type: 'agent_value', title: 'Value', width: 'full' },
        { type: 'agents', title: 'Agents', service: 'landflow-host' },
        { type: 'run_graph', title: 'A run', traceId: 'abc123' },
      ],
    });
    expect(spec.panels.map((p) => p.type)).toEqual(['agent_value', 'agents', 'run_graph']);
  });
});

describe('alert templates', () => {
  it('are valid alerts whose searches compile', () => {
    const templates = new Agents(null as never, null as never).alertTemplates();
    expect(new Set(templates.map((t) => t.kind))).toEqual(new Set(['cost', 'errors', 'quality']));
    expect(new Set(templates.map((t) => t.key)).size).toBe(templates.length);
    for (const template of templates) {
      const alert = AlertInput.parse(template.alert);
      expect(() => compileSearch(SIGNALS[alert.signal], alert.query), template.key).not.toThrow();
      if (alert.groupBy) expect(() => compileSearch(SIGNALS[alert.signal], `${alert.groupBy}:*`)).not.toThrow();
    }
  });
});

describe('Claude Code as an agent', () => {
  const range = { from: new Date('2026-11-07T00:00:00Z'), to: new Date('2026-11-14T00:00:00Z') };
  const metric = (name: string, v: number, g: string[] = ['', '', '', 'platform']) => ({
    service: 'claude-code',
    metric: `claude_code.${name}`,
    g,
    v,
  });
  const event = (name: string, c: number, o: object = {}) => ({
    service: 'claude-code',
    event: name,
    model: '',
    tool: '',
    success: '',
    decision: '',
    source: '',
    mode: '',
    status: '',
    c,
    retries: 0,
    ...o,
  });
  const prices = [
    { model: 'claude-opus-5-5*', inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2, cacheWritePerMTok: 5 },
  ] as never;
  const [claude] = claudeCodeAgents(
    [
      metric('token.usage', 50_000, ['claude-opus-5-5', 'input', '', 'platform']),
      metric('token.usage', 12_000, ['claude-opus-5-5', 'output', '', 'platform']),
      metric('token.usage', 400_000, ['claude-opus-5-5', 'cacheRead', '', 'platform']),
      metric('token.usage', 30_000, ['claude-opus-5-5', 'cacheCreation', '', 'platform']),
      metric('cost.usage', 0.7, ['claude-opus-5-5', '', '', 'platform']),
      metric('commit.count', 3),
      metric('pull_request.count', 1),
      metric('lines_of_code.count', 420, ['claude-opus-5-5', 'added', '', 'platform']),
      metric('lines_of_code.count', 77, ['claude-opus-5-5', 'removed', '', 'platform']),
      metric('code_edit_tool.decision', 1, ['', '', 'reject', 'platform']),
    ],
    [
      event('user_prompt', 6),
      event('api_request', 14, { model: 'claude-opus-5-5' }),
      event('api_error', 1, { status: '429', retries: 1 }),
      event('tool_result', 8, { tool: 'Bash', success: 'true' }),
      event('tool_result', 1, { tool: 'Edit', success: 'false' }),
      event('tool_decision', 6, { tool: 'Bash', decision: 'accept', source: 'config', mode: 'default' }),
      event('tool_decision', 2, { tool: 'Bash', decision: 'accept', source: 'user_temporary', mode: 'default' }),
      event('tool_decision', 1, { tool: 'Write', decision: 'reject', source: 'user_reject', mode: 'default' }),
    ],
    [
      {
        service: 'claude-code',
        users: 2,
        sessions: 3,
        prompts: 6,
        q: [4200, 9000],
        firstMs: '1794000000000',
        lastMs: '1794003600000',
      },
    ],
    prices,
    range,
  );
  const summary = claude!.summary;

  it('prices its tokens with cached tokens counted once', () => {
    expect(summary.key).toBe('claude-code/Claude Code');
    expect(summary.models).toHaveLength(1);
    // 50,000 × $4 + 12,000 × $20 + 400,000 × $0.2 + 30,000 × $5, per million = $0.67 (the emitter said $0.70)
    expect(summary.models[0]).toMatchObject({
      calls: 14,
      inputTokens: 480_000,
      costUsd: 0.67,
      costSource: 'priced',
      reportedCostUsd: 0.7,
    });
    expect(summary.costUsd).toBe(0.67);
    expect(claude!.teamCosts.get('platform')).toBeCloseTo(0.67, 6);
  });

  it('counts prompts as runs and reads errors, tools and activity', () => {
    expect(summary).toMatchObject({
      runUnit: 'prompt',
      runs: 6,
      successRate: null,
      latencyOf: 'model call',
      p50Ms: 4200,
      p95Ms: 9000,
      modelCalls: 14,
      toolCalls: 9,
      stepErrors: 2,
      rateLimits: 1,
      retries: 1,
      users: 2,
      sessions: 3,
      teams: ['platform'],
    });
    expect(summary.activity).toMatchObject({
      commits: 3,
      pullRequests: 1,
      linesAdded: 420,
      linesRemoved: 77,
      editsRejected: 1,
    });
  });

  it('lists what each tool was allowed to do, and by whom', () => {
    expect(summary.permissions.tools).toEqual([
      { name: 'Bash', kind: '', allowed: 8, denied: 0, sources: { config: 6, user_temporary: 2 } },
      { name: 'Write', kind: '', allowed: 0, denied: 1, sources: { user_reject: 1 } },
    ]);
    expect(summary.permissions.modes).toEqual(['default']);
    expect(summary.permissions.needsApproval).toEqual(['Bash', 'Write']);
    expect(summary.approvals).toEqual({ approved: 2, denied: 1 });
  });

  it('falls back to sessions when the events are not exported', () => {
    const [metricsOnly] = claudeCodeAgents(
      [metric('session.count', 4), metric('commit.count', 1)],
      [],
      [],
      prices,
      range,
    );
    expect(metricsOnly!.summary).toMatchObject({ runUnit: 'session', runs: 4, sessions: 4, users: 0 });
  });
});

describe('the value report in words', () => {
  it('quotes the numbers with their arithmetic', () => {
    const how = {
      net: '$185.00 value − $0.85 cost = $184.15',
      roi: '($185.00 − $0.85) ÷ $0.85 = 21665%',
      costPerOutcome: '',
    };
    const figures = { value: 185, cost: 0.85, net: 184.15, roi: 216.65, outcomes: 14, costPerOutcome: 0.06, how };
    const text = valueText({
      from: '2026-11-07T00:00:00.000Z',
      to: '2026-11-14T00:00:00.000Z',
      currency: 'USD',
      hourlyRate: 60,
      model: 'MODEL LINE',
      totals: figures,
      agents: [
        {
          ...figures,
          key: 'h/A',
          name: 'Support triage',
          service: 'h',
          family: 'landflow',
          seen: true,
          costHow: '',
          lines: [
            { outcomeId: 'o', name: 'Run completed', count: 5, unitValue: 5, value: 25, how: '5 × $5.00 = $25.00' },
          ],
        },
      ],
      teams: [],
      outcomes: [
        {
          id: 'o',
          name: 'Run completed',
          signal: 'traces',
          search: 'traces: x',
          attribution: { mode: 'trace' },
          unitValue: 5,
          unitHow: '5 min saved × $60.00/h ÷ 60 = $5.00 each',
          credited: 5,
          unattributed: 1,
          value: 25,
          unattributedValue: 5,
          how: '5 credited × $5.00 = $25.00',
        },
      ],
      unattributed: { outcomes: 1, value: 5, note: '' },
      truncated: false,
    } satisfies ValueReportResponse);
    expect(text).toContain('2026-11-07 to 2026-11-14');
    expect(text).toContain('value $185.00, cost $0.85, net $184.15, ROI 21665%');
    expect(text).toContain('Support triage (h)');
    expect(text).toContain('Run completed: 5 × $5.00 = $25.00');
    expect(text).toContain('5 min saved × $60.00/h ÷ 60 = $5.00 each');
    expect(text).toContain('Not counted: 1 outcomes');
    expect(text.endsWith('MODEL LINE')).toBe(true);
  });
});
