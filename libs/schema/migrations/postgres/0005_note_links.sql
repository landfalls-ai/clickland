-- Notes point somewhere: [{ label, url }], e.g. the Landfall room a postmortem note came from.

ALTER TABLE notes ADD COLUMN links jsonb NOT NULL DEFAULT '[]';
