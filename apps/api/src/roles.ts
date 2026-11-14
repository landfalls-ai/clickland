import type { ApiScope } from '@clickland/contracts';

/** A person's role in Clickland, from their Landbright groups. */
export type Role = 'viewer' | 'editor' | 'admin';

/** Landbright group → Clickland role. Other groups ("Everyone", …) are ignored. Matched without case. */
export const ROLE_BY_GROUP: Record<string, Role> = {
  'clickland admins': 'admin',
  'clickland editors': 'editor',
  'clickland viewers': 'viewer',
};

/** What each role may do, as API scopes (docs/identity.md#roles). */
export const SCOPES_BY_ROLE: Record<Role, ApiScope[]> = {
  viewer: ['read'],
  editor: ['read', 'alerts:write', 'notes:write', 'views:write'],
  admin: ['admin'],
};

const RANK: Record<Role, number> = { viewer: 1, editor: 2, admin: 3 };

/** The strongest role the groups grant, or null when none of them is a Clickland group. */
export function roleFromGroups(groups: readonly string[]): Role | null {
  let best: Role | null = null;
  for (const g of groups) {
    const role = ROLE_BY_GROUP[g.trim().toLowerCase()];
    if (role && (!best || RANK[role] > RANK[best])) best = role;
  }
  return best;
}

/** The role a key's scopes amount to (for "me" with an API key). */
export function roleFromScopes(scopes: readonly ApiScope[]): Role {
  if (scopes.includes('admin')) return 'admin';
  return scopes.some((s) => s.endsWith(':write')) ? 'editor' : 'viewer';
}
