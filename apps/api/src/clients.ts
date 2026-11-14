import { createClient, type ClickHouseClient, type ClickHouseSettings } from '@clickhouse/client';
import type { Query } from '@clickland/query';
import postgres from 'postgres';
import type { Config } from './config.js';
import { ApiError } from './errors.js';

export type Sql = postgres.Sql;

export interface Clients {
  ch: ClickHouseClient;
  pg: Sql;
  close(): Promise<void>;
}

export function createClients(config: Config): Clients {
  const ch = createClient({
    url: config.clickhouseUrl,
    username: config.clickhouseUser,
    password: config.clickhousePassword,
    database: config.database,
    request_timeout: 60_000,
    clickhouse_settings: { session_timezone: 'UTC', output_format_json_quote_64bit_integers: 0 },
  });
  const pg = postgres(config.postgresUrl, { max: 10, onnotice: () => {} });
  return {
    ch,
    pg,
    async close() {
      await Promise.all([ch.close(), pg.end()]);
    },
  };
}

export interface QueryResult<T> {
  rows: T[];
  stats: { rowsRead: number; bytesRead: number; elapsedMs: number };
}

/** Runs a compiled query; a ClickHouse error becomes `query_failed` with the server's message. */
export async function runQuery<T>(
  ch: ClickHouseClient,
  q: Query,
  settings: ClickHouseSettings = {},
): Promise<QueryResult<T>> {
  const started = performance.now();
  try {
    const rs = await ch.query({
      query: q.sql,
      query_params: q.params,
      format: 'JSONEachRow',
      clickhouse_settings: settings,
    });
    const rows = await rs.json<T>();
    const summary = rs.response_headers['x-clickhouse-summary'];
    const parsed =
      typeof summary === 'string' ? (JSON.parse(summary) as { read_rows?: string; read_bytes?: string }) : {};
    return {
      rows,
      stats: {
        rowsRead: Number(parsed.read_rows ?? 0),
        bytesRead: Number(parsed.read_bytes ?? 0),
        elapsedMs: Math.round(performance.now() - started),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0]! : String(error);
    throw new ApiError('query_failed', message.slice(0, 500));
  }
}
