import type { ReactNode } from 'react';
import type { Panel } from '@clickland/contracts';
import { MetricAggregation, MetricType } from '@clickland/contracts';
import { cn, Field, Input, PANEL_TYPES, Segmented, Select, Textarea, type PanelType } from '@clickland/ui';
import type { MetricName } from '@/lib/types';
import { convertPanel } from './spec-ops';

/** The type picker: a grid of panel types with what each one shows. */
export function TypePicker({ value, onPick }: { value?: PanelType; onPick: (type: PanelType) => void }) {
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-3" role="listbox" aria-label="Panel type">
      {(Object.keys(PANEL_TYPES) as PanelType[]).map((type) => {
        const { label, icon: Icon, hint } = PANEL_TYPES[type];
        return (
          <button
            key={type}
            type="button"
            role="option"
            aria-selected={value === type}
            onClick={() => onPick(type)}
            className={cn(
              'flex flex-col items-start gap-1 rounded-xl border p-2.5 text-left transition-colors hover:border-bd',
              value === type ? 'border-ac bg-acdim' : 'border-hair',
            )}
          >
            <span className="flex items-center gap-1.5 text-[13px] font-semibold text-t1">
              <Icon className="size-4 text-t2" strokeWidth={1.8} />
              {label}
            </span>
            <span className="text-[11px] leading-snug text-t3">{hint}</span>
          </button>
        );
      })}
    </div>
  );
}

const signalOptions = [
  { value: 'logs' as const, label: 'Logs' },
  { value: 'traces' as const, label: 'Traces' },
];

/** The fields of one panel; which ones depends on its type. */
export function PanelForm({
  value,
  onChange,
  metrics = [],
}: {
  value: Panel;
  onChange: (panel: Panel) => void;
  metrics?: MetricName[];
}) {
  const set = (patch: Record<string, unknown>) => onChange({ ...value, ...patch } as Panel);
  const p = value as Panel & Record<string, unknown>;
  const row = (children: ReactNode) => <div className="grid grid-cols-1 gap-3 md:grid-cols-2">{children}</div>;

  const signal = 'signal' in value && (
    <Field label="Signal">
      <Segmented
        label="Signal"
        value={(p.signal as 'logs' | 'traces') ?? 'logs'}
        onChange={(s) => set({ signal: s })}
        options={signalOptions}
      />
    </Field>
  );
  const query = 'query' in value && (
    <Field label="Search" hint="The search language, as in Search.">
      <Input
        value={(p.query as string) ?? ''}
        onChange={(e) => set({ query: e.target.value })}
        className="font-mono"
        spellCheck={false}
        aria-label="Panel search"
      />
    </Field>
  );
  const groupBy = (value.type === 'timeseries' || value.type === 'bar' || value.type === 'metric') && (
    <Field label={value.type === 'bar' ? 'Group by (required)' : 'Group by'}>
      <Input
        value={(p.groupBy as string) ?? ''}
        onChange={(e) => set({ groupBy: e.target.value || (value.type === 'bar' ? '' : null) })}
        placeholder="service"
        className="font-mono"
        aria-label="Group by"
      />
    </Field>
  );
  const limit = (value.type === 'logs' || value.type === 'spans') && (
    <Field label="Rows">
      <Input
        type="number"
        min={1}
        max={200}
        value={(p.limit as number) ?? 25}
        onChange={(e) => set({ limit: e.target.valueAsNumber })}
        aria-label="Rows"
      />
    </Field>
  );
  const metric = value.type === 'metric' && (
    <>
      <Field label="Metric">
        <Input
          list="metric-names"
          value={value.metric}
          onChange={(e) => {
            const m = metrics.find((x) => x.name === e.target.value);
            set(m ? { metric: m.name, metricType: m.type } : { metric: e.target.value });
          }}
          className="font-mono"
          aria-label="Metric"
        />
        <datalist id="metric-names">
          {metrics.map((m) => (
            <option key={m.name} value={m.name}>
              {m.type}
            </option>
          ))}
        </datalist>
      </Field>
      {row(
        <>
          <Field label="Metric type">
            <Select
              value={value.metricType}
              onChange={(e) => set({ metricType: e.target.value })}
              aria-label="Metric type"
            >
              {MetricType.options.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </Select>
          </Field>
          <Field label="Aggregation">
            <Select
              value={value.aggregation}
              onChange={(e) => set({ aggregation: e.target.value })}
              aria-label="Aggregation"
            >
              {MetricAggregation.options.map((a) => (
                <option key={a}>{a}</option>
              ))}
            </Select>
          </Field>
        </>,
      )}
      <Field label="Service">
        <Input
          value={value.service ?? ''}
          onChange={(e) => set({ service: e.target.value || null })}
          placeholder="all services"
          aria-label="Service"
        />
      </Field>
    </>
  );

  return (
    <div className="flex flex-col gap-3" data-testid="panel-form">
      {row(
        <>
          <Field label="Type">
            <Select
              value={value.type}
              onChange={(e) => onChange(convertPanel(value, e.target.value as PanelType))}
              aria-label="Type"
            >
              {(Object.keys(PANEL_TYPES) as PanelType[]).map((t) => (
                <option key={t} value={t}>
                  {PANEL_TYPES[t].label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Width">
            <Segmented
              label="Width"
              value={value.width ?? 'half'}
              onChange={(w) => set({ width: w })}
              options={[
                { value: 'half', label: 'Half' },
                { value: 'full', label: 'Full' },
              ]}
            />
          </Field>
        </>,
      )}
      <Field label="Title">
        <Input value={value.title} onChange={(e) => set({ title: e.target.value })} aria-label="Title" />
      </Field>
      {signal}
      {query}
      {groupBy}
      {limit}
      {metric}
      {value.type === 'trace' && (
        <Field label="Trace id">
          <Input
            value={value.traceId}
            onChange={(e) => set({ traceId: e.target.value.trim() })}
            className="font-mono"
            aria-label="Trace id"
          />
        </Field>
      )}
      {value.type === 'markdown' && (
        <Field label="Text" hint="Markdown: **bold**, lists, links, tables.">
          <Textarea rows={6} value={value.text} onChange={(e) => set({ text: e.target.value })} aria-label="Text" />
        </Field>
      )}
    </div>
  );
}
