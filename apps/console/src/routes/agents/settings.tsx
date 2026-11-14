import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  ModelPriceInput,
  OutcomeInput,
  type ModelPrice,
  type OutcomeDefinition,
  type ValueSettings,
} from '@clickland/contracts';
import {
  Badge,
  Button,
  Card,
  CardGrid,
  ErrorNote,
  Field,
  Figure,
  formatMoney,
  formatOutcomes,
  Input,
  Segmented,
  Select,
  Switch,
  Textarea,
} from '@clickland/ui';
import { AgentsFrame, Loaded, Section } from '@/components/agents/agents-frame';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { ApiError } from '@/lib/api';
import { agentApi, useAgentPeriod, useOutcomes, usePrices, useValueSettings } from '@/lib/agents';
import { useCan } from '@/lib/auth';
import { useWrite } from '@/lib/queries';

const TOUCHES = ['value', 'agents'];
const num = (s: string) => (s.trim() === '' ? NaN : Number(s));
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Settings ------------------------------------------------------------------------------------------------------------

function SettingsForm({ settings }: { settings: ValueSettings }) {
  const [rate, setRate] = useState(String(settings.hourlyRate));
  const [currency, setCurrency] = useState(settings.currency);
  const [team, setTeam] = useState(settings.teamAttribute);
  const [loop, setLoop] = useState(String(settings.loopThreshold));
  const save = useWrite(agentApi.updateSettings, TOUCHES);
  const dirty =
    rate !== String(settings.hourlyRate) ||
    currency !== settings.currency ||
    team !== settings.teamAttribute ||
    loop !== String(settings.loopThreshold);
  return (
    <Card className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Field label="Hourly rate" hint="Turns minutes saved into money">
          <Input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} aria-label="Hourly rate" />
        </Field>
        <Field label="Currency">
          <Input
            value={currency}
            maxLength={3}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            className="font-mono"
            aria-label="Currency"
          />
        </Field>
        <Field label="Team attribute" hint="service.namespace when absent">
          <Input
            value={team}
            onChange={(e) => setTeam(e.target.value)}
            className="font-mono"
            aria-label="Team attribute"
          />
        </Field>
        <Field label="Loop threshold" hint="Same tool, back to back">
          <Input
            inputMode="numeric"
            value={loop}
            onChange={(e) => setLoop(e.target.value)}
            aria-label="Loop threshold"
          />
        </Field>
      </div>
      {save.error && <ErrorNote error={save.error} />}
      <div className="flex items-center gap-2">
        <span className="text-[12px] text-t3">
          Changed by {settings.updatedBy}, {new Date(settings.updatedAt).toLocaleString()}
        </span>
        <Button
          variant="primary"
          size="sm"
          className="ml-auto"
          disabled={!dirty}
          loading={save.isPending}
          onClick={() =>
            save.mutate(
              { hourlyRate: num(rate), currency, teamAttribute: team, loopThreshold: num(loop) },
              { onSuccess: () => toast.success('Value settings saved') },
            )
          }
        >
          Save
        </Button>
      </div>
    </Card>
  );
}

// Prices --------------------------------------------------------------------------------------------------------------

type PriceDraft = Record<
  'model' | 'provider' | 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'source' | 'asOf' | 'note',
  string
>;

const priceDraft = (p?: ModelPrice): PriceDraft => ({
  model: p?.model ?? '',
  provider: p?.provider ?? '',
  input: p ? String(p.inputPerMTok) : '',
  output: p ? String(p.outputPerMTok) : '',
  cacheRead: p ? String(p.cacheReadPerMTok) : '0',
  cacheWrite: p ? String(p.cacheWritePerMTok) : '0',
  source: p?.source ?? '',
  asOf: p?.asOf ?? '',
  note: p?.note ?? '',
});

