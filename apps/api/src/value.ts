/**
 * What agent value is computed from, kept in Postgres: the settings (hourly rate, currency), the price table and the
 * outcome definitions. The figures themselves are computed in agents.ts from telemetry, never stored.
 */
import {
  type ModelPrice,
  ModelPriceInput,
  type OutcomeDefinition,
  OutcomeInput,
  type ValueSettings,
  type ValueSettingsInput,
} from '@clickland/contracts';
import { checkOutcomeDefinition, OutcomeDefinitionError } from '@clickland/query';
import type { Sql } from './clients.js';
import { ApiError, notFound } from './errors.js';
import { newId } from './ids.js';
import { wrapSearchErrors } from './telemetry.js';

type SettingsRow = {
  hourly_rate: number;
  currency: string;
  team_attribute: string;
  loop_threshold: number;
  updated_by: string;
  updated_at: Date;
};
type PriceRow = {
  id: string;
  model: string;
  provider: string;
  input_per_mtok: number;
  output_per_mtok: number;
  cache_read_per_mtok: number;
  cache_write_per_mtok: number;
  source: string;
  as_of: string | Date | null;
  note: string;
  seed_key: string | null;
  edited: boolean;
  updated_by: string;
  updated_at: Date;
};
type OutcomeRow = {
  id: string;
  name: string;
  description: string;
  signal: 'traces' | 'logs' | 'metric';
  query: string;
  metric_filter: Record<string, string>;
  attribution: OutcomeDefinition['attribution'];
  value_kind: 'minutes' | 'amount';
  minutes_saved: number;
  amount: number;
  rationale: string;
  enabled: boolean;
  seed_key: string | null;
  edited: boolean;
  created_by: string;
  created_at: Date;
  updated_at: Date;
};

const toSettings = (r: SettingsRow): ValueSettings => ({
  hourlyRate: r.hourly_rate,
  currency: r.currency,
  teamAttribute: r.team_attribute,
  loopThreshold: r.loop_threshold,
  updatedBy: r.updated_by,
  updatedAt: r.updated_at.toISOString(),
});

const day = (value: string | Date | null) =>
  value === null ? null : value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);

const toPrice = (r: PriceRow): ModelPrice => ({
  id: r.id,
  model: r.model,
  provider: r.provider,
  inputPerMTok: r.input_per_mtok,
  outputPerMTok: r.output_per_mtok,
  cacheReadPerMTok: r.cache_read_per_mtok,
  cacheWritePerMTok: r.cache_write_per_mtok,
  source: r.source,
  asOf: day(r.as_of),
  note: r.note,
  seeded: r.seed_key !== null && !r.edited,
  editable: true,
  updatedBy: r.updated_by,
  updatedAt: r.updated_at.toISOString(),
});

