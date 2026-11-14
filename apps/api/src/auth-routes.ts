import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate } from './auth.js';
import { ApiError } from './errors.js';
import { safeReturnTo, type SignInError } from './identity.js';
import { roleFromScopes } from './roles.js';
import type { Services } from './services.js';

export const SESSION_COOKIE = 'cl_session';
const LOGIN_COOKIE = 'cl_login';
const LOGIN_TTL_S = 600;

const Callback = z.object({
  code: z.string().min(1).max(2000).optional(),
  state: z.string().min(1).max(500).optional(),
  iss: z.string().max(500).optional(),
  error: z.string().max(200).optional(),
});

/** The routes the onRequest hook lets through: each checks what it needs. */
export const AUTH_PUBLIC = ['/api/auth/login', '/api/auth/oidc/callback', '/api/auth/logout', '/api/auth/me'];

/**
 * Sign-in through Landbright: `login` sends the browser to Landbright, `oidc/callback` opens a session, `logout` ends it
 * (and returns Landbright's end-session URL), `me` says who is signed in.
 */
export function registerAuthRoutes(app: FastifyInstance, services: Services): void {
  const { config, sessions } = services;
  const cookieBase = { httpOnly: true, sameSite: 'lax' as const, secure: false, path: '/' };
  const redirectOrigin = config.oidc ? new URL(config.oidc.redirectUri) : null;
  if (redirectOrigin?.protocol === 'https:') cookieBase.secure = true;

  const backToConsole = (reply: FastifyReply, error: SignInError, returnTo = '/') =>
    reply
      .clearCookie(LOGIN_COOKIE, { ...cookieBase, path: '/api/auth' })
      .redirect(`${returnTo}${returnTo.includes('?') ? '&' : '?'}signin_error=${error}`);

  app.get('/api/auth/login', async (request, reply) => {
    const returnTo = safeReturnTo((request.query as { returnTo?: unknown }).returnTo);
    // The login cookie must be set on the host Landbright sends the browser back to (localhost, not 127.0.0.1).
    if (redirectOrigin && request.headers.host !== redirectOrigin.host)
      return reply.redirect(`${redirectOrigin.origin}/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
    try {
      const { url, state } = await sessions.startLogin(returnTo);
      return reply
        .setCookie(LOGIN_COOKIE, state, { ...cookieBase, path: '/api/auth', maxAge: LOGIN_TTL_S })
        .redirect(url);
    } catch (error) {
      request.log.warn({ err: error }, 'sign-in could not start');
      return backToConsole(reply, 'unavailable', returnTo);
    }
  });

  app.get('/api/auth/oidc/callback', async (request, reply) => {
    const parsed = Callback.safeParse(request.query);
    if (!parsed.success) return backToConsole(reply, 'failed');
    const q = parsed.data;
    if (q.error) return backToConsole(reply, q.error === 'access_denied' ? 'denied' : 'failed');
    if (!q.code || !q.state) return backToConsole(reply, 'failed');
    try {
      const result = await sessions.finishLogin({
        state: q.state,
        code: q.code,
        iss: q.iss,
        browserState: request.cookies[LOGIN_COOKIE],
        userAgent: request.headers['user-agent'],
      });
      if ('error' in result) return backToConsole(reply, result.error, result.returnTo);
      return reply
        .clearCookie(LOGIN_COOKIE, { ...cookieBase, path: '/api/auth' })
        .setCookie(SESSION_COOKIE, result.token, { ...cookieBase, maxAge: config.sessionHours * 3600 })
        .redirect(result.returnTo);
    } catch (error) {
      request.log.warn({ err: error }, 'sign-in failed');
      return backToConsole(reply, error instanceof ApiError && error.code === 'unavailable' ? 'unavailable' : 'failed');
    }
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const redirect = await sessions.logout(request.cookies[SESSION_COOKIE]);
    return reply.clearCookie(SESSION_COOKIE, cookieBase).send({ redirect });
  });

  app.get('/api/auth/me', async (request: FastifyRequest) => {
    const authorization = request.headers.authorization;
    const token = request.cookies[SESSION_COOKIE];
    if (!authorization && token) {
      const found = await sessions.principal(token);
      if ('principal' in found) {
        const p = found.principal.person!;
        return {
          kind: 'person',
          user: { id: p.id, name: p.displayName, email: p.email, roles: [p.role], groups: p.groups },
          role: p.role,
          scopes: found.principal.scopes,
          authMode: 'oidc',
        };
      }
      if (found.reason === 'no_role') throw signInNeeded('no_role');
    }
    if (!authorization && config.authMode !== 'dev') throw signInNeeded();
    const principal = await authenticate(services.clients.pg, config, authorization);
    const role = roleFromScopes(principal.scopes);
    return {
      kind: principal.name === 'dev' ? 'dev' : principal.name === 'bootstrap' ? 'bootstrap' : 'key',
      user: {
        id: principal.name,
        name: principal.name === 'dev' ? 'Local developer' : principal.name,
        email: null,
        roles: [role],
        groups: [],
      },
      role,
      scopes: principal.scopes,
      authMode: config.authMode,
    };
  });

  function signInNeeded(reason?: 'no_role') {
    return new ApiError(
      'unauthorized',
      reason === 'no_role' ? 'You are signed in, but not in a Clickland group' : 'Sign in with Landbright',
      {
        signIn: sessions.available ? 'available' : 'unavailable',
        ...(reason ? { reason } : {}),
        ...(config.oidcProblem ? { problem: config.oidcProblem } : {}),
      },
    );
  }
}
