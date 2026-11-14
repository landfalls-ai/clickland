import {
  AddPanelRequest,
  type ApiScope,
  HistogramRequest,
  KnowledgeSearchRequest,
  MetricQueryRequest,
  NoteInput,
  PatternsRequest,
  SearchRequest,
  ViewSpec,
} from '@clickland/contracts';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { type Principal, requireScope } from './auth.js';
import { ApiError } from './errors.js';
import type { Services } from './services.js';
import { resolveRange } from './telemetry.js';
import { VIEW_RESOURCE_URI } from './views.js';

export const VERSION = '0.1.0';

const VIEW_META = { ui: { resourceUri: VIEW_RESOURCE_URI } };

/** The built MCP App (apps/views → one HTML file). Read once; a missing build serves a page that says so. */
let viewHtml: Promise<string> | null = null;
export function loadViewHtml(path: string): Promise<string> {
  viewHtml ??= readFile(path, 'utf8').catch(
    () =>
      '<!doctype html><meta charset="utf-8"><title>Clickland view</title><body style="font:14px system-ui;padding:16px">The Clickland view is not built: run <code>pnpm --filter @clickland/views build</code>.</body>',
  );
  return viewHtml;
}

const ok = (data: unknown, text?: string): CallToolResult => ({
  content: [{ type: 'text', text: text ?? JSON.stringify(data) }],
  structuredContent: data as Record<string, unknown>,
});

const fail = (error: unknown): CallToolResult => {
  const message =
    error instanceof ApiError
      ? `${error.code}: ${error.message}`
      : error instanceof Error
        ? error.message
        : String(error);
  return { content: [{ type: 'text', text: message }], isError: true };
};

/** A view's tool result: the view and its marker, so a chat answer can show it inline (`[[clickland:view:…]]`). */
const viewResult = (view: {
  id: string;
  title: string;
  spec: unknown;
  pinned: boolean;
  version: number;
  url: string;
  marker: string;
}) =>
  ok(
    {
      view: { id: view.id, title: view.title, spec: view.spec, pinned: view.pinned, version: view.version },
      url: view.url,
      marker: view.marker,
    },
    `View "${view.title}" (${view.id}) is ready: ${view.url}\nPut ${view.marker} in your answer to show it to the person inline.`,
  );

/**
 * One MCP server per request (stateless Streamable HTTP), bound to the caller's principal so every tool checks the
 * same scopes as the REST API.
 */
