/**
 * Alerts on the direct route reach a Landfall-shaped `POST /triggers` (an in-process fake that keeps rooms by dedup
 * key, as Landfall does) and the room's link lands on the alert events. Every body is checked against Landfall's
 * OpenAPI `SourceTriggerPayload`. CLICKLAND_INTEGRATION=db pnpm --filter @clickland/api test:integration
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createClients } from '../src/clients.js';
import { configFromEnv } from '../src/config.js';
import { createServices } from '../src/services.js';
import { haveOpenApi, validateAgainst } from './landfall-openapi.js';

const enabled = (process.env.CLICKLAND_INTEGRATION ?? '').split(',').includes('db');
const config = {
  ...configFromEnv({ CLICKLAND_AUTH: 'keys', CLICKLAND_BOOTSTRAP_KEY: 'ck_test_bootstrap_key_00000000000000' }),
  backgroundJobs: false,
};
const auth = { authorization: `Bearer ${config.bootstrapKey}` };
const TOKEN = 'test-ingest-token';

/** A stand-in for Landfall's trigger door: bearer ingest token, one open room per dedup key, recovery never closes. */
function fakeLandfall() {
  const received: { body: Record<string, unknown>; problems: string[]; authorized: boolean }[] = [];
  const open = new Map<string, string>();
  let rooms = 0;
  const server = createServer((req, res) => {
    let text = '';
    req.on('data', (c: Buffer) => (text += c));
    req.on('end', () => {
      const authorized = req.headers.authorization === `Bearer ${TOKEN}`;
      const body = JSON.parse(text) as Record<string, unknown>;
      received.push({ body, authorized, problems: haveOpenApi ? validateAgainst('SourceTriggerPayload', body) : [] });
      const send = (status: number, answer: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer));
      };
      if (!authorized) return send(401, { message: 'Missing trigger ingest token' });
      const key = String(body.dedupKey);
      const room = open.get(key);
      const result = (outcome: string, id: string) => ({
        outcome,
        incidentId: id,
        tenantId: 't',
        entity: {},
        proposedSeverity: body.severity,
        workspaceUrl: id ? `http://localhost:5173/o/local/incidents/${id}` : '',
      });
      if (body.kind === 'recovery')
        return send(200, room ? result('recorded', room) : { ...result('ignored', ''), reason: 'no-open-incident' });
      if (room) return send(200, result('attached', room));
      const id = `inc_test_${++rooms}`;
      open.set(key, id);
      return send(201, result('opened', id));
    });
  });
  return { server, received };
}

