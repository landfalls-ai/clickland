import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Search, Waypoints } from 'lucide-react';
import type { LogRow, SearchResponse } from '@clickland/contracts';
import {
  Card,
  EmptyState,
  ErrorNote,
  formatTime,
  LogTable,
  SectionLabel,
  Skeleton,
  TraceWaterfall,
} from '@clickland/ui';
import { PageBody, PageHeader } from '@/components/shell/page-header';
import { CopyButton } from '@/components/ui/copy-button';
import { ApiError, quiet, send } from '@/lib/api';
import { httpData } from '@/lib/http-data';

/** /traces/:id : the waterfall, the selected span's detail, and the trace's logs (`trace_id:<id>`). */
export function TracePage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [spanId, setSpanId] = useState<string | null>(null);
  const trace = useQuery({ queryKey: ['trace', id], queryFn: () => httpData.trace(id), retry: quiet });

  // The trace's logs, from a little before it started to a little after it ended.
  const logWindow = useMemo(() => {
    if (!trace.data) return null;
    const start = Date.parse(trace.data.startedAt);
    return {
      from: new Date(start - 5 * 60_000).toISOString(),
      to: new Date(start + trace.data.durationMs + 5 * 60_000).toISOString(),
    };
  }, [trace.data]);
  const logQuery = `trace_id:${id}`;
  const logs = useQuery({
    queryKey: ['trace-logs', id, logWindow?.from],
    queryFn: () =>
      send<SearchResponse<LogRow>>('POST', '/api/search', {
        signal: 'logs',
        query: logQuery,
        ...logWindow!,
        limit: 200,
      }),
    enabled: Boolean(logWindow),
    retry: quiet,
  });
  const spanLogs = spanId ? (logs.data?.rows ?? []).filter((r) => r.spanId === spanId) : logs.data?.rows;
  const searchHref = logWindow
    ? `/search?${new URLSearchParams({ signal: 'logs', query: logQuery, from: logWindow.from, to: logWindow.to })}`
    : '/search';

  return (
    <>
      <PageHeader
        title="Trace"
        meta={
          <span className="flex min-w-0 items-center gap-1 font-mono">
            <span className="truncate">{id}</span>
            <CopyButton text={id} label="Copy the trace id" />
          </span>
        }
        actions={
          trace.data && <span className="text-[12px] text-t3">{formatTime(trace.data.startedAt, { date: true })}</span>
        }
      />
      <PageBody className="flex flex-col gap-4">
        {trace.isLoading ? (
          <Skeleton lines={10} />
        ) : trace.error instanceof ApiError && trace.error.status === 404 ? (
          <EmptyState
            icon={<Waypoints className="size-5" />}
            title="No spans with this trace id"
            hint="It may not be ingested yet, or it is older than the retention."
          />
        ) : trace.error ? (
          <ErrorNote error={trace.error} />
        ) : (
          trace.data && (
            <Card className="px-3 py-3">
              <TraceWaterfall trace={trace.data} selected={spanId} onSelect={setSpanId} />
            </Card>
          )
        )}

        {trace.data && (
          <Card className="px-1.5 py-2">
            <div className="flex items-center gap-2 px-2 pb-2">
              <SectionLabel>{spanId ? 'Logs of the selected span' : 'Logs of this trace'}</SectionLabel>
              <Link
                to={searchHref}
                className="ml-auto inline-flex items-center gap-1 text-[12px] text-ac hover:underline"
              >
                <Search className="size-3.5" /> Open in Search
              </Link>
            </div>
            {logs.isLoading ? (
              <Skeleton lines={4} className="p-2" />
            ) : logs.error ? (
              <ErrorNote error={logs.error} className="m-2" />
            ) : (
              <LogTable
                rows={spanLogs ?? []}
                onOpenTrace={(t) => t !== id && navigate(`/traces/${t}`)}
                empty={spanId ? 'No logs from this span.' : 'No logs carry this trace id.'}
              />
            )}
          </Card>
        )}
      </PageBody>
    </>
  );
}
