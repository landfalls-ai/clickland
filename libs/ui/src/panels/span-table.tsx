import type { ReactNode } from 'react';
import type { SpanRow } from '@clickland/contracts';
import { cn } from '../cn';
import { isErrorStatus, serviceColor } from '../colors';
import { formatDuration, formatTime } from '../format';
import { Badge } from '../primitives/badge';

/** Span rows: time, service, name, duration (with a bar against the slowest) and status. */
export function SpanTable({
  rows,
  onSelect,
  selected,
  empty,
  className,
}: {
  rows: SpanRow[];
  /** A click: the console opens the trace or a drawer. */
  onSelect?: (row: SpanRow) => void;
  selected?: string;
  empty?: ReactNode;
  className?: string;
}) {
  if (!rows.length) return <div className="py-6 text-center text-[12px] text-t3">{empty ?? 'No spans match.'}</div>;
  const slowest = Math.max(...rows.map((r) => r.durationMs), 0.001);
  return (
    <div
      className={cn('@container min-w-0 text-[12px]', className)}
      role="table"
      aria-label="Spans"
      data-testid="span-table"
    >
      <div
        role="row"
        className="hidden h-8 items-center gap-3 border-b border-hair px-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3 @2xl:grid @2xl:grid-cols-[96px_minmax(80px,140px)_1fr_120px_64px]"
      >
        <span role="columnheader">Time</span>
        <span role="columnheader">Service</span>
        <span role="columnheader">Span</span>
        <span role="columnheader">Duration</span>
        <span role="columnheader">Status</span>
      </div>
      {rows.map((row) => {
        const error = isErrorStatus(row.status);
        return (
          <div
            key={row.cursor}
            role="row"
            tabIndex={onSelect ? 0 : undefined}
            onClick={onSelect ? () => onSelect(row) : undefined}
            onKeyDown={
              onSelect
                ? (e) => {
                    if (e.key === 'Enter') onSelect(row);
                  }
                : undefined
            }
            className={cn(
              'grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-0.5 border-b border-hair px-2 py-1.5 outline-none @2xl:grid-cols-[96px_minmax(80px,140px)_1fr_120px_64px]',
              onSelect && 'cursor-pointer hover:bg-acdim focus-visible:bg-acdim',
              selected === row.cursor && 'bg-acdim',
              error && 'shadow-[inset_2px_0_0_var(--rd)]',
            )}
          >
            <div className="flex min-w-0 items-center gap-2 @2xl:contents">
              <span role="cell" className="shrink-0 font-mono text-[11px] text-t3">
                {formatTime(row.timestamp)}
              </span>
              <span role="cell" className="flex min-w-0 items-center gap-1.5 text-t2">
                <span className="size-1.5 shrink-0 rounded-full" style={{ background: serviceColor(row.service) }} />
                <span className="truncate">{row.service}</span>
              </span>
            </div>
            <span
              role="cell"
              className="row-start-2 min-w-0 truncate font-mono text-t1 @2xl:row-start-auto"
              title={row.name}
            >
              {row.name}
            </span>
            <span role="cell" className="row-span-2 flex items-center gap-2 @2xl:row-span-1">
              <span className="hidden h-1.5 flex-1 overflow-hidden rounded-full bg-nudim @2xl:block">
                <span
                  className="block h-full rounded-full"
                  style={{
                    width: `${Math.max(2, (row.durationMs / slowest) * 100)}%`,
                    background: error ? 'var(--rd)' : serviceColor(row.service),
                  }}
                />
              </span>
              <span className="font-mono text-[11px] text-t1">{formatDuration(row.durationMs)}</span>
            </span>
            <span role="cell" className="hidden @2xl:block">
              {error ? <Badge tone="danger">error</Badge> : <span className="text-t3">{row.status || 'unset'}</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}
