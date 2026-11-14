import { useEffect, useMemo, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { SeriesResponse } from '@clickland/contracts';
import { cssVar, resolvedSeriesColor, withAlpha } from '../colors';
import { formatCount, formatTime } from '../format';
import { alignSeries, stack } from './align';
import { fitAxisSize, timeTicks } from './axes';
import { useLatest } from '../use-latest';
import { Legend } from './legend';
import { useThemeVersion, useWidth } from './use-chart-env';

export interface TimeSeriesChartProps {
  data: SeriesResponse;
  /** `line` (default) or `bars`; bars of several series stack. */
  kind?: 'line' | 'bars';
  height?: number;
  /** Formats a value on the axis and in the legend. */
  format?: (value: number) => string;
  /** Missing buckets: 0 for counts (default), null for gauges (gaps). */
  missing?: 0 | null;
  /** The range asked for (counts fill every empty bucket in it with 0). */
  range?: { from: string | number; to: string | number };
  /** Drag across the chart to pick a range (milliseconds). */
  onZoom?: (from: number, to: number) => void;
  className?: string;
}

/** A time-series chart on uPlot (canvas, fast on thousands of points), with a legend that follows the cursor. */
export function TimeSeriesChart({
  data,
  kind = 'line',
  height = 180,
  format = formatCount,
  missing = 0,
  range,
  onZoom,
  className,
}: TimeSeriesChartProps) {
  const [box, width] = useWidth<HTMLDivElement>();
  const target = useRef<HTMLDivElement>(null);
  const theme = useThemeVersion();
  const [hover, setHover] = useState<number | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const from = range?.from;
  const to = range?.to;
  const aligned = useMemo(
    () =>
      alignSeries(
        data.series,
        missing,
        data.bucketSeconds ? { bucketSeconds: data.bucketSeconds, from, to } : undefined,
      ),
    [data, missing, from, to],
  );
  const zoom = useLatest(onZoom);
  const fmt = useLatest(format);

  useEffect(() => {
    const el = target.current;
    if (!el || width <= 0 || !aligned.xs.length) return;
    const t3 = cssVar('--t3', '#737373');
    const hair = cssVar('--hair', 'rgba(0,0,0,0.08)');
    const font = `11px ${cssVar('--font-geist-mono', '') || 'ui-monospace'}, ui-monospace, monospace`;
    const visible = aligned.keys.map((k) => !hidden.has(k));
    const bars = kind === 'bars';
    // Stacked bars draw running sums, the tallest first, so each series shows as its own band.
    const shown = aligned.ys.map((ys, i) => (visible[i] ? ys : ys.map(() => (bars ? 0 : null))));
    const values = bars ? stack(shown) : shown;
    const order = bars ? values.map((_, i) => values.length - 1 - i) : values.map((_, i) => i);
    const barPaths = bars ? uPlot.paths.bars!({ size: [0.8, 48], gap: 1 }) : undefined;
    const opts: uPlot.Options = {
      width,
      height,
      legend: { show: false },
      padding: [8, 8, 0, 0],
      cursor: {
        drag: { x: Boolean(zoom.current), y: false, setScale: false },
        points: { size: 6 },
      },
      scales: { x: { time: true }, y: { range: (_u, min, max) => [Math.min(0, min), max > 0 ? max * 1.08 : 1] } },
      axes: [
        {
          stroke: t3,
          font,
          grid: { stroke: hair, width: 1 },
          ticks: { stroke: hair, width: 1 },
          size: 28,
          space: 64,
          values: timeTicks,
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
        ...order.map((i) => {
          const color = resolvedSeriesColor(i);
          return {
            label: aligned.keys[i],
            stroke: color,
            width: bars ? 0 : 1.5,
            fill: bars ? withAlpha(color, 0.85) : aligned.keys.length === 1 ? withAlpha(color, 0.12) : undefined,
            paths: barPaths,
            points: { show: false },
            spanGaps: false,
          } satisfies uPlot.Series;
        }),
      ],
      hooks: {
        setCursor: [(u) => setHover(u.cursor.idx ?? null)],
        setSelect: [
          (u) => {
            if (!zoom.current || u.select.width < 4) return;
            const from = u.posToVal(u.select.left, 'x') * 1000;
            const to = u.posToVal(u.select.left + u.select.width, 'x') * 1000;
            u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
            zoom.current(Math.round(from), Math.round(to));
          },
        ],
      },
    };
    const plot = new uPlot(opts, [aligned.xs, ...order.map((i) => values[i]!)] as uPlot.AlignedData, el);
    return () => plot.destroy();
  }, [aligned, width, height, kind, theme, hidden]);

  if (!aligned.xs.length) {
    return (
      <div className="grid place-items-center text-[12px] text-t3" style={{ height }} data-testid="chart-empty">
        No data in this range
      </div>
    );
  }
  const at = hover !== null && hover >= 0 && hover < aligned.xs.length ? hover : null;
  const items = aligned.keys.map((key, i) => {
    const value = at === null ? aligned.ys[i]!.reduce<number>((s, v) => s + (v ?? 0), 0) : (aligned.ys[i]![at] ?? NaN);
    return { key, colorIndex: i, value: format(value), hidden: hidden.has(key) };
  });
  // A legend total only makes sense for counts; for gauges show the last value instead.
  if (at === null && missing === null) {
    items.forEach((item, i) => {
      const ys = aligned.ys[i]!;
      const last = [...ys].reverse().find((v) => v !== null);
      item.value = last === undefined || last === null ? '–' : format(last);
    });
  }
  return (
    <div ref={box} className={className} data-testid="timeseries-chart">
      <div ref={target} style={{ height }} />
      <Legend
        caption={
          at === null ? (missing === null ? 'latest' : 'total') : formatTime(aligned.xs[at]! * 1000, { ms: false })
        }
        items={items}
        onToggle={
          aligned.keys.length > 1
            ? (key) =>
                setHidden((prev) => {
                  const next = new Set(prev);
                  if (next.has(key)) next.delete(key);
                  else next.add(key);
                  return next;
                })
            : undefined
        }
      />
    </div>
  );
}
