import type { RangeInput } from '@clickland/contracts';

export interface TimeBounds {
  from: string;
  to: string;
}

/** Absolute bounds for a range; a relative range ends now. */
export function resolveRange(range: RangeInput, now: number = Date.now()): TimeBounds {
  if ('lastMinutes' in range) {
    return { from: new Date(now - range.lastMinutes * 60_000).toISOString(), to: new Date(now).toISOString() };
  }
  return { from: range.from, to: range.to };
}
