import type {
  PatternResult,
  SearchResponse,
  SeriesResponse,
  ServiceSummary,
  Signal,
  TraceResponse,
} from '@clickland/contracts';
import type { TimeBounds } from './time';

export interface SearchQuery extends TimeBounds {
  signal: Signal;
  query: string;
  limit?: number;
  before?: string | null;
}

export interface HistogramQuery extends TimeBounds {
  signal: Signal;
  query: string;
  groupBy?: string | null;
}

export interface MetricQuery extends TimeBounds {
  metric: string;
  type: 'gauge' | 'sum' | 'histogram';
  aggregation: 'avg' | 'min' | 'max' | 'sum' | 'rate' | 'p50' | 'p95' | 'p99';
  service?: string | null;
  groupBy?: string | null;
}

export interface PatternsQuery extends TimeBounds {
  signal: Signal;
  query: string;
  sample?: number;
}

export interface PatternsResponse {
  patterns: PatternResult[];
  sampled: number;
  total: number;
}

/**
 * Where panels get their data. The console implements it over HTTP (/api/…); the MCP App through the host bridge
 * (`callServerTool` with Clickland's MCP tools). Panels only ever talk to this.
 */
export interface DataSource {
  search(req: SearchQuery): Promise<SearchResponse>;
  histogram(req: HistogramQuery): Promise<SeriesResponse>;
  trace(traceId: string): Promise<TraceResponse>;
  services(range: TimeBounds): Promise<ServiceSummary[]>;
  metric(req: MetricQuery): Promise<SeriesResponse>;
  patterns(req: PatternsQuery): Promise<PatternsResponse>;
  /** How many rows match (a stat panel). */
  total(req: Omit<HistogramQuery, 'groupBy'>): Promise<number>;
}

/** Links out of a panel. Each is optional: without one the panel shows no link. */
export interface PanelLinks {
  openTrace?: (traceId: string) => void;
  openSearch?: (search: { signal: Signal; query: string }) => void;
  openService?: (name: string) => void;
}
