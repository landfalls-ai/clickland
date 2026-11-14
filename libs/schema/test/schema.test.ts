import { describe, expect, it } from 'vitest';
import { loadMigrations, renderClickhouse, splitStatements } from '../src/index.js';

const config = {
  database: 'clickland',
  logsTtlDays: 30,
  tracesTtlDays: 30,
  metricsTtlDays: 90,
  ingestPassword: 'in',
  apiPassword: "it's",
};

describe('renderClickhouse', () => {
  it('fills the database and the retention of each signal', () => {
    const sql = renderClickhouse('CREATE TABLE ${DATABASE}.t TTL ts + ${LOGS_TTL}, ${METRICS_TTL}', config);
    expect(sql).toBe('CREATE TABLE clickland.t TTL ts + toIntervalDay(30), toIntervalDay(90)');
  });

  it('refuses an unknown placeholder and a database name that would need quoting', () => {
    expect(() => renderClickhouse('${NOPE}', config)).toThrow(/Unknown placeholder/);
    expect(() => renderClickhouse('x', { ...config, database: 'a;DROP' })).toThrow(/Bad database name/);
  });
});

describe('passwords', () => {
  it('are quoted for a SQL string literal', () => {
    expect(renderClickhouse("BY '${API_PASSWORD}'", config)).toBe("BY 'it\\'s'");
  });
});

describe('splitStatements', () => {
  it('splits at a semicolon that ends a line and drops comment-only pieces', () => {
    expect(splitStatements('-- c\nSELECT 1;\n-- only a comment;\nSELECT 2;\n')).toEqual(['-- c\nSELECT 1', 'SELECT 2']);
  });
});

describe('the shipped ClickHouse migrations', () => {
  const migrations = loadMigrations('clickhouse', (sql) => renderClickhouse(sql, config));

  it('are numbered in order and leave no placeholder behind', () => {
    expect(migrations.map((m) => m.name)).toEqual([...migrations.map((m) => m.name)].sort());
    for (const m of migrations) for (const s of m.statements) expect(s).not.toMatch(/\$\{/);
  });

  it('keep the ClickStack table names the stock collector exporter writes to', () => {
    const all = migrations.flatMap((m) => m.statements).join('\n');
    for (const table of [
      'otel_logs',
      'otel_traces',
      'otel_metrics_gauge',
      'otel_metrics_sum',
      'otel_metrics_histogram',
    ])
      expect(all).toContain(`clickland.${table}`);
  });

  it('give logs and traces 30 days and metrics 90', () => {
    const all = migrations.flatMap((m) => m.statements).join('\n');
    expect(all).toMatch(/otel_logs[\s\S]*TTL toDateTime\(Timestamp\) \+ toIntervalDay\(30\)/);
    expect(all).toMatch(/TTL toDateTime\(TimeUnix\) \+ toIntervalDay\(90\)/);
  });
});
