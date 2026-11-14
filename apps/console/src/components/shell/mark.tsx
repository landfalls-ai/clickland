import { cn } from '@clickland/ui';

/** The product mark, as Landbright's `LB` tile. */
export function Mark({ size, className }: { size: 'sm' | 'md'; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'grid shrink-0 place-items-center border border-acbd bg-ac2 font-bold tracking-[0.02em] text-on-ac',
        size === 'md' ? 'size-[34px] rounded-[9px] text-[12px]' : 'size-7 rounded-[8px] text-[11px]',
        className,
      )}
    >
      CL
    </span>
  );
}
