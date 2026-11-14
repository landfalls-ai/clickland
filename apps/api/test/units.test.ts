import { AlertInput } from '@clickland/contracts';
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { breaches, groupSearch, groupValues } from '../src/alerts.js';
import { askAssistant, pickText } from '../src/assistant.js';
import { configFromEnv } from '../src/config.js';
import { questionWords } from '../src/knowledge.js';
import { topSeries } from '../src/telemetry.js';
import { RETRY_DELAYS_S, signWebhook } from '../src/webhooks.js';

describe('alerts', () => {
  it('compares with the threshold strictly', () => {
    expect(breaches('above', 11, 10)).toBe(true);
    expect(breaches('above', 10, 10)).toBe(false);
    expect(breaches('below', 0, 1)).toBe(true);
  });

  it('adds the group to the search, escaping quotes', () => {
    expect(groupSearch('level:error', null, '')).toBe('level:error');
    expect(groupSearch('level:error', 'service', 'api')).toBe('(level:error) AND service:"api"');
    expect(groupSearch('', 'service', 'a"b\\c')).toBe('service:"a\\"b\\\\c"');
  });

  it('keeps vanished firing groups at 0 and an empty ungrouped series at 0', () => {
    expect([...groupValues([], null, [])]).toEqual([['', 0]]);
    expect([...groupValues([{ key: 'api', count: 3 }], 'service', ['web'])]).toEqual([
      ['api', 3],
      ['web', 0],
    ]);
  });
});

describe('alert severity, labels and runbook', () => {
  const base = { name: 'a', signal: 'logs', thresholdType: 'above', threshold: 1, windowMinutes: 5 };

  it("defaults to sev3 (Landfall's remote default), no labels and no runbook", () => {
    expect(AlertInput.parse(base)).toMatchObject({ severity: 'sev3', labels: {} });
    expect(AlertInput.parse(base).runbookUrl).toBeUndefined();
  });

  it("takes Landfall's scale only, label names that are fields, and an http(s) runbook", () => {
    const ok = {
      ...base,
      severity: 'sev1',
      labels: { team: 'core', 'k8s.ns': 'landfall' },
      runbookUrl: 'https://r.example/x',
    };
    expect(AlertInput.parse(ok)).toMatchObject(ok);
    expect(AlertInput.safeParse({ ...base, severity: 'critical' }).success).toBe(false);
    expect(AlertInput.safeParse({ ...base, labels: { 'bad key': 'x' } }).success).toBe(false);
    expect(AlertInput.safeParse({ ...base, runbookUrl: 'javascript:alert(1)' }).success).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`k${i}`, 'v']));
    expect(AlertInput.safeParse({ ...base, labels: many }).success).toBe(false);
  });
});

describe('webhooks', () => {
  it('signs like Standard Webhooks', () => {
    const key = Buffer.from('secret-key-bytes');
    const secret = `whsec_${key.toString('base64')}`;
    const expected = createHmac('sha256', key).update('evt_1.1700000000.{"a":1}').digest('base64');
    expect(signWebhook(secret, 'evt_1', 1700000000, '{"a":1}')).toBe(`v1,${expected}`);
  });

  it('retries five times over about 42 minutes', () => {
    expect(RETRY_DELAYS_S).toEqual([5, 30, 120, 600, 1800]);
  });
});

describe('knowledge', () => {
  it('keeps the content words of a question', () => {
    expect(questionWords('Why is checkout failing with timeouts to payments-db?')).toEqual([
      'checkout',
      'failing',
      'timeouts',
      'payments',
    ]);
  });
});

describe('series', () => {
  it('keeps the biggest series and folds the rest into "other"', () => {
    const points = ['a', 'b', 'c'].flatMap((k, i) => [{ t: '2026-11-14 15:00:00', k, v: 3 - i }]);
    const series = topSeries(points, 2, 'sum');
    expect(series.map((s) => s.key)).toEqual(['a', 'b', 'other']);
    expect(series[0]!.points).toEqual([['2026-11-14T15:00:00Z', 3]]);
  });
});

