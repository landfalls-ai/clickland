import { useQuery } from '@tanstack/react-query';
import { get, send } from './api';
import type { Me, Role } from './types';

/**
 * Who is signed in (GET /api/auth/me). A 401 is the sign-in page: its details say whether sign-in is available, and
 * `reason: "no_role"` when the person is signed in at Landbright but in no Clickland group.
 */
export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: () => get<Me>('/api/auth/me'), retry: false, staleTime: 60_000 });
}

/** The groups that give a role, as Landbright names them (docs/identity.md#roles). */
export const ROLE_GROUPS: Record<Role, string> = {
  admin: 'Clickland Admins',
  editor: 'Clickland Editors',
  viewer: 'Clickland Viewers',
};

/** Why a sign-in came back without a session (the API redirects to `?signin_error=<code>`). */
export const SIGN_IN_ERRORS: Record<string, string> = {
  no_role:
    'Your Landbright account isn’t in a Clickland group. Ask an admin to add you to Clickland Viewers, Clickland Editors or Clickland Admins.',
  inactive: 'Your Clickland access is turned off in Landbright. Ask an admin to turn it back on.',
  expired: 'That sign-in took too long or started in another browser. Try again.',
  denied: 'Landbright didn’t sign you in.',
  unavailable: 'Landbright isn’t answering. Try again in a moment.',
  failed: 'Sign-in didn’t complete. Try again.',
};

const LEVEL: Record<Role, number> = { viewer: 1, editor: 2, admin: 3 };

/** The strongest role among the user's roles. */
export function roleOf(me: Me | undefined): Role {
  if (me?.role) return me.role;
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
  const back = returnTo.replace(/[?&]signin_error=[^&]*/, '').replace(/^\/?$/, '/') || '/';
  window.location.assign(`/api/auth/login?returnTo=${encodeURIComponent(back)}`);
}

/** "Viewer · Landbright", "Admin · API key", "Admin · dev bypass". */
export function roleLine(me: Me): string {
  const role = roleOf(me);
  const label = role[0]!.toUpperCase() + role.slice(1);
  if (me.kind === 'dev' || me.authMode === 'dev') return `${label} · dev bypass`;
  if (me.kind === 'key' || me.kind === 'bootstrap') return `${label} · API key`;
  return label;
}

export async function signOut(): Promise<void> {
  try {
    const body = await send<{ redirect?: string } | undefined>('POST', '/api/auth/logout');
    window.location.assign(body?.redirect ?? '/');
  } catch {
    window.location.assign('/');
  }
}
