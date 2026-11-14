# Identity: sign-in, roles and SCIM

Landbright manages the people who use Clickland. They sign in to the console through Landbright (OIDC), and Landbright
pushes people and groups to Clickland over SCIM 2.0. Their Landbright groups decide their role. Machines (Landflow's
plugin, Landfall's Source Protocol connection, Landledger's usage reader) keep using API keys (`ck_…`).

| Piece | Where |
|---|---|
| Tables `users`, `groups`, `group_members`, `sessions`, `auth_requests`, `scim_tokens` | `libs/schema/migrations/postgres/0007_identity.sql` |
| The OIDC relying party | `apps/api/src/oidc.ts` |
| Sessions, sign-in reconciliation, the role on each request | `apps/api/src/identity.ts` |
| `/api/auth/*` | `apps/api/src/auth-routes.ts` |
| Groups → roles → scopes | `apps/api/src/roles.ts` |
| The SCIM server and its tokens | `apps/api/src/scim.ts`, `apps/api/src/cli.ts` |
| The sign-in page, the user chip, controls by role | `apps/console/src/components/shell/app-shell.tsx`, `sidebar.tsx`, `src/lib/auth.ts` |

## Sign-in

Clickland is an OIDC relying party of Landbright, in the same pattern as Landledger's:

- The client is `clickland-local` at the issuer `http://localhost:4402/oidc`, with the scopes `openid email profile
  roles`. Landbright puts group names in the `roles` claim.
- The flow is the authorization code flow with PKCE (S256). The client secret goes in the token request body
  (`client_secret_post`). The ID token is checked against the issuer's JWKS: issuer, audience, expiry and nonce. Claims
  the ID token lacks (email, name, roles) come from userinfo.
- The redirect URI is `http://localhost:4711/api/auth/oidc/callback`, and after sign-out Landbright sends the browser
  to `http://localhost:4711/`. A sign-in that starts on `127.0.0.1:4711` is first sent to `localhost:4711`, so the
  login cookie is on the host Landbright returns to.
- Sessions are Clickland's own. The cookie `cl_session` is httpOnly, SameSite=Lax, and lasts `CLICKLAND_SESSION_HOURS`
  (default 8). Postgres keeps only its sha256. Clickland asks for no refresh token: Landbright only issues one for
  `offline_access` with `prompt=consent`. When the session ends, the person signs in again.
- `POST /api/auth/logout` deletes the session row, clears the cookie and returns `{ "redirect" }`. The redirect is
  Landbright's end-session URL, with `id_token_hint` and `post_logout_redirect_uri`, so Landbright's session ends too.

