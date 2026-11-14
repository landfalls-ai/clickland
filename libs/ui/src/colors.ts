/**
 * Colours: services get a stable colour from the --viz-* tokens, severities a tone. Canvas (uPlot) can't read CSS
 * variables, so charts resolve them with `cssVar` when they draw.
 */

export const VIZ_VARS = ['--viz-1', '--viz-2', '--viz-3', '--viz-4', '--viz-5', '--viz-7'] as const;
const VIZ_FALLBACK = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#4a3aa7'];

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** The index of a service's colour: the same name always gets the same colour. */
export const serviceColorIndex = (service: string) => hash(service) % VIZ_VARS.length;

/** A service's colour as a CSS value (for the DOM). */
export const serviceColor = (service: string) => `var(${VIZ_VARS[serviceColorIndex(service)]})`;

/** The nth series colour as a CSS value. */
export const seriesColor = (index: number) => `var(${VIZ_VARS[index % VIZ_VARS.length]})`;

/** Reads a CSS custom property off the document (for canvas drawing). */
export function cssVar(name: string, fallback: string): string {
  if (typeof document === 'undefined' || typeof getComputedStyle === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

export const resolvedSeriesColor = (index: number) =>
  cssVar(VIZ_VARS[index % VIZ_VARS.length]!, VIZ_FALLBACK[index % VIZ_FALLBACK.length]!);

/** `#rrggbb` or `rgb(…)` with an alpha; anything else comes back unchanged. */
export function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3) h = [...h].map((c) => c + c).join('');
    const n = parseInt(h, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(color.trim());
  if (rgb) {
    const parts = rgb[1]!
      .split(/[\s,/]+/)
      .filter(Boolean)
      .slice(0, 3);
    return `rgba(${parts.join(', ')}, ${alpha})`;
  }
  return color;
}

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'muted';

/** The tone of a log severity (OTel severity text, any case). */
export function severityTone(severity: string): Tone {
  const s = severity.toLowerCase();
  if (/^(fatal|crit|critical|emerg|alert|error|err)/.test(s)) return 'danger';
  if (/^warn/.test(s)) return 'warning';
  if (/^(info|notice)/.test(s)) return 'accent';
  if (/^(debug|trace)/.test(s)) return 'muted';
  return 'neutral';
}

/** Whether a span status is an error (`Error`, `STATUS_CODE_ERROR`). */
export const isErrorStatus = (status: string) => /error/i.test(status);
