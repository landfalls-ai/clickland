import { describe, expect, it } from 'vitest';
import {
  alignRange,
  buildTrace,
  chooseBucketSeconds,
  compileSearch,
  histogramQuantile,
  LOGS,
  maskMessage,
  minePatterns,
  parseSearch,
  searchRowsQuery,
  SearchFieldError,
  SearchSyntaxError,
  splitByNonAlpha,
  TRACES,
} from '../src/index.js';

describe('parseSearch', () => {
  it('reads words, phrases, fields, comparisons, existence and wildcards', () => {
    expect(parseSearch('timeout')).toEqual({ type: 'match', field: null, value: 'timeout', kind: 'word' });
    expect(parseSearch('"connection refused"')).toEqual({
      type: 'match',
      field: null,
      value: 'connection refused',
      kind: 'phrase',
    });
    expect(parseSearch('level:error')).toEqual({ type: 'match', field: 'level', value: 'error', kind: 'word' });
    expect(parseSearch('http.status_code:>=500')).toEqual({
      type: 'compare',
      field: 'http.status_code',
      op: '>=',
      value: '500',
    });
    expect(parseSearch('k8s.pod.name:*')).toEqual({ type: 'exists', field: 'k8s.pod.name' });
    expect(parseSearch('route:/api/*')).toEqual({ type: 'match', field: 'route', value: '/api/*', kind: 'wildcard' });
    expect(parseSearch('msg:"a b"')).toEqual({ type: 'match', field: 'msg', value: 'a b', kind: 'phrase' });
  });

  it('gives AND precedence over OR, and reads - and NOT as negation', () => {
    expect(parseSearch('a b OR c')).toEqual({
      type: 'or',
      children: [
        {
          type: 'and',
          children: [
            { type: 'match', field: null, value: 'a', kind: 'word' },
            { type: 'match', field: null, value: 'b', kind: 'word' },
          ],
        },
        { type: 'match', field: null, value: 'c', kind: 'word' },
      ],
    });
    expect(parseSearch('-level:debug')).toEqual({
      type: 'not',
      child: { type: 'match', field: 'level', value: 'debug', kind: 'word' },
    });
    expect(parseSearch('NOT (a OR b)')?.type).toBe('not');
  });

  it('keeps a dash inside a word', () => {
    expect(parseSearch('connection-refused')).toEqual({
      type: 'match',
      field: null,
      value: 'connection-refused',
      kind: 'word',
    });
  });

  it('says where a search is broken', () => {
    expect(() => parseSearch('(a b')).toThrow(SearchSyntaxError);
    expect(() => parseSearch('"open')).toThrow(/quote is not closed/);
    expect(() => parseSearch('level:')).toThrow(/needs a value/);
    expect(() => parseSearch('a OR')).toThrow(/ends too early/);
    expect(() => parseSearch('a )')).toThrow(/Unexpected/);
  });

  it('returns null for an empty search', () => {
    expect(parseSearch('   ')).toBeNull();
  });
});

describe('splitByNonAlpha', () => {
  it('splits like ClickHouse: ASCII punctuation separates, other bytes stay in tokens', () => {
    expect(splitByNonAlpha('GET /api/v1/users?id=42')).toEqual(['GET', 'api', 'v1', 'users', 'id', '42']);
    expect(splitByNonAlpha('naïve-café')).toEqual(['naïve', 'café']);
  });
});