function PriceDialog({ price, onClose }: { price?: ModelPrice; onClose: () => void }) {
  const [d, setD] = useState(() => priceDraft(price));
  const [problem, setProblem] = useState<string | null>(null);
  const create = useWrite(agentApi.createPrice, TOUCHES);
  const update = useWrite(agentApi.updatePrice, TOUCHES);
  const set = (k: keyof PriceDraft) => (e: { target: { value: string } }) => setD({ ...d, [k]: e.target.value });
  const submit = () => {
    const parsed = ModelPriceInput.safeParse({
      model: d.model.trim(),
      provider: d.provider.trim(),
      inputPerMTok: num(d.input),
      outputPerMTok: num(d.output),
      cacheReadPerMTok: num(d.cacheRead || '0'),
      cacheWritePerMTok: num(d.cacheWrite || '0'),
      source: d.source.trim(),
      asOf: d.asOf || null,
      note: d.note,
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      return setProblem(`${issue.path.join('.')}: ${issue.message}`);
    }
    setProblem(null);
    const done = {
      onSuccess: () => {
        toast.success(price ? 'Price saved' : 'Price added');
        onClose();
      },
      onError: (e: Error) =>
        setProblem(e instanceof ApiError && e.status === 409 ? 'That model already has a price.' : message(e)),
    };
    if (price) update.mutate({ id: price.id, input: parsed.data }, done);
    else create.mutate(parsed.data, done);
  };
  return (
    <Dialog
      title={price ? `Price of ${price.model}` : 'Add a price'}
      subtitle="USD per million tokens"
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" loading={create.isPending || update.isPending}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Model" hint="An id, or a prefix ending in *">
            <Input value={d.model} onChange={set('model')} className="font-mono" aria-label="Model" autoFocus />
          </Field>
          <Field label="Provider">
            <Input value={d.provider} onChange={set('provider')} aria-label="Provider" />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Field label="Input">
            <Input inputMode="decimal" value={d.input} onChange={set('input')} aria-label="Input per MTok" />
          </Field>
          <Field label="Output">
            <Input inputMode="decimal" value={d.output} onChange={set('output')} aria-label="Output per MTok" />
          </Field>
          <Field label="Cache read">
            <Input
              inputMode="decimal"
              value={d.cacheRead}
              onChange={set('cacheRead')}
              aria-label="Cache read per MTok"
            />
          </Field>
          <Field label="Cache write">
            <Input
              inputMode="decimal"
              value={d.cacheWrite}
              onChange={set('cacheWrite')}
              aria-label="Cache write per MTok"
            />
          </Field>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_160px]">
          <Field label="Source" hint="Where the price was read">
            <Input value={d.source} onChange={set('source')} aria-label="Source" />
          </Field>
          <Field label="As of">
            <Input type="date" value={d.asOf} onChange={set('asOf')} aria-label="As of" />
          </Field>
        </div>
        <Field label="Note">
          <Input value={d.note} onChange={set('note')} aria-label="Note" />
        </Field>
        {problem && <ErrorNote error={problem} />}
      </div>
    </Dialog>
  );
}

function PriceCard({ price, onEdit, onDelete }: { price: ModelPrice; onEdit: () => void; onDelete: () => void }) {
  const usd = (n: number) => formatMoney(n, 'USD');
  return (
    <Card className="flex flex-col gap-2" testId="price-card">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[13px] font-semibold text-t1">{price.model}</span>
        {price.seeded && <Badge tone="muted">seeded</Badge>}
        <Button size="icon-sm" variant="ghost" onClick={onEdit} aria-label={`Edit ${price.model}`}>
          <Pencil className="size-3.5" />
        </Button>
        <Button size="icon-sm" variant="ghost" onClick={onDelete} aria-label={`Delete ${price.model}`}>
          <Trash2 className="size-3.5" />
        </Button>
      </div>
      <div className="grid grid-cols-4 gap-2">
        <Figure label="Input" value={usd(price.inputPerMTok)} />
        <Figure label="Output" value={usd(price.outputPerMTok)} />
        <Figure label="Cache read" value={usd(price.cacheReadPerMTok)} />
        <Figure label="Cache write" value={usd(price.cacheWritePerMTok)} />
      </div>
      <p className="truncate text-[12px] text-t3">
        {price.provider && <>{price.provider} · </>}
        {price.asOf ? `as of ${price.asOf}` : 'no date'}
        {price.source && (
          <>
            {' · '}
            {/^https?:\/\//.test(price.source) ? (
              <a href={price.source} target="_blank" rel="noreferrer" className="text-ac hover:underline">
                source
              </a>
            ) : (
              price.source
            )}
          </>
        )}
      </p>
    </Card>
  );
}

