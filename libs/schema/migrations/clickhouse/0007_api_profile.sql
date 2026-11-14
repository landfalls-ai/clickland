-- The limits every query from the Clickland API runs under (research.md §5, decision D8). The users themselves are
-- declared in deploy/clickhouse/users.d/clickland.xml (passwords come from the environment, never from SQL).
-- readonly = 2: SELECT only, but per-query settings (the API's own limits, use_query_cache) may still be set.
CREATE SETTINGS PROFILE OR REPLACE clickland_api SETTINGS
  readonly = 2,
  max_memory_usage = 4000000000 MAX 8000000000,
  max_execution_time = 30 MAX 120,
  max_rows_to_read = 2000000000,
  read_overflow_mode = 'throw',
  max_result_rows = 1000000,
  result_overflow_mode = 'throw',
  enable_full_text_index = 1,
  use_query_condition_cache = 1;