The client comes from the file Landbright writes, `~/.config/land-family/clickland-local.env` (`LANDBRIGHT_ISSUER`,
`LANDBRIGHT_CLIENT_ID`, `LANDBRIGHT_CLIENT_SECRET`, `LANDBRIGHT_TOKEN_ENDPOINT_AUTH_METHOD`). `CLICKLAND_OIDC_*`
variables override it ([reference/api.md](reference/api.md#authentication)). Without a secret, sign-in is off, and
`/api/auth/me` says why (`details.signIn: "unavailable"`, `details.problem`).

### Who is calling

On every `/api/*` request, the API identifies the caller in this order:

1. **An `Authorization: Bearer` key** (`ck_…`, or the bootstrap key). A key always wins, even next to a cookie.
2. **The session cookie**: a person, with the role their groups give. The API works the role out on every request,
   so a group change applies on the next one.
3. **The dev bypass**, only with `CLICKLAND_AUTH=dev`, and only when the API listens on loopback. It is off by
   default (`CLICKLAND_AUTH=keys`). With it on, calls with neither a key nor a session act as a local admin.
4. Otherwise `401`.

`/v1` (Landfall's Source Protocol) and `/scim/v2` take only their own bearer tokens, never a cookie or the dev bypass.

## Roles

| Landbright group | Role | Scopes |
|---|---|---|
| Clickland Admins | admin | `admin`: everything, including API keys, webhooks, SCIM tokens and the agents' value settings |
| Clickland Editors | editor | `read`, `alerts:write`, `notes:write`, `views:write` |
| Clickland Viewers | viewer | `read` (which includes `usage:read`) |

- Group names match without case. Someone in several Clickland groups gets the strongest role.
- Other groups ("Everyone", "Engineering", and so on) are ignored.
- **People in no Clickland group are refused.** The callback returns to `/?signin_error=no_role`, and the console
  says which groups to ask for. No user row is created for them. If a signed-in person loses their last Clickland
  group, their next request is `401` with `details.reason: "no_role"`.
- The console hides or disables what a role can't do. Viewers get no "New alert", note or dashboard edit controls.
  Editors don't see API keys, webhooks or the agents' settings. The API enforces the same scopes either way.

## SCIM

Clickland is a SCIM 2.0 server (RFC 7643 and RFC 7644) at `http://127.0.0.1:4710/scim/v2`. The console's dev server
proxies `/scim` too. Landbright pushes to it with a bearer token.

### Tokens

```bash
pnpm scim:token   # mints a token for "Landbright" and writes ~/.config/land-family/clickland-scim.env (mode 600)
```

The file holds `CLICKLAND_SCIM_URL=http://127.0.0.1:4710/scim/v2` and `CLICKLAND_SCIM_TOKEN=cls_…`, and its folder is
mode 700. The CLI never prints the token. Use `--name`, `--out` and `--url` to change them. Admins can also call
`POST /api/scim/tokens`, which shows the token once, plus `GET` and `DELETE /api/scim/tokens/:id`. Clickland stores
the sha256 of each token.

### What Clickland answers

| Route | Notes |
|---|---|
| `GET /ServiceProviderConfig`, `/ResourceTypes[/:id]`, `/Schemas[/:id]` | patch and filter supported; bulk, sort, etag and change password not |
| `POST /Users` | `userName` (the email), `externalId` (Landbright's `sub`), `displayName`, `name`, `emails`, `active`; `201` with `Location`. Also accepts optional `groups`. `409 uniqueness` when the userName (any case) or externalId is taken |
| `GET /Users?filter=…` | `eq` on `userName` (any case), `externalId`, `displayName` (any case) and `id`; `startIndex` and `count` (at most 500) |
| `GET /Users/:id`, `PUT /Users/:id`, `DELETE /Users/:id` | Landbright never deletes a user; a delete also ends their sessions |
| `PATCH /Users/:id` | `replace` or `add` of `active` (`true`/`false`, or `"True"`/`"False"`); a pathless `replace` of `{ userName, displayName, externalId, name, emails, active }` (it ignores attributes Clickland doesn't keep); paths `userName`, `displayName`, `externalId`, `name`, `name.givenName`, `name.familyName`, `name.formatted`, `emails`; and `groups` |
| `PATCH /Users/:id` with `groups` | `replace` with `[{ value, display }]` sets the person's groups to exactly those (a value is a group id or a name; a new name makes the group); `add` adds; `remove` with `groups[value eq "…"]`, a list, or nothing (all) |
| `POST /Groups` | `{ displayName, externalId, members: [{ value: <user id> }] }`; `409 uniqueness` on a taken displayName (any case); an unknown member is `400 invalidValue` |
| `GET /Groups?filter=…`, `GET /Groups/:id` | `eq` on `displayName` (any case), `externalId`, `id`; `excludedAttributes=members` leaves the members out |
| `PATCH /Groups/:id` | `add` `members` with a list; `remove` `members[value eq "id"]`, `members` with a list, or `members` alone (all); `replace` `members`, `displayName`, `externalId`; a pathless `replace` or `add` of `{ displayName, externalId, members }` |
| `PUT /Groups/:id`, `DELETE /Groups/:id` | `204` on delete; the members lose what the group gave them |

Requests may be `application/scim+json` or `application/json`. Answers are `application/scim+json`. Operation names
match without case (`Replace`). A PATCH body is a `PatchOp` message (`Operations`, and `schemas` if sent). Errors
follow RFC 7644 §3.12: `{ "schemas": ["urn:ietf:params:scim:api:messages:2.0:Error"], "status": "409", "scimType":
"uniqueness", "detail": "…" }`. The `scimType` is one of `invalidFilter`, `invalidPath`, `invalidValue`,
`invalidSyntax`, `noTarget`, `mutability` or `uniqueness`. A `404` on PATCH tells Landbright to create the user
again.

### Deactivation

`PATCH /Users/:id` with `active: false` (or a `PUT` with `active: false`, or a `DELETE`) deletes all of that person's
session rows in the same transaction. Their next request with the old cookie is `401`, and the console shows the
sign-in page. While they are inactive, signing in returns `/?signin_error=inactive`. Setting `active: true` lets them
sign in again.

## Precedence: SCIM and the sign-in claim

A person can reach Clickland by signing in first (JIT), by SCIM first, or by both in either order. Sign-in reconciles
them:

1. Clickland finds the user by `sub`, which is their `externalId`. If there is no match, it looks up the email as
   `userName`, but only when that row has no `sub` yet: a person SCIM pushed before they signed in. It then records
   the `sub` on that row. An email that already belongs to another `sub` is refused (`signin_error=failed`).
2. If no user exists, it creates one just in time from the claims.
3. It stores the `roles` claim (`groups_claim`) and the time of the sign-in.

Which source decides each part of the record:

| What | SCIM has not spoken | SCIM has spoken |
|---|---|---|
| Profile (userName, email, display name, name) | refreshed from the claims at each sign-in | SCIM's; sign-in no longer changes it (`scim_managed`, set by any SCIM create or change of the user) |
| Groups, and so the role | the `roles` claim from the last sign-in | SCIM's group memberships (`scim_groups_at`, set once any SCIM operation adds or removes the person from a group, deletes one of their groups or replaces their groups); the claim is kept but no longer used |
| Active | always true | SCIM's `active` |

So a person Landbright provisions is governed entirely by SCIM, and the claim only matters before the first push. If
SCIM has removed someone from every Clickland group, they have no role, even if the claim still names one.

## Checked live (2026-11-14)

See [history.md](history.md). The screens are under `study/console-screens/identity-*`:

- the sign-in page, the no-role page, the signed-in console and Settings (an editor), each at 1440 and 390 px;
- Settings for an admin, and the console after a deactivation, at 1440.

## Open

- Sign-in uses only OIDC. SAML 2.0 is Landbright's job: it federates SAML IdPs and still speaks OIDC to Clickland.
- No audit log of sign-ins and SCIM changes yet; the API's request log has them.
- No `etag`/`version`, bulk or sort on SCIM, and filters are `eq` only.
- The console has no page for SCIM tokens yet: use `pnpm scim:token` or the admin routes.
- Sessions don't slide: a session ends `CLICKLAND_SESSION_HOURS` after sign-in.
