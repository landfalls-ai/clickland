import { createHash } from 'node:crypto';
import type { Principal } from './auth.js';
import type { Sql } from './clients.js';
import type { Config } from './config.js';
import { ApiError } from './errors.js';
import { newId } from './ids.js';
import { type Identity, type OidcClient, pkcePair, randomToken } from './oidc.js';
import { type Role, roleFromGroups, SCOPES_BY_ROLE } from './roles.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const LOGIN_TTL_S = 600;

/** Why a sign-in came back to the console without a session (`/?signin_error=<code>`). */
export type SignInError = 'no_role' | 'inactive' | 'expired' | 'denied' | 'failed' | 'unavailable';

/**
 * A person's groups: SCIM's memberships once SCIM has set this person's groups (`scim_groups_at`), else the `roles`
 * claim from their last sign-in. A SQL expression over `u` (users).
 */
import type { TransactionSql } from 'postgres';
type Tx = Sql | TransactionSql;
export const effectiveGroups = (sql: Tx) => sql`
  CASE WHEN u.scim_groups_at IS NOT NULL THEN coalesce((
    SELECT array_agg(g.display_name ORDER BY g.display_name)
    FROM group_members m JOIN groups g ON g.id = m.group_id WHERE m.user_id = u.id), '{}')
  ELSE u.groups_claim END`;

/** Ends every console session of a person at once (SCIM deactivation, deletion). */
export async function endSessions(sql: Tx, userId: string): Promise<number> {
  const rows = await sql`DELETE FROM sessions WHERE user_id = ${userId}`;
  return rows.count;
}

/** Only a path on this site: `/x?y`, never `//host` or a full URL. */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\'))
    return '/';
  return value.slice(0, 2000);
}

interface PersonRow {
  id: string;
  email: string | null;
  user_name: string;
  display_name: string | null;
  groups: string[];
}

/** The principal of a person: their email names them; their role (from their groups) gives the scopes. */
export function personPrincipal(row: PersonRow, role: Role, sessionId: string): Principal {
  const email = row.email ?? row.user_name;
  return {
    name: email,
    scopes: SCOPES_BY_ROLE[role],
    person: {
      id: row.id,
      email,
      displayName: row.display_name ?? email,
      role,
      groups: row.groups,
      sessionId,
    },
  };
}

/**
 * Console sessions: sign-in through Landbright, then a random token in an httpOnly cookie. Postgres keeps its sha256.
 * The role is worked out on every request from the person's groups, so a SCIM group change applies on the next one.
 */
export class Sessions {
  constructor(
    private readonly sql: Sql,
    private readonly config: Config,
    private readonly oidc: OidcClient | null,
  ) {}

  get available(): boolean {
    return this.oidc !== null;
  }

  private client(): OidcClient {
    if (!this.oidc)
      throw new ApiError('unavailable', `Sign-in with Landbright isn't set up: ${this.config.oidcProblem}`);
    return this.oidc;
  }

  async startLogin(returnTo: string): Promise<{ url: string; state: string }> {
    const oidc = this.client();
    const state = randomToken(24);
    const nonce = randomToken(24);
    const { verifier, challenge } = pkcePair();
    await this.sql`
      INSERT INTO auth_requests (state_hash, code_verifier, nonce, return_to, expires_at)
      VALUES (${sha256(state)}, ${verifier}, ${nonce}, ${returnTo}, now() + make_interval(secs => ${LOGIN_TTL_S}))`;
    return { url: await oidc.authorizationUrl({ state, nonce, challenge }), state };
  }

  /** The callback: checks the state (and that this browser started it), signs in, reconciles the user, opens a session. */
  async finishLogin(input: {
    state: string;
    code: string;
    iss?: string;
    browserState?: string;
    userAgent?: string;
  }): Promise<
    { token: string; returnTo: string; userId: string; role: Role } | { error: SignInError; returnTo: string }
  > {
    const oidc = this.client();
    const [pending] = await this.sql<{ code_verifier: string; nonce: string; return_to: string; live: boolean }[]>`
      DELETE FROM auth_requests WHERE state_hash = ${sha256(input.state)}
      RETURNING code_verifier, nonce, return_to, expires_at > now() AS live`;
    if (!pending || !pending.live || input.browserState !== input.state) return { error: 'expired', returnTo: '/' };
    if (input.iss !== undefined && input.iss !== oidc.config.issuer) return { error: 'failed', returnTo: '/' };
    const identity = await oidc.signIn({ code: input.code, verifier: pending.code_verifier, nonce: pending.nonce });
    const result = await this.reconcile(identity, input.userAgent);
    return 'error' in result ? { ...result, returnTo: pending.return_to } : { ...result, returnTo: pending.return_to };
  }

