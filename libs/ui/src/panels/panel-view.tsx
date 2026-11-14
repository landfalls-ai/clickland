import type { ReactNode } from 'react';
import {
  Activity,
  BarChart3,
  Bot,
  CircleDollarSign,
  ExternalLink,
  FileText,
  Hash,
  LineChart,
  ListTree,
  type LucideIcon,
  Rows3,
  Server,
  Shapes,
  Waypoints,
  Workflow,
} from 'lucide-react';
import type { LogRow, Panel, SpanRow } from '@clickland/contracts';
import { cn } from '../cn';
import { totals } from '../charts/align';
import { BarChart } from '../charts/bar-chart';
import { TimeSeriesChart } from '../charts/time-series-chart';
import type { DataSource, PanelLinks } from '../data';
import { formatBytes, formatCount, formatDuration } from '../format';
import { Card, ErrorNote, Skeleton } from '../primitives/layout';
import type { TimeBounds } from '../time';
import { useLoad } from '../use-load';
import { LogTable } from './log-table';
import { Markdown } from './markdown';
import { PatternsList } from './patterns-list';
import { ServicesTable } from './services-table';
import { SpanTable } from './span-table';
import { Stat } from './stat';
import { TraceWaterfall } from './trace-waterfall';

export type PanelType = Panel['type'];

/** Each panel type's name and icon (the editor's type picker uses them too). */
export const PANEL_TYPES: Record<PanelType, { label: string; icon: LucideIcon; hint: string }> = {
  timeseries: {
    label: 'Time series',
    icon: LineChart,
    hint: 'Rows over time, optionally one line per value of a field',
  },
  bar: { label: 'Bar chart', icon: BarChart3, hint: 'Rows per value of a field' },
  stat: { label: 'Stat', icon: Hash, hint: 'How many rows match' },
  logs: { label: 'Logs', icon: Rows3, hint: 'The newest matching log rows' },
  spans: { label: 'Spans', icon: Activity, hint: 'The newest matching spans' },
  trace: { label: 'Trace', icon: Waypoints, hint: 'One trace as a waterfall' },
  services: { label: 'Services', icon: Server, hint: 'Requests, error rate and latency per service' },
  patterns: { label: 'Patterns', icon: Shapes, hint: 'Log lines grouped into templates' },
  metric: { label: 'Metric', icon: ListTree, hint: 'An OpenTelemetry metric over time' },
  markdown: { label: 'Text', icon: FileText, hint: 'Notes in Markdown' },
  agents: { label: 'Agents', icon: Bot, hint: 'The AI agents seen in telemetry: runs, success, latency, cost' },
  agent_value: { label: 'Agent value', icon: CircleDollarSign, hint: 'Net value, ROI and cost of the AI agents' },
  run_graph: { label: 'Run graph', icon: Workflow, hint: "One agent run's decision path" },
};

export interface PanelViewProps {
  panel: Panel;
  range: TimeBounds;
  data: DataSource;
  links?: PanelLinks;
  /** Bump to reload (relative ranges refresh on a timer). */
  refresh?: number;
  /** Extra controls in the header (the editor's buttons). */
  actions?: ReactNode;
  className?: string;
}

/** One panel of a view: a card with the title and the body its type draws, fetched through `data`. */
export function PanelView({ panel, range, data, links, refresh = 0, actions, className }: PanelViewProps) {
  const meta = PANEL_TYPES[panel.type];
  const Icon = meta?.icon ?? FileText;
  const open = openLink(panel, links);
  return (
    <Card className={cn('flex min-w-0 flex-col gap-2.5 px-3.5 py-3', className)} testId={`panel-${panel.type}`}>
      <header className="flex min-h-7 items-center gap-2">
        <Icon className="size-3.5 shrink-0 text-t3" strokeWidth={1.8} aria-hidden />
        <h3 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-t1" title={panel.title}>
          {panel.title}
        </h3>
        {open && (
          <button
            type="button"
            onClick={open.go}
            title={open.label}
            aria-label={open.label}
            className="grid size-7 shrink-0 place-items-center rounded-full text-t3 hover:bg-acdim hover:text-ac"
          >
            <ExternalLink className="size-3.5" />
          </button>
        )}
        {actions}
      </header>
      <PanelBody panel={panel} range={range} data={data} links={links} refresh={refresh} />
    </Card>
  );
}

