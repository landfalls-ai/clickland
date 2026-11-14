/** The routes of docs/agent-value.md: /api/agents/* (read from telemetry) and /api/value/* (settings, prices, outcomes). */
import {
  AgentParams,
  AgentsQuery,
  type ApiScope,
  ModelPriceInput,
  OutcomeInput,
  OutcomePreviewRequest,
  RunGraphParams,
  SafetyQuery,
  ValueReportQuery,
  ValueSettingsInput,
} from '@clickland/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Services } from './services.js';

const Id = z.object({ id: z.string().min(1).max(100) });
const Key = z.object({ key: z.string().min(1).max(100) });

export function registerAgentRoutes(
  app: FastifyInstance,
  services: Services,
  tools: {
    need: (request: FastifyRequest, scope: ApiScope) => void;
    parse: <S extends z.ZodType>(schema: S, value: unknown) => z.output<S>;
  },
): void {
  const { agents, value, alerts } = services;
  const { need, parse } = tools;

  // Agents: all read from telemetry ---------------------------------------------------------------------------------
  app.get('/api/agents', async (r) => (need(r, 'read'), agents.list(parse(AgentsQuery, r.query))));
  app.get('/api/agents/value', async (r) => (need(r, 'read'), agents.value(parse(ValueReportQuery, r.query))));
  app.get('/api/agents/safety', async (r) => (need(r, 'read'), agents.safety(parse(SafetyQuery, r.query))));
  app.get('/api/agents/runs/:traceId/graph', async (r) => {
    need(r, 'read');
    return agents.graph(parse(RunGraphParams, r.params).traceId);
  });
  app.get('/api/agents/alert-templates', async (r) => (need(r, 'read'), { templates: agents.alertTemplates() }));
  app.post('/api/agents/alert-templates/:key/install', async (r, reply) => {
    need(r, 'alerts:write');
    const template = agents.alertTemplate(parse(Key, r.params).key);
    return reply.status(201).send(await alerts.create(template.alert, r.principal.name));
  });
  app.get('/api/agents/:id', async (r) => {
    need(r, 'read');
    return agents.detail(parse(AgentParams, r.params).id, parse(AgentsQuery.omit({ family: true }), r.query));
  });

  // What value is computed from: reading is `read`, changing is `admin` (these numbers decide every figure) ----------
  app.get('/api/value/settings', async (r) => (need(r, 'read'), value.settings()));
  app.put('/api/value/settings', async (r) => {
    need(r, 'admin');
    return value.updateSettings(parse(ValueSettingsInput, r.body), r.principal.name);
  });

  app.get('/api/value/prices', async (r) => (need(r, 'read'), { prices: await value.prices() }));
  app.post('/api/value/prices', async (r, reply) => {
    need(r, 'admin');
    return reply.status(201).send(await value.createPrice(parse(ModelPriceInput, r.body), r.principal.name));
  });
  app.put('/api/value/prices/:id', async (r) => {
    need(r, 'admin');
    return value.updatePrice(parse(Id, r.params).id, parse(ModelPriceInput, r.body), r.principal.name);
  });
  app.delete('/api/value/prices/:id', async (r, reply) => {
    need(r, 'admin');
    await value.deletePrice(parse(Id, r.params).id);
    return reply.status(204).send();
  });

  app.get('/api/value/outcomes', async (r) => (need(r, 'read'), { outcomes: await value.outcomes() }));
  app.post('/api/value/outcomes', async (r, reply) => {
    need(r, 'admin');
    return reply.status(201).send(await value.createOutcome(parse(OutcomeInput, r.body), r.principal.name));
  });
  app.post('/api/value/outcomes/preview', async (r) => {
    need(r, 'read');
    return agents.preview(parse(OutcomePreviewRequest, r.body));
  });
  app.get('/api/value/outcomes/:id', async (r) => (need(r, 'read'), value.outcome(parse(Id, r.params).id)));
  app.put('/api/value/outcomes/:id', async (r) => {
    need(r, 'admin');
    return value.updateOutcome(parse(Id, r.params).id, parse(OutcomeInput, r.body));
  });
  app.delete('/api/value/outcomes/:id', async (r, reply) => {
    need(r, 'admin');
    await value.deleteOutcome(parse(Id, r.params).id);
    return reply.status(204).send();
  });

  app.post('/api/value/seed', async (r) => (need(r, 'admin'), value.seed(r.principal.name)));
}
