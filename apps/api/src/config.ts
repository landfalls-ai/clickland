import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { parseEnv } from 'node:util';

/** Sign-in through Landbright: an OIDC relying party (authorization code + PKCE S256, client_secret_post). */
export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  postLogoutRedirectUri: string;
  scopes: string;
}

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
  /**
   * `keys` (the default): every call needs an API key or a console session (sign-in through Landbright).
   * `dev`: calls with neither act as a local admin; only on a loopback host, and only when asked for.
   */
  authMode: 'dev' | 'keys';
  /** Null until the Landbright client file (or CLICKLAND_OIDC_*) gives a secret; `oidcProblem` says why. */
  oidc: OidcConfig | null;
  oidcProblem: string | null;
  /** How long a console session lasts. */
  sessionHours: number;
  /** The Landflow chat endpoint of the observability assistant flow, and its shared secret (the Assistant panel). */
  assistantUrl: string | null;
  assistantAuthHeader: string | null;
  assistantSecret: string | null;
  /** `user:password` for the chat trigger's Basic Auth. */
  assistantBasicAuth: string | null;
  /** Off in tests: the alert evaluator, webhook dispatcher and session cleanup loops. */
  backgroundJobs: boolean;
}

const expandHome = (path: string) => (path.startsWith('~/') ? `${homedir()}${path.slice(1)}` : path);

/** The Landbright client file (LANDBRIGHT_ISSUER, LANDBRIGHT_CLIENT_ID, LANDBRIGHT_CLIENT_SECRET, …), if it exists. */
export function readClientFile(path: string): Record<string, string> | null {
  const file = expandHome(path);
  if (!existsSync(file)) return null;
  return parseEnv(readFileSync(file, 'utf8')) as Record<string, string>;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
export const DEFAULT_CLIENT_FILE = '~/.config/land-family/clickland-local.env';

/** Landbright's client for Clickland: the client file Landbright's session writes, overridden by CLICKLAND_OIDC_*. */
export function oidcFromEnv(env: NodeJS.ProcessEnv): { oidc: OidcConfig | null; problem: string | null } {
  const clientFile = env.CLICKLAND_OIDC_ENV_FILE ?? DEFAULT_CLIENT_FILE;
  const file = clientFile === 'none' ? null : readClientFile(clientFile);
  const secret = env.CLICKLAND_OIDC_CLIENT_SECRET ?? file?.LANDBRIGHT_CLIENT_SECRET ?? null;
  const method = file?.LANDBRIGHT_TOKEN_ENDPOINT_AUTH_METHOD ?? 'client_secret_post';
  if (!secret)
    return { oidc: null, problem: `No client secret: ${clientFile} doesn't exist yet (Landbright writes it)` };
  if (method !== 'client_secret_post')
    return { oidc: null, problem: `The Landbright client uses ${method}; Clickland sends client_secret_post` };
  const origin = (env.CLICKLAND_OIDC_CONSOLE_URL ?? 'http://localhost:4711').replace(/\/$/, '');
  return {
    oidc: {
      issuer: (env.CLICKLAND_OIDC_ISSUER ?? file?.LANDBRIGHT_ISSUER ?? 'http://localhost:4402/oidc').replace(/\/$/, ''),
      clientId: env.CLICKLAND_OIDC_CLIENT_ID ?? file?.LANDBRIGHT_CLIENT_ID ?? 'clickland-local',
      clientSecret: secret,
      redirectUri: env.CLICKLAND_OIDC_REDIRECT_URI ?? `${origin}/api/auth/oidc/callback`,
      postLogoutRedirectUri: env.CLICKLAND_OIDC_POST_LOGOUT_REDIRECT_URI ?? `${origin}/`,
      scopes: env.CLICKLAND_OIDC_SCOPES ?? 'openid email profile roles',
    },
    problem: null,
  };
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const auth = env.CLICKLAND_AUTH ?? 'keys';
  if (auth !== 'dev' && auth !== 'keys') throw new Error('CLICKLAND_AUTH is keys (the default) or dev');
  const host = env.CLICKLAND_API_HOST ?? '127.0.0.1';
  if (auth === 'dev' && !LOOPBACK.has(host))
    throw new Error(`CLICKLAND_AUTH=dev is for this machine only; the API listens on ${host}`);
  const sessionHours = Number(env.CLICKLAND_SESSION_HOURS ?? 8);
  if (!(sessionHours > 0 && sessionHours <= 24 * 30)) throw new Error('CLICKLAND_SESSION_HOURS is 1 to 720');
  const { oidc, problem } = oidcFromEnv(env);
  return {
    port: Number(env.CLICKLAND_API_PORT ?? 4710),
    host,
    clickhouseUrl: env.CLICKLAND_CH_URL ?? 'http://127.0.0.1:28123',
    clickhouseUser: env.CLICKLAND_CH_API_USER ?? 'clickland_api',
    clickhousePassword: env.CLICKLAND_CH_API_PASSWORD ?? 'clickland-dev-api',
    database: env.CLICKLAND_CH_DATABASE ?? 'clickland',
    postgresUrl: env.CLICKLAND_PG_URL ?? 'postgres://clickland:clickland-dev@127.0.0.1:25432/clickland',
    consoleUrl: (env.CLICKLAND_CONSOLE_URL ?? 'http://127.0.0.1:4711').replace(/\/$/, ''),
    bootstrapKey: env.CLICKLAND_BOOTSTRAP_KEY || null,
    authMode: auth,
    oidc,
    oidcProblem: problem,
    sessionHours,
    assistantUrl: env.CLICKLAND_ASSISTANT_URL ?? null,
    assistantAuthHeader: env.CLICKLAND_ASSISTANT_AUTH_HEADER ?? null,
    assistantSecret: env.CLICKLAND_ASSISTANT_SECRET ?? null,
    assistantBasicAuth: env.CLICKLAND_ASSISTANT_BASIC_AUTH ?? null,
    backgroundJobs: env.CLICKLAND_BACKGROUND_JOBS !== 'off',
  };
}