// Outcomes ------------------------------------------------------------------------------------------------------------

type Mode = 'trace' | 'correlate' | 'field' | 'agent';

interface OutcomeDraft {
  name: string;
  description: string;
  signal: 'traces' | 'logs' | 'metric';
  query: string;
  mode: Mode;
  field: string;
  agent: string;
  valueKind: 'minutes' | 'amount';
  minutes: string;
  amount: string;
  rationale: string;
  enabled: boolean;
  metricFilter: Record<string, string>;
}

const outcomeDraft = (o?: OutcomeDefinition): OutcomeDraft => ({
  name: o?.name ?? '',
  description: o?.description ?? '',
  signal: o?.signal ?? 'traces',
  query: o?.query ?? '',
  mode: o?.attribution.mode ?? 'trace',
  field: o && 'field' in o.attribution ? o.attribution.field : '',
  agent: o && o.attribution.mode === 'agent' ? o.attribution.agent : '',
  valueKind: o?.valueKind ?? 'minutes',
  minutes: o ? String(o.minutesSaved) : '5',
  amount: o ? String(o.amount) : '0',
  rationale: o?.rationale ?? '',
  enabled: o?.enabled ?? true,
  metricFilter: o?.metricFilter ?? {},
});

function toInput(d: OutcomeDraft) {
  const attribution =
    d.mode === 'trace'
      ? { mode: 'trace' as const }
      : d.mode === 'agent'
        ? { mode: 'agent' as const, agent: d.agent.trim() }
        : { mode: d.mode, field: d.field.trim() };
  return OutcomeInput.safeParse({
    name: d.name.trim(),
    description: d.description,
    signal: d.signal,
    query: d.query.trim(),
    metricFilter: d.metricFilter,
    attribution,
    valueKind: d.valueKind,
    minutesSaved: d.valueKind === 'minutes' ? num(d.minutes) : 0,
    amount: d.valueKind === 'amount' ? num(d.amount) : 0,
    rationale: d.rationale,
    enabled: d.enabled,
  });
}

/** The live preview under the query: what the outcome would count in the page's period. */
function Preview({
  draft,
  bounds,
  currency,
}: {
  draft: OutcomeDraft;
  bounds: { from: string; to: string };
  currency: string;
}) {
  const key = useDebounced(JSON.stringify(draft), 400);
  const parsed = useMemo(() => toInput(JSON.parse(key) as OutcomeDraft), [key]);
  const preview = useQuery({
    queryKey: ['value', 'preview', key, bounds.from, bounds.to],
    queryFn: () => agentApi.previewOutcome({ outcome: parsed.data!, ...bounds }),
    enabled: parsed.success,
    retry: false,
    placeholderData: keepPreviousData,
  });
  const error = !parsed.success ? parsed.error.issues[0]?.message : preview.error ? message(preview.error) : null;
  return (
    <div
      className="rounded-xl border border-hair bg-sf2 px-3 py-2.5"
      data-testid="outcome-preview"
      aria-busy={preview.isFetching}
    >
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">Preview, this period</p>
      {error ? (
        <p className="text-[12px] text-rd">{error}</p>
      ) : preview.data ? (
        <div className="grid grid-cols-3 gap-2 md:grid-cols-5">
          <Figure label="Matched" value={formatOutcomes(preview.data.matched)} />
          <Figure label="Credited" value={formatOutcomes(preview.data.credited)} />
          <Figure label="Not credited" value={formatOutcomes(preview.data.unattributed)} />
          <Figure label="Each" value={formatMoney(preview.data.unitValue, currency)} />
          <Figure label="Total" value={formatMoney(preview.data.value, currency)} />
        </div>
      ) : (
        <p className="text-[12px] text-t3">Counting…</p>
      )}
    </div>
  );
}

