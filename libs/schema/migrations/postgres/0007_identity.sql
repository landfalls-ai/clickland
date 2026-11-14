-- Identity (docs/identity.md): people who sign in through Landbright (OIDC), the groups Landbright pushes over SCIM,
-- console sessions and SCIM bearer tokens.

-- A person. `id` is also the SCIM id; `external_id` is Landbright's `sub` (the ID token's sub and SCIM's externalId).
CREATE TABLE users (
  id                text PRIMARY KEY,                 -- usr_…
  external_id       text UNIQUE,                      -- Landbright's sub; null until a sign-in or SCIM names it
  user_name         text NOT NULL,                    -- the email Landbright sends as userName
  display_name      text,
  given_name        text,
  family_name       text,
  formatted_name    text,
  email             text,
  active            boolean NOT NULL DEFAULT true,    -- false: SCIM deactivated them; no sign-in, no session
  groups_claim      text[] NOT NULL DEFAULT '{}',     -- the `roles` claim at the last sign-in (all group names)
  scim_managed      boolean NOT NULL DEFAULT false,   -- SCIM created or changed this person: it owns the profile
  scim_groups_at    timestamptz,                      -- SCIM set this person's groups: memberships decide the role
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  last_sign_in_at   timestamptz
);
CREATE UNIQUE INDEX users_user_name ON users (lower(user_name));

-- A group as SCIM pushes it ("Clickland Admins", …). Its display name maps to a role (apps/api/src/roles.ts).
CREATE TABLE groups (
  id            text PRIMARY KEY,                     -- grp_…, the SCIM id
  display_name  text NOT NULL,
  external_id   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX groups_display_name ON groups (lower(display_name));

CREATE TABLE group_members (
  group_id    text NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
  user_id     text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX group_members_user ON group_members (user_id);

-- Console sessions: the cookie is random; Postgres keeps its sha256. Deactivating a person deletes their rows.
CREATE TABLE sessions (
  id            text PRIMARY KEY,                     -- sha256 of the cookie
  user_id       text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  id_token      text,                                 -- the ID token, as id_token_hint at sign-out
  user_agent    text,
  CHECK (expires_at > created_at)
);
CREATE INDEX sessions_user ON sessions (user_id);

-- Sign-ins in flight (authorization code + PKCE): state, verifier and nonce until the callback, ten minutes at most.
CREATE TABLE auth_requests (
  state_hash     text PRIMARY KEY,
  code_verifier  text NOT NULL,
  nonce          text NOT NULL,
  return_to      text NOT NULL DEFAULT '/',
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL
);

-- SCIM bearer tokens (`cls_…`): shown once, stored as sha256.
CREATE TABLE scim_tokens (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  prefix        text NOT NULL,
  hash          text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