describe('compileSearch', () => {
  it('turns a bare word into hasAllTokens on the indexed body', () => {
    expect(compileSearch(LOGS, 'Timeout')).toEqual({
      sql: 'hasAllTokens(lower(Body), {p0:Array(String)})',
      params: { p0: ['timeout'] },
    });
  });

  it('turns a phrase into hasPhrase and a punctuated word into an exact LIKE', () => {
    expect(compileSearch(LOGS, '"Connection refused"').sql).toBe('hasPhrase(lower(Body), {p0:String})');
    const dashed = compileSearch(LOGS, 'connection-refused');
    expect(dashed.sql).toBe('lower(Body) LIKE {p0:String}');
    expect(dashed.params.p0).toBe('%connection-refused%');
  });

  it('escapes LIKE metacharacters in wildcards', () => {
    expect(compileSearch(LOGS, '100%_done*').params.p0).toBe('%100\\%\\_done%%');
  });

  it('matches levels case-insensitively and trace ids exactly', () => {
    expect(compileSearch(LOGS, 'level:ERROR')).toEqual({
      sql: 'lower(`SeverityText`) = {p0:String}',
      params: { p0: 'error' },
    });
    expect(compileSearch(LOGS, 'trace_id:abc').sql).toBe('`TraceId` = {p0:String}');
  });

  it('uses the key=value items index for an attribute, across maps when unprefixed', () => {
    expect(compileSearch(LOGS, 'attributes.http.method:GET')).toEqual({
      sql: 'has(`LogAttributeItems`, {p0:String})',
      params: { p0: 'http.method=GET' },
    });
    expect(compileSearch(LOGS, 'http.method:GET').sql).toBe(
      '(has(`LogAttributeItems`, {p0:String}) OR has(`ResourceAttributeItems`, {p1:String}) OR has(`ScopeAttributeItems`, {p2:String}))',
    );
  });

  it('reads a materialized column instead of the map', () => {
    expect(compileSearch(LOGS, 'k8s.pod.name:web-1').sql).toBe('`__hdx_materialized_k8s.pod.name` = {p0:String}');
    expect(compileSearch(LOGS, 'resource.k8s.namespace.name:*').sql).toBe(
      "`__hdx_materialized_k8s.namespace.name` != ''",
    );
  });

  it('compares attribute values as numbers and span durations in milliseconds', () => {
    expect(compileSearch(LOGS, 'attr.status:>=500').sql).toBe(
      '(mapContains(`LogAttributes`, {p0:String}) AND toFloat64OrNull(`LogAttributes`[{p0:String}]) >= {p1:Float64})',
    );
    expect(compileSearch(TRACES, 'duration:>500')).toEqual({
      sql: '`Duration` > {p0:Float64}',
      params: { p0: 500_000_000 },
    });
  });

  it('combines with AND, OR and NOT', () => {
    expect(compileSearch(LOGS, 'service:api (timeout OR refused) -level:debug').sql).toBe(
      '`ServiceName` = {p0:String} AND (hasAllTokens(lower(Body), {p1:Array(String)}) OR hasAllTokens(lower(Body), {p2:Array(String)})) AND NOT lower(`SeverityText`) = {p3:String}',
    );
  });

  it('never puts typed text into SQL', () => {
    const hostile = compileSearch(LOGS, `"'; DROP TABLE otel_logs; --" attr.x':y`);
    expect(hostile.sql).not.toMatch(/DROP|'/);
    expect(() => compileSearch(LOGS, 'duration:abc')).not.toThrow(); // duration is a trace field; on logs it is an attribute
    expect(() => compileSearch(TRACES, 'duration:abc')).toThrow(SearchFieldError);
  });

  it('matches everything when empty, and keeps parameter names apart with a prefix', () => {
    expect(compileSearch(LOGS, '')).toEqual({ sql: 'true', params: {} });
    expect(compileSearch(LOGS, 'x', 'a').sql).toBe('hasAllTokens(lower(Body), {a0:Array(String)})');
  });
});

describe('time buckets', () => {
  const range = { from: new Date('2026-11-14T10:00:00Z'), to: new Date('2026-11-14T11:00:00Z') };

  it('chooses a bucket that keeps at most 120 points', () => {
    expect(chooseBucketSeconds(range)).toBe(30);
    expect(chooseBucketSeconds({ from: range.from, to: new Date('2026-11-21T10:00:00Z') })).toBe(7200);
  });

  it('rounds the range out to whole buckets so repeated queries repeat', () => {
    const r = alignRange({ from: new Date('2026-11-14T10:00:07Z'), to: new Date('2026-11-14T10:59:59Z') }, 60);
    expect(r.from.toISOString()).toBe('2026-11-14T10:00:00.000Z');
    expect(r.to.toISOString()).toBe('2026-11-14T11:00:00.000Z');
  });

  it('pages with a numeric cursor only', () => {
    expect(searchRowsQuery(LOGS, '', range, 10, '1794661998000000000').params.before).toBe('1794661998000000000');
    expect(() => searchRowsQuery(LOGS, '', range, 10, '1 OR 1=1')).toThrow(SearchFieldError);
  });
});

describe('histogramQuantile', () => {
  it('interpolates inside the bucket that holds the rank', () => {
    // 10 values ≤ 100, 10 values in (100, 200]
    expect(histogramQuantile(0.5, [10, 10, 0], [100, 200])).toBe(100);
    expect(histogramQuantile(0.75, [10, 10, 0], [100, 200])).toBe(150);
    expect(histogramQuantile(0.99, [0, 0, 5], [100, 200])).toBe(200);
    expect(Number.isNaN(histogramQuantile(0.5, [0, 0], [1]))).toBe(true);
  });
});

describe('Drain', () => {
  it('masks variables', () => {
    expect(maskMessage('user 42 from 10.0.0.1:8080 took 31ms id=4bf92f3577b34da6')).toBe(
      'user <NUM> from <IP> took <NUM> id=<HEX>',
    );
  });

  it('groups messages that differ only in variables', () => {
    const patterns = minePatterns([
      { text: 'Connection to db-1 refused after 30 ms', service: 'api' },
      { text: 'Connection to db-2 refused after 45 ms', service: 'api' },
      { text: 'Connection to cache refused after 12 ms', service: 'worker' },
      { text: 'User alice signed in', service: 'auth' },
      { text: 'User bob signed in', service: 'auth' },
    ]);
    expect(patterns[0]).toMatchObject({
      template: 'Connection to <*> refused after <NUM> ms',
      count: 3,
      services: ['api', 'worker'],
    });
    expect(patterns[1]).toMatchObject({ template: 'User <*> signed in', count: 2 });
  });
});

describe('buildTrace', () => {
  const span = (
    spanId: string,
    parentSpanId: string,
    start: number,
    duration: number,
    status = 'Ok',
    service = 'api',
  ) => ({
    spanId,
    parentSpanId,
    startNs: BigInt(start),
    durationNs: BigInt(duration),
    status,
    service,
  });

  it('orders spans depth first and finds the trace bounds', () => {
    const t = buildTrace([span('c', 'a', 30, 10, 'Error', 'db'), span('a', '', 0, 100), span('b', 'a', 10, 5)]);
    expect(t.ordered.map((o) => [o.span.spanId, o.depth])).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 1],
    ]);
    expect(t.durationNs).toBe(100n);
    expect(t.services).toEqual(['api', 'db']);
    expect(t.errorCount).toBe(1);
  });

  it('shows a span whose parent is missing as a root', () => {
    expect(buildTrace([span('x', 'gone', 5, 1)]).roots).toHaveLength(1);
  });
});