function openLink(panel: Panel, links?: PanelLinks): { label: string; go: () => void } | null {
  if (!links) return null;
  if (panel.type === 'trace' && links.openTrace)
    return { label: 'Open the trace', go: () => links.openTrace!(panel.traceId) };
  if (!links.openSearch) return null;
  switch (panel.type) {
    case 'timeseries':
    case 'bar':
    case 'stat':
    case 'patterns':
      return {
        label: 'Open in Search',
        go: () => links.openSearch!({ signal: panel.signal ?? 'logs', query: panel.query ?? '' }),
      };
    case 'logs':
      return { label: 'Open in Search', go: () => links.openSearch!({ signal: 'logs', query: panel.query ?? '' }) };
    case 'spans':
      return { label: 'Open in Search', go: () => links.openSearch!({ signal: 'traces', query: panel.query ?? '' }) };
    default:
      return null;
  }
}

type BodyProps = Omit<PanelViewProps, 'actions' | 'className'> & { refresh: number };

/** The panel's body without its card (for embedding a panel's content elsewhere). */
export function PanelBody(props: BodyProps) {
  const { panel } = props;
  switch (panel.type) {
    case 'timeseries':
      return <TimeseriesBody {...props} panel={panel} />;
    case 'bar':
      return <BarBody {...props} panel={panel} />;
    case 'stat':
      return <StatBody {...props} panel={panel} />;
    case 'logs':
      return <LogsBody {...props} panel={panel} />;
    case 'spans':
      return <SpansBody {...props} panel={panel} />;
    case 'trace':
      return <TraceBody {...props} panel={panel} />;
    case 'services':
      return <ServicesBody {...props} />;
    case 'patterns':
      return <PatternsBody {...props} panel={panel} />;
    case 'metric':
      return <MetricBody {...props} panel={panel} />;
    case 'markdown':
      return <Markdown text={panel.text} />;
    default:
      return <p className="text-[12px] text-t3">This panel type isn’t supported here.</p>;
  }
}

type Of<T extends PanelType> = Extract<Panel, { type: T }>;
type Typed<T extends PanelType> = Omit<BodyProps, 'panel'> & { panel: Of<T> };

const keyOf = (panel: Panel, range: TimeBounds, refresh: number, extra: unknown = null) => {
  const { title: _t, width: _w, id: _id, ...query } = panel;
  return JSON.stringify([query, range.from, range.to, refresh, extra]);
};

function Loading<T>({
  state,
  lines = 4,
  height,
  children,
}: {
  state: { data: T | undefined; error: Error | undefined; loading: boolean };
  lines?: number;
  height?: number;
  children: (data: T) => ReactNode;
}) {
  if (state.error && state.data === undefined) return <ErrorNote error={state.error} />;
  if (state.data === undefined)
    return height ? (
      <div
        style={{ height }}
        className="animate-pulse-soft rounded-lg bg-nudim"
        aria-busy="true"
        aria-label="Loading"
      />
    ) : (
      <Skeleton lines={lines} />
    );
  return (
    <div className={cn('min-w-0 transition-opacity', state.loading && 'opacity-70')}>
      {state.error && <ErrorNote error={state.error} className="mb-2" />}
      {children(state.data)}
    </div>
  );
}

function TimeseriesBody({ panel, range, data, refresh }: Typed<'timeseries'>) {
  const state = useLoad(keyOf(panel, range, refresh), () =>
    data.histogram({
      signal: panel.signal ?? 'logs',
      query: panel.query ?? '',
      groupBy: panel.groupBy ?? null,
      ...range,
    }),
  );
  return (
    <Loading state={state} height={200}>
      {(d) => <TimeSeriesChart data={d} kind={panel.groupBy ? 'line' : 'bars'} height={180} range={range} />}
    </Loading>
  );
}

function BarBody({ panel, range, data, refresh }: Typed<'bar'>) {
  const state = useLoad(keyOf(panel, range, refresh), () =>
    data.histogram({ signal: panel.signal ?? 'logs', query: panel.query ?? '', groupBy: panel.groupBy, ...range }),
  );
  return (
    <Loading state={state} height={200}>
      {(d) => (
        <BarChart
          items={totals(d.series)
            .map((t) => ({ label: t.key, value: t.value }))
            .sort((a, b) => b.value - a.value)}
        />
      )}
    </Loading>
  );
}