/** The value, once it has stopped changing for `ms`. */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

function OutcomeDialog({
  outcome,
  bounds,
  currency,
  onClose,
}: {
  outcome?: OutcomeDefinition;
  bounds: { from: string; to: string };
  currency: string;
  onClose: () => void;
}) {
  const [d, setD] = useState(() => outcomeDraft(outcome));
  const [problem, setProblem] = useState<string | null>(null);
  const create = useWrite(agentApi.createOutcome, TOUCHES);
  const update = useWrite(agentApi.updateOutcome, TOUCHES);
  const patch = (p: Partial<OutcomeDraft>) => setD({ ...d, ...p });
  const submit = () => {
    const parsed = toInput(d);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      return setProblem(`${issue.path.join('.') || 'outcome'}: ${issue.message}`);
    }
    setProblem(null);
    const done = {
      onSuccess: () => {
        toast.success(outcome ? 'Outcome saved' : 'Outcome added');
        onClose();
      },
      onError: (e: Error) => setProblem(message(e)),
    };
    if (outcome) update.mutate({ id: outcome.id, input: parsed.data }, done);
    else create.mutate(parsed.data, done);
  };
  return (
    <Dialog
      title={outcome ? outcome.name : 'Add an outcome'}
      subtitle="A search over telemetry, and what one match is worth"
      onClose={onClose}
      onSubmit={submit}
      width={640}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" loading={create.isPending || update.isPending}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Name">
          <Input value={d.name} onChange={(e) => patch({ name: e.target.value })} aria-label="Name" autoFocus />
        </Field>
        <Field label="Description">
          <Input
            value={d.description}
            onChange={(e) => patch({ description: e.target.value })}
            aria-label="Description"
          />
        </Field>
        <Field label="Signal">
          <Segmented
            label="Signal"
            value={d.signal}
            onChange={(signal) => patch({ signal })}
            options={[
              { value: 'traces', label: 'Traces' },
              { value: 'logs', label: 'Logs' },
              { value: 'metric', label: 'Metric' },
            ]}
          />
        </Field>
        <Field label={d.signal === 'metric' ? 'Metric name' : 'Search'}>
          <Textarea
            rows={d.signal === 'metric' ? 1 : 3}
            value={d.query}
            onChange={(e) => patch({ query: e.target.value })}
            className="font-mono"
            spellCheck={false}
            aria-label="Query"
          />
        </Field>
        <Preview draft={d} bounds={bounds} currency={currency} />
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Credited to">
            <Select value={d.mode} onChange={(e) => patch({ mode: e.target.value as Mode })} aria-label="Attribution">
              <option value="trace">the agents in the same trace</option>
              <option value="correlate">the agent sharing a field (correlate)</option>
              <option value="field">the agent a field names</option>
              <option value="agent">one agent</option>
            </Select>
          </Field>
          {d.mode === 'agent' ? (
            <Field label="Agent" hint="service/name">
              <Input
                value={d.agent}
                onChange={(e) => patch({ agent: e.target.value })}
                className="font-mono"
                aria-label="Agent"
              />
            </Field>
          ) : d.mode !== 'trace' ? (
            <Field label="Field">
              <Input
                value={d.field}
                onChange={(e) => patch({ field: e.target.value })}
                className="font-mono"
                aria-label="Field"
              />
            </Field>
          ) : null}
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Value">
            <Segmented
              label="Value kind"
              value={d.valueKind}
              onChange={(valueKind) => patch({ valueKind })}
              options={[
                { value: 'minutes', label: 'Minutes saved' },
                { value: 'amount', label: 'Amount' },
              ]}
            />
          </Field>
          {d.valueKind === 'minutes' ? (
            <Field label="Minutes saved per outcome">
              <Input
                inputMode="decimal"
                value={d.minutes}
                onChange={(e) => patch({ minutes: e.target.value })}
                aria-label="Minutes saved"
              />
            </Field>
          ) : (
            <Field label={`Amount per outcome (${currency})`}>
              <Input
                inputMode="decimal"
                value={d.amount}
                onChange={(e) => patch({ amount: e.target.value })}
                aria-label="Amount"
              />
            </Field>
          )}
        </div>
        <Field label="Rationale" hint="Why this value: shown next to every number that uses it">
          <Textarea
            rows={3}
            value={d.rationale}
            onChange={(e) => patch({ rationale: e.target.value })}
            aria-label="Rationale"
          />
        </Field>
        <label className="flex items-center gap-2 text-[13px] text-t1">
          <Switch checked={d.enabled} onChange={(enabled) => patch({ enabled })} label="Enabled" /> Enabled
        </label>
        {problem && <ErrorNote error={problem} />}
      </div>
    </Dialog>
  );
}

