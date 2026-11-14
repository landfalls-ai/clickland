import { Fragment, useState, type ReactNode } from 'react';
import { ChevronRight, Waypoints } from 'lucide-react';
import type { LogRow } from '@clickland/contracts';
import { cn } from '../cn';
import { serviceColor, severityTone } from '../colors';
import { formatTime } from '../format';
import { Badge } from '../primitives/badge';
import { KeyValues, SectionLabel } from '../primitives/layout';

export interface LogTableProps {
  rows: LogRow[];
  /** Opens a trace (a link in the expanded row). */
  onOpenTrace?: (traceId: string) => void;
  /** Replaces the inline expansion: the console opens a drawer instead. */
  onSelect?: (row: LogRow) => void;
  /** The row the drawer shows, highlighted. */
  selected?: string;
  /** Adds `key:value` to the search (clicking an attribute). */
  onPick?: (key: string, value: string) => void;
  empty?: ReactNode;
  className?: string;
}

/**
 * Log rows: time, severity (coloured), service and body. A click expands the row to its attributes and resource. On
 * a phone each row is two lines (meta, then the body), so nothing scrolls sideways.
 */
export function LogTable({ rows, onOpenTrace, onSelect, selected, onPick, empty, className }: LogTableProps) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  if (!rows.length) return <div className="py-6 text-center text-[12px] text-t3">{empty ?? 'No log rows match.'}</div>;
  const toggle = (row: LogRow) => {
    if (onSelect) return onSelect(row);
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(row.cursor)) next.delete(row.cursor);
      else next.add(row.cursor);
      return next;
    });
  };
  return (
    <div
      className={cn('@container min-w-0 text-[12px]', className)}
      role="table"
      aria-label="Log rows"
      data-testid="log-table"
    >
      <div
        role="row"
        className="hidden h-8 items-center gap-3 border-b border-hair px-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3 @2xl:grid @2xl:grid-cols-[14px_96px_64px_minmax(80px,140px)_1fr]"
      >
        <span />
        <span role="columnheader">Time</span>
        <span role="columnheader">Level</span>
        <span role="columnheader">Service</span>
        <span role="columnheader">Body</span>
      </div>
      {rows.map((row) => {
        const expanded = !onSelect && open.has(row.cursor);
        return (
          <Fragment key={row.cursor}>
            <div
              role="row"
              tabIndex={0}
              aria-expanded={onSelect ? undefined : expanded}
              onClick={() => toggle(row)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  toggle(row);
                }
              }}
              className={cn(
                'grid cursor-pointer grid-cols-[14px_1fr] items-start gap-x-2 border-b border-hair px-2 py-1.5 outline-none hover:bg-acdim focus-visible:bg-acdim @2xl:grid-cols-[14px_96px_64px_minmax(80px,140px)_1fr] @2xl:gap-x-3',
                selected === row.cursor && 'bg-acdim',
                severityTone(row.severity) === 'danger' && 'shadow-[inset_2px_0_0_var(--rd)]',
              )}
            >
              <ChevronRight
                className={cn('mt-0.5 size-3.5 text-t3 transition-transform', expanded && 'rotate-90')}
                aria-hidden
              />
              {/* Phone: one meta line. @2xl: the cells themselves. */}
              <div className="flex min-w-0 items-center gap-2 @2xl:contents">
                <span role="cell" className="shrink-0 font-mono text-[11px] text-t3 @2xl:pt-px" title={row.timestamp}>
                  {formatTime(row.timestamp)}
                </span>
                <span role="cell" className="shrink-0">
                  <Badge tone={severityTone(row.severity)} className="uppercase">
                    {row.severity || '—'}
                  </Badge>
                </span>
                <span role="cell" className="flex min-w-0 items-center gap-1.5 truncate text-t2">
                  <span className="size-1.5 shrink-0 rounded-full" style={{ background: serviceColor(row.service) }} />
                  <span className="truncate">{row.service}</span>
                </span>
              </div>
              <span
                role="cell"
                className={cn(
                  'col-start-2 min-w-0 font-mono text-[12px] leading-snug text-t1 @2xl:col-start-auto',
                  expanded
                    ? 'whitespace-pre-wrap break-words'
                    : 'line-clamp-2 break-all @2xl:truncate @2xl:break-normal',
                )}
              >
                {row.body}
              </span>
            </div>
            {expanded && (
              <div role="row" className="border-b border-hair bg-sf2 px-3 py-3 @2xl:pl-8">
                <LogDetail row={row} onOpenTrace={onOpenTrace} onPick={onPick} />
              </div>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

/** A log row in full: the trace link, attributes and resource. */
export function LogDetail({
  row,
  onOpenTrace,
  onPick,
}: {
  row: LogRow;
  onOpenTrace?: (traceId: string) => void;
  onPick?: (key: string, value: string) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="log-detail">
      {row.traceId && (
        <div className="flex flex-wrap items-center gap-2 text-[12px]">
          <span className="text-t3">Trace</span>
          {onOpenTrace ? (
            <button
              type="button"
              onClick={() => onOpenTrace(row.traceId)}
              className="inline-flex items-center gap-1 font-mono text-ac hover:underline"
            >
              <Waypoints className="size-3.5" /> {row.traceId}
            </button>
          ) : (
            <span className="font-mono text-t1">{row.traceId}</span>
          )}
          {row.spanId && <span className="font-mono text-t3">span {row.spanId}</span>}
        </div>
      )}
      <div>
        <SectionLabel className="mb-1">Attributes</SectionLabel>
        <KeyValues values={row.attributes} onPick={onPick ? (k, v) => onPick(`attributes.${k}`, v) : undefined} />
      </div>
      <div>
        <SectionLabel className="mb-1">Resource</SectionLabel>
        <KeyValues values={row.resource} onPick={onPick ? (k, v) => onPick(`resource.${k}`, v) : undefined} />
      </div>
    </div>
  );
}
