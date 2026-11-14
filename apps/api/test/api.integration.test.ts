/**
 * The API against the local stack (`pnpm dev:up && pnpm db:migrate`): CLICKLAND_INTEGRATION=db pnpm --filter @clickland/api test:integration
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createClients } from '../src/clients.js';
import { configFromEnv } from '../src/config.js';
import { scopedServices } from './scoped.js';

const enabled = (process.env.CLICKLAND_INTEGRATION ?? '').split(',').includes('db');
const config = {
  ...configFromEnv({ CLICKLAND_AUTH: 'keys', CLICKLAND_BOOTSTRAP_KEY: 'ck_test_bootstrap_key_00000000000000' }),
  backgroundJobs: false,
};
const auth = { authorization: `Bearer ${config.bootstrapKey}` };

describe.skipIf(!enabled)('API (live stack)', () => {
  const clients = createClients(config);
  const services = scopedServices(config, clients);
  let app: Awaited<ReturnType<typeof buildApp>>;
  const created: string[] = [];

  beforeAll(async () => {
    app = await buildApp(services, { viewHtmlPath: '/nonexistent' });
  });
  afterAll(async () => {
    for (const id of created) await clients.pg`DELETE FROM views WHERE id = ${id}`;
    await app.close();
    await clients.close();
  });

  it('is healthy without a key and refuses data without one', async () => {
    expect((await app.inject({ url: '/api/health' })).json()).toMatchObject({ status: 'ok' });
    expect((await app.inject({ method: 'POST', url: '/api/search', payload: { signal: 'logs' } })).statusCode).toBe(
      401,
    );
  });

  it('searches, and a syntax error is a 400 with a position', async () => {
    const ok = await app.inject({
      method: 'POST',
      url: '/api/search',
      headers: auth,
      payload: { signal: 'logs', query: '', limit: 5 },
    });
    expect(ok.statusCode).toBe(200);
    const bad = await app.inject({
      method: 'POST',
      url: '/api/search',
      headers: auth,
      payload: { signal: 'logs', query: '"open' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.details.position).toBe(0);
  });

  it('keeps a dashboard: create, add a panel, a stale save conflicts, remove', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/views',
      headers: auth,
      payload: { pinned: true, spec: { title: 'Test board', panels: [{ type: 'services', title: 'Services' }] } },
    });
    expect(res.statusCode).toBe(201);
    const view = res.json();
    created.push(view.id);
    expect(view.marker).toBe(`[[clickland:view:${view.id}]]`);
    const added = await app.inject({
      method: 'POST',
      url: `/api/views/${view.id}/panels`,
      headers: auth,
      payload: { panel: { type: 'logs', title: 'Errors', query: 'level:error' } },
    });
    expect(added.json().spec.panels).toHaveLength(2);
    expect(added.json().version).toBe(2);
    const stale = await app.inject({
      method: 'PUT',
      url: `/api/views/${view.id}`,
      headers: auth,
      payload: { title: 'Renamed', version: 1 },
    });
    expect(stale.statusCode).toBe(409);
    const removed = await app.inject({ method: 'DELETE', url: `/api/views/${view.id}/panels/0`, headers: auth });
    expect(removed.json().spec.panels.map((p: { type: string }) => p.type)).toEqual(['logs']);
    const list = await app.inject({ url: '/api/views?pinned=true', headers: auth });
    expect(list.json().views.some((v: { id: string }) => v.id === view.id)).toBe(true);
  });

  it('a read-only key can show a view but not save a dashboard', async () => {
    const key = (
      await app.inject({
        method: 'POST',
        url: '/api/keys',
        headers: auth,
        payload: { name: 'test-read', scopes: ['read'] },
      })
    ).json();
    const read = { authorization: `Bearer ${key.key}` };
    const spec = { title: 'Read view', panels: [{ type: 'markdown', title: 'Hi', text: 'hello' }] };
    const shown = await app.inject({ method: 'POST', url: '/api/views', headers: read, payload: { spec } });
    expect(shown.statusCode).toBe(201);
    created.push(shown.json().id);
    expect(
      (await app.inject({ method: 'POST', url: '/api/views', headers: read, payload: { spec, pinned: true } }))
        .statusCode,
    ).toBe(403);
    await app.inject({ method: 'DELETE', url: `/api/keys/${key.id}`, headers: auth });
    expect((await app.inject({ url: '/api/alerts', headers: read })).statusCode).toBe(401);
    await clients.pg`DELETE FROM api_keys WHERE id = ${key.id}`;
  });

  it("keeps an alert's severity, labels and runbook, and sends them in the webhook", async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/alerts',
      headers: auth,
      payload: {
        name: 'Test severity alert',
        signal: 'logs',
        query: 'service:"clickland-test-nothing-here"',
        thresholdType: 'below',
        threshold: 1,
        windowMinutes: 5,
        enabled: false,
        severity: 'sev2',
        labels: { team: 'core' },
        runbookUrl: 'https://runbooks.example/landfall-errors',
      },
    });
    expect(res.statusCode).toBe(201);
    const alert = res.json();
    expect(alert).toMatchObject({
      severity: 'sev2',
      labels: { team: 'core' },
      runbookUrl: 'https://runbooks.example/landfall-errors',
    });
    const hook = await services.webhooks.create({
      url: 'http://127.0.0.1:9/hook',
      events: ['alert.firing'],
      alertId: alert.id,
      description: 'test',
      format: 'standard',
    });
    services.webhooks.allowed.add(hook.id);
    try {
      const [row] = await clients.pg`SELECT * FROM alerts WHERE id = ${alert.id}`;
      const events = await services.alerts.evaluate(row as never);
      expect(events.map((e) => e.state)).toEqual(['firing']);
      const [delivery] = await clients.pg<{ payload: { data: { alert: Record<string, unknown> } } }[]>`
        SELECT payload FROM webhook_deliveries WHERE webhook_id = ${hook.id}`;
      expect(delivery!.payload.data.alert).toMatchObject({
        severity: 'sev2',
        labels: { team: 'core' },
        runbookUrl: 'https://runbooks.example/landfall-errors',
      });
    } finally {
      await clients.pg`DELETE FROM webhooks WHERE id = ${hook.id}`;
      await clients.pg`DELETE FROM alerts WHERE id = ${alert.id}`;
    }
  });

  it('a PUT that omits severity, labels or runbook keeps them, and keeps the groups (and rooms) unless the search changed', async () => {
    const rule = {
      name: 'Test alert edits',
      signal: 'logs',
      query: 'service:"clickland-test-nothing-here"',
      thresholdType: 'below',
      threshold: 1,
      windowMinutes: 5,
      enabled: false,
    };
    const plain = await app.inject({ method: 'POST', url: '/api/alerts', headers: auth, payload: rule });
    expect(plain.json()).toMatchObject({ severity: 'sev3', direct: false, labels: {}, runbookUrl: null });
    await clients.pg`DELETE FROM alerts WHERE id = ${plain.json().id}`;

    const created = await app.inject({
      method: 'POST',
      url: '/api/alerts',
      headers: auth,
      payload: { ...rule, severity: 'sev1', labels: { team: 'core' }, runbookUrl: 'https://runbooks.example/x' },
    });
    const id = created.json().id as string;
    const put = (payload: object) => app.inject({ method: 'PUT', url: `/api/alerts/${id}`, headers: auth, payload });
    try {
      const [row] = await clients.pg`SELECT * FROM alerts WHERE id = ${id}`;
      await services.alerts.evaluate(row as never);
      // An older client (the console's form) sends only the rule.
      const renamed = await put({ ...rule, name: 'Test alert edits, renamed', threshold: 2 });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json()).toMatchObject({
        name: 'Test alert edits, renamed',
        severity: 'sev1',
        labels: { team: 'core' },
        runbookUrl: 'https://runbooks.example/x',
      });
      expect(renamed.json().states.map((s: { state: string }) => s.state)).toEqual(['firing']);

      const cleared = await put({ ...rule, severity: 'sev4', labels: {}, runbookUrl: null });
      expect(cleared.json()).toMatchObject({ severity: 'sev4', labels: {}, runbookUrl: null });

      const newSearch = await put({ ...rule, query: 'service:"clickland-test-nothing-else"' });
      expect(newSearch.json().states).toEqual([]);
    } finally {
      await clients.pg`DELETE FROM alerts WHERE id = ${id}`;
    }
  });

  it("keeps a note's links and returns them in knowledge search", async () => {
    const word = `zqlinks${Date.now()}`;
    const links = [{ label: 'Landfall room', url: 'http://localhost:5173/o/local/incidents/inc_test' }];
    const res = await app.inject({
      method: 'POST',
      url: '/api/notes',
      headers: auth,
      payload: { title: `Postmortem ${word}`, body: 'Checkout timed out.', service: 'checkout', links },
    });
    expect(res.statusCode).toBe(201);
    const note = res.json();
    try {
      expect(note.links).toEqual(links);
      const found = await app.inject({
        method: 'POST',
        url: '/api/knowledge/search',
        headers: auth,
        payload: { query: word },
      });
      const result = found.json().results.find((r: { metadata: { id?: string } }) => r.metadata.id === note.id);
      expect(result.metadata).toMatchObject({ kind: 'note', links });
      expect(result.pageContent).toContain('Links: Landfall room <http://localhost:5173/o/local/incidents/inc_test>');
      const listed = await app.inject({ url: `/api/notes?q=${word}`, headers: auth });
      expect(listed.json().notes[0].links).toEqual(links);
    } finally {
      await clients.pg`DELETE FROM notes WHERE id = ${note.id}`;
    }
  });

  it('serves MCP: tools/list includes the view tools', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/mcp',
      headers: {
        ...auth,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-06-18',
      },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    const names = res.json().result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['search_logs', 'render_view', 'update_view', 'list_dashboards', 'search_knowledge']),
    );
    const render = res.json().result.tools.find((t: { name: string }) => t.name === 'render_view');
    expect(render._meta.ui.resourceUri).toBe('ui://clickland/view');
  });
});
