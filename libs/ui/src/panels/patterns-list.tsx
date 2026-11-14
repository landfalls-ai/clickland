import { Fragment } from 'react';
import type { PatternResult } from '@clickland/contracts';
import { cn } from '../cn';
import { serviceColor } from '../colors';
import { formatCount, formatPercent } from '../format';

/** Splits a Drain template into text and placeholders (`<*>`, `<NUM>`, `<IP>`, …) so placeholders can be styled. */
export function templateParts(template: string): { text: string; placeholder: boolean }[] {
  const parts: { text: string; placeholder: boolean }[] = [];
  const re = /<[A-Z*][A-Z0-9_*]*>/g;
  let last = 0;
  for (const m of template.matchAll(re)) {
    if (m.index! > last) parts.push({ text: template.slice(last, m.index), placeholder: false });
    parts.push({ text: m[0], placeholder: true });
    last = m.index! + m[0].length;
  }
  if (last < template.length) parts.push({ text: template.slice(last), placeholder: false });
  return parts;
}

/** Log patterns: the template (placeholders highlighted), its count and share, and an example. */
export function PatternsList({
  patterns,
  onSelect,
  className,
  meta,
}: {
  patterns: PatternResult[];
  onSelect?: (pattern: PatternResult) => void;
  className?: string;
  meta?: { sampled: number; total: number };
}) {
  if (!patterns.length) return <div className="py-6 text-center text-[12px] text-t3">No patterns in this range.</div>;
  return (
    <div className={cn('flex min-w-0 flex-col', className)} data-testid="patterns-list">
      {meta && (
        <p className="mb-1 text-[11px] text-t3">
          From the newest {formatCount(meta.sampled)} of {formatCount(meta.total)} rows
        </p>
      )}
      {patterns.map((p, i) => (
        <div
          key={`${p.template}-${i}`}
          role={onSelect ? 'button' : undefined}
          tabIndex={onSelect ? 0 : undefined}
          onClick={onSelect ? () => onSelect(p) : undefined}
          onKeyDown={onSelect ? (e) => e.key === 'Enter' && onSelect(p) : undefined}
          className={cn(
            'flex min-w-0 flex-col gap-1.5 border-b border-hair py-2.5 outline-none last:border-0',
            onSelect && '-mx-2 cursor-pointer rounded-lg px-2 hover:bg-acdim focus-visible:bg-acdim',
          )}
        >
          <div className="flex min-w-0 items-start gap-3">
            <code className="min-w-0 flex-1 break-words font-mono text-[12px] leading-snug text-t1">
              {templateParts(p.template).map((part, j) => (
                <Fragment key={j}>
                  {part.placeholder ? (
                    <span className="rounded bg-acdim px-0.5 text-ac" data-placeholder>
                      {part.text}
                    </span>
                  ) : (
                    part.text
                  )}
                </Fragment>
              ))}
            </code>
            <span className="shrink-0 text-right font-mono text-[12px] font-semibold text-t1">{formatCount(p.count)}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-nudim">
              <span className="block h-full rounded-full bg-viz-1" style={{ width: `${Math.max(1, p.share * 100)}%` }} />
            </span>
            <span className="w-12 text-right font-mono text-[11px] text-t3">{formatPercent(p.share)}</span>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-t3">
            {p.services.map((s) => (
              <span key={s} className="inline-flex items-center gap-1">
                <span className="size-1.5 rounded-full" style={{ background: serviceColor(s) }} />
                {s}
              </span>
            ))}
            <span className="min-w-0 flex-1 truncate font-mono" title={p.example}>
              e.g. {p.example}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
