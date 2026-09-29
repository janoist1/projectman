/**
 * Versioned schema migrations. The applied version is stored in `PRAGMA user_version`;
 * each migration runs once, inside a transaction. Never edit a released migration: add a
 * new one instead.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
      CREATE TABLE users (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        created_at    TEXT NOT NULL
      );

      -- id is the SHA-256 of the cookie token, so a leaked database does not leak sessions.
      CREATE TABLE auth_sessions (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at   TEXT NOT NULL,
        expires_at   TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      CREATE INDEX auth_sessions_user ON auth_sessions(user_id);

      CREATE TABLE projects (
        key            TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        template_id    TEXT,
        config_version TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );

      CREATE TABLE tasks (
        id          TEXT PRIMARY KEY,
        project_key TEXT NOT NULL REFERENCES projects(key),
        key         TEXT NOT NULL UNIQUE,
        seq         INTEGER NOT NULL,
        title       TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        stage_id    TEXT NOT NULL,
        status      TEXT NOT NULL,
        assignee    TEXT,
        repo        TEXT,
        priority    INTEGER,
        labels      TEXT NOT NULL DEFAULT '[]',
        checks      TEXT NOT NULL DEFAULT '{}',
        visibility  TEXT NOT NULL,
        created_by  TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        closed_at   TEXT
      );
      CREATE INDEX tasks_project ON tasks(project_key, seq);
      CREATE INDEX tasks_assignee ON tasks(project_key, assignee);

      -- repo is '' when the link has no repository, so the uniqueness constraint holds.
      CREATE TABLE task_links (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        kind       TEXT NOT NULL,
        ref        TEXT NOT NULL,
        repo       TEXT NOT NULL DEFAULT '',
        title      TEXT,
        state      TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (task_id, kind, repo, ref)
      );
      CREATE INDEX task_links_ref ON task_links(kind, repo, ref);

      CREATE TABLE timeline_events (
        seq          INTEGER PRIMARY KEY AUTOINCREMENT,
        id           TEXT NOT NULL UNIQUE,
        project_key  TEXT NOT NULL,
        task_key     TEXT,
        session_id   TEXT,
        actor_kind   TEXT NOT NULL,
        actor_handle TEXT,
        type         TEXT NOT NULL,
        data         TEXT NOT NULL,
        created_at   TEXT NOT NULL
      );
      CREATE INDEX timeline_project ON timeline_events(project_key, seq);
      CREATE INDEX timeline_task ON timeline_events(task_key, seq);

      -- One session per (AI member x work item). work_item_ref is the task key, the
      -- meeting id, or '' for the member's general chat.
      CREATE TABLE sessions (
        id                TEXT PRIMARY KEY,
        project_key       TEXT NOT NULL,
        member            TEXT NOT NULL,
        work_item_type    TEXT NOT NULL,
        work_item_ref     TEXT NOT NULL,
        claude_session_id TEXT NOT NULL,
        cwd               TEXT NOT NULL,
        branch            TEXT,
        transcript_path   TEXT,
        state             TEXT NOT NULL,
        activity          TEXT,
        started_at        TEXT NOT NULL,
        last_activity_at  TEXT NOT NULL,
        ended_at          TEXT,
        UNIQUE (project_key, member, work_item_type, work_item_ref)
      );
      CREATE INDEX sessions_project ON sessions(project_key, member);
      CREATE INDEX sessions_work_item ON sessions(project_key, work_item_type, work_item_ref);

      CREATE TABLE team_messages (
        seq          INTEGER PRIMARY KEY AUTOINCREMENT,
        id           TEXT NOT NULL UNIQUE,
        project_key  TEXT NOT NULL,
        from_handle  TEXT NOT NULL,
        to_handles   TEXT NOT NULL,
        task_key     TEXT,
        body         TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        delivered_at TEXT
      );
      CREATE INDEX team_messages_project ON team_messages(project_key, seq);
      CREATE INDEX team_messages_task ON team_messages(task_key, seq);

      CREATE TABLE inbox_items (
        seq         INTEGER PRIMARY KEY AUTOINCREMENT,
        id          TEXT NOT NULL UNIQUE,
        project_key TEXT NOT NULL,
        kind        TEXT NOT NULL,
        assignees   TEXT NOT NULL,
        source      TEXT NOT NULL,
        session_id  TEXT,
        task_key    TEXT,
        title       TEXT NOT NULL,
        body        TEXT,
        payload     TEXT NOT NULL,
        options     TEXT NOT NULL,
        state       TEXT NOT NULL,
        resolution  TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX inbox_project_state ON inbox_items(project_key, state, seq);
      CREATE INDEX inbox_task ON inbox_items(task_key, state);

      CREATE TABLE member_state (
        project_key TEXT NOT NULL,
        handle      TEXT NOT NULL,
        status      TEXT NOT NULL,
        activity    TEXT,
        updated_at  TEXT NOT NULL,
        PRIMARY KEY (project_key, handle)
      );

      CREATE TABLE counters (
        project_key TEXT NOT NULL,
        name        TEXT NOT NULL,
        value       INTEGER NOT NULL,
        PRIMARY KEY (project_key, name)
      );
    `,
  },
  {
    version: 2,
    name: 'colleague invitations',
    sql: `
      CREATE TABLE invitations (
        id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL REFERENCES projects(key),
        email TEXT NOT NULL COLLATE NOCASE,
        display_name TEXT,
        access TEXT NOT NULL CHECK(access IN ('admin', 'developer', 'client', 'viewer')),
        roles TEXT NOT NULL,
        invited_by TEXT NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        accepted_at TEXT,
        revoked_at TEXT,
        token_hash TEXT NOT NULL UNIQUE
      );
      CREATE INDEX invitations_project ON invitations(project_key, created_at);
    `,
  },
  {
    version: 3,
    name: 'member schedule runs',
    sql: `
      CREATE TABLE schedule_runs (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        project_key TEXT NOT NULL REFERENCES projects(key),
        member TEXT NOT NULL,
        scheduled_for TEXT NOT NULL,
        started_at TEXT,
        session_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('started', 'skipped', 'failed', 'done')),
        reason TEXT,
        automatic INTEGER NOT NULL
      );
      CREATE INDEX schedule_runs_project ON schedule_runs(project_key, seq);
      CREATE UNIQUE INDEX schedule_runs_occurrence
        ON schedule_runs(project_key, member, scheduled_for) WHERE automatic = 1;
    `,
  },
  {
    version: 4,
    name: 'pull request member attribution',
    sql: `ALTER TABLE task_links ADD COLUMN author TEXT;
      UPDATE task_links SET author = (SELECT assignee FROM tasks WHERE tasks.id = task_links.task_id) WHERE kind = 'pull_request';`,
  },
];

export const LATEST_SCHEMA_VERSION = migrations.reduce((max, m) => Math.max(max, m.version), 0);
