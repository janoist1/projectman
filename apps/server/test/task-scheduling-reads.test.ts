import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Task } from '@projectman/shared';
import { createRepositories, openDatabase } from '../src/db';
import type { Repositories } from '../src/db';
import { SCHEDULING_SQL } from '../src/db/tasks';

const at = '2026-10-10T10:00:00.000Z';
let repos: Repositories;
let counter = 0;

function card(seq: number, patch: Partial<Task> = {}): Task {
  counter += 1;
  return {
    id: `tsk_${counter}`,
    projectKey: 'PM',
    key: `PM-${seq}`,
    title: `Card ${seq}`,
    description: '',
    stageId: 'ready',
    status: 'active',
    assignee: null,
    repo: null,
    priority: null,
    labels: [],
    links: [],
    createdBy: 'owner',
    createdAt: at,
    updatedAt: at,
    closedAt: null,
    ...patch,
  };
}
const add = (seq: number, patch: Partial<Task> = {}) => repos.tasks.insert(card(seq, patch));
const keys = (tasks: Task[]) => tasks.map((task) => task.key);
const read = (query: Parameters<Repositories['tasks']['readScheduling']>[1], project = 'PM') =>
  repos.tasks.readScheduling(project, query);

beforeEach(() => {
  counter = 0;
  repos = createRepositories(openDatabase(':memory:'));
  for (const key of ['PM', 'OT'])
    repos.projects.insert({
      key,
      name: key,
      templateId: null,
      configVersion: 'v1',
      createdAt: at,
      updatedAt: at,
    });
});
afterEach(() => repos.db.close());

describe('keys', () => {
  it('returns exactly the named cards once each, closed ones too, by number, with only their links', () => {
    add(3, { links: [{ kind: 'branch', ref: 'b3' }] });
    add(1, { status: 'done', closedAt: at, links: [{ kind: 'branch', ref: 'b1' }] });
    add(2, { links: [{ kind: 'branch', ref: 'b2' }] });
    const found = read({ kind: 'keys', keys: ['PM-3', 'PM-1', 'PM-3', 'PM-404'] });
    expect(keys(found)).toEqual(['PM-1', 'PM-3']);
    expect(found.map((task) => task.links.map((link) => link.ref))).toEqual([['b1'], ['b3']]);
    expect(read({ kind: 'keys', keys: [] })).toEqual([]);
  });

  it('never crosses into another project', () => {
    repos.tasks.insert({ ...card(9), projectKey: 'OT', key: 'OT-9' });
    expect(read({ kind: 'keys', keys: ['OT-9'] })).toEqual([]);
    expect(keys(read({ kind: 'keys', keys: ['OT-9'] }, 'OT'))).toEqual(['OT-9']);
  });

  it('matches the stored card of get and list', () => {
    add(1, {
      priority: 'urgent',
      labels: ['a'],
      links: [{ kind: 'pull_request', ref: '7', repo: 'r', title: 'T' }],
    });
    expect(read({ kind: 'keys', keys: ['PM-1'] })).toEqual(repos.tasks.list('PM'));
  });
});

describe('pull', () => {
  it('reads all priorities and assigned cards for the queue, excluding inactive and other-stage cards and themes', () => {
    add(1, { priority: 'urgent' });
    add(2, { stageId: 'other' });
    add(3, { assignee: 'dev' });
    add(4, { status: 'done', closedAt: at });
    add(5);
    add(6, { priority: 'high' });
    add(7, { kind: 'theme' });
    expect(keys(read({ kind: 'queue', stageId: 'ready' }))).toEqual(['PM-1', 'PM-3', 'PM-5', 'PM-6']);
  });
  it('returns the active unassigned urgent cards of the stage', () => {
    add(1, { priority: 'urgent' });
    add(2, { priority: 'urgent', stageId: 'other' });
    add(3, { priority: 'urgent', assignee: 'dev' });
    add(4, { priority: 'urgent', status: 'done', closedAt: at });
    add(5);
    add(6, { priority: 'high' });
    add(7, { kind: 'theme', priority: 'urgent' });
    add(8, { priority: 'urgent', labels: ['hold'] });
    expect(keys(read({ kind: 'pull', stageId: 'ready' }))).toEqual(['PM-1', 'PM-8']);
  });
});

