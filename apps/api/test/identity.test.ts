import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { requireScope } from '../src/auth.js';
import { createClients } from '../src/clients.js';
import { configFromEnv } from '../src/config.js';
import { personPrincipal, safeReturnTo } from '../src/identity.js';
import { groupsFromClaims, OidcClient, pkcePair } from '../src/oidc.js';
import { roleFromGroups, roleFromScopes, SCOPES_BY_ROLE } from '../src/roles.js';
import { parseFilter, parseValuePath, patchOps, ScimError, SCHEMAS } from '../src/scim.js';
import { createServices } from '../src/services.js';
import { fakeLandbright, ISSUER, oidcConfig } from './fake-oidc.js';

describe('roles', () => {
  it('maps the three Clickland groups, without case, and ignores the rest', () => {
    expect(roleFromGroups(['Clickland Viewers'])).toBe('viewer');
    expect(roleFromGroups(['clickland editors', 'Everyone'])).toBe('editor');
    expect(roleFromGroups(['Everyone', 'Engineering'])).toBeNull();
    expect(roleFromGroups([])).toBeNull();
  });

  it('gives the strongest role when someone is in several groups', () => {
    expect(roleFromGroups(['Clickland Viewers', 'Clickland Admins', 'Clickland Editors'])).toBe('admin');
  });

  it('lets an editor change alerts, notes and dashboards, but not webhooks or keys', () => {
    const editor = personPrincipal(
      { id: 'usr_1', email: 'tal@x', user_name: 'tal@x', display_name: 'Tal', groups: ['Clickland Editors'] },
      'editor',
      's',
    );
    for (const scope of ['read', 'alerts:write', 'notes:write', 'views:write', 'usage:read'] as const)
      expect(() => requireScope(editor, scope)).not.toThrow();
    for (const scope of ['webhooks:write', 'admin'] as const)
      expect(() => requireScope(editor, scope)).toThrow(/scope/);
    expect(SCOPES_BY_ROLE.viewer).toEqual(['read']);
    expect(SCOPES_BY_ROLE.admin).toEqual(['admin']);
    expect(editor.name).toBe('tal@x');
  });

  it('reads a role back from a key’s scopes', () => {
    expect(roleFromScopes(['admin'])).toBe('admin');
    expect(roleFromScopes(['read', 'notes:write'])).toBe('editor');
    expect(roleFromScopes(['usage:read'])).toBe('viewer');
  });
});

describe('configuration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clickland-oidc-'));
  const file = join(dir, 'client.env');
  writeFileSync(
    file,
    'LANDBRIGHT_ISSUER=http://localhost:4402/oidc\nLANDBRIGHT_CLIENT_ID=clickland-local\nLANDBRIGHT_CLIENT_SECRET=s3\nLANDBRIGHT_TOKEN_ENDPOINT_AUTH_METHOD=client_secret_post\n',
  );
  chmodSync(file, 0o600);

  it('needs a key or a session by default; the dev bypass only when asked, and only on loopback', () => {
    expect(configFromEnv({ CLICKLAND_OIDC_ENV_FILE: 'none' }).authMode).toBe('keys');
    expect(configFromEnv({ CLICKLAND_AUTH: 'dev', CLICKLAND_OIDC_ENV_FILE: 'none' }).authMode).toBe('dev');
    expect(() => configFromEnv({ CLICKLAND_AUTH: 'dev', CLICKLAND_API_HOST: '0.0.0.0' })).toThrow(/this machine only/);
    expect(() => configFromEnv({ CLICKLAND_AUTH: 'open' })).toThrow(/keys/);
  });

  it('reads Landbright’s client file and builds the redirect URIs on localhost:4711', () => {
    const c = configFromEnv({ CLICKLAND_OIDC_ENV_FILE: file });
    expect(c.oidc).toEqual({
      issuer: 'http://localhost:4402/oidc',
      clientId: 'clickland-local',
      clientSecret: 's3',
      redirectUri: 'http://localhost:4711/api/auth/oidc/callback',
      postLogoutRedirectUri: 'http://localhost:4711/',
      scopes: 'openid email profile roles',
    });
    expect(c.oidcProblem).toBeNull();
  });

  it('says why sign-in is off: no file, or a client that wants another auth method', () => {
    const none = configFromEnv({ CLICKLAND_OIDC_ENV_FILE: join(dir, 'missing.env') });
    expect(none.oidc).toBeNull();
    expect(none.oidcProblem).toMatch(/doesn't exist yet/);
    const basic = join(dir, 'basic.env');
    writeFileSync(basic, 'LANDBRIGHT_CLIENT_SECRET=x\nLANDBRIGHT_TOKEN_ENDPOINT_AUTH_METHOD=client_secret_basic\n');
    expect(configFromEnv({ CLICKLAND_OIDC_ENV_FILE: basic }).oidcProblem).toMatch(/client_secret_basic/);
  });
});

