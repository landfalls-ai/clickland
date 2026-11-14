import type { SearchResponse, SeriesResponse, ServiceSummary, TraceResponse } from '@clickland/contracts';
import type { DataSource, PatternsResponse } from '@clickland/ui';
import { get, qs, send } from './api';

/** The console's panels fetch over HTTP from the API (the MCP App fetches the same through MCP tools). */
export const httpData: DataSource = {
  search: (req) => send<SearchResponse>('POST', '/api/search', req),
  histogram: (req) => send<SeriesResponse>('POST', '/api/search/histogram', req),
  trace: (traceId) => get<TraceResponse>(`/api/traces/${encodeURIComponent(traceId)}`),
  services: async (range) => (await get<{ services: ServiceSummary[] }>(`/api/services${qs({ ...range })}`)).services,
  metric: (req) => send<SeriesResponse>('POST', '/api/metrics/query', req),
  patterns: (req) => send<PatternsResponse>('POST', '/api/patterns', req),
  // No count route yet: a stat is the sum of the histogram's buckets.
  total: async (req) => {
    const histogram = await send<SeriesResponse>('POST', '/api/search/histogram', { ...req, groupBy: null });
    return histogram.series.reduce((sum, s) => sum + s.points.reduce((a, [, v]) => a + v, 0), 0);
  },
};
