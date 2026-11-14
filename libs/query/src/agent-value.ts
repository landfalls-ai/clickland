/**
 * Business value (docs/agent-value.md §4). Clickland's own model, stated in full:
 *
 *   an outcome       = a search over telemetry (spans, logs) or a sum metric
 *   an outcome's value = minutes saved × hourly rate ÷ 60, or a direct amount
 *   value(agent)     = Σ outcomes credited to the agent × the outcome's value
 *   net              = value − cost
 *   ROI              = (value − cost) ÷ cost
 *   cost per outcome = cost ÷ outcomes
 *
 * Every figure comes with a `how` line that spells the arithmetic out.
 */
import { compileSearch, quoteIdentifier, type ParamValue } from './compile.js';
import { type AgentRun, costOf, metricTotalsQuery, type ModelPrice, serviceFilter } from './agents.js';
import { chTime, fieldExpression, type Query, type TimeRange } from './queries.js';
import { SIGNALS } from './signals.js';

export type OutcomeAttribution =
  /** The agents that ran in the outcome's trace share it equally. */
  | { mode: 'trace' }
  /** The agents whose runs carry the same value of a field (e.g. `incident.id`) share it. */
  | { mode: 'correlate'; field: string }
  /** The outcome's row names its agent in a field (e.g. `gen_ai.agent.name`). */
  | { mode: 'field'; field: string }
  /** Always one agent (its key, `service/name`). */
  | { mode: 'agent'; agent: string };

export interface OutcomeDefinitionLike {
  id: string;
  name: string;
  signal: 'traces' | 'logs' | 'metric';
  /** A Clickland search for traces and logs; the metric's name for a metric. */
  query: string;
  metricFilter: Record<string, string>;
  attribution: OutcomeAttribution;
  valueKind: 'minutes' | 'amount';
  minutesSaved: number;
  amount: number;
}

export interface ValueSettingsLike {
  hourlyRate: number;
  currency: string;
  teamAttribute: string;
}

export interface OutcomeRow {
  service: string;
  /** What the attribution joins on: a trace id, a field's value, or ''. */
  join: string;
  team: string;
  count: number;
}

export class OutcomeDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutcomeDefinitionError';
  }
}

/** Checks a definition can be counted, with the same errors a search gives. */
export function checkOutcomeDefinition(def: Pick<OutcomeDefinitionLike, 'signal' | 'query' | 'attribution'>): void {
  if (def.signal === 'metric') {
    if (!/^[A-Za-z_][\w.\-/]*$/.test(def.query))
      throw new OutcomeDefinitionError('A metric outcome’s query is the metric’s name');
    if (def.attribution.mode === 'trace' || def.attribution.mode === 'correlate')
      throw new OutcomeDefinitionError(
        'A metric has no traces to join on: credit it to one agent, or to the agent a label names',
      );
    return;
  }
  compileSearch(SIGNALS[def.signal], def.query);
  if (def.attribution.mode === 'field' || def.attribution.mode === 'correlate')
    fieldExpression(SIGNALS[def.signal], def.attribution.field, {});
}

/** Counts an outcome's rows per service, join value and team. */
export function outcomeRowsQuery(
  def: Pick<OutcomeDefinitionLike, 'signal' | 'query' | 'attribution' | 'metricFilter'>,
  range: TimeRange,
  teamAttribute: string,
  service?: string | null,
): Query {
  checkOutcomeDefinition(def);
  const attribution = def.attribution;
  if (def.signal === 'metric') {
    return metricTotalsQuery({
      range,
      metrics: [def.query],
      groupKeys: [attribution.mode === 'field' ? attribution.field : '', teamAttribute],
      filter: def.metricFilter,
      service,
    });
  }
  const schema = SIGNALS[def.signal];
  const filter = compileSearch(schema, def.query);
  const ts = quoteIdentifier(schema.timestamp);
  const params: Record<string, ParamValue> = { ...filter.params, from: chTime(range.from), to: chTime(range.to) };
  const join =
    attribution.mode === 'trace'
      ? 'TraceId'
      : attribution.mode === 'agent'
        ? "''"
        : fieldExpression(schema, attribution.field, params, 'join');
  const team = fieldExpression(schema, teamAttribute, params, 'team');
  return {
    sql: `SELECT ServiceName AS service, toString(${join}) AS j,
  if(${team} != '', ${team}, ResourceAttributes['service.namespace']) AS team, count() AS c
FROM ${quoteIdentifier(schema.table)}
WHERE ${ts} >= {from:DateTime64(9)} AND ${ts} < {to:DateTime64(9)} AND (${filter.sql})${serviceFilter(service, params)}
GROUP BY service, j, team
ORDER BY c DESC
LIMIT 50000`,
    params,
  };
}

