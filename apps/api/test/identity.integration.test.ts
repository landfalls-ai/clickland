/**
 * Identity against the local Postgres (`pnpm dev:up && pnpm db:migrate`): a SCIM conformance-style suite in the forms
 * Landbright sends, and sign-in through a fake Landbright.
 *
 *   CLICKLAND_INTEGRATION=db pnpm --filter @clickland/api test:integration
 *
 * People and groups carry a per-run suffix and are removed afterwards. The three Clickland groups may already exist
 * (Landbright pushes them): the suite adopts them on 409 as Landbright does, never replaces their members, and deletes
 * only the groups it created.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createClients } from '../src/clients.js';
import { configFromEnv } from '../src/config.js';
import { SCHEMAS } from '../src/scim.js';
import { fakeLandbright, ISSUER, oidcConfig, type Person } from './fake-oidc.js';
import { scopedServices } from './scoped.js';

const enabled = (process.env.CLICKLAND_INTEGRATION ?? '').split(',').includes('db');
const BOOTSTRAP = 'ck_test_bootstrap_key_00000000000000';
const config = {
  ...configFromEnv({ CLICKLAND_AUTH: 'keys', CLICKLAND_BOOTSTRAP_KEY: BOOTSTRAP, CLICKLAND_OIDC_ENV_FILE: 'none' }),
  oidc: oidcConfig,
  oidcProblem: null,
  backgroundJobs: false,
};
const HOST = { host: 'localhost:4711' };
const run = Date.now().toString(36);
const email = (who: string) => `${who}-${run}@landbright.test`;

describe.skipIf(!enabled)('identity (live Postgres)', () => {
  const clients = createClients(config);
  let fake: Awaited<ReturnType<typeof fakeLandbright>>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let token = '';
  let tokenId = '';
  /** The groups that were there before this run; the ones it made (by name too) go afterwards. */
  let groupsBefore: string[] = [];

  beforeAll(async () => {
    groupsBefore = (await clients.pg<{ id: string }[]>`SELECT id FROM groups`).map((g) => g.id);
    fake = await fakeLandbright();
    const fetchImpl: typeof fetch = (input, init) => fake.fetchImpl(input, init);
    const services = scopedServices(config, clients);
    // Landbright is the fake.
    const { Sessions } = await import('../src/identity.js');
    const { OidcClient } = await import('../src/oidc.js');
    services.sessions = new Sessions(clients.pg, config, new OidcClient(oidcConfig, fetchImpl));
    app = await buildApp(services, { viewHtmlPath: '/nonexistent' });
    const minted = await services.scimTokens.create(`test ${run}`);
    token = minted.token;
    tokenId = minted.id;
  });

  afterAll(async () => {
    await clients.pg`DELETE FROM users WHERE user_name LIKE ${`%-${run}@landbright.test`}`;
    // Landbright's own groups always carry an externalId; the run's carry none (made by name) or its test- prefix.
    await clients.pg`
      DELETE FROM groups WHERE NOT (id = ANY(${groupsBefore}))
        AND (external_id IS NULL OR external_id LIKE ${`test-${run}-%`})`;
    await clients.pg`DELETE FROM scim_tokens WHERE id = ${tokenId}`;
    await app.close();
    await clients.close();
  });

  const scim = (
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    payload?: unknown,
    type = 'application/scim+json',
  ) =>
    app.inject({
      method,
      url: `/scim/v2${url}`,
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload === undefined ? {} : { 'content-type': type }),
      },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
  const patch = (Operations: unknown[]) => ({ schemas: [SCHEMAS.patch], Operations });

  /** What Landbright sends for a person. */
  const userBody = (who: string, sub: string, given: string, family: string) => ({
    schemas: [SCHEMAS.user],
    userName: email(who),
    externalId: sub,
    displayName: `${given} ${family}`,
    name: { givenName: given, familyName: family, formatted: `${given} ${family}` },
    emails: [{ value: email(who), type: 'work', primary: true }],
    active: true,
  });

  /** POST /Groups; on 409, GET by displayName (Landbright's adoption). */
  async function ensureGroup(displayName: string, members: string[] = []): Promise<string> {
    const res = await scim('POST', '/Groups', {
      schemas: [SCHEMAS.group],
      displayName,
      externalId: `test-${run}-${displayName}`,
      members: members.map((value) => ({ value })),
    });
    if (res.statusCode === 201) return res.json().id;
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ schemas: [SCHEMAS.error], status: '409', scimType: 'uniqueness' });
    const found = await scim('GET', `/Groups?filter=${encodeURIComponent(`displayName eq "${displayName}"`)}`);
    const id = found.json().Resources[0].id as string;
    if (members.length)
      await scim(
        'PATCH',
        `/Groups/${id}`,
        patch([{ op: 'add', path: 'members', value: members.map((value) => ({ value })) }]),
      );
    return id;
  }

  /** A person signs in through the fake Landbright the way a browser does: the session cookie, or the error. */
  async function signIn(person: Person): Promise<{ cookie?: string; location: string }> {
    const login = await app.inject({ url: '/api/auth/login?returnTo=/alerts', headers: HOST });
    expect(login.statusCode).toBe(302);
    const state = login.cookies.find((c) => c.name === 'cl_login')!.value;
    const q = fake.authorize(login.headers.location as string, person);
    const cb = await app.inject({
      url: `/api/auth/oidc/callback?${new URLSearchParams(q)}`,
      headers: HOST,
      cookies: { cl_login: state },
    });
    expect(cb.statusCode).toBe(302);
    return {
      cookie: cb.cookies.find((c) => c.name === 'cl_session' && c.value)?.value,
      location: cb.headers.location as string,
    };
  }
  const me = (cookie: string) => app.inject({ url: '/api/auth/me', cookies: { cl_session: cookie } });
  const as = (cookie: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      cookies: { cl_session: cookie },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  it('answers the discovery endpoints', async () => {
    const spc = await scim('GET', '/ServiceProviderConfig');
    expect(spc.statusCode).toBe(200);
    expect(spc.headers['content-type']).toMatch(/^application\/scim\+json/);
    expect(spc.json()).toMatchObject({
      patch: { supported: true },
      filter: { supported: true },
      bulk: { supported: false },
    });
    const types = (await scim('GET', '/ResourceTypes')).json();
    expect(types.Resources.map((t: { id: string }) => t.id)).toEqual(['User', 'Group']);
    expect((await scim('GET', '/ResourceTypes/User')).json().endpoint).toBe('/Users');
    const schemas = (await scim('GET', '/Schemas')).json();
    expect(schemas.totalResults).toBe(2);
    expect((await scim('GET', `/Schemas/${SCHEMAS.group}`)).json().name).toBe('Group');
    const missing = await scim('GET', '/Nope');
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ schemas: [SCHEMAS.error], status: '404' });
  });

  it('creates a user (application/json too), then 409, then filter, then adopt with a pathless PATCH', async () => {
    const created = await scim(
      'POST',
      '/Users',
      userBody('maya', `sub-maya-${run}`, 'Maya', 'Cohen'),
      'application/json',
    );
    expect(created.statusCode).toBe(201);
    const user = created.json();
    expect(created.headers.location).toBe(`http://localhost:80/scim/v2/Users/${user.id}`);
    expect(user).toMatchObject({
      schemas: [SCHEMAS.user],
      userName: email('maya'),
      externalId: `sub-maya-${run}`,
      displayName: 'Maya Cohen',
      name: { givenName: 'Maya', familyName: 'Cohen', formatted: 'Maya Cohen' },
      emails: [{ value: email('maya'), type: 'work', primary: true }],
      active: true,
      groups: [],
      meta: { resourceType: 'User' },
    });

    const again = await scim('POST', '/Users', userBody('maya', `sub-maya-${run}`, 'Maya', 'Cohen'));
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({
      schemas: [SCHEMAS.error],
      status: '409',
      scimType: 'uniqueness',
      detail: expect.any(String),
    });

    const found = await scim(
      'GET',
      `/Users?filter=${encodeURIComponent(`userName eq "${email('maya').toUpperCase()}"`)}`,
    );
    expect(found.json()).toMatchObject({ schemas: [SCHEMAS.list], totalResults: 1, startIndex: 1, itemsPerPage: 1 });
    expect(found.json().Resources[0].id).toBe(user.id);

    const adopted = await scim(
      'PATCH',
      `/Users/${user.id}`,
      patch([
        {
          op: 'replace',
          value: {
            userName: email('maya'),
            displayName: 'Maya C.',
            externalId: `sub-maya2-${run}`,
            name: { givenName: 'Maya', familyName: 'C.' },
          },
        },
      ]),
    );
    expect(adopted.statusCode).toBe(200);
    expect(adopted.json()).toMatchObject({
      displayName: 'Maya C.',
      externalId: `sub-maya2-${run}`,
      name: { familyName: 'C.' },
    });
    for (const filter of [`externalId eq "sub-maya2-${run}"`, 'displayName eq "maya c."']) {
      const byFilter = await scim('GET', `/Users?filter=${encodeURIComponent(filter)}`);
      expect(byFilter.json().Resources.map((u: { id: string }) => u.id)).toContain(user.id);
    }
    expect((await scim('GET', `/Users?filter=${encodeURIComponent('title eq "x"')}`)).json()).toMatchObject({
      status: '400',
      scimType: 'invalidFilter',
    });
    const gone = await scim('PATCH', '/Users/usr_missing', patch([{ op: 'replace', path: 'active', value: false }]));
    expect(gone.statusCode).toBe(404);
    expect(gone.json()).toMatchObject({ schemas: [SCHEMAS.error], status: '404' });
  });

  it('signs a person in just in time, then SCIM adopts them by email and takes over their profile', async () => {
    const yoav: Person = {
      sub: `sub-yoav-${run}`,
      email: email('yoav'),
      name: 'Yoav Ben David',
      roles: ['Clickland Viewers', 'Everyone'],
    };
    const { cookie, location } = await signIn(yoav);
    expect(location).toBe('/alerts');
    const who = (await me(cookie!)).json();
    expect(who).toMatchObject({
      kind: 'person',
      role: 'viewer',
      authMode: 'oidc',
      user: { email: email('yoav'), name: 'Yoav Ben David' },
    });
    expect(who.scopes).toEqual(['read']);

    // Landbright pushes the same person: 409, filter, adopt.
    expect((await scim('POST', '/Users', userBody('yoav', yoav.sub, 'Yoav', 'Ben David'))).statusCode).toBe(409);
    const id = (await scim('GET', `/Users?filter=${encodeURIComponent(`userName eq "${email('yoav')}"`)}`)).json()
      .Resources[0].id;
    expect(id).toBe(who.user.id);
    await scim(
      'PATCH',
      `/Users/${id}`,
      patch([{ op: 'replace', value: { displayName: 'Yoav B.D.', externalId: yoav.sub } }]),
    );
    // The next sign-in doesn't overwrite what SCIM said.
    const second = await signIn({ ...yoav, name: 'Someone Else' });
    expect((await me(second.cookie!)).json().user.name).toBe('Yoav B.D.');
  });

  it('ends every session of a deactivated person at once, and refuses their sign-in until reactivated', async () => {
    const eden: Person = {
      sub: `sub-eden-${run}`,
      email: email('eden'),
      name: 'Eden Tzur',
      roles: ['Clickland Editors'],
    };
    const created = (await scim('POST', '/Users', userBody('eden', eden.sub, 'Eden', 'Tzur'))).json();
    const a = await signIn(eden);
    const b = await signIn(eden);
    expect((await as(a.cookie!, 'GET', '/api/alerts')).statusCode).toBe(200);
    const [{ n }] = await clients.pg<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM sessions WHERE user_id = ${created.id}`;
    expect(n).toBe(2);

    const off = await scim('PATCH', `/Users/${created.id}`, patch([{ op: 'replace', path: 'active', value: false }]));
    expect(off.json().active).toBe(false);
    const [{ left }] = await clients.pg<
      { left: number }[]
    >`SELECT count(*)::int AS left FROM sessions WHERE user_id = ${created.id}`;
    expect(left).toBe(0);
    for (const c of [a.cookie!, b.cookie!]) {
      expect((await as(c, 'GET', '/api/alerts')).statusCode).toBe(401);
      expect((await me(c)).statusCode).toBe(401);
    }
    expect((await signIn(eden)).location).toBe('/alerts?signin_error=inactive');

    await scim('PATCH', `/Users/${created.id}`, patch([{ op: 'Replace', path: 'active', value: 'True' }]));
    const back = await signIn(eden);
    expect((await me(back.cookie!)).json().role).toBe('editor');
  });

  it('changes the role on the next request when SCIM changes group membership (SCIM wins over the claim)', async () => {
    const shira: Person = {
      sub: `sub-shira-${run}`,
      email: email('shira'),
      name: 'Shira Navon',
      roles: ['Clickland Viewers'],
    };
    const user = (await scim('POST', '/Users', userBody('shira', shira.sub, 'Shira', 'Navon'))).json();
    const { cookie } = await signIn(shira);
    expect((await me(cookie!)).json().role).toBe('viewer'); // the claim, until SCIM sets groups
    expect((await as(cookie!, 'POST', '/api/alerts', {})).statusCode).toBe(403);

    const editors = await ensureGroup('Clickland Editors', [user.id]);
    expect((await me(cookie!)).json().role).toBe('editor');
    expect((await as(cookie!, 'POST', '/api/alerts', {})).statusCode).toBe(400); // allowed; the body is wrong
    expect((await as(cookie!, 'GET', '/api/keys')).statusCode).toBe(403);
    const shown = (await scim('GET', `/Groups/${editors}`)).json();
    expect(shown.members.map((m: { value: string }) => m.value)).toContain(user.id);
    expect((await scim('GET', `/Users/${user.id}`)).json().groups).toEqual([
      expect.objectContaining({ value: editors, display: 'Clickland Editors' }),
    ]);

    const admins = await ensureGroup('Clickland Admins');
    await scim('PATCH', `/Groups/${admins}`, patch([{ op: 'add', path: 'members', value: [{ value: user.id }] }]));
    expect((await me(cookie!)).json().role).toBe('admin');
    expect((await as(cookie!, 'GET', '/api/keys')).statusCode).toBe(200);

    for (const g of [admins, editors])
      await scim('PATCH', `/Groups/${g}`, patch([{ op: 'remove', path: `members[value eq "${user.id}"]` }]));
    // SCIM has spoken: no Clickland group now, even though the claim still says viewer.
    const refused = await me(cookie!);
    expect(refused.statusCode).toBe(401);
    expect(refused.json().error.details.reason).toBe('no_role');
    expect((await signIn(shira)).location).toBe('/alerts?signin_error=no_role');
  });

  it('accepts the groups replace form on a user (names), and member add/remove and rename on a group', async () => {
    const tal = (await scim('POST', '/Users', userBody('tal', `sub-tal-${run}`, 'Tal', 'Levi'))).json();
    const res = await scim(
      'PATCH',
      `/Users/${tal.id}`,
      patch([
        {
          op: 'replace',
          path: 'groups',
          value: [
            { value: 'Clickland Viewers', display: 'Clickland Viewers' },
            { value: `Team ${run}`, display: `Team ${run}` },
          ],
        },
      ]),
    );
    expect(res.statusCode).toBe(200);
    expect(
      res
        .json()
        .groups.map((g: { display: string }) => g.display)
        .sort(),
    ).toEqual(['Clickland Viewers', `Team ${run}`]);
    const { cookie } = await signIn({
      sub: `sub-tal-${run}`,
      email: email('tal'),
      name: 'Tal',
      roles: ['Clickland Admins'],
    });
    expect((await me(cookie!)).json().role).toBe('viewer');

    // Replace again with one group: the other membership goes.
    const again = await scim(
      'PATCH',
      `/Users/${tal.id}`,
      patch([{ op: 'replace', path: 'groups', value: [{ value: `Team ${run}`, display: `Team ${run}` }] }]),
    );
    expect(again.json().groups.map((g: { display: string }) => g.display)).toEqual([`Team ${run}`]);

    // A group of its own: rename, replace members, remove all.
    const team = (await scim('GET', `/Groups?filter=${encodeURIComponent(`displayName eq "Team ${run}"`)}`)).json()
      .Resources[0];
    const renamed = await scim(
      'PATCH',
      `/Groups/${team.id}`,
      patch([{ op: 'replace', path: 'displayName', value: `Renamed ${run}` }]),
    );
    expect(renamed.json()).toMatchObject({
      displayName: `Renamed ${run}`,
      members: [expect.objectContaining({ value: tal.id })],
    });
    const pathless = await scim(
      'PATCH',
      `/Groups/${team.id}`,
      patch([{ op: 'replace', value: { displayName: `Team ${run}` } }]),
    );
    expect(pathless.json().displayName).toBe(`Team ${run}`);
    const emptied = await scim('PATCH', `/Groups/${team.id}`, patch([{ op: 'remove', path: 'members' }]));
    expect(emptied.json().members).toEqual([]);
    const unknown = await scim(
      'PATCH',
      `/Groups/${team.id}`,
      patch([{ op: 'add', path: 'members', value: [{ value: 'usr_nobody' }] }]),
    );
    expect(unknown.json()).toMatchObject({ status: '400', scimType: 'invalidValue' });
    const noMembers = await scim('GET', `/Groups/${team.id}?excludedAttributes=members`);
    expect(noMembers.json().members).toBeUndefined();
  });

  it('deletes a group, and its members lose what it gave them', async () => {
    const yael = (await scim('POST', '/Users', userBody('yael', `sub-yael-${run}`, 'Yael', 'Test'))).json();
    const group = await ensureGroup(`Doomed ${run}`, [yael.id]);
    expect((await scim('GET', `/Users/${yael.id}`)).json().groups).toHaveLength(1);
    expect((await scim('POST', '/Groups', { displayName: `doomed ${run}` })).statusCode).toBe(409);
    const del = await scim('DELETE', `/Groups/${group}`);
    expect(del.statusCode).toBe(204);
    expect((await scim('GET', `/Groups/${group}`)).statusCode).toBe(404);
    expect((await scim('DELETE', `/Groups/${group}`)).statusCode).toBe(404);
    expect((await scim('GET', `/Users/${yael.id}`)).json().groups).toEqual([]);
  });

  it('refuses someone in no Clickland group without creating them, and keeps keys working beside sessions', async () => {
    const outsider: Person = {
      sub: `sub-out-${run}`,
      email: email('outsider'),
      name: 'Out Sider',
      roles: ['Everyone'],
    };
    expect((await signIn(outsider)).location).toBe('/alerts?signin_error=no_role');
    const [row] = await clients.pg`SELECT id FROM users WHERE external_id = ${outsider.sub}`;
    expect(row).toBeUndefined();

    // A key still works, and wins over a cookie.
    const viewer = await signIn({
      sub: `sub-v-${run}`,
      email: email('viewer'),
      name: 'V',
      roles: ['Clickland Viewers'],
    });
    const key = await app.inject({
      url: '/api/keys',
      headers: { authorization: `Bearer ${BOOTSTRAP}` },
      cookies: { cl_session: viewer.cookie! },
    });
    expect(key.statusCode).toBe(200);
    // No key, no session, no dev bypass: 401.
    expect((await app.inject({ url: '/api/alerts' })).statusCode).toBe(401);
  });

  it('checks the state cookie, passes Landbright’s refusals on, and signs out through Landbright', async () => {
    const login = await app.inject({ url: '/api/auth/login', headers: HOST });
    const q = fake.authorize(login.headers.location as string, {
      sub: `sub-x-${run}`,
      email: email('x'),
      roles: ['Clickland Viewers'],
    });
    const foreign = await app.inject({ url: `/api/auth/oidc/callback?${new URLSearchParams(q)}`, headers: HOST });
    expect(foreign.headers.location).toBe('/?signin_error=expired');
    const denied = await app.inject({ url: '/api/auth/oidc/callback?error=access_denied', headers: HOST });
    expect(denied.headers.location).toBe('/?signin_error=denied');
    const wrongIss = await app.inject({
      url: `/api/auth/login`,
      headers: HOST,
    });
    const q2 = fake.authorize(wrongIss.headers.location as string, {
      sub: `sub-x-${run}`,
      roles: ['Clickland Viewers'],
    });
    const bad = await app.inject({
      url: `/api/auth/oidc/callback?${new URLSearchParams({ ...q2, iss: 'http://evil.test' })}`,
      headers: HOST,
      cookies: { cl_login: wrongIss.cookies.find((c) => c.name === 'cl_login')!.value },
    });
    expect(bad.headers.location).toBe('/?signin_error=failed');

    const { cookie } = await signIn({
      sub: `sub-out2-${run}`,
      email: email('leaver'),
      name: 'Leaver',
      roles: ['Clickland Viewers'],
    });
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', cookies: { cl_session: cookie! } });
    const redirect = new URL(out.json().redirect);
    expect(redirect.origin + redirect.pathname).toBe(`${ISSUER}/session/end`);
    expect(redirect.searchParams.get('post_logout_redirect_uri')).toBe('http://localhost:4711/');
    expect(redirect.searchParams.get('id_token_hint')).toBeTruthy();
    expect(out.cookies.find((c) => c.name === 'cl_session')?.value).toBe('');
    expect((await me(cookie!)).statusCode).toBe(401);
  });
});
