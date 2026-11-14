import type { Series } from '@clickland/contracts';

export interface Aligned {
  /** Unix seconds. */
  xs: number[];
  /** One array per series, aligned to `xs`. */
  ys: (number | null)[][];
  keys: string[];
}

/** Fill the bucket grid between these times (counts): the API only sends buckets that have rows. */
export interface GridFill {
  bucketSeconds: number;
  /** ISO or ms; the first and last buckets default to the data's own. */
  from?: string | number;
  to?: string | number;
}

const MAX_GRID = 3000;

/**
 * Puts every series on one shared time axis; missing buckets become `missing` (0 for counts, null for gauges).
 * With `grid` (counts only), every bucket between `from` and `to` is present, so a line of sparse counts
 * drops to zero between them instead of drawing a straight line from one to the next.
 */
export function alignSeries(series: Series[], missing: 0 | null = 0, grid?: GridFill): Aligned {
  const times = new Set<number>();
  const maps = series.map((s) => {
    const m = new Map<number, number>();
    for (const [t, v] of s.points) {
      const x = Math.floor(new Date(t).getTime() / 1000);
      times.add(x);
      m.set(x, v);
    }
    return m;
  });
  if (grid && missing === 0 && grid.bucketSeconds > 0 && times.size) {
    const step = grid.bucketSeconds;
    const known = [...times];
    const toSec = (t: string | number | undefined, fallback: number) =>
      t === undefined ? fallback : Math.floor((typeof t === 'number' ? t : new Date(t).getTime()) / 1000);
    const first = Math.min(...known);
    const start = first - Math.floor((first - Math.min(toSec(grid.from, first), first)) / step) * step;
    const end = Math.max(toSec(grid.to, Math.max(...known)), Math.max(...known));
    if ((end - start) / step <= MAX_GRID) for (let x = start; x <= end; x += step) times.add(x);
  }
  const xs = [...times].sort((a, b) => a - b);
  return { xs, ys: maps.map((m) => xs.map((x) => m.get(x) ?? missing)), keys: series.map((s) => s.key) };
}

/** Running sums for stacked bars: series i becomes the sum of series 0..i. */
export function stack(ys: (number | null)[][]): number[][] {
  const out: number[][] = [];
  ys.forEach((row, i) => {
    out.push(row.map((v, j) => (v ?? 0) + (i > 0 ? out[i - 1]![j]! : 0)));
  });
  return out;
}

/** Total per series (for legends and the bar chart). */
export const totals = (series: Series[]) =>
  series.map((s) => ({ key: s.key, value: s.points.reduce((sum, [, v]) => sum + v, 0) }));
