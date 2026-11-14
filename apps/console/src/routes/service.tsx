import { useMemo } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import type { SeriesResponse, SpanRow } from '@clickland/contracts';
import {
  Card,
  ErrorNote,
  exampleQuery,
  formatCount,
  formatDuration,
  formatPercent,
  PatternsList,
  SectionLabel,
  Skeleton,
  SpanTable,
  Stat,
  TimeSeriesChart,
} from '@clickland/ui';
import { PageBody, PageHeader } from '@/components/shell/page-header';
import { TimeRangePicker } from '@/components/time-range-picker';
import { quiet } from '@/lib/api';
import { httpData } from '@/lib/http-data';
import { fieldClause } from '@/lib/search-query';
import { useUrlRange } from './services';

/** p95 per bucket from a sample of spans (until the histogram can aggregate a field). */
export function latencySeries(rows: SpanRow[], bucketSeconds: number, percentile = 0.95): SeriesResponse {
  const buckets = new Map<number, number[]>();
  for (const r of rows) {
    const t = Math.floor(Date.parse(r.timestamp) / 1000 / bucketSeconds) * bucketSeconds;
    buckets.set(t, [...(buckets.get(t) ?? []), r.durationMs]);
  }
  const points = [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([t, ds]): [string, number] => {
      const sorted = ds.sort((a, b) => a - b);
      return [new Date(t * 1000).toISOString(), sorted[Math.min(sorted.length - 1, Math.ceil(percentile * sorted.length) - 1)]!];
    });
  return { bucketSeconds, series: [{ key: `p${Math.round(percentile * 100)}`, points }] };
}

