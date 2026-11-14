/**
 * AI agents and their value, end to end against the local stack: scripts/demo-agents.mjs sends one batch of GenAI
 * telemetry through the collector under this run's own service names, and the routes and MCP tools read it back.
 *
 *   pnpm dev:up && pnpm db:migrate
 *   CLICKLAND_INTEGRATION=db pnpm --filter @clickland/api test:integration
 */
import { createClient } from '@clickhouse/client';
import type { AgentSummary, ModelPrice } from '@clickland/contracts';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
const PREFIX = `demo-it-${Date.now()}-`;
const SERVICE = `${PREFIX}*`;
const SCRIPT = fileURLToPath(new URL('../../../scripts/demo-agents.mjs', import.meta.url));
/** What one batch of the script holds (it is always the same shape). */
const SENT = { logs: 48, metricPoints: 14 };

describe.skipIf(!enabled)('AI agents and their value (live stack)', () => {
  const clients = createClients(config);
  const services = createServices(config, clients);
  const admin = createClient({
    url: config.clickhouseUrl,
    username: 'clickland_admin',
    password: process.env.CLICKLAND_CH_ADMIN_PASSWORD ?? 'clickland-dev-admin',
    database: config.database,
  });
  let app: Awaited<ReturnType<typeof buildApp>>;
  let sent: { services: Record<string, string>; traces: Record<string, string>; spans: number };
  let hourlyRate = 60;
  const cleanup: (() => Promise<unknown>)[] = [];

  const get = (url: string, headers = auth) => app.inject({ url, headers });
  const send = (method: 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, headers = auth) =>
    app.inject({ method, url, headers, payload: payload as never });
  const count = async (table: string, time: string) => {
    const rs = await admin.query({
      query: `SELECT count() AS c FROM ${table} WHERE ServiceName LIKE {p:String} AND ${time} > now() - INTERVAL 1 HOUR`,
      query_params: { p: `${PREFIX}%` },
      format: 'JSONEachRow',
    });
    return Number((await rs.json<{ c: string }>())[0]!.c);
  };

  beforeAll(async () => {
    app = await buildApp(services, { viewHtmlPath: '/nonexistent' });
    sent = JSON.parse(execFileSync('node', [SCRIPT, '--json', '--prefix', PREFIX], { encoding: 'utf8' }));
    // The collector batches: wait until the whole batch is in ClickHouse.
    const deadline = Date.now() + 45_000;
    for (;;) {
      const [spans, logs, points] = await Promise.all([
        count('otel_traces', 'Timestamp'),
        count('otel_logs', 'Timestamp'),
        count('otel_metrics_sum', 'TimeUnix'),
      ]);
      if (spans >= sent.spans && logs >= SENT.logs && points >= SENT.metricPoints) break;
      if (Date.now() > deadline)
        throw new Error(`The batch did not arrive: ${spans}/${sent.spans} spans, ${logs} logs, ${points} points`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect((await send('POST', '/api/value/seed')).statusCode).toBe(200);
    hourlyRate = (await get('/api/value/settings')).json().hourlyRate;
  }, 60_000);

  afterAll(async () => {
    for (const undo of cleanup) await undo().catch(() => {});
    for (const table of ['otel_traces', 'otel_logs', 'otel_metrics_sum'])
      await admin
        .command({ query: `DELETE FROM ${table} WHERE ServiceName LIKE {p:String}`, query_params: { p: `${PREFIX}%` } })
        .catch(() => {});
    await admin.close();
    await app.close();
    await clients.close();
  });

  const agentsOf = async () => {
    const res = await get(`/api/agents?service=${SERVICE}`);
    expect(res.statusCode).toBe(200);
    return res.json().agents as AgentSummary[];
  };
  const named = (agents: AgentSummary[], name: string) => agents.find((a) => a.name === name)!;

  it('finds every agent in telemetry: Landflow, A2A, Landfall and Claude Code', async () => {
    const agents = await agentsOf();
    expect(agents.map((a) => `${a.family}:${a.name}`).sort()).toEqual([
      'a2a:k8s-agent',
      'claude_code:Claude Code',
      'landfall:Landfall investigator',
      'landflow:Digest writer',
      'landflow:Log analyst',
      'landflow:Release notes writer',
      'landflow:Support triage',
      'landflow:Triage the alert',
    ]);
    expect(named(agents, 'Support triage').service).toBe(sent.services.landflow);
    expect(named(agents, 'Support triage').id).toMatch(/^ag_/);
    const onlyRemote = await get(`/api/agents?service=${SERVICE}&family=a2a`);
    expect(onlyRemote.json().agents.map((a: { name: string }) => a.name)).toEqual(['k8s-agent']);
  });

  it('computes operations per agent: runs, success, tokens, cost, errors, rate limits, retries, loops', async () => {
    const agents = await agentsOf();
    const triage = named(agents, 'Support triage');
    expect(triage).toMatchObject({
      runs: 5,
      failedRuns: 0,
      successRate: 1,
      modelCalls: 12,
      inputTokens: 9500,
      outputTokens: 2320,
      stepErrors: 1,
      rateLimits: 1,
      retries: 1,
      loops: 0,
      users: 2,
      sessions: 5,
      teams: ['platform'],
      feedback: { up: 1, down: 1 },
    });
    // Tokens × the seeded list price of claude-sonnet-5-5 ($2 in, $10 out per million).
    expect(triage.costUsd).toBeCloseTo(0.0422, 6);
    expect(triage.costHow).toContain('9,500 input × $2/MTok + 2,320 output × $10/MTok');
    // The node run inside each tool call is not a second tool call; the sub-agent is the parent's tool.
    expect(triage.tools.map((t: { name: string; calls: number }) => [t.name, t.calls]).sort()).toEqual([
      ['Log analyst', 3],
      ['search_logs', 3],
    ]);
    expect(triage.evaluations).toEqual([{ name: 'relevance', count: 1, averageScore: 0.9, labels: { pass: 1 } }]);

    expect(named(agents, 'Log analyst')).toMatchObject({ runs: 3, subAgentRuns: 3, inputTokens: 6000 });
    // A workflow's AI Agent node, as Landflow sends it: the node run is the agent, the SDK's span inside each model
    // call is the same call (tokens counted once), and its tools are the node runs marked ai_tool.
    const node = named(agents, 'Triage the alert');
    expect(node).toMatchObject({
      runs: 1,
      sources: ['workflow'],
      modelCalls: 2,
      inputTokens: 6500,
      outputTokens: 1100,
      toolCalls: 2,
    });
    expect(node.tools.map((t: { name: string }) => t.name).sort()).toEqual(['Add a note', 'Search traces']);
    expect(named(agents, 'Release notes writer')).toMatchObject({
      runs: 1,
      successRate: 0,
      loops: 1,
      endReasons: { max_steps: 1 },
    });
    expect(named(agents, 'k8s-agent')).toMatchObject({ family: 'a2a', inputTokens: 5000, outputTokens: 700 });
    expect(named(agents, 'Landfall investigator')).toMatchObject({
      runs: 2,
      failedRuns: 1,
      successRate: 0.5,
      costUsd: 0,
    });
  });

  it('reads Claude Code from its metrics and events', async () => {
    const claude = named(await agentsOf(), 'Claude Code');
    expect(claude).toMatchObject({
      service: sent.services.claudeCode,
      runUnit: 'prompt',
      runs: 6,
      modelCalls: 14,
      toolCalls: 13,
      stepErrors: 2,
      rateLimits: 1,
      retries: 1,
      users: 1,
      sessions: 1,
      teams: ['platform'],
      approvals: { approved: 7, denied: 1 },
    });
    expect(claude.costUsd).toBeCloseTo(0.67, 6);
    expect(claude.activity).toMatchObject({
      commits: 3,
      pullRequests: 1,
      linesAdded: 420,
      linesRemoved: 77,
      activeSeconds: 1800,
    });
    expect(claude.permissions.modes.sort()).toEqual(['acceptEdits', 'default']);
    expect(claude.permissions.tools.find((t: { name: string }) => t.name === 'Write')).toMatchObject({
      allowed: 0,
      denied: 1,
    });
  });

  it('shows one agent with its recent runs and its value', async () => {
    const triage = named(await agentsOf(), 'Support triage');
    const res = await get(`/api/agents/${triage.id}?service=${SERVICE}`);
    expect(res.statusCode).toBe(200);
    const detail = res.json();
    expect(detail.agent.key).toBe(triage.key);
    expect(detail.recentRuns).toHaveLength(5);
    expect(detail.recentRuns.find((r: { traceId: string }) => r.traceId === sent.traces.rateLimit)).toMatchObject({
      status: 'ok',
      rateLimits: 1,
      retries: 1,
      inputTokens: 1000,
    });
    expect(detail.value).toMatchObject({ outcomes: 5, value: (5 * 5 * hourlyRate) / 60 });
    expect((await get('/api/agents/ag_bm9wZS9ub3Bl')).statusCode).toBe(404);
    expect((await get('/api/agents/not-an-id')).statusCode).toBe(400);
  });

  it('draws a run’s decision path, with its loop', async () => {
    const res = await get(`/api/agents/runs/${sent.traces.loop}/graph`);
    expect(res.statusCode).toBe(200);
    const graph = res.json();
    expect(graph.summary).toMatchObject({
      agents: ['Release notes writer'],
      modelCalls: 6,
      toolCalls: 6,
      inputTokens: 18000,
      errors: 1,
    });
    expect(graph.loops).toMatchObject([{ agent: 'Release notes writer', tool: 'fetch_page', count: 6 }]);
    expect(graph.nodes[0]).toMatchObject({
      kind: 'agent',
      label: 'Release notes writer',
      status: 'error',
      parentId: null,
    });
    expect(graph.nodes.filter((n: { loop: boolean }) => n.loop)).toHaveLength(6);
    expect(graph.edges).toHaveLength(graph.nodes.length - 1);

    const nested = (await get(`/api/agents/runs/${sent.traces.triage}/graph`)).json();
    expect(nested.nodes.map((n: { kind: string }) => n.kind)).toEqual([
      'agent',
      'model',
      'tool',
      'model',
      'tool',
      'subagent',
      'model',
      'tool',
      'model',
    ]);
    expect(nested.nodes.find((n: { label: string }) => n.label === 'search_logs').hiddenSpans).toBe(2);
    // Captured prompts never ride in a graph.
    expect((await get(`/api/agents/runs/${sent.traces.content}/graph`)).body).not.toContain('4242');
    expect((await get(`/api/agents/runs/${'0'.repeat(32)}/graph`)).statusCode).toBe(404);
    expect((await get('/api/agents/runs/xyz/graph')).statusCode).toBe(400);
  });

  it('reports value, cost, net and ROI, and how each was computed', async () => {
    const res = await get(`/api/agents/value?service=${SERVICE}`);
    expect(res.statusCode).toBe(200);
    const report = res.json();
    const credited = Object.fromEntries(
      report.outcomes.map((o: { name: string; credited: number }) => [o.name, o.credited]),
    );
    expect(credited).toMatchObject({
      'Landflow agent run completed': 5,
      'Landflow workflow run with an agent succeeded': 2,
      'Alert triaged': 1,
      'Landfall investigation completed': 1,
      'Landfall incident resolved with the investigator': 1,
      'Claude Code commit': 3,
      'Claude Code pull request': 1,
    });
    // Sync contacts succeeded with no agent in it: shown, not counted.
    expect(report.unattributed.outcomes).toBe(1);

    const minutes = 5 * 5 + 2 * 10 + 15 + 20 + 30 + 3 * 15 + 30;
    const seededOnly = report.outcomes.every((o: { name: string }) => o.name in credited);
    if (seededOnly) expect(report.totals.value).toBeCloseTo((minutes * hourlyRate) / 60, 2);
    expect(report.totals.cost).toBeCloseTo(0.8519, 3);
    expect(report.totals.net).toBeCloseTo(report.totals.value - report.totals.cost, 1);
    expect(report.totals.roi).toBeCloseTo((report.totals.value - report.totals.cost) / report.totals.cost, 1);
    expect(report.totals.how.roi).toMatch(/^\(\$[\d,.]+ − \$0\.85\) ÷ \$0\.85 = \d+%$/);
    expect(report.model).toContain('ROI = (value − cost) ÷ cost');

    const claude = report.agents.find((a: { name: string }) => a.name === 'Claude Code');
    expect(claude).toMatchObject({ outcomes: 4, adoption: { users: 1, sessions: 1, runs: 6, runUnit: 'prompt' } });
    expect(claude.lines.map((l: { name: string; count: number }) => [l.name, l.count]).sort()).toEqual([
      ['Claude Code commit', 3],
      ['Claude Code pull request', 1],
    ]);
    const investigator = report.agents.find((a: { name: string }) => a.name === 'Landfall investigator');
    expect(investigator).toMatchObject({ outcomes: 2, cost: 0, roi: null });
    // A sub-agent costs money and earns nothing of its own: it is still listed.
    expect(report.agents.find((a: { name: string }) => a.name === 'Log analyst')).toMatchObject({
      outcomes: 0,
      value: 0,
    });
    const triage = report.agents.find((a: { name: string }) => a.name === 'Support triage');
    expect(triage.quality).toMatchObject({ successRate: 1, feedback: { up: 1, down: 1 } });
  });

  it('breaks value down by team and filters by team and agent', async () => {
    const report = (await get(`/api/agents/value?service=${SERVICE}`)).json();
    const teams = Object.fromEntries(report.teams.map((t: { team: string }) => [t.team, t]));
    expect(Object.keys(teams).sort()).toEqual(['docs', 'platform', 'unassigned']);
    // docs: the digest workflow (10 min); its cost is the digest and the failed release-notes run.
    expect(teams.docs.outcomes).toBe(1);
    expect(teams.docs.cost).toBeCloseTo(0.0975, 4);
    expect(teams.unassigned.outcomes).toBe(2);

    const docs = (await get(`/api/agents/value?service=${SERVICE}&team=docs`)).json();
    expect(docs.totals.outcomes).toBe(1);
    expect(docs.teams.map((t: { team: string }) => t.team)).toEqual(['docs']);

    const triage = named(await agentsOf(), 'Support triage');
    const one = (await get(`/api/agents/value?service=${SERVICE}&agent=${triage.id}`)).json();
    expect(one.agents.map((a: { name: string }) => a.name)).toEqual(['Support triage']);
    expect(one.totals.outcomes).toBe(5);
    expect((await get(`/api/agents/value?service=${SERVICE}&agent=ag_bm9wZS9ub3Bl`)).statusCode).toBe(404);
  });

  it('keeps outcome definitions: preview, create, count, change, delete', async () => {
    const outcome = {
      name: `IT digest written ${PREFIX}`,
      signal: 'traces',
      query: 'name:"invoke_agent Digest writer" NOT status:error',
      attribution: { mode: 'field', field: 'gen_ai.agent.name' },
      valueKind: 'amount',
      amount: 100,
    };
    const preview = await send('POST', '/api/value/outcomes/preview', { outcome, service: SERVICE });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ matched: 1, credited: 1, unattributed: 0, unitValue: 100, value: 100 });
    expect(preview.json().agents[0].key).toBe(`${sent.services.landflow}/Digest writer`);

    const created = await send('POST', '/api/value/outcomes', outcome);
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    cleanup.push(() => clients.pg`DELETE FROM outcome_definitions WHERE id = ${id}`);
    expect(created.json()).toMatchObject({ seeded: false, enabled: true, minutesSaved: 0 });

    const report = (await get(`/api/agents/value?service=${SERVICE}`)).json();
    const digest = report.agents.find((a: { name: string }) => a.name === 'Digest writer');
    expect(digest.lines.find((l: { outcomeId: string }) => l.outcomeId === id)).toMatchObject({
      count: 1,
      value: 100,
      how: '1 × $100.00 = $100.00',
    });

    const changed = await send('PUT', `/api/value/outcomes/${id}`, { ...outcome, amount: 250, enabled: false });
    expect(changed.json()).toMatchObject({ amount: 250, enabled: false });
    const after = (await get(`/api/agents/value?service=${SERVICE}`)).json();
    expect(after.outcomes.some((o: { id: string }) => o.id === id)).toBe(false);

    expect((await send('POST', '/api/value/outcomes', { ...outcome, query: '"open' })).statusCode).toBe(400);
    expect(
      (
        await send('POST', '/api/value/outcomes', {
          ...outcome,
          signal: 'metric',
          query: 'some.metric',
          attribution: { mode: 'trace' },
        })
      ).statusCode,
    ).toBe(400);
    expect((await send('DELETE', `/api/value/outcomes/${id}`)).statusCode).toBe(204);
    expect((await get(`/api/value/outcomes/${id}`)).statusCode).toBe(404);
  });

  it('seeds once: a second seed adds nothing, and the Claude prices are dated', async () => {
    const again = (await send('POST', '/api/value/seed')).json();
    expect(again.prices.added).toBe(0);
    expect(again.outcomes.added).toBe(0);
    const prices = (await get('/api/value/prices')).json().prices as ModelPrice[];
    const opus = prices.find((p) => p.model === 'claude-opus-5-5*')!;
    expect(opus).toMatchObject({ provider: 'anthropic', editable: true });
    expect(opus.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const outcomes = (await get('/api/value/outcomes')).json().outcomes as { name: string }[];
    expect(outcomes.map((o) => o.name)).toEqual(expect.arrayContaining(['Alert triaged', 'Claude Code commit']));
  });

  it('keeps the price table editable', async () => {
    const model = `it-model-${Date.now()}*`;
    const price = { model, inputPerMTok: 1, outputPerMTok: 2 };
    const created = await send('POST', '/api/value/prices', price);
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    cleanup.push(() => clients.pg`DELETE FROM model_prices WHERE id = ${id}`);
    expect(created.json()).toMatchObject({ seeded: false, cacheReadPerMTok: 0 });
    expect((await send('POST', '/api/value/prices', price)).statusCode).toBe(409);
    const changed = await send('PUT', `/api/value/prices/${id}`, { ...price, outputPerMTok: 3, note: 'negotiated' });
    expect(changed.json()).toMatchObject({ outputPerMTok: 3, note: 'negotiated' });
    expect((await send('PUT', `/api/value/prices/${id}`, { ...price, model: 'claude-opus-5-5*' })).statusCode).toBe(
      409,
    );
    expect((await send('POST', '/api/value/prices', { ...price, model: 'bad model' })).statusCode).toBe(400);
    expect((await send('DELETE', `/api/value/prices/${id}`)).statusCode).toBe(204);
    expect((await send('DELETE', `/api/value/prices/${id}`)).statusCode).toBe(404);
  });

  it('lets a read key read and only an admin change what the figures are made of', async () => {
    const key = (await send('POST', '/api/keys', { name: 'it-agents-read', scopes: ['read'] })).json();
    cleanup.push(() => clients.pg`DELETE FROM api_keys WHERE id = ${key.id}`);
    const read = { authorization: `Bearer ${key.key}` };
    expect((await get(`/api/agents?service=${SERVICE}`, read)).statusCode).toBe(200);
    expect((await get(`/api/agents/value?service=${SERVICE}`, read)).statusCode).toBe(200);
    const settings = await get('/api/value/settings', read);
    expect(settings.json()).toMatchObject({
      currency: expect.stringMatching(/^[A-Z]{3}$/),
      teamAttribute: expect.any(String),
    });
    expect((await send('PUT', '/api/value/settings', { hourlyRate: 1 }, read)).statusCode).toBe(403);
    expect((await send('POST', '/api/value/seed', undefined, read)).statusCode).toBe(403);
    expect((await send('POST', '/api/value/outcomes', {}, read)).statusCode).toBe(403);
    expect(
      (await send('POST', '/api/agents/alert-templates/agent-run-errors/install', undefined, read)).statusCode,
    ).toBe(403);
    expect((await get('/api/agents')).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/agents' })).statusCode).toBe(401);
    // Saving the settings as they are changes nothing but who saved them.
    const same = settings.json();
    const saved = await send('PUT', '/api/value/settings', { hourlyRate: same.hourlyRate, currency: same.currency });
    expect(saved.json()).toMatchObject({ hourlyRate: same.hourlyRate, loopThreshold: same.loopThreshold });
    expect((await send('PUT', '/api/value/settings', { hourlyRate: -1 })).statusCode).toBe(400);
  });

  it('flags personal data and prompt injection in captured content, masked', async () => {
    const res = await get(`/api/agents/safety?service=${SERVICE}`);
    expect(res.statusCode).toBe(200);
    const safety = res.json();
    expect(safety.contentCaptured).toBe(true);
    expect(safety.totals).toMatchObject({ pii: 2, secret: 0, prompt_injection: 2 });
    expect(safety.flags.map((f: { detector: string }) => f.detector).sort()).toEqual([
      'credit_card',
      'email',
      'ignore_instructions',
      'reveal_system_prompt',
    ]);
    expect(safety.flags[0]).toMatchObject({
      traceId: sent.traces.content,
      agent: '',
      attribute: 'gen_ai.input.messages',
    });
    expect(res.body).not.toContain('dana.levi');
    expect(res.body).not.toContain('4242 4242');
    // Claude Code's prompts are redacted at the source, so there is nothing of its to scan.
    const none = (await get(`/api/agents/safety?service=${sent.services.claudeCode}`)).json();
    expect(none).toMatchObject({ contentCaptured: false, scanned: 0, flags: [] });
  });

  it('offers cost, error and quality alerts and installs one as a normal alert', async () => {
    const templates = (await get('/api/agents/alert-templates')).json().templates as { key: string; kind: string }[];
    expect(new Set(templates.map((t) => t.kind))).toEqual(new Set(['cost', 'errors', 'quality']));
    const installed = await send('POST', '/api/agents/alert-templates/agent-run-errors/install');
    expect(installed.statusCode).toBe(201);
    const alert = installed.json();
    cleanup.push(() => clients.pg`DELETE FROM alerts WHERE id = ${alert.id}`);
    expect(alert).toMatchObject({ signal: 'traces', groupBy: 'gen_ai.agent.name', thresholdType: 'above' });
    // The existing machinery evaluates it: the failed release-notes run is counted for its agent.
    const tested = (await send('POST', `/api/alerts/${alert.id}/test`)).json();
    expect(JSON.stringify(tested)).toContain('Release notes writer');
    expect((await send('POST', '/api/agents/alert-templates/nope/install')).statusCode).toBe(404);
  });

  it('shows the agent panels in a view', async () => {
    const res = await send('POST', '/api/views', {
      spec: {
        title: 'AI this week',
        range: { lastMinutes: 10080 },
        panels: [
          { type: 'agent_value', title: 'What the agents are worth', width: 'full' },
          { type: 'agents', title: 'Agents', service: SERVICE },
          { type: 'run_graph', title: 'The looping run', traceId: sent.traces.loop },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    cleanup.push(() => clients.pg`DELETE FROM views WHERE id = ${res.json().id}`);
    expect(res.json().spec.panels.map((p: { type: string }) => p.type)).toEqual(['agent_value', 'agents', 'run_graph']);
  });

  it('answers "what is our AI worth this week?" over MCP', async () => {
    const rpc = (id: number, method: string, params?: unknown) =>
      app.inject({
        method: 'POST',
        url: '/api/mcp',
        headers: {
          ...auth,
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'mcp-protocol-version': '2025-06-18',
        },
        payload: { jsonrpc: '2.0', id, method, params },
      });
    const names = (await rpc(1, 'tools/list')).json().result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(['list_agents', 'get_agent', 'agent_value', 'run_graph']));

    const value = (
      await rpc(2, 'tools/call', { name: 'agent_value', arguments: { lastDays: 7, service: SERVICE } })
    ).json().result;
    expect(value.isError).toBeFalsy();
    expect(value.content[0].text).toMatch(/Total: value \$[\d,.]+, cost \$0\.85, net \$[\d,.]+, ROI \d+%/);
    expect(value.content[0].text).toContain('Claude Code commit: 3 credited');
    expect(value.structuredContent.totals.outcomes).toBeGreaterThanOrEqual(14);

    const list = (await rpc(3, 'tools/call', { name: 'list_agents', arguments: { service: SERVICE } })).json().result;
    expect(list.structuredContent.agents).toHaveLength(8);
    const agent = (
      await rpc(4, 'tools/call', { name: 'get_agent', arguments: { agent: 'Support triage', service: SERVICE } })
    ).json().result;
    expect(agent.structuredContent.agent.runs).toBe(5);
    const graph = (await rpc(5, 'tools/call', { name: 'run_graph', arguments: { traceId: sent.traces.a2a } })).json()
      .result;
    expect(graph.structuredContent.summary.agents).toEqual(['k8s-agent']);
    const missing = (
      await rpc(6, 'tools/call', { name: 'get_agent', arguments: { agent: 'nobody', service: SERVICE } })
    ).json().result;
    expect(missing.isError).toBe(true);
  });
});
