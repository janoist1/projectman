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

/**
 * Marks sessions whose transcript is a Codex rollout file (rollout-*.jsonl, compressed
 * .jsonl.zst; the file name is what follows the last "/") as Codex sessions. Migration 9 runs
 * it once; `migrate` repeats it on every start, because a build from before migration 9 run
 * on the same database leaves the column at its default for the Codex sessions it records.
 * A Claude Code transcript is never named like that, so repeating it is safe.
 */
export const SESSION_PROVIDER_REPAIR = `UPDATE sessions SET provider = 'codex'
      WHERE provider = 'claude' AND (
        substr(transcript_path, length(rtrim(transcript_path, replace(transcript_path, '/', ''))) + 1)
          GLOB 'rollout-*.jsonl'
        OR substr(transcript_path, length(rtrim(transcript_path, replace(transcript_path, '/', ''))) + 1)
          GLOB 'rollout-*.jsonl.zst');`;

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
  {
    version: 5,
    name: 'per recipient message receipts',
    sql: `ALTER TABLE team_messages ADD COLUMN receipts TEXT;`,
  },
  {
    version: 6,
    name: 'invitations for unclaimed members',
    sql: `ALTER TABLE invitations ADD COLUMN member_handle TEXT;
      CREATE INDEX invitations_member ON invitations(project_key, member_handle);`,
  },
  {
    version: 7,
    name: 'one level subtasks',
    sql: `ALTER TABLE tasks ADD COLUMN parent_key TEXT REFERENCES tasks(key);
      CREATE INDEX tasks_parent ON tasks(project_key, parent_key);`,
  },
  {
    version: 8,
    name: 'pull request head commit',
    sql: `ALTER TABLE task_links ADD COLUMN head_sha TEXT;`,
  },
  {
    version: 9,
    name: 'session provider',
    // Earlier rows are Codex conversations when their transcript is a Codex rollout file.
    sql: `ALTER TABLE sessions ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude';
      ${SESSION_PROVIDER_REPAIR}`,
  },
  {
    version: 10,
    name: 'deferred automatic session starts',
    // The starts admission refused for a reason that can clear (src/domain/admission): they are
    // loaded back into the in-memory store when the server starts, so a restart does not lose them.
    // seq keeps the order they were deferred in; spec and waiting are JSON.
    sql: `CREATE TABLE deferred_starts (
        seq         INTEGER PRIMARY KEY AUTOINCREMENT,
        key         TEXT NOT NULL UNIQUE,
        project_key TEXT NOT NULL,
        task_key    TEXT,
        spec        TEXT NOT NULL,
        waiting     TEXT NOT NULL
      );`,
  },
  {
    version: 11,
    name: 'task attachments',
    // The file system and SQLite share no transaction, so a row carries a durable state:
    // 'pending' (the upload is being written; recovered by removing it), 'ready' (the only
    // readable state), 'deleting' (the intent to delete, with who asked, until the file is gone
    // and the audit event is written). The id also names the file in storage.
    sql: `CREATE TABLE attachments (
        seq                 INTEGER PRIMARY KEY AUTOINCREMENT,
        id                  TEXT NOT NULL UNIQUE,
        project_key         TEXT NOT NULL REFERENCES projects(key),
        task_key            TEXT NOT NULL REFERENCES tasks(key),
        file_name           TEXT NOT NULL,
        size                INTEGER NOT NULL,
        media_type          TEXT NOT NULL,
        preview             TEXT NOT NULL CHECK(preview IN ('image', 'pdf', 'none')),
        uploaded_by_kind    TEXT NOT NULL CHECK(uploaded_by_kind IN ('human', 'ai', 'system')),
        uploaded_by_handle  TEXT,
        created_at          TEXT NOT NULL,
        state               TEXT NOT NULL CHECK(state IN ('pending', 'ready', 'deleting')),
        deleted_by_kind     TEXT,
        deleted_by_handle   TEXT,
        delete_requested_at TEXT
      );
      CREATE INDEX attachments_task ON attachments(project_key, task_key, state, seq);`,
  },
  {
    version: 12,
    name: 'boundary requests and grants',
    sql: `CREATE TABLE boundary_requests (
    id TEXT PRIMARY KEY,
    project_key TEXT NOT NULL REFERENCES projects(key),
    session_id TEXT NOT NULL,
    deduplication_key TEXT NOT NULL,
    record TEXT NOT NULL,
    UNIQUE(project_key, session_id, deduplication_key)
  );
  CREATE INDEX boundary_requests_state ON boundary_requests(json_extract(record, '$.state'));
  CREATE TABLE boundary_grants (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE REFERENCES boundary_requests(id),
    record TEXT NOT NULL
  );`,
  },
  {
    version: 13,
    name: 'member workspaces, their reservation and task bindings',
    // One durable workspace per project x member x repository (PM-138). The holder columns are the
    // reservation: the session whose process (with its process group) owns the workspace, kept
    // across restarts until that process is proven gone. A binding is what a member's task uses in
    // the workspace: its branch (work) or the pinned commit of a review round (review), and the
    // workspace generation its conversation belongs to. Older session rows need nothing new.
    sql: `CREATE TABLE member_workspaces (
        id                TEXT PRIMARY KEY,
        project_key       TEXT NOT NULL REFERENCES projects(key),
        member            TEXT NOT NULL,
        repo              TEXT NOT NULL,
        path              TEXT NOT NULL,
        generation        INTEGER NOT NULL,
        created_at        TEXT NOT NULL,
        holder_session_id TEXT,
        holder_task_key   TEXT,
        holder_pid        INTEGER,
        held_since        TEXT,
        UNIQUE (project_key, member, repo)
      );
      CREATE TABLE task_workspace_bindings (
        project_key   TEXT NOT NULL REFERENCES projects(key),
        task_key      TEXT NOT NULL REFERENCES tasks(key),
        member        TEXT NOT NULL,
        workspace_id  TEXT NOT NULL REFERENCES member_workspaces(id),
        kind          TEXT NOT NULL CHECK(kind IN ('work', 'review')),
        branch        TEXT,
        base_commit   TEXT,
        source_path   TEXT,
        source_ref    TEXT,
        source_commit TEXT,
        round         INTEGER NOT NULL DEFAULT 0,
        refresh       INTEGER NOT NULL DEFAULT 0,
        generation    INTEGER NOT NULL,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        PRIMARY KEY (project_key, task_key, member, workspace_id)
      );
      CREATE INDEX task_workspace_bindings_task ON task_workspace_bindings(project_key, task_key, kind);`,
  },
  {
    version: 14,
    name: 'execution profile of a session',
    // The profile a session's process last ran in (PM-141): `legacy` or `managed_vm`. A conversation
    // started in one profile is never resumed in the other (its directory and the questions it was
    // allowed belong to that profile), so the start needs to know. Every older row is `legacy`.
    sql: `ALTER TABLE sessions ADD COLUMN execution_profile TEXT NOT NULL DEFAULT 'legacy';`,
  },
  {
    version: 15,
    name: 'provenance of a published pull request author',
    // Who authored a pull request that the publishing gate opened (PM-142). The author of such a link
    // comes from the authenticated session, and `author_source = 'published'` keeps polling from
    // replacing it with a member matched by the shared bot login. Every older link has none (NULL)
    // and keeps the login-matching behavior it always had.
    sql: `ALTER TABLE task_links ADD COLUMN author_source TEXT;`,
  },
  {
    version: 16,
    name: 'egress operations and allowances',
    // The network side of the VM boundary (PM-140). An operation is a destination a session was
    // refused, registered so it can be asked for (its id is the boundary operation id); an
    // allowance is an allowed request the egress proxy consumed: one member, one project, one
    // host and port, until a fixed time, revocable by an owner. Existing rows need nothing new.
    sql: `CREATE TABLE egress_operations (
        id          TEXT PRIMARY KEY,
        project_key TEXT NOT NULL REFERENCES projects(key),
        member      TEXT NOT NULL,
        session_id  TEXT NOT NULL,
        task_key    TEXT,
        host        TEXT NOT NULL,
        port        INTEGER NOT NULL,
        created_at  TEXT NOT NULL,
        expires_at  TEXT NOT NULL
      );
      CREATE INDEX egress_operations_session ON egress_operations(session_id, host, port);
      CREATE INDEX egress_operations_member ON egress_operations(project_key, member, host, port);
      CREATE TABLE egress_allowances (
        id           TEXT PRIMARY KEY,
        project_key  TEXT NOT NULL REFERENCES projects(key),
        member       TEXT NOT NULL,
        host         TEXT NOT NULL,
        port         INTEGER NOT NULL,
        request_id   TEXT NOT NULL UNIQUE REFERENCES boundary_requests(id),
        operation_id TEXT NOT NULL REFERENCES egress_operations(id),
        granted_at   TEXT NOT NULL,
        expires_at   TEXT NOT NULL,
        revoked_at   TEXT,
        revoked_by   TEXT
      );
      CREATE INDEX egress_allowances_member ON egress_allowances(project_key, member, host, port);`,
  },
  {
    version: 17,
    name: 'permission settings of a session',
    // An owner's permission settings for one session (PM-170): the CLI mode and who answers when it
    // asks. NULL is the member's setting, which every older row and every new session has; resumes
    // use the same row, so they keep it. `permission_restart_pending`: a new mode waits for the
    // session's next idle moment; `permission_grants_lost`: that restart dropped what was allowed
    // for the session.
    sql: `ALTER TABLE sessions ADD COLUMN permission_mode TEXT;
      ALTER TABLE sessions ADD COLUMN approver TEXT;
      ALTER TABLE sessions ADD COLUMN permission_restart_pending INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN permission_grants_lost INTEGER NOT NULL DEFAULT 0;`,
  },
  {
    version: 18,
    name: 'token usage of sessions',
    // The tokens AI sessions used (PM-178), read from their transcripts: one row per session, hour,
    // model and scope (the session's own conversation or its subagents), added to as the session
    // goes on. The member and the task are kept on the row so a card's or a member's usage in a time
    // window is one query. `usage_since` is when a session's usage started to be counted: every
    // older session has none (NULL, "no data"), and one resumed later counts from that resume.
    sql: `CREATE TABLE token_usage (
        session_id    TEXT NOT NULL REFERENCES sessions(id),
        project_key   TEXT NOT NULL,
        member        TEXT NOT NULL,
        task_key      TEXT,
        hour          TEXT NOT NULL,
        model         TEXT NOT NULL,
        scope         TEXT NOT NULL,
        input_tokens       INTEGER NOT NULL DEFAULT 0,
        output_tokens      INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session_id, hour, model, scope)
      );
      CREATE INDEX token_usage_member ON token_usage(project_key, member, hour);
      CREATE INDEX token_usage_task ON token_usage(project_key, task_key);
      ALTER TABLE sessions ADD COLUMN usage_since TEXT;`,
  },
  {
    version: 20,
    name: 'review pins',
    // The commit of the developer's branch handed over when a task entered a review or test stage
    // (PM-183): one row per task, replaced by the next hand-over or a new review round, and removed
    // when the task leaves the stage. Every existing task has none, and its reviewers keep reading
    // the branch as before.
    sql: `CREATE TABLE task_review_pins (
        project_key TEXT NOT NULL REFERENCES projects(key),
        task_key    TEXT NOT NULL PRIMARY KEY REFERENCES tasks(key),
        stage_id    TEXT NOT NULL,
        commit_id   TEXT NOT NULL,
        branch      TEXT NOT NULL,
        pinned_at   TEXT NOT NULL,
        pinned_by   TEXT NOT NULL
      );`,
  },
  {
    // 19 is skipped on purpose: a database already at 20 would never run a lower number.
    version: 21,
    name: 'usage alert of sessions',
    // A session whose usage reached the project's warning limit (PM-187): when, what it counted and
    // the limit then. NULL: it has not. Set once, so a session raises one warning.
    sql: `ALTER TABLE sessions ADD COLUMN usage_alert_at TEXT;
      ALTER TABLE sessions ADD COLUMN usage_alert_tokens INTEGER;
      ALTER TABLE sessions ADD COLUMN usage_alert_limit INTEGER;`,
  },
  {
    version: 22,
    name: 'state since of sessions',
    // When a session entered its current state (PM-207), so a card's "working" age counts from there.
    // NULL: a session from before it was kept; its last activity stands in.
    sql: `ALTER TABLE sessions ADD COLUMN state_since TEXT;`,
  },
  {
    // 23 is left to another card on purpose: a database already at 24 would never run a lower number.
    version: 24,
    name: 'end-of-round compaction of sessions',
    // PM-213: a task session whose round ended (the card left its stage) owes a compaction of its
    // conversation until one ran or was given up; and the context the conversation last measured
    // (input + cache read + cache write of its last step), so a stopped session is compacted when
    // it resumes only if the conversation is big. Existing sessions owe nothing and have no measure.
    // And the commit a reviewer's session last reviewed (PM-183's pin, which is gone once the card
    // leaves the stage), for the message that wakes it for the next round.
    sql: `ALTER TABLE sessions ADD COLUMN compact_pending INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN context_tokens INTEGER;
      ALTER TABLE sessions ADD COLUMN reviewed_commit TEXT;`,
  },
  {
    // 22 and 24 are taken and 23 is another card's, so this is 25.
    version: 25,
    name: 'card kind and theme',
    // PM-205: a card is a `task` (every existing row) or a `theme`, and a card that is not a subtask can
    // belong to one theme. A subtask's theme is read from its parent, never stored (the parent changing
    // theme writes nothing to its subtasks). Existing cards are tasks with no theme; their timeline events
    // and links are not touched.
    sql: `ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'task';
      ALTER TABLE tasks ADD COLUMN theme_key TEXT REFERENCES tasks(key);
      CREATE INDEX tasks_theme ON tasks(project_key, theme_key);`,
  },
  {
    // 23 is another card's, 24 and 25 are taken, so this is 26.
    version: 26,
    name: 'task covers',
    // PM-224: a person's choice of a card's cover, one row per task: `pinned` (that image) or `hidden`
    // (no cover). A card without a row keeps the automatic cover (its first image), so existing cards
    // are untouched. The row of a deleted pinned file is removed with the file.
    sql: `CREATE TABLE task_covers (
        project_key   TEXT NOT NULL REFERENCES projects(key),
        task_key      TEXT NOT NULL PRIMARY KEY REFERENCES tasks(key),
        mode          TEXT NOT NULL CHECK (mode IN ('pinned', 'hidden')),
        attachment_id TEXT,
        set_at        TEXT NOT NULL,
        set_by_kind   TEXT NOT NULL,
        set_by_handle TEXT,
        CHECK ((mode = 'pinned') = (attachment_id IS NOT NULL))
      );`,
  },
  {
    // 23 is another card's, 24 to 26 are taken, so this is 27.
    version: 27,
    name: 'current work sentence of sessions',
    // PM-238: what a member says it does on its card now: a one-line summary and an optional longer
    // detail. NULL: none given (every existing session). Only the latest is kept, and it is cleared
    // when the session's round or the session ends.
    sql: `ALTER TABLE sessions ADD COLUMN doing_summary TEXT;
      ALTER TABLE sessions ADD COLUMN doing_detail TEXT;`,
  },
  {
    version: 28,
    name: 'manual board order of tasks',
    // PM-118: a card's place in the manual order of its board column, independent of `priority`. The
    // cards that exist get one project-wide order, newest update first and the highest number first
    // among equals (the order the board showed within a phase), spaced 1024 apart like the ranks the
    // board writes (`BOARD_RANK_STEP` in the shared package). A column's order is that order filtered to
    // the cards in it, so it is stable whatever the stages of a column are.
    sql: `ALTER TABLE tasks ADD COLUMN board_rank INTEGER NOT NULL DEFAULT 0;
      UPDATE tasks SET board_rank = ranked.position * 1024
        FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY project_key ORDER BY updated_at DESC, seq DESC) AS position
              FROM tasks) AS ranked
        WHERE ranked.id = tasks.id;
      CREATE INDEX tasks_board_order ON tasks(project_key, stage_id, board_rank);`,
  },
];
export const LATEST_SCHEMA_VERSION = migrations.reduce((max, m) => Math.max(max, m.version), 0);
