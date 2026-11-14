/**
 * The API against the local stack (`pnpm dev:up && pnpm db:migrate`): CLICKLAND_INTEGRATION=db pnpm --filter @clickland/api test:integration
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createClients } from '../src/clients.js';
import { configFromEnv } from '../src/config.js';
import { createServices } from '../src/services.js';

const enabled = (process.env.CLICKLAND_INTEGRATION ?? '').split(',').includes('db');
const config = {
  ...configFromEnv({ CLICKLAND_AUTH: 'keys', CLICKLAND_BOOTSTRAP_KEY: 'ck_test_bootstrap_key_00000000000000' }),
  backgroundJobs: false,
};
const auth = { authorization: `Bearer ${config.bootstrapKey}` };

describe.skipIf(!enabled)('API (live stack)', () => {
  const clients = createClients(config);
  const services = createServices(config, clients);
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
