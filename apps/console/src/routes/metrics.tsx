import { useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChartLine } from 'lucide-react';
import { MetricAggregation } from '@clickland/contracts';
import { Card, EmptyState, ErrorNote, Field, formatterForUnit, Input, Select, Skeleton, TimeSeriesChart, cn } from '@clickland/ui';
import { PageBody, PageHeader } from '@/components/shell/page-header';
import { TimeRangePicker } from '@/components/time-range-picker';
import { quiet } from '@/lib/api';
import { httpData } from '@/lib/http-data';
import { useMetricNames } from '@/lib/queries';
import type { MetricName } from '@/lib/types';
import { useUrlRange } from './services';

type Aggregation = (typeof MetricAggregation.options)[number];

/** The aggregation that suits a metric type by default. */
/** Internal ClickHouse metrics (thousands of them) sort after the apps' own. */
const isInternal = (m: MetricName) => m.services.length > 0 && m.services.every((s) => s === 'clickhouse');

/** Apps, docker and kubernetes metrics first, then ClickHouse's own; by name within each. */
export const sortMetrics = (metrics: MetricName[]): MetricName[] =>
  [...metrics].sort((a, b) => Number(isInternal(a)) - Number(isInternal(b)) || a.name.localeCompare(b.name));

export const defaultAggregation = (type: MetricName['type']): Aggregation =>
  type === 'histogram' ? 'p95' : type === 'sum' ? 'rate' : 'avg';

/** /metrics?metric=&agg=&service=&groupBy= : pick a metric, an aggregation and a group-by; see the chart. */
export function MetricsPage() {
  const { range, bounds, setRange, params, setParams } = useUrlRange();
  const names = useMetricNames(bounds);
  const [filter, setFilter] = useState('');
  const metrics = useMemo(() => sortMetrics(names.data?.metrics ?? []), [names.data]);
  const selectedName = params.get('metric') ?? '';
  // One name can arrive as two types (a gauge from one service, a sum from another); `type` tells them apart.
  const selectedType = params.get('type') ?? '';
  const metric = metrics.find((m) => m.name === selectedName && (!selectedType || m.type === selectedType));
  const isSelected = (m: MetricName) => m === metric;
  const aggregation = (params.get('agg') as Aggregation | null) ?? (metric ? defaultAggregation(metric.type) : 'avg');
  const service = params.get('service') ?? '';
  const groupBy = params.get('groupBy') ?? '';
  const [draftGroup, setDraftGroup] = useState(groupBy);

  const set = (next: Record<string, string>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) if (v) p.set(k, v); else p.delete(k);
    setParams(p);
  };

  const chart = useQuery({
    queryKey: ['metric', selectedName, metric?.type, aggregation, service, groupBy, bounds.from, bounds.to],
    queryFn: () =>
      httpData.metric({
        metric: selectedName,
        type: metric!.type,
        aggregation,
        service: service || null,
        groupBy: groupBy || null,
        ...bounds,
      }),
    enabled: Boolean(metric),
    placeholderData: keepPreviousData,
    retry: quiet,
  });

  const needle = filter.toLowerCase();
  const visible = metrics.filter((m) => m.name.toLowerCase().includes(needle) || m.services.some((s) => s.toLowerCase().includes(needle)));
  const format = metric ? formatterForUnit(metric.unit, metric.name) : undefined;

  return (
    <>
      <PageHeader title="Metrics" actions={<TimeRangePicker value={range} onChange={setRange} />} />
      <PageBody className="flex flex-col gap-3 md:flex-row md:items-start">
        <Card className="flex flex-col gap-2 px-2 py-2 md:w-72 md:shrink-0">
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter metrics" aria-label="Filter metrics" />
          <div className="max-h-[220px] overflow-y-auto md:max-h-[calc(100dvh-180px)]" role="listbox" aria-label="Metrics">
            {names.isLoading ? (
              <Skeleton lines={8} className="p-2" />
            ) : names.error ? (
              <ErrorNote error={names.error} />
            ) : !visible.length ? (
              <p className="p-2 text-[12px] text-t3">No metrics in this range.</p>
            ) : (
              visible.map((m) => (
                <button
                  key={`${m.name}:${m.type}`}
                  type="button"
                  role="option"
                  aria-selected={isSelected(m)}
                  onClick={() => {
                    setDraftGroup('');
                    set({ metric: m.name, type: m.type, agg: defaultAggregation(m.type), service: '', groupBy: '' });
                  }}
                  className={cn(
                    'flex w-full flex-col rounded-lg px-2 py-1.5 text-left hover:bg-acdim',
                    isSelected(m) && 'bg-acdim',
                  )}
                >
                  <span className="truncate font-mono text-[12px] text-t1">{m.name}</span>
                  <span className="text-[11px] text-t3">
                    {m.type}
                    {m.unit ? ` · ${m.unit}` : ''}
                    {m.services.length ? ` · ${m.services.length > 2 ? `${m.services.length} services` : m.services.join(', ')}` : ''}
                  </span>
                </button>
              ))
            )}
          </div>
        </Card>
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          {!metric ? (
            <Card>
              <EmptyState icon={<ChartLine className="size-5" />} title="Pick a metric" hint="Every OpenTelemetry metric the collector stored in this range." />
            </Card>
          ) : (
            <>
              <Card className="flex flex-col gap-3">
                <div>
                  <h2 className="break-all font-mono text-[14px] font-semibold text-t1">{metric.name}</h2>
                  {metric.description && <p className="text-[12px] text-t2">{metric.description}</p>}
                </div>
                <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                  <Field label="Aggregation">
                    <Select value={aggregation} onChange={(e) => set({ agg: e.target.value })}>
                      {MetricAggregation.options.map((a) => (
                        <option key={a} value={a}>
                          {a}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Service">
                    <Select value={service} onChange={(e) => set({ service: e.target.value })}>
                      <option value="">All services</option>
                      {metric.services.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Group by" className="col-span-2 md:col-span-1">
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        set({ groupBy: draftGroup.trim() });
                      }}
                    >
                      <Input
                        value={draftGroup}
                        onChange={(e) => setDraftGroup(e.target.value)}
                        onBlur={() => draftGroup.trim() !== groupBy && set({ groupBy: draftGroup.trim() })}
                        placeholder="an attribute, e.g. http.route"
                        className="font-mono"
                      />
                    </form>
                  </Field>
                </div>
              </Card>
              <Card className="px-3">
                {chart.data ? (
                  <TimeSeriesChart data={chart.data} height={260} missing={null} format={format} />
                ) : chart.error ? (
                  <ErrorNote error={chart.error} />
                ) : (
                  <div className="h-[290px] animate-pulse-soft rounded-lg bg-nudim" />
                )}
              </Card>
            </>
          )}
        </div>
      </PageBody>
    </>
  );
}
