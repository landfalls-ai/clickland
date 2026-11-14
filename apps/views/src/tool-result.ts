import { ViewSpec, type PanelInput, type RangeInput } from '@clickland/contracts';

/** What the app draws: a view, its id when it is saved, and where the console shows it. */
export interface LoadedView {
  spec: ViewSpec;
  id: string | null;
  pinned: boolean;
  /** The view's page in the console (render_view returns it); its origin is the console's. */
  url: string | null;
}

export interface ToolCall {
  name?: string;
  arguments?: Record<string, unknown>;
  result: { structuredContent?: Record<string, unknown>; content?: Array<{ type: string; text?: string }>; isError?: boolean };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

/** The structured content of a tool result, or the JSON in its first text block. */
export function structured(result: ToolCall['result']): Obj | null {
  if (isObj(result.structuredContent)) return result.structuredContent;
  for (const block of result.content ?? []) {
    if (block.type === 'text' && block.text) {
      try {
        const parsed: unknown = JSON.parse(block.text);
        if (isObj(parsed)) return parsed;
      } catch {
        // Plain text, not JSON.
      }
    }
  }
  return null;
}

function rangeOf(args: Obj): RangeInput {
  const from = str(args.from);
  const to = str(args.to);
  if (from && to) return { from, to };
  if (typeof args.lastMinutes === 'number') return { lastMinutes: args.lastMinutes };
  return { lastMinutes: 60 };
}

function oneOf(panel: PanelInput, args: Obj, title: string): ViewSpec {
  return ViewSpec.parse({ title, range: rangeOf(args), panels: [{ ...panel, width: 'full' }] });
}

/**
 * Turns a tool result into the view to draw. `render_view`, `get_view` and `update_view` carry a ViewSpec (with the
 * view's id); `search_logs`, `search_traces`, `get_trace`, `list_services` and `query_metric` become a one-panel view
 * of the same query, so the panel stays live.
 */
export function viewFromToolResult(call: ToolCall): LoadedView {
  if (call.result.isError) {
    const text = call.result.content?.find((c) => c.type === 'text')?.text;
    throw new Error(text || 'The tool failed.');
  }
  const sc = structured(call.result) ?? {};
  const args = call.arguments ?? {};
  const name = call.name ?? '';

  // A view: { id, spec, … } (render_view, get_view, update_view), { view: { … } }, or a bare spec.
  const view = isObj(sc.view) ? sc.view : sc;
  const rawSpec = isObj(view.spec) ? view.spec : Array.isArray(view.panels) ? view : null;
  if (rawSpec) {
    const parsed = ViewSpec.safeParse(rawSpec);
    if (!parsed.success) throw new Error(`The view is not valid: ${parsed.error.issues[0]?.message ?? 'unknown problem'}`);
    return {
      spec: parsed.data,
      id: str(view.id) ?? str(sc.id) ?? null,
      pinned: view.pinned === true,
      url: str(view.url) ?? str(sc.url) ?? null,
    };
  }

  const query = str(args.query) ?? '';
  const loaded = (spec: ViewSpec): LoadedView => ({ spec, id: null, pinned: false, url: null });

  if (name === 'get_trace' || (Array.isArray(sc.spans) && str(sc.traceId))) {
    const traceId = str(sc.traceId) ?? str(args.traceId) ?? '';
    return loaded(oneOf({ type: 'trace', title: `Trace ${traceId.slice(0, 12)}`, traceId }, args, `Trace ${traceId.slice(0, 12)}`));
  }
  if (name === 'list_services' || Array.isArray(sc.services)) {
    return loaded(oneOf({ type: 'services', title: 'Services' }, args, 'Services'));
  }
  if (name === 'query_metric' || str(args.metric)) {
    const metric = str(args.metric) ?? 'metric';
    const aggregation = (str(args.aggregation) ?? 'avg') as never;
    return loaded(
      oneOf(
        {
          type: 'metric',
          title: `${metric} (${aggregation})`,
          metric,
          metricType: (str(args.type) ?? 'gauge') as never,
          aggregation,
          service: str(args.service) ?? null,
          groupBy: str(args.groupBy) ?? null,
        },
        args,
        metric,
      ),
    );
  }
  const traces =
    name === 'search_traces' ||
    args.signal === 'traces' ||
    (Array.isArray(sc.rows) && isObj(sc.rows[0]) && 'durationMs' in sc.rows[0]);
  if (name === 'search_logs' || name === 'search_traces' || Array.isArray(sc.rows)) {
    const limit = typeof args.limit === 'number' ? Math.min(200, Math.max(1, args.limit)) : 50;
    const title = query ? `${traces ? 'Spans' : 'Logs'}: ${query}` : traces ? 'Spans' : 'Logs';
    return loaded(oneOf({ type: traces ? 'spans' : 'logs', title, query, limit }, args, title));
  }
  throw new Error(`Clickland can’t draw the result of ${name || 'this tool'}.`);
}