/** The rows of either query shape as outcome rows. */
export function toOutcomeRows(
  def: Pick<OutcomeDefinitionLike, 'signal'>,
  rows: Record<string, unknown>[],
): OutcomeRow[] {
  if (def.signal === 'metric')
    return rows.map((r) => {
      const g = r.g as string[];
      return { service: String(r.service), join: g[0] ?? '', team: g[1] ?? '', count: Number(r.v) };
    });
  return rows.map((r) => ({ service: String(r.service), join: String(r.j), team: String(r.team), count: Number(r.c) }));
}

export interface OutcomeCredit {
  /** The agent's key, or null when no agent could be credited. */
  agent: string | null;
  team: string;
  count: number;
}

/** Who gets an outcome's rows. A row several agents share is split equally, so the totals still add up. */
export function creditOutcome(
  def: Pick<OutcomeDefinitionLike, 'attribution'>,
  rows: OutcomeRow[],
  runs: AgentRun[],
  knownAgents: { key: string; name: string; service: string }[],
): OutcomeCredit[] {
  const attribution = def.attribution;
  const credits = new Map<string, OutcomeCredit>();
  const add = (agent: string | null, team: string, count: number) => {
    const id = `${agent ?? ''}\n${team}`;
    const credit = credits.get(id) ?? { agent, team, count: 0 };
    credit.count += count;
    credits.set(id, credit);
  };
  const share = (row: OutcomeRow, agents: Map<string, string>) => {
    if (agents.size === 0) return add(null, row.team, row.count);
    // The agent's own team wins over the outcome row's (a workflow span rarely carries one).
    for (const [key, team] of agents) add(key, team || row.team, row.count / agents.size);
  };

  if (attribution.mode === 'agent') {
    // The key as written, else an agent of the same name (a service that reports under another name).
    const name = attribution.agent.slice(attribution.agent.indexOf('/') + 1);
    const agent =
      knownAgents.find((a) => a.key === attribution.agent)?.key ??
      knownAgents.find((a) => a.name === name)?.key ??
      attribution.agent;
    for (const row of rows) add(agent, row.team, row.count);
  } else if (attribution.mode === 'field') {
    for (const row of rows) {
      if (!row.join) {
        add(null, row.team, row.count);
        continue;
      }
      const own = `${row.service}/${row.join}`;
      const match = knownAgents.find((a) => a.key === own) ??
        knownAgents.find((a) => a.name === row.join) ?? { key: own };
      add(match.key, row.team, row.count);
    }
  } else {
    // trace: the top-level agents of the trace; correlate: the agents whose runs carry the field's value.
    const index = new Map<string, Map<string, string>>();
    for (const run of runs) {
      const value = attribution.mode === 'trace' ? run.traceId : run.correlate[attribution.field];
      if (!value || (attribution.mode === 'trace' && run.parentRunSpanId)) continue;
      const agents = index.get(value) ?? new Map<string, string>();
      if (!agents.has(run.key)) agents.set(run.key, run.team);
      index.set(value, agents);
    }
    for (const row of rows) share(row, index.get(row.join) ?? new Map());
  }
  return [...credits.values()];
}

