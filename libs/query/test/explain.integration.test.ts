/**
 * Decision D4 (docs/research.md §8): the search compiler's SQL must hit the indexes it was written for. Runs against the
 * clickland-infra ClickHouse (pnpm dev:up && pnpm db:migrate) when CLICKLAND_INTEGRATION names `db` or `all`.
 */
import { createClient } from '@clickhouse/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  compileSearch,
  countQuery,
  facetsQuery,
  histogramQuery,
  LOGS,
  metricNamesQuery,
  metricQuery,
  sampleQuery,
  searchRowsQuery,
  servicesQuery,
  serviceLogErrorsQuery,
  totalQuery,
  traceQuery,
  TRACES,
  type Query,
} from '../src/index.js';

const enabled = /\b(db|all)\b/.test(process.env.CLICKLAND_INTEGRATION ?? '');
const client = createClient({
  url: process.env.CLICKLAND_CH_URL ?? 'http://127.0.0.1:28123',
  username: 'clickland_admin',
  password: process.env.CLICKLAND_CH_ADMIN_PASSWORD ?? 'clickland-dev-admin',
  database: 'clickland',
  clickhouse_settings: { session_timezone: 'UTC' },
});
const SERVICE = `explain-test-${Date.now()}`;
const now = new Date();
const range = { from: new Date(now.getTime() - 3600_000), to: new Date(now.getTime() + 60_000) };

async function explain(q: Query): Promise<string> {
  const rs = await client.query({
    query: `EXPLAIN indexes = 1 ${q.sql}`,
    query_params: q.params,
    format: 'TabSeparatedRaw',
  });
  return rs.text();
}

/** An index is used when it prunes (a Skip entry), or the text index reads directly (a __text_index_ column). */
const usesIndex = (plan: string, index: string) =>
  new RegExp(`Name: ${index}\\b|__text_index_${index}_|ReadFromTextIndex\\w*\\s*\\(.*${index}`).test(plan);

async function run(q: Query) {
  return (await client.query({ query: q.sql, query_params: q.params, format: 'JSONEachRow' })).json<
    Record<string, unknown>
  >();
}

