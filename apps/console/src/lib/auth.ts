import { useQuery } from '@tanstack/react-query';
import { ApiError, get, send } from './api';
import type { Me, Role } from './types';

/**
 * Who is signed in. 401 means sign in with Landbright. Until the identity routes exist (404), the console runs as a
 * local developer with every role, as with `CLICKLAND_AUTH=dev`.
 */
export const DEV_ME: Me = { user: { name: 'Local developer', email: 'dev@clickland.local', roles: ['admin'] }, authMode: 'dev' };

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await get<Me>('/api/auth/me');
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return DEV_ME;
        throw e;
      }
    },
    retry: false,
    staleTime: 60_000,
  });
}

const LEVEL: Record<Role, number> = { viewer: 1, editor: 2, admin: 3 };

/** The strongest role among the user's roles. */
export function roleOf(me: Me | undefined): Role {
  const roles = (me?.user.roles ?? []).map((r) => r.toLowerCase());
  if (roles.includes('admin')) return 'admin';
  if (roles.includes('editor')) return 'editor';
  return 'viewer';
}

/** viewer: read only; editor: alerts, notes, dashboards; admin: everything (API keys, webhooks). */
export type Ability = 'edit' | 'admin';
export const can = (me: Me | undefined, ability: Ability) =>
  LEVEL[roleOf(me)] >= (ability === 'admin' ? LEVEL.admin : LEVEL.editor);

export function useCan(ability: Ability): boolean {
  const me = useMe();
  return can(me.data, ability);
}

/** Starts sign-in at Landbright, coming back to `returnTo`. */
export function signIn(returnTo = window.location.pathname + window.location.search): void {
  window.location.assign(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
}

export async function signOut(): Promise<void> {
  try {
    const body = await send<{ redirect?: string } | undefined>('POST', '/api/auth/logout');
    window.location.assign(body?.redirect ?? '/');
  } catch {
    window.location.assign('/');
  }
}
