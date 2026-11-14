-- PM-1512: how far each session has been told of changes to its card (the card-change notice in team tool results).
CREATE TABLE card_notice_cursors (
  session_id TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  seq INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
