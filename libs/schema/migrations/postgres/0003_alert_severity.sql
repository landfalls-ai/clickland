-- Alerts carry a severity (Landfall's scale, sev1 the worst), labels and a runbook link; all three ride in webhooks.

ALTER TABLE alerts ADD COLUMN severity text NOT NULL DEFAULT 'sev3'
  CHECK (severity IN ('sev1', 'sev2', 'sev3', 'sev4'));
ALTER TABLE alerts ADD COLUMN labels jsonb NOT NULL DEFAULT '{}';
ALTER TABLE alerts ADD COLUMN runbook_url text;
