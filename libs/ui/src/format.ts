/** Number, duration and time formatting shared by every panel. */

export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return '–';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${trim(n / 1e9)}B`;
  if (abs >= 1e6) return `${trim(n / 1e6)}M`;
  if (abs >= 1e4) return `${trim(n / 1e3)}k`;
  if (Number.isInteger(n)) return n.toLocaleString('en-US');
  return trim(n);
}

function trim(n: number): string {
  const abs = Math.abs(n);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return n.toFixed(digits).replace(/\.0+$|(\.\d*?)0+$/, '$1');
}

/** A duration in milliseconds: `850 µs`, `12.3 ms`, `1.24 s`, `2 m 03 s`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return '–';
  if (ms === 0) return '0';
  if (ms < 1) return `${Math.round(ms * 1000)} µs`;
  if (ms < 1000) return `${trim(ms)} ms`;
  if (ms < 60_000) return `${trim(ms / 1000)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  if (minutes < 60) return `${minutes} m ${String(seconds).padStart(2, '0')} s`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} m`;
}

/** A byte count in binary units: `512 B`, `3.4 KiB`, `1.2 GiB`. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return '–';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = n;
  let i = 0;
  while (Math.abs(value) >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${i === 0 ? Math.round(value) : trim(value)} ${units[i]}`;
}

/** The formatter that suits an OpenTelemetry unit (`By`, `ms`, `s`, `1`, …). */
export function formatterForUnit(unit: string, name = ''): (n: number) => string {
  if (/^(By|bytes?)$/i.test(unit)) return formatBytes;
  if (unit === 'ms') return formatDuration;
  if (unit === 's') return (n) => formatDuration(n * 1000);
  if (unit === '1' && /utilization|percent|ratio/i.test(name)) return (n) => (/percent/i.test(name) ? `${trim(n)}%` : formatPercent(n));
  if (/duration|latency/i.test(name)) return formatDuration;
  return formatCount;
}

export function formatPercent(ratio: number, digits = 1): string {
  if (!Number.isFinite(ratio)) return '–';
  const value = ratio * 100;
  if (value > 0 && value < 0.1) return '<0.1%';
  return `${value.toFixed(value >= 10 || value === 0 ? 0 : digits)}%`;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** `14:05:03.120` in local time; `Nov 14 14:05:03` with `date`. */
export function formatTime(iso: string | number, opts: { date?: boolean; ms?: boolean } = {}): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${opts.ms === false ? '' : `.${pad(d.getMilliseconds(), 3)}`}`;
  if (!opts.date) return time;
  return `${d.toLocaleString('en-US', { month: 'short' })} ${d.getDate()} ${time}`;
}

/** A short label for a time range: "Last 60 min", or "Nov 14 14:00 → 15:00". */
export function formatRange(range: { lastMinutes: number } | { from: string; to: string }): string {
  if ('lastMinutes' in range) {
    const m = range.lastMinutes;
    if (m % 1440 === 0) return `Last ${m / 1440} ${m === 1440 ? 'day' : 'days'}`;
    if (m % 60 === 0) return `Last ${m / 60} ${m === 60 ? 'hour' : 'hours'}`;
    return `Last ${m} min`;
  }
  const from = new Date(range.from);
  const to = new Date(range.to);
  const sameDay = from.toDateString() === to.toDateString();
  const short = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${formatTime(range.from, { date: true, ms: false }).slice(0, -3)} → ${sameDay ? short(to) : formatTime(range.to, { date: true, ms: false }).slice(0, -3)}`;
}
