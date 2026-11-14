import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@clickland/ui';

/** A small icon button that copies `text` and shows a check for a moment. */
export function CopyButton({ text, label = 'Copy', className }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => toast.error('Could not copy to the clipboard'),
    );
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={label}
      title={copied ? 'Copied' : label}
      className={cn(
        'grid size-7 shrink-0 place-items-center rounded-full text-t3 transition-colors duration-[120ms] hover:bg-acdim hover:text-ac',
        className,
      )}
    >
      {copied ? <Check className="size-3.5 text-gn" /> : <Copy className="size-3.5" />}
    </button>
  );
}

/** A secret shown once (a new API key or webhook secret), with a copy button. */
export function OnceSecret({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-warnbd bg-warndim p-3" data-testid="once-secret">
      <span className="text-[12px] font-semibold text-warn">{label} — copy it now; it won’t be shown again.</span>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded-lg bg-sf px-2 py-1.5 font-mono text-[12px] text-t1">
          {value}
        </code>
        <CopyButton text={value} label={`Copy the ${label.toLowerCase()}`} />
      </div>
    </div>
  );
}
