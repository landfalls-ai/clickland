/**
 * The agent queries against a real ClickHouse (the clickland-infra stack: pnpm dev:up && pnpm db:migrate), when
 * CLICKLAND_INTEGRATION names `db` or `all`. Rows are written straight into the tables under this run's own service
 * name and deleted afterwards.
 */
import { createClient } from '@clickhouse/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  agentContentQuery,
  agentSpansQuery,
  agentTraceQuery,
  attributeAgentRuns,
  buildRunGraph,
  claudeCodeEventsQuery,
  claudeCodePromptsQuery,
  claudeCodeTotalsQuery,
  evaluationLogsQuery,
  metricTotalsQuery,
  outcomeRowsQuery,
  type Query,
  type RawAgentSpan,
  toAgentSpan,
  toOutcomeRows,
} from '../src/index.js';

const enabled = /\b(db|all)\b/.test(process.env.CLICKLAND_INTEGRATION ?? '');
const client = createClient({
  url: process.env.CLICKLAND_CH_URL ?? 'http://127.0.0.1:28123',
  username: 'clickland_admin',
  password: process.env.CLICKLAND_CH_ADMIN_PASSWORD ?? 'clickland-dev-admin',
  database: 'clickland',
  clickhouse_settings: { session_timezone: 'UTC', output_format_json_quote_64bit_integers: 0 },
});
const SERVICE = `agents-test-${Date.now()}`;
const TRACE = [...`${Date.now()}`.padStart(32, 'a')].join('');
const now = new Date();
const range = { from: new Date(now.getTime() - 3600_000), to: new Date(now.getTime() + 60_000) };
const ts = (offsetMs: number) => new Date(now.getTime() - offsetMs).toISOString().replace('T', ' ').replace('Z', '');
const seconds = (offsetMs: number) => ts(offsetMs).slice(0, 19);

async function run<T = Record<string, unknown>>(q: Query): Promise<T[]> {
  return (await client.query({ query: q.sql, query_params: q.params, format: 'JSONEachRow' })).json<T>();
}

