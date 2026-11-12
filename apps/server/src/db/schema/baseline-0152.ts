/**
 * Generated from migrations 1–152 at d3468c591d759b554d0a027f45c7a7c896c1d016.
 * Frozen schema: never edit this SQL, just as a released migration must never be edited.
 */
export const BASELINE_VERSION = 152;
export const BASELINE_RELEASE = 'v2026.11.12';

export const BASELINE_SQL = String.raw`CREATE TABLE users (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        created_at    TEXT NOT NULL
      , language TEXT NOT NULL DEFAULT 'en', ui_style TEXT CHECK (ui_style IN ('classic', 'win311')));

CREATE TABLE auth_sessions (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at   TEXT NOT NULL,
        expires_at   TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );

CREATE TABLE projects (
        key            TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        template_id    TEXT,
        config_version TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      , created_by TEXT REFERENCES users(id));

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
      , parent_key TEXT REFERENCES tasks(key), kind TEXT NOT NULL DEFAULT 'task', theme_key TEXT REFERENCES tasks(key), board_rank INTEGER NOT NULL DEFAULT 0, developer_level TEXT, stage_entered_at TEXT, complexity TEXT, archived_at TEXT);

CREATE TABLE task_links (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        kind       TEXT NOT NULL,
        ref        TEXT NOT NULL,
        repo       TEXT NOT NULL DEFAULT '',
        title      TEXT,
        state      TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, author TEXT, head_sha TEXT, author_source TEXT,
        UNIQUE (task_id, kind, repo, ref)
      );

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
      , actor_via TEXT, actor_meta TEXT);

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
        ended_at          TEXT, provider TEXT NOT NULL DEFAULT 'claude', execution_profile TEXT NOT NULL DEFAULT 'legacy', permission_mode TEXT, approver TEXT, permission_restart_pending INTEGER NOT NULL DEFAULT 0, permission_grants_lost INTEGER NOT NULL DEFAULT 0, usage_since TEXT, usage_alert_at TEXT, usage_alert_tokens INTEGER, usage_alert_limit INTEGER, state_since TEXT, compact_pending INTEGER NOT NULL DEFAULT 0, context_tokens INTEGER, reviewed_commit TEXT, doing_summary TEXT, doing_detail TEXT, last_stop TEXT NULL, start_cause TEXT, engine_id TEXT NOT NULL DEFAULT 'local', work_metadata TEXT,
        UNIQUE (project_key, member, work_item_type, work_item_ref)
      );

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
      , receipts TEXT, answer TEXT, kind TEXT, version TEXT, subject TEXT, via TEXT, origin TEXT, relayed TEXT, operator_request TEXT, operator_signal TEXT, attachments TEXT, actor_meta TEXT, email TEXT, location TEXT, places TEXT, conversation TEXT CHECK (conversation IN ('direct')), client_request_id TEXT);

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
      , route TEXT);

CREATE TABLE member_state (
        project_key TEXT NOT NULL,
        handle      TEXT NOT NULL,
        status      TEXT NOT NULL,
        activity    TEXT,
        updated_at  TEXT NOT NULL, activity_task_key TEXT,
        PRIMARY KEY (project_key, handle)
      );

CREATE TABLE counters (
        project_key TEXT NOT NULL,
        name        TEXT NOT NULL,
        value       INTEGER NOT NULL,
        PRIMARY KEY (project_key, name)
      );

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
      , member_handle TEXT);

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

CREATE TABLE deferred_starts (
        seq         INTEGER PRIMARY KEY AUTOINCREMENT,
        key         TEXT NOT NULL UNIQUE,
        project_key TEXT NOT NULL,
        task_key    TEXT,
        spec        TEXT NOT NULL,
        waiting     TEXT NOT NULL
      );

CREATE TABLE attachments (
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
      , comment_upload INTEGER NOT NULL DEFAULT 0 CHECK (comment_upload IN (0, 1)), comment_event_id TEXT);

CREATE TABLE member_workspaces (
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
        held_since        TEXT, holder_scope_id TEXT, holder_cleanup_failed INTEGER NOT NULL DEFAULT 0,
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

CREATE TABLE token_usage (
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

CREATE TABLE task_review_pins (
        project_key TEXT NOT NULL REFERENCES projects(key),
        task_key    TEXT NOT NULL PRIMARY KEY REFERENCES tasks(key),
        stage_id    TEXT NOT NULL,
        commit_id   TEXT NOT NULL,
        branch      TEXT NOT NULL,
        pinned_at   TEXT NOT NULL,
        pinned_by   TEXT NOT NULL
      );

CREATE TABLE task_covers (
        project_key   TEXT NOT NULL REFERENCES projects(key),
        task_key      TEXT NOT NULL PRIMARY KEY REFERENCES tasks(key),
        mode          TEXT NOT NULL CHECK (mode IN ('pinned', 'hidden')),
        attachment_id TEXT,
        set_at        TEXT NOT NULL,
        set_by_kind   TEXT NOT NULL,
        set_by_handle TEXT,
        CHECK ((mode = 'pinned') = (attachment_id IS NOT NULL))
      );

CREATE TABLE task_loops (
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
      , triage_json TEXT NULL);

CREATE TABLE task_fix_limits (
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
      );

CREATE TABLE full_test_runs (
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
      , runner TEXT NOT NULL DEFAULT 'engine' CHECK (runner IN ('engine','github_actions')), external_url TEXT);

CREATE TABLE integrator_keys (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), prefix TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, expires_at TEXT,
      revoked_at TEXT, last_used_at TEXT
    , mode TEXT NOT NULL DEFAULT 'legacy'
      CHECK (mode IN ('legacy','super','read')), last_used_channel TEXT
      CHECK (last_used_channel IN ('mcp','cli','rest')));

CREATE TABLE task_handoffs (
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

CREATE TABLE engines (
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

CREATE TABLE task_hand_ons (
      project_key TEXT NOT NULL,
      task_key TEXT NOT NULL,
      from_stage_id TEXT NOT NULL,
      to_stage_id TEXT NOT NULL,
      mover TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      inbox_item_id TEXT,
      PRIMARY KEY (project_key, task_key)
    );

CREATE TABLE task_handovers (
      project_key TEXT NOT NULL, task_key TEXT NOT NULL, "commit" TEXT NOT NULL,
      branch TEXT NOT NULL, stage_id TEXT NOT NULL, at TEXT NOT NULL,
      PRIMARY KEY (project_key, task_key)
    );

CREATE TABLE task_merges (
      id TEXT PRIMARY KEY, project_key TEXT NOT NULL, task_key TEXT NOT NULL,
      repo TEXT NOT NULL, base TEXT NOT NULL, "commit" TEXT, branch TEXT,
      from_stage_id TEXT NOT NULL, to_stage_id TEXT NOT NULL, merger TEXT NOT NULL, requested_at TEXT NOT NULL, started_by TEXT, started_at TEXT,
      state TEXT NOT NULL CHECK (state IN ('requested','queued','running','failed','blocked','fixing','merged','cancelled')),
      step TEXT, merge_commit TEXT, check_json TEXT, landed TEXT NOT NULL, failure_json TEXT,
      block_json TEXT, pushed_json TEXT, pull_requests_json TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT,
      fix_json TEXT, resolution_json TEXT
    , prioritized_at TEXT, train_id TEXT, diagnostic_json TEXT, queue_rank INTEGER, retry_json TEXT);

CREATE TABLE releases (
      id TEXT PRIMARY KEY, project_key TEXT NOT NULL, repo TEXT NOT NULL, task_key TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('proposed','approved','rejected','deploying','failed','live','published')),
      "commit" TEXT NOT NULL, base_commit TEXT, tasks_json TEXT NOT NULL, summary TEXT NOT NULL,
      proposed_by TEXT NOT NULL, proposed_at TEXT NOT NULL, decided_by TEXT, decided_at TEXT,
      deploy_started_at TEXT, previous_commit TEXT, live_at TEXT,
      tag TEXT, url TEXT, published_at TEXT,
      failure_json TEXT, publish_error TEXT, updated_at TEXT NOT NULL
    );

CREATE TABLE decision_offers (
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

CREATE TABLE message_attachments (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE, project_key TEXT NOT NULL, message_id TEXT,
      file_name TEXT NOT NULL, size INTEGER NOT NULL, media_type TEXT NOT NULL, preview TEXT NOT NULL,
      uploaded_by_kind TEXT NOT NULL, uploaded_by_handle TEXT NOT NULL, created_at TEXT NOT NULL,
      bound_at TEXT, state TEXT NOT NULL CHECK (state IN ('pending','ready','deleting')),
      deleted_by_kind TEXT, deleted_by_handle TEXT, delete_requested_at TEXT
    );

CREATE TABLE feedback_marks (
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

CREATE TABLE feedback_events (
      id TEXT PRIMARY KEY,
      mark_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      type TEXT NOT NULL,
      body TEXT,
      data TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

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
    );

CREATE TABLE merge_trains (
      id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL,
      repo TEXT NOT NULL,
      state TEXT NOT NULL,
      record_json TEXT NOT NULL
    );

CREATE TABLE email_login_codes (
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

CREATE TABLE session_cleanups (
      scope_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, project_key TEXT NOT NULL,
      task_key TEXT, kind TEXT NOT NULL, survivors INTEGER NOT NULL,
      failed_at TEXT NOT NULL, last_attempt_at TEXT, attempts INTEGER NOT NULL DEFAULT 0
    );

CREATE TABLE operator_execution_intents (
      id TEXT PRIMARY KEY, project_key TEXT NOT NULL, request_id TEXT NOT NULL,
      operation TEXT NOT NULL, changes TEXT NOT NULL, agreement_version INTEGER NULL,
      approval_mode TEXT NOT NULL CHECK (approval_mode IN ('click','waived')),
      status TEXT NOT NULL CHECK (status IN ('prepared','committed','failed')),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, config_version TEXT NULL, refusal TEXT NULL
    );

CREATE TABLE question_groups (
    primary_item_id TEXT PRIMARY KEY, project_key TEXT NOT NULL, question TEXT NOT NULL,
    created_at TEXT NOT NULL, by_handle TEXT NOT NULL, note TEXT NOT NULL
  );

CREATE TABLE question_group_items (
    item_id TEXT NOT NULL UNIQUE, primary_item_id TEXT NOT NULL REFERENCES question_groups(primary_item_id)
  );

CREATE TABLE release_deployments (
      release_id TEXT PRIMARY KEY REFERENCES releases(id),
      attempt_id TEXT NOT NULL UNIQUE,
      controller_id TEXT NOT NULL,
      phase TEXT NOT NULL CHECK (phase IN ('preparing','prepared','quiescing','switching','live','failed','published','recovery_required')),
      maintenance INTEGER NOT NULL CHECK (maintenance IN (0,1)),
      revision INTEGER NOT NULL,
      data_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

CREATE TABLE release_deployment_requests (
      request_id TEXT PRIMARY KEY,
      release_id TEXT NOT NULL REFERENCES releases(id),
      attempt_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      resulting_revision INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

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

CREATE TABLE integrator_key_audit (
      seq INTEGER PRIMARY KEY,
      key_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('created','revoked')),
      prefix TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('legacy','super','read')),
      at TEXT NOT NULL
    );

CREATE TABLE instance_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

CREATE TABLE project_change_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      project_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      entity_id TEXT,
      at TEXT NOT NULL
    );

CREATE TABLE merge_queue_revisions (
      project_key TEXT NOT NULL,
      repo TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project_key, repo)
    );

CREATE TABLE super_handoffs (
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

CREATE TABLE history_documents (
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

CREATE VIRTUAL TABLE history_fts USING fts5(
      title, body,
      content='history_documents', content_rowid='id',
      tokenize='unicode61 remove_diacritics 2', prefix='3 4 5'
    );

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

CREATE TABLE history_searches (
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
    , semantic_status TEXT NOT NULL DEFAULT 'not_run'
      CHECK (semantic_status IN ('not_run', 'used', 'disabled', 'loading', 'backfill', 'unavailable', 'busy', 'timeout', 'resource_limit', 'error')), semantic_duration_ms INTEGER
      CHECK (semantic_duration_ms IS NULL OR semantic_duration_ms >= 0));

CREATE TABLE operator_signal_arms (
      project_key TEXT NOT NULL REFERENCES projects(key) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      armed_at TEXT NOT NULL,
      PRIMARY KEY (project_key, kind)
    );

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
    , autonomous_lessons INTEGER NOT NULL DEFAULT 0 CHECK (autonomous_lessons IN (0,1)));

CREATE TABLE merge_check_runs (
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
    , runner TEXT NOT NULL DEFAULT 'engine'
      CHECK (runner IN ('engine','github_actions')), url TEXT, infra TEXT);

CREATE TABLE merge_check_run_tasks (
      run_id   TEXT NOT NULL REFERENCES merge_check_runs(id) ON DELETE CASCADE,
      task_key TEXT NOT NULL,
      position INTEGER NOT NULL,
      PRIMARY KEY (run_id, task_key)
    );

CREATE TABLE operator_grants (
      id              TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL,
      granted_at      TEXT NOT NULL,
      expires_at      TEXT,
      revoked_at      TEXT,
      revoked_reason  TEXT CHECK (revoked_reason IN ('revoked', 'replaced')),
      last_used_at    TEXT
    );

CREATE TABLE web_push_devices (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT, endpoint_hash TEXT NOT NULL UNIQUE, p256dh TEXT, auth TEXT,
    vapid_key_id TEXT NOT NULL, origin TEXT, browser TEXT NOT NULL, os TEXT NOT NULL,
    form TEXT NOT NULL CHECK (form IN ('desktop','phone')),
    installed INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    state TEXT NOT NULL CHECK (state IN ('active','expired')),
    last_sent_at TEXT, last_result TEXT CHECK (last_result IN ('ok','failed','expired')), last_failure TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE web_push_settings (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    categories TEXT NOT NULL, quiet_enabled INTEGER NOT NULL, quiet_start TEXT NOT NULL,
    quiet_end TEXT NOT NULL, time_zone TEXT NOT NULL, digest_due_at TEXT, updated_at TEXT NOT NULL);

CREATE TABLE web_push_items (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    inbox_item_id TEXT NOT NULL, project_key TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('sent','quiet','digested','skipped')),
    skip_reason TEXT CHECK (skip_reason IN ('category_off','viewing')),
    created_at TEXT NOT NULL, PRIMARY KEY (user_id, inbox_item_id));

CREATE TABLE history_semantic_sources (
      source_id TEXT PRIMARY KEY REFERENCES history_documents(source_id) ON DELETE CASCADE,
      project_key TEXT NOT NULL REFERENCES projects(key) ON DELETE CASCADE,
      index_key TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      next_char INTEGER NOT NULL DEFAULT 0 CHECK (next_char >= 0),
      complete INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0, 1))
    );

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

CREATE TABLE history_semantic_state (
      project_key TEXT PRIMARY KEY REFERENCES projects(key) ON DELETE CASCADE,
      index_key TEXT NOT NULL,
      last_source_id TEXT NOT NULL DEFAULT '',
      complete INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0, 1))
    );

CREATE TABLE "operator_requests" (
      id TEXT PRIMARY KEY, project_key TEXT NOT NULL, session_id TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('message', 'answer', 'signal', 'approval', 'queue')),
      message_id TEXT, inbox_item_id TEXT, from_handle TEXT NOT NULL, quote TEXT NOT NULL,
      opened_at TEXT NOT NULL, closed_at TEXT, queue_item_id TEXT
    );

CREATE TABLE "operator_steps" (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES "operator_requests"(id),
      at TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL, task_key TEXT, member TEXT,
      changes TEXT NOT NULL DEFAULT '[]', config_version TEXT, inbox_item_id TEXT, refusal TEXT, signal_id TEXT,
      agreement_version INTEGER NULL, approval_mode TEXT NULL, operation_id TEXT NULL
    , system_feedback TEXT);

CREATE TABLE system_feedback_items (
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

CREATE TABLE system_feedback_occurrences (
      item_id TEXT NOT NULL REFERENCES system_feedback_items(id),
      at TEXT NOT NULL, version TEXT NOT NULL, session_id TEXT
    );

CREATE TABLE system_feedback_forwarding (
      id TEXT PRIMARY KEY,
      mode TEXT NOT NULL CHECK (mode IN ('manual', 'card', 'off')),
      project_key TEXT REFERENCES projects(key),
      changed_by TEXT NOT NULL, changed_at TEXT NOT NULL,
      CHECK ((mode = 'card') = (project_key IS NOT NULL))
    );

CREATE TABLE email_contacts (project_key TEXT NOT NULL, handle TEXT NOT NULL, wants INTEGER NOT NULL,
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
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, mime_message_id TEXT, mime_references TEXT);

CREATE TABLE release_publications (
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
  );

CREATE TABLE project_checklists (project_key TEXT PRIMARY KEY, base_template_id TEXT, created_at TEXT NOT NULL);

CREATE TABLE project_checklist_items (
    project_key TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, title TEXT NOT NULL, hint TEXT,
    source TEXT NOT NULL CHECK (source IN ('base','template','operator')), template_id TEXT, condition TEXT,
    state TEXT NOT NULL CHECK (state IN ('open','done','not_needed')), reason TEXT,
    reopened TEXT CHECK (reopened IN ('condition','owner')), updated_at TEXT NOT NULL, updated_by TEXT NOT NULL,
    PRIMARY KEY (project_key, id));

CREATE TABLE "member_queue_items" (
    id TEXT PRIMARY KEY,
    project_key TEXT NOT NULL REFERENCES projects(key) ON DELETE CASCADE,
    member TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('message','todo','fix_limit','permission','boundary','screening','signal','start','checklist')),
    source_type TEXT NOT NULL CHECK (source_type IN ('message','inbox','boundary','signal','fix_limit','obligation','start','checklist')),
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
    wait_details TEXT,
    UNIQUE (project_key, member, source_type, source_id)
  );

CREATE TABLE project_engines (
    project_key TEXT NOT NULL,
    engine_id   TEXT NOT NULL REFERENCES engines(id),
    is_default  INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
    added_by    TEXT NOT NULL REFERENCES users(id),
    added_at    TEXT NOT NULL,
    PRIMARY KEY (project_key, engine_id)
  );

CREATE TABLE owner_accounts (
    user_id    TEXT NOT NULL PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    granted_by TEXT NOT NULL REFERENCES users(id),
    granted_at TEXT NOT NULL,
    revoked_at TEXT,
    revoked_by TEXT REFERENCES users(id)
  );

CREATE TABLE owner_invitations (
    id               TEXT NOT NULL PRIMARY KEY,
    email            TEXT NOT NULL COLLATE NOCASE,
    token_hash       TEXT NOT NULL UNIQUE,
    created_by       TEXT NOT NULL REFERENCES users(id),
    created_at       TEXT NOT NULL,
    expires_at       TEXT NOT NULL,
    accepted_at      TEXT,
    accepted_user_id TEXT REFERENCES users(id),
    revoked_at       TEXT
  );

CREATE TABLE host_requests (
    id           TEXT NOT NULL PRIMARY KEY,
    project_key  TEXT NOT NULL REFERENCES projects(key) ON DELETE CASCADE,
    task_key     TEXT,
    opened_by    TEXT NOT NULL,
    title        TEXT NOT NULL,
    body         TEXT NOT NULL,
    state        TEXT NOT NULL CHECK (state IN ('open','answered','declined','withdrawn')),
    answer       TEXT,
    answered_by  TEXT REFERENCES users(id),
    answered_via TEXT CHECK (answered_via IN ('web','super')),
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );

CREATE TABLE task_acceptance_items (
      id           TEXT PRIMARY KEY,
      task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      position     INTEGER NOT NULL,
      text         TEXT NOT NULL,
      state        TEXT NOT NULL CHECK (state IN ('open', 'done', 'not_needed', 'moved')),
      evidence     TEXT,
      reason       TEXT,
      moved_to     TEXT,
      origin_task  TEXT,
      origin_item  TEXT,
      marked_by    TEXT,
      marked_at    TEXT,
      confirmed_by TEXT,
      confirmed_at TEXT,
      created_by   TEXT,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );

CREATE TABLE compute_job_runs (
      id TEXT NOT NULL PRIMARY KEY, project_key TEXT NOT NULL REFERENCES projects(key),
      repo TEXT NOT NULL, job_id TEXT NOT NULL, commit_sha TEXT NOT NULL,
      runner TEXT NOT NULL CHECK (runner IN ('github_actions','engine')),
      status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','error','cancelled')),
      reason TEXT, requested_by TEXT NOT NULL, task_key TEXT REFERENCES tasks(key),
      created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
      queued_ms INTEGER, duration_ms INTEGER, billable_ms INTEGER,
      external_url TEXT, output_tail TEXT, outputs_json TEXT, artifact_name TEXT, artifact_expires_at TEXT
    );

CREATE TABLE ntfy_channels (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    server_url TEXT NOT NULL, topic TEXT NOT NULL, origin TEXT, enabled INTEGER NOT NULL DEFAULT 1,
    last_sent_at TEXT, last_result TEXT CHECK (last_result IN ('ok','failed')), last_failure TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE "pauses" (
      id             TEXT NOT NULL PRIMARY KEY,
      scope          TEXT NOT NULL CHECK (scope IN ('instance', 'project', 'engine')),
      project_key    TEXT REFERENCES projects(key),
      engine_id      TEXT,
      kind           TEXT NOT NULL CHECK (kind IN ('manual', 'shutdown')),
      source         TEXT NOT NULL CHECK (source IN ('app', 'control', 'system')),
      reason         TEXT,
      requested_by   TEXT REFERENCES users(id),
      requested_at   TEXT NOT NULL,
      force_after_ms INTEGER NOT NULL,
      resumed_at     TEXT,
      resumed_by     TEXT,
      CHECK (scope = 'engine' OR (scope = 'instance') = (project_key IS NULL)),
      CHECK ((scope = 'engine') = (engine_id IS NOT NULL)),
      CHECK (scope != 'engine' OR (project_key IS NULL AND kind = 'shutdown' AND source = 'system'))
    );

CREATE TABLE "session_pauses" (
      session_id    TEXT NOT NULL REFERENCES sessions(id),
      pause_id      TEXT NOT NULL REFERENCES "pauses"(id),
      project_key   TEXT NOT NULL REFERENCES projects(key),
      since         TEXT NOT NULL,
      point         TEXT,
      tool          TEXT,
      waiting_for   TEXT,
      paused_at     TEXT,
      needs_restart INTEGER NOT NULL DEFAULT 0,
      resumed_at    TEXT
    );

CREATE TABLE feedback_deletions (
      id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL,
      mark_id TEXT NOT NULL,
      author TEXT NOT NULL,
      deleted_by TEXT NOT NULL,
      task_key TEXT,
      deleted_at TEXT NOT NULL
    );

CREATE TABLE obligations (
      id              TEXT PRIMARY KEY,
      project_key     TEXT NOT NULL,
      task_key        TEXT NOT NULL,
      kind            TEXT NOT NULL CHECK (kind IN ('merge','fix_limit','refinement_turn','review_step','work','start','senior_wait','next_step')),
      responsible     TEXT,
      subject         TEXT NOT NULL,
      opened_at       TEXT NOT NULL,
      due_at          TEXT NOT NULL,
      paused_since    TEXT,
      pause_reason    TEXT CHECK (pause_reason IN ('held','inbox','permission','start_refused','related_inbox')),
      woken_at        TEXT,
      handed_over_at  TEXT,
      inbox_item_id   TEXT,
      state           TEXT NOT NULL CHECK (state IN ('open','handed_over','fulfilled','cancelled')),
      closed_at       TEXT,
      updated_at      TEXT NOT NULL,
      pm_told_at      TEXT
    , decision TEXT CHECK (decision IN ('wait','any')), decided_by TEXT);

CREATE TABLE operator_signals (
      id TEXT PRIMARY KEY, project_key TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('outage','nobody','stalled','silent','idle','merge_waiting','merge_blocked','unreleased','ready_waiting','answer_stalled','process_cleanup_failed','refinement_stalled','loop_suspected','structural_pattern','milestone_closed','start_blocked','obligation_overdue','senior_wait','relation_check')), case_key TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending','open','accepted','dismissed','resolved')),
      actionable INTEGER NOT NULL DEFAULT 0, task_key TEXT, subject TEXT, inbox_item_id TEXT, message_id TEXT,
      raised_at TEXT NOT NULL, decided_by TEXT, decided_at TEXT, resolved_at TEXT, delivered_at TEXT,
      follow_up_at TEXT, decision_note TEXT, delivered_to TEXT
    );

CREATE TABLE message_turns (
      project_key TEXT NOT NULL, message_id TEXT NOT NULL, handle TEXT NOT NULL,
      session_id TEXT NOT NULL, typed_at TEXT NOT NULL,
      ended_at TEXT, end_state TEXT CHECK (end_state IN ('idle','exited','failed')),
      PRIMARY KEY (message_id, handle)
    );

CREATE INDEX auth_sessions_user ON auth_sessions(user_id);

CREATE INDEX tasks_project ON tasks(project_key, seq);

CREATE INDEX tasks_assignee ON tasks(project_key, assignee);

CREATE INDEX task_links_ref ON task_links(kind, repo, ref);

CREATE INDEX timeline_project ON timeline_events(project_key, seq);

CREATE INDEX timeline_task ON timeline_events(task_key, seq);

CREATE INDEX sessions_project ON sessions(project_key, member);

CREATE INDEX sessions_work_item ON sessions(project_key, work_item_type, work_item_ref);

CREATE INDEX team_messages_project ON team_messages(project_key, seq);

CREATE INDEX team_messages_task ON team_messages(task_key, seq);

CREATE INDEX inbox_project_state ON inbox_items(project_key, state, seq);

CREATE INDEX inbox_task ON inbox_items(task_key, state);

CREATE INDEX invitations_project ON invitations(project_key, created_at);

CREATE INDEX schedule_runs_project ON schedule_runs(project_key, seq);

CREATE UNIQUE INDEX schedule_runs_occurrence
        ON schedule_runs(project_key, member, scheduled_for) WHERE automatic = 1;

CREATE INDEX invitations_member ON invitations(project_key, member_handle);

CREATE INDEX tasks_parent ON tasks(project_key, parent_key);

CREATE INDEX attachments_task ON attachments(project_key, task_key, state, seq);

CREATE INDEX task_workspace_bindings_task ON task_workspace_bindings(project_key, task_key, kind);

CREATE INDEX token_usage_member ON token_usage(project_key, member, hour);

CREATE INDEX token_usage_task ON token_usage(project_key, task_key);

CREATE INDEX tasks_theme ON tasks(project_key, theme_key);

CREATE INDEX tasks_board_order ON tasks(project_key, stage_id, board_rank);

CREATE INDEX task_loops_task ON task_loops(project_key, task_key, ended_at);

CREATE INDEX full_test_runs_task_commit ON full_test_runs(task_key, commit_sha);

CREATE INDEX timeline_involvements ON timeline_events(project_key, created_at DESC, id DESC)
      WHERE type IN ('session_started', 'session_ended');

CREATE UNIQUE INDEX task_handoffs_open ON task_handoffs(task_key) WHERE outcome IS NULL;

CREATE INDEX task_handoffs_task ON task_handoffs(task_key, started_at);

CREATE UNIQUE INDEX engines_one_default ON engines(is_default)
    WHERE is_default = 1 AND revoked_at IS NULL;

CREATE INDEX task_merges_queue ON task_merges(project_key, repo, state, created_at);

CREATE UNIQUE INDEX task_merges_open ON task_merges(project_key, task_key)
      WHERE state IN ('requested','queued','running','failed','blocked','fixing');

CREATE UNIQUE INDEX releases_open ON releases(project_key) WHERE state IN ('proposed','approved','deploying');

CREATE INDEX releases_project ON releases(project_key, proposed_at);

CREATE INDEX message_attachments_message ON message_attachments(project_key, message_id);

CREATE INDEX message_attachments_unsent ON message_attachments(state, message_id, created_at);

CREATE INDEX feedback_marks_project ON feedback_marks (project_key, updated_at);

CREATE INDEX feedback_marks_task ON feedback_marks (project_key, task_key);

CREATE INDEX feedback_events_mark ON feedback_events (mark_id, created_at);

CREATE INDEX feedback_sessions_member ON feedback_sessions (project_key, member);

CREATE UNIQUE INDEX merge_trains_running ON merge_trains(project_key, repo) WHERE state = 'running';

CREATE INDEX email_login_events_subject ON email_login_events(kind, subject, at);

CREATE INDEX email_login_events_at ON email_login_events(at);

CREATE INDEX invitations_email ON invitations(email);

CREATE INDEX session_cleanups_session ON session_cleanups(session_id);

CREATE INDEX question_group_members ON question_group_items(primary_item_id);

CREATE INDEX team_messages_question_answer ON team_messages(project_key, json_extract(origin, '$.inboxItemId'))
    WHERE json_extract(origin, '$.kind') = 'answer';

CREATE UNIQUE INDEX release_deployments_active ON release_deployments((1))
      WHERE maintenance = 1 OR phase IN ('preparing','prepared','quiescing','switching','recovery_required');

CREATE INDEX release_deployment_requests_release ON release_deployment_requests(release_id);

CREATE INDEX super_operation_audit_settles ON super_operation_audit(settles_id);

CREATE INDEX super_operation_audit_project ON super_operation_audit(project_key, seq);

CREATE INDEX super_operation_audit_prefix ON super_operation_audit(project_key, prefix, seq);

CREATE INDEX tasks_scheduling_pull
      ON tasks(project_key, stage_id, priority, seq)
      WHERE kind = 'task' AND status = 'active' AND assignee IS NULL;

CREATE INDEX tasks_scheduling_open
      ON tasks(project_key, seq)
      WHERE status NOT IN ('done', 'cancelled');

CREATE INDEX tasks_scheduling_closed
      ON tasks(project_key, seq)
      WHERE kind = 'task' AND status IN ('done', 'cancelled') AND closed_at IS NOT NULL;

CREATE UNIQUE INDEX integrator_keys_active_mode ON integrator_keys(user_id, mode)
      WHERE revoked_at IS NULL;

CREATE INDEX integrator_key_audit_owner ON integrator_key_audit(owner_user_id, seq);

CREATE INDEX timeline_task_state_before
      ON timeline_events(project_key, task_key, created_at, seq)
      WHERE type IN ('task_stage_changed', 'task_updated');

CREATE INDEX timeline_structural_window
      ON timeline_events(project_key, created_at)
      WHERE type IN ('task_merge_requested', 'task_merge_failed', 'task_full_test',
        'task_stage_changed', 'task_labels_changed', 'task_updated');

CREATE INDEX project_change_events_project ON project_change_events(project_key, seq);

CREATE INDEX super_handoffs_state ON super_handoffs(project_key, state, created_at);

CREATE INDEX super_operations_state ON super_operations(project_key, state);

CREATE INDEX super_operations_handoff ON super_operations(handoff_id);

CREATE INDEX history_documents_type_at ON history_documents(project_key, source_type, at);

CREATE INDEX history_documents_task ON history_documents(project_key, task_key);

CREATE UNIQUE INDEX history_documents_entity ON history_documents(project_key, source_type, entity_id);

CREATE INDEX history_searches_project_at ON history_searches(project_key, at, id);

CREATE INDEX history_searches_member_at ON history_searches(project_key, member, at);

CREATE UNIQUE INDEX doc_writes_open ON doc_writes(project_key) WHERE state IN ('queued','running');

CREATE INDEX inbox_open ON inbox_items(seq) WHERE state = 'open';

CREATE INDEX task_merges_task ON task_merges(project_key, task_key, state, finished_at);

CREATE INDEX task_loops_task_key ON task_loops(task_key, ended_at);

CREATE INDEX timeline_project_type ON timeline_events(project_key, type, seq);

CREATE INDEX sessions_state ON sessions(state);

CREATE INDEX merge_check_runs_project ON merge_check_runs(project_key, requested_at);

CREATE INDEX merge_check_run_tasks_task ON merge_check_run_tasks(task_key);

CREATE INDEX web_push_devices_user ON web_push_devices(user_id);

CREATE INDEX web_push_settings_digest ON web_push_settings(digest_due_at) WHERE digest_due_at IS NOT NULL;

CREATE INDEX web_push_items_outcome ON web_push_items(user_id, outcome);

CREATE INDEX history_semantic_sources_scan ON history_semantic_sources(project_key, index_key, complete, source_id);

CREATE INDEX history_semantic_dirty_due ON history_semantic_dirty(next_attempt_at, source_id);

CREATE INDEX operator_requests_project ON operator_requests(project_key, opened_at);

CREATE INDEX operator_requests_session ON operator_requests(session_id) WHERE closed_at IS NULL;

CREATE INDEX operator_steps_request ON operator_steps(request_id, at);

CREATE INDEX operator_steps_signal ON operator_steps(signal_id) WHERE signal_id IS NOT NULL;

CREATE INDEX system_feedback_items_project ON system_feedback_items(project_key, last_seen_at);

CREATE INDEX system_feedback_occurrences_item ON system_feedback_occurrences(item_id, at);

CREATE INDEX email_messages_project ON email_messages(project_key, created_at);

CREATE INDEX email_contact_events_project ON email_contact_events(project_key, at);

CREATE INDEX member_queue_items_member ON member_queue_items(project_key, member, state, queued_at);

CREATE INDEX member_queue_items_place ON member_queue_items(project_key, place_task_key)
    WHERE state IN ('queued','processing');

CREATE INDEX member_queue_items_closed ON member_queue_items(project_key, member, closed_at);

CREATE UNIQUE INDEX project_engines_one_default ON project_engines(project_key) WHERE is_default = 1;

CREATE INDEX project_engines_engine ON project_engines(engine_id);

CREATE INDEX host_requests_open ON host_requests(state, created_at);

CREATE INDEX host_requests_project ON host_requests(project_key, state);

CREATE INDEX member_queue_items_open_source ON member_queue_items(source_type)
      WHERE state IN ('queued','processing');

CREATE INDEX member_queue_items_waiting ON member_queue_items(wait_at)
      WHERE state = 'queued' AND wake = 1 AND wait_code IS NOT NULL;

CREATE INDEX sessions_live ON sessions(project_key, member, state);

CREATE INDEX task_acceptance_items_task ON task_acceptance_items(task_id, position);

CREATE INDEX compute_job_runs_key ON compute_job_runs(project_key, repo, job_id, commit_sha);

CREATE INDEX compute_job_runs_status ON compute_job_runs(status);

CREATE UNIQUE INDEX pauses_open ON pauses(scope, COALESCE(project_key, engine_id, '')) WHERE resumed_at IS NULL;

CREATE UNIQUE INDEX session_pauses_open ON session_pauses(session_id) WHERE resumed_at IS NULL;

CREATE INDEX session_pauses_project ON session_pauses(project_key, resumed_at);

CREATE INDEX session_pauses_pause ON session_pauses(pause_id, resumed_at);

CREATE INDEX feedback_deletions_project ON feedback_deletions (project_key, deleted_at);

CREATE UNIQUE INDEX obligations_unique ON obligations(project_key, task_key, kind, COALESCE(responsible, ''), subject);

CREATE INDEX obligations_state ON obligations(state);

CREATE UNIQUE INDEX operator_signals_open ON operator_signals(project_key, case_key) WHERE resolved_at IS NULL;

CREATE INDEX operator_signals_delivery ON operator_signals(project_key, kind, delivered_at);

CREATE UNIQUE INDEX team_messages_client_request ON team_messages(project_key, from_handle, client_request_id)
      WHERE client_request_id IS NOT NULL;

CREATE INDEX attachments_unsent_comment ON attachments(project_key, uploaded_by_kind, uploaded_by_handle, created_at)
      WHERE comment_upload = 1 AND comment_event_id IS NULL;

CREATE INDEX message_turns_open ON message_turns(session_id) WHERE ended_at IS NULL;

CREATE INDEX team_messages_origin_event ON team_messages(json_extract(origin, '$.eventId'));

CREATE INDEX team_messages_from ON team_messages(project_key, from_handle, created_at);

CREATE INDEX timeline_note_edits ON timeline_events(project_key, json_extract(data, '$.noteId'))
      WHERE type = 'task_note_edited';

CREATE INDEX tasks_closed ON tasks(project_key, closed_at);

CREATE TRIGGER tasks_change_insert AFTER INSERT ON tasks
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'task', NEW.key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER tasks_change_update AFTER UPDATE ON tasks
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'task', NEW.key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER tasks_change_delete AFTER DELETE ON tasks
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT OLD.project_key, 'task', OLD.key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER task_links_change_insert AFTER INSERT ON task_links
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT project_key, 'task', key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM tasks WHERE id = NEW.task_id;
      END;

CREATE TRIGGER task_links_change_update AFTER UPDATE ON task_links
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT project_key, 'task', key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM tasks WHERE id = NEW.task_id;
      END;

CREATE TRIGGER task_links_change_delete AFTER DELETE ON task_links
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT project_key, 'task', key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM tasks WHERE id = OLD.task_id;
      END;

CREATE TRIGGER attachments_change_insert AFTER INSERT ON attachments
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'task', NEW.task_key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER attachments_change_update AFTER UPDATE ON attachments
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'task', NEW.task_key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER attachments_change_delete AFTER DELETE ON attachments
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT OLD.project_key, 'task', OLD.task_key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER task_covers_change_insert AFTER INSERT ON task_covers
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'task', NEW.task_key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER task_covers_change_update AFTER UPDATE ON task_covers
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'task', NEW.task_key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER task_covers_change_delete AFTER DELETE ON task_covers
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT OLD.project_key, 'task', OLD.task_key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER task_fix_limits_change_insert AFTER INSERT ON task_fix_limits
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'task', NEW.task_key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER task_fix_limits_change_update AFTER UPDATE ON task_fix_limits
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'task', NEW.task_key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER task_fix_limits_change_delete AFTER DELETE ON task_fix_limits
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT OLD.project_key, 'task', OLD.task_key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER task_hand_ons_change_insert AFTER INSERT ON task_hand_ons
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'task', NEW.task_key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER task_hand_ons_change_update AFTER UPDATE ON task_hand_ons
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'task', NEW.task_key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER task_hand_ons_change_delete AFTER DELETE ON task_hand_ons
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT OLD.project_key, 'task', OLD.task_key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER task_handovers_change_insert AFTER INSERT ON task_handovers
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'task', NEW.task_key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER task_handovers_change_update AFTER UPDATE ON task_handovers
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'task', NEW.task_key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER task_handovers_change_delete AFTER DELETE ON task_handovers
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT OLD.project_key, 'task', OLD.task_key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER task_review_pins_change_insert AFTER INSERT ON task_review_pins
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'task', NEW.task_key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER task_review_pins_change_update AFTER UPDATE ON task_review_pins
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'task', NEW.task_key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER task_review_pins_change_delete AFTER DELETE ON task_review_pins
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT OLD.project_key, 'task', OLD.task_key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER task_loops_change_insert AFTER INSERT ON task_loops
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'task', NEW.task_key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER task_loops_change_update AFTER UPDATE ON task_loops
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'task', NEW.task_key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER task_loops_change_delete AFTER DELETE ON task_loops
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT OLD.project_key, 'task', OLD.task_key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER deferred_starts_change_insert AFTER INSERT ON deferred_starts
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'task', NEW.task_key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER deferred_starts_change_update AFTER UPDATE ON deferred_starts
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'task', NEW.task_key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER deferred_starts_change_delete AFTER DELETE ON deferred_starts
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT OLD.project_key, 'task', OLD.task_key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER full_test_runs_change_insert AFTER INSERT ON full_test_runs
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'task', NEW.task_key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER full_test_runs_change_update AFTER UPDATE ON full_test_runs
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'task', NEW.task_key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER full_test_runs_change_delete AFTER DELETE ON full_test_runs
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT OLD.project_key, 'task', OLD.task_key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER timeline_events_change_insert AFTER INSERT ON timeline_events
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'timeline', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER team_messages_change_insert AFTER INSERT ON team_messages
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'message', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER team_messages_change_update AFTER UPDATE ON team_messages
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'message', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER message_attachments_change_insert AFTER INSERT ON message_attachments
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'message', NEW.message_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER message_attachments_change_update AFTER UPDATE ON message_attachments
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'message', NEW.message_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER inbox_items_change_insert AFTER INSERT ON inbox_items
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'inbox', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER inbox_items_change_update AFTER UPDATE ON inbox_items
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'inbox', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER question_groups_change_insert AFTER INSERT ON question_groups
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'inbox', NEW.primary_item_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER question_groups_change_update AFTER UPDATE ON question_groups
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'inbox', NEW.primary_item_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER question_groups_change_delete AFTER DELETE ON question_groups
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT OLD.project_key, 'inbox', OLD.primary_item_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER projects_change_insert AFTER INSERT ON projects
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.key, 'configuration', NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER projects_change_update AFTER UPDATE ON projects
      WHEN OLD.config_version IS NOT NEW.config_version
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.key, 'configuration', NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER task_handoffs_change_insert AFTER INSERT ON task_handoffs
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'handoff', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER task_handoffs_change_update AFTER UPDATE ON task_handoffs
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'handoff', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER super_operation_audit_change_insert AFTER INSERT ON super_operation_audit
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'operation', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER task_merges_change_insert AFTER INSERT ON task_merges
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'operation', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER task_merges_change_update AFTER UPDATE ON task_merges
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'operation', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER merge_trains_change_insert AFTER INSERT ON merge_trains
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'operation', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER merge_trains_change_update AFTER UPDATE ON merge_trains
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'operation', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER releases_change_insert AFTER INSERT ON releases
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'operation', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER releases_change_update AFTER UPDATE ON releases
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'operation', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER super_handoffs_change_insert AFTER INSERT ON super_handoffs
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'handoff', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER super_handoffs_change_update AFTER UPDATE ON super_handoffs
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'handoff', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER super_operations_change_insert AFTER INSERT ON super_operations
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'operation', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER super_operations_change_update AFTER UPDATE ON super_operations
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'operation', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER history_documents_ai AFTER INSERT ON history_documents BEGIN
      INSERT INTO history_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
    END;

CREATE TRIGGER history_documents_ad AFTER DELETE ON history_documents BEGIN
      INSERT INTO history_fts(history_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
    END;

CREATE TRIGGER history_dirty_task_ai AFTER INSERT ON tasks BEGIN
      INSERT INTO history_dirty (project_key, source_type, entity_id)
        SELECT new.project_key, 'task', new.id WHERE 1
        ON CONFLICT (project_key, source_type, entity_id) DO UPDATE SET revision = revision + 1;
    END;

CREATE TRIGGER history_dirty_task_au AFTER UPDATE OF title, description, created_by, updated_at ON tasks BEGIN
      INSERT INTO history_dirty (project_key, source_type, entity_id)
        SELECT new.project_key, 'task', new.id WHERE 1
        ON CONFLICT (project_key, source_type, entity_id) DO UPDATE SET revision = revision + 1;
    END;

CREATE TRIGGER history_dirty_task_ad AFTER DELETE ON tasks BEGIN
      INSERT INTO history_dirty (project_key, source_type, entity_id)
        SELECT old.project_key, 'task', old.id WHERE 1
        ON CONFLICT (project_key, source_type, entity_id) DO UPDATE SET revision = revision + 1;
    END;

CREATE TRIGGER history_dirty_note_ai AFTER INSERT ON timeline_events BEGIN
      INSERT INTO history_dirty (project_key, source_type, entity_id)
        SELECT new.project_key, 'note', new.id WHERE new.type = 'task_note'
        ON CONFLICT (project_key, source_type, entity_id) DO UPDATE SET revision = revision + 1;
    END;

CREATE TRIGGER history_dirty_note_au AFTER UPDATE OF type, task_key, actor_handle, data, created_at ON timeline_events BEGIN
      INSERT INTO history_dirty (project_key, source_type, entity_id)
        SELECT new.project_key, 'note', new.id WHERE new.type = 'task_note'
        ON CONFLICT (project_key, source_type, entity_id) DO UPDATE SET revision = revision + 1;
    END;

CREATE TRIGGER history_dirty_note_au_old AFTER UPDATE OF type ON timeline_events BEGIN
      INSERT INTO history_dirty (project_key, source_type, entity_id)
        SELECT old.project_key, 'note', old.id WHERE old.type = 'task_note' AND new.type <> 'task_note'
        ON CONFLICT (project_key, source_type, entity_id) DO UPDATE SET revision = revision + 1;
    END;

CREATE TRIGGER history_dirty_note_ad AFTER DELETE ON timeline_events BEGIN
      INSERT INTO history_dirty (project_key, source_type, entity_id)
        SELECT old.project_key, 'note', old.id WHERE old.type = 'task_note'
        ON CONFLICT (project_key, source_type, entity_id) DO UPDATE SET revision = revision + 1;
    END;

CREATE TRIGGER history_dirty_question_ai AFTER INSERT ON inbox_items BEGIN
      INSERT INTO history_dirty (project_key, source_type, entity_id)
        SELECT new.project_key, 'question', new.id WHERE 1
        ON CONFLICT (project_key, source_type, entity_id) DO UPDATE SET revision = revision + 1;
    END;

CREATE TRIGGER history_dirty_question_au AFTER UPDATE ON inbox_items BEGIN
      INSERT INTO history_dirty (project_key, source_type, entity_id)
        SELECT new.project_key, 'question', new.id WHERE 1
        ON CONFLICT (project_key, source_type, entity_id) DO UPDATE SET revision = revision + 1;
    END;

CREATE TRIGGER history_dirty_question_ad AFTER DELETE ON inbox_items BEGIN
      INSERT INTO history_dirty (project_key, source_type, entity_id)
        SELECT old.project_key, 'question', old.id WHERE 1
        ON CONFLICT (project_key, source_type, entity_id) DO UPDATE SET revision = revision + 1;
    END;

CREATE TRIGGER history_dirty_message_ai AFTER INSERT ON team_messages BEGIN
      INSERT INTO history_dirty (project_key, source_type, entity_id)
        SELECT new.project_key, 'message', new.id WHERE 1
        ON CONFLICT (project_key, source_type, entity_id) DO UPDATE SET revision = revision + 1;
    END;

CREATE TRIGGER history_dirty_message_au AFTER UPDATE OF body, answer, origin, from_handle, to_handles, task_key, created_at ON team_messages BEGIN
      INSERT INTO history_dirty (project_key, source_type, entity_id)
        SELECT new.project_key, 'message', new.id WHERE 1
        ON CONFLICT (project_key, source_type, entity_id) DO UPDATE SET revision = revision + 1;
    END;

CREATE TRIGGER history_dirty_message_ad AFTER DELETE ON team_messages BEGIN
      INSERT INTO history_dirty (project_key, source_type, entity_id)
        SELECT old.project_key, 'message', old.id WHERE 1
        ON CONFLICT (project_key, source_type, entity_id) DO UPDATE SET revision = revision + 1;
    END;

CREATE TRIGGER doc_writes_change_insert AFTER INSERT ON doc_writes
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'operation', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER doc_writes_change_update AFTER UPDATE ON doc_writes
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'operation', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER merge_check_runs_change_insert AFTER INSERT ON merge_check_runs
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'operation', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER merge_check_runs_change_update AFTER UPDATE ON merge_check_runs
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'operation', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER history_semantic_dirty_ai AFTER INSERT ON history_documents BEGIN
      INSERT INTO history_semantic_dirty (source_id) VALUES (new.source_id)
      ON CONFLICT (source_id) DO UPDATE SET revision = revision + 1, attempts = 0, next_attempt_at = NULL;
    END;

CREATE TRIGGER operator_requests_change_insert AFTER INSERT ON operator_requests
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'operation', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER operator_requests_change_update AFTER UPDATE ON operator_requests
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'operation', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER operator_steps_change_insert AFTER INSERT ON operator_steps
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT project_key, 'operation', NEW.request_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM operator_requests WHERE id = NEW.request_id;
      END;

CREATE TRIGGER operator_steps_change_update AFTER UPDATE ON operator_steps
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT project_key, 'operation', NEW.request_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM operator_requests WHERE id = NEW.request_id;
      END;

CREATE TRIGGER history_documents_au AFTER UPDATE OF title, body ON history_documents
    WHEN old.title IS NOT new.title OR old.body IS NOT new.body BEGIN
      INSERT INTO history_fts(history_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
      INSERT INTO history_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
    END;

CREATE TRIGGER history_semantic_dirty_au AFTER UPDATE OF title, body, commit_sha ON history_documents
    WHEN old.title IS NOT new.title OR old.body IS NOT new.body OR old.commit_sha IS NOT new.commit_sha BEGIN
      INSERT INTO history_semantic_dirty (source_id) VALUES (new.source_id)
      ON CONFLICT (source_id) DO UPDATE SET revision = revision + 1, attempts = 0, next_attempt_at = NULL;
    END;

CREATE TRIGGER task_acceptance_items_change_insert AFTER INSERT ON task_acceptance_items
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT project_key, 'task', key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM tasks WHERE id = NEW.task_id;
      END;

CREATE TRIGGER task_acceptance_items_change_update AFTER UPDATE ON task_acceptance_items
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT project_key, 'task', key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM tasks WHERE id = NEW.task_id;
      END;

CREATE TRIGGER task_acceptance_items_change_delete AFTER DELETE ON task_acceptance_items
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT project_key, 'task', key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM tasks WHERE id = OLD.task_id;
      END;

CREATE TRIGGER pauses_change_insert AFTER INSERT ON pauses
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT key, 'pause', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM projects WHERE NEW.project_key IS NULL OR key = NEW.project_key;
      END;

CREATE TRIGGER pauses_change_update AFTER UPDATE ON pauses
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT key, 'pause', NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM projects WHERE NEW.project_key IS NULL OR key = NEW.project_key;
      END;

CREATE TRIGGER session_pauses_change_insert AFTER INSERT ON session_pauses
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'pause', NEW.pause_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER session_pauses_change_update AFTER UPDATE ON session_pauses
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT NEW.project_key, 'pause', NEW.pause_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
      END;

CREATE TRIGGER history_dirty_note_edit_ai AFTER INSERT ON timeline_events
      WHEN new.type = 'task_note_edited' BEGIN
      INSERT INTO history_dirty (project_key, source_type, entity_id)
        VALUES (new.project_key, 'note', json_extract(new.data, '$.noteId'))
        ON CONFLICT (project_key, source_type, entity_id) DO UPDATE SET revision = revision + 1;
    END;

INSERT INTO instance_meta (key, value)
      SELECT 'project_change_generation',
        lower(substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-4' || substr(h, 14, 3) || '-' ||
          substr('89ab', 1 + abs(random()) % 4, 1) || substr(h, 18, 3) || '-' || substr(h, 21, 12))
      FROM (SELECT hex(randomblob(16)) AS h);
`;
