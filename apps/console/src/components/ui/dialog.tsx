import { useEffect, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { Button, cn } from '@clickland/ui';

function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
}

/**
 * The modal frame, as Landbright's: portalled; Escape and a click outside close it. With `onSubmit` the body is a
 * form, so Enter submits. On a phone it is a sheet from the bottom.
 */
export function Dialog({
  title,
  subtitle,
  onClose,
  children,
  footer,
  onSubmit,
  width = 520,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  onSubmit?: () => void;
  width?: number;
}) {
  useEscape(onClose);
  const inner = (
    <>
      <header className="flex items-center gap-3 border-b border-hair px-5 py-3.5">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-semibold text-t1">{title}</h2>
          {subtitle && <p className="truncate text-[12px] text-t3">{subtitle}</p>}
        </div>
        <Button size="icon-sm" variant="ghost" onClick={onClose} aria-label="Close">
          <X className="size-4" />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
      {footer && <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-hair px-5 py-3 pb-safe">{footer}</footer>}
    </>
  );
  const frame =
    'flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-hair bg-sf shadow-pop animate-in md:max-h-[min(760px,90vh)] md:w-[var(--w)] md:max-w-full md:rounded-2xl';
  const props = {
    role: 'dialog',
    'aria-modal': true,
    'aria-label': typeof title === 'string' ? title : undefined,
    onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
    style: { '--w': `${width}px` } as React.CSSProperties,
    className: frame,
  };
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-overlay animate-in md:items-center md:p-6"
      onMouseDown={onClose}
    >
      {onSubmit ? (
        <form
          {...props}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          {inner}
        </form>
      ) : (
        <div {...props}>{inner}</div>
      )}
    </div>,
    document.body,
  );
}

export function ConfirmDialog({
  title,
  message,
  action,
  busy,
  onConfirm,
  onClose,
}: {
  title: string;
  message: ReactNode;
  action: string;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      title={title}
      onClose={onClose}
      width={440}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} loading={busy} autoFocus>
            {action}
          </Button>
        </>
      }
    >
      <div className="text-[13px] leading-relaxed text-t2">{message}</div>
    </Dialog>
  );
}

/** A panel from the right (desktop) or the bottom (phone): the search's row detail. */
export function Drawer({
  title,
  onClose,
  children,
  actions,
  className,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  useEscape(onClose);
  return createPortal(
    <div className="fixed inset-0 z-50" data-testid="drawer">
      <div className="absolute inset-0 bg-overlay animate-in md:bg-black/10" onMouseDown={onClose} aria-hidden />
      <aside
        role="dialog"
        aria-label={typeof title === 'string' ? title : 'Details'}
        className={cn(
          'absolute inset-x-0 bottom-0 flex max-h-[88dvh] flex-col rounded-t-2xl border-t border-hair bg-sf shadow-pop animate-in md:inset-y-0 md:left-auto md:right-0 md:max-h-none md:w-[min(560px,100vw)] md:rounded-none md:border-l md:border-t-0',
          className,
        )}
      >
        <header className="flex min-h-[52px] shrink-0 items-center gap-2 border-b border-hair px-4">
          <h2 className="min-w-0 flex-1 truncate text-[14px] font-semibold text-t1">{title}</h2>
          {actions}
          <Button size="icon-sm" variant="ghost" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </Button>
        </header>
        <div className="pb-safe min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
      </aside>
    </div>,
    document.body,
  );
}
