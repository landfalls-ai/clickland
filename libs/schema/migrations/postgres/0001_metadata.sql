-- Clickland's metadata: everything that isn't telemetry (decision D7).

CREATE TABLE api_keys (
  id text PRIMARY KEY,
  name text NOT NULL,
  prefix text NOT NULL UNIQUE,          -- the visible start of the key, "ck_" + 8 characters
  hash text NOT NULL,                   -- sha256 of the whole key
  scopes text[] NOT NULL,               -- read, alerts:write, webhooks:write, notes:write, admin
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

CREATE TABLE saved_searches (
  id text PRIMARY KEY,
  name text NOT NULL,
  signal text NOT NULL CHECK (signal IN ('logs', 'traces')),
  query text NOT NULL DEFAULT '',
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE alerts (
  id text PRIMARY KEY,
  name text NOT NULL,
  signal text NOT NULL CHECK (signal IN ('logs', 'traces')),
  query text NOT NULL DEFAULT '',       -- a Clickland search; the alert counts matching rows
  group_by text,                        -- optional field: one series per value (e.g. ServiceName)
  threshold_type text NOT NULL CHECK (threshold_type IN ('above', 'below')),
  threshold double precision NOT NULL,
  window_minutes integer NOT NULL CHECK (window_minutes BETWEEN 1 AND 1440),
  interval_minutes integer NOT NULL CHECK (interval_minutes BETWEEN 1 AND 1440),
  enabled boolean NOT NULL DEFAULT true,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  next_run_at timestamptz NOT NULL DEFAULT now()
);

-- One row per alert and group: the current state, so a webhook fires on a change (ok -> firing, firing -> ok).
CREATE TABLE alert_states (
  alert_id text NOT NULL REFERENCES alerts (id) ON DELETE CASCADE,
  group_key text NOT NULL,              -- '' when the alert has no group_by
  state text NOT NULL CHECK (state IN ('ok', 'firing')),
  value double precision NOT NULL,
  changed_at timestamptz NOT NULL,
  evaluated_at timestamptz NOT NULL,
  PRIMARY KEY (alert_id, group_key)
);

CREATE TABLE alert_events (
  id text PRIMARY KEY,
  alert_id text NOT NULL REFERENCES alerts (id) ON DELETE CASCADE,
  group_key text NOT NULL,
  state text NOT NULL CHECK (state IN ('ok', 'firing')),
  value double precision NOT NULL,
  threshold double precision NOT NULL,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX alert_events_alert ON alert_events (alert_id, created_at DESC);

-- Webhook subscriptions: Landflow's Clickland trigger registers one when its workflow is published.
CREATE TABLE webhooks (
  id text PRIMARY KEY,
  url text NOT NULL,
  secret text NOT NULL,                 -- HMAC-SHA256 signing secret, shown once at creation
  events text[] NOT NULL,               -- alert.firing, alert.resolved, note.created
  alert_id text REFERENCES alerts (id) ON DELETE CASCADE,  -- null: every alert
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id text PRIMARY KEY,
  webhook_id text NOT NULL REFERENCES webhooks (id) ON DELETE CASCADE,
  event_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';