function StatBody({ panel, range, data, refresh }: Typed<'stat'>) {
  const state = useLoad(keyOf(panel, range, refresh), () =>
    data.total({ signal: panel.signal ?? 'logs', query: panel.query ?? '', ...range }),
  );
  return (
    <Loading state={state} lines={2}>
      {(n) => (
        <Stat
          value={formatCount(n)}
          sub={
            <span className="font-mono">
              {panel.signal === 'traces' ? 'spans' : 'log rows'}
              {panel.query ? ` · ${panel.query}` : ''}
            </span>
          }
        />
      )}
    </Loading>
  );
}

function LogsBody({ panel, range, data, refresh, links }: Typed<'logs'>) {
  const state = useLoad(keyOf(panel, range, refresh), () =>
    data.search({ signal: 'logs', query: panel.query ?? '', limit: panel.limit ?? 25, ...range }),
  );
  return (
    <Loading state={state} lines={6}>
      {(d) => (
        <div className="-mx-1.5 max-h-[420px] overflow-y-auto">
          <LogTable rows={d.rows as LogRow[]} onOpenTrace={links?.openTrace} />
        </div>
      )}
    </Loading>
  );
}

function SpansBody({ panel, range, data, refresh, links }: Typed<'spans'>) {
  const state = useLoad(keyOf(panel, range, refresh), () =>
    data.search({ signal: 'traces', query: panel.query ?? '', limit: panel.limit ?? 25, ...range }),
  );
  return (
    <Loading state={state} lines={6}>
      {(d) => (
        <div className="-mx-1.5 max-h-[420px] overflow-y-auto">
          <SpanTable
            rows={d.rows as SpanRow[]}
            onSelect={links?.openTrace ? (row) => links.openTrace!(row.traceId) : undefined}
          />
        </div>
      )}
    </Loading>
  );
}

function TraceBody({ panel, data, refresh }: Typed<'trace'>) {
  const state = useLoad(JSON.stringify([panel.traceId, refresh]), () => data.trace(panel.traceId));
  return (
    <Loading state={state} lines={6}>
      {(trace) => <TraceWaterfall trace={trace} />}
    </Loading>
  );
}

function ServicesBody({ panel, range, data, refresh, links }: BodyProps) {
  const state = useLoad(keyOf(panel, range, refresh), () => data.services(range));
  return (
    <Loading state={state} lines={5}>
      {(services) => <ServicesTable services={services} onSelect={links?.openService} className="-mx-1.5" />}
    </Loading>
  );
}

function PatternsBody({ panel, range, data, refresh, links }: Typed<'patterns'>) {
  const state = useLoad(keyOf(panel, range, refresh), () =>
    data.patterns({ signal: panel.signal ?? 'logs', query: panel.query ?? '', ...range }),
  );
  const signal = panel.signal ?? 'logs';
  return (
    <Loading state={state} lines={5}>
      {(d) => (
        <div className="max-h-[420px] overflow-y-auto">
          <PatternsList
            patterns={d.patterns}
            meta={{ sampled: d.sampled, total: d.total }}
            onSelect={
              links?.openSearch
                ? (p) => links.openSearch!({ signal, query: exampleQuery(panel.query ?? '', p.example) })
                : undefined
            }
          />
        </div>
      )}
    </Loading>
  );
}

/** A search for a pattern's example: the panel's query and the example as a phrase. */
export function exampleQuery(query: string, example: string): string {
  const phrase = `"${example.slice(0, 300).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return query.trim() ? `${query.trim()} ${phrase}` : phrase;
}

function MetricBody({ panel, range, data, refresh }: Typed<'metric'>) {
  const state = useLoad(keyOf(panel, range, refresh), () =>
    data.metric({
      metric: panel.metric,
      type: panel.metricType,
      aggregation: panel.aggregation,
      service: panel.service ?? null,
      groupBy: panel.groupBy ?? null,
      ...range,
    }),
  );
  const latency = /^p\d\d$/.test(panel.aggregation) || /duration|latency/i.test(panel.metric);
  return (
    <Loading state={state} height={200}>
      {(d) => (
        <TimeSeriesChart
          data={d}
          missing={null}
          height={180}
          format={
            latency && /duration|latency|time/i.test(panel.metric)
              ? formatDuration
              : /memory|bytes|filesystem|\.size\b|heap/i.test(panel.metric) &&
                  !/fault|percent|utilization/i.test(panel.metric)
                ? formatBytes
                : formatCount
          }
        />
      )}
    </Loading>
  );
}