const money = (n: number, currency: string) =>
  `${currency === 'USD' ? '$' : `${currency} `}${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const amount = (n: number) => (Number.isInteger(n) ? n.toLocaleString('en-US') : n.toFixed(1));
const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;

/** What one outcome is worth, and the sentence that says why. */
export function outcomeUnitValue(
  def: Pick<OutcomeDefinitionLike, 'valueKind' | 'minutesSaved' | 'amount'>,
  settings: Pick<ValueSettingsLike, 'hourlyRate' | 'currency'>,
): { value: number; how: string } {
  if (def.valueKind === 'amount')
    return { value: def.amount, how: `${money(def.amount, settings.currency)} each (a direct value)` };
  const value = (def.minutesSaved * settings.hourlyRate) / 60;
  return {
    value,
    how: `${amount(def.minutesSaved)} min saved × ${money(settings.hourlyRate, settings.currency)}/h ÷ 60 = ${money(value, settings.currency)} each`,
  };
}

/** A run's cost by the price table (see `costOf`). */
export const runCost = (run: AgentRun, prices: ModelPrice[]) =>
  run.models.reduce((sum, use) => sum + costOf(use, prices).usd, 0);

export interface AgentCost {
  key: string;
  name: string;
  service: string;
  family: string;
  cost: number;
  costHow: string;
}

function figures(value: number, cost: number, outcomes: number, currency: string) {
  const net = value - cost;
  const roi = cost > 0 ? net / cost : null;
  const costPerOutcome = outcomes > 0 ? cost / outcomes : null;
  return {
    value: round(value),
    cost: round(cost, 4),
    net: round(net),
    roi: roi === null ? null : round(roi, 4),
    outcomes: round(outcomes, 2),
    costPerOutcome: costPerOutcome === null ? null : round(costPerOutcome, 4),
    how: {
      net: `${money(value, currency)} value − ${money(cost, currency)} cost = ${money(net, currency)}`,
      roi:
        roi === null
          ? 'No cost recorded, so ROI is not defined'
          : `(${money(value, currency)} − ${money(cost, currency)}) ÷ ${money(cost, currency)} = ${(roi * 100).toFixed(0)}%`,
      costPerOutcome:
        costPerOutcome === null
          ? 'No outcomes credited'
          : `${money(cost, currency)} ÷ ${amount(outcomes)} outcomes = ${money(costPerOutcome, currency)}`,
    },
  };
}

/**
 * The value report: per agent, per team and per outcome, plus the outcomes no agent could be credited with (shown, and
 * left out of every total).
 */
export function buildValueReport<D extends OutcomeDefinitionLike>(input: {
  settings: ValueSettingsLike;
  outcomes: { definition: D; credits: OutcomeCredit[]; search: string }[];
  agents: AgentCost[];
  teamCosts: { team: string; cost: number }[];
  /** Keep only this agent (key) or this team. */
  agent?: string | null;
  team?: string | null;
}) {
  const { settings } = input;
  const currency = settings.currency;
  type Line = { outcomeId: string; name: string; count: number; unitValue: number; value: number; how: string };
  const perAgent = new Map<string, { lines: Map<string, Line>; value: number; outcomes: number }>();
  const perTeam = new Map<string, { value: number; outcomes: number }>();

  const outcomes = input.outcomes.map(({ definition, credits, search }) => {
    const unit = outcomeUnitValue(definition, settings);
    let credited = 0;
    let unattributed = 0;
    for (const credit of credits) {
      if (input.team != null && credit.team !== input.team) continue;
      if (credit.agent === null) {
        if (!input.agent) unattributed += credit.count;
        continue;
      }
      if (input.agent && credit.agent !== input.agent) continue;
      credited += credit.count;
      const agent = perAgent.get(credit.agent) ?? { lines: new Map<string, Line>(), value: 0, outcomes: 0 };
      const line = agent.lines.get(definition.id) ?? {
        outcomeId: definition.id,
        name: definition.name,
        count: 0,
        unitValue: round(unit.value, 4),
        value: 0,
        how: '',
      };
      line.count += credit.count;
      agent.lines.set(definition.id, line);
      agent.value += credit.count * unit.value;
      agent.outcomes += credit.count;
      perAgent.set(credit.agent, agent);
      const team = perTeam.get(credit.team) ?? { value: 0, outcomes: 0 };
      team.value += credit.count * unit.value;
      team.outcomes += credit.count;
      perTeam.set(credit.team, team);
    }
    return {
      id: definition.id,
      name: definition.name,
      signal: definition.signal,
      search,
      attribution: definition.attribution,
      unitValue: round(unit.value, 4),
      unitHow: unit.how,
      credited: round(credited, 2),
      unattributed: round(unattributed, 2),
      value: round(credited * unit.value),
      unattributedValue: round(unattributed * unit.value),
      how: `${amount(credited)} credited × ${money(unit.value, currency)} = ${money(credited * unit.value, currency)}`,
    };
  });

  const costs = new Map(input.agents.map((a) => [a.key, a]));
  const keys = new Set([...perAgent.keys(), ...(input.team != null ? [] : costs.keys())]);
  const agents = [...keys]
    .filter((key) => !input.agent || key === input.agent)
    .map((key) => {
      const known = costs.get(key);
      const earned = perAgent.get(key) ?? { lines: new Map<string, Line>(), value: 0, outcomes: 0 };
      // With a team filter an agent's cost is not split by team here; the team rows carry the team's cost.
      const cost = input.team != null ? 0 : (known?.cost ?? 0);
      const slash = key.indexOf('/');
      return {
        key,
        name: known?.name ?? key.slice(slash + 1),
        service: known?.service ?? key.slice(0, slash),
        family: known?.family ?? 'genai',
        seen: Boolean(known),
        ...figures(earned.value, cost, earned.outcomes, currency),
        costHow:
          input.team != null
            ? 'Cost is shown per team when a team is selected'
            : (known?.costHow ?? 'No runs of this agent in the period'),
        lines: [...earned.lines.values()].map((line) => ({
          ...line,
          count: round(line.count, 2),
          value: round(line.count * line.unitValue),
          how: `${amount(line.count)} × ${money(line.unitValue, currency)} = ${money(line.count * line.unitValue, currency)}`,
        })),
      };
    })
    .sort((x, y) => y.net - x.net);

  const teamCosts = new Map(input.teamCosts.map((t) => [t.team, t.cost]));
  const teamNames = new Set([...perTeam.keys(), ...teamCosts.keys()]);
  const teams = [...teamNames]
    .filter((team) => input.team == null || team === input.team)
    .map((team) => {
      const earned = perTeam.get(team) ?? { value: 0, outcomes: 0 };
      // With an agent filter the team rows show that agent's value only; cost by team stays whole, so it is left out.
      return {
        team: team || 'unassigned',
        ...figures(earned.value, input.agent ? 0 : (teamCosts.get(team) ?? 0), earned.outcomes, currency),
      };
    })
    .sort((x, y) => y.net - x.net);

  const totalValue = agents.reduce((sum, a) => sum + a.value, 0);
  const totalOutcomes = agents.reduce((sum, a) => sum + a.outcomes, 0);
  const totalCost =
    input.team != null ? teams.reduce((sum, t) => sum + t.cost, 0) : agents.reduce((sum, a) => sum + a.cost, 0);
  return {
    currency,
    hourlyRate: settings.hourlyRate,
    totals: figures(totalValue, totalCost, totalOutcomes, currency),
    agents,
    teams,
    outcomes,
    unattributed: {
      outcomes: round(
        outcomes.reduce((sum, o) => sum + o.unattributed, 0),
        2,
      ),
      value: round(outcomes.reduce((sum, o) => sum + o.unattributedValue, 0)),
      note: 'Outcomes that matched but that no agent took part in. They are not counted as AI value.',
    },
  };
}
