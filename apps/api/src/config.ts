/** The API's configuration, from CLICKLAND_* variables (docs/reference/configuration.md). Defaults are the local dev stack. */
export interface Config {
  port: number;
  host: string;
  clickhouseUrl: string;
  clickhouseUser: string;
  clickhousePassword: string;
  database: string;
  postgresUrl: string;
  /** Where people open Clickland (links in webhooks, knowledge results and MCP answers). */
  consoleUrl: string;
  /** An admin key that exists while it is set. */
  bootstrapKey: string | null;
  /** `dev`: the console needs no sign-in (local only). `keys`: every call needs an API key. */
  authMode: 'dev' | 'keys';
  /** The Landflow chat endpoint of the observability assistant flow, and its shared secret (the Assistant panel). */
  assistantUrl: string | null;
  assistantAuthHeader: string | null;
  assistantSecret: string | null;
  /** Off in tests: the alert evaluator and webhook dispatcher loops. */
  backgroundJobs: boolean;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const auth = env.CLICKLAND_AUTH ?? 'dev';
  if (auth !== 'dev' && auth !== 'keys') throw new Error('CLICKLAND_AUTH is dev or keys');
  return {
    port: Number(env.CLICKLAND_API_PORT ?? 4710),
    host: env.CLICKLAND_API_HOST ?? '127.0.0.1',
    clickhouseUrl: env.CLICKLAND_CH_URL ?? 'http://127.0.0.1:28123',
    clickhouseUser: env.CLICKLAND_CH_API_USER ?? 'clickland_api',
    clickhousePassword: env.CLICKLAND_CH_API_PASSWORD ?? 'clickland-dev-api',
    database: env.CLICKLAND_CH_DATABASE ?? 'clickland',
    postgresUrl: env.CLICKLAND_PG_URL ?? 'postgres://clickland:clickland-dev@127.0.0.1:25432/clickland',
    consoleUrl: (env.CLICKLAND_CONSOLE_URL ?? 'http://127.0.0.1:4711').replace(/\/$/, ''),
    bootstrapKey: env.CLICKLAND_BOOTSTRAP_KEY ?? null,
    authMode: auth,
    assistantUrl: env.CLICKLAND_ASSISTANT_URL ?? null,
    assistantAuthHeader: env.CLICKLAND_ASSISTANT_AUTH_HEADER ?? null,
    assistantSecret: env.CLICKLAND_ASSISTANT_SECRET ?? null,
    backgroundJobs: env.CLICKLAND_BACKGROUND_JOBS !== 'off',
  };
}
