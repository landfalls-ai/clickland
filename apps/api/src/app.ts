import {
  AddPanelRequest,
  AlertInput,
  ApiKeyInput,
  type ApiScope,
  CreateViewRequest,
  FacetsRequest,
  HistogramRequest,
  KnowledgeSearchRequest,
  MetricQueryRequest,
  NoteInput,
  PatternsRequest,
  SearchRequest,
  UpdateViewRequest,
  WebhookInput,
} from '@clickland/contracts';
import cors from '@fastify/cors';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { askAssistant } from './assistant.js';
import { authenticate, type Principal, requireScope } from './auth.js';
import { ApiError } from './errors.js';
import { createMcpServer, VERSION } from './mcp.js';
import type { Services } from './services.js';
import { registerSourceProtocol } from './source-protocol.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal;
  }
}

export interface AppOptions {
  /** Where the built MCP App lives (apps/views/dist/view.html). */
  viewHtmlPath: string;
  /** Signs a request in from something other than an API key (the console's session cookie). */
  sessionPrincipal?: (request: FastifyRequest) => Promise<Principal | null>;
  /** Extra routes (sign-in, SCIM) registered before the API's own. */
  plugins?: ((app: FastifyInstance) => Promise<void> | void)[];
  logger?: boolean;
  fetchImpl?: typeof fetch;
}

/** Validates a body, query or params object; the first problem becomes a 400 that names its path. */
export function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value ?? {});
  if (result.success) return result.data;
  const issue = result.error.issues[0]!;
  throw new ApiError('bad_request', `${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}`, {
    issues: result.error.issues,
  });
}

const Id = z.object({ id: z.string().min(1).max(100) });
const Range = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});
const PUBLIC = new Set(['/api/health', '/api/auth/login', '/api/auth/callback', '/api/auth/logout', '/api/auth/me']);