const describeAttribution = (o: OutcomeDefinition) => {
  const a = o.attribution;
  if (a.mode === 'trace') return 'to the agents in the same trace';
  if (a.mode === 'agent') return `to ${a.agent}`;
  if (a.mode === 'field') return `to the agent ${a.field} names`;
  return `to the agent sharing ${a.field}`;
};

function OutcomeCard({
  outcome,
  currency,
  hourlyRate,
  onEdit,
  onDelete,
}: {
  outcome: OutcomeDefinition;
  currency: string;
  hourlyRate: number;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const update = useWrite(agentApi.updateOutcome, TOUCHES);
  const value =
    outcome.valueKind === 'minutes'
      ? `${outcome.minutesSaved} min (${formatMoney((outcome.minutesSaved * hourlyRate) / 60, currency)})`
      : formatMoney(outcome.amount, currency);
  const toggle = (enabled: boolean) => {
    const parsed = OutcomeInput.safeParse({ ...outcome, enabled });
    if (parsed.success)
      update.mutate({ id: outcome.id, input: parsed.data }, { onError: (e) => toast.error(message(e)) });
  };
  return (
    <Card className="flex h-full flex-col gap-2" testId="outcome-definition">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-t1">{outcome.name}</span>
        {outcome.seeded && <Badge tone="muted">seeded</Badge>}
        <Switch checked={outcome.enabled} onChange={toggle} disabled={update.isPending} label="Enabled" />
      </div>
      <code className="break-words rounded-lg bg-sf2 px-2 py-1 font-mono text-[11px] text-t2">
        <span className="text-t3">{outcome.signal}:</span> {outcome.query}
      </code>
      <p className="text-[12px] text-t2">
        {value} each, credited {describeAttribution(outcome)}
      </p>
      {outcome.rationale && <p className="text-[12px] text-t3">{outcome.rationale}</p>}
      <div className="mt-auto flex justify-end gap-1">
        <Button size="sm" variant="ghost" onClick={onEdit}>
          <Pencil className="size-3.5" /> Edit
        </Button>
        <Button size="sm" variant="ghost" onClick={onDelete} aria-label={`Delete ${outcome.name}`}>
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </Card>
  );
}

// The page ------------------------------------------------------------------------------------------------------------

type Editing =
  | { kind: 'price'; price?: ModelPrice }
  | { kind: 'outcome'; outcome?: OutcomeDefinition }
  | { kind: 'delete-price'; price: ModelPrice }
  | { kind: 'delete-outcome'; outcome: OutcomeDefinition }
  | null;

/** /agents/settings (admin): the hourly rate, the price table and the outcomes value is computed from. */
export function AgentSettingsPage() {
  const admin = useCan('admin');
  const { bounds } = useAgentPeriod();
  const settings = useValueSettings();
  const prices = usePrices();
  const outcomes = useOutcomes();
  const [editing, setEditing] = useState<Editing>(null);
  const seed = useWrite(agentApi.seed, TOUCHES);
  const deletePrice = useWrite(agentApi.deletePrice, TOUCHES);
  const deleteOutcome = useWrite(agentApi.deleteOutcome, TOUCHES);
  const currency = settings.data?.currency ?? 'USD';

  if (!admin)
    return (
      <AgentsFrame>
        <Card>
          <p className="text-[13px] text-t2">Only an admin can change what agent value is computed from.</p>
        </Card>
      </AgentsFrame>
    );

  return (
    <AgentsFrame>
      <Section title="Value">
        <Loaded query={settings} lines={3}>
          {(s) => <SettingsForm key={s.updatedAt} settings={s} />}
        </Loaded>
      </Section>

      <Section
        title="Prices"
        aside={
          <Button size="sm" onClick={() => setEditing({ kind: 'price' })}>
            <Plus className="size-3.5" /> Add
          </Button>
        }
      >
        <Loaded query={prices}>
          {(list) => (
            <CardGrid>
              {list.map((p) => (
                <PriceCard
                  key={p.id}
                  price={p}
                  onEdit={() => setEditing({ kind: 'price', price: p })}
                  onDelete={() => setEditing({ kind: 'delete-price', price: p })}
                />
              ))}
            </CardGrid>
          )}
        </Loaded>
      </Section>

      <Section
        title="Outcomes"
        aside={
          <Button size="sm" onClick={() => setEditing({ kind: 'outcome' })}>
            <Plus className="size-3.5" /> Add
          </Button>
        }
      >
        <Loaded query={outcomes}>
          {(list) => (
            <CardGrid>
              {list.map((o) => (
                <OutcomeCard
                  key={o.id}
                  outcome={o}
                  currency={currency}
                  hourlyRate={settings.data?.hourlyRate ?? 60}
                  onEdit={() => setEditing({ kind: 'outcome', outcome: o })}
                  onDelete={() => setEditing({ kind: 'delete-outcome', outcome: o })}
                />
              ))}
            </CardGrid>
          )}
        </Loaded>
      </Section>

      <Section title="Defaults">
        <Card className="flex flex-col gap-2 md:flex-row md:items-center">
          <p className="flex-1 text-[12px] text-t2">
            Adds the seeded prices and outcomes that are missing. Rows a person changed are left alone.
          </p>
          <Button
            loading={seed.isPending}
            onClick={() =>
              seed.mutate(undefined, {
                onSuccess: (r) =>
                  toast.success(
                    `Prices: ${r.prices.added} added, ${r.prices.refreshed} refreshed, ${r.prices.kept} kept. Outcomes: ${r.outcomes.added} added, ${r.outcomes.refreshed} refreshed, ${r.outcomes.kept} kept.`,
                  ),
                onError: (e) => toast.error(message(e)),
              })
            }
          >
            <RotateCcw className="size-3.5" /> Restore the defaults
          </Button>
        </Card>
      </Section>

      {editing?.kind === 'price' && <PriceDialog price={editing.price} onClose={() => setEditing(null)} />}
      {editing?.kind === 'outcome' && (
        <OutcomeDialog outcome={editing.outcome} bounds={bounds} currency={currency} onClose={() => setEditing(null)} />
      )}
      {editing?.kind === 'delete-price' && (
        <ConfirmDialog
          title="Delete this price?"
          message={
            <>
              Calls to <span className="font-mono">{editing.price.model}</span> will count as unpriced.
            </>
          }
          action="Delete"
          busy={deletePrice.isPending}
          onConfirm={() => deletePrice.mutate(editing.price.id, { onSuccess: () => setEditing(null) })}
          onClose={() => setEditing(null)}
        />
      )}
      {editing?.kind === 'delete-outcome' && (
        <ConfirmDialog
          title="Delete this outcome?"
          message={<>“{editing.outcome.name}” will no longer count toward any agent’s value.</>}
          action="Delete"
          busy={deleteOutcome.isPending}
          onConfirm={() => deleteOutcome.mutate(editing.outcome.id, { onSuccess: () => setEditing(null) })}
          onClose={() => setEditing(null)}
        />
      )}
    </AgentsFrame>
  );
}
