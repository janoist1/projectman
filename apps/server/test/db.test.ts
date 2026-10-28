import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { InboxItem, Session, Task } from '@projectman/shared';
import Database from 'better-sqlite3';
import {
  createRepositories,
  decodeWorkItem,
  encodeWorkItem,
  LATEST_SCHEMA_VERSION,
  migrate,
  openDatabase,
  schemaVersion,
} from '../src/db';
import { migrations } from '../src/db/migrations';

const now = '2026-09-29T10:00:00.000Z';

describe('legacy task check migration', () => {
  function legacyTask(checks: string, labels: string[]) {
    const db = new Database(':memory:');
    for (const migration of migrations.filter((item) => item.version <= 114)) db.exec(migration.sql);
    db.pragma('user_version = 114');
    // The repositories prepare statements for the current schema: add the columns of migration 116
    // (PM-1071) for that, and drop them again below so that migrating can add them.
    db.exec('ALTER TABLE team_messages ADD COLUMN location TEXT');
    db.exec('ALTER TABLE team_messages ADD COLUMN places TEXT');
    // The same for migration 119 (PM-1062).
    db.exec('ALTER TABLE projects ADD COLUMN created_by TEXT');
    // And for migration 122 (PM-1064): the handle rename prepares an update of its table.
    db.exec('CREATE TABLE host_requests (opened_by TEXT, project_key TEXT)');
    const repos = createRepositories(db);
    repos.projects.insert({
      key: 'AR',
      name: 'Acme',
      templateId: null,
      configVersion: 'v1',
      createdAt: now,
      updatedAt: now,
    });
    repos.tasks.insert(sampleTask({ labels }));
    db.prepare('UPDATE tasks SET checks = ? WHERE key = ?').run(checks, 'AR-1');
    db.exec('DROP TABLE host_requests');
    db.exec('ALTER TABLE team_messages DROP COLUMN location');
    db.exec('ALTER TABLE team_messages DROP COLUMN places');
    db.exec('ALTER TABLE projects DROP COLUMN created_by');
    return repos;
  }

  it.each([
    ['passed', ['code-review-ok', 'security-ok', 'qa-ok', 'client-accepted']],
    ['failed', ['code-review-changes', 'security-changes', 'qa-failed', 'client-changes']],
    ['blocked', ['code-review-blocked', 'security-changes', 'qa-failed', 'client-changes']],
    ['retest_needed', ['code-review-changes', 'security-changes', 'qa-retest', 'client-changes']],
    ['pending', []],
  ] as const)('folds %s checks into labels without losing or duplicating labels', (state, expected) => {
    const checks = JSON.stringify({
      code_review: state,
      security_review: state,
      qa: state,
      client_test: state,
    });
    const repos = legacyTask(checks, ['frontend', 'frontend', ...expected.slice(0, 1)]);
    try {
      migrate(repos.db);
      expect(repos.tasks.get('AR-1')!.labels).toEqual(['frontend', ...expected]);
      expect(repos.db.prepare('SELECT checks FROM tasks WHERE key = ?').get('AR-1')).toEqual({
        checks: '{}',
      });
    } finally {
      repos.db.close();
    }
  });

  it.each(['{"unknown":"passed","qa":"unknown"}', 'invalid json', '{}'])(
    'preserves labels when checks have no known state: %s',
    (checks) => {
      const repos = legacyTask(checks, ['frontend']);
      try {
        migrate(repos.db);
        expect(repos.tasks.get('AR-1')!.labels).toEqual(['frontend']);
        expect(repos.db.prepare('SELECT checks FROM tasks WHERE key = ?').get('AR-1')).toEqual({
          checks: '{}',
        });
      } finally {
        repos.db.close();
      }
    },
  );
});

it('keeps legacy member activity with a null source card', () => {
  const db = new Database(':memory:');
  try {
    for (const migration of migrations.filter((item) => item.version < 108)) db.exec(migration.sql);
    db.pragma('user_version = 107');
    db.prepare(
      `INSERT INTO member_state (project_key, handle, status, activity, updated_at)
      VALUES ('AR', 'dev-1', 'working', 'Read file', ?)`,
    ).run(now);
    migrate(db);
    expect(createRepositories(db).memberState.get('AR', 'dev-1')).toMatchObject({
      activity: 'Read file',
      activityTaskKey: null,
    });
  } finally {
    db.close();
  }
});

it('preserves queue rows and indexes while adding checklist notices', () => {
  const db = new Database(':memory:');
  try {
    for (const migration of migrations.filter((item) => item.version <= 106)) db.exec(migration.sql);
    db.pragma('user_version = 106');
    db.prepare(
      `INSERT INTO projects (key, name, template_id, config_version, created_at, updated_at)
      VALUES ('AR', 'Acme', NULL, 'v1', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO member_queue_items (id, project_key, member, kind, source_type, source_id, place, queued_at, payload, wait_details)
      VALUES ('old', 'AR', 'dev-1', 'start', 'start', 'old-start', '{"type":"general"}', ?, '{"spec":1}', '{"provider":"claude"}')`,
    ).run(now);
    const before = db.prepare('SELECT * FROM member_queue_items').all();
    migrate(db);
    expect(db.prepare('SELECT * FROM member_queue_items').all()).toEqual(before);
    db.prepare(
      `INSERT INTO member_queue_items (id, project_key, member, kind, source_type, source_id, place, queued_at)
      VALUES ('new', 'AR', 'dev-1', 'checklist', 'checklist', 'onboarding', '{"type":"general"}', ?)`,
    ).run(now);
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'member_queue_items_%'")
        .all(),
    ).toHaveLength(3);
  } finally {
    db.close();
  }
});

