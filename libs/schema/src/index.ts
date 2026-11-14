import { createClient, type ClickHouseClient } from '@clickhouse/client';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

/** Where the SQL files live: `migrations/` next to `dist/` (and next to `src/` in tests). */
export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export interface SchemaConfig {
  clickhouseUrl: string;
  clickhouseUser: string;
  clickhousePassword: string;
  database: string;
  postgresUrl: string;
  logsTtlDays: number;
  tracesTtlDays: number;
  metricsTtlDays: number;
  ingestPassword: string;
  apiPassword: string;
}

/** Reads the configuration from CLICKLAND_* variables, with the local development defaults (deploy/.env.example). */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): SchemaConfig {
  const days = (name: string, fallback: number) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isInteger(value) || value < 1)
      throw new Error(`${name} must be a whole number of days, got ${env[name]}`);
    return value;
  };
  return {
    clickhouseUrl: env.CLICKLAND_CH_URL ?? 'http://127.0.0.1:28123',
    clickhouseUser: env.CLICKLAND_CH_ADMIN_USER ?? 'clickland_admin',
    clickhousePassword: env.CLICKLAND_CH_ADMIN_PASSWORD ?? 'clickland-dev-admin',
    database: env.CLICKLAND_CH_DATABASE ?? 'clickland',
    postgresUrl: env.CLICKLAND_PG_URL ?? 'postgres://clickland:clickland-dev@127.0.0.1:25432/clickland',
    logsTtlDays: days('CLICKLAND_LOGS_TTL_DAYS', 30),
    tracesTtlDays: days('CLICKLAND_TRACES_TTL_DAYS', 30),
    metricsTtlDays: days('CLICKLAND_METRICS_TTL_DAYS', 90),
    ingestPassword: env.CLICKLAND_CH_INGEST_PASSWORD ?? 'clickland-dev-ingest',
    apiPassword: env.CLICKLAND_CH_API_PASSWORD ?? 'clickland-dev-api',
  };
}

export interface Migration {
  name: string;
  statements: string[];
}

/**
 * Fills the `${NAME}` placeholders the ClickStack files use. Retention is set when a table is created; changing it
 * later is a new migration (`ALTER TABLE … MODIFY TTL`), never an edit of a shipped one.
 */
export function renderClickhouse(
  sql: string,
  config: Pick<SchemaConfig, 'database' | 'logsTtlDays' | 'tracesTtlDays' | 'metricsTtlDays'> &
    Partial<Pick<SchemaConfig, 'ingestPassword' | 'apiPassword'>>,
): string {
  const quoted = (value: string | undefined) => value?.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  if (!/^[a-z_][a-z0-9_]*$/.test(config.database)) throw new Error(`Bad database name: ${config.database}`);
  const vars: Record<string, string> = {
    DATABASE: config.database,
    LOGS_TTL: `toIntervalDay(${config.logsTtlDays})`,
    TRACES_TTL: `toIntervalDay(${config.tracesTtlDays})`,
    METRICS_TTL: `toIntervalDay(${config.metricsTtlDays})`,
  };
  const ingest = quoted(config.ingestPassword);
  const api = quoted(config.apiPassword);
  if (ingest !== undefined) vars.INGEST_PASSWORD = ingest;
  if (api !== undefined) vars.API_PASSWORD = api;
  return sql.replace(/\$\{([A-Z_]+)\}/g, (match, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new Error(`Unknown placeholder ${match}`);
    return value;
  });
}

/** Splits a file into statements at a `;` that ends a line, and drops comment-only pieces. */
export function splitStatements(sql: string): string[] {
  return sql
    .split(/;\s*$/m)
    .map((part) => part.trim())
    .filter((part) => part.replace(/^--.*$/gm, '').trim().length > 0);
}

export function loadMigrations(
  kind: 'clickhouse' | 'postgres',
  render: (sql: string) => string = (s) => s,
): Migration[] {
  const dir = join(MIGRATIONS_DIR, kind);
  return readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => {
      const sql = render(readFileSync(join(dir, file), 'utf8'));
      // Postgres runs a file as one script; ClickHouse takes one statement per request.
      return { name: file, statements: kind === 'postgres' ? [sql] : splitStatements(sql) };
    });
}

export async function migrateClickhouse(
  config: SchemaConfig,
  log: (line: string) => void = () => {},
): Promise<string[]> {
  const client: ClickHouseClient = createClient({
    url: config.clickhouseUrl,
    username: config.clickhouseUser,
    password: config.clickhousePassword,
  });
  try {
    await client.command({ query: `CREATE DATABASE IF NOT EXISTS ${config.database}` });
    await client.command({
      query: `CREATE TABLE IF NOT EXISTS ${config.database}._migrations (name String, applied_at DateTime DEFAULT now())
              ENGINE = MergeTree ORDER BY name`,
    });
    const done = new Set(
      (
        await (
          await client.query({ query: `SELECT name FROM ${config.database}._migrations`, format: 'JSONEachRow' })
        ).json<{ name: string }>()
      ).map((row) => row.name),
    );
    const applied: string[] = [];
    for (const migration of loadMigrations('clickhouse', (sql) => renderClickhouse(sql, config))) {
      if (done.has(migration.name)) continue;
      for (const statement of migration.statements) await client.command({ query: statement });
      await client.insert({
        table: `${config.database}._migrations`,
        values: [{ name: migration.name }],
        format: 'JSONEachRow',
      });
      applied.push(migration.name);
      log(`clickhouse: applied ${migration.name}`);
    }
    return applied;
  } finally {
    await client.close();
  }
}

export async function migratePostgres(config: SchemaConfig, log: (line: string) => void = () => {}): Promise<string[]> {
  const sql = postgres(config.postgresUrl, { onnotice: () => {} });
  try {
    await sql`CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const done = new Set((await sql<{ name: string }[]>`SELECT name FROM _migrations`).map((row) => row.name));
    const applied: string[] = [];
    for (const migration of loadMigrations('postgres')) {
      if (done.has(migration.name)) continue;
      await sql.begin(async (tx) => {
        await tx.unsafe(migration.statements[0]!);
        await tx`INSERT INTO _migrations (name) VALUES (${migration.name})`;
      });
      applied.push(migration.name);
      log(`postgres: applied ${migration.name}`);
    }
    return applied;
  } finally {
    await sql.end();
  }
}