describe.skipIf(!enabled)('compiled searches use the indexes (EXPLAIN indexes=1)', () => {
  beforeAll(async () => {
    const ts = (offset: number) => new Date(now.getTime() - offset).toISOString().replace('T', ' ').replace('Z', '');
    await client.insert({
      table: 'otel_logs',
      format: 'JSONEachRow',
      values: [
        {
          Timestamp: ts(1000),
          ServiceName: SERVICE,
          SeverityText: 'ERROR',
          SeverityNumber: 17,
          Body: 'Connection to payments-db refused after 30 ms',
          TraceId: '4bf92f3577b34da6a3ce929d0e0e4736',
          LogAttributes: { 'http.method': 'GET', 'http.status_code': '503' },
          ResourceAttributes: { 'k8s.pod.name': 'web-1', 'service.name': SERVICE },
        },
        {
          Timestamp: ts(2000),
          ServiceName: SERVICE,
          SeverityText: 'info',
          SeverityNumber: 9,
          Body: 'User alice signed in',
          LogAttributes: { 'http.method': 'POST' },
          ResourceAttributes: {},
        },
      ],
    });
    await client.insert({
      table: 'otel_traces',
      format: 'JSONEachRow',
      values: [
        {
          Timestamp: ts(1000),
          TraceId: '4bf92f3577b34da6a3ce929d0e0e4736',
          SpanId: '00f067aa0ba902b7',
          ParentSpanId: '',
          SpanName: 'GET /checkout',
          SpanKind: 'Server',
          ServiceName: SERVICE,
          Duration: 750_000_000,
          StatusCode: 'Error',
          SpanAttributes: { 'http.route': '/checkout' },
          ResourceAttributes: {},
        },
      ],
    });
  });

  afterAll(async () => {
    await client.close();
  });

  const cases: [string, typeof LOGS, string, string][] = [
    ['a word', LOGS, 'refused', 'idx_lower_body'],
    ['a phrase', LOGS, '"connection to"', 'idx_lower_body'],
    ['a punctuated word', LOGS, 'payments-db', 'idx_lower_body'],
    ['a wildcard', LOGS, 'refus*', 'idx_lower_body'],
    ['an attribute value', LOGS, 'http.method:GET', 'idx_log_attr_items'],
    ['a prefixed attribute', LOGS, 'attributes.http.method:GET', 'idx_log_attr_items'],
    ['an attribute that exists', LOGS, 'attributes.http.status_code:*', 'idx_log_attr_key'],
    ['a resource attribute', LOGS, 'resource.service.name:x', 'idx_res_attr_items'],
    ['a trace id on logs', LOGS, 'trace_id:4bf92f3577b34da6a3ce929d0e0e4736', 'idx_trace_id'],
    ['a trace id on spans', TRACES, 'trace_id:4bf92f3577b34da6a3ce929d0e0e4736', 'idx_trace_id'],
    ['a span attribute', TRACES, 'attributes.http.route:/checkout', 'idx_span_attr_items'],
    ['a slow span', TRACES, 'duration:>500', 'idx_duration'],
  ];

  for (const [label, schema, search, index] of cases) {
    it(`${label} (${search}) uses ${index}`, async () => {
      const filter = compileSearch(schema, search);
      const plan = await explain({
        sql: `SELECT count() FROM ${schema.table} WHERE ${filter.sql}`,
        params: filter.params,
      });
      expect(usesIndex(plan, index), plan).toBe(true);
    });
  }

  it('a log search with a time range prunes by the primary key too', async () => {
    const plan = await explain(searchRowsQuery(LOGS, 'refused', range, 50));
    expect(plan).toMatch(/PrimaryKey[\s\S]*toStartOfFiveMinutes\(Timestamp\)/);
    expect(usesIndex(plan, 'idx_lower_body')).toBe(true);
  });

  it('finds the rows it should', async () => {
    const rows = await run(searchRowsQuery(LOGS, `service:${SERVICE} refused http.method:GET level:error`, range, 10));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.Body).toContain('payments-db');
    expect(await run(searchRowsQuery(LOGS, `service:${SERVICE} -refused`, range, 10))).toHaveLength(1);
    expect(await run(searchRowsQuery(LOGS, `service:${SERVICE} k8s.pod.name:web-1`, range, 10))).toHaveLength(1);
    expect(await run(searchRowsQuery(TRACES, `service:${SERVICE} duration:>500 status:error`, range, 10))).toHaveLength(
      1,
    );
  });

  it('runs every query builder', async () => {
    const minute = 60;
    expect((await run(histogramQuery(LOGS, `service:${SERVICE}`, range, minute, 'level'))).length).toBeGreaterThan(0);
    expect(await run(countQuery(LOGS, `service:${SERVICE}`, range, 'http.method'))).toEqual(
      expect.arrayContaining([expect.objectContaining({ k: 'GET' })]),
    );
    await run(facetsQuery(LOGS, range));
    expect(await run(traceQuery(TRACES, '4bf92f3577b34da6a3ce929d0e0e4736'))).not.toHaveLength(0);
    expect(await run(servicesQuery(range))).toEqual(
      expect.arrayContaining([expect.objectContaining({ service: SERVICE })]),
    );
    expect(await run(serviceLogErrorsQuery(range))).toEqual(
      expect.arrayContaining([expect.objectContaining({ service: SERVICE })]),
    );
    expect(await run(sampleQuery(LOGS, `service:${SERVICE}`, range, 10))).toHaveLength(2);
    expect(Number((await run(totalQuery(LOGS, `service:${SERVICE}`, range)))[0]!.c)).toBe(2);
    const names = await run(metricNamesQuery(range));
    expect(names.length).toBeGreaterThan(0);
    for (const type of ['gauge', 'sum', 'histogram'] as const) {
      const name = names.find((n) => n.type === type)?.name as string | undefined;
      if (!name) continue;
      const aggregations =
        type === 'gauge'
          ? (['avg', 'max'] as const)
          : type === 'sum'
            ? (['rate', 'sum'] as const)
            : (['avg', 'p95'] as const);
      for (const aggregation of aggregations)
        await run(metricQuery({ metric: name, type, aggregation, range, bucketSeconds: 60, groupBy: 'service' }));
    }
  });
});
