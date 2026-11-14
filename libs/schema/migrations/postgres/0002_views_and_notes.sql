-- Views built on demand (MCP UI) and dashboards (pinned views), and notes: what people and agents learned.

CREATE TABLE views (
  id text PRIMARY KEY,
  title text NOT NULL,
  spec jsonb NOT NULL,
  pinned boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX views_pinned ON views (pinned, updated_at DESC);

CREATE TABLE notes (
  id text PRIMARY KEY,
  title text NOT NULL,
  body text NOT NULL,
  service text,
  tags text[] NOT NULL DEFAULT '{}',
  trace_ids text[] NOT NULL DEFAULT '{}',
  alert_event_id text REFERENCES alert_events (id) ON DELETE SET NULL,
  author text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  search tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', title), 'A') ||
    setweight(to_tsvector('english', coalesce(service, '')), 'B') ||
    setweight(to_tsvector('english', body), 'C')
  ) STORED
);
CREATE INDEX notes_search ON notes USING gin (search);
CREATE INDEX notes_service ON notes (service, created_at DESC);
