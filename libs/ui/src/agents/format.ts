/** Formatting for the AI agent pages and panels (docs/agent-value.md#console-spec). */
import type { AgentFamily } from '@clickland/contracts';

export const FAMILY_LABEL: Record<AgentFamily, string> = {
  landflow: 'Landflow',
  a2a: 'A2A',
  landfall: 'Landfall',
  claude_code: 'Claude Code',
  genai: 'Other',
};

export const familyLabel = (family: string) => FAMILY_LABEL[family as AgentFamily] ?? family;

/** Money in the report's currency: 2 decimals; a cost under 1 with 4 (`cost: true`). */
export function formatMoney(n: number, currency = 'USD', opts: { cost?: boolean } = {}): string {
  if (!Number.isFinite(n)) return '–';
  const digits = opts.cost && Math.abs(n) < 1 && n !== 0 ? 4 : 2;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(n);
  } catch {
    return `${currency} ${n.toFixed(digits)}`;
  }
}

/** ROI as a whole percentage; `null` (no cost) is a dash. */
export const formatRoi = (roi: number | null): string =>
  roi === null || !Number.isFinite(roi) ? '—' : `${Math.round(roi * 100).toLocaleString('en-US')}%`;

/** Outcomes: whole numbers, or one decimal when an outcome was shared between agents. */
export const formatOutcomes = (n: number): string =>
  Number.isInteger(n) ? n.toLocaleString('en-US') : (Math.round(n * 10) / 10).toFixed(1);

/** A success rate as a percentage; `null` is "not known". */
export const formatSuccess = (rate: number | null): string =>
  rate === null || !Number.isFinite(rate) ? 'not known' : `${Math.round(rate * 100)}%`;

/** A run's duration: milliseconds under a second, else seconds with one decimal. */
export function formatRunDuration(ms: number): string {
  if (!Number.isFinite(ms)) return '–';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** Token counts: 950, 9.5k, 1.2M. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '–';
  const short = (v: number, unit: string) => `${v.toFixed(v >= 100 ? 0 : 1).replace(/\.0$/, '')}${unit}`;
  if (Math.abs(n) >= 1e6) return short(n / 1e6, 'M');
  if (Math.abs(n) >= 1e3) return short(n / 1e3, 'k');
  return n.toLocaleString('en-US');
}

/** An agent's id from its key (`service/name`): the API's ids are the key in URL-safe base64, as `ag_…`. */
export function agentIdOf(key: string): string {
  const bytes = new TextEncoder().encode(key);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return `ag_${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}
