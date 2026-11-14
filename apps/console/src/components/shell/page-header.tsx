import type { ReactNode } from 'react';
import { cn } from '@clickland/ui';
import { Mark } from './mark';

/** The 52px top bar every page starts with: title on the left, actions on the right (as Landflow and Landbright). */
export function PageHeader({
  title,
  meta,
  actions,
  className,
}: {
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        'sticky top-0 z-20 flex min-h-[52px] shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-hair bg-bg/95 px-4 py-2 backdrop-blur md:px-6',
        className,
      )}
    >
      <Mark size="sm" className="md:hidden" />
      <h1 className="min-w-0 truncate text-[15px] font-semibold text-t1">{title}</h1>
      {meta && <div className="flex min-w-0 items-center gap-2 text-[12px] text-t3">{meta}</div>}
      {actions && <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">{actions}</div>}
    </header>
  );
}

export function PageBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('px-4 py-4 md:px-6 md:py-5', className)}>{children}</div>;
}
