import type {
  RunGraphResponse,
  SearchResponse,
  SeriesResponse,
  ServiceSummary,
  TraceResponse,
  ValueReportResponse,
} from '@clickland/contracts';
import type { AgentCardData, DataSource, PatternsResponse } from '@clickland/ui';
import { structured, type ToolCall } from './tool-result';

/** Calls one of the server's tools through the host (`App.callServerTool`). */
export type CallTool = (name: string, args: Record<string, unknown>) => Promise<ToolCall['result']>;

async function call<T>(callTool: CallTool, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await callTool(name, args);
  if (result.isError) {
    const text = result.content?.find((c) => c.type === 'text')?.text;
    throw new Error(text || `${name} failed.`);
  }
  const body = structured(result);
  if (!body) throw new Error(`${name} returned no data.`);
  return body as T;
}

/** Panels fetch their data through Clickland's MCP tools, so the view works in any MCP Apps host. */
export function mcpDataSource(callTool: CallTool): DataSource {
  return {
    search: (req) =>
      call<SearchResponse>(callTool, req.signal === 'traces' ? 'search_traces' : 'search_logs', { ...req }),
    histogram: (req) => call<SeriesResponse>(callTool, 'histogram', { ...req }),
    trace: (traceId) => call<TraceResponse>(callTool, 'get_trace', { traceId }),
    services: async (range) =>
      (await call<{ services: ServiceSummary[] }>(callTool, 'list_services', { ...range })).services,
    metric: (req) => call<SeriesResponse>(callTool, 'query_metric', { ...req }),
    patterns: (req) => call<PatternsResponse>(callTool, 'event_patterns', { ...req }),
    total: async (req) => {
      const body = await call<Record<string, unknown>>(callTool, 'count', { ...req });
      const n = body.count ?? body.total ?? body.value;
      if (typeof n !== 'number') throw new Error('count returned no number.');
      return n;
    },
    agents: ({ from, to, service }) =>
      call<{ agents: AgentCardData[]; truncated: boolean }>(callTool, 'list_agents', {
        from,
        to,
        ...(service ? { service } : {}),
      }),
    agentValue: ({ from, to, agent, team, service }) =>
      call<ValueReportResponse>(callTool, 'agent_value', {
        from,
        to,
        ...(agent ? { agent } : {}),
        ...(team ? { team } : {}),
        ...(service ? { service } : {}),
      }),
    runGraph: (traceId) => call<RunGraphResponse>(callTool, 'run_graph', { traceId }),
  };
}