const toOutcome = (r: OutcomeRow): OutcomeDefinition => ({
  id: r.id,
  name: r.name,
  description: r.description,
  signal: r.signal,
  query: r.query,
  metricFilter: r.metric_filter,
  attribution: r.attribution,
  valueKind: r.value_kind,
  minutesSaved: r.minutes_saved,
  amount: r.amount,
  rationale: r.rationale,
  enabled: r.enabled,
  seeded: r.seed_key !== null && !r.edited,
  createdBy: r.created_by,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

/** A definition that cannot be counted is a 400 that says why, like a bad search. */
export function validateOutcome(input: OutcomeInput): void {
  try {
    wrapSearchErrors(() => checkOutcomeDefinition(input));
  } catch (error) {
    if (error instanceof OutcomeDefinitionError) throw new ApiError('bad_request', error.message);
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Seeds

const PRICING_SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing';
/** The day the list prices below were read. Change both together. */
export const PRICES_AS_OF = '2026-11-14';

/** Anthropic's list prices in USD per million tokens: [model, input, output, cache read, 5-minute cache write, note]. */
const CLAUDE_PRICES: [string, number, number, number, number, string?][] = [
  ['claude-fable-5-2*', 8, 40, 0.2, 10],
  ['claude-mythos-5-2*', 8, 40, 0.2, 10],
  ['claude-fable-5-1*', 10, 50, 0.25, 12.5],
  ['claude-mythos-5-1*', 10, 50, 0.25, 12.5],
  ['claude-fable-5*', 10, 50, 1, 12.5],
  ['claude-mythos-5*', 10, 50, 1, 12.5],
  ['claude-opus-5-5*', 4, 20, 0.2, 5],
  ['claude-opus-5*', 5, 25, 0.5, 6.25],
  ['claude-opus-4-8*', 5, 25, 0.5, 6.25],
  ['claude-opus-4-7*', 5, 25, 0.5, 6.25],
  ['claude-opus-4-6*', 5, 25, 0.5, 6.25],
  ['claude-opus-4-5*', 5, 25, 0.5, 6.25],
  ['claude-opus-4-1*', 15, 75, 1.5, 18.75],
  ['claude-opus-4*', 15, 75, 1.5, 18.75, 'Claude Opus 4 (and any Opus 4.x without its own row)'],
  ['claude-sonnet-5-5*', 2, 10, 0.1, 2.5],
  ['claude-sonnet-5*', 2, 10, 0.2, 2.5],
  ['claude-sonnet-4-6*', 3, 15, 0.3, 3.75],
  ['claude-sonnet-4-5*', 3, 15, 0.3, 3.75],
  ['claude-sonnet-4*', 3, 15, 0.3, 3.75],
  [
    'claude-haiku-5-5*',
    0.1,
    0.5,
    0.01,
    0.125,
    'Prompts up to 100,000 tokens; longer prompts cost $0.50 in and $2.50 out',
  ],
  ['claude-haiku-4-5*', 1, 5, 0.1, 1.25],
];

export const SEED_PRICES: (ModelPriceInput & { seedKey: string })[] = CLAUDE_PRICES.map(
  ([model, input, output, cacheRead, cacheWrite, note]) => ({
    seedKey: `anthropic:${model}`,
    model,
    provider: 'anthropic',
    inputPerMTok: input,
    outputPerMTok: output,
    cacheReadPerMTok: cacheRead,
    cacheWritePerMTok: cacheWrite,
    source: PRICING_SOURCE,
    asOf: PRICES_AS_OF,
    note: note ?? 'List price; the cache write is the 5-minute rate. Batch and long-context rates differ.',
  }),
);

/** The outcomes Clickland starts with. Minutes are deliberately low: change them once you have measured. */
export const SEED_OUTCOMES: (OutcomeInput & { seedKey: string })[] = [
  {
    seedKey: 'landflow-agent-run',
    name: 'Landflow agent run completed',
    description:
      'An agent in Landflow finished a run of its own (schedule, Telegram, Slack) without an error. Test chats, sub-agents and runs inside a workflow are left out: a workflow run is counted once, by the outcomes below.',
    signal: 'traces',
    query:
      'gen_ai.operation.name:invoke_agent landflow.agent.source:* NOT status:error NOT landflow.agent.source:test NOT landflow.agent.source:agent NOT landflow.agent.source:workflow',
    metricFilter: {},
    attribution: { mode: 'field', field: 'gen_ai.agent.name' },
    valueKind: 'minutes',
    minutesSaved: 5,
    amount: 0,
    rationale: 'A person answering the same question by hand: reading, looking up, replying. 5 minutes is a floor.',
    enabled: true,
  },
  {
    seedKey: 'landflow-workflow-with-agent',
    name: 'Landflow workflow run with an agent succeeded',
    description:
      'A workflow run that ended in success and had an agent take part (the agents in its trace share it). Triage and SDLC runs have their own outcomes and are left out here.',
    signal: 'traces',
    query:
      'name:workflow.execute landflow.execution.status:success NOT landflow.workflow.name:*riage* NOT landflow.workflow.name:*SDLC*',
    metricFilter: {},
    attribution: { mode: 'trace' },
    valueKind: 'minutes',
    minutesSaved: 10,
    amount: 0,
    rationale: 'A workflow that needs a model replaces a manual hand-off between two tools: about 10 minutes.',
    enabled: true,
  },
  {
    seedKey: 'alert-triaged',
    name: 'Alert triaged',
    description: 'Landflow’s triage flow ran to the end for a Clickland alert, with an agent in its trace.',
    signal: 'traces',
    query: 'name:workflow.execute landflow.execution.status:success landflow.workflow.name:*riage*',
    metricFilter: {},
    attribution: { mode: 'trace' },
    valueKind: 'minutes',
    minutesSaved: 15,
    amount: 0,
    rationale: 'First look at an alert by an on-call engineer: open the alert, find the logs and traces, write it up.',
    enabled: true,
  },
  {
    seedKey: 'sdlc-pr-merged',
    name: 'Pull request merged by the SDLC flow',
    description: 'Landflow’s SDLC flow merged a pull request its agents built.',
    signal: 'traces',
    query: 'name:workflow.execute landflow.execution.status:success landflow.workflow.name:*SDLC*',
    metricFilter: {},
    attribution: { mode: 'trace' },
    valueKind: 'minutes',
    minutesSaved: 60,
    amount: 0,
    rationale: 'A small reviewed change, from ticket to merge, done by a developer: at least an hour.',
    enabled: true,
  },
  {
    seedKey: 'landfall-investigation',
    name: 'Landfall investigation completed',
    description: 'Landfall’s AI investigator finished a diagnosis run in an incident room.',
    signal: 'traces',
    query: 'name:diagnosis.run NOT status:error',
    metricFilter: {},
    attribution: { mode: 'trace' },
    valueKind: 'minutes',
    minutesSaved: 20,
    amount: 0,
    rationale: 'The first 20 minutes of an incident: gathering signals and forming a first hypothesis.',
    enabled: true,
  },
  {
    seedKey: 'landfall-incident-resolved',
    name: 'Landfall incident resolved with the investigator',
    description:
      'An incident was resolved and the investigator had run in its room (joined on incident.id). Counts nothing until Landfall puts the event type on its timeline span.',
    signal: 'traces',
    query: 'name:incidents.appendEventInTx incident.event.type:incident.resolved',
    metricFilter: {},
    attribution: { mode: 'correlate', field: 'incident.id' },
    valueKind: 'minutes',
    minutesSaved: 30,
    amount: 0,
    rationale: 'Minutes of incident time saved across the people in the room. Replace with your measured MTTR change.',
    enabled: true,
  },
  {
    seedKey: 'claude-code-commit',
    name: 'Claude Code commit',
    description: 'A git commit made through Claude Code (its claude_code.commit.count metric).',
    signal: 'metric',
    query: 'claude_code.commit.count',
    metricFilter: {},
    attribution: { mode: 'agent', agent: 'claude-code/Claude Code' },
    valueKind: 'minutes',
    minutesSaved: 15,
    amount: 0,
    rationale: 'A committed change a developer would otherwise have typed and checked by hand.',
    enabled: true,
  },
  {
    seedKey: 'claude-code-pr',
    name: 'Claude Code pull request',
    description: 'A pull request opened through Claude Code (its claude_code.pull_request.count metric).',
    signal: 'metric',
    query: 'claude_code.pull_request.count',
    metricFilter: {},
    attribution: { mode: 'agent', agent: 'claude-code/Claude Code' },
    valueKind: 'minutes',
    minutesSaved: 30,
    amount: 0,
    rationale: 'On top of its commits: the description, the checks and the back-and-forth of opening a pull request.',
    enabled: true,
  },
];

// ---------------------------------------------------------------------------------------------------------------

export class ValueStore {
  constructor(private readonly pg: Sql) {}

  async settings(): Promise<ValueSettings> {
    const [row] = await this.pg<SettingsRow[]>`SELECT * FROM value_settings`;
    if (row) return toSettings(row);
    const [created] = await this.pg<SettingsRow[]>`
      INSERT INTO value_settings DEFAULT VALUES ON CONFLICT (id) DO UPDATE SET id = true RETURNING *`;
    return toSettings(created!);
  }

  async updateSettings(input: ValueSettingsInput, by: string): Promise<ValueSettings> {
    const current = await this.settings();
    const [row] = await this.pg<SettingsRow[]>`
      UPDATE value_settings SET
        hourly_rate = ${input.hourlyRate ?? current.hourlyRate},
        currency = ${input.currency ?? current.currency},
        team_attribute = ${input.teamAttribute ?? current.teamAttribute},
        loop_threshold = ${input.loopThreshold ?? current.loopThreshold},
        updated_by = ${by}, updated_at = now()
      RETURNING *`;
    return toSettings(row!);
  }

  async prices(): Promise<ModelPrice[]> {
    return (await this.pg<PriceRow[]>`SELECT * FROM model_prices ORDER BY model`).map(toPrice);
  }

  async createPrice(input: ModelPriceInput, by: string): Promise<ModelPrice> {
    const taken = await this.pg`SELECT 1 FROM model_prices WHERE model = ${input.model}`;
    if (taken.length) throw new ApiError('conflict', `There is already a price for ${input.model}; change that one`);
    const [row] = await this.pg<PriceRow[]>`
      INSERT INTO model_prices (id, model, provider, input_per_mtok, output_per_mtok, cache_read_per_mtok,
        cache_write_per_mtok, source, as_of, note, edited, updated_by)
      VALUES (${newId('mp')}, ${input.model}, ${input.provider}, ${input.inputPerMTok}, ${input.outputPerMTok},
        ${input.cacheReadPerMTok}, ${input.cacheWritePerMTok}, ${input.source}, ${input.asOf ?? null}, ${input.note},
        true, ${by})
      RETURNING *`;
    return toPrice(row!);
  }

  async updatePrice(id: string, input: ModelPriceInput, by: string): Promise<ModelPrice> {
    const taken = await this.pg`SELECT 1 FROM model_prices WHERE model = ${input.model} AND id != ${id}`;
    if (taken.length) throw new ApiError('conflict', `There is already a price for ${input.model}`);
    const [row] = await this.pg<PriceRow[]>`
      UPDATE model_prices SET model = ${input.model}, provider = ${input.provider},
        input_per_mtok = ${input.inputPerMTok}, output_per_mtok = ${input.outputPerMTok},
        cache_read_per_mtok = ${input.cacheReadPerMTok}, cache_write_per_mtok = ${input.cacheWritePerMTok},
        source = ${input.source}, as_of = ${input.asOf ?? null}, note = ${input.note},
        edited = true, updated_by = ${by}, updated_at = now()
      WHERE id = ${id} RETURNING *`;
    if (!row) throw notFound('Price');
    return toPrice(row);
  }

  async deletePrice(id: string): Promise<void> {
    const rows = await this.pg`DELETE FROM model_prices WHERE id = ${id} RETURNING id`;
    if (rows.length === 0) throw notFound('Price');
  }

  async outcomes(filter: { enabled?: boolean } = {}): Promise<OutcomeDefinition[]> {
    const enabled = filter.enabled ?? null;
    const rows = await this.pg<OutcomeRow[]>`
      SELECT * FROM outcome_definitions WHERE (${enabled}::boolean IS NULL OR enabled = ${enabled}) ORDER BY name`;
    return rows.map(toOutcome);
  }

  async outcome(id: string): Promise<OutcomeDefinition> {
    const [row] = await this.pg<OutcomeRow[]>`SELECT * FROM outcome_definitions WHERE id = ${id}`;
    if (!row) throw notFound('Outcome');
    return toOutcome(row);
  }

  async createOutcome(input: OutcomeInput, by: string): Promise<OutcomeDefinition> {
    validateOutcome(input);
    const [row] = await this.pg<OutcomeRow[]>`
      INSERT INTO outcome_definitions (id, name, description, signal, query, metric_filter, attribution, value_kind,
        minutes_saved, amount, rationale, enabled, edited, created_by)
      VALUES (${newId('oc')}, ${input.name}, ${input.description}, ${input.signal}, ${input.query},
        ${this.pg.json(input.metricFilter)}, ${this.pg.json(input.attribution)}, ${input.valueKind},
        ${input.minutesSaved}, ${input.amount}, ${input.rationale}, ${input.enabled}, true, ${by})
      RETURNING *`;
    return toOutcome(row!);
  }

  async updateOutcome(id: string, input: OutcomeInput): Promise<OutcomeDefinition> {
    validateOutcome(input);
    const [row] = await this.pg<OutcomeRow[]>`
      UPDATE outcome_definitions SET name = ${input.name}, description = ${input.description},
        signal = ${input.signal}, query = ${input.query}, metric_filter = ${this.pg.json(input.metricFilter)},
        attribution = ${this.pg.json(input.attribution)}, value_kind = ${input.valueKind},
        minutes_saved = ${input.minutesSaved}, amount = ${input.amount}, rationale = ${input.rationale},
        enabled = ${input.enabled}, edited = true, updated_at = now()
      WHERE id = ${id} RETURNING *`;
    if (!row) throw notFound('Outcome');
    return toOutcome(row);
  }

  async deleteOutcome(id: string): Promise<void> {
    const rows = await this.pg`DELETE FROM outcome_definitions WHERE id = ${id} RETURNING id`;
    if (rows.length === 0) throw notFound('Outcome');
  }

  /**
   * Writes the starting prices and outcomes. Safe to run again: a seeded row nobody changed is brought up to date, a
   * row a person edited or deleted-and-recreated under the same model is left alone, and nothing is ever removed.
   */
  async seed(by: string): Promise<{
    prices: { added: number; refreshed: number; kept: number };
    outcomes: { added: number; refreshed: number; kept: number };
  }> {
    const result = { prices: { added: 0, refreshed: 0, kept: 0 }, outcomes: { added: 0, refreshed: 0, kept: 0 } };
    await this.pg.begin(async (tx) => {
      for (const seed of SEED_PRICES) {
        const price = ModelPriceInput.parse(seed);
        const [existing] = await tx<{ seed_key: string | null; edited: boolean }[]>`
          SELECT seed_key, edited FROM model_prices WHERE seed_key = ${seed.seedKey} OR model = ${price.model}`;
        if (!existing) {
          await tx`
            INSERT INTO model_prices (id, model, provider, input_per_mtok, output_per_mtok, cache_read_per_mtok,
              cache_write_per_mtok, source, as_of, note, seed_key, updated_by)
            VALUES (${newId('mp')}, ${price.model}, ${price.provider}, ${price.inputPerMTok}, ${price.outputPerMTok},
              ${price.cacheReadPerMTok}, ${price.cacheWritePerMTok}, ${price.source}, ${price.asOf ?? null},
              ${price.note}, ${seed.seedKey}, ${by})`;
          result.prices.added++;
        } else if (existing.seed_key === seed.seedKey && !existing.edited) {
          await tx`
            UPDATE model_prices SET input_per_mtok = ${price.inputPerMTok}, output_per_mtok = ${price.outputPerMTok},
              cache_read_per_mtok = ${price.cacheReadPerMTok}, cache_write_per_mtok = ${price.cacheWritePerMTok},
              source = ${price.source}, as_of = ${price.asOf ?? null}, note = ${price.note}, updated_at = now()
            WHERE seed_key = ${seed.seedKey}`;
          result.prices.refreshed++;
        } else result.prices.kept++;
      }
      for (const seed of SEED_OUTCOMES) {
        const outcome = OutcomeInput.parse(seed);
        validateOutcome(outcome);
        const [existing] = await tx<{ edited: boolean }[]>`
          SELECT edited FROM outcome_definitions WHERE seed_key = ${seed.seedKey}`;
        if (!existing) {
          await tx`
            INSERT INTO outcome_definitions (id, name, description, signal, query, metric_filter, attribution,
              value_kind, minutes_saved, amount, rationale, enabled, seed_key, created_by)
            VALUES (${newId('oc')}, ${outcome.name}, ${outcome.description}, ${outcome.signal}, ${outcome.query},
              ${tx.json(outcome.metricFilter)}, ${tx.json(outcome.attribution)}, ${outcome.valueKind},
              ${outcome.minutesSaved}, ${outcome.amount}, ${outcome.rationale}, ${outcome.enabled},
              ${seed.seedKey}, ${by})`;
          result.outcomes.added++;
        } else if (!existing.edited) {
          await tx`
            UPDATE outcome_definitions SET name = ${outcome.name}, description = ${outcome.description},
              signal = ${outcome.signal}, query = ${outcome.query}, metric_filter = ${tx.json(outcome.metricFilter)},
              attribution = ${tx.json(outcome.attribution)}, value_kind = ${outcome.valueKind},
              minutes_saved = ${outcome.minutesSaved}, amount = ${outcome.amount}, rationale = ${outcome.rationale},
              updated_at = now()
            WHERE seed_key = ${seed.seedKey}`;
          result.outcomes.refreshed++;
        } else result.outcomes.kept++;
      }
    });
    return result;
  }
}
