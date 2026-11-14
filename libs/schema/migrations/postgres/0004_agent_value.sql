-- AI agent value (docs/agent-value.md): what a model costs, what counts as an outcome and what one is worth.
-- Agents themselves are never stored: they are read from telemetry.

-- One row: the rate that turns minutes into money, and how teams and loops are recognised.
CREATE TABLE value_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  hourly_rate double precision NOT NULL DEFAULT 60 CHECK (hourly_rate > 0),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  team_attribute text NOT NULL DEFAULT 'team.id',   -- the attribute that names a team; service.namespace when absent
  loop_threshold integer NOT NULL DEFAULT 5 CHECK (loop_threshold BETWEEN 2 AND 100),
  updated_by text NOT NULL DEFAULT 'system',
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO value_settings DEFAULT VALUES;

-- The price of a million tokens per model. `model` is an id or a prefix ending in '*'; the longest match prices a model.
CREATE TABLE model_prices (
  id text PRIMARY KEY,
  model text NOT NULL UNIQUE,
  provider text NOT NULL DEFAULT '',
  input_per_mtok double precision NOT NULL CHECK (input_per_mtok >= 0),
  output_per_mtok double precision NOT NULL CHECK (output_per_mtok >= 0),
  cache_read_per_mtok double precision NOT NULL DEFAULT 0 CHECK (cache_read_per_mtok >= 0),
  cache_write_per_mtok double precision NOT NULL DEFAULT 0 CHECK (cache_write_per_mtok >= 0),
  source text NOT NULL DEFAULT '',                  -- where the price was read
  as_of date,                                       -- the day it was read
  note text NOT NULL DEFAULT '',
  seed_key text UNIQUE,                             -- set on rows the seed wrote
  edited boolean NOT NULL DEFAULT false,            -- a person changed it: the seed leaves it alone from then on
  updated_by text NOT NULL DEFAULT 'system',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- An outcome is a search over telemetry (or a sum metric) with a value: minutes saved, or a direct amount.
CREATE TABLE outcome_definitions (
  id text PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  signal text NOT NULL CHECK (signal IN ('traces', 'logs', 'metric')),
  query text NOT NULL,                              -- a Clickland search, or the metric's name
  metric_filter jsonb NOT NULL DEFAULT '{}',
  attribution jsonb NOT NULL,                       -- {"mode":"trace"} | correlate/field + "field" | agent + "agent"
  value_kind text NOT NULL CHECK (value_kind IN ('minutes', 'amount')),
  minutes_saved double precision NOT NULL DEFAULT 0 CHECK (minutes_saved >= 0),
  amount double precision NOT NULL DEFAULT 0 CHECK (amount >= 0),
  rationale text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  seed_key text UNIQUE,
  edited boolean NOT NULL DEFAULT false,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outcome_definitions_enabled ON outcome_definitions (enabled, name);