describe('children', () => {
  it('returns the open subtasks, and the closed ones too on request', () => {
    add(1);
    add(2, { parentKey: 'PM-1' });
    add(3, { parentKey: 'PM-1', status: 'done', closedAt: at });
    add(4);
    add(5, { parentKey: 'PM-4' });
    expect(keys(read({ kind: 'children', parentKeys: ['PM-1'] }))).toEqual(['PM-2']);
    expect(keys(read({ kind: 'children', parentKeys: ['PM-1'], includeClosed: true }))).toEqual([
      'PM-2',
      'PM-3',
    ]);
    expect(keys(read({ kind: 'children', parentKeys: ['PM-4', 'PM-1'] }))).toEqual(['PM-2', 'PM-5']);
    expect(read({ kind: 'children', parentKeys: [] })).toEqual([]);
  });
});

describe('open', () => {
  it('returns every card that is not done or cancelled, themes included', () => {
    add(1, { kind: 'theme' });
    add(2);
    add(3, { status: 'done', closedAt: at });
    add(4, { status: 'cancelled', closedAt: at });
    add(5, { status: 'blocked' as Task['status'] });
    expect(keys(read({ kind: 'open' }))).toEqual(['PM-1', 'PM-2', 'PM-5']);
  });
});

describe('listed', () => {
  const listed = (query: Partial<Extract<Parameters<typeof read>[0], { kind: 'listed' }>> = {}) =>
    keys(read({ kind: 'listed', status: 'open', limit: 10, ...query }));

  it('filters by status, stage and assignee in SQL and takes the newest change first up to the limit', () => {
    add(1, { updatedAt: '2026-10-10T10:00:01.000Z', assignee: 'dev' });
    add(2, { updatedAt: '2026-10-10T10:00:03.000Z', stageId: 'dev' });
    add(3, { updatedAt: '2026-10-10T10:00:02.000Z', kind: 'theme' });
    add(4, { status: 'done', closedAt: at, updatedAt: '2026-10-10T10:00:04.000Z' });
    expect(listed()).toEqual(['PM-2', 'PM-3', 'PM-1']);
    expect(listed({ limit: 2 })).toEqual(['PM-2', 'PM-3']);
    expect(listed({ status: 'done' })).toEqual(['PM-4']);
    expect(listed({ stageId: 'ready' })).toEqual(['PM-1']);
    expect(listed({ assignee: 'dev' })).toEqual(['PM-1']);
  });
});

