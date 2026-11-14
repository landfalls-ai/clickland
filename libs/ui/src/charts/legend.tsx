import { cn } from '../cn';
import { seriesColor } from '../colors';

export interface LegendItem {
  key: string;
  value: string;
  colorIndex: number;
  hidden?: boolean;
}

/** The legend under a chart: a swatch, the series and its value at the cursor (or its total). Click to hide. */
export function Legend({
  items,
  caption,
  onToggle,
}: {
  items: LegendItem[];
  caption?: string;
  onToggle?: (key: string) => void;
}) {
  if (!items.length) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]" data-testid="chart-legend">
      {caption && <span className="font-mono text-[11px] text-t3">{caption}</span>}
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          onClick={() => onToggle?.(item.key)}
          disabled={!onToggle}
          aria-pressed={!item.hidden}
          className={cn(
            'inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md px-1 text-left disabled:cursor-default',
            item.hidden ? 'opacity-40' : 'hover:bg-acdim',
          )}
        >
          <span className="size-2 shrink-0 rounded-sm" style={{ background: seriesColor(item.colorIndex) }} />
          <span className="truncate text-t2">{item.key || (items.length === 1 ? 'all' : '(none)')}</span>
          <span className="shrink-0 whitespace-nowrap font-mono text-[11px] font-semibold text-t1">{item.value}</span>
        </button>
      ))}
    </div>
  );
}
