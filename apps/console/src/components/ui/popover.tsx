import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@clickland/ui';

/** A button with a panel under it; a click outside or Escape closes it. On a phone the panel spans the screen. */
export function Popover({
  trigger,
  children,
  align = 'right',
  className,
  label,
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
  className?: string;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={box} className="relative">
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && (
        <div
          role="dialog"
          aria-label={label}
          className={cn(
            'fixed inset-x-2 top-auto z-40 mt-1.5 rounded-2xl border border-hair bg-sf p-3 shadow-pop animate-in md:absolute md:inset-x-auto md:w-max md:max-w-[min(560px,90vw)]',
            align === 'right' ? 'md:right-0' : 'md:left-0',
            className,
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
