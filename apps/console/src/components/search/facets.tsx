import { useState } from 'react';
import { ChevronRight, Minus } from 'lucide-react';
import { cn, formatCount, Skeleton } from '@clickland/ui';
import type { FacetField } from '@/lib/types';

/** The facets sidebar: each field's top values from the 15-minute rollups; a click adds `field:value`. */
export function Facets({
  fields,
  loading,
  error,
  onPick,
}: {
  fields: FacetField[] | undefined;
  loading: boolean;
  error?: Error | null;
  onPick: (field: string, value: string, exclude: boolean) => void;
}) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  if (error) return <p className="text-[12px] text-rd">{error.message}</p>;
  if (!fields) return loading ? <Skeleton lines={8} /> : null;
  if (!fields.length)
    return <p className="text-[12px] text-t3">No facets in this range (they come from 15-minute rollups).</p>;
  return (
    <div className="flex flex-col gap-1" data-testid="facets">
      {fields.map((f, i) => {
        const open = i < 6 ? !closed.has(f.field) : closed.has(f.field);
        const max = Math.max(...f.values.map((v) => v.count), 1);
        return (
          <div key={f.field} className="flex flex-col">
            <button
              type="button"
              onClick={() =>
                setClosed((prev) => {
                  const next = new Set(prev);
                  if (next.has(f.field)) next.delete(f.field);
                  else next.add(f.field);
                  return next;
                })
              }
              aria-expanded={open}
              className="flex h-7 items-center gap-1 rounded-md px-1 text-left text-[12px] font-semibold text-t2 hover:bg-acdim"
            >
              <ChevronRight className={cn('size-3.5 shrink-0 text-t3 transition-transform', open && 'rotate-90')} />
              <span className="truncate font-mono" title={f.field}>
                {f.field}
              </span>
            </button>
            {open && (
              <div className="mb-1 flex flex-col">
                {f.values.slice(0, 10).map((v) => (
                  <div key={v.value} className="group relative flex items-center">
                    <button
                      type="button"
                      onClick={() => onPick(f.field, v.value, false)}
                      title={`${f.field}:${v.value}`}
                      className="relative flex h-7 min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-md pl-5 pr-1 text-left text-[12px] hover:bg-acdim"
                    >
                      <span
                        className="absolute inset-y-1 left-4 rounded-sm bg-nudim"
                        style={{ width: `calc(${(v.count / max) * 100}% - 1.25rem)` }}
                        aria-hidden
                      />
                      <span className="relative min-w-0 flex-1 truncate font-mono text-t1">{v.value || '(empty)'}</span>
                      <span className="relative shrink-0 font-mono text-[11px] text-t3">{formatCount(v.count)}</span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Exclude ${f.field}:${v.value}`}
                      title="Exclude"
                      onClick={() => onPick(f.field, v.value, true)}
                      className="grid size-6 shrink-0 place-items-center rounded-md text-t3 hover:bg-acdim hover:text-rd md:opacity-0 md:group-hover:opacity-100"
                    >
                      <Minus className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
