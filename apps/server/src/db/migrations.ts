import {
  V83_CHANGE_TRIGGER_TABLES,
  V92_CHANGE_TRIGGER_TABLES,
  V100_REBUILT_TRIGGER_TABLES,
  changeTriggerSql,
  changeTriggersSql,
} from './change-triggers';
import { PENDING_MESSAGE_RECIPIENTS } from './message-pending';

/**
 * Versioned schema migrations. The applied version is stored in `PRAGMA user_version`;
 * each migration runs once, inside a transaction. Never edit a released migration: add a
 * new one instead.
 */
interface Migration {
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
  {
    version: 29,
    name: 'task loops',
    // PM-261: the loops found on cards (AI members writing to each other without progress), one row per
    // loop, open until `ended_at`. At most one is open per card (the loop watch looks for the next one
    // only after the end of the last). `members` and `deciders` are JSON arrays of handles; `head_commit`
    // is the card's branch head when the loop was found, so a later commit ends it; `notified_count` is
    // the number of counted messages when the member was told (0 until then), so a loop that goes on is told apart.
    sql: `CREATE TABLE task_loops (
        id              TEXT NOT NULL PRIMARY KEY,
        project_key     TEXT NOT NULL REFERENCES projects(key),
        task_key        TEXT NOT NULL REFERENCES tasks(key),
        started_at      TEXT NOT NULL,
        raised_at       TEXT NOT NULL,
        last_message_at TEXT NOT NULL,
        members         TEXT NOT NULL,
        count           INTEGER NOT NULL,
        notified        TEXT,
        notified_count  INTEGER NOT NULL DEFAULT 0,
        phase           TEXT NOT NULL CHECK (phase IN ('notified', 'owner', 'let_run')),
        owner_reason    TEXT,
        deciders        TEXT NOT NULL,
        inbox_item_id   TEXT,
        head_commit     TEXT,
        ended_at        TEXT,
        end_reason      TEXT,
        let_run_by      TEXT
      );
      CREATE INDEX task_loops_task ON task_loops(project_key, task_key, ended_at);`,
  },
  {
    version: 30,
    name: 'task fix limits',
    // PM-262: the fix round limit of a card, one row per card that was ever held or let go on. The rounds
    // are counted from the timeline after counted_from (NULL: from the start) plus extra_rounds that
    // people allowed. hold_phase is set while the card is held ('lead', 'replan' or 'owner'); decider is
    // the AI member who decides, deciders (a JSON array of handles) the people.
    sql: `CREATE TABLE task_fix_limits (
        task_key      TEXT NOT NULL PRIMARY KEY REFERENCES tasks(key),
        project_key   TEXT NOT NULL REFERENCES projects(key),
        counted_from  TEXT,
        extra_rounds  INTEGER NOT NULL DEFAULT 0,
        hold_phase    TEXT CHECK (hold_phase IN ('lead', 'replan', 'owner')),
        held_at       TEXT,
        decider       TEXT,
        deciders      TEXT NOT NULL DEFAULT '[]',
        reason        TEXT,
        inbox_item_id TEXT
      );`,
  },
  {
    version: 31,
    name: 'pauses',
    // PM-219: a pause of the instance (project_key NULL) or of one project, durable so that it survives a
    // restart. At most one is open (resumed_at NULL) per scope. kind 'shutdown' is the pause the server makes
    // before it stops, which the next start resumes; requested_by is a user id, NULL for the control command
    // and the system. force_after_ms is the deadline after which a session that has not stopped is cut.
    // session_pauses: the sessions a pause holds, one open row per session (whichever pause caught it
    // first); point NULL while the session is still stopping; needs_restart: it stopped at a point from which
    // a session whose process is gone restarts on resume.
    sql: `CREATE TABLE pauses (
        id             TEXT NOT NULL PRIMARY KEY,
        scope          TEXT NOT NULL CHECK (scope IN ('instance', 'project')),
        project_key    TEXT REFERENCES projects(key),
        kind           TEXT NOT NULL CHECK (kind IN ('manual', 'shutdown')),
        source         TEXT NOT NULL CHECK (source IN ('app', 'control', 'system')),
        reason         TEXT,
        requested_by   TEXT REFERENCES users(id),
        requested_at   TEXT NOT NULL,
        force_after_ms INTEGER NOT NULL,
        resumed_at     TEXT,
        resumed_by     TEXT,
        CHECK ((scope = 'instance') = (project_key IS NULL))
      );
      CREATE UNIQUE INDEX pauses_open ON pauses(scope, COALESCE(project_key, '')) WHERE resumed_at IS NULL;
      CREATE TABLE session_pauses (
        session_id    TEXT NOT NULL REFERENCES sessions(id),
        pause_id      TEXT NOT NULL REFERENCES pauses(id),
        project_key   TEXT NOT NULL REFERENCES projects(key),
        since         TEXT NOT NULL,
        point         TEXT,
        tool          TEXT,
        waiting_for   TEXT,
        paused_at     TEXT,
        needs_restart INTEGER NOT NULL DEFAULT 0,
        resumed_at    TEXT
      );
      CREATE UNIQUE INDEX session_pauses_open ON session_pauses(session_id) WHERE resumed_at IS NULL;
      CREATE INDEX session_pauses_project ON session_pauses(project_key, resumed_at);`,
  },
  {
    version: 32,
    name: 'full test runs',
    // PM-217: the server's full test of a card's pinned commit before it is reviewed, one row per run.
    // `status` is queued, running, passed, failed, error or cancelled; `reason` is the error reason or
    // the cancel reason. `failed_files` is a JSON array of file names.
    sql: `CREATE TABLE full_test_runs (
        id           TEXT NOT NULL PRIMARY KEY,
        project_key  TEXT NOT NULL REFERENCES projects(key),
        task_key     TEXT NOT NULL REFERENCES tasks(key),
        repo         TEXT NOT NULL,
        branch       TEXT NOT NULL,
        commit_sha   TEXT NOT NULL,
        status       TEXT NOT NULL CHECK (status IN ('queued', 'running', 'passed', 'failed', 'error', 'cancelled')),
        reason       TEXT,
        exit_code    INTEGER,
        failed_files TEXT,
        duration_ms  INTEGER,
        created_at   TEXT NOT NULL,
        started_at   TEXT,
        finished_at  TEXT
      );
      CREATE INDEX full_test_runs_task_commit ON full_test_runs(task_key, commit_sha);`,
  },
  {
    version: 33,
    name: 'session last stop',
    // PM-288: why the session stopped last, a JSON `SessionStop`; null for a running session and for
    // a row from before it was kept.
    sql: `ALTER TABLE sessions ADD COLUMN last_stop TEXT NULL;`,
  },
  {
    version: 34,
    name: 'team message answers',
    // PM-249: the message that carries a person's answer to an AI member's question points at it
    // (JSON `{ inboxItemId, question, answer }`), so that the card thread shows a question and its
    // answer. NULL for every other message and for the answers sent before this.
    sql: 'ALTER TABLE team_messages ADD COLUMN answer TEXT;',
  },
  {
    version: 35,
    name: 'task developer level',
    // PM-347: the recommended developer of the card, a JSON `TaskDeveloperLevel`; NULL: no
    // recommendation (which counts as `any`), as on every card from before it.
    sql: 'ALTER TABLE tasks ADD COLUMN developer_level TEXT;',
  },
  {
    version: 36,
    name: 'senior waits',
    // PM-348: the wait of a card recommended for the Senior for one, with the question the owners
    // got after the wait limit and what they answered. At most one is open per card.
    sql: `CREATE TABLE senior_waits (
        id             TEXT PRIMARY KEY,
        project_key    TEXT NOT NULL,
        task_key       TEXT NOT NULL,
        since          TEXT NOT NULL,
        inbox_item_id  TEXT,
        asked_at       TEXT,
        decision       TEXT CHECK (decision IN ('wait', 'any')),
        decided_by     TEXT,
        decided_at     TEXT,
        ended_at       TEXT,
        end_reason     TEXT CHECK (end_reason IN
          ('senior', 'assigned', 'moved', 'closed', 'level_changed', 'no_senior'))
      );
      CREATE UNIQUE INDEX senior_waits_open ON senior_waits(project_key, task_key)
        WHERE ended_at IS NULL;`,
  },
  {
    version: 37,
    name: 'task stage entered at',
    sql: `ALTER TABLE tasks ADD COLUMN stage_entered_at TEXT;
UPDATE tasks SET stage_entered_at = COALESCE(
  (SELECT e.created_at FROM timeline_events e
    WHERE e.task_key = tasks.key AND e.type = 'task_stage_changed'
    ORDER BY e.seq DESC LIMIT 1),
  created_at);`,
  },
  {
    version: 38,
    name: 'team message kind and card version',
    sql: `ALTER TABLE team_messages ADD COLUMN kind TEXT;
ALTER TABLE team_messages ADD COLUMN version TEXT;
ALTER TABLE team_messages ADD COLUMN subject TEXT;`,
  },
  {
    version: 39,
    name: 'session involvement attribution',
    sql: `ALTER TABLE timeline_events ADD COLUMN actor_via TEXT;
    ALTER TABLE team_messages ADD COLUMN via TEXT;
    ALTER TABLE team_messages ADD COLUMN origin TEXT;
    ALTER TABLE sessions ADD COLUMN start_cause TEXT;
    CREATE TABLE integrator_keys (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), prefix TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, expires_at TEXT,
      revoked_at TEXT, last_used_at TEXT
    );
    CREATE INDEX timeline_involvements ON timeline_events(project_key, created_at DESC, id DESC)
      WHERE type IN ('session_started', 'session_ended');`,
  },
  {
    version: 40,
    name: 'task handoffs',
    // PM-342: the handoff of a card's assignee. A row is open while outcome is NULL (at most one per card);
    // it ends with 'note' (the old member's note), 'fallback' (the transcript summary stands in) or
    // 'cancelled' (the card went back). step: waiting_point | writing | paused | closing; closing_at is when
    // the note or the fallback was recorded (the old session closes after it). from_session_id is the old
    // member's session on the card; taken_over_* is the receiver's session that began with the handoff.
    sql: `CREATE TABLE task_handoffs (
        id                    TEXT NOT NULL PRIMARY KEY,
        project_key           TEXT NOT NULL REFERENCES projects(key),
        task_key              TEXT NOT NULL REFERENCES tasks(key),
        from_member           TEXT NOT NULL,
        to_member             TEXT,
        from_provider         TEXT NOT NULL,
        to_provider           TEXT,
        from_session_id       TEXT,
        reason                TEXT NOT NULL,
        step                  TEXT NOT NULL CHECK (step IN ('waiting_point', 'writing', 'paused', 'closing')),
        started_at            TEXT NOT NULL,
        deadline_at           TEXT,
        outcome               TEXT CHECK (outcome IN ('note', 'fallback', 'cancelled')),
        fallback_reason       TEXT,
        note                  TEXT,
        branch                TEXT,
        last_commit           TEXT,
        uncommitted           INTEGER,
        summary_source        TEXT,
        summary_text          TEXT,
        summary_at            TEXT,
        closing_at            TEXT,
        ended_at              TEXT,
        taken_over_at         TEXT,
        taken_over_session_id TEXT
      );
      CREATE UNIQUE INDEX task_handoffs_open ON task_handoffs(task_key) WHERE outcome IS NULL;
      CREATE INDEX task_handoffs_task ON task_handoffs(task_key, started_at);`,
  },
  {
    version: 41,
    name: 'session engine',
    // PM-311: the engine a session runs on; the sessions from before engines ran on the local one.
    sql: `ALTER TABLE sessions ADD COLUMN engine_id TEXT NOT NULL DEFAULT 'local';`,
  },
  {
    version: 42,
    name: 'engine registry and machine keys',
    sql: `CREATE TABLE engines (
    id TEXT NOT NULL PRIMARY KEY,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    revoked_at TEXT,
    revoked_by TEXT REFERENCES users(id),
    last_seen_at TEXT,
    last_seen_ip TEXT,
    last_hello TEXT
  );
  CREATE UNIQUE INDEX engines_one_default ON engines(is_default)
    WHERE is_default = 1 AND revoked_at IS NULL;`,
  },
  {
    version: 43,
    name: 'project focus',
    // PM-427: the project's ordered focus list; position is 1-based, added_by is the Actor as JSON.
    sql: `CREATE TABLE project_focus_items (
    project_key TEXT NOT NULL,
    position INTEGER NOT NULL,
    task_key TEXT NOT NULL,
    added_at TEXT NOT NULL,
    added_by TEXT NOT NULL,
    PRIMARY KEY (project_key, task_key)
  );
  CREATE INDEX project_focus_items_order ON project_focus_items(project_key, position);`,
  },
  {
    version: 44,
    name: 'relayed project manager replies',
    sql: `ALTER TABLE team_messages ADD COLUMN relayed TEXT;`,
  },
  {
    version: 45,
    name: 'task hand-on requests',
    sql: `CREATE TABLE task_hand_ons (
      project_key TEXT NOT NULL,
      task_key TEXT NOT NULL,
      from_stage_id TEXT NOT NULL,
      to_stage_id TEXT NOT NULL,
      mover TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      inbox_item_id TEXT,
      PRIMARY KEY (project_key, task_key)
    );`,
  },
  {
    version: 46,
    name: 'clear stalled fix limits',
    sql: `UPDATE task_fix_limits
          SET hold_phase = NULL, held_at = NULL, decider = NULL, deciders = '[]', reason = NULL, inbox_item_id = NULL
          WHERE hold_phase IS NOT NULL
            AND inbox_item_id IS NOT NULL
            AND (
              NOT EXISTS (SELECT 1 FROM inbox_items WHERE id = task_fix_limits.inbox_item_id)
              OR EXISTS (SELECT 1 FROM inbox_items WHERE id = task_fix_limits.inbox_item_id AND state = 'cancelled')
            );`,
  },
  {
    version: 47,
    name: 'operator requests and steps',
    // PM-463: an owner's request to the Operator and what it did for it; changes and refusal are JSON.
    // operator_request on a message marks one the Operator sent during a request.
    sql: `CREATE TABLE operator_requests (
      id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL,
      session_id TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('message', 'answer')),
      message_id TEXT,
      inbox_item_id TEXT,
      from_handle TEXT NOT NULL,
      quote TEXT NOT NULL,
      opened_at TEXT NOT NULL,
      closed_at TEXT
    );
    CREATE INDEX operator_requests_project ON operator_requests(project_key, opened_at);
    CREATE INDEX operator_requests_session ON operator_requests(session_id) WHERE closed_at IS NULL;
    CREATE TABLE operator_steps (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL REFERENCES operator_requests(id),
      at TEXT NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      task_key TEXT,
      member TEXT,
      changes TEXT NOT NULL DEFAULT '[]',
      config_version TEXT,
      inbox_item_id TEXT,
      refusal TEXT
    );
    CREATE INDEX operator_steps_request ON operator_steps(request_id, at);
    ALTER TABLE team_messages ADD COLUMN operator_request TEXT;`,
  },
  {
    version: 48,
    name: 'member merges and persistent handovers',
    sql: `CREATE TABLE task_merges (
      id TEXT PRIMARY KEY, project_key TEXT NOT NULL, task_key TEXT NOT NULL,
      repo TEXT NOT NULL, base TEXT NOT NULL, "commit" TEXT, branch TEXT,
      from_stage_id TEXT NOT NULL, to_stage_id TEXT NOT NULL, merger TEXT NOT NULL, requested_at TEXT NOT NULL, started_by TEXT, started_at TEXT,
      state TEXT NOT NULL CHECK (state IN ('requested','queued','running','failed','blocked','merged','cancelled')),
      step TEXT, merge_commit TEXT, check_json TEXT, landed TEXT NOT NULL, failure_json TEXT,
      block_json TEXT, pushed_json TEXT, pull_requests_json TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT
    );
    CREATE INDEX task_merges_queue ON task_merges(project_key, repo, state, created_at);
    CREATE UNIQUE INDEX task_merges_open ON task_merges(project_key, task_key)
      WHERE state IN ('requested','queued','running','failed','blocked');
    CREATE TABLE task_handovers (
      project_key TEXT NOT NULL, task_key TEXT NOT NULL, "commit" TEXT NOT NULL,
      branch TEXT NOT NULL, stage_id TEXT NOT NULL, at TEXT NOT NULL,
      PRIMARY KEY (project_key, task_key)
    );
    INSERT INTO task_handovers SELECT project_key, task_key, commit_id, branch, stage_id, pinned_at FROM task_review_pins;`,
  },
  {
    version: 49,
    name: 'merge conflict fixes',
    sql: `DROP INDEX task_merges_queue;
    DROP INDEX task_merges_open;
    ALTER TABLE task_merges RENAME TO task_merges_old;
    CREATE TABLE task_merges (
      id TEXT PRIMARY KEY, project_key TEXT NOT NULL, task_key TEXT NOT NULL,
      repo TEXT NOT NULL, base TEXT NOT NULL, "commit" TEXT, branch TEXT,
      from_stage_id TEXT NOT NULL, to_stage_id TEXT NOT NULL, merger TEXT NOT NULL, requested_at TEXT NOT NULL, started_by TEXT, started_at TEXT,
      state TEXT NOT NULL CHECK (state IN ('requested','queued','running','failed','blocked','fixing','merged','cancelled')),
      step TEXT, merge_commit TEXT, check_json TEXT, landed TEXT NOT NULL, failure_json TEXT,
      block_json TEXT, pushed_json TEXT, pull_requests_json TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT,
      fix_json TEXT, resolution_json TEXT
    );
    INSERT INTO task_merges SELECT *, NULL, NULL FROM task_merges_old;
    DROP TABLE task_merges_old;
    CREATE INDEX task_merges_queue ON task_merges(project_key, repo, state, created_at);
    CREATE UNIQUE INDEX task_merges_open ON task_merges(project_key, task_key)
      WHERE state IN ('requested','queued','running','failed','blocked','fixing');`,
  },
  {
    version: 50,
    name: 'operator signals',
    sql: `CREATE TABLE operator_signals (
    id TEXT PRIMARY KEY, project_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('outage','nobody','stalled','silent')), case_key TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending','open','accepted','dismissed','resolved')),
    actionable INTEGER NOT NULL DEFAULT 0, task_key TEXT, subject TEXT, inbox_item_id TEXT, message_id TEXT,
    raised_at TEXT NOT NULL, decided_by TEXT, decided_at TEXT, resolved_at TEXT, delivered_at TEXT
  );
  CREATE UNIQUE INDEX operator_signals_open ON operator_signals(project_key, case_key) WHERE resolved_at IS NULL;
  ALTER TABLE team_messages ADD COLUMN operator_signal TEXT;`,
  },
  {
    version: 51,
    name: 'releases',
    sql: `CREATE TABLE releases (
      id TEXT PRIMARY KEY, project_key TEXT NOT NULL, repo TEXT NOT NULL, task_key TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('proposed','approved','rejected','deploying','failed','live','published')),
      "commit" TEXT NOT NULL, base_commit TEXT, tasks_json TEXT NOT NULL, summary TEXT NOT NULL,
      proposed_by TEXT NOT NULL, proposed_at TEXT NOT NULL, decided_by TEXT, decided_at TEXT,
      deploy_started_at TEXT, previous_commit TEXT, live_at TEXT,
      tag TEXT, url TEXT, published_at TEXT,
      failure_json TEXT, publish_error TEXT, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX releases_open ON releases(project_key) WHERE state IN ('proposed','approved','deploying');
    CREATE INDEX releases_project ON releases(project_key, proposed_at);`,
  },
  {
    version: 52,
    name: 'doc writes',
    sql: `CREATE TABLE doc_writes (
    id TEXT PRIMARY KEY,
    project_key TEXT NOT NULL,
    repo TEXT NOT NULL,
    base TEXT NOT NULL,
    base_commit TEXT NOT NULL,
    edits TEXT NOT NULL,
    message TEXT NOT NULL,
    author TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    request_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    engine_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued','running','published','stale','failed')),
    commit_sha TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX doc_writes_open ON doc_writes(project_key) WHERE state IN ('queued','running');`,
  },
  {
    version: 53,
    name: 'decision offers',
    sql: `CREATE TABLE decision_offers (
      project_key TEXT NOT NULL,
      item_id TEXT NOT NULL,
      verdict TEXT NOT NULL CHECK (verdict IN ('recorded','declined','skipped')),
      decision TEXT,
      request_id TEXT NOT NULL,
      decided_at TEXT NOT NULL,
      PRIMARY KEY (project_key, item_id)
    );
    CREATE TABLE decision_candidate_state (
      project_key TEXT PRIMARY KEY,
      since TEXT NOT NULL,
      listed_at TEXT
    );
    INSERT INTO decision_candidate_state (project_key, since, listed_at)
      SELECT DISTINCT project_key, strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL FROM inbox_items;`,
  },
  {
    version: 54,
    name: 'message attachments',
    sql: `CREATE TABLE message_attachments (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE, project_key TEXT NOT NULL, message_id TEXT,
      file_name TEXT NOT NULL, size INTEGER NOT NULL, media_type TEXT NOT NULL, preview TEXT NOT NULL,
      uploaded_by_kind TEXT NOT NULL, uploaded_by_handle TEXT NOT NULL, created_at TEXT NOT NULL,
      bound_at TEXT, state TEXT NOT NULL CHECK (state IN ('pending','ready','deleting')),
      deleted_by_kind TEXT, deleted_by_handle TEXT, delete_requested_at TEXT
    );
    CREATE INDEX message_attachments_message ON message_attachments(project_key, message_id);
    CREATE INDEX message_attachments_unsent ON message_attachments(state, message_id, created_at);
    ALTER TABLE team_messages ADD COLUMN attachments TEXT;`,
  },
  {
    version: 55,
    name: 'feedback marks',
    sql: `CREATE TABLE feedback_marks (
      id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL,
      author TEXT NOT NULL,
      surface_id TEXT NOT NULL,
      origin TEXT NOT NULL,
      page_url TEXT NOT NULL,
      page_path TEXT NOT NULL,
      page_title TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('point','area','element','page')),
      body TEXT NOT NULL,
      anchor TEXT NOT NULL,
      environment TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('new','waiting_owner','handled','closed')),
      outcome TEXT CHECK (outcome IN ('card_created','card_linked','answered')),
      task_key TEXT,
      screenshot TEXT,
      handed_to TEXT,
      handed_at TEXT,
      handed_message_id TEXT,
      inbox_item_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT
    );
    CREATE INDEX feedback_marks_project ON feedback_marks (project_key, updated_at);
    CREATE INDEX feedback_marks_task ON feedback_marks (project_key, task_key);
    CREATE TABLE feedback_events (
      id TEXT PRIMARY KEY,
      mark_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      type TEXT NOT NULL,
      body TEXT,
      data TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX feedback_events_mark ON feedback_events (mark_id, created_at);
    CREATE TABLE feedback_launch_codes (
      code_hash TEXT PRIMARY KEY,
      project_key TEXT NOT NULL,
      member TEXT NOT NULL,
      surface_id TEXT NOT NULL,
      origin TEXT NOT NULL,
      app_origin TEXT NOT NULL,
      mark_id TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT
    );
    CREATE TABLE feedback_sessions (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      project_key TEXT NOT NULL,
      member TEXT NOT NULL,
      surface_id TEXT NOT NULL,
      origin TEXT NOT NULL,
      app_origin TEXT NOT NULL,
      user_agent TEXT,
      created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      revoked_by TEXT
    );
    CREATE INDEX feedback_sessions_member ON feedback_sessions (project_key, member);
    CREATE TABLE feedback_marker_colors (
      project_key TEXT NOT NULL,
      member TEXT NOT NULL,
      color_index INTEGER NOT NULL CHECK (color_index BETWEEN 0 AND 7),
      PRIMARY KEY (project_key, member)
    );
    CREATE TABLE feedback_reads (
      project_key TEXT NOT NULL,
      member TEXT NOT NULL,
      mark_id TEXT NOT NULL,
      read_at TEXT NOT NULL,
      -- The last thread entry the member saw (rowid order, so entries made within one millisecond count).
      last_event_rowid INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project_key, member, mark_id)
    );`,
  },
  {
    version: 56,
    name: 'operator signal kinds',
    sql: `DROP INDEX operator_signals_open;
    ALTER TABLE operator_signals RENAME TO operator_signals_old;
    CREATE TABLE operator_signals (
      id TEXT PRIMARY KEY, project_key TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('outage','nobody','stalled','silent','idle','merge_waiting','merge_blocked','unreleased','ready_waiting')), case_key TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending','open','accepted','dismissed','resolved')),
      actionable INTEGER NOT NULL DEFAULT 0, task_key TEXT, subject TEXT, inbox_item_id TEXT, message_id TEXT,
      raised_at TEXT NOT NULL, decided_by TEXT, decided_at TEXT, resolved_at TEXT, delivered_at TEXT
    );
    INSERT INTO operator_signals SELECT id, project_key, kind, case_key, state, actionable, task_key, subject, inbox_item_id, message_id, raised_at, decided_by, decided_at, resolved_at, delivered_at FROM operator_signals_old;
    DROP TABLE operator_signals_old;
    CREATE UNIQUE INDEX operator_signals_open ON operator_signals(project_key, case_key) WHERE resolved_at IS NULL;`,
  },
  {
    version: 57,
    name: 'operator steps on signals',
    // PM-545: the Operator's own steps on a system signal hang on a request row of source 'signal' (the
    // CHECK grows, so both tables are rebuilt: the steps first reference the new requests table, then the
    // old pair goes) and carry the signal's id; a signal remembers when to be looked at again.
    sql: `CREATE TABLE operator_requests_next (
      id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL,
      session_id TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('message', 'answer', 'signal')),
      message_id TEXT,
      inbox_item_id TEXT,
      from_handle TEXT NOT NULL,
      quote TEXT NOT NULL,
      opened_at TEXT NOT NULL,
      closed_at TEXT
    );
    CREATE TABLE operator_steps_next (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL REFERENCES operator_requests_next(id),
      at TEXT NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      task_key TEXT,
      member TEXT,
      changes TEXT NOT NULL DEFAULT '[]',
      config_version TEXT,
      inbox_item_id TEXT,
      refusal TEXT,
      signal_id TEXT
    );
    INSERT INTO operator_requests_next SELECT id, project_key, session_id, source, message_id, inbox_item_id, from_handle, quote, opened_at, closed_at FROM operator_requests;
    INSERT INTO operator_steps_next (id, request_id, at, action, status, task_key, member, changes, config_version, inbox_item_id, refusal)
      SELECT id, request_id, at, action, status, task_key, member, changes, config_version, inbox_item_id, refusal FROM operator_steps;
    DROP TABLE operator_steps;
    DROP TABLE operator_requests;
    ALTER TABLE operator_requests_next RENAME TO operator_requests;
    ALTER TABLE operator_steps_next RENAME TO operator_steps;
    CREATE INDEX operator_requests_project ON operator_requests(project_key, opened_at);
    CREATE INDEX operator_requests_session ON operator_requests(session_id) WHERE closed_at IS NULL;
    CREATE INDEX operator_steps_request ON operator_steps(request_id, at);
    CREATE INDEX operator_steps_signal ON operator_steps(signal_id) WHERE signal_id IS NOT NULL;
    ALTER TABLE operator_signals ADD COLUMN follow_up_at TEXT;`,
  },
  {
    version: 58,
    name: 'merge queue priority',
    // PM-576: a queued merge the merger (or the Operator) put forward carries the time of that decision;
    // the queue puts such merges first, the latest decision first, and the rest by created_at as before.
    sql: `ALTER TABLE task_merges ADD COLUMN prioritized_at TEXT;`,
  },
  {
    version: 59,
    name: 'operator signal dismissal note',
    sql: 'ALTER TABLE operator_signals ADD COLUMN decision_note TEXT;',
  },
  {
    version: 60,
    name: 'durable merge trains',
    sql: `CREATE TABLE merge_trains (
      id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL,
      repo TEXT NOT NULL,
      state TEXT NOT NULL,
      record_json TEXT NOT NULL
    );
    CREATE UNIQUE INDEX merge_trains_running ON merge_trains(project_key, repo) WHERE state = 'running';
    ALTER TABLE task_merges ADD COLUMN train_id TEXT;`,
  },
  {
    version: 61,
    name: 'email login',
    // PM-670: the one-time e-mail login code of invited clients and the durable limits around it. Only
    // keyed hashes are stored (HMAC of the address, of the client IP and of the code): never an open
    // address, IP or code. One live code per address; a new one overwrites the old.
    sql: `CREATE TABLE email_login_codes (
      address_hash TEXT PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      code_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      used_at TEXT
    );
    CREATE TABLE email_login_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK (kind IN ('request', 'send', 'verify')),
      subject TEXT NOT NULL,
      at TEXT NOT NULL
    );
    CREATE INDEX email_login_events_subject ON email_login_events(kind, subject, at);
    CREATE INDEX email_login_events_at ON email_login_events(at);
    CREATE INDEX invitations_email ON invitations(email);`,
  },
  {
    version: 62,
    name: 'session work metadata',
    // PM-694: what a session's chat proves about its work (last step, last tool, last error code), kept
    // without any chat text as JSON; NULL for every session from before it.
    sql: 'ALTER TABLE sessions ADD COLUMN work_metadata TEXT;',
  },
  {
    version: 63,
    name: 'answer stalled signal kind',
    // PM-694: the kind CHECK grows by 'answer_stalled', so the table is rebuilt as in version 56, with
    // the columns added since (follow_up_at, decision_note).
    sql: `DROP INDEX operator_signals_open;
    ALTER TABLE operator_signals RENAME TO operator_signals_old;
    CREATE TABLE operator_signals (
      id TEXT PRIMARY KEY, project_key TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('outage','nobody','stalled','silent','idle','merge_waiting','merge_blocked','unreleased','ready_waiting','answer_stalled')), case_key TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending','open','accepted','dismissed','resolved')),
      actionable INTEGER NOT NULL DEFAULT 0, task_key TEXT, subject TEXT, inbox_item_id TEXT, message_id TEXT,
      raised_at TEXT NOT NULL, decided_by TEXT, decided_at TEXT, resolved_at TEXT, delivered_at TEXT,
      follow_up_at TEXT, decision_note TEXT
    );
    INSERT INTO operator_signals SELECT id, project_key, kind, case_key, state, actionable, task_key, subject, inbox_item_id, message_id, raised_at, decided_by, decided_at, resolved_at, delivered_at, follow_up_at, decision_note FROM operator_signals_old ORDER BY rowid;
    DROP TABLE operator_signals_old;
    CREATE UNIQUE INDEX operator_signals_open ON operator_signals(project_key, case_key) WHERE resolved_at IS NULL;`,
  },
  {
    version: 64,
    name: 'merge train diagnostics',
    sql: 'ALTER TABLE task_merges ADD COLUMN diagnostic_json TEXT;',
  },
  {
    version: 65,
    name: 'operator knowledge approval requests',
    // Grow the source CHECK while retaining every request, step and signal link.
    sql: `CREATE TABLE operator_requests_next (
      id TEXT PRIMARY KEY, project_key TEXT NOT NULL, session_id TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('message', 'answer', 'signal', 'approval')),
      message_id TEXT, inbox_item_id TEXT, from_handle TEXT NOT NULL, quote TEXT NOT NULL,
      opened_at TEXT NOT NULL, closed_at TEXT
    );
    CREATE TABLE operator_steps_next (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES operator_requests_next(id),
      at TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL, task_key TEXT, member TEXT,
      changes TEXT NOT NULL DEFAULT '[]', config_version TEXT, inbox_item_id TEXT, refusal TEXT, signal_id TEXT
    );
    INSERT INTO operator_requests_next SELECT id, project_key, session_id, source, message_id, inbox_item_id, from_handle, quote, opened_at, closed_at FROM operator_requests;
    INSERT INTO operator_steps_next SELECT id, request_id, at, action, status, task_key, member, changes, config_version, inbox_item_id, refusal, signal_id FROM operator_steps;
    DROP TABLE operator_steps;
    DROP TABLE operator_requests;
    ALTER TABLE operator_requests_next RENAME TO operator_requests;
    ALTER TABLE operator_steps_next RENAME TO operator_steps;
    CREATE INDEX operator_requests_project ON operator_requests(project_key, opened_at);
    CREATE INDEX operator_requests_session ON operator_requests(session_id) WHERE closed_at IS NULL;
    CREATE INDEX operator_steps_request ON operator_steps(request_id, at);
    CREATE INDEX operator_steps_signal ON operator_steps(signal_id) WHERE signal_id IS NOT NULL;`,
  },
  {
    version: 66,
    name: 'session process cleanup signals',
    sql: `DROP INDEX operator_signals_open;
    ALTER TABLE operator_signals RENAME TO operator_signals_old;
    CREATE TABLE operator_signals (
      id TEXT PRIMARY KEY, project_key TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('outage','nobody','stalled','silent','idle','merge_waiting','merge_blocked','unreleased','ready_waiting','answer_stalled','process_cleanup_failed')), case_key TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending','open','accepted','dismissed','resolved')),
      actionable INTEGER NOT NULL DEFAULT 0, task_key TEXT, subject TEXT, inbox_item_id TEXT, message_id TEXT,
      raised_at TEXT NOT NULL, decided_by TEXT, decided_at TEXT, resolved_at TEXT, delivered_at TEXT,
      follow_up_at TEXT, decision_note TEXT
    );
    INSERT INTO operator_signals SELECT id, project_key, kind, case_key, state, actionable, task_key, subject, inbox_item_id, message_id, raised_at, decided_by, decided_at, resolved_at, delivered_at, follow_up_at, decision_note FROM operator_signals_old ORDER BY rowid;
    DROP TABLE operator_signals_old;
    CREATE UNIQUE INDEX operator_signals_open ON operator_signals(project_key, case_key) WHERE resolved_at IS NULL;`,
  },
  {
    version: 67,
    name: 'workspace process scope reservation',
    sql: `ALTER TABLE member_workspaces ADD COLUMN holder_scope_id TEXT;
    ALTER TABLE member_workspaces ADD COLUMN holder_cleanup_failed INTEGER NOT NULL DEFAULT 0;`,
  },
  {
    version: 68,
    name: 'unresolved session process scopes',
    sql: `CREATE TABLE session_cleanups (
      scope_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, project_key TEXT NOT NULL,
      task_key TEXT, kind TEXT NOT NULL, survivors INTEGER NOT NULL,
      failed_at TEXT NOT NULL, last_attempt_at TEXT, attempts INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX session_cleanups_session ON session_cleanups(session_id);`,
  },
  {
    version: 69,
    name: 'coordination signal recipient',
    sql: 'ALTER TABLE operator_signals ADD COLUMN delivered_to TEXT;',
  },
  {
    version: 70,
    name: 'operator execution journal and approval provenance',
    sql: `ALTER TABLE operator_steps ADD COLUMN agreement_version INTEGER NULL;
    ALTER TABLE operator_steps ADD COLUMN approval_mode TEXT NULL;
    CREATE TABLE operator_execution_intents (
      id TEXT PRIMARY KEY, project_key TEXT NOT NULL, request_id TEXT NOT NULL,
      operation TEXT NOT NULL, changes TEXT NOT NULL, agreement_version INTEGER NULL,
      approval_mode TEXT NOT NULL CHECK (approval_mode IN ('click','waived')),
      status TEXT NOT NULL CHECK (status IN ('prepared','committed','failed')),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, config_version TEXT NULL, refusal TEXT NULL
    );`,
  },
  {
    // PM-702: the kind CHECK grows by 'refinement_stalled', so the table is rebuilt as in version 66; the
    // columns, rows and the open-case index stay as they are.
    version: 71,
    name: 'refinement stalled signals',
    sql: `DROP INDEX operator_signals_open;
    ALTER TABLE operator_signals RENAME TO operator_signals_old;
    CREATE TABLE operator_signals (
      id TEXT PRIMARY KEY, project_key TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('outage','nobody','stalled','silent','idle','merge_waiting','merge_blocked','unreleased','ready_waiting','answer_stalled','process_cleanup_failed','refinement_stalled')), case_key TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending','open','accepted','dismissed','resolved')),
      actionable INTEGER NOT NULL DEFAULT 0, task_key TEXT, subject TEXT, inbox_item_id TEXT, message_id TEXT,
      raised_at TEXT NOT NULL, decided_by TEXT, decided_at TEXT, resolved_at TEXT, delivered_at TEXT,
      follow_up_at TEXT, decision_note TEXT, delivered_to TEXT
    );
    INSERT INTO operator_signals SELECT id, project_key, kind, case_key, state, actionable, task_key, subject, inbox_item_id, message_id, raised_at, decided_by, decided_at, resolved_at, delivered_at, follow_up_at, decision_note, delivered_to FROM operator_signals_old ORDER BY rowid;
    DROP TABLE operator_signals_old;
    CREATE UNIQUE INDEX operator_signals_open ON operator_signals(project_key, case_key) WHERE resolved_at IS NULL;`,
  },
];
// PM-695 retains the original inbox rows, including their question text and provenance.
migrations.push({
  version: 72,
  name: 'shared owner questions',
  sql: `CREATE TABLE question_groups (
    primary_item_id TEXT PRIMARY KEY, project_key TEXT NOT NULL, question TEXT NOT NULL,
    created_at TEXT NOT NULL, by_handle TEXT NOT NULL, note TEXT NOT NULL
  );
  CREATE TABLE question_group_items (
    item_id TEXT NOT NULL UNIQUE, primary_item_id TEXT NOT NULL REFERENCES question_groups(primary_item_id)
  );
  CREATE INDEX question_group_members ON question_group_items(primary_item_id);
  CREATE INDEX team_messages_question_answer ON team_messages(project_key, json_extract(origin, '$.inboxItemId'))
    WHERE json_extract(origin, '$.kind') = 'answer';`,
});
migrations.push({
  version: 73,
  name: 'PM loop triage',
  sql: `ALTER TABLE task_loops ADD COLUMN triage_json TEXT NULL;
    DROP INDEX operator_signals_open;
    ALTER TABLE operator_signals RENAME TO operator_signals_old;
    CREATE TABLE operator_signals (
      id TEXT PRIMARY KEY, project_key TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('outage','nobody','stalled','silent','idle','merge_waiting','merge_blocked','unreleased','ready_waiting','answer_stalled','process_cleanup_failed','refinement_stalled','loop_suspected')), case_key TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending','open','accepted','dismissed','resolved')),
      actionable INTEGER NOT NULL DEFAULT 0, task_key TEXT, subject TEXT, inbox_item_id TEXT, message_id TEXT,
      raised_at TEXT NOT NULL, decided_by TEXT, decided_at TEXT, resolved_at TEXT, delivered_at TEXT,
      follow_up_at TEXT, decision_note TEXT, delivered_to TEXT
    );
    INSERT INTO operator_signals SELECT id, project_key, kind, case_key, state, actionable, task_key, subject, inbox_item_id, message_id, raised_at, decided_by, decided_at, resolved_at, delivered_at, follow_up_at, decision_note, delivered_to FROM operator_signals_old ORDER BY rowid;
    DROP TABLE operator_signals_old;
    CREATE UNIQUE INDEX operator_signals_open ON operator_signals(project_key, case_key) WHERE resolved_at IS NULL;`,
});
migrations.push({
  version: 74,
  name: 'report only structural review signals',
  sql: `DROP INDEX operator_signals_open;
    ALTER TABLE operator_signals RENAME TO operator_signals_old;
    CREATE TABLE operator_signals (
      id TEXT PRIMARY KEY, project_key TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('outage','nobody','stalled','silent','idle','merge_waiting','merge_blocked','unreleased','ready_waiting','answer_stalled','process_cleanup_failed','refinement_stalled','loop_suspected','structural_pattern','milestone_closed')), case_key TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending','open','accepted','dismissed','resolved')),
      actionable INTEGER NOT NULL DEFAULT 0, task_key TEXT, subject TEXT, inbox_item_id TEXT, message_id TEXT,
      raised_at TEXT NOT NULL, decided_by TEXT, decided_at TEXT, resolved_at TEXT, delivered_at TEXT,
      follow_up_at TEXT, decision_note TEXT, delivered_to TEXT
    );
    INSERT INTO operator_signals (id, project_key, kind, case_key, state, actionable, task_key, subject, inbox_item_id, message_id, raised_at, decided_by, decided_at, resolved_at, delivered_at, follow_up_at, decision_note, delivered_to)
      SELECT id, project_key, kind, case_key, state, actionable, task_key, subject, inbox_item_id, message_id, raised_at, decided_by, decided_at, resolved_at, delivered_at, follow_up_at, decision_note, delivered_to FROM operator_signals_old ORDER BY rowid;
    DROP TABLE operator_signals_old;
    CREATE UNIQUE INDEX operator_signals_open ON operator_signals(project_key, case_key) WHERE resolved_at IS NULL;`,
});
migrations.push({
  version: 75,
  name: 'hybrid release deployments',
  // One row per release attempt. `phase`, `maintenance` and `revision` repeat what `data_json` holds so the
  // database itself can enforce the one active deployment of the instance and the fence can be read without
  // parsing; the repository writes them in one statement. Requests are kept to answer a repeat the same way.
  sql: `CREATE TABLE release_deployments (
      release_id TEXT PRIMARY KEY REFERENCES releases(id),
      attempt_id TEXT NOT NULL UNIQUE,
      controller_id TEXT NOT NULL,
      phase TEXT NOT NULL CHECK (phase IN ('preparing','prepared','quiescing','switching','live','failed','published','recovery_required')),
      maintenance INTEGER NOT NULL CHECK (maintenance IN (0,1)),
      revision INTEGER NOT NULL,
      data_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX release_deployments_active ON release_deployments((1))
      WHERE maintenance = 1 OR phase IN ('preparing','prepared','quiescing','switching','recovery_required');
    CREATE TABLE release_deployment_requests (
      request_id TEXT PRIMARY KEY,
      release_id TEXT NOT NULL REFERENCES releases(id),
      attempt_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      resulting_revision INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX release_deployment_requests_release ON release_deployment_requests(release_id);`,
});
migrations.push({
  version: 76,
  name: 'super mode actor origin and operation audit',
  // PM-757: the Operator's super mode keeps its origin (operatorMode, credential id and prefix) in a nullable
  // JSON column next to the old actor columns, which stay as they are; every old row has NULL. The audit is
  // append-only and holds only an operation's name and target, never a request or a raw error.
  sql: `ALTER TABLE timeline_events ADD COLUMN actor_meta TEXT;
    ALTER TABLE team_messages ADD COLUMN actor_meta TEXT;
    CREATE TABLE super_operation_audit (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      project_key TEXT NOT NULL,
      task_key TEXT,
      key_id TEXT NOT NULL,
      prefix TEXT NOT NULL,
      request_id TEXT NOT NULL,
      handoff_id TEXT,
      operation TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('started','succeeded','refused','failed','unknown')),
      error_code TEXT,
      settles_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX super_operation_audit_settles ON super_operation_audit(settles_id);
    CREATE INDEX super_operation_audit_project ON super_operation_audit(project_key, seq);
    CREATE INDEX super_operation_audit_prefix ON super_operation_audit(project_key, prefix, seq);`,
});
migrations.push({
  version: 77,
  name: 'pending message recipients',
  sql: `CREATE TABLE team_message_pending (
      message_id TEXT NOT NULL REFERENCES team_messages(id) ON DELETE CASCADE,
      project_key TEXT NOT NULL,
      handle TEXT NOT NULL,
      seq INTEGER NOT NULL,
      PRIMARY KEY (message_id, handle)
    );
    CREATE INDEX team_message_pending_recipient ON team_message_pending(project_key, handle, seq);
    INSERT INTO team_message_pending (message_id, project_key, handle, seq)
      ${PENDING_MESSAGE_RECIPIENTS};`,
});
migrations.push({
  version: 78,
  name: 'task scheduling read indexes',
  // PM-770: the narrow sets the scheduler reads by (`TaskSchedulingQuery`): the cards a free developer
  // may pull, the open cards, and the closed cards whose worktree may be swept. Each stays small while
  // the closed history grows. Additive: nothing is rewritten.
  sql: `CREATE INDEX tasks_scheduling_pull
      ON tasks(project_key, stage_id, priority, seq)
      WHERE kind = 'task' AND status = 'active' AND assignee IS NULL;
    CREATE INDEX tasks_scheduling_open
      ON tasks(project_key, seq)
      WHERE status NOT IN ('done', 'cancelled');
    CREATE INDEX tasks_scheduling_closed
      ON tasks(project_key, seq)
      WHERE kind = 'task' AND status IN ('done', 'cancelled') AND closed_at IS NOT NULL;`,
});
migrations.push({
  version: 79,
  name: 'explicit integrator key modes and lifecycle audit',
  sql: `ALTER TABLE integrator_keys ADD COLUMN mode TEXT NOT NULL DEFAULT 'legacy'
      CHECK (mode IN ('legacy','super','read'));
    ALTER TABLE integrator_keys ADD COLUMN last_used_channel TEXT
      CHECK (last_used_channel IN ('mcp','cli','rest'));
    CREATE UNIQUE INDEX integrator_keys_active_mode ON integrator_keys(user_id, mode)
      WHERE revoked_at IS NULL;
    CREATE TABLE integrator_key_audit (
      seq INTEGER PRIMARY KEY,
      key_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('created','revoked')),
      prefix TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('legacy','super','read')),
      at TEXT NOT NULL
    );
    CREATE INDEX integrator_key_audit_owner ON integrator_key_audit(owner_user_id, seq);`,
});
migrations.push({
  version: 80,
  name: 'timeline task state before index',
  // PM-771: `latestTaskStatesBefore` finds a card's last state-setting event before a time (the starting
  // state of a sibling reconstruction) from the state events alone, never walking its notes and messages.
  // The structural evidence of the fixed seven-day window (`structuralEvidence`) is found by the creation
  // time of its six detector event types instead of a walk of the project's whole timeline.
  // Partial and additive: only those event types are indexed; nothing is rewritten.
  sql: `CREATE INDEX timeline_task_state_before
      ON timeline_events(project_key, task_key, created_at, seq)
      WHERE type IN ('task_stage_changed', 'task_updated');
    CREATE INDEX timeline_structural_window
      ON timeline_events(project_key, created_at)
      WHERE type IN ('task_merge_requested', 'task_merge_failed', 'task_full_test',
        'task_stage_changed', 'task_labels_changed', 'task_updated');`,
});
migrations.push({
  version: 81,
  name: 'durable project change journal',
  // PM-761: change signals scripts and the integrator can read again with a cursor. The journal starts
  // empty (no history is made up); triggers on the state tables write it in the changing transaction
  // (db/change-triggers.ts). `project_change_generation` is made once with the database; a restore from a
  // snapshot must replace it (docs/ARCHITECTURE.md "Project change journal").
  sql: `CREATE TABLE instance_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT INTO instance_meta (key, value)
      SELECT 'project_change_generation',
        lower(substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-4' || substr(h, 14, 3) || '-' ||
          substr('89ab', 1 + abs(random()) % 4, 1) || substr(h, 18, 3) || '-' || substr(h, 21, 12))
      FROM (SELECT hex(randomblob(16)) AS h);
    CREATE TABLE project_change_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      project_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      entity_id TEXT,
      at TEXT NOT NULL
    );
    CREATE INDEX project_change_events_project ON project_change_events(project_key, seq);
    ${changeTriggersSql()}`,
});
migrations.push({
  version: 82,
  name: 'repository merge queue revisions and order',
  sql: `CREATE TABLE merge_queue_revisions (
      project_key TEXT NOT NULL,
      repo TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project_key, repo)
    );
    INSERT INTO merge_queue_revisions (project_key, repo)
      SELECT DISTINCT project_key, repo FROM task_merges;
    ALTER TABLE task_merges ADD COLUMN queue_rank INTEGER;`,
});
migrations.push({
  version: 83,
  name: 'super mode durable handoffs and operations',
  // PM-762: what the base Operator hands over to the super-mode integrator survives a restart, and what the
  // integrator starts from it is one record per (project, token, request id). `revision` is the CAS counter of
  // the state machine; `command_hash` pins the exact command the owner's yes was given for.
  sql: `CREATE TABLE super_handoffs (
      id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL REFERENCES projects(key) ON DELETE CASCADE,
      task_key TEXT,
      request_id TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      reason TEXT NOT NULL,
      command TEXT NOT NULL,
      command_hash TEXT NOT NULL,
      expected_config_version TEXT,
      state TEXT NOT NULL,
      operation_id TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (project_key, request_id)
    );
    CREATE INDEX super_handoffs_state ON super_handoffs(project_key, state, created_at);
    CREATE TABLE super_operations (
      id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL REFERENCES projects(key) ON DELETE CASCADE,
      task_key TEXT,
      key_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      handoff_id TEXT,
      command TEXT NOT NULL,
      command_hash TEXT NOT NULL,
      expected_config_version TEXT,
      state TEXT NOT NULL,
      owner_question_id TEXT,
      expires_at TEXT,
      error_code TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (project_key, key_id, request_id)
    );
    CREATE INDEX super_operations_state ON super_operations(project_key, state);
    CREATE INDEX super_operations_handoff ON super_operations(handoff_id);
    ${V83_CHANGE_TRIGGER_TABLES.map(changeTriggerSql).join('\n')}`,
});
/** One trigger of a history source table: record that the source changed (never decide anything about it). */
function historyDirtyTrigger(
  name: string,
  when: string,
  on: string,
  row: 'new' | 'old',
  type: string,
  id: string,
) {
  return `CREATE TRIGGER history_dirty_${name} AFTER ${on} BEGIN
      INSERT INTO history_dirty (project_key, source_type, entity_id)
        SELECT ${row}.project_key, '${type}', ${row}.${id} WHERE ${when}
        ON CONFLICT (project_key, source_type, entity_id) DO UPDATE SET revision = revision + 1;
    END;`;
}
const NOTE_ROW = "type = 'task_note'";
const HISTORY_DIRTY_TRIGGERS_SQL = [
  historyDirtyTrigger('task_ai', '1', 'INSERT ON tasks', 'new', 'task', 'id'),
  historyDirtyTrigger(
    'task_au',
    '1',
    'UPDATE OF title, description, created_by, updated_at ON tasks',
    'new',
    'task',
    'id',
  ),
  historyDirtyTrigger('task_ad', '1', 'DELETE ON tasks', 'old', 'task', 'id'),
  historyDirtyTrigger('note_ai', `new.${NOTE_ROW}`, 'INSERT ON timeline_events', 'new', 'note', 'id'),
  historyDirtyTrigger(
    'note_au',
    `new.${NOTE_ROW}`,
    'UPDATE OF type, task_key, actor_handle, data, created_at ON timeline_events',
    'new',
    'note',
    'id',
  ),
  historyDirtyTrigger(
    'note_au_old',
    `old.${NOTE_ROW} AND new.type <> 'task_note'`,
    'UPDATE OF type ON timeline_events',
    'old',
    'note',
    'id',
  ),
  historyDirtyTrigger('note_ad', `old.${NOTE_ROW}`, 'DELETE ON timeline_events', 'old', 'note', 'id'),
  historyDirtyTrigger('question_ai', '1', 'INSERT ON inbox_items', 'new', 'question', 'id'),
  historyDirtyTrigger('question_au', '1', 'UPDATE ON inbox_items', 'new', 'question', 'id'),
  historyDirtyTrigger('question_ad', '1', 'DELETE ON inbox_items', 'old', 'question', 'id'),
  historyDirtyTrigger('message_ai', '1', 'INSERT ON team_messages', 'new', 'message', 'id'),
  // A delivery receipt (`delivered_at`, `receipts`) changes no searchable text.
  historyDirtyTrigger(
    'message_au',
    '1',
    'UPDATE OF body, answer, origin, from_handle, to_handles, task_key, created_at ON team_messages',
    'new',
    'message',
    'id',
  ),
  historyDirtyTrigger('message_ad', '1', 'DELETE ON team_messages', 'old', 'message', 'id'),
].join('\n    ');
migrations.push({
  version: 84,
  name: 'history search index',
  // PM-786: a durable full-text index of the project history (cards, notes, closed questions, team messages and
  // the two project documents). `history_documents` holds the searchable projection only, never an access copy:
  // who may read a hit is decided from the live source at query time. The triggers on the four source tables
  // only record WHICH source changed (`history_dirty`, in the writing transaction); the indexer reads the
  // current source and updates the projection. `history_index_state` is the backfill's checkpoint.
  sql: `CREATE TABLE history_documents (
      id INTEGER PRIMARY KEY,
      source_id TEXT NOT NULL UNIQUE,
      project_key TEXT NOT NULL REFERENCES projects(key) ON DELETE CASCADE,
      source_type TEXT NOT NULL CHECK (source_type IN ('task', 'note', 'question', 'message', 'document')),
      entity_id TEXT NOT NULL,
      task_key TEXT,
      author TEXT,
      at TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      repo TEXT,
      path TEXT,
      commit_sha TEXT
    );
    CREATE INDEX history_documents_type_at ON history_documents(project_key, source_type, at);
    CREATE INDEX history_documents_task ON history_documents(project_key, task_key);
    CREATE UNIQUE INDEX history_documents_entity ON history_documents(project_key, source_type, entity_id);
    CREATE VIRTUAL TABLE history_fts USING fts5(
      title, body,
      content='history_documents', content_rowid='id',
      tokenize='unicode61 remove_diacritics 2', prefix='3 4 5'
    );
    CREATE TRIGGER history_documents_ai AFTER INSERT ON history_documents BEGIN
      INSERT INTO history_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
    END;
    CREATE TRIGGER history_documents_ad AFTER DELETE ON history_documents BEGIN
      INSERT INTO history_fts(history_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
    END;
    CREATE TRIGGER history_documents_au AFTER UPDATE OF title, body ON history_documents BEGIN
      INSERT INTO history_fts(history_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
      INSERT INTO history_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
    END;
    CREATE TABLE history_dirty (
      project_key TEXT NOT NULL,
      source_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (project_key, source_type, entity_id)
    );
    CREATE TABLE history_index_state (
      project_key TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      complete INTEGER NOT NULL DEFAULT 0,
      source_type TEXT,
      last_id TEXT
    );
    CREATE TABLE history_doc_state (
      project_key TEXT NOT NULL,
      repo TEXT NOT NULL,
      path TEXT NOT NULL,
      commit_sha TEXT,
      checked_at TEXT,
      indexed_at TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'stale', 'unavailable', 'missing')),
      PRIMARY KEY (project_key, repo, path)
    );
    ${HISTORY_DIRTY_TRIGGERS_SQL}`,
});
migrations.push({
  version: 85,
  name: 'history search log',
  // PM-787: the private measurement of the history search. One row per authenticated, authorized, valid search,
  // with the text of the request: it lives in this table only (never in the index, the timeline or a log) and
  // is purged after 90 days. `via` is 'integrator' for a search made through an integrator key.
  sql: `CREATE TABLE history_searches (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      member TEXT NOT NULL,
      project_key TEXT NOT NULL REFERENCES projects(key) ON DELETE CASCADE,
      via TEXT,
      query TEXT NOT NULL,
      filters TEXT NOT NULL,
      result_count INTEGER,
      has_more INTEGER,
      outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'error')),
      error_code TEXT
    );
    CREATE INDEX history_searches_project_at ON history_searches(project_key, at, id);
    CREATE INDEX history_searches_member_at ON history_searches(project_key, member, at);`,
});
migrations.push({
  version: 86,
  name: 'arm coordinator-only signals without retroactive notifications',
  sql: `CREATE TABLE operator_signal_arms (
      project_key TEXT NOT NULL REFERENCES projects(key) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      armed_at TEXT NOT NULL,
      PRIMARY KEY (project_key, kind)
    );
    UPDATE operator_signals SET state = 'resolved',
      resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      decision_note = 'PM-780: retroactive report-only signal closed at upgrade'
      WHERE kind IN ('structural_pattern', 'milestone_closed')
        AND resolved_at IS NULL AND state IN ('pending', 'open');`,
});
migrations.push({
  version: 87,
  name: 'external origin of document writes',
  // PM-784: a document write made through the bearer MCP has no Operator request, step or requesting owner;
  // it carries the verified external origin instead (`external_origin`, JSON). The three old columns become
  // nullable, so an old row stays as it is (origin NULL) and a new external row leaves them NULL. The table
  // is rebuilt, which drops its journal triggers and its open-write index: both are created again.
  sql: `DROP TRIGGER doc_writes_change_insert;
    DROP TRIGGER doc_writes_change_update;
    DROP INDEX doc_writes_open;
    ALTER TABLE doc_writes RENAME TO doc_writes_old;
    CREATE TABLE doc_writes (
      id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL,
      repo TEXT NOT NULL,
      base TEXT NOT NULL,
      base_commit TEXT NOT NULL,
      edits TEXT NOT NULL,
      message TEXT NOT NULL,
      author TEXT NOT NULL,
      requested_by TEXT,
      request_id TEXT,
      step_id TEXT,
      engine_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('queued','running','published','stale','failed')),
      commit_sha TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      external_origin TEXT
    );
    INSERT INTO doc_writes (id, project_key, repo, base, base_commit, edits, message, author, requested_by,
        request_id, step_id, engine_id, state, commit_sha, error, created_at, updated_at, external_origin)
      SELECT id, project_key, repo, base, base_commit, edits, message, author, requested_by,
        request_id, step_id, engine_id, state, commit_sha, error, created_at, updated_at, NULL
      FROM doc_writes_old ORDER BY rowid;
    DROP TABLE doc_writes_old;
    CREATE UNIQUE INDEX doc_writes_open ON doc_writes(project_key) WHERE state IN ('queued','running');
    ${changeTriggerSql({
      table: 'doc_writes',
      kind: 'operation',
      on: ['INSERT', 'UPDATE'],
      project: (row) => `${row}.project_key`,
      entity: (row) => `${row}.id`,
    })}`,
});
migrations.push({
  version: 88,
  name: 'obligations',
  // PM-806: an open step with a responsible and a deadline (merge, work, review step, refinement turn). It has
  // at most one reminder (`woken_at`) and at most one integrator todo (`inbox_item_id`), also after a restart.
  // Bookkeeping only: its wake and hand-over are timeline events, so the table is not in the change journal.
  sql: `CREATE TABLE obligations (
      id              TEXT PRIMARY KEY,
      project_key     TEXT NOT NULL,
      task_key        TEXT NOT NULL,
      kind            TEXT NOT NULL CHECK (kind IN ('merge','fix_limit','refinement_turn','review_step','work')),
      responsible     TEXT NOT NULL,
      subject         TEXT NOT NULL,
      opened_at       TEXT NOT NULL,
      due_at          TEXT NOT NULL,
      paused_since    TEXT,
      pause_reason    TEXT CHECK (pause_reason IN ('held','inbox','permission','start_refused')),
      woken_at        TEXT,
      handed_over_at  TEXT,
      inbox_item_id   TEXT,
      state           TEXT NOT NULL CHECK (state IN ('open','handed_over','fulfilled','cancelled')),
      closed_at       TEXT,
      updated_at      TEXT NOT NULL
    );
    CREATE UNIQUE INDEX obligations_unique ON obligations(project_key, task_key, kind, responsible, subject);
    CREATE INDEX obligations_state ON obligations(state);`,
});
migrations.push({
  version: 89,
  name: 'obligation reminders carry their obligation',
  // PM-813: a reminder that waits undelivered is dropped once its obligation is closed. The reminders written
  // before this carry no subject; the obligation of each waiting one is its row on the same card and
  // responsible that was woken last before the message (the only reminder one row ever sends). The sweep
  // then discards the waiting reminders whose obligation is closed. A reminder with no such row is left alone.
  sql: `UPDATE team_messages SET subject = json_object('type', 'obligation', 'obligationId',
        (SELECT o.id FROM obligations AS o
          WHERE o.project_key = team_messages.project_key AND o.task_key = team_messages.task_key
            AND o.responsible = json_extract(team_messages.to_handles, '$[0]')
            AND o.woken_at IS NOT NULL AND o.woken_at <= team_messages.created_at
          ORDER BY o.woken_at DESC LIMIT 1))
    WHERE from_handle = 'system' AND subject IS NULL AND task_key IS NOT NULL
      AND body LIKE 'projectman reminder:%'
      AND json_valid(to_handles) AND json_array_length(to_handles) = 1
      AND id IN (SELECT message_id FROM team_message_pending)
      AND EXISTS (SELECT 1 FROM obligations AS o
          WHERE o.project_key = team_messages.project_key AND o.task_key = team_messages.task_key
            AND o.responsible = json_extract(team_messages.to_handles, '$[0]')
            AND o.woken_at IS NOT NULL AND o.woken_at <= team_messages.created_at);`,
});
migrations.push({
  version: 90,
  name: 'start obligation kind',
  // PM-804: the kind CHECK grows by 'start' (the offer to start a ready card), so the table is rebuilt as in
  // version 63; the rows and the indexes stay as they are.
  sql: `DROP INDEX obligations_unique;
    DROP INDEX obligations_state;
    ALTER TABLE obligations RENAME TO obligations_old;
    CREATE TABLE obligations (
      id              TEXT PRIMARY KEY,
      project_key     TEXT NOT NULL,
      task_key        TEXT NOT NULL,
      kind            TEXT NOT NULL CHECK (kind IN ('merge','fix_limit','refinement_turn','review_step','work','start')),
      responsible     TEXT NOT NULL,
      subject         TEXT NOT NULL,
      opened_at       TEXT NOT NULL,
      due_at          TEXT NOT NULL,
      paused_since    TEXT,
      pause_reason    TEXT CHECK (pause_reason IN ('held','inbox','permission','start_refused')),
      woken_at        TEXT,
      handed_over_at  TEXT,
      inbox_item_id   TEXT,
      state           TEXT NOT NULL CHECK (state IN ('open','handed_over','fulfilled','cancelled')),
      closed_at       TEXT,
      updated_at      TEXT NOT NULL
    );
    INSERT INTO obligations SELECT id, project_key, task_key, kind, responsible, subject, opened_at, due_at, paused_since, pause_reason, woken_at, handed_over_at, inbox_item_id, state, closed_at, updated_at FROM obligations_old ORDER BY rowid;
    DROP TABLE obligations_old;
    CREATE UNIQUE INDEX obligations_unique ON obligations(project_key, task_key, kind, responsible, subject);
    CREATE INDEX obligations_state ON obligations(state);`,
});
migrations.push({
  version: 91,
  name: 'hot read indexes',
  // PM-834: additive indexes for frequent reads in sweeps, board cards and session lifecycle management
  // (`inbox.listOpen`, `inbox.listOpenOfKind`, `taskMerges.latestMerged`, `taskLoops.open`,
  // `taskLoops.lastEndedAt`, `timeline.ofProjectType`, `sessions.listInStates`).
  sql: `CREATE INDEX inbox_open ON inbox_items(seq) WHERE state = 'open';
    CREATE INDEX task_merges_task ON task_merges(project_key, task_key, state, finished_at);
    CREATE INDEX task_loops_task_key ON task_loops(task_key, ended_at);
    CREATE INDEX timeline_project_type ON timeline_events(project_key, type, seq);
    CREATE INDEX sessions_state ON sessions(state);`,
});
migrations.push({
  version: 92,
  name: 'merge check runs',
  // PM-876: every merge check (a card's merge, a train's group check, a member's diagnosis) with the time and
  // worker count the hub passed and the step measurements the engine reported (`report_json`, null: unknown).
  // The task rows hold the cards of a run in train order and are written in the run's transaction.
  sql: `CREATE TABLE merge_check_runs (
      id           TEXT PRIMARY KEY,
      project_key  TEXT NOT NULL REFERENCES projects(key),
      repo         TEXT NOT NULL,
      kind         TEXT NOT NULL CHECK (kind IN ('merge','train','diagnose')),
      train_id     TEXT,
      commit_sha   TEXT NOT NULL,
      base         TEXT,
      status       TEXT NOT NULL CHECK (status IN ('running','passed','failed','error','cancelled')),
      reason       TEXT,
      max_workers  INTEGER NOT NULL,
      requested_at TEXT NOT NULL,
      started_at   TEXT,
      finished_at  TEXT,
      duration_ms  INTEGER,
      report_json  TEXT
    );
    CREATE INDEX merge_check_runs_project ON merge_check_runs(project_key, requested_at);
    CREATE TABLE merge_check_run_tasks (
      run_id   TEXT NOT NULL REFERENCES merge_check_runs(id) ON DELETE CASCADE,
      task_key TEXT NOT NULL,
      position INTEGER NOT NULL,
      PRIMARY KEY (run_id, task_key)
    );
    CREATE INDEX merge_check_run_tasks_task ON merge_check_run_tasks(task_key);
    ${V92_CHANGE_TRIGGER_TABLES.map(changeTriggerSql).join('\n')}`,
});
migrations.push({
  version: 93,
  name: 'operator grants',
  // PM-881: the host owner's grant that lets the Operator run machine operations. At most one is active at
  // a time (the service closes the old row as 'replaced' in the same transaction); the audit is read from the rows.
  sql: `CREATE TABLE operator_grants (
      id              TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL,
      granted_at      TEXT NOT NULL,
      expires_at      TEXT,
      revoked_at      TEXT,
      revoked_reason  TEXT CHECK (revoked_reason IN ('revoked', 'replaced')),
      last_used_at    TEXT
    );`,
});
migrations.push({
  version: 94,
  name: 'web push notifications',
  sql: `CREATE TABLE web_push_devices (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT, endpoint_hash TEXT NOT NULL UNIQUE, p256dh TEXT, auth TEXT,
    vapid_key_id TEXT NOT NULL, origin TEXT, browser TEXT NOT NULL, os TEXT NOT NULL,
    form TEXT NOT NULL CHECK (form IN ('desktop','phone')),
    installed INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    state TEXT NOT NULL CHECK (state IN ('active','expired')),
    last_sent_at TEXT, last_result TEXT CHECK (last_result IN ('ok','failed','expired')), last_failure TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE INDEX web_push_devices_user ON web_push_devices(user_id);
  CREATE TABLE web_push_settings (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    categories TEXT NOT NULL, quiet_enabled INTEGER NOT NULL, quiet_start TEXT NOT NULL,
    quiet_end TEXT NOT NULL, time_zone TEXT NOT NULL, digest_due_at TEXT, updated_at TEXT NOT NULL);
  CREATE INDEX web_push_settings_digest ON web_push_settings(digest_due_at) WHERE digest_due_at IS NOT NULL;
  CREATE TABLE web_push_items (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    inbox_item_id TEXT NOT NULL, project_key TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('sent','quiet','digested','skipped')),
    skip_reason TEXT CHECK (skip_reason IN ('category_off','viewing')),
    created_at TEXT NOT NULL, PRIMARY KEY (user_id, inbox_item_id));
  CREATE INDEX web_push_items_outcome ON web_push_items(user_id, outcome);`,
});
migrations.push({
  version: 95,
  name: 'merge check runner',
  // PM-906: where a merge check ran (the card's engine, or the repository's GitHub Actions workflow) and, for
  // a GitHub run, its run page.
  sql: `ALTER TABLE merge_check_runs ADD COLUMN runner TEXT NOT NULL DEFAULT 'engine'
      CHECK (runner IN ('engine','github_actions'));
    ALTER TABLE merge_check_runs ADD COLUMN url TEXT;`,
});
migrations.push({
  version: 96,
  name: 'operator step operation',
  // PM-888: an `operation` step names the super operation the Operator started on the shared path.
  sql: 'ALTER TABLE operator_steps ADD COLUMN operation_id TEXT NULL;',
});
migrations.push({
  version: 97,
  name: 'semantic history search',
  // PM-767: a derived vector index beside the full-text one. Plain tables: the sqlite-vec extension is loaded
  // only by the embedding worker's own connection, so this migration, the source writes and the full-text search
  // work without it. A vector is 384 float32 values (1536 bytes) of one chunk of one source's text;
  // `content_hash` and `index_key` say which text and which model generation it was made from, and a vector of
  // another text or generation is never a hit. `history_semantic_dirty` is this index's own queue (the full-text
  // indexer acknowledges `history_dirty`; the two never acknowledge each other's rows).
  sql: `CREATE TABLE history_semantic_sources (
      source_id TEXT PRIMARY KEY REFERENCES history_documents(source_id) ON DELETE CASCADE,
      project_key TEXT NOT NULL REFERENCES projects(key) ON DELETE CASCADE,
      index_key TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      next_char INTEGER NOT NULL DEFAULT 0 CHECK (next_char >= 0),
      complete INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0, 1))
    );
    CREATE INDEX history_semantic_sources_scan ON history_semantic_sources(project_key, index_key, complete, source_id);
    CREATE TABLE history_semantic_chunks (
      id INTEGER PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES history_semantic_sources(source_id) ON DELETE CASCADE,
      chunk_no INTEGER NOT NULL CHECK (chunk_no >= 0),
      start_char INTEGER NOT NULL CHECK (start_char >= 0),
      end_char INTEGER NOT NULL CHECK (end_char > start_char),
      from_line INTEGER NOT NULL CHECK (from_line >= 1),
      to_line INTEGER NOT NULL CHECK (to_line >= from_line),
      embedding BLOB NOT NULL CHECK (length(embedding) = 1536),
      UNIQUE (source_id, chunk_no)
    );
    CREATE TABLE history_semantic_dirty (
      source_id TEXT PRIMARY KEY REFERENCES history_documents(source_id) ON DELETE CASCADE,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      next_attempt_at TEXT
    );
    CREATE INDEX history_semantic_dirty_due ON history_semantic_dirty(next_attempt_at, source_id);
    CREATE TABLE history_semantic_state (
      project_key TEXT PRIMARY KEY REFERENCES projects(key) ON DELETE CASCADE,
      index_key TEXT NOT NULL,
      last_source_id TEXT NOT NULL DEFAULT '',
      complete INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0, 1))
    );
    CREATE TRIGGER history_semantic_dirty_ai AFTER INSERT ON history_documents BEGIN
      INSERT INTO history_semantic_dirty (source_id) VALUES (new.source_id)
      ON CONFLICT (source_id) DO UPDATE SET revision = revision + 1, attempts = 0, next_attempt_at = NULL;
    END;
    CREATE TRIGGER history_semantic_dirty_au AFTER UPDATE OF title, body, commit_sha ON history_documents BEGIN
      INSERT INTO history_semantic_dirty (source_id) VALUES (new.source_id)
      ON CONFLICT (source_id) DO UPDATE SET revision = revision + 1, attempts = 0, next_attempt_at = NULL;
    END;
    ALTER TABLE history_searches ADD COLUMN semantic_status TEXT NOT NULL DEFAULT 'not_run'
      CHECK (semantic_status IN ('not_run', 'used', 'disabled', 'loading', 'backfill', 'unavailable', 'busy', 'timeout', 'resource_limit', 'error'));
    ALTER TABLE history_searches ADD COLUMN semantic_duration_ms INTEGER
      CHECK (semantic_duration_ms IS NULL OR semantic_duration_ms >= 0);`,
});
migrations.push({
  version: 98,
  name: 'member queue',
  // PM-894: one durable queue per AI member. A row is one source's item for one member (the unique key), with
  // the place the member works it (`place`, a work item as JSON) and whether it wakes the member. `state`
  // is queued, processing or closed (done, handed_off, cancelled) and `close_reason` says why. `payload` is
  // the owning lane's internal state; it is never shown. The later slices' lanes (PM-925..927, PM-885) write
  // the columns they own (attempts, restarted_at, session_id, wait_*, outcome) and nothing else reads them.
  sql: `CREATE TABLE member_queue_items (
      id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL REFERENCES projects(key) ON DELETE CASCADE,
      member TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('message','todo','fix_limit','permission','boundary','screening','signal','start')),
      source_type TEXT NOT NULL CHECK (source_type IN ('message','inbox','boundary','signal','fix_limit','obligation','start')),
      source_id TEXT NOT NULL,
      place TEXT NOT NULL,
      task_key TEXT,
      place_task_key TEXT,
      wake INTEGER NOT NULL DEFAULT 0 CHECK (wake IN (0, 1)),
      state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','processing','done','handed_off','cancelled')),
      title TEXT NOT NULL DEFAULT '',
      from_handle TEXT,
      queued_at TEXT NOT NULL,
      started_at TEXT,
      closed_at TEXT,
      close_reason TEXT CHECK (close_reason IS NULL OR close_reason IN ('delivered','resolved','finished','handed_off','started','place_closed','source_closed','stale','member_removed','attempts_exhausted')),
      attempts INTEGER NOT NULL DEFAULT 0,
      restarted_at TEXT,
      session_id TEXT,
      wait_code TEXT,
      wait_at TEXT,
      outcome TEXT,
      payload TEXT,
      UNIQUE (project_key, member, source_type, source_id)
    );
    CREATE INDEX member_queue_items_member ON member_queue_items(project_key, member, state, queued_at);
    CREATE INDEX member_queue_items_place ON member_queue_items(project_key, place_task_key)
      WHERE state IN ('queued','processing');
    CREATE INDEX member_queue_items_closed ON member_queue_items(project_key, member, closed_at);`,
});
migrations.push({
  version: 99,
  name: 'drop the message pending index',
  // PM-925: the member queue (version 98) is the one place a waiting message lives; the index it replaces is
  // no longer written or read. The queue is brought true from the messages themselves at startup. A wait
  // keeps what the refusal said besides its code (`wait_details`: the provider, the engine, a time), as a
  // deferred start did, so a card shows the same.
  sql: `DROP TABLE IF EXISTS team_message_pending;
    ALTER TABLE member_queue_items ADD COLUMN wait_details TEXT;`,
});
migrations.push({
  version: 100,
  name: 'operator requests from the member queue',
  // PM-885: the Operator's queue item is a request source of its own ('queue'), linked to the item by
  // `queue_item_id`. The source CHECK grows, so both tables are rebuilt as in version 65, and their change
  // triggers (version 81) are created again.
  sql: `CREATE TABLE operator_requests_next (
      id TEXT PRIMARY KEY, project_key TEXT NOT NULL, session_id TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('message', 'answer', 'signal', 'approval', 'queue')),
      message_id TEXT, inbox_item_id TEXT, from_handle TEXT NOT NULL, quote TEXT NOT NULL,
      opened_at TEXT NOT NULL, closed_at TEXT, queue_item_id TEXT
    );
    CREATE TABLE operator_steps_next (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES operator_requests_next(id),
      at TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL, task_key TEXT, member TEXT,
      changes TEXT NOT NULL DEFAULT '[]', config_version TEXT, inbox_item_id TEXT, refusal TEXT, signal_id TEXT,
      agreement_version INTEGER NULL, approval_mode TEXT NULL, operation_id TEXT NULL
    );
    INSERT INTO operator_requests_next (id, project_key, session_id, source, message_id, inbox_item_id, from_handle, quote, opened_at, closed_at)
      SELECT id, project_key, session_id, source, message_id, inbox_item_id, from_handle, quote, opened_at, closed_at FROM operator_requests;
    INSERT INTO operator_steps_next (id, request_id, at, action, status, task_key, member, changes, config_version, inbox_item_id, refusal, signal_id, agreement_version, approval_mode, operation_id)
      SELECT id, request_id, at, action, status, task_key, member, changes, config_version, inbox_item_id, refusal, signal_id, agreement_version, approval_mode, operation_id FROM operator_steps;
    DROP TABLE operator_steps;
    DROP TABLE operator_requests;
    ALTER TABLE operator_requests_next RENAME TO operator_requests;
    ALTER TABLE operator_steps_next RENAME TO operator_steps;
    CREATE INDEX operator_requests_project ON operator_requests(project_key, opened_at);
    CREATE INDEX operator_requests_session ON operator_requests(session_id) WHERE closed_at IS NULL;
    CREATE INDEX operator_steps_request ON operator_steps(request_id, at);
    CREATE INDEX operator_steps_signal ON operator_steps(signal_id) WHERE signal_id IS NOT NULL;
    ${V100_REBUILT_TRIGGER_TABLES.map(changeTriggerSql).join('\n')}`,
});
migrations.push({
  version: 101,
  name: 'system feedback',
  // PM-479 (PM-472): the gaps in projectman the Operator found, per installation. The text is stored already
  // filtered; an item's occurrences keep the first one; the forwarding setting is append-only (the latest row
  // counts, none means `manual`). A `system_feedback` Operator step keeps what it recorded in its own column.
  sql: `CREATE TABLE system_feedback_items (
      id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL REFERENCES projects(key),
      title TEXT NOT NULL, what TEXT NOT NULL, workaround TEXT NOT NULL, fix TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('new', 'forwarded', 'dismissed')),
      created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, version TEXT NOT NULL,
      session_id TEXT,
      forwarded_kind TEXT CHECK (forwarded_kind IN ('card', 'issue')),
      forwarded_project TEXT, forwarded_task TEXT, forwarded_url TEXT,
      forwarded_by TEXT,
      forwarded_at TEXT,
      dismissed_reason TEXT, dismissed_by TEXT, dismissed_at TEXT,
      card_error TEXT
    );
    CREATE INDEX system_feedback_items_project ON system_feedback_items(project_key, last_seen_at);
    CREATE TABLE system_feedback_occurrences (
      item_id TEXT NOT NULL REFERENCES system_feedback_items(id),
      at TEXT NOT NULL, version TEXT NOT NULL, session_id TEXT
    );
    CREATE INDEX system_feedback_occurrences_item ON system_feedback_occurrences(item_id, at);
    CREATE TABLE system_feedback_forwarding (
      id TEXT PRIMARY KEY,
      mode TEXT NOT NULL CHECK (mode IN ('manual', 'card', 'off')),
      project_key TEXT REFERENCES projects(key),
      changed_by TEXT NOT NULL, changed_at TEXT NOT NULL,
      CHECK ((mode = 'card') = (project_key IS NOT NULL))
    );
    ALTER TABLE operator_steps ADD COLUMN system_feedback TEXT;`,
});
migrations.push({
  version: 102,
  name: 'email channel',
  sql: `CREATE TABLE email_contacts (project_key TEXT NOT NULL, handle TEXT NOT NULL, wants INTEGER NOT NULL,
    changed_by TEXT NOT NULL, changed_at TEXT NOT NULL, requested_by TEXT, source TEXT NOT NULL,
    PRIMARY KEY (project_key, handle));
  CREATE TABLE email_contact_events (id TEXT PRIMARY KEY, project_key TEXT NOT NULL, handle TEXT NOT NULL,
    wants INTEGER NOT NULL, "by" TEXT NOT NULL, requested_by TEXT, source TEXT NOT NULL, source_ref TEXT,
    quote TEXT, at TEXT NOT NULL);
  CREATE TABLE email_messages (id TEXT PRIMARY KEY, project_key TEXT NOT NULL, direction TEXT NOT NULL,
    member TEXT, contact TEXT, task_key TEXT, subject TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL,
    park_reason TEXT, note TEXT, from_address TEXT, attachment_names TEXT NOT NULL DEFAULT '[]',
    reply_token_hash TEXT UNIQUE, reply_expires_at TEXT, in_reply_to TEXT, provider_id TEXT UNIQUE,
    inbox_item_id TEXT, message_id TEXT, decided_by TEXT, decided_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE INDEX email_messages_project ON email_messages(project_key, created_at);
  CREATE INDEX email_contact_events_project ON email_contact_events(project_key, at);`,
});
migrations.push({
  version: 103,
  name: 'full test runner and external url',
  // PM-909: where a full test of a pinned commit ran (the engine's sandbox or GitHub Actions) and the Actions
  // run page. An existing row is an engine result.
  sql: `ALTER TABLE full_test_runs ADD COLUMN runner TEXT NOT NULL DEFAULT 'engine' CHECK (runner IN ('engine','github_actions'));
    ALTER TABLE full_test_runs ADD COLUMN external_url TEXT;`,
});
migrations.push({
  version: 104,
  name: 'team message e-mail reply',
  // PM-943: the e-mail a team message carries (the reply of a contact); NULL on every other message.
  sql: `ALTER TABLE team_messages ADD COLUMN email TEXT;`,
});
migrations.push({
  version: 105,
  name: 'release publications',
  // PM-968: the tag and GitHub release the deployment duty's holder made of a merged commit (`publish_release`).
  // `url` is NULL until the GitHub release exists: a row without it is an unfinished publication, resumed by a repeat.
  sql: `CREATE TABLE release_publications (
    id TEXT PRIMARY KEY,
    project_key TEXT NOT NULL,
    repo TEXT NOT NULL,
    "commit" TEXT NOT NULL,
    base_commit TEXT,
    tag TEXT NOT NULL,
    tasks_json TEXT NOT NULL,
    summary TEXT NOT NULL,
    published_by TEXT NOT NULL,
    tagged_at TEXT NOT NULL,
    url TEXT,
    published_at TEXT,
    UNIQUE (project_key, repo, "commit"),
    UNIQUE (project_key, repo, tag)
  );`,
});
export const LATEST_SCHEMA_VERSION = migrations.reduce((max, m) => Math.max(max, m.version), 0);
