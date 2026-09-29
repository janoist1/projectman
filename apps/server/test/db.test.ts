import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { InboxItem, Session, Task } from '@projectman/shared';
import { createRepositories, LATEST_SCHEMA_VERSION, migrate, openDatabase, schemaVersion } from '../src/db';

const now = '2026-09-29T10:00:00.000Z';

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
    checks: { code_review: 'pending' },
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
    ]) {
      expect(tables).toContain(t);
    }
    db.close();
  });

  it('maps tasks, links and counters', () => {
    const repos = createRepositories(openDatabase(':memory:'));
    repos.projects.insert({
      key: 'AR',
      name: 'aroom',
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
    expect(task.checks).toEqual({ code_review: 'pending' });
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

    repos.tasks.update({ ...task, stageId: 'development', assignee: 'dev-1', updatedAt: now });
    expect(repos.tasks.listByAssignee('AR', 'dev-1').map((t) => t.key)).toEqual(['AR-1']);
  });

  it('maps sessions, timeline, messages, inbox and member state', () => {
    const repos = createRepositories(openDatabase(':memory:'));
    const session: Session = {
      id: 'ses_1',
      projectKey: 'AR',
      member: 'dev-1',
      workItem: { type: 'task', taskKey: 'AR-1' },
      claudeSessionId: '0b7c6a1e-8f7b-4c1e-9d55-0d8c0f4e7a11',
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
