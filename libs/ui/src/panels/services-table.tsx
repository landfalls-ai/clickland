import type { ServiceSummary } from '@clickland/contracts';
import { cn } from '../cn';
import { serviceColor } from '../colors';
import { formatCount, formatDuration, formatPercent } from '../format';

const rateTone = (rate: number) => (rate >= 0.05 ? 'var(--rd)' : rate >= 0.01 ? 'var(--warn)' : 'var(--gn)');

/** Services with their request count, error rate and latency percentiles. Cards on a phone, a table at md. */
export function ServicesTable({
  services,
  onSelect,
  className,
}: {
  services: ServiceSummary[];
  onSelect?: (name: string) => void;
  className?: string;
}) {
  if (!services.length)
    return <div className="py-6 text-center text-[12px] text-t3">No services sent spans in this range.</div>;
  const sorted = [...services].sort((a, b) => b.errorRate - a.errorRate || b.requests - a.requests);
  return (
    <div className={cn('@container min-w-0 text-[13px]', className)} role="table" aria-label="Services" data-testid="services-table">
      <div
        role="row"
        className="hidden h-9 items-center gap-3 border-b border-hair px-3 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3 @3xl:grid @3xl:grid-cols-[minmax(120px,1.4fr)_80px_minmax(120px,1fr)_72px_72px_72px_80px]"
      >
        <span role="columnheader">Service</span>
        <span role="columnheader" className="text-right">
          Requests
        </span>
        <span role="columnheader">Error rate</span>
        <span role="columnheader" className="text-right">
          p50
        </span>
        <span role="columnheader" className="text-right">
          p95
        </span>
        <span role="columnheader" className="text-right">
          p99
        </span>
        <span role="columnheader" className="text-right">
          Log errors
        </span>
      </div>
      {sorted.map((s) => (
        <div
          key={s.name}
          role="row"
          tabIndex={onSelect ? 0 : undefined}
          onClick={onSelect ? () => onSelect(s.name) : undefined}
          onKeyDown={onSelect ? (e) => e.key === 'Enter' && onSelect(s.name) : undefined}
          className={cn(
            'grid grid-cols-2 items-center gap-x-3 gap-y-1 border-b border-hair px-3 py-2.5 outline-none last:border-0 @3xl:grid-cols-[minmax(120px,1.4fr)_80px_minmax(120px,1fr)_72px_72px_72px_80px] @3xl:py-2',
            onSelect && 'cursor-pointer hover:bg-acdim focus-visible:bg-acdim',
          )}
        >
          <span role="cell" className="col-span-2 flex min-w-0 items-center gap-2 font-semibold text-t1 @3xl:col-span-1">
            <span className="size-2 shrink-0 rounded-full" style={{ background: serviceColor(s.name) }} />
            <span className="truncate">{s.name}</span>
          </span>
          <Metric label="Requests" value={formatCount(s.requests)} />
          <span role="cell" className="col-span-2 flex items-center gap-2 @3xl:col-span-1">
            <span className="text-[11px] text-t3 @3xl:hidden">Errors</span>
            <span className="h-1.5 min-w-10 flex-1 overflow-hidden rounded-full bg-nudim">
              <span
                className="block h-full rounded-full"
                style={{ width: `${Math.min(100, Math.max(s.errorRate > 0 ? 3 : 0, s.errorRate * 100))}%`, background: rateTone(s.errorRate) }}
              />
            </span>
            <span className="w-12 text-right font-mono text-[12px]" style={{ color: s.errorRate >= 0.01 ? rateTone(s.errorRate) : undefined }}>
              {formatPercent(s.errorRate)}
            </span>
          </span>
          <Metric label="p50" value={s.requests ? formatDuration(s.p50Ms) : '–'} />
          <Metric label="p95" value={s.requests ? formatDuration(s.p95Ms) : '–'} strong />
          <Metric label="p99" value={s.requests ? formatDuration(s.p99Ms) : '–'} />
          <Metric label="Log errors" value={formatCount(s.logErrors)} danger={s.logErrors > 0} />
        </div>
      ))}
    </div>
  );
}

function Metric({ label, value, strong, danger }: { label: string; value: string; strong?: boolean; danger?: boolean }) {
  return (
    <span role="cell" className="flex items-baseline justify-between gap-2 @3xl:block @3xl:text-right">
      <span className="text-[11px] text-t3 @3xl:hidden">{label}</span>
      <span className={cn('font-mono text-[12px] text-t2', strong && 'font-semibold text-t1', danger && 'text-rd')}>{value}</span>
    </span>
  );
}
