-- The direct route to Landfall: webhooks in Landfall's own format, and the room each alert event opened or attached to.

-- An alert takes the direct route when it is sev1 or when this is set (alerts about Landflow itself).
ALTER TABLE alerts ADD COLUMN direct boolean NOT NULL DEFAULT false;

-- `landfall`: posts Landfall's SourceTriggerPayload to its POST /triggers with the ingest token.
ALTER TABLE webhooks ADD COLUMN format text NOT NULL DEFAULT 'standard' CHECK (format IN ('standard', 'landfall'));
ALTER TABLE webhooks ADD COLUMN auth_token text;          -- sent as Authorization: Bearer; never returned
ALTER TABLE webhooks ADD COLUMN connection_id text;       -- Landfall's remote-source connection id

-- Which alert event a delivery reports, so Landfall's answer can be stored on it.
ALTER TABLE webhook_deliveries ADD COLUMN alert_event_id text REFERENCES alert_events (id) ON DELETE SET NULL;

-- The Landfall room: { system, id, url, outcome, at }. On the event, and on the group's state so a later firing
-- of the same group shows the room it attaches to.
ALTER TABLE alert_events ADD COLUMN incident jsonb;
ALTER TABLE alert_states ADD COLUMN incident jsonb;