  /**
   * Finds the person by `sub` (else by email, when no sub is on file: a SCIM user who hasn't signed in yet), creates them
   * just in time if needed, records the groups claim, and opens a session if they are active and have a role. SCIM owns
   * the profile once it has spoken (`scim_managed`), and the groups once it has set them (`scim_groups_at`).
   */
  async reconcile(
    identity: Identity,
    userAgent?: string,
  ): Promise<{ token: string; userId: string; role: Role } | { error: 'no_role' | 'inactive' | 'failed' }> {
    const token = randomToken(32);
    const refused = Symbol('refused');
    let error: 'no_role' | 'inactive' | 'failed' = 'failed';
    try {
      return await this.sql.begin(async (tx) => {
        const email = identity.email;
        let [user] = await tx<{ id: string; scim_managed: boolean }[]>`
          SELECT id, scim_managed FROM users WHERE external_id = ${identity.subject} FOR UPDATE`;
        if (!user && email) {
          const [byEmail] = await tx<{ id: string; scim_managed: boolean; external_id: string | null }[]>`
            SELECT id, scim_managed, external_id FROM users WHERE lower(user_name) = lower(${email}) FOR UPDATE`;
          if (byEmail?.external_id) {
            error = 'failed'; // the same email belongs to another Landbright subject
            throw refused;
          }
          if (byEmail) {
            await tx`UPDATE users SET external_id = ${identity.subject} WHERE id = ${byEmail.id}`;
            user = byEmail;
          }
        }
        if (!user) {
          [user] = await tx<{ id: string; scim_managed: boolean }[]>`
            INSERT INTO users (id, external_id, user_name, display_name, given_name, family_name, email)
            VALUES (${newId('usr')}, ${identity.subject}, ${email ?? identity.subject}, ${identity.name},
                    ${identity.givenName}, ${identity.familyName}, ${email})
            RETURNING id, scim_managed`;
        } else if (!user.scim_managed) {
          await tx`
            UPDATE users SET user_name = ${email ?? identity.subject}, email = ${email}, display_name = ${identity.name},
              given_name = ${identity.givenName}, family_name = ${identity.familyName}, updated_at = now()
            WHERE id = ${user.id}`;
        }
        const [row] = await tx<(PersonRow & { active: boolean })[]>`
          UPDATE users u SET groups_claim = ${identity.groups}, last_sign_in_at = now()
          WHERE u.id = ${user!.id}
          RETURNING u.id, u.email, u.user_name, u.display_name, u.active, ${effectiveGroups(tx)} AS groups`;
        if (!row!.active) {
          error = 'inactive';
          throw refused;
        }
        const role = roleFromGroups(row!.groups);
        if (!role) {
          error = 'no_role';
          throw refused;
        }
        await tx`
          INSERT INTO sessions (id, user_id, expires_at, id_token, user_agent)
          VALUES (${sha256(token)}, ${row!.id}, now() + make_interval(hours => ${this.config.sessionHours}),
                  ${identity.idToken}, ${userAgent?.slice(0, 300) ?? null})`;
        return { token, userId: row!.id, role };
      });
    } catch (e) {
      if (e === refused) return { error };
      throw e;
    }
  }

  /** The person behind a session cookie, or why there is none. Active people with a role only. */
  async principal(token: string): Promise<{ principal: Principal } | { reason: 'none' | 'no_role' }> {
    const id = sha256(token);
    const [row] = await this.sql<PersonRow[]>`
      WITH s AS (
        UPDATE sessions SET last_seen_at = now()
        WHERE id = ${id} AND expires_at > now()
        RETURNING user_id)
      SELECT u.id, u.email, u.user_name, u.display_name, ${effectiveGroups(this.sql)} AS groups
      FROM s JOIN users u ON u.id = s.user_id
      WHERE u.active`;
    if (!row) return { reason: 'none' };
    const role = roleFromGroups(row.groups);
    if (!role) return { reason: 'no_role' };
    return { principal: personPrincipal(row, role, id) };
  }

  /** Ends the session here; returns where to send the browser so Landbright ends its session too. */
  async logout(token: string | undefined): Promise<string> {
    let idToken: string | null = null;
    if (token) {
      const [row] = await this.sql<{ id_token: string | null }[]>`
        DELETE FROM sessions WHERE id = ${sha256(token)} RETURNING id_token`;
      idToken = row?.id_token ?? null;
    }
    return (await this.oidc?.endSessionUrl(idToken)) ?? this.oidc?.config.postLogoutRedirectUri ?? '/';
  }

  /** Forgets sign-ins that never came back and expired sessions. */
  async cleanup(): Promise<number> {
    const a = await this.sql`DELETE FROM auth_requests WHERE expires_at < now()`;
    const s = await this.sql`DELETE FROM sessions WHERE expires_at < now()`;
    return a.count + s.count;
  }
}
