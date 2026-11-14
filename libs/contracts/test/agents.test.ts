import { describe, expect, it } from 'vitest';
import {
  AgentParams,
  AgentsQuery,
  ModelPriceInput,
  OutcomeAttribution,
  OutcomeInput,
  Panel,
  RunGraphParams,
  SafetyQuery,
  ValueReportQuery,
  ValueSettingsInput,
} from '../src/index.js';

describe('agent questions', () => {
  it('take a period, a service name or prefix, and a family', () => {
    expect(AgentsQuery.parse({})).toEqual({});
    expect(AgentsQuery.safeParse({ service: 'demo-*', family: 'claude_code' }).success).toBe(true);
    expect(AgentsQuery.safeParse({ service: "x' OR 1=1" }).success).toBe(false);
    expect(AgentsQuery.safeParse({ family: 'robots' }).success).toBe(false);
    expect(AgentsQuery.safeParse({ from: 'yesterday' }).success).toBe(false);
  });

  it('take an agent id and a hex trace id in the path', () => {
    expect(AgentParams.safeParse({ id: 'ag_bGFuZGZsb3ctaG9zdC9B' }).success).toBe(true);
    expect(AgentParams.safeParse({ id: 'landflow-host/A' }).success).toBe(false);
    expect(RunGraphParams.safeParse({ traceId: '4bf92f3577b34da6a3ce929d0e0e4736' }).success).toBe(true);
    expect(RunGraphParams.safeParse({ traceId: 'xyz' }).success).toBe(false);
  });

  it('filter the value report by agent and team, and bound the safety scan', () => {
    expect(ValueReportQuery.safeParse({ agent: 'ag_abc', team: 'platform' }).success).toBe(true);
    expect(ValueReportQuery.safeParse({ agent: 'Support triage' }).success).toBe(false);
    expect(SafetyQuery.parse({}).limit).toBe(500);
    expect(SafetyQuery.parse({ limit: '50' }).limit).toBe(50);
    expect(SafetyQuery.safeParse({ limit: 5000 }).success).toBe(false);
  });
});

describe('what value is computed from', () => {
  it('settings change one field at a time, within bounds', () => {
    expect(ValueSettingsInput.parse({ hourlyRate: 85 })).toEqual({ hourlyRate: 85 });
    expect(ValueSettingsInput.safeParse({ hourlyRate: 0 }).success).toBe(false);
    expect(ValueSettingsInput.safeParse({ currency: 'usd' }).success).toBe(false);
    expect(ValueSettingsInput.safeParse({ loopThreshold: 1 }).success).toBe(false);
    expect(ValueSettingsInput.safeParse({ teamAttribute: 'team id' }).success).toBe(false);
  });

  it('a price names a model or a prefix, and its cache prices default to zero', () => {
    expect(ModelPriceInput.parse({ model: 'claude-opus-5-5*', inputPerMTok: 4, outputPerMTok: 20 })).toMatchObject({
      cacheReadPerMTok: 0,
      cacheWritePerMTok: 0,
      provider: '',
    });
    expect(ModelPriceInput.safeParse({ model: 'claude *', inputPerMTok: 1, outputPerMTok: 1 }).success).toBe(false);
    expect(ModelPriceInput.safeParse({ model: 'm', inputPerMTok: -1, outputPerMTok: 1 }).success).toBe(false);
    expect(
      ModelPriceInput.safeParse({ model: 'm', inputPerMTok: 1, outputPerMTok: 1, asOf: '14/11/2026' }).success,
    ).toBe(false);
  });

  it('an outcome is credited one of four ways', () => {
    expect(OutcomeAttribution.safeParse({ mode: 'trace' }).success).toBe(true);
    expect(OutcomeAttribution.safeParse({ mode: 'correlate', field: 'incident.id' }).success).toBe(true);
    expect(OutcomeAttribution.safeParse({ mode: 'field' }).success).toBe(false);
    expect(OutcomeAttribution.safeParse({ mode: 'agent', agent: 'claude-code/Claude Code' }).success).toBe(true);
    expect(OutcomeAttribution.safeParse({ mode: 'everyone' }).success).toBe(false);
  });

  it('an outcome needs a value of its kind, and a metric cannot be credited by trace', () => {
    const base = {
      name: 'Alert triaged',
      signal: 'traces',
      query: 'name:workflow.execute',
      attribution: { mode: 'trace' },
    };
    expect(OutcomeInput.safeParse({ ...base, valueKind: 'minutes', minutesSaved: 15 }).success).toBe(true);
    const noValue = OutcomeInput.safeParse({ ...base, valueKind: 'minutes' });
    expect(noValue.success).toBe(false);
    expect(noValue.error!.issues[0]!.path).toEqual(['valueKind']);
    const metric = OutcomeInput.safeParse({
      ...base,
      signal: 'metric',
      query: 'claude_code.commit.count',
      valueKind: 'amount',
      amount: 5,
    });
    expect(metric.error!.issues[0]!.path).toEqual(['attribution', 'mode']);
  });
});

describe('agent panels', () => {
  it('are panels of a view', () => {
    expect(Panel.parse({ type: 'agents', title: 'Agents' })).toEqual({
      type: 'agents',
      title: 'Agents',
      width: 'half',
    });
    expect(Panel.parse({ type: 'agent_value', title: 'Value', agent: 'Support triage', width: 'full' })).toMatchObject({
      agent: 'Support triage',
      width: 'full',
    });
    expect(Panel.safeParse({ type: 'run_graph', title: 'Run' }).success).toBe(false);
    expect(Panel.safeParse({ type: 'run_graph', title: 'Run', traceId: 'abc123' }).success).toBe(true);
  });
});
