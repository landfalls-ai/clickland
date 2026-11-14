import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import type { RangeInput } from '@clickland/contracts';
import type { PanelLinks } from '@clickland/ui';

/** A view's range as Search's `from`/`to`. */
export function searchRange(range: RangeInput): { from: string; to: string } {
  return 'lastMinutes' in range ? { from: `now-${range.lastMinutes}m`, to: 'now' } : range;
}

/** Links out of panels drawn in the console: traces, Search (with the view's range) and services. */
export function useConsoleLinks(range: RangeInput): PanelLinks {
  const navigate = useNavigate();
  const key = JSON.stringify(range);
  return useMemo(() => {
    const r = searchRange(JSON.parse(key) as RangeInput);
    return {
      openTrace: (traceId) => navigate(`/traces/${traceId}`),
      openSearch: ({ signal, query }) => navigate(`/search?${new URLSearchParams({ signal, query, ...r })}`),
      openService: (name) => navigate(`/services/${encodeURIComponent(name)}?${new URLSearchParams(r)}`),
    };
  }, [navigate, key]);
}
