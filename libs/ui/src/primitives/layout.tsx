import type { CSSProperties, ReactNode } from 'react';
import { cn } from '../cn';

export function Card({
  children,
  className,
  style,
  testId,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  testId?: string;
}) {
  return (
    <div data-testid={testId} className={cn('rounded-2xl border border-hair bg-sf px-4 py-3.5', className)} style={style}>
      {children}
    </div>
  );
}

export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('text-[11px] font-semibold uppercase tracking-[0.06em] text-t3', className)}>{children}</div>
  );
}

export function EmptyState({
  icon,
  title,
  hint,
  action,
  compact,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center text-center text-t2',
        compact ? 'gap-1 p-4' : 'gap-2 px-4 py-10',
        className,
      )}
    >
      {icon && (
        <div className="mb-1 grid size-10 place-items-center rounded-xl border border-hair bg-sf2 text-t2">{icon}</div>
      )}
      <p className={cn('font-semibold text-t1', compact ? 'text-[13px]' : 'text-[15px]')}>{title}</p>
      {hint && <div className="max-w-[52ch] text-[13px] leading-snug">{hint}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** A red box with an error's message. */
export function ErrorNote({ error, className }: { error: unknown; className?: string }) {
  if (!error) return null;
  return (
    <p role="alert" className={cn('rounded-[10px] border border-rdbd bg-rddim px-3 py-2 text-[12px] text-rd', className)}>
      {error instanceof Error ? error.message : String(error)}
    </p>
  );
}

/** Shimmering placeholder lines while a panel loads. */
export function Skeleton({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-2', className)} aria-busy="true" aria-label="Loading">
      {Array.from({ length: lines }, (_, i) => (
        <div
          key={i}
          className="h-3 animate-pulse-soft rounded bg-nudim"
          style={{ width: `${90 - ((i * 23) % 40)}%` }}
        />
      ))}
    </div>
  );
}

/** Attributes as a key/value list: one column on phones, two at md. */
export function KeyValues({
  values,
  empty = 'None',
  onPick,
  className,
}: {
  values: Record<string, string>;
  empty?: ReactNode;
  /** Called with `key` and `value` when a row is clicked (e.g. to add it to a search). */
  onPick?: (key: string, value: string) => void;
  className?: string;
}) {
  const entries = Object.entries(values).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) return <p className="text-[12px] text-t3">{empty}</p>;
  return (
    <dl className={cn('grid grid-cols-1 gap-x-4 font-mono text-[12px] md:grid-cols-[minmax(120px,max-content)_1fr]', className)}>
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="truncate pt-1 text-t3 md:py-0.5" title={k}>
            {k}
          </dt>
          <dd className="min-w-0 break-all pb-1 text-t1 md:py-0.5">
            {onPick ? (
              <button
                type="button"
                className="text-left hover:text-ac hover:underline"
                title={`Search ${k}:${v}`}
                onClick={() => onPick(k, v)}
              >
                {v}
              </button>
            ) : (
              v
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
