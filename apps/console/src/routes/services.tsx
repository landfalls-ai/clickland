import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Card, ErrorNote, ServicesTable, Skeleton } from '@clickland/ui';
import { PageBody, PageHeader } from '@/components/shell/page-header';
import { TimeRangePicker } from '@/components/time-range-picker';
import { quiet } from '@/lib/api';
import { httpData } from '@/lib/http-data';
import { rangeFromParams, resolve } from '@/lib/time';

/** The range in the URL with a setter that keeps the other parameters (Services, Metrics, Patterns, a service). */
export function useUrlRange() {
  const [params, setParams] = useSearchParams();
  const range = rangeFromParams(params);
  const [runAt, setRunAt] = useState(() => Date.now());
  const { from, to } = range;
  const bounds = useMemo(() => resolve({ from, to }, runAt), [from, to, runAt]);
  const setRange = (r: { from: string; to: string }) => {
    const p = new URLSearchParams(params);
    p.set('from', r.from);
    p.set('to', r.to);
    setParams(p);
    setRunAt(Date.now());
  };
  return { range, bounds, setRange, refresh: () => setRunAt(Date.now()), params, setParams };
}

/** Services from spans: requests, error rate and latency; a click opens the service. */
export function ServicesPage() {
  const navigate = useNavigate();
  const { range, bounds, setRange, params } = useUrlRange();
  const services = useQuery({
    queryKey: ['services', bounds.from, bounds.to],
    queryFn: () => httpData.services(bounds),
    placeholderData: keepPreviousData,
    retry: quiet,
    refetchInterval: 30_000,
  });
  return (
    <>
      <PageHeader title="Services" actions={<TimeRangePicker value={range} onChange={setRange} />} />
      <PageBody>
        <Card className="px-1.5 py-1">
          {services.isLoading ? (
            <Skeleton lines={6} className="p-2" />
          ) : services.error ? (
            <ErrorNote error={services.error} className="m-2" />
          ) : (
            <ServicesTable
              services={services.data ?? []}
              onSelect={(name) =>
                navigate(
                  `/services/${encodeURIComponent(name)}?${new URLSearchParams({ from: params.get('from') ?? range.from, to: params.get('to') ?? range.to })}`,
                )
              }
            />
          )}
        </Card>
      </PageBody>
    </>
  );
}
