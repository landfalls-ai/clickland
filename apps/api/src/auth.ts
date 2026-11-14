import type { ApiScope } from '@clickland/contracts';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Sql } from './clients.js';
import type { Config } from './config.js';
import { ApiError } from './errors.js';

export interface Principal {
  /** `key:<name>`, `bootstrap`, `dev` or `oidc:<subject>`. */
  name: string;
  scopes: ApiScope[];
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function newApiKey(): { key: string; prefix: string; hash: string } {
  const key = `ck_${randomBytes(24).toString('base64url').slice(0, 32)}`;
  return { key, prefix: key.slice(0, 11), hash: sha256(key) };
}

const sameString = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Who is calling. An API key wins; without one, `CLICKLAND_AUTH=dev` lets the local console in as an admin. Keys are
 * stored hashed; the bootstrap key is compared in constant time.
 */
export async function authenticate(pg: Sql, config: Config, authorization: string | undefined): Promise<Principal> {
  const match = authorization?.match(/^Bearer\s+(\S+)$/i);
  if (match) {
    const key = match[1]!;
    if (config.bootstrapKey && sameString(key, config.bootstrapKey)) return { name: 'bootstrap', scopes: ['admin'] };
    if (/^ck_[\w-]{32}$/.test(key)) {
      const [row] = await pg<{ id: string; name: string; scopes: ApiScope[] }[]>`
        UPDATE api_keys SET last_used_at = now()
        WHERE hash = ${sha256(key)} AND revoked_at IS NULL
        RETURNING id, name, scopes`;
      if (row) return { name: `key:${row.name}`, scopes: row.scopes };
    }
    throw new ApiError('unauthorized', 'The API key is not valid');
  }
  if (config.authMode === 'dev') return { name: 'dev', scopes: ['admin'] };
  throw new ApiError('unauthorized', 'Send an API key: Authorization: Bearer ck_…');
}

/** Scopes another scope also grants: `read` can read usage rollups (it can read the raw metrics anyway). */
const IMPLIED_BY: Partial<Record<ApiScope, ApiScope[]>> = { 'usage:read': ['read'] };

export function requireScope(principal: Principal, scope: ApiScope): void {
  if (principal.scopes.includes('admin') || principal.scopes.includes(scope)) return;
  if (IMPLIED_BY[scope]?.some((s) => principal.scopes.includes(s))) return;
  throw new ApiError('forbidden', `This needs the ${scope} scope`);
}
