-- The collector and the API connect as their own users (declared with SQL so the grants live next to the tables).
-- Their passwords are set by the migration runner from CLICKLAND_CH_INGEST_PASSWORD and CLICKLAND_CH_API_PASSWORD.
CREATE USER IF NOT EXISTS clickland_ingest IDENTIFIED WITH sha256_password BY '${INGEST_PASSWORD}';
GRANT INSERT, SELECT ON ${DATABASE}.* TO clickland_ingest;
CREATE USER IF NOT EXISTS clickland_api IDENTIFIED WITH sha256_password BY '${API_PASSWORD}' SETTINGS PROFILE 'clickland_api';
GRANT SELECT ON ${DATABASE}.* TO clickland_api;
GRANT SELECT ON system.parts TO clickland_api;
GRANT SELECT ON system.columns TO clickland_api;
GRANT SELECT ON system.data_skipping_indices TO clickland_api;
