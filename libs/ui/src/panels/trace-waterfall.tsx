import { useMemo, useState } from 'react';
import { ChevronRight, X } from 'lucide-react';
import type { SpanRow, TraceResponse } from '@clickland/contracts';
import { cn } from '../cn';
import { isErrorStatus, serviceColor } from '../colors';
import { formatDuration, formatTime } from '../format';
import { Badge } from '../primitives/badge';
import { Button } from '../primitives/button';
import { KeyValues, SectionLabel } from '../primitives/layout';

export type TraceSpan = SpanRow & { depth?: number; offsetMs?: number };

export interface OrderedSpan {
  span: TraceSpan;
  depth: number;
  offsetMs: number;
  childCount: number;
}

/**
 * Display order for a waterfall: depth first, siblings by start. A span whose parent is missing (not ingested yet,
 * or sampled out) becomes a root, so nothing is hidden; cycles in bad data are cut.
 */
export function orderSpans(spans: TraceSpan[]): OrderedSpan[] {
  if (!spans.length) return [];
  const start = Math.min(...spans.map((s) => new Date(s.timestamp).getTime()));
  const offsetOf = (s: TraceSpan) => s.offsetMs ?? new Date(s.timestamp).getTime() - start;
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const children = new Map<string, TraceSpan[]>();
  const roots: TraceSpan[] = [];
  for (const span of spans) {
    const parent = span.parentSpanId && span.parentSpanId !== span.spanId ? byId.get(span.parentSpanId) : undefined;
    if (parent) children.set(parent.spanId, [...(children.get(parent.spanId) ?? []), span]);
    else roots.push(span);
  }
  const byStart = (a: TraceSpan, b: TraceSpan) => offsetOf(a) - offsetOf(b) || a.name.localeCompare(b.name);
  const out: OrderedSpan[] = [];
  const seen = new Set<string>();
  const walk = (span: TraceSpan, depth: number) => {
    if (seen.has(span.spanId)) return;
    seen.add(span.spanId);
    const kids = (children.get(span.spanId) ?? []).sort(byStart);
    out.push({ span, depth, offsetMs: offsetOf(span), childCount: kids.length });
    for (const kid of kids) walk(kid, depth + 1);
  };
  for (const root of roots.sort(byStart)) walk(root, 0);
  // A cycle with no root in it: show what is left as roots.
  for (const span of spans) if (!seen.has(span.spanId)) walk(span, 0);
  return out;
}

/** Hides the descendants of collapsed spans. */
export function visibleSpans(ordered: OrderedSpan[], collapsed: Set<string>): OrderedSpan[] {
  const out: OrderedSpan[] = [];
  let hideBelow: number | null = null;
  for (const row of ordered) {
    if (hideBelow !== null) {
      if (row.depth > hideBelow) continue;
      hideBelow = null;
    }
    out.push(row);
    if (collapsed.has(row.span.spanId)) hideBelow = row.depth;
  }
  return out;
}

/**
 * A trace as a waterfall: one row per span, indented by depth, with a bar at its offset and length, coloured by
 * service (red for errors). A click shows the span's detail; the chevron folds a subtree.
 */
