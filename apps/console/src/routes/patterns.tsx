import { useState } from 'react';
import { useNavigate } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Shapes } from 'lucide-react';
import type { Signal } from '@clickland/contracts';
import { Button, Card, EmptyState, exampleQuery, PatternsList, Segmented, Select, Skeleton } from '@clickland/ui';
import { QueryError, SearchBox } from '@/components/search/search-box';
import { PageBody, PageHeader } from '@/components/shell/page-header';
import { TimeRangePicker } from '@/components/time-range-picker';
import { ApiError } from '@/lib/api';
import { httpData } from '@/lib/http-data';
import { useUrlRange } from './services';

/** /patterns : Drain templates over a search; a click searches the template's example. */
export function PatternsPage() {
  const navigate = useNavigate();
  const { range, bounds, setRange, refresh, params, setParams } = useUrlRange();
  const signal: Signal = params.get('signal') === 'traces' ? 'traces' : 'logs';
  // The search in the URL runs; the box is a draft until Find.
  const submitted = params.get('query');
  const [query, setQuery] = useState(submitted ?? 'level:error');
  const [sample, setSample] = useState(5000);
  const run = useQuery({
    queryKey: ['patterns', signal, submitted, sample, bounds.from, bounds.to],
    queryFn: () => httpData.patterns({ signal, query: submitted ?? '', ...bounds, sample }),
    enabled: submitted !== null,
    placeholderData: keepPreviousData,
    retry: false,
  });

  const submit = () => {
    const p = new URLSearchParams(params);
    p.set('query', query);
    p.set('signal', signal);
    setParams(p);
    refresh();
  };

  return (
    <>
      <PageHeader
        title="Patterns"
        actions={
          <Segmented
            label="Signal"
            value={signal}
            onChange={(s) => {
              const p = new URLSearchParams(params);
              p.set('signal', s);
              setParams(p);
            }}
            options={[
              { value: 'logs', label: 'Logs' },
              { value: 'traces', label: 'Traces' },
            ]}
          />
        }
      />
      <PageBody className="flex flex-col gap-3">
        <div className="flex flex-col gap-2 md:flex-row md:items-center">
          <SearchBox value={query} onChange={setQuery} onSubmit={submit} className="md:flex-1" invalid={run.error instanceof ApiError && run.error.status === 400} />
          <div className="flex items-center gap-2">
            <TimeRangePicker value={range} onChange={setRange} className="min-w-0 flex-1 md:flex-none" />
            <Select value={String(sample)} onChange={(e) => setSample(Number(e.target.value))} aria-label="Sample size" className="w-32">
              {[1000, 5000, 10000, 20000].map((n) => (
                <option key={n} value={n}>
                  {n.toLocaleString('en-US')} rows
                </option>
              ))}
            </Select>
            <Button variant="primary" onClick={submit} loading={run.isFetching}>
              Find
            </Button>
          </div>
        </div>
        {run.error && (
          <QueryError query={query} message={run.error.message} position={run.error instanceof ApiError ? run.error.position : undefined} />
        )}
        <Card>
          {run.isLoading ? (
            <Skeleton lines={8} />
          ) : run.data ? (
            <PatternsList
              patterns={run.data.patterns}
              meta={{ sampled: run.data.sampled, total: run.data.total }}
              onSelect={(p) =>
                navigate(`/search?${new URLSearchParams({ signal, query: exampleQuery(submitted ?? '', p.example), from: range.from, to: range.to })}`)
              }
            />
          ) : (
            <EmptyState
              icon={<Shapes className="size-5" />}
              title="Group a search into patterns"
              hint="Clickland mines templates (Drain) over a sample of the newest matching rows. Pick a search and press Find."
            />
          )}
        </Card>
      </PageBody>
    </>
  );
}
