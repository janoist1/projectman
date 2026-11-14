CREATE TABLE start_condition_marks (
  task_key TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  met_since TEXT NOT NULL
);
CREATE INDEX start_condition_marks_project ON start_condition_marks(project_key);