/** /services/:name : errors over time, latency p95, its top error patterns and recent error spans. */
export function ServicePage() {
  const { name = '' } = useParams();
  const navigate = useNavigate();
  const { range, bounds, setRange } = useUrlRange();
  const svc = fieldClause('service', name);
  const key = [name, bounds.from, bounds.to];

  const summary = useQuery({
    queryKey: ['services', bounds.from, bounds.to],
    queryFn: () => httpData.services(bounds),
    placeholderData: keepPreviousData,
    retry: quiet,
  });
  const me = summary.data?.find((s) => s.name === name);
  // While the summary loads the stats pulse; once loaded, a service with no spans in range reads "–".
  const none = summary.isLoading ? '…' : '–';

  const errors = useQuery({
    queryKey: ['service-errors', ...key],
    queryFn: async (): Promise<SeriesResponse> => {
      const [spans, logs] = await Promise.all([
        httpData.histogram({ signal: 'traces', query: `${svc} status:error`, ...bounds }),
        httpData.histogram({ signal: 'logs', query: `${svc} level:error`, ...bounds }),
      ]);
      const sum = (s: SeriesResponse) => s.series[0]?.points ?? [];
      return {
        bucketSeconds: spans.bucketSeconds,
        series: [
          { key: 'error spans', points: sum(spans) },
          { key: 'error logs', points: sum(logs) },
        ],
      };
    },
    placeholderData: keepPreviousData,
    retry: quiet,
  });
  const latency = useQuery({
    queryKey: ['service-latency', ...key],
    queryFn: async () => {
      const sample = await httpData.search({ signal: 'traces', query: svc, ...bounds, limit: 500 });
      const minutes = (Date.parse(bounds.to) - Date.parse(bounds.from)) / 60_000;
      const bucket = minutes <= 60 ? 60 : minutes <= 360 ? 300 : minutes <= 1440 ? 900 : 3600;
      return latencySeries(sample.rows as SpanRow[], bucket);
    },
    placeholderData: keepPreviousData,
    retry: quiet,
  });
  const patterns = useQuery({
    queryKey: ['service-patterns', ...key],
    // Error logs first; a service that logs no errors (most spans-only services) gets its error spans' patterns.
    queryFn: async () => {
      const logs = await httpData.patterns({ signal: 'logs', query: `${svc} level:error`, ...bounds, sample: 5000 });
      if (logs.patterns.length) return { ...logs, signal: 'logs' as const, query: `${svc} level:error` };
      const spans = await httpData.patterns({ signal: 'traces', query: `${svc} status:error`, ...bounds, sample: 5000 });
      return { ...spans, signal: 'traces' as const, query: `${svc} status:error` };
    },
    placeholderData: keepPreviousData,
    retry: quiet,
  });
  const errorSpans = useQuery({
    queryKey: ['service-error-spans', ...key],
    queryFn: () => httpData.search({ signal: 'traces', query: `${svc} status:error`, ...bounds, limit: 20 }),
    placeholderData: keepPreviousData,
    retry: quiet,
  });

  const search = useMemo(
    () => (signal: string, query: string) =>
      `/search?${new URLSearchParams({ signal, query, from: range.from, to: range.to })}`,
    [range.from, range.to],
  );

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Link to={`/services?${new URLSearchParams({ from: range.from, to: range.to })}`} aria-label="All services" className="text-t3 hover:text-t1">
              <ArrowLeft className="size-4" />
            </Link>
            {name}
          </span>
        }
        actions={<TimeRangePicker value={range} onChange={setRange} />}
      />
      <PageBody className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Card>
            <Stat label="Requests" value={me ? formatCount(me.requests) : none} />
          </Card>
          <Card>
            <Stat label="Error rate" value={me ? formatPercent(me.errorRate) : none} tone={me && me.errorRate >= 0.01 ? 'danger' : undefined} />
          </Card>
          <Card>
            <Stat label="p95" value={me ? formatDuration(me.p95Ms) : none} sub={me ? `p50 ${formatDuration(me.p50Ms)}` : undefined} />
          </Card>
          <Card>
            <Stat label="Log errors" value={me ? formatCount(me.logErrors) : none} tone={me && me.logErrors > 0 ? 'danger' : undefined} />
          </Card>
        </div>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <Card className="px-3">
            <div className="mb-1 flex items-center">
              <SectionLabel>Errors over time</SectionLabel>
              <Link to={search('traces', `${svc} status:error`)} className="ml-auto text-[12px] text-ac hover:underline">
                Search
              </Link>
            </div>
            {errors.data ? <TimeSeriesChart data={errors.data} height={170} range={bounds} /> : errors.error ? <ErrorNote error={errors.error} /> : <Skeleton lines={5} />}
          </Card>
          <Card className="px-3">
            <div className="mb-1 flex items-center gap-2">
              <SectionLabel>Latency p95</SectionLabel>
              <span className="text-[11px] text-t3">from the newest 500 spans</span>
            </div>
            {latency.data ? (
              <TimeSeriesChart data={latency.data} height={170} missing={null} format={formatDuration} />
            ) : latency.error ? (
              <ErrorNote error={latency.error} />
            ) : (
              <Skeleton lines={5} />
            )}
          </Card>
        </div>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <Card className="px-3">
            <div className="mb-1 flex items-center gap-2">
              <SectionLabel>Top error patterns</SectionLabel>
              {patterns.data && <span className="text-[11px] text-t3">{patterns.data.signal === 'logs' ? 'error logs' : 'error spans'}</span>}
            </div>
            {patterns.data ? (
              <PatternsList
                patterns={patterns.data.patterns.slice(0, 10)}
                meta={{ sampled: patterns.data.sampled, total: patterns.data.total }}
                onSelect={(p) => navigate(search(patterns.data.signal, exampleQuery(patterns.data.query, p.example)))}
              />
            ) : patterns.error ? (
              <ErrorNote error={patterns.error} />
            ) : (
              <Skeleton lines={5} />
            )}
          </Card>
          <Card className="px-1.5">
            <SectionLabel className="mb-1 px-2">Recent error spans</SectionLabel>
            {errorSpans.data ? (
              <SpanTable
                rows={errorSpans.data.rows as SpanRow[]}
                onSelect={(r) => navigate(`/traces/${r.traceId}`)}
                empty="No error spans in this range."
              />
            ) : errorSpans.error ? (
              <ErrorNote error={errorSpans.error} />
            ) : (
              <Skeleton lines={5} className="px-2" />
            )}
          </Card>
        </div>
      </PageBody>
    </>
  );
}
