-- PM-1377: the command a full test run ran, so a merge reuses a pass only of the same command. Older rows stay
  -- NULL and are never reused.
ALTER TABLE full_test_runs ADD COLUMN command TEXT;