describe('assistant', () => {
  const config = {
    ...configFromEnv({}),
    assistantUrl: 'http://landflow.test/chat',
    assistantSecret: 's3cret',
    assistantAuthHeader: 'x-landflow-secret',
  };

  it('is unavailable without a Landflow URL', async () => {
    const events = askAssistant({ ...config, assistantUrl: null }, { sessionId: 's', message: 'hi', user: 'dev' });
    await expect(events.next()).rejects.toMatchObject({ code: 'assistant_unavailable' });
  });

  it('turns a JSON answer into text and done, sending the secret header', async () => {
    let headers: Headers | undefined;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      headers = new Headers(init.headers);
      return new Response(JSON.stringify({ output: 'Checkout times out [[clickland:view:vw_abc]]', runId: 'ex_1' }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const out = [];
    for await (const e of askAssistant(config, { sessionId: 's', message: 'why?', user: 'dev' }, fetchImpl))
      out.push(e);
    expect(headers?.get('x-landflow-secret')).toBe('s3cret');
    expect(out).toEqual([
      { type: 'text', delta: 'Checkout times out [[clickland:view:vw_abc]]' },
      { type: 'done', runId: 'ex_1' },
    ]);
  });

  it("maps Landflow's stream: items are text, tools nest, done's output is not repeated", async () => {
    const frames = [
      { type: 'begin', metadata: {} },
      { type: 'item', content: 'Hel' },
      { type: 'tool', tool: { id: 't1', name: 'Logs_analyst', status: 'started', input: { reason: 'errors' } } },
      { type: 'tool', tool: { id: 't1', name: 'Logs_analyst', status: 'finished' } },
      { type: 'item', content: 'lo' },
      { type: 'end', metadata: {} },
      { type: 'done', executionId: 'ex_1', sessionId: 's', status: 'success', output: 'Hello' },
    ];
    const sse = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('');
    let body: { sessionId: string } | undefined;
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    const out = [];
    for await (const e of askAssistant(config, { sessionId: 'chat 1', message: 'hi', user: 'oidc:a@b' }, fetchImpl))
      out.push(e);
    expect(body?.sessionId).toBe('oidc:a_b:chat_1');
    expect(out).toEqual([
      { type: 'text', delta: 'Hel' },
      { type: 'tool', name: 'Logs_analyst', status: 'started' },
      { type: 'tool', name: 'Logs_analyst', status: 'done' },
      { type: 'text', delta: 'lo' },
      { type: 'done', runId: 'ex_1' },
    ]);
  });

  it('reports a failed run', async () => {
    const sse = `data: ${JSON.stringify({ type: 'done', status: 'error', error: { message: 'model refused' } })}\n\n`;
    const fetchImpl = (async () =>
      new Response(sse, { headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;
    const out = [];
    for await (const e of askAssistant(config, { sessionId: 's', message: 'hi', user: 'dev' }, fetchImpl)) out.push(e);
    expect(out).toEqual([
      { type: 'error', message: 'model refused' },
      { type: 'done', runId: undefined },
    ]);
  });

  it('sends Basic Auth for the chat trigger', async () => {
    let auth: string | null = null;
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      auth = new Headers(init.headers).get('authorization');
      return new Response('{"output":"ok"}', { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const basic = { ...config, assistantSecret: null, assistantBasicAuth: 'clickland:pw' };
    for await (const _ of askAssistant(basic, { sessionId: 's', message: 'hi', user: 'dev' }, fetchImpl)) void _;
    expect(auth).toBe(`Basic ${Buffer.from('clickland:pw').toString('base64')}`);
  });

  it('finds the text in common answer shapes', () => {
    expect(pickText([{ output: 'a' }])).toBe('a');
    expect(pickText({ message: { content: 'b' } })).toBe('b');
  });
});