export async function buildApp(services: Services, options: AppOptions): Promise<FastifyInstance> {
  const { config, telemetry, alerts, webhooks, notes, views, knowledge, keys } = services;
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 2 * 1024 * 1024, trustProxy: true });
  await app.register(cors, { origin: [config.consoleUrl], credentials: true });
  app.decorateRequest('principal', null as unknown as Principal);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) return reply.status(error.status).send(error.body());
    const e = error as { statusCode?: number; validation?: unknown; code?: string; message: string };
    if (e.statusCode && e.statusCode < 500)
      return reply
        .status(e.statusCode)
        .send(new ApiError(e.statusCode === 404 ? 'not_found' : 'bad_request', e.message).body());
    request.log.error(error);
    console.error(error);
    return reply.status(500).send(new ApiError('internal', 'Something went wrong in Clickland').body());
  });
  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send(new ApiError('not_found', `No route ${request.method} ${request.url.split('?')[0]}`).body()),
  );

  // Who is calling: an API key, else the console's session, else (CLICKLAND_AUTH=dev) the local developer.
  app.addHook('onRequest', async (request) => {
    const path = request.url.split('?')[0]!;
    if (!path.startsWith('/api/') || PUBLIC.has(path)) return;
    if (!request.headers.authorization && options.sessionPrincipal) {
      const principal = await options.sessionPrincipal(request);
      if (principal) {
        request.principal = principal;
        return;
      }
    }
    request.principal = await authenticate(services.clients.pg, config, request.headers.authorization);
  });
  const need = (request: FastifyRequest, scope: ApiScope) => requireScope(request.principal, scope);

  for (const plugin of options.plugins ?? []) await plugin(app);

  // Landfall's Source Protocol (`/v1/*`): Clickland as a remote source in Landfall's war room.
  await registerSourceProtocol(app, services);

  app.get('/api/health', async (_request, reply) => {
    const check = async (fn: () => Promise<unknown>) =>
      fn().then(
        () => 'ok' as const,
        (e: unknown) => (e instanceof Error ? e.message : 'down'),
      );
    const [clickhouse, postgres] = await Promise.all([
      check(() => services.clients.ch.query({ query: 'SELECT 1' }).then((r) => r.close())),
      check(() => services.clients.pg`SELECT 1`),
    ]);
    const status = clickhouse === 'ok' && postgres === 'ok' ? 'ok' : 'degraded';
    return reply.status(status === 'ok' ? 200 : 503).send({ status, clickhouse, postgres, version: VERSION });
  });

  if (!options.plugins?.length) {
    // Without the sign-in plugin, "me" says who the API key or dev mode is.
    app.get('/api/auth/me', async (request, reply) => {
      try {
        const principal = await authenticate(services.clients.pg, config, request.headers.authorization);
        const roles = principal.scopes.includes('admin')
          ? ['admin']
          : principal.scopes.some((s) => s.endsWith(':write'))
            ? ['editor']
            : ['viewer'];
        return {
          user: { name: principal.name === 'dev' ? 'Local developer' : principal.name, email: null, roles },
          authMode: config.authMode,
          scopes: principal.scopes,
        };
      } catch (error) {
        if (error instanceof ApiError) return reply.status(error.status).send(error.body());
        throw error;
      }
    });
  }

  // Telemetry ------------------------------------------------------------------------------------------------------
  app.post('/api/search', async (r) => (need(r, 'read'), telemetry.search(parse(SearchRequest, r.body))));
  app.post(
    '/api/search/histogram',
    async (r) => (need(r, 'read'), telemetry.histogram(parse(HistogramRequest, r.body))),
  );
  app.post('/api/facets', async (r) => (need(r, 'read'), telemetry.facets(parse(FacetsRequest, r.body))));
  app.get('/api/traces/:id', async (r) => {
    need(r, 'read');
    const { id } = parse(z.object({ id: z.string().regex(/^[0-9a-fA-F]{1,64}$/, 'a hex trace id') }), r.params);
    return telemetry.trace(id);
  });
  app.get('/api/services', async (r) => (need(r, 'read'), telemetry.services(parse(Range, r.query))));
  app.get('/api/metrics/names', async (r) => (need(r, 'read'), telemetry.metricNames(parse(Range, r.query))));
  app.post('/api/metrics/query', async (r) => (need(r, 'read'), telemetry.metric(parse(MetricQueryRequest, r.body))));
  app.post('/api/patterns', async (r) => (need(r, 'read'), telemetry.patterns(parse(PatternsRequest, r.body))));

  // Alerts ---------------------------------------------------------------------------------------------------------
  app.get('/api/alerts', async (r) => (need(r, 'read'), { alerts: await alerts.list() }));
  app.post('/api/alerts', async (r, reply) => {
    need(r, 'alerts:write');
    return reply.status(201).send(await alerts.create(parse(AlertInput, r.body), r.principal.name));
  });
  app.get('/api/alerts/:id', async (r) => (need(r, 'read'), alerts.get(parse(Id, r.params).id)));
  app.put(
    '/api/alerts/:id',
    async (r) => (need(r, 'alerts:write'), alerts.update(parse(Id, r.params).id, parse(AlertInput, r.body))),
  );
  app.delete('/api/alerts/:id', async (r, reply) => {
    need(r, 'alerts:write');
    await alerts.delete(parse(Id, r.params).id);
    return reply.status(204).send();
  });
  app.get('/api/alerts/:id/events', async (r) => {
    need(r, 'read');
    const { limit } = parse(z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) }), r.query);
    return { events: await alerts.events(parse(Id, r.params).id, limit) };
  });
  app.post('/api/alerts/:id/test', async (r) => (need(r, 'read'), alerts.test(parse(Id, r.params).id)));

  // Webhooks -------------------------------------------------------------------------------------------------------
  app.get('/api/webhooks', async (r) => (need(r, 'read'), { webhooks: await webhooks.list() }));
  app.post('/api/webhooks', async (r, reply) => {
    need(r, 'webhooks:write');
    return reply.status(201).send(await webhooks.create(parse(WebhookInput, r.body)));
  });
  app.get('/api/webhooks/:id', async (r) => (need(r, 'read'), webhooks.get(parse(Id, r.params).id)));
  app.get(
    '/api/webhooks/:id/deliveries',
    async (r) => (need(r, 'read'), { deliveries: await webhooks.deliveries(parse(Id, r.params).id) }),
  );
  app.delete('/api/webhooks/:id', async (r, reply) => {
    need(r, 'webhooks:write');
    await webhooks.delete(parse(Id, r.params).id);
    return reply.status(204).send();
  });

  // Views and dashboards ---------------------------------------------------------------------------------------------
  // Creating a view is a read: an agent with a read key may show a person a screen. Pinning or changing one is views:write.
  app.post('/api/views', async (r, reply) => {
    const body = parse(CreateViewRequest, r.body);
    need(r, body.pinned ? 'views:write' : 'read');
    return reply.status(201).send(await views.create(body, r.principal.name));
  });
  app.get('/api/views', async (r) => {
    need(r, 'read');
    const q = parse(
      z.object({
        pinned: z.enum(['true', 'false']).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
      }),
      r.query,
    );
    return {
      views: await views.list({ pinned: q.pinned === undefined ? undefined : q.pinned === 'true', limit: q.limit }),
    };
  });
  app.get('/api/views/:id', async (r) => (need(r, 'read'), views.get(parse(Id, r.params).id)));
  app.put(
    '/api/views/:id',
    async (r) => (need(r, 'views:write'), views.update(parse(Id, r.params).id, parse(UpdateViewRequest, r.body))),
  );
  app.post('/api/views/:id/panels', async (r) => {
    need(r, 'views:write');
    const body = parse(AddPanelRequest, r.body);
    return views.addPanel(parse(Id, r.params).id, body.panel, body.position);
  });
  app.delete('/api/views/:id/panels/:index', async (r) => {
    need(r, 'views:write');
    const p = parse(z.object({ id: z.string(), index: z.coerce.number().int().min(0) }), r.params);
    return views.removePanel(p.id, p.index);
  });
  app.delete('/api/views/:id', async (r, reply) => {
    need(r, 'views:write');
    await views.delete(parse(Id, r.params).id);
    return reply.status(204).send();
  });

  // Notes and knowledge ------------------------------------------------------------------------------------------------
  app.get('/api/notes', async (r) => {
    need(r, 'read');
    const q = parse(
      z.object({
        service: z.string().max(300).optional(),
        q: z.string().max(500).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      }),
      r.query,
    );
    return { notes: await notes.list(q) };
  });
  app.post('/api/notes', async (r, reply) => {
    need(r, 'notes:write');
    return reply.status(201).send(await notes.create(parse(NoteInput, r.body), r.principal.name));
  });
  app.post(
    '/api/knowledge/search',
    async (r) => (need(r, 'read'), knowledge.search(parse(KnowledgeSearchRequest, r.body))),
  );

  // API keys ---------------------------------------------------------------------------------------------------------
  app.get('/api/keys', async (r) => (need(r, 'admin'), { keys: await keys.list() }));
  app.post('/api/keys', async (r, reply) => {
    need(r, 'admin');
    return reply.status(201).send(await keys.create(parse(ApiKeyInput, r.body)));
  });
  app.delete('/api/keys/:id', async (r, reply) => {
    need(r, 'admin');
    await keys.revoke(parse(Id, r.params).id);
    return reply.status(204).send();
  });

  // MCP (stateless Streamable HTTP) ------------------------------------------------------------------------------------
  app.post('/api/mcp', async (request, reply) => {
    const server = createMcpServer(services, request.principal, options.viewHtmlPath);
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });
  const noSessions = async (_r: FastifyRequest, reply: { status: (n: number) => { send: (b: unknown) => unknown } }) =>
    reply.status(405).send({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Clickland’s MCP server is stateless: POST only' },
      id: null,
    });
  app.get('/api/mcp', noSessions);
  app.delete('/api/mcp', noSessions);

  // The Assistant panel: a Landflow chat flow, streamed back as server-sent events ------------------------------------
  app.post('/api/assistant/chat', async (request, reply) => {
    need(request, 'read');
    const body = parse(
      z.object({ sessionId: z.string().min(1).max(200), message: z.string().min(1).max(20_000) }),
      request.body,
    );
    const abort = new AbortController();
    const events = askAssistant(
      config,
      { ...body, user: request.principal.name },
      options.fetchImpl ?? fetch,
      abort.signal,
    );
    // Fails before streaming (503 when Landflow is not connected) keep their status.
    const first = await events.next();
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    reply.raw.on('close', () => abort.abort());
    const send = (event: unknown) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    try {
      if (!first.done) send(first.value);
      for await (const event of events) send(event);
    } catch (error) {
      send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
    reply.raw.end();
  });

  return app;
}