export function createMcpServer(services: Services, principal: Principal, viewHtmlPath: string): McpServer {
  const server = new McpServer(
    { name: 'clickland', title: 'Clickland', version: VERSION },
    {
      instructions:
        'Clickland holds the land family\'s logs, traces and metrics (ClickHouse, OpenTelemetry). Search with search_logs / search_traces (a Lucene-like language: words, "phrases", field:value, field:>n, AND/OR/NOT), open a trace with get_trace, compare services with list_services, chart with histogram / query_metric, cluster messages with event_patterns, and look up what people learned with search_knowledge. To show a person a screen, call render_view with panels; put the returned marker in your answer.',
    },
  );
  const { telemetry, alerts, notes, views, knowledge } = services;
  const tool = <S extends z.ZodType>(
    name: string,
    config: { title: string; description: string; inputSchema: S; scope?: ApiScope; ui?: boolean; readOnly?: boolean },
    run: (args: z.output<S>) => Promise<CallToolResult>,
  ) => {
    const handler = async (args: z.output<S>) => {
      try {
        requireScope(principal, config.scope ?? 'read');
        return await run(args);
      } catch (error) {
        return fail(error);
      }
    };
    const meta = {
      title: config.title,
      description: config.description,
      inputSchema: config.inputSchema,
      annotations: { readOnlyHint: config.readOnly ?? true, openWorldHint: false },
    };
    if (config.ui) registerAppTool(server, name, { ...meta, _meta: VIEW_META }, handler as never);
    else server.registerTool(name, meta, handler as never);
  };

  const searchInput = SearchRequest.omit({ signal: true });
  tool(
    'search_logs',
    {
      title: 'Search logs',
      description: 'Newest log rows matching a search. Returns rows and a cursor for the next page.',
      inputSchema: searchInput,
      ui: true,
    },
    async (a) => ok({ signal: 'logs', ...(await telemetry.search({ ...a, signal: 'logs' })) }),
  );
  tool(
    'search_traces',
    {
      title: 'Search spans',
      description: 'Newest spans matching a search (e.g. "service:checkout duration:>500 status:error").',
      inputSchema: searchInput,
      ui: true,
    },
    async (a) => ok({ signal: 'traces', ...(await telemetry.search({ ...a, signal: 'traces' })) }),
  );
  tool(
    'histogram',
    {
      title: 'Count over time',
      description: 'Rows matching a search per time bucket, optionally one series per value of groupBy.',
      inputSchema: HistogramRequest,
    },
    async (a) => ok(await telemetry.histogram(a)),
  );
  tool(
    'count',
    {
      title: 'Count',
      description: 'How many rows match a search in a range.',
      inputSchema: z.object({
        signal: SearchRequest.shape.signal,
        query: z.string().max(4000).default(''),
        from: z.string().optional(),
        to: z.string().optional(),
      }),
    },
    async (a) => ok({ count: await telemetry.total(a.signal, a.query, resolveRange(a)) }),
  );
  tool(
    'get_trace',
    {
      title: 'Get a trace',
      description: 'Every span of a trace in tree order, with depth, offset and duration.',
      inputSchema: z.object({ traceId: z.string().regex(/^[0-9a-fA-F]{1,64}$/) }),
      ui: true,
    },
    async (a) => ok(await telemetry.trace(a.traceId)),
  );
  tool(
    'list_services',
    {
      title: 'List services',
      description: 'Each service: requests, error rate, latency p50/p95/p99 and error logs.',
      inputSchema: z.object({ from: z.string().optional(), to: z.string().optional() }),
      ui: true,
    },
    async (a) => ok(await telemetry.services(a)),
  );
  tool(
    'list_metrics',
    {
      title: 'List metrics',
      description: 'The metric names with their type, unit and services.',
      inputSchema: z.object({ from: z.string().optional(), to: z.string().optional() }),
    },
    async (a) => ok(await telemetry.metricNames(a)),
  );
  tool(
    'query_metric',
    {
      title: 'Query a metric',
      description: 'A metric over time: avg/min/max/sum, rate for counters, p50/p95/p99 for histograms.',
      inputSchema: MetricQueryRequest,
      ui: true,
    },
    async (a) => ok({ request: a, ...(await telemetry.metric(a)) }),
  );
  tool(
    'event_patterns',
    {
      title: 'Event patterns',
      description: 'Clusters matching messages into templates (Drain), with counts and an example each.',
      inputSchema: PatternsRequest,
    },
    async (a) => ok(await telemetry.patterns(a)),
  );
  tool(
    'list_alerts',
    { title: 'List alerts', description: 'Every alert with its current state per group.', inputSchema: z.object({}) },
    async () => ok({ alerts: await alerts.list() }),
  );
  tool(
    'search_knowledge',
    {
      title: 'Search knowledge',
      description: 'What Clickland knows that answers a question: notes, alerts, services and log patterns.',
      inputSchema: KnowledgeSearchRequest,
    },
    async (a) => ok(await knowledge.search(a)),
  );
  tool(
    'add_note',
    {
      title: 'Add a note',
      description: 'Record what was learned (a finding, a cause, a fix), so the next person or agent finds it.',
      inputSchema: NoteInput,
      scope: 'notes:write',
      readOnly: false,
    },
    async (a) => ok({ note: await notes.create(a, principal.name) }),
  );

  // Views and dashboards (MCP UI).
  tool(
    'render_view',
    {
      title: 'Show a view',
      description:
        'Build a screen for the person: a title, a range ({"lastMinutes":60}) and 1–12 panels (timeseries, bar, stat, logs, spans, trace, services, patterns, metric, markdown; width half|full). Set pinned to save it as a dashboard.',
      inputSchema: z.object({ spec: ViewSpec, pinned: z.boolean().default(false) }),
      ui: true,
      readOnly: false,
    },
    async (a) => {
      if (a.pinned) requireScope(principal, 'views:write');
      return viewResult(await views.create(a, principal.name));
    },
  );
  tool(
    'get_view',
    {
      title: 'Get a view',
      description: 'A view or dashboard by id.',
      inputSchema: z.object({ id: z.string() }),
      ui: true,
    },
    async (a) => viewResult(await views.get(a.id)),
  );
  tool(
    'update_view',
    {
      title: 'Change a view',
      description:
        "Replace a view's spec, rename it, or pin it as a dashboard (pinned: true). Send version to fail on a concurrent edit.",
      inputSchema: z.object({
        id: z.string(),
        spec: ViewSpec.optional(),
        title: z.string().min(1).max(200).optional(),
        pinned: z.boolean().optional(),
        version: z.number().int().optional(),
      }),
      scope: 'views:write',
      ui: true,
      readOnly: false,
    },
    async ({ id, ...rest }) => viewResult(await views.update(id, rest)),
  );
  tool(
    'add_panel',
    {
      title: 'Add a panel',
      description: 'Add a panel to a view (at the end, or at position).',
      inputSchema: AddPanelRequest.extend({ id: z.string() }),
      scope: 'views:write',
      ui: true,
      readOnly: false,
    },
    async (a) => viewResult(await views.addPanel(a.id, a.panel, a.position)),
  );
  tool(
    'remove_panel',
    {
      title: 'Remove a panel',
      description: 'Remove the panel at index (0-based) from a view.',
      inputSchema: z.object({ id: z.string(), index: z.number().int().min(0) }),
      scope: 'views:write',
      ui: true,
      readOnly: false,
    },
    async (a) => viewResult(await views.removePanel(a.id, a.index)),
  );
  tool(
    'list_dashboards',
    { title: 'List dashboards', description: 'The saved dashboards (pinned views).', inputSchema: z.object({}) },
    async () => ok({ dashboards: await views.list({ pinned: true }) }),
  );

  registerAppResource(
    server,
    'Clickland view',
    VIEW_RESOURCE_URI,
    { description: 'Draws a Clickland view: live charts, tables, traces and patterns.', mimeType: RESOURCE_MIME_TYPE },
    async () => ({
      contents: [{ uri: VIEW_RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: await loadViewHtml(viewHtmlPath) }],
    }),
  );
  return server;
}
