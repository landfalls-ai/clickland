import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Filter, Pause, Play, Radio, RefreshCw, Waypoints } from 'lucide-react';
import type { LogRow, SearchResponse, SeriesResponse, Signal, SpanRow } from '@clickland/contracts';
import {
  Button,
  Card,
  formatCount,
  Input,
  LogDetail,
  LogTable,
  Segmented,
  Skeleton,
  SpanDetail,
  SpanTable,
  TimeSeriesChart,
} from '@clickland/ui';
import { Facets } from '@/components/search/facets';
import { QueryError, SearchBox } from '@/components/search/search-box';
import { PageBody, PageHeader } from '@/components/shell/page-header';
import { TimeRangePicker } from '@/components/time-range-picker';
import { Drawer } from '@/components/ui/dialog';
import { ApiError, quiet, send } from '@/lib/api';
import { useFacets } from '@/lib/queries';
import { addClause } from '@/lib/search-query';
import { isRelative, rangeFromParams, relativeOf, resolve, type TimeRange } from '@/lib/time';

const PAGE = 100;

/** /search?signal=&query=&from=&to=&groupBy= : logs or traces, with a histogram, facets, infinite scroll and live tail. */
export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const signal: Signal = params.get('signal') === 'traces' ? 'traces' : 'logs';
  const query = params.get('query') ?? '';
  const groupBy = params.get('groupBy') ?? '';
  const range = rangeFromParams(params);
  const [draft, setDraft] = useState(query);
  const [draftGroup, setDraftGroup] = useState(groupBy);
  const [runAt, setRunAt] = useState(() => Date.now());
  const [live, setLive] = useState(false);
  const [selected, setSelected] = useState<LogRow | SpanRow | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [lastQuery, setLastQuery] = useState(query);

  // Back/forward changes the query string: the box follows it.
  if (lastQuery !== query) {
    setLastQuery(query);
    setDraft(query);
  }

  const { from: rangeFrom, to: rangeTo } = range;
  const bounds = useMemo(() => resolve({ from: rangeFrom, to: rangeTo }, runAt), [rangeFrom, rangeTo, runAt]);
  const facetBounds = useMemo(
    () => ({
      from: new Date(Math.floor(Date.parse(bounds.from) / 60_000) * 60_000).toISOString(),
      to: new Date(Math.ceil(Date.parse(bounds.to) / 60_000) * 60_000).toISOString(),
    }),
    [bounds.from, bounds.to],
  );

  const update = (next: Partial<{ signal: Signal; query: string; from: string; to: string; groupBy: string }>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v === undefined || v === '') p.delete(k);
      else p.set(k, v);
    }
    if (!p.get('signal')) p.set('signal', signal);
    if (!p.get('from')) p.set('from', range.from);
    if (!p.get('to')) p.set('to', range.to);
    setParams(p);
    setRunAt(Date.now());
  };

  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setRunAt(Date.now()), 2000);
    return () => clearInterval(id);
  }, [live]);

  const toggleLive = () => {
    if (!live && !isRelative(range)) update({ from: relativeOf(range, Date.now()), to: 'now' });
    setLive(!live);
  };

  const results = useInfiniteQuery({
    queryKey: ['search', signal, query, bounds.from, bounds.to],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal: abort }) =>
      send<SearchResponse>('POST', '/api/search', { signal, query, ...bounds, limit: PAGE, before: pageParam }).catch(
        (e: unknown) => {
          if (abort.aborted) throw new DOMException('aborted', 'AbortError');
          throw e;
        },
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    retry: quiet,
  });
  const histogram = useQuery({
    queryKey: ['histogram', signal, query, bounds.from, bounds.to, groupBy],
    queryFn: () =>
      send<SeriesResponse>('POST', '/api/search/histogram', { signal, query, ...bounds, groupBy: groupBy || null }),
    placeholderData: keepPreviousData,
    retry: quiet,
  });
  const facets = useFacets(signal, facetBounds);

  const rows = useMemo(() => results.data?.pages.flatMap((p) => p.rows) ?? [], [results.data]);
  const stats = results.data?.pages[0]?.stats;
  const syntax = results.error instanceof ApiError && results.error.status === 400 ? results.error : null;

  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || live || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && results.hasNextPage && !results.isFetchingNextPage)
          void results.fetchNextPage();
      },
      { rootMargin: '400px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [results, live]);

  const pick = (field: string, value: string, exclude = false) => {
    const q = addClause(query, field, value, exclude);
    setDraft(q);
    update({ query: q });
    setFiltersOpen(false);
  };

  const openTrace = (traceId: string) => navigate(`/traces/${traceId}`);
  const facetsBody = (
    <Facets fields={facets.data?.fields} loading={facets.isLoading} error={facets.error} onPick={pick} />
  );

  return (
    <>
      <PageHeader
        title="Search"
        actions={
          <>
            <Segmented
              label="Signal"
              value={signal}
              onChange={(s) => {
                setSelected(null);
                update({ signal: s, groupBy: '' });
                setDraftGroup('');
              }}
              options={[
                { value: 'logs', label: 'Logs' },
                { value: 'traces', label: 'Traces' },
              ]}
            />
            <Button
              size="sm"
              variant={live ? 'primary' : 'outline'}
              onClick={toggleLive}
              aria-pressed={live}
              title="Live tail: refresh every 2 seconds"
            >
              {live ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
              Live
            </Button>
          </>
        }
      />
      <PageBody className="flex flex-col gap-3">
        <div className="flex flex-col gap-2 md:flex-row md:items-center">
          <SearchBox
            value={draft}
            onChange={setDraft}
            onSubmit={() => update({ query: draft.trim() })}
            invalid={Boolean(syntax)}
            className="md:flex-1"
            placeholder={
              signal === 'traces' ? 'service:api duration:>500 status:error' : 'level:error service:api timeout'
            }
          />
          <div className="flex items-center gap-2">
            <TimeRangePicker
              value={range}
              onChange={(r: TimeRange) => {
                if (!isRelative(r)) setLive(false);
                update({ from: r.from, to: r.to });
              }}
              className="min-w-0 flex-1 md:flex-none"
            />
            <Button variant="primary" onClick={() => update({ query: draft.trim() })} aria-label="Run the search">
              <RefreshCw className="size-3.5 md:hidden" />
              <span className="hidden md:inline">Search</span>
            </Button>
            <Button className="md:hidden" onClick={() => setFiltersOpen(true)} aria-label="Filters">
              <Filter className="size-3.5" />
            </Button>
          </div>
        </div>
        {syntax && <QueryError query={query} message={syntax.message} position={syntax.position} />}
        {!syntax && results.error && <QueryError query={query} message={results.error.message} />}

        <Card className="px-3 py-2.5">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className="text-[12px] font-semibold text-t2">
              {signal === 'logs' ? 'Log rows' : 'Spans'} over time
            </span>
            {live && (
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-gn">
                <Radio className="size-3 animate-pulse-soft" /> live
              </span>
            )}
            <form
              className="ml-auto flex items-center gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                update({ groupBy: draftGroup.trim() });
              }}
            >
              <label htmlFor="group-by" className="text-[12px] text-t3">
                Group by
              </label>
              <Input
                id="group-by"
                list="facet-fields"
                value={draftGroup}
                onChange={(e) => setDraftGroup(e.target.value)}
                onBlur={() => draftGroup.trim() !== groupBy && update({ groupBy: draftGroup.trim() })}
                placeholder="service"
                className="h-7 w-32 font-mono text-[12px] md:w-40"
              />
              <datalist id="facet-fields">
                {[
                  'service',
                  signal === 'logs' ? 'level' : 'status',
                  ...(facets.data?.fields.map((f) => f.field) ?? []),
                ].map((f) => (
                  <option key={f} value={f} />
                ))}
              </datalist>
            </form>
          </div>
          {histogram.data ? (
            <TimeSeriesChart
              data={histogram.data}
              kind="bars"
              height={140}
              range={bounds}
              onZoom={(from, to) => {
                setLive(false);
                update({ from: new Date(from).toISOString(), to: new Date(to).toISOString() });
              }}
            />
          ) : histogram.error ? (
            <p className="py-6 text-center text-[12px] text-t3">{histogram.error.message}</p>
          ) : (
            <div className="h-[170px] animate-pulse-soft rounded-lg bg-nudim" />
          )}
        </Card>

        <div className="flex min-w-0 gap-4">
          <aside className="hidden w-56 shrink-0 md:block" aria-label="Facets">
            <div className="sticky top-[64px] max-h-[calc(100dvh-80px)] overflow-y-auto pr-1">{facetsBody}</div>
          </aside>
          <Card className="min-w-0 flex-1 px-1.5 py-1.5">
            <div className="flex items-center gap-2 px-2 pb-1.5 pt-1 text-[12px] text-t3">
              <span>
                <span className="font-semibold text-t1">{formatCount(rows.length)}</span>
                {results.hasNextPage && !live ? '+' : ''} {signal === 'logs' ? 'rows' : 'spans'}
              </span>
              {stats && (
                <span className="hidden md:inline">
                  · read {formatCount(stats.rowsRead)} rows in {stats.elapsedMs} ms
                </span>
              )}
              {results.isFetching && <span className="ml-auto animate-pulse-soft">loading…</span>}
            </div>
            {!results.data && results.isLoading ? (
              <Skeleton lines={10} className="p-2" />
            ) : signal === 'logs' ? (
              <LogTable
                rows={rows as LogRow[]}
                onSelect={setSelected}
                selected={selected?.cursor}
                empty="No log rows match. Widen the time range or loosen the search."
              />
            ) : (
              <SpanTable
                rows={rows as SpanRow[]}
                onSelect={setSelected}
                selected={selected?.cursor}
                empty="No spans match. Widen the time range or loosen the search."
              />
            )}
            <div ref={sentinel} />
            {results.hasNextPage && !live && (
              <div className="flex justify-center py-3">
                <Button size="sm" onClick={() => void results.fetchNextPage()} loading={results.isFetchingNextPage}>
                  Load more
                </Button>
              </div>
            )}
          </Card>
        </div>
      </PageBody>

      {filtersOpen && (
        <Drawer title="Filters" onClose={() => setFiltersOpen(false)}>
          {facetsBody}
        </Drawer>
      )}
      {selected && (
        <Drawer
          title={
            'body' in selected ? `${selected.service} · ${selected.severity}` : `${selected.service} · ${selected.name}`
          }
          onClose={() => setSelected(null)}
          actions={
            selected.traceId ? (
              <Button size="sm" onClick={() => openTrace(selected.traceId)}>
                <Waypoints className="size-3.5" /> Trace
              </Button>
            ) : undefined
          }
        >
          {'body' in selected ? (
            <div className="flex flex-col gap-3">
              <pre className="whitespace-pre-wrap break-words rounded-lg bg-sf2 p-2.5 font-mono text-[12px] text-t1">
                {selected.body}
              </pre>
              <LogDetail row={selected} onOpenTrace={openTrace} onPick={(k, v) => pick(k, v)} />
            </div>
          ) : (
            <SpanDetail span={selected} />
          )}
        </Drawer>
      )}
    </>
  );
}