describe('sign-in helpers', () => {
  it('keeps returnTo on this site', () => {
    expect(safeReturnTo('/alerts?x=1')).toBe('/alerts?x=1');
    for (const bad of ['//evil.test', 'https://evil.test', '/\\evil', 42, undefined])
      expect(safeReturnTo(bad)).toBe('/');
  });

  it('reads groups from roles, else groups', () => {
    expect(groupsFromClaims({ roles: ['A', 'A', 'B', 3] })).toEqual(['A', 'B']);
    expect(groupsFromClaims({ groups: ['C'] })).toEqual(['C']);
    expect(groupsFromClaims({})).toEqual([]);
  });

  it('makes an S256 PKCE pair', () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier).toMatch(/^[\w-]{43}$/);
    expect(challenge).toMatch(/^[\w-]{43}$/);
    expect(challenge).not.toBe(verifier);
  });
});

describe('OIDC against a fake Landbright', () => {
  const person = {
    sub: 'sub-tal',
    email: 'tal@landbright.test',
    name: 'Tal Levi',
    roles: ['Clickland Editors', 'Everyone'],
  };

  it('builds the authorization URL, exchanges the code with client_secret_post and PKCE, and fills claims from userinfo', async () => {
    const fake = await fakeLandbright();
    const client = new OidcClient(oidcConfig, fake.fetchImpl);
    const { verifier, challenge } = pkcePair();
    const url = new URL(await client.authorizationUrl({ state: 'st', nonce: 'n1', challenge }));
    expect(url.origin + url.pathname).toBe(`${ISSUER}/auth`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'clickland-local',
      redirect_uri: 'http://localhost:4711/api/auth/oidc/callback',
      scope: 'openid email profile roles',
      code_challenge_method: 'S256',
      code_challenge: challenge,
    });
    const { code } = fake.authorize(url.toString(), person);
    const identity = await client.signIn({ code, verifier, nonce: 'n1' });
    expect(identity).toMatchObject({
      subject: 'sub-tal',
      email: 'tal@landbright.test',
      name: 'Tal Levi',
      groups: ['Clickland Editors', 'Everyone'],
    });
    const token = fake.calls.find((c) => c.url.endsWith('/token'))!;
    expect(token.body).toContain('client_secret=test-secret-not-real');
    expect(token.body).toContain(`code_verifier=${verifier}`);
  });

  it('refuses a wrong nonce, a wrong verifier and a token for another client', async () => {
    const fake = await fakeLandbright();
    const client = new OidcClient(oidcConfig, fake.fetchImpl);
    const pair = pkcePair();
    const url = await client.authorizationUrl({ state: 's', nonce: 'right', challenge: pair.challenge });
    const a = fake.authorize(url, person);
    await expect(client.signIn({ code: a.code, verifier: pair.verifier, nonce: 'wrong' })).rejects.toThrow(/nonce/);
    const b = fake.authorize(url, person);
    await expect(client.signIn({ code: b.code, verifier: 'not-the-verifier', nonce: 'right' })).rejects.toThrow(
      /invalid_grant/,
    );

    const other = await fakeLandbright({ audience: 'someone-else' });
    const c2 = new OidcClient(oidcConfig, other.fetchImpl);
    const c = other.authorize(await c2.authorizationUrl({ state: 's', nonce: 'n', challenge: pair.challenge }), person);
    await expect(c2.signIn({ code: c.code, verifier: pair.verifier, nonce: 'n' })).rejects.toThrow(/aud/);
  });

  it('refuses an issuer that names itself differently, and builds the end-session URL', async () => {
    const liar = await fakeLandbright({ issuer: 'http://evil.test/oidc' });
    await expect(new OidcClient(oidcConfig, liar.fetchImpl).discovery()).rejects.toThrow(/issuer/);
    const fake = await fakeLandbright();
    const end = new URL((await new OidcClient(oidcConfig, fake.fetchImpl).endSessionUrl('idt'))!);
    expect(end.pathname).toBe('/oidc/session/end');
    expect(Object.fromEntries(end.searchParams)).toEqual({
      client_id: 'clickland-local',
      post_logout_redirect_uri: 'http://localhost:4711/',
      id_token_hint: 'idt',
    });
  });

  it('says Landbright is unavailable when it does not answer', async () => {
    const down: typeof fetch = async () => {
      throw new TypeError('connect ECONNREFUSED');
    };
    await expect(new OidcClient(oidcConfig, down).discovery()).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('SCIM parsing', () => {
  it('parses eq filters on the attributes it allows, without case on the name', () => {
    expect(parseFilter('userName eq "a@b.test"', ['userName', 'externalId'])).toEqual({
      attr: 'userName',
      value: 'a@b.test',
    });
    expect(parseFilter('USERNAME EQ "x\\"y"', ['userName'])).toEqual({ attr: 'userName', value: 'x"y' });
    expect(() => parseFilter('userName sw "a"', ['userName'])).toThrow(ScimError);
    expect(() => parseFilter('title eq "a"', ['userName'])).toThrow(/filters on userName/);
  });

  it('parses value paths', () => {
    expect(parseValuePath('members[value eq "usr_1"]')).toEqual({ attr: 'members', value: 'usr_1' });
    expect(parseValuePath('displayName')).toEqual({ attr: 'displayname', value: null });
  });

  it('reads PatchOp operations, ops without case, and refuses the rest', () => {
    expect(
      patchOps({ schemas: [SCHEMAS.patch], Operations: [{ op: 'Replace', path: 'active', value: false }] }),
    ).toEqual([{ op: 'replace', path: 'active', value: false }]);
    expect(() => patchOps({ Operations: [] })).toThrow(/non-empty/);
    expect(() => patchOps({ Operations: [{ op: 'move' }] })).toThrow(/Unknown op/);
    expect(() => patchOps({ schemas: ['x'], Operations: [{ op: 'add' }] })).toThrow(/PatchOp/);
  });
});

describe('routes without a database', () => {
  const config = {
    ...configFromEnv({ CLICKLAND_OIDC_ENV_FILE: 'none' }),
    backgroundJobs: false,
    oidc: oidcConfig,
    oidcProblem: null,
  };

  it('says "sign in with Landbright" when nobody is signed in, and SCIM wants its token in RFC 7644 form', async () => {
    const clients = createClients(config);
    const app = await buildApp(createServices(config, clients), { viewHtmlPath: '/nonexistent' });
    try {
      const me = await app.inject({ url: '/api/auth/me' });
      expect(me.statusCode).toBe(401);
      expect(me.json().error.details).toEqual({ signIn: 'available' });
      const search = await app.inject({ method: 'POST', url: '/api/search', payload: { signal: 'logs' } });
      expect(search.statusCode).toBe(401);

      const scim = await app.inject({ url: '/scim/v2/Users' });
      expect(scim.statusCode).toBe(401);
      expect(scim.headers['content-type']).toMatch(/^application\/scim\+json/);
      expect(scim.json()).toEqual({
        schemas: [SCHEMAS.error],
        status: '401',
        detail: expect.stringMatching(/SCIM token/),
      });
      const wrong = await app.inject({
        url: '/scim/v2/Users',
        headers: { authorization: 'Bearer ck_not_a_scim_token' },
      });
      expect(wrong.statusCode).toBe(401);
    } finally {
      await app.close();
      await clients.close();
    }
  });

  it('sends a sign-in that starts on 127.0.0.1 to localhost, where Landbright comes back', async () => {
    const clients = createClients(config);
    const app = await buildApp(createServices(config, clients), { viewHtmlPath: '/nonexistent' });
    try {
      const res = await app.inject({ url: '/api/auth/login?returnTo=/alerts', headers: { host: '127.0.0.1:4711' } });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('http://localhost:4711/api/auth/login?returnTo=%2Falerts');
    } finally {
      await app.close();
      await clients.close();
    }
  });
});
