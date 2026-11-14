import type { ApiScope } from '@clickland/contracts';
import { newApiKey } from './auth.js';
import type { Sql } from './clients.js';
import { notFound } from './errors.js';
import { newId } from './ids.js';

type Row = {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiScope[];
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
};
const toKey = (r: Row) => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  scopes: r.scopes,
  createdAt: r.created_at.toISOString(),
  lastUsedAt: r.last_used_at?.toISOString() ?? null,
  revokedAt: r.revoked_at?.toISOString() ?? null,
});

export class Keys {
  constructor(private readonly pg: Sql) {}

  async list() {
    const rows = await this.pg<
      Row[]
    >`SELECT id, name, prefix, scopes, created_at, last_used_at, revoked_at FROM api_keys ORDER BY created_at DESC`;
    return rows.map(toKey);
  }

  /** The key itself is returned only here; Clickland stores its sha256. */
  async create(input: { name: string; scopes: ApiScope[] }) {
    const { key, prefix, hash } = newApiKey();
    const [row] = await this.pg<Row[]>`
      INSERT INTO api_keys (id, name, prefix, hash, scopes) VALUES (${newId('key')}, ${input.name}, ${prefix}, ${hash}, ${input.scopes})
      RETURNING id, name, prefix, scopes, created_at, last_used_at, revoked_at`;
    return { ...toKey(row!), key };
  }

  async revoke(id: string) {
    const rows = await this
      .pg`UPDATE api_keys SET revoked_at = now() WHERE id = ${id} AND revoked_at IS NULL RETURNING id`;
    if (rows.length === 0) throw notFound('API key');
  }
}
