import type uPlot from 'uplot';
import { formatTime } from '../format';

/** A y axis as wide as its longest label (plus a gap), so `1.16 GiB` is never clipped at the left edge. */
export function fitAxisSize(self: uPlot, values: string[] | null, axisIdx: number, cycleNum: number): number {
  const axis = self.axes[axisIdx] as uPlot.Axis & { _size?: number };
  if (cycleNum > 1 && axis._size) return axis._size;
  const longest = (values ?? []).reduce((a, v) => (v.length > a.length ? v : a), '');
  if (!longest) return 24;
  const font = Array.isArray(axis.font) ? axis.font[0] : axis.font;
  if (font) self.ctx.font = String(font);
  return Math.ceil(self.ctx.measureText(longest).width / (window.devicePixelRatio || 1)) + 14;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Time ticks in local time, chosen by how wide the visible range is: `14:05:30`, `14:05`, `Nov 14 14:00`, `Nov 14`. */
export function timeTicks(self: uPlot, splits: number[]): string[] {
  const min = self.scales.x?.min ?? splits[0] ?? 0;
  const max = self.scales.x?.max ?? splits[splits.length - 1] ?? 0;
  const span = max - min;
  return splits.map((s) => {
    const d = new Date(s * 1000);
    if (span <= 10 * 60) return formatTime(s * 1000, { ms: false });
    if (span <= 36 * 3600) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const day = `${d.toLocaleString('en-US', { month: 'short' })} ${d.getDate()}`;
    if (span <= 4 * 86400)
      return d.getHours() === 0 && d.getMinutes() === 0 ? day : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return day;
  });
}
