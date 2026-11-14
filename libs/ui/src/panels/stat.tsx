import type { ReactNode } from 'react';
import { cn } from '../cn';

/** One big number with a label and an optional line under it. */
export function Stat({
  label,
  value,
  sub,
  tone,
  className,
}: {
  label?: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'danger' | 'success' | 'warning';
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-1', className)} data-testid="stat">
      {label && <span className="text-[12px] text-t3">{label}</span>}
      <span
        className={cn(
          'font-mono text-[32px] font-semibold leading-none tracking-tight text-t1 tabular-nums',
          tone === 'danger' && 'text-rd',
          tone === 'success' && 'text-gn',
          tone === 'warning' && 'text-warn',
        )}
      >
        {value}
      </span>
      {sub && <span className="text-[12px] text-t3">{sub}</span>}
    </div>
  );
}
