import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { InboxItem, Session, Task } from '@projectman/shared';
import Database from 'better-sqlite3';
import { createRepositories, LATEST_SCHEMA_VERSION, migrate, openDatabase, schemaVersion } from '../src/db';
import { migrations } from '../src/db/migrations';

const now = '2026-09-29T10:00:00.000Z';

describe('merge migration 48', () => {
  it('backfills persistent handovers from review pins and allows only one open merge per card', () => {
    const db = new Database(':memory:');
    try {
      const prior = migrations.filter((item) => item.version < 48);
      for (const migration of prior) db.exec(migration.sql);
      db.pragma(`user_version = ${Math.max(...prior.map((item) => item.version))}`);
      const old = createRepositories(db);
      old.projects.insert({
        key: 'AR',
        name: 'acme',
        templateId: null,
        configVersion: 'v1',
        createdAt: now,
        updatedAt: now,
      });
      old.tasks.insert(sampleTask());
      db.prepare('INSERT INTO task_review_pins VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        'AR',
        'AR-1',
        'review',
        'approved',
        'task/AR-1',
        now,
        'dev-1',
      );
      expect(migrate(db)).toBe(48);
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
    visibility: 'internal',
    createdBy: 'owner',
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    ...overrides,
  };
}

describe('database', () => {
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
    // Checks recorded before labels read as their labels.
    repos.db
      .prepare(`UPDATE tasks SET checks = ? WHERE key = 'AR-2'`)
      .run('{"code_review":"passed","qa":"pending"}');
    expect(repos.tasks.get('AR-2')!.labels).toEqual(['frontend', 'code-review-ok']);
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
      repos.tasks.updatePullRequestLinks('acme/web', 12, { state: 'merged', title: 'Login' }, now),
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
    // Writing labels replaces the legacy checks they were read with.
    repos.db.prepare(`UPDATE tasks SET checks = ? WHERE key = 'AR-1'`).run('{"code_review":"passed"}');
    expect(repos.tasks.get('AR-1')!.labels).toContain('code-review-ok');
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
      updatedAt: now,
    });
    repos.memberState.upsert({
      projectKey: 'AR',
      handle: 'dev-1',
      status: 'working',
      activity: 'x',
      updatedAt: now,
    });
    expect(repos.memberState.get('AR', 'dev-1')).toMatchObject({ status: 'working', activity: 'x' });
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