describe.skipIf(!enabled)('agent queries (live ClickHouse)', () => {
  beforeAll(async () => {
    const span = (
      id: string,
      parent: string,
      name: string,
      offset: number,
      attributes: Record<string, string>,
      extra = {},
    ) => ({
      Timestamp: ts(offset),
      TraceId: TRACE,
      SpanId: id,
      ParentSpanId: parent,
      SpanName: name,
      SpanKind: 'Internal',
      ServiceName: SERVICE,
      Duration: 50_000_000,
      StatusCode: 'Ok',
      SpanAttributes: attributes,
      ResourceAttributes: { 'service.namespace': 'landflow', 'team.id': 'platform', 'host.name': 'not-kept' },
      ...extra,
    });
    await client.insert({
      table: 'otel_traces',
      format: 'JSONEachRow',
      values: [
        span('a000000000000001', '', 'POST /chat', 9000, { 'http.route': '/chat' }),
        span(
          'a000000000000002',
          'a000000000000001',
          'invoke_agent Scout',
          8000,
          {
            'gen_ai.operation.name': 'invoke_agent',
            'gen_ai.agent.name': 'Scout',
            'landflow.agent.source': 'slack',
            'incident.id': 'inc-9',
          },
          {
            'Events.Timestamp': [ts(7000)],
            'Events.Name': ['gen_ai.evaluation.result'],
            'Events.Attributes': [{ 'gen_ai.evaluation.name': 'relevance', 'gen_ai.evaluation.score.value': '0.75' }],
          },
        ),
        span('a000000000000003', 'a000000000000002', 'gen_ai.chat claude-sonnet-5-5', 7000, {
          'gen_ai.operation.name': 'chat',
          'gen_ai.request.model': 'claude-sonnet-5-5',
          'gen_ai.usage.input_tokens': '1200',
          'gen_ai.usage.output_tokens': '300',
          'gen_ai.input.messages': '[{"role":"user","content":"mail me at pat@corp-mail.io"}]',
        }),
        span('a000000000000004', 'a000000000000002', 'execute_tool search', 6000, {
          'gen_ai.operation.name': 'execute_tool',
          'gen_ai.tool.name': 'search',
          'gen_ai.tool.call.arguments': '{"q":"errors"}',
        }),
        span('a000000000000005', 'a000000000000004', 'db.query', 5500, { 'db.system': 'postgresql' }),
      ],
    });
    const point = (
      metric: string,
      value: number,
      offset: number,
      temporality: number,
      start: number,
      attributes = {},
    ) => ({
      ServiceName: SERVICE,
      MetricName: metric,
      Attributes: attributes,
      ResourceAttributes: { 'team.id': 'platform' },
      StartTimeUnix: seconds(start),
      TimeUnix: seconds(offset),
      Value: value,
      AggregationTemporality: temporality,
      IsMonotonic: true,
    });
    await client.insert({
      table: 'otel_metrics_sum',
      format: 'JSONEachRow',
      values: [
        // Delta: the points add up.
        point('it.delta', 5, 3000, 1, 4000, { model: 'a' }),
        point('it.delta', 7, 2000, 1, 3000, { model: 'a' }),
        point('it.delta', 2, 2000, 1, 3000, { model: 'b' }),
        // Cumulative, started before the range: its growth inside the range.
        point('it.cumulative.old', 10, 3000, 2, 7200_000),
        point('it.cumulative.old', 25, 2000, 2, 7200_000),
        point('it.cumulative.old', 40, 1000, 2, 7200_000),
        // Cumulative, started inside the range: its last value.
        point('it.cumulative.new', 3, 3000, 2, 5000),
        point('it.cumulative.new', 9, 1000, 2, 5000),
        point('claude_code.commit.count', 4, 1000, 1, 2000),
      ],
    });
    const log = (body: string, attributes: Record<string, string>, extra = {}) => ({
      Timestamp: ts(2000),
      ServiceName: SERVICE,
      SeverityText: 'INFO',
      SeverityNumber: 9,
      Body: body,
      LogAttributes: attributes,
      ResourceAttributes: {},
      ...extra,
    });
    await client.insert({
      table: 'otel_logs',
      format: 'JSONEachRow',
      values: [
        log('claude_code.user_prompt', {
          'event.name': 'user_prompt',
          'session.id': 's1',
          'user.id': 'u1',
          prompt: 'call +972 54 123 4567',
        }),
        log('claude_code.user_prompt', {
          'event.name': 'user_prompt',
          'session.id': 's1',
          'user.id': 'u1',
          prompt: '<REDACTED>',
        }),
        log('claude_code.api_request', {
          'event.name': 'api_request',
          model: 'claude-opus-5-5',
          duration_ms: '1000',
          'session.id': 's1',
          'user.id': 'u1',
        }),
        log('claude_code.api_request', {
          'event.name': 'api_request',
          model: 'claude-opus-5-5',
          duration_ms: '3000',
          'session.id': 's2',
          'user.id': 'u1',
        }),
        log('claude_code.api_error', { 'event.name': 'api_error', status_code: '429', attempt: '3' }),
        // The same event with the newer EventName column set and a different body.
        log('tool finished', { tool_name: 'Bash', success: 'false' }, { EventName: 'claude_code.tool_result' }),
        log(
          'evaluation',
          { 'gen_ai.evaluation.name': 'faithfulness', 'gen_ai.evaluation.score.value': '0.4' },
          { EventName: 'gen_ai.evaluation.result', TraceId: TRACE, SpanId: 'a000000000000002' },
        ),
      ],
    });
  });

  afterAll(async () => {
    for (const table of ['otel_traces', 'otel_logs', 'otel_metrics_sum'])
      await client
        .command({ query: `DELETE FROM ${table} WHERE ServiceName = {s:String}`, query_params: { s: SERVICE } })
        .catch(() => {});
    await client.close();
  });

  it('fetches the whole agent trace, slim: no content, no stray attributes', async () => {
    const rows = await run<RawAgentSpan>(
      agentSpansQuery(range, { service: SERVICE, extraKeys: ['team.id', 'incident.id'] }),
    );
    expect(rows).toHaveLength(5);
    const byName = Object.fromEntries(rows.map((r) => [r.SpanName, r]));
    expect(byName['POST /chat']!.attrs).toEqual({});
    expect(byName['gen_ai.chat claude-sonnet-5-5']!.attrs).toEqual({
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': 'claude-sonnet-5-5',
      'gen_ai.usage.input_tokens': '1200',
      'gen_ai.usage.output_tokens': '300',
    });
    expect(byName['invoke_agent Scout']!.res).toEqual({ 'service.namespace': 'landflow', 'team.id': 'platform' });
    expect(byName['invoke_agent Scout']!.eventNames).toEqual(['gen_ai.evaluation.result']);
    expect(byName['execute_tool search']!.attrs).not.toHaveProperty('gen_ai.tool.call.arguments');
    expect(byName['execute_tool search']!.argsHash).toMatch(/^\d+$/);
    expect(JSON.stringify(rows)).not.toContain('corp-mail');

    const { runs } = attributeAgentRuns(rows.map(toAgentSpan), {
      teamAttribute: 'team.id',
      correlateFields: ['incident.id'],
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      name: 'Scout',
      family: 'landflow',
      team: 'platform',
      correlate: { 'incident.id': 'inc-9' },
    });
    expect(runs[0]!.models[0]).toMatchObject({ model: 'claude-sonnet-5-5', inputTokens: 1200, outputTokens: 300 });
    expect(runs[0]!.evaluations).toEqual([{ name: 'relevance', score: 0.75, label: '' }]);
  });

  it('uses the attribute-key index to find agent traces', async () => {
    const q = agentSpansQuery(range, { service: SERVICE });
    const explain = async (sql: string) =>
      (
        await client.query({ query: `EXPLAIN indexes = 1 ${sql}`, query_params: q.params, format: 'TabSeparatedRaw' })
      ).text();
    // The inner query finds the traces by the map-key index; the outer one reads them by the trace id index.
    const inner = /TraceId IN \(\n([\s\S]+?)\n {2}\)\nORDER BY/.exec(q.sql)![1]!;
    expect(await explain(inner)).toMatch(/idx_span_attr_key/);
    expect(await explain(q.sql)).toMatch(/idx_trace_id/);
  });

  it('reads one trace for the run graph', async () => {
    const rows = await run<RawAgentSpan>(agentTraceQuery(TRACE));
    const graph = buildRunGraph(rows.map(toAgentSpan));
    expect(graph.nodes.map((n) => [n.kind, n.label])).toEqual([
      ['span', 'POST /chat'],
      ['agent', 'Scout'],
      ['model', 'claude-sonnet-5-5'],
      ['tool', 'search'],
    ]);
    expect(graph.nodes[3]!.hiddenSpans).toBe(1);
    expect(await run(agentTraceQuery('0'.repeat(32)))).toEqual([]);
  });

  it('totals a delta metric by adding and a cumulative one by its growth', async () => {
    const rows = await run<{ metric: string; g: string[]; v: number }>(
      metricTotalsQuery({ range, metrics: ['it.delta', 'it.cumulative.old', 'it.cumulative.new'], service: SERVICE }),
    );
    expect(Object.fromEntries(rows.map((r) => [r.metric, Number(r.v)]))).toEqual({
      'it.delta': 14,
      'it.cumulative.old': 30,
      'it.cumulative.new': 9,
    });
  });

  it('groups and filters a metric by data point or resource attributes', async () => {
    const grouped = await run<{ g: string[]; v: number }>(
      metricTotalsQuery({ range, metrics: ['it.delta'], groupKeys: ['model', 'team.id'], service: SERVICE }),
    );
    expect(grouped.map((r) => [r.g, Number(r.v)]).sort()).toEqual([
      [['a', 'platform'], 12],
      [['b', 'platform'], 2],
    ]);
    const filtered = await run<{ v: number }>(
      metricTotalsQuery({ range, metrics: ['it.*'], filter: { model: 'b' }, service: SERVICE }),
    );
    expect(filtered.map((r) => Number(r.v))).toEqual([2]);
  });

  it('reads Claude Code’s events by body or by event name', async () => {
    const events = await run<{
      event: string;
      tool: string;
      success: string;
      status: string;
      c: number;
      retries: number;
    }>(claudeCodeEventsQuery(range, SERVICE));
    const of = (name: string) => events.filter((e) => e.event === name);
    expect(of('user_prompt').reduce((n, e) => n + Number(e.c), 0)).toBe(2);
    expect(of('api_error')).toMatchObject([{ status: '429', retries: 1 }]);
    expect(of('tool_result')).toMatchObject([{ tool: 'Bash', success: 'false' }]);

    const [totals] = await run<{ users: number; sessions: number; prompts: number; q: number[] }>(
      claudeCodeTotalsQuery(range, SERVICE),
    );
    expect(totals).toMatchObject({ users: 1, sessions: 2, prompts: 2 });
    expect(totals!.q[0]).toBe(2000);
  });

  it('finds evaluation results sent as log records', async () => {
    const rows = await run<{ TraceId: string; SpanId: string; attrs: Record<string, string> }>(
      evaluationLogsQuery(range, SERVICE),
    );
    expect(rows).toEqual([
      {
        TraceId: TRACE,
        SpanId: 'a000000000000002',
        service: SERVICE,
        attrs: { 'gen_ai.evaluation.name': 'faithfulness', 'gen_ai.evaluation.score.value': '0.4' },
      },
    ]);
  });

  it('returns captured content only to the safety scan, cut to size', async () => {
    const spans = await run<{ name: string; content: Record<string, string> }>(
      agentContentQuery(range, { service: SERVICE, maxChars: 30 }),
    );
    expect(spans.map((r) => r.name).sort()).toEqual(['execute_tool search', 'gen_ai.chat claude-sonnet-5-5']);
    const chat = spans.find((r) => r.name.startsWith('gen_ai.chat'))!;
    expect(Object.keys(chat.content)).toEqual(['gen_ai.input.messages']);
    expect(chat.content['gen_ai.input.messages']).toHaveLength(30);
    // A redacted Claude Code prompt is not content.
    const prompts = await run<{ content: Record<string, string> }>(claudeCodePromptsQuery(range, { service: SERVICE }));
    expect(prompts.map((p) => p.content.prompt)).toEqual(['call +972 54 123 4567']);
  });

  it('counts outcomes per trace, per field and from a metric', async () => {
    const base = { metricFilter: {} };
    const byTrace = outcomeRowsQuery(
      {
        ...base,
        signal: 'traces',
        query: 'gen_ai.operation.name:invoke_agent NOT status:error',
        attribution: { mode: 'trace' },
      },
      range,
      'team.id',
      SERVICE,
    );
    expect(toOutcomeRows({ signal: 'traces' }, await run(byTrace))).toEqual([
      { service: SERVICE, join: TRACE, team: 'platform', count: 1 },
    ]);
    const byField = outcomeRowsQuery(
      {
        ...base,
        signal: 'traces',
        query: 'landflow.agent.source:*',
        attribution: { mode: 'field', field: 'gen_ai.agent.name' },
      },
      range,
      'no.such.attribute',
      SERVICE,
    );
    // No team attribute on the row: the service's namespace stands in.
    expect(toOutcomeRows({ signal: 'traces' }, await run(byField))).toEqual([
      { service: SERVICE, join: 'Scout', team: 'landflow', count: 1 },
    ]);
    const byIncident = outcomeRowsQuery(
      { ...base, signal: 'traces', query: 'incident.id:*', attribution: { mode: 'correlate', field: 'incident.id' } },
      range,
      'team.id',
      SERVICE,
    );
    expect(toOutcomeRows({ signal: 'traces' }, await run(byIncident))[0]).toMatchObject({ join: 'inc-9' });
    const logs = outcomeRowsQuery(
      {
        ...base,
        signal: 'logs',
        query: 'event.name:api_request',
        attribution: { mode: 'agent', agent: 'x/Claude Code' },
      },
      range,
      'team.id',
      SERVICE,
    );
    expect(toOutcomeRows({ signal: 'logs' }, await run(logs))).toEqual([
      { service: SERVICE, join: '', team: '', count: 2 },
    ]);
    const metric = outcomeRowsQuery(
      {
        ...base,
        signal: 'metric',
        query: 'claude_code.commit.count',
        attribution: { mode: 'agent', agent: 'x/Claude Code' },
      },
      range,
      'team.id',
      SERVICE,
    );
    expect(toOutcomeRows({ signal: 'metric' }, await run(metric))).toEqual([
      { service: SERVICE, join: '', team: 'platform', count: 4 },
    ]);
  });
});
