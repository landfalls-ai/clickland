import { useEffect, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { cssVar, resolvedSeriesColor, withAlpha } from '../colors';
import { formatCount } from '../format';
import { useLatest } from '../use-latest';
import { fitAxisSize } from './axes';
import { Legend } from './legend';
import { useThemeVersion, useWidth } from './use-chart-env';

export interface BarItem {
  label: string;
  value: number;
}

/** A categorical bar chart on uPlot: one bar per item (e.g. errors per service), the value under the cursor. */
export function BarChart({
  items,
  height = 180,
  format = formatCount,
  onSelect,
  className,
}: {
  items: BarItem[];
  height?: number;
  format?: (value: number) => string;
  onSelect?: (label: string) => void;
  className?: string;
}) {
  const [box, width] = useWidth<HTMLDivElement>();
  const target = useRef<HTMLDivElement>(null);
  const theme = useThemeVersion();
  const [hover, setHover] = useState<number | null>(null);
  const select = useLatest(onSelect);
  const fmt = useLatest(format);

  useEffect(() => {
    const el = target.current;
    if (!el || width <= 0 || !items.length) return;
    const t3 = cssVar('--t3', '#737373');
    const hair = cssVar('--hair', 'rgba(0,0,0,0.08)');
    const font = `11px ${cssVar('--font-geist-mono', '') || 'ui-monospace'}, ui-monospace, monospace`;
    const xs = items.map((_, i) => i);
    const maxLabel = Math.max(4, Math.floor(width / Math.max(items.length, 1) / 7));
    const opts: uPlot.Options = {
      width,
      height,
      legend: { show: false },
      padding: [8, 8, 0, 0],
      cursor: { drag: { x: false, y: false }, points: { show: false } },
      scales: {
        x: { time: false, range: [-0.5, items.length - 0.5] },
        y: { range: (_u, _min, max) => [0, max > 0 ? max * 1.1 : 1] },
      },
      axes: [
        {
          stroke: t3,
          font,
          grid: { show: false },
          ticks: { show: false },
          size: 28,
          splits: () => xs,
          values: (_u, splits) =>
            splits.map((i) => {
              const label = items[i]?.label ?? '';
              return label.length > maxLabel ? `${label.slice(0, maxLabel - 1)}…` : label;
            }),
        },
        {
          stroke: t3,
          font,
          grid: { stroke: hair, width: 1 },
          ticks: { show: false },
          size: fitAxisSize,
          values: (_u, splits) => splits.map((v) => fmt.current(v)),
        },
      ],
      series: [
        {},
        {
          label: 'value',
          stroke: resolvedSeriesColor(0),
          fill: withAlpha(resolvedSeriesColor(0), 0.85),
          width: 0,
          paths: uPlot.paths.bars!({ size: [0.7, 64], align: 0 }),
          points: { show: false },
        },
      ],
      hooks: { setCursor: [(u) => setHover(u.cursor.idx ?? null)] },
    };
    const plot = new uPlot(opts, [xs, items.map((i) => i.value)], el);
    const click = () => {
      const idx = plot.cursor.idx;
      if (idx !== null && idx !== undefined && items[idx]) select.current?.(items[idx].label);
    };
    plot.over.addEventListener('click', click);
    return () => {
      plot.over.removeEventListener('click', click);
      plot.destroy();
    };
  }, [items, width, height, theme]);

  if (!items.length) {
    return (
      <div className="grid place-items-center text-[12px] text-t3" style={{ height }} data-testid="chart-empty">
        No data in this range
      </div>
    );
  }
  const at = hover !== null && items[hover] ? hover : null;
  return (
    <div ref={box} className={className} data-testid="bar-chart">
      <div ref={target} style={{ height }} className={onSelect ? 'cursor-pointer' : undefined} />
      <Legend
        items={
          at === null
            ? items.slice(0, 6).map((item) => ({ key: item.label, value: format(item.value), colorIndex: 0 }))
            : [{ key: items[at]!.label, value: format(items[at]!.value), colorIndex: 0 }]
        }
        caption={at === null && items.length > 6 ? `top 6 of ${items.length}` : undefined}
      />
    </div>
  );
}