it('assigns a unique schema version to every migration', () => {
  const versions = migrations.map(({ version }) => version);
  expect(versions).toEqual([...new Set(versions)]);
});

it('adds question groups after the refinement stalled signals migration without changing existing questions', () => {
  const db = new Database(':memory:');
  try {
    for (const migration of migrations.filter((item) => item.version <= 71)) db.exec(migration.sql);
    db.pragma('user_version = 71');
    const insert = db.prepare(`INSERT INTO inbox_items
      (id, project_key, kind, assignees, source, title, payload, options, state, created_at, updated_at)
      VALUES (?, 'AR', 'question', '["owner"]', 'dev-1', ?, '{}', '[]', 'screening', ?, ?)`);
    insert.run('inb_first', 'First question?', now, now);
    insert.run('inb_second', 'Second question?', now, now);
    const before = db.prepare('SELECT * FROM inbox_items ORDER BY seq').all();
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'question_groups'").get(),
    ).toBeUndefined();

    expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
    expect(db.prepare('SELECT * FROM inbox_items ORDER BY seq').all()).toEqual(before);
    expect(db.prepare('SELECT * FROM operator_execution_intents').all()).toEqual([]);
    const inbox = createRepositories(db).inbox;
    inbox.createGroup({
      primaryItemId: 'inb_first',
      projectKey: 'AR',
      question: 'Combined question?',
      by: 'pm',
      note: 'Both need the same decision.',
      itemIds: ['inb_first', 'inb_second'],
      at: now,
    });
    expect(inbox.groupOf('inb_second')).toMatchObject({
      primaryItemId: 'inb_first',
      itemIds: ['inb_first', 'inb_second'],
    });
    expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
    expect(inbox.groupOf('inb_first')?.question).toBe('Combined question?');
  } finally {
    db.close();
  }
});

it('preserves existing merge rows and failure diagnostics through migration 49', () => {
  const db = new Database(':memory:');
  try {
    for (const migration of migrations.filter((m) => m.version <= 48)) db.exec(migration.sql);
    db.pragma('user_version = 48');
    const failure = { reason: 'conflict', base: 'onto', at: now, files: ['a.ts'] };
    db.prepare(
      `INSERT INTO task_merges (id, project_key, task_key, repo, base, "commit", from_stage_id, to_stage_id, merger, requested_at, state, landed, failure_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'm',
      'AR',
      'AR-1',
      'web',
      'main',
      'approved',
      'review',
      'done',
      'owner',
      now,
      'failed',
      'nowhere',
      JSON.stringify(failure),
      now,
      now,
    );
    migrate(db);
    const repository = createRepositories(db).taskMerges;
    const row = repository.get('m')!;
    expect(row).toMatchObject({ state: 'failed', commit: 'approved', failure });
    repository.save({
      ...row,
      state: 'fixing',
      fix: { by: 'owner', base: 'onto', branch: 'merge-fix/AR-1', startedAt: now },
    });
    expect(repository.open('AR', 'AR-1')?.state).toBe('fixing');
    repository.save({
      ...row,
      state: 'merged',
      commit: 'resolved',
      resolution: { note: 'Resolve imports in a.ts', commit: 'resolved' },
    });
    expect(repository.latestMerged('AR', 'AR-1')?.resolution).toEqual({
      note: 'Resolve imports in a.ts',
      commit: 'resolved',
    });
  } finally {
    db.close();
  }
});

describe('merge migration 48', () => {
  it('backfills persistent handovers from review pins and allows only one open merge per card', () => {
    const db = new Database(':memory:');
    try {
      const prior = migrations.filter((item) => item.version < 48);
      for (const migration of prior) db.exec(migration.sql);
      db.pragma(`user_version = ${Math.max(...prior.map((item) => item.version))}`);
      // Seed the historical schema directly: current repositories require later migrations.
      db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?)').run('AR', 'acme', null, 'v1', now, now);
      const task = sampleTask();
      db.prepare(
        `INSERT INTO tasks
        (id, project_key, key, seq, title, stage_id, status, visibility, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        task.id,
        task.projectKey,
        task.key,
        1,
        task.title,
        task.stageId,
        task.status,
        'internal',
        task.createdBy,
        task.createdAt,
        task.updatedAt,
      );
      db.prepare('INSERT INTO task_review_pins VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        'AR',
        'AR-1',
        'review',
        'approved',
        'task/AR-1',
        now,
        'dev-1',
      );
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      const repos = createRepositories(db);
      expect(repos.taskHandovers.get('AR', 'AR-1')).toEqual({ commit: 'approved', branch: 'task/AR-1' });
      repos.reviewPins.clear('AR-1');
      expect(repos.taskHandovers.get('AR', 'AR-1')?.commit).toBe('approved');
      const row = {
        id: 'm1',
        projectKey: 'AR',
        taskKey: 'AR-1',
        repo: 'web',
        base: 'main',
        commit: 'approved',
        branch: 'task/AR-1',
        fromStageId: 'review',
        toStageId: 'done',
        merger: 'owner',
        requestedAt: now,
        state: 'queued' as const,
        step: 'queued' as const,
        landed: 'nowhere' as const,
        createdAt: now,
        updatedAt: now,
      };
      repos.taskMerges.save(row);
      expect(() => repos.taskMerges.save({ ...row, id: 'm2' })).toThrow();
      repos.taskMerges.save({ ...row, state: 'blocked' });
      expect(() => repos.taskMerges.save({ ...row, id: 'm2' })).toThrow();
      const fix = { by: 'owner', branch: 'merge-fix/AR-1', base: 'onto', startedAt: now };
      repos.taskMerges.save({ ...row, state: 'fixing', fix });
      expect(repos.taskMerges.open('AR', 'AR-1')).toMatchObject({ state: 'fixing', fix });
      expect(() => repos.taskMerges.save({ ...row, id: 'm2' })).toThrow();
      repos.taskMerges.save({ ...row, state: 'cancelled' });
      expect(() => repos.taskMerges.save({ ...row, id: 'm2' })).not.toThrow();
    } finally {
      db.close();
    }
  });
});

function sampleTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'tsk_1',
    projectKey: 'AR',
    key: 'AR-1',
    title: 'Login page',
    description: 'Build it',
    stageId: 'backlog',
    status: 'active',
    assignee: null,
    repo: null,
    priority: null,
    labels: ['frontend'],
    links: [{ kind: 'branch', ref: 'feature/login' }],
    createdBy: 'owner',
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    ...overrides,
  };
}

describe('database', () => {
  it('lists only unresolved signals of the project in raised time and insertion order', () => {
    const db = openDatabase(':memory:');
    try {
      const repos = createRepositories(db);
      for (const key of ['AR', 'XY'])
        repos.projects.insert({
          key,
          name: key,
          templateId: null,
          configVersion: 'v1',
          createdAt: now,
          updatedAt: now,
        });
      const insert = (id: string, projectKey: string, raisedAt: string, resolvedAt: string | null = null) => {
        repos.operatorSignals.insert({
          id,
          projectKey,
          raisedAt,
          resolvedAt,
          caseKey: id,
          kind: 'outage',
          state: resolvedAt ? 'resolved' : 'pending',
          actionable: false,
          taskKey: null,
          subject: null,
          inboxItemId: null,
          messageId: null,
          decidedBy: null,
          decidedAt: null,
          deliveredAt: null,
          deliveredTo: null,
          followUpAt: null,
          decisionNote: null,
        });
      };
      insert('later', 'AR', '2026-09-30T10:00:00.000Z');
      insert('tie-z', 'AR', now);
      insert('closed', 'AR', now, now);
      insert('other-project', 'XY', now);
      insert('tie-a', 'AR', now);
      expect(repos.operatorSignals.listOpen('AR').map((s) => s.id)).toEqual(['tie-z', 'tie-a', 'later']);
      expect(repos.operatorSignals.list('AR').map((s) => s.id)).toEqual([
        'tie-z',
        'closed',
        'tie-a',
        'later',
      ]);
    } finally {
      db.close();
    }
  });

  it('persists stable priority numbers and reads unknown stored levels as unset', () => {
    const db = openDatabase(':memory:');
    const repos = createRepositories(db);
    repos.projects.insert({
      key: 'AR',
      name: 'acme',
      templateId: null,
      configVersion: 'v1',
      createdAt: now,
      updatedAt: now,
    });
    const levels = ['urgent', 'high', 'normal', 'low', null] as const;
    for (const [index, priority] of levels.entries()) {
      const key = `AR-${index + 1}`;
      repos.tasks.insert(sampleTask({ key, id: `tsk_${index + 1}`, priority }));
      expect(repos.tasks.get(key)!.priority).toBe(priority);
      expect(db.prepare('SELECT priority FROM tasks WHERE key = ?').get(key)).toEqual({
        priority: priority === null ? null : index + 1,
      });
    }
    for (const priority of levels) {
      repos.tasks.update('tsk_1', { priority });
      expect(repos.tasks.get('AR-1')!.priority).toBe(priority);
    }
    db.prepare('UPDATE tasks SET priority = 7 WHERE key = ?').run('AR-1');
    expect(repos.tasks.get('AR-1')!.priority).toBeNull();
    db.close();
  });
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('applies migrations once and records the schema version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-db-'));
    dirs.push(dir);
    const db = openDatabase(join(dir, 'db.sqlite'));
    expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    ).map((r) => r.name);
    for (const t of [
      'users',
      'auth_sessions',
      'projects',
      'tasks',
      'task_links',
      'timeline_events',
      'sessions',
      'team_messages',
      'inbox_items',
      'member_state',
      'counters',
      'deferred_starts',
    ]) {
      expect(tables).toContain(t);
    }
    db.close();
  });

  it('maps tasks, links and counters', () => {
    const repos = createRepositories(openDatabase(':memory:'));
    repos.projects.insert({
      key: 'AR',
      name: 'acme',
      templateId: null,
      configVersion: 'v1',
      createdAt: now,
      updatedAt: now,
    });
    expect(repos.counters.next('AR', 'task')).toBe(1);
    expect(repos.counters.next('AR', 'task')).toBe(2);
    expect(repos.counters.next('XY', 'task')).toBe(1);

    repos.tasks.insert(sampleTask());
    repos.tasks.insert(sampleTask({ id: 'tsk_2', key: 'AR-2', title: 'Second', links: [] }));
    const task = repos.tasks.get('AR-1')!;
    expect(task.labels).toEqual(['frontend']);
    expect(task.links).toEqual([{ kind: 'branch', ref: 'feature/login' }]);

    expect(
      repos.tasks.upsertLink(
        task.id,
        { kind: 'pull_request', ref: '12', repo: 'acme/web', state: 'open' },
        now,
      ),
    ).toBe('inserted');
    expect(
      repos.tasks.upsertLink(
        task.id,
        { kind: 'pull_request', ref: '12', repo: 'acme/web', state: 'open' },
        now,
      ),
    ).toBe('unchanged');
    expect(repos.tasks.listWatchablePullRequests()).toEqual([
      { projectKey: 'AR', taskKey: 'AR-1', repo: 'acme/web', number: 12, state: 'open' },
    ]);
    expect(
      repos.tasks.updatePullRequestLinks('AR', 'acme/web', 12, { state: 'merged', title: 'Login' }, now),
    ).toEqual(['AR-1']);
    expect(repos.tasks.get('AR-1')!.links[1]).toEqual({
      kind: 'pull_request',
      ref: '12',
      repo: 'acme/web',
      title: 'Login',
      state: 'merged',
    });
    expect(repos.tasks.listWatchablePullRequests()).toEqual([]);

    const list = repos.tasks.list('AR');
    expect(list.map((t) => t.key)).toEqual(['AR-1', 'AR-2']);
    expect(list[0]!.links).toHaveLength(2);

    repos.tasks.update(task.id, { stageId: 'development', assignee: 'dev-1', updatedAt: now });
    expect(repos.tasks.listByAssignee('AR', 'dev-1').map((t) => t.key)).toEqual(['AR-1']);
  });

  it('keeps a pull request linked from two projects apart: a change in one never touches the other', () => {
    const repos = createRepositories(openDatabase(':memory:'));
    const link = { kind: 'pull_request' as const, ref: '12', repo: 'acme/web', state: 'open' as const };
    for (const key of ['AR', 'XY'])
      repos.projects.insert({
        key,
        name: key,
        templateId: null,
        configVersion: 'v1',
        createdAt: now,
        updatedAt: now,
      });
    repos.tasks.insert(sampleTask({ links: [] }));
    repos.tasks.insert(sampleTask({ id: 'tsk_b', projectKey: 'XY', key: 'XY-1', links: [] }));
    repos.tasks.upsertLink('tsk_1', link, now);
    repos.tasks.upsertLink('tsk_b', link, now);
    repos.tasks.recordPullRequestHead('AR', 'acme/web', 12, 'sha1', now);
    repos.tasks.recordPullRequestHead('XY', 'acme/web', 12, 'sha1', now);

    expect(repos.tasks.findByPullRequest('XY', 'acme/web', 12)).toEqual([
      { projectKey: 'XY', taskKey: 'XY-1' },
    ]);
    expect(repos.tasks.updatePullRequestLinks('XY', 'acme/web', 12, { state: 'merged' }, now)).toEqual([
      'XY-1',
    ]);
    expect(repos.tasks.recordPullRequestHead('XY', 'acme/web', 12, 'sha2', now)).toEqual([
      { projectKey: 'XY', taskKey: 'XY-1' },
    ]);
    expect(repos.tasks.get('AR-1')!.links[0]).toMatchObject({ state: 'open' });
    expect(repos.tasks.recordPullRequestHead('AR', 'acme/web', 12, 'sha1', now)).toEqual([]);
  });

  it('writes only the task fields a change names, and reads subtasks and assignments with their links', () => {
    const repos = createRepositories(openDatabase(':memory:'));
    repos.projects.insert({
      key: 'AR',
      name: 'acme',
      templateId: null,
      configVersion: 'v1',
      createdAt: now,
      updatedAt: now,
    });
    repos.tasks.insert(sampleTask());
    repos.tasks.insert(sampleTask({ id: 'tsk_2', key: 'AR-2', parentKey: 'AR-1', assignee: 'dev-1' }));
    repos.tasks.insert(
      sampleTask({ id: 'tsk_3', key: 'AR-3', parentKey: 'AR-1', assignee: 'dev-1', links: [] }),
    );
    // Two writers, each with its own field: neither undoes the other.
    repos.tasks.update('tsk_1', { labels: ['frontend', 'waiting'] });
    repos.tasks.update('tsk_1', { title: 'Login page v2', parentKey: null });
    expect(repos.tasks.get('AR-1')).toMatchObject({
      title: 'Login page v2',
      labels: ['frontend', 'waiting'],
      parentKey: null,
    });
    repos.tasks.update('tsk_1', { labels: ['frontend'] });
    expect(repos.tasks.get('AR-1')!.labels).toEqual(['frontend']);

    for (const tasks of [repos.tasks.children('AR', 'AR-1'), repos.tasks.listByAssignee('AR', 'dev-1')]) {
      expect(tasks.map((t) => [t.key, t.links.length])).toEqual([
        ['AR-2', 1],
        ['AR-3', 0],
      ]);
    }
    expect(repos.tasks.children('AR', 'AR-2')).toEqual([]);
  });

  it("records each earlier session's provider from its transcript file name", () => {
    const db = new Database(':memory:');
    try {
      for (const migration of migrations.filter((item) => item.version <= 8)) db.exec(migration.sql);
      db.pragma('user_version = 8');
      const insert = db.prepare(
        `INSERT INTO sessions (id, project_key, member, work_item_type, work_item_ref, claude_session_id, cwd,
           transcript_path, state, started_at, last_activity_at)
         VALUES (?, 'AR', ?, 'general', '', '0b7c6a1e-8f7b-4c1e-9d55-0d8c0f4e7a11', '/w', ?, 'exited', ?, ?)`,
      );
      const transcripts: Array<[string, string | null, string]> = [
        ['dev-1', '/home/anna/.codex/sessions/2026/01/01/rollout-2026-01-01T00-00-00-a.jsonl', 'codex'],
        ['dev-2', '/home/anna/.codex/sessions/2025/12/01/rollout-2025-12-01T00-00-00-b.jsonl.zst', 'codex'],
        ['dev-3', 'rollout-local.jsonl', 'codex'],
        ['dev-4', '/home/anna/.claude/projects/-w/0b7c6a1e.jsonl', 'claude'],
        ['dev-5', '/home/anna/rollout-notes/session.jsonl', 'claude'],
        ['dev-6', '/home/anna/rollout-a.jsonl.bak', 'claude'],
        ['dev-7', null, 'claude'],
      ];
      for (const [member, path] of transcripts) insert.run(`ses_${member}`, member, path, now, now);
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      const repos = createRepositories(db);
      expect(transcripts.map(([member]) => repos.sessions.get(`ses_${member}`)?.provider)).toEqual(
        transcripts.map(([, , provider]) => provider),
      );
    } finally {
      db.close();
    }
  });

  it('repairs the provider of Codex sessions an older build recorded after the migration', () => {
    const db = openDatabase(':memory:');
    try {
      // A build from before migration 9 knows nothing of the column and leaves it at its default.
      db.prepare(
        `INSERT INTO sessions (id, project_key, member, work_item_type, work_item_ref, claude_session_id, cwd,
           transcript_path, state, started_at, last_activity_at)
         VALUES ('ses_cx', 'AR', 'cx-1', 'general', '', '0b7c6a1e-8f7b-4c1e-9d55-0d8c0f4e7a11', '/w',
           '/home/anna/.codex/sessions/2026/01/01/rollout-2026-01-01T00-00-00-a.jsonl', 'exited', ?, ?)`,
      ).run(now, now);
      expect(createRepositories(db).sessions.get('ses_cx')?.provider).toBe('claude');
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(createRepositories(db).sessions.get('ses_cx')?.provider).toBe('codex');
    } finally {
      db.close();
    }
  });

  it('stores deferred starts one per key, oldest first, and reads a broken value as null', () => {
    const repos = createRepositories(openDatabase(':memory:'));
    const record = (key: string, reason: string) => ({
      key,
      projectKey: 'AR',
      taskKey: key.startsWith('message') ? null : 'AR-1',
      spec: { kind: key.split(':')[0], projectKey: 'AR' },
      waiting: { reason, since: now },
    });
    repos.deferredStarts.save(record('hand-over:AR:AR-1', 'ai_disabled'));
    repos.deferredStarts.save(record('message:AR:cr:general', 'plan_usage_paused'));
    expect(repos.deferredStarts.list().map((r) => r.key)).toEqual([
      'hand-over:AR:AR-1',
      'message:AR:cr:general',
    ]);
    expect(repos.deferredStarts.list()[1]).toEqual(record('message:AR:cr:general', 'plan_usage_paused'));

    // Deferred again: the row is replaced, and it counts as the newest.
    repos.deferredStarts.save(record('hand-over:AR:AR-1', 'member_at_capacity'));
    expect(repos.deferredStarts.list().map((r) => [r.key, (r.waiting as { reason: string }).reason])).toEqual(
      [
        ['message:AR:cr:general', 'plan_usage_paused'],
        ['hand-over:AR:AR-1', 'member_at_capacity'],
      ],
    );

    repos.db
      .prepare(
        `UPDATE deferred_starts SET spec = 'not json', waiting = '' WHERE key = 'message:AR:cr:general'`,
      )
      .run();
    expect(repos.deferredStarts.list()[0]).toMatchObject({ spec: null, waiting: null });
    repos.deferredStarts.remove('message:AR:cr:general');
    repos.deferredStarts.remove('unknown');
    expect(repos.deferredStarts.list().map((r) => r.key)).toEqual(['hand-over:AR:AR-1']);
  });

  it('refuses a database written by a newer build', () => {
    const db = openDatabase(':memory:');
    db.pragma(`user_version = ${LATEST_SCHEMA_VERSION + 1}`);
    expect(() => migrate(db)).toThrow(/schema version .* newer build/);
    db.close();
  });

  it('counts the resumable sessions: finished or failed ones of an open card or of a general chat', () => {
    const repos = createRepositories(openDatabase(':memory:'));
    repos.projects.insert({
      key: 'AR',
      name: 'acme',
      templateId: null,
      configVersion: 'v1',
      createdAt: now,
      updatedAt: now,
    });
    repos.tasks.insert(sampleTask());
    repos.tasks.insert(sampleTask({ id: 'tsk_2', key: 'AR-2', status: 'done' }));
    repos.tasks.insert(sampleTask({ id: 'tsk_3', key: 'AR-3', status: 'cancelled' }));
    const base: Session = {
      id: 'ses_0',
      projectKey: 'AR',
      member: 'dev-1',
      workItem: { type: 'task', taskKey: 'AR-1' },
      claudeSessionId: '',
      cwd: '/tmp/work',
      branch: null,
      transcriptPath: null,
      state: 'exited',
      activity: null,
      startedAt: now,
      lastActivityAt: now,
      endedAt: now,
    };
    const add = (id: string, over: Partial<Session>) =>
      repos.sessions.insert({ ...base, id, claudeSessionId: `claude-${id}`, ...over });
    expect(repos.sessions.countResumable()).toBe(0);
    add('ses_open', {});
    add('ses_failed', { member: 'dev-2', state: 'failed' });
    add('ses_chat', { member: 'dev-3', workItem: { type: 'general' } });
    add('ses_running', { member: 'dev-4', state: 'working', endedAt: null });
    add('ses_done', { member: 'dev-5', workItem: { type: 'task', taskKey: 'AR-2' } });
    add('ses_cancelled', { member: 'dev-6', workItem: { type: 'task', taskKey: 'AR-3' } });
    add('ses_unknown', { member: 'dev-7', workItem: { type: 'task', taskKey: 'AR-9' } });
    expect(repos.sessions.countResumable()).toBe(3);
  });

  it('finds only the latest source-bearing task session in the requested project (PM-818)', () => {
    const db = openDatabase(':memory:');
    const repos = createRepositories(db);
    const add = (id: string, over: Partial<Session> = {}) =>
      repos.sessions.insert({
        id,
        projectKey: 'AR',
        member: id,
        workItem: { type: 'task', taskKey: 'AR-1' },
        claudeSessionId: id,
        cwd: '/work',
        branch: null,
        transcriptPath: null,
        state: 'exited',
        activity: null,
        startedAt: now,
        lastActivityAt: now,
        endedAt: now,
        ...over,
      });
    try {
      add('ses_without_source');
      expect(repos.sessions.latestSourceOfTask('AR', 'AR-1')).toBeNull();
      add('ses_branch', { branch: 'task/AR-1', engineId: 'eng_abcdefghijkl' });
      expect(repos.sessions.latestSourceOfTask('AR', 'AR-1')?.id).toBe('ses_branch');
      add('ses_review', { startedAt: '2026-09-30T10:00:00.000Z' });
      repos.sessions.setReviewedCommit('ses_review', 'reviewed');
      add('ses_newer_without_source', { startedAt: '2026-10-01T10:00:00.000Z' });
      add('ses_other_project', {
        projectKey: 'OTHER',
        branch: 'other',
        startedAt: '2026-10-01T10:00:00.000Z',
      });
      add('ses_other_task', { workItem: { type: 'task', taskKey: 'AR-2' }, branch: 'other' });
      add('ses_chat', { workItem: { type: 'general' }, branch: 'other' });
      expect(repos.sessions.latestSourceOfTask('AR', 'AR-1')?.id).toBe('ses_review');
      expect(repos.sessions.latestSourceOfTask('AR', 'AR-3')).toBeNull();
    } finally {
      db.close();
    }
  });

  it('maps sessions, timeline, messages, inbox and member state', () => {
    const repos = createRepositories(openDatabase(':memory:'));
    const session: Session = {
      id: 'ses_1',
      projectKey: 'AR',
      member: 'dev-1',
      workItem: { type: 'task', taskKey: 'AR-1' },
      claudeSessionId: '0b7c6a1e-8f7b-4c1e-9d55-0d8c0f4e7a11',
      provider: 'codex',
      cwd: '/tmp/work',
      branch: null,
      transcriptPath: null,
      state: 'starting',
      activity: null,
      startedAt: now,
      lastActivityAt: now,
      endedAt: null,
    };
    repos.sessions.insert(session);
    expect(repos.sessions.findByWorkItem('AR', 'dev-1', { type: 'task', taskKey: 'AR-1' })).toEqual(session);
    expect(repos.sessions.findByWorkItem('AR', 'dev-1', { type: 'general' })).toBeNull();
    expect(() => repos.sessions.insert({ ...session, id: 'ses_2' })).toThrow();
    const updated = repos.sessions.update('ses_1', { state: 'working', activity: 'Bash: npm test' })!;
    expect(updated.state).toBe('working');
    expect(repos.sessions.update('ses_1', { provider: 'claude' })?.provider).toBe('claude');
    const { provider: _, ...withoutProvider } = { ...session, id: 'ses_3', member: 'dev-2' };
    repos.sessions.insert(withoutProvider);
    expect(repos.sessions.get('ses_3')?.provider).toBe('claude');
    expect(repos.sessions.list('AR', { member: 'dev-1', taskKey: 'AR-1' }).map((s) => s.id)).toEqual([
      'ses_1',
    ]);
    expect(repos.sessions.list('AR', { taskKey: 'AR-1' }).map((s) => s.id)).toEqual(['ses_1', 'ses_3']);
    expect(repos.sessions.listInStates(['working']).map((s) => s.id)).toEqual(['ses_1']);

    for (let i = 1; i <= 3; i++) {
      repos.timeline.insert({
        id: `evt_${i}`,
        projectKey: 'AR',
        taskKey: 'AR-1',
        sessionId: null,
        actor: { kind: 'human', handle: 'owner' },
        type: 'task_note',
        data: { text: `note ${i}` },
        createdAt: now,
      });
    }
    expect(repos.timeline.list('AR', { taskKey: 'AR-1', limit: 2 }).map((e) => e.id)).toEqual([
      'evt_2',
      'evt_3',
    ]);
    repos.timeline.insert({
      id: 'evt_q',
      projectKey: 'AR',
      taskKey: 'AR-1',
      sessionId: null,
      actor: { kind: 'human', handle: 'owner' },
      type: 'question_asked',
      data: { inboxItemId: 'inb_1' },
      createdAt: now,
    });
    // Only the given types, the most recent `limit` of them, oldest first.
    expect(
      repos.timeline.listOfTypes('AR', 'AR-1', ['task_note', 'question_asked'], 3).map((e) => e.id),
    ).toEqual(['evt_2', 'evt_3', 'evt_q']);
    expect(repos.timeline.listOfTypes('AR', 'AR-1', ['question_asked'], 5).map((e) => e.id)).toEqual([
      'evt_q',
    ]);
    expect(repos.timeline.listOfTypes('AR', 'AR-2', ['task_note'], 5)).toEqual([]);
    expect(repos.timeline.listOfTypes('AR', 'AR-1', [], 5)).toEqual([]);

    repos.messages.insert({
      id: 'msg_1',
      projectKey: 'AR',
      from: 'qa',
      to: ['dev-1', 'owner'],
      taskKey: 'AR-1',
      body: 'Please fix',
      createdAt: now,
      deliveredAt: null,
    });
    expect(repos.messages.list('AR', { member: 'owner' }).map((m) => m.id)).toEqual(['msg_1']);
    expect(repos.messages.list('AR', { member: 'someone' })).toEqual([]);
    expect(repos.messages.markDelivered('msg_1', now)!.deliveredAt).toBe(now);

    const item: InboxItem = {
      id: 'inb_1',
      projectKey: 'AR',
      kind: 'permission',
      assignees: ['owner'],
      source: 'dev-1',
      sessionId: 'ses_1',
      taskKey: 'AR-1',
      title: 'Bash: rm -rf dist',
      body: null,
      payload: { toolName: 'Bash' },
      options: [{ id: 'allow', label: 'allow', style: 'primary' }],
      state: 'open',
      resolution: null,
      createdAt: now,
    };
    repos.inbox.insert(item);
    expect(repos.inbox.get('inb_1')).toEqual(item);
    expect(repos.inbox.countOpenFor('AR', 'owner')).toBe(1);
    const resolution = { optionId: 'allow', by: 'owner', at: now, note: null };
    expect(repos.inbox.close('inb_1', 'resolved', resolution, now)!.resolution).toEqual(resolution);
    expect(repos.inbox.close('inb_1', 'expired', null, now)).toBeNull();
    expect(repos.inbox.countOpenFor('AR', 'owner')).toBe(0);

    const gate = (id: string, requestId: string, to: string): InboxItem => ({
      ...item,
      id,
      kind: 'decision',
      payload: { gate: { requestId, taskKey: 'AR-1', fromStageId: 'code_review', toStageId: to } },
    });
    repos.inbox.insert(gate('inb_2', 'gat_1', 'merge'));
    repos.inbox.insert(gate('inb_3', 'gat_1', 'merge'));
    repos.inbox.insert(gate('inb_4', 'gat_2', 'release'));
    repos.inbox.close('inb_3', 'resolved', resolution, now);
    const ids = (items: InboxItem[]) => items.map((i) => i.id);
    expect(ids(repos.inbox.listGateRequest('AR', 'AR-1', 'gat_1'))).toEqual(['inb_2', 'inb_3']);
    expect(ids(repos.inbox.listGateRequest('AR', 'AR-2', 'gat_1'))).toEqual([]);
    expect(ids(repos.inbox.listOpenGateRequests('AR', 'AR-1', 'code_review', 'merge'))).toEqual(['inb_2']);
    expect(ids(repos.inbox.listOpenGateRequests('AR', 'AR-1', 'merge', 'release'))).toEqual([]);
    expect(ids(repos.inbox.list('AR', { kind: 'decision', state: 'open' }))).toEqual(['inb_2', 'inb_4']);
    expect(ids(repos.inbox.list('AR', { limit: 2 }))).toEqual(['inb_3', 'inb_4']);

    repos.memberState.upsert({
      projectKey: 'AR',
      handle: 'dev-1',
      status: 'idle',
      activity: null,
      activityTaskKey: null,
      updatedAt: now,
    });
    repos.memberState.upsert({
      projectKey: 'AR',
      handle: 'dev-1',
      status: 'working',
      activity: 'x',
      activityTaskKey: 'AR-1',
      updatedAt: now,
    });
    expect(repos.memberState.get('AR', 'dev-1')).toMatchObject({
      status: 'working',
      activity: 'x',
      activityTaskKey: 'AR-1',
    });
  });

  it('lists inbox items without a limit in full, oldest first, and with a limit the newest N', () => {
    const repos = createRepositories(openDatabase(':memory:'));
    const now = new Date().toISOString();
    const total = 520;
    for (let n = 1; n <= total; n++) {
      repos.inbox.insert({
        id: `inb_${String(n).padStart(4, '0')}`,
        projectKey: 'AR',
        kind: 'question',
        assignees: ['owner'],
        source: 'dev-1',
        sessionId: null,
        taskKey: 'AR-1',
        title: `Question ${n}`,
        body: null,
        payload: {},
        options: [],
        state: 'open',
        resolution: null,
        createdAt: now,
      });
    }
    const ids = (items: InboxItem[]) => items.map((i) => i.id);
    const all = Array.from({ length: total }, (_, i) => `inb_${String(i + 1).padStart(4, '0')}`);

    // The limited and the unlimited query of the same filter must not share a prepared statement.
    const filter = { kind: 'question', state: 'open', taskKey: 'AR-1' } as const;
    expect(ids(repos.inbox.list('AR', { ...filter, limit: 3 }))).toEqual(all.slice(-3));
    expect(ids(repos.inbox.list('AR', filter))).toEqual(all);
    expect(ids(repos.inbox.list('AR', { ...filter, limit: 3 }))).toEqual(all.slice(-3));
    expect(ids(repos.inbox.list('AR'))).toEqual(all);
    expect(ids(repos.inbox.list('AR', { limit: 500 }))).toEqual(all.slice(-500));
  });

  it('stores users and auth sessions with case-insensitive email lookup', () => {
    const repos = createRepositories(openDatabase(':memory:'));
    expect(repos.users.count()).toBe(0);
    repos.users.insert({
      id: 'usr_1',
      name: 'Owner',
      email: 'Owner@Example.com',
      passwordHash: 'h',
      createdAt: now,
    });
    expect(repos.users.findByEmail('owner@example.com')?.id).toBe('usr_1');
    repos.authSessions.insert({
      id: 'hash',
      userId: 'usr_1',
      createdAt: now,
      expiresAt: now,
      lastSeenAt: now,
    });
    expect(repos.authSessions.get('hash')?.userId).toBe('usr_1');
    expect(repos.authSessions.deleteExpired('2026-09-30T00:00:00.000Z')).toBe(1);
    expect(repos.authSessions.get('hash')).toBeNull();
  });
});

describe('the work item column encoding (PM-475)', () => {
  it('round-trips every work item, a general chat with a person too', () => {
    for (const item of [
      { type: 'task', taskKey: 'AR-1' },
      { type: 'meeting', meetingId: 'mtg_1' },
      { type: 'schedule', runId: 'run_1' },
      { type: 'general' },
      { type: 'general', with: 'cleo' },
    ] as const) {
      const { type, ref } = encodeWorkItem(item);
      expect(decodeWorkItem(type, ref)).toEqual(item);
    }
  });

  it('keeps the owners’ general chat as an empty ref, so no row needs a migration', () => {
    expect(encodeWorkItem({ type: 'general' })).toEqual({ type: 'general', ref: '' });
    expect(encodeWorkItem({ type: 'general', with: 'cleo' })).toEqual({ type: 'general', ref: 'cleo' });
    expect(decodeWorkItem('general', '')).toEqual({ type: 'general' });
  });
});