describe.skipIf(!enabled)('the direct route to Landfall (live stack, fake Landfall)', () => {
  const clients = createClients(config);
  const services = createServices(config, clients);
  const landfall = fakeLandfall();
  let app: Awaited<ReturnType<typeof buildApp>>;
  let triggersUrl = '';
  const alertIds: string[] = [];
  const hookIds: string[] = [];

  beforeAll(async () => {
    app = await buildApp(services, { viewHtmlPath: '/nonexistent' });
    await new Promise<void>((r) => landfall.server.listen(0, '127.0.0.1', r));
    triggersUrl = `http://127.0.0.1:${(landfall.server.address() as AddressInfo).port}/triggers`;
  });
  afterAll(async () => {
    for (const id of hookIds) await clients.pg`DELETE FROM webhooks WHERE id = ${id}`;
    for (const id of alertIds) await clients.pg`DELETE FROM alerts WHERE id = ${id}`;
    await new Promise((r) => (landfall.server as Server).close(r));
    await app.close();
    await clients.close();
  });

  /** An alert that fires now: fewer than 1 row match a search that matches nothing. Disabled, so no evaluator runs it. */
  const createAlert = async (name: string, extra: Record<string, unknown>) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/alerts',
      headers: auth,
      payload: {
        name,
        signal: 'logs',
        query: 'service:"clickland-test-direct-route" level:error',
        thresholdType: 'below',
        threshold: 1,
        windowMinutes: 5,
        enabled: false,
        labels: { team: 'core' },
        runbookUrl: 'https://runbooks.example/direct',
        ...extra,
      },
    });
    expect(res.statusCode).toBe(201);
    alertIds.push(res.json().id);
    return res.json() as { id: string };
  };

  const createHook = async (payload: Record<string, unknown>) => {
    const res = await app.inject({ method: 'POST', url: '/api/webhooks', headers: auth, payload });
    expect(res.statusCode).toBe(201);
    hookIds.push(res.json().id);
    return res.json() as { id: string };
  };

  /** Sends this test's deliveries (only these webhooks', so the shared dev database's other deliveries are left alone). */
  const deliver = async (hooks: string[]) => {
    for (let i = 0; i < 10; i++) {
      await clients.pg`UPDATE webhook_deliveries SET next_attempt_at = now() WHERE webhook_id = ANY (${hooks}) AND status = 'pending'`;
      await services.webhooks.dispatchDue(50, hooks);
      const [{ n }] = await clients.pg<{ n: number }[]>`
        SELECT count(*)::int AS n FROM webhook_deliveries WHERE webhook_id = ANY (${hooks}) AND status = 'pending'`;
      if (n === 0) return;
    }
  };

  const evaluate = async (alertId: string, threshold?: number) => {
    const [row] = await clients.pg`SELECT * FROM alerts WHERE id = ${alertId}`;
    return services.alerts.evaluate({ ...(row as object), ...(threshold === undefined ? {} : { threshold }) } as never);
  };

  const events = async (alertId: string) =>
    (await app.inject({ url: `/api/alerts/${alertId}/events`, headers: auth })).json().events as {
      id: string;
      state: string;
      incident: { id: string | null; url: string | null; outcome: string } | null;
    }[];

  it('a sev1 alert opens a room, its resolve is recorded on it, and the next firing attaches to it', async () => {
    const alert = await createAlert('Test direct sev1', { severity: 'sev1' });
    const direct = await createHook({
      url: triggersUrl,
      events: ['alert.firing', 'alert.resolved'],
      alertId: alert.id,
      format: 'landfall',
      landfall: { ingestToken: TOKEN, connectionId: 'conn_test' },
    });
    const listed = (await app.inject({ url: `/api/webhooks/${direct.id}`, headers: auth })).json();
    expect(listed).toMatchObject({ format: 'landfall', landfall: { connectionId: 'conn_test' } });
    expect(JSON.stringify(listed)).not.toContain(TOKEN);

    // Fires: Landfall opens a room; the event keeps its link.
    expect((await evaluate(alert.id)).map((e) => e.state)).toEqual(['firing']);
    await deliver([direct.id]);
    let list = await events(alert.id);
    expect(list[0]!.incident).toMatchObject({
      id: 'inc_test_1',
      url: 'http://localhost:5173/o/local/incidents/inc_test_1',
      outcome: 'opened',
    });

    // Resolves: a recovery, recorded on the same room (Landfall never closes a room for it).
    expect((await evaluate(alert.id, 0)).map((e) => e.state)).toEqual(['ok']);
    list = await events(alert.id);
    expect(list[0]!.incident).toMatchObject({ id: 'inc_test_1', outcome: 'pending' });
    await deliver([direct.id]);
    list = await events(alert.id);
    expect(list[0]!.incident).toMatchObject({ id: 'inc_test_1', outcome: 'recorded' });

    // Fires again: shown on the room at once, and Landfall attaches it there.
    await evaluate(alert.id);
    expect((await events(alert.id))[0]!.incident).toMatchObject({ id: 'inc_test_1', outcome: 'pending' });
    await deliver([direct.id]);
    list = await events(alert.id);
    expect(list.map((e) => [e.state, e.incident?.outcome])).toEqual([
      ['firing', 'attached'],
      ['ok', 'recorded'],
      ['firing', 'opened'],
    ]);
    const state = (await app.inject({ url: `/api/alerts/${alert.id}`, headers: auth })).json().states[0];
    expect(state.incident).toMatchObject({ id: 'inc_test_1', outcome: 'attached' });

    const bodies = landfall.received.filter((r) => r.body.dedupKey === `${alert.id}:`);
    expect(bodies.map((r) => r.body.kind)).toEqual(['trigger', 'recovery', 'trigger']);
    for (const r of bodies) {
      expect(r.authorized).toBe(true);
      expect(r.problems).toEqual([]);
      expect(r.body).toMatchObject({
        landfallSource: 'remote',
        connectionId: 'conn_test',
        severity: 'sev1',
        title: 'Test direct sev1',
        entityHints: ['service:clickland-test-direct-route', 'team:core'],
      });
      expect(r.body.summary).toContain('Runbook: https://runbooks.example/direct');
    }
  });

  it('only the direct route goes to a landfall webhook; standard webhooks get every alert with its route', async () => {
    const triage = await createAlert('Test triage sev3', { severity: 'sev3' });
    const flagged = await createAlert('Test about Landflow', { severity: 'sev2', direct: true });
    const direct = await createHook({
      url: triggersUrl,
      events: ['alert.firing'],
      format: 'landfall',
      landfall: { ingestToken: TOKEN, connectionId: 'conn_test' },
    });
    const standard = await createHook({ url: 'http://127.0.0.1:9/hook', events: ['alert.firing'] });
    const before = landfall.received.length;
    try {
      await evaluate(triage.id);
      await evaluate(flagged.id);
      const queued = await clients.pg<
        {
          webhook_id: string;
          payload: { title?: string; data: { route: string; alert: { id: string; name: string } } };
        }[]
      >`
        SELECT webhook_id, payload FROM webhook_deliveries WHERE webhook_id = ANY (${[direct.id, standard.id]})`;
      const toLandfall = queued.filter((q) => q.webhook_id === direct.id).map((q) => q.payload.title);
      expect(toLandfall).toEqual(['Test about Landflow']);
      const routes = Object.fromEntries(
        queued
          .filter((q) => q.webhook_id === standard.id && alertIds.includes(q.payload.data.alert.id))
          .map((q) => [q.payload.data.alert.name, q.payload.data.route]),
      );
      expect(routes).toMatchObject({ 'Test triage sev3': 'triage', 'Test about Landflow': 'direct' });
      await deliver([direct.id]);
      const sent = landfall.received.slice(before).filter((r) => r.body.dedupKey === `${flagged.id}:`);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.body.severity).toBe('sev2');
    } finally {
      // The catch-all hooks see every alert while they exist: remove them before other tests run.
      await clients.pg`DELETE FROM webhooks WHERE id = ANY (${[direct.id, standard.id]})`;
    }
  });

  it('a refusal from Landfall stays on the delivery, with its reason, for a retry', async () => {
    const alert = await createAlert('Test refused', { severity: 'sev1' });
    const hook = await createHook({
      url: triggersUrl,
      events: ['alert.firing'],
      alertId: alert.id,
      format: 'landfall',
      landfall: { ingestToken: 'wrong-token', connectionId: 'conn_test' },
    });
    await evaluate(alert.id);
    await services.webhooks.dispatchDue(50, [hook.id]);
    const [d] = (await app.inject({ url: `/api/webhooks/${hook.id}/deliveries`, headers: auth })).json().deliveries;
    expect(d).toMatchObject({ status: 'pending', attempts: 1 });
    expect(d.lastError).toMatch(/^HTTP 401: .*ingest token/);
    expect((await events(alert.id))[0]!.incident).toBeNull();
  });
});
