-- PM-1335: the failed session starts of a member at a place, so that the backoff and the stop at the limit
-- survive a restart. `retry_at` is when the next automatic start may run (NULL once stopped); `stopped_at`
-- is when the limit was reached (NULL while the place is still trying). `last_session_id` makes a count
-- idempotent for one session. No old row needs a backfill: nothing counted failures before.
CREATE TABLE start_failures (
  project_key TEXT NOT NULL, member TEXT NOT NULL, place TEXT NOT NULL,
  provider TEXT NOT NULL, engine_id TEXT,
  failures INTEGER NOT NULL, last_code TEXT NOT NULL, last_session_id TEXT,
  first_at TEXT NOT NULL, last_at TEXT NOT NULL,
  retry_at TEXT, stopped_at TEXT,
  PRIMARY KEY (project_key, member, place)
);
