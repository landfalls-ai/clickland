/**
 * Time ranges in the URL: `from`/`to` are ISO times or `now-15m`-style relative times, so a link can be absolute
 * (an alert's window) or keep moving (the default, the last 15 minutes).
 */

export interface TimeRange {
  from: string;
  to: string;
}

export const DEFAULT_RANGE: TimeRange = { from: 'now-15m', to: 'now' };

export const PRESETS: Array<{ label: string; short: string; from: string }> = [
  { label: 'Last 5 minutes', short: '5m', from: 'now-5m' },
  { label: 'Last 15 minutes', short: '15m', from: 'now-15m' },
  { label: 'Last hour', short: '1h', from: 'now-1h' },
  { label: 'Last 4 hours', short: '4h', from: 'now-4h' },
  { label: 'Last 24 hours', short: '24h', from: 'now-24h' },
  { label: 'Last 7 days', short: '7d', from: 'now-7d' },
];

const UNIT: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** A time expression in milliseconds: `now`, `now-15m`, or an ISO time. NaN when it's neither. */
export function parseTime(expr: string, now: number): number {
  const e = expr.trim();
  if (e === 'now') return now;
  const rel = /^now-(\d+)([smhdw])$/.exec(e);
  if (rel) return now - Number(rel[1]) * UNIT[rel[2]!]!;
  return Date.parse(e);
}

export const isRelative = (range: TimeRange) => range.to === 'now' && /^now-\d+[smhdw]$/.test(range.from);

/** Absolute ISO bounds for a range at `now`. */
export function resolve(range: TimeRange, now: number): { from: string; to: string } {
  let from = parseTime(range.from, now);
  let to = parseTime(range.to, now);
  if (Number.isNaN(to)) to = now;
  if (Number.isNaN(from) || from >= to) from = to - 15 * 60_000;
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

/** The range from the query string, defaulting to the last 15 minutes. */
export function rangeFromParams(params: URLSearchParams): TimeRange {
  const from = params.get('from');
  const to = params.get('to');
  if (from && !Number.isNaN(parseTime(from, 0)) && (!to || !Number.isNaN(parseTime(to, 0))))
    return { from, to: to || 'now' };
  return DEFAULT_RANGE;
}

/** "Last 15 minutes", "Last 3h", or "Nov 14 14:00 → 15:00". */
export function rangeLabel(range: TimeRange): string {
  const preset = PRESETS.find((p) => p.from === range.from && range.to === 'now');
  if (preset) return preset.label;
  const rel = /^now-(\d+)([smhdw])$/.exec(range.from);
  if (rel && range.to === 'now') return `Last ${rel[1]}${rel[2]}`;
  const f = new Date(parseTime(range.from, Date.now()));
  const t = new Date(parseTime(range.to, Date.now()));
  const day = (d: Date) => d.toLocaleString('en-US', { month: 'short', day: 'numeric' });
  const hm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${day(f)} ${hm(f)} → ${f.toDateString() === t.toDateString() ? '' : `${day(t)} `}${hm(t)}`;
}

/** The value for an `<input type="datetime-local">` in local time. */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** A relative `from` with the same length as an absolute range (live tail keeps the window). */
export function relativeOf(range: TimeRange, now: number): string {
  if (isRelative(range)) return range.from;
  const r = resolve(range, now);
  const minutes = Math.max(1, Math.round((Date.parse(r.to) - Date.parse(r.from)) / 60_000));
  return `now-${minutes}m`;
}

/** Minutes a range covers (for a dashboard's relative range). */
export function minutesOf(range: TimeRange, now: number): number {
  const r = resolve(range, now);
  return Math.max(1, Math.round((Date.parse(r.to) - Date.parse(r.from)) / 60_000));
}