export function TraceWaterfall({
  trace,
  selected: selectedProp,
  onSelect,
  showDetail = true,
  className,
}: {
  trace: TraceResponse;
  selected?: string | null;
  onSelect?: (spanId: string | null) => void;
  showDetail?: boolean;
  className?: string;
}) {
  const ordered = useMemo(() => orderSpans(trace.spans), [trace.spans]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [own, setOwn] = useState<string | null>(null);
  const selectedId = selectedProp !== undefined ? selectedProp : own;
  const select = (id: string | null) => {
    setOwn(id);
    onSelect?.(id);
  };
  const total = Math.max(
    trace.durationMs,
    ...ordered.map((o) => o.offsetMs + o.span.durationMs),
    0.001,
  );
  const rows = visibleSpans(ordered, collapsed);
  const selected = ordered.find((o) => o.span.spanId === selectedId)?.span;
  const ticks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div className={cn('@container flex min-w-0 flex-col gap-3', className)} data-testid="trace-waterfall">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-t3">
        <span>
          <span className="font-semibold text-t1">{trace.spans.length}</span> {trace.spans.length === 1 ? 'span' : 'spans'}
        </span>
        <span>
          <span className="font-mono font-semibold text-t1">{formatDuration(trace.durationMs)}</span>
        </span>
        {trace.errorCount > 0 && <Badge tone="danger">{trace.errorCount} {trace.errorCount === 1 ? 'error' : 'errors'}</Badge>}
        <span className="flex flex-wrap items-center gap-2">
          {trace.services.map((s) => (
            <span key={s} className="inline-flex items-center gap-1">
              <span className="size-2 rounded-sm" style={{ background: serviceColor(s) }} />
              {s}
            </span>
          ))}
        </span>
      </div>

      <div className="min-w-0 overflow-hidden rounded-xl border border-hair">
        <div className="grid h-7 grid-cols-1 items-center border-b border-hair bg-sf2 text-[10px] text-t3 @xl:grid-cols-[minmax(200px,38%)_1fr]">
          <span className="hidden px-2 font-semibold uppercase tracking-[0.06em] @xl:block">Span</span>
          <div className="relative mx-2 h-full">
            {ticks.map((t) => (
              <span
                key={t}
                // Phones keep the ends and the middle; the quarter ticks would overlap.
                className={cn('absolute top-1/2 -translate-y-1/2 font-mono', (t === 0.25 || t === 0.75) && 'hidden @xl:inline')}
                style={t === 1 ? { right: 0 } : t === 0.5 ? { left: '50%', transform: 'translate(-50%, -50%)' } : { left: `${t * 100}%` }}
              >
                {t === 0 ? '0' : formatDuration(total * t)}
              </span>
            ))}
          </div>
        </div>
        {/* Long traces scroll inside the card, so the selected span's detail stays in view below. */}
        <div role="tree" aria-label="Spans" className="max-h-[min(62dvh,600px)] overflow-y-auto">
          {rows.map(({ span, depth, offsetMs, childCount }) => {
            const error = isErrorStatus(span.status);
            const isSelected = span.spanId === selectedId;
            const folded = collapsed.has(span.spanId);
            const left = (offsetMs / total) * 100;
            const width = Math.max((span.durationMs / total) * 100, 0.4);
            return (
              <div
                key={span.spanId}
                role="treeitem"
                aria-level={depth + 1}
                aria-selected={isSelected}
                aria-expanded={childCount ? !folded : undefined}
                data-span-id={span.spanId}
                tabIndex={0}
                onClick={() => select(isSelected ? null : span.spanId)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') select(isSelected ? null : span.spanId);
                }}
                className={cn(
                  'grid cursor-pointer grid-cols-1 items-center gap-y-1 border-b border-hair px-2 py-1.5 outline-none last:border-0 hover:bg-acdim focus-visible:bg-acdim @xl:grid-cols-[minmax(200px,38%)_1fr] @xl:gap-y-0 @xl:py-1',
                  isSelected && 'bg-acdim',
                  error && 'bg-rddim',
                )}
              >
                <div className="flex min-w-0 items-center gap-1 text-[12px]" style={{ paddingLeft: Math.min(depth, 12) * 12 }}>
                  {childCount ? (
                    <button
                      type="button"
                      aria-label={folded ? 'Expand' : 'Collapse'}
                      onClick={(e) => {
                        e.stopPropagation();
                        setCollapsed((prev) => {
                          const next = new Set(prev);
                          if (next.has(span.spanId)) next.delete(span.spanId);
                          else next.add(span.spanId);
                          return next;
                        });
                      }}
                      className="grid size-4 shrink-0 place-items-center rounded text-t3 hover:text-t1"
                    >
                      <ChevronRight className={cn('size-3.5 transition-transform', !folded && 'rotate-90')} />
                    </button>
                  ) : (
                    <span className="size-4 shrink-0" />
                  )}
                  <span className="size-2 shrink-0 rounded-sm" style={{ background: serviceColor(span.service) }} />
                  <span className="shrink-0 text-t3">{span.service}</span>
                  <span className={cn('min-w-0 truncate font-mono text-t1', error && 'text-rd')} title={span.name}>
                    {span.name}
                  </span>
                  {folded && <span className="shrink-0 text-[11px] text-t3">+{childCount}</span>}
                </div>
                <div className="relative mx-0 h-5 @xl:mx-2" aria-hidden>
                  <div
                    className="absolute top-1/2 h-2.5 -translate-y-1/2 rounded-sm"
                    style={{
                      left: `${left}%`,
                      width: `${width}%`,
                      background: error ? 'var(--rd)' : serviceColor(span.service),
                    }}
                  />
                  {/* The duration sits after the bar, before it when the bar ends late, or inside a bar that fills the row. */}
                  <span
                    className={cn(
                      'absolute top-1/2 -translate-y-1/2 whitespace-nowrap px-1 font-mono text-[10px]',
                      left + width > 70 && left < 15 ? 'font-semibold text-white' : 'text-t2',
                    )}
                    style={
                      left + width <= 70 ? { left: `${left + width}%` } : left >= 15 ? { right: `${100 - left}%` } : { left: `${left}%` }
                    }
                  >
                    {formatDuration(span.durationMs)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {showDetail && selected && <SpanDetail span={selected} onClose={() => select(null)} />}
    </div>
  );
}

/** One span in full: timing, status, ids, attributes and resource. */
export function SpanDetail({ span, onClose }: { span: TraceSpan; onClose?: () => void }) {
  const error = isErrorStatus(span.status);
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-xl border border-hair bg-sf2 p-3" data-testid="span-detail">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="size-2 rounded-sm" style={{ background: serviceColor(span.service) }} />
            <span className="text-[12px] text-t2">{span.service}</span>
            <Badge tone="muted">{span.kind || 'span'}</Badge>
            {error ? <Badge tone="danger">error</Badge> : <Badge tone="neutral">{span.status || 'unset'}</Badge>}
          </div>
          <h3 className="mt-1 break-all font-mono text-[13px] font-semibold text-t1">{span.name}</h3>
        </div>
        {onClose && (
          <Button size="icon-sm" variant="ghost" aria-label="Close the span" onClick={onClose}>
            <X className="size-4" />
          </Button>
        )}
      </div>
      {span.statusMessage && (
        <p className="rounded-lg border border-rdbd bg-rddim px-2.5 py-1.5 font-mono text-[12px] text-rd">
          {span.statusMessage}
        </p>
      )}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px] md:grid-cols-4">
        <div>
          <dt className="text-t3">Duration</dt>
          <dd className="font-mono text-t1">{formatDuration(span.durationMs)}</dd>
        </div>
        <div>
          <dt className="text-t3">Started</dt>
          <dd className="font-mono text-t1">{formatTime(span.timestamp)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-t3">Span</dt>
          <dd className="truncate font-mono text-t1">{span.spanId}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-t3">Parent</dt>
          <dd className="truncate font-mono text-t1">{span.parentSpanId || '—'}</dd>
        </div>
      </dl>
      <div>
        <SectionLabel className="mb-1">Attributes</SectionLabel>
        <KeyValues values={span.attributes} />
      </div>
      <div>
        <SectionLabel className="mb-1">Resource</SectionLabel>
        <KeyValues values={span.resource} />
      </div>
    </div>
  );
}