describe('closed-worktrees', () => {
  const before = '2026-10-10T10:00:00.000Z';
  const closed = (seq: number, closedAt: string | null, patch: Partial<Task> = {}) =>
    add(seq, { status: 'done', closedAt, ...patch });

  it('keeps the boundary inclusive, instants rather than text, and leaves invalid dates out', () => {
    closed(1, '2026-10-10T09:59:59.999Z');
    closed(2, '2026-10-10T10:00:00.000Z');
    closed(3, '2026-10-10T10:00:00.001Z');
    closed(4, '2026-10-10T11:30:00.000+02:00'); // 09:30Z
    closed(5, '2026-10-10T10:30:00.000-01:00'); // 11:30Z
    closed(6, 'not a date');
    closed(7, '12345');
    closed(8, null);
    closed(9, '2026-10-01T00:00:00.000Z', { status: 'cancelled' });
    closed(10, '2026-10-01T00:00:00.000Z', { kind: 'theme' });
    add(11, { closedAt: '2026-10-01T00:00:00.000Z' });
    expect(keys(read({ kind: 'closed-worktrees', closedBefore: before }))).toEqual([
      'PM-1',
      'PM-2',
      'PM-4',
      'PM-9',
    ]);
  });

  it('pages by number and ends on an empty page', () => {
    for (let seq = 1; seq <= 7; seq++) closed(seq, '2026-09-01T00:00:00.000Z');
    const pages: string[][] = [];
    let afterSeq = 0;
    for (;;) {
      const page = read({ kind: 'closed-worktrees', closedBefore: before, afterSeq, limit: 3 });
      if (page.length === 0) break;
      pages.push(keys(page));
      afterSeq = Number(page.at(-1)!.key.split('-')[1]);
    }
    expect(pages).toEqual([['PM-1', 'PM-2', 'PM-3'], ['PM-4', 'PM-5', 'PM-6'], ['PM-7']]);
  });

  it('a card reopened between pages is not read on the next page', () => {
    for (let seq = 1; seq <= 4; seq++) closed(seq, '2026-09-01T00:00:00.000Z');
    const first = read({ kind: 'closed-worktrees', closedBefore: before, limit: 2 });
    expect(keys(first)).toEqual(['PM-1', 'PM-2']);
    repos.tasks.update(first[0]!.id, { status: 'active', closedAt: null });
    repos.tasks.update(repos.tasks.get('PM-3')!.id, { status: 'active', closedAt: null });
    expect(keys(read({ kind: 'closed-worktrees', closedBefore: before, afterSeq: 2, limit: 2 }))).toEqual([
      'PM-4',
    ]);
  });

  it('refuses invalid parameters with a RangeError', () => {
    for (const closedBefore of [
      '',
      'yesterday',
      '2026-10-10',
      '2026-10-10T10:00:00+02:00',
      '2026-13-40T10:00:00Z',
    ])
      expect(() => read({ kind: 'closed-worktrees', closedBefore })).toThrow(RangeError);
    for (const afterSeq of [-1, 1.5, Number.NaN])
      expect(() => read({ kind: 'closed-worktrees', closedBefore: before, afterSeq })).toThrow(RangeError);
    for (const limit of [0, 501, 2.5, -3])
      expect(() => read({ kind: 'closed-worktrees', closedBefore: before, limit })).toThrow(RangeError);
    expect(() => read({ kind: 'closed-worktrees', closedBefore: before, limit: 500 })).not.toThrow();
  });
});

describe('query plans', () => {
  const plan = (sql: string, ...params: unknown[]) =>
    (repos.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[])
      .map((row) => row.detail)
      .join('\n');

  it('serves the pull, open and closed reads from their partial indexes and never scans the table', () => {
    expect(plan(SCHEDULING_SQL.pullUrgent, 'PM', 'ready')).toContain('tasks_scheduling_pull');
    expect(plan(SCHEDULING_SQL.open, 'PM')).toContain('tasks_scheduling_open');
    expect(plan(SCHEDULING_SQL.closed, 'PM', 0, at, 10)).toContain('tasks_scheduling_closed');
  });

  it('reads the open and the waiting member queue items from their partial indexes', () => {
    expect(
      plan(
        `SELECT * FROM member_queue_items WHERE source_type = ? AND state IN ('queued','processing')
         ORDER BY queued_at, rowid`,
        'start',
      ),
    ).toContain('member_queue_items_open_source');
    expect(
      plan(
        `SELECT * FROM member_queue_items
         WHERE state = 'queued' AND wake = 1 AND wait_code IS NOT NULL ORDER BY wait_at, rowid`,
      ),
    ).toContain('member_queue_items_waiting');
  });

  it('drives the key and parent reads by the bound set, not by a walk of the project', () => {
    // The first line of a plan is the table the read starts from: the key index, or the index probed per value.
    const first = (sql: string, ...params: unknown[]) => plan(sql, ...params).split('\n')[0];
    expect(first(SCHEDULING_SQL.keys, 'PM', '[]')).toContain('sqlite_autoindex_tasks_2 (key=?)');
    for (const sql of [SCHEDULING_SQL.children, SCHEDULING_SQL.childrenAll])
      expect(first(sql, 'PM', '[]')).toContain('tasks_parent (project_key=? AND parent_key=?)');
    expect(plan(SCHEDULING_SQL.linksOfIds, '[]')).not.toMatch(/SCAN task_links/);
  });
});
