import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TimelineEvent } from '@projectman/shared';
import type { TaskStateHistoryReader } from '../src/contracts';
import { createRepositories, openDatabase } from '../src/db';
import type { Repositories } from '../src/db';
import { TIMELINE_SQL } from '../src/db/timeline';

const T = (minutes: number) =>
  new Date(Date.parse('2026-10-01T00:00:00.000Z') + minutes * 60_000).toISOString();
let repos: Repositories;
let counter = 0;

function put(
  taskKey: string | null,
  type: TimelineEvent['type'],
  data: Record<string, unknown>,
  at: string,
  projectKey = 'PM',
) {
  const event: TimelineEvent = {
    id: `evt_${++counter}`,
    projectKey,
    taskKey,
    sessionId: null,
    actor: { kind: 'system', handle: null },
    type,
    data,
    createdAt: at,
  };
  repos.timeline.insert(event);
  return event;
}
const stage = (key: string, to: string, at: string, projectKey = 'PM') =>
  put(key, 'task_stage_changed', { from: 'x', to }, at, projectKey);
const ids = (events: TimelineEvent[]) => events.map((event) => event.id);

beforeEach(() => {
  counter = 0;
  repos = createRepositories(openDatabase(':memory:'));
  for (const key of ['PM', 'OT'])
    repos.projects.insert({
      key,
      name: key,
      templateId: null,
      configVersion: 'v1',
      createdAt: T(0),
      updatedAt: T(0),
    });
});
afterEach(() => repos.db.close());

describe('latestTaskStatesBefore', () => {
  const reader = (): TaskStateHistoryReader => repos.timeline;

  it('returns [] for no keys and nothing for a card without state evidence', () => {
    expect(reader().latestTaskStatesBefore('PM', [], T(100))).toEqual([]);
    put('PM-1', 'task_note', { text: 'hello' }, T(1));
    put('PM-1', 'task_updated', { action: 'closed' }, T(2));
    put('PM-1', 'task_updated', { fields: ['title'] }, T(3));
    expect(reader().latestTaskStatesBefore('PM', ['PM-1', 'PM-404'], T(100))).toEqual([]);
  });

  it('picks the greatest seq per card among the state events created strictly before the time', () => {
    const first = stage('PM-1', 'development', T(1));
    const second = put('PM-1', 'task_updated', { action: 'cancelled' }, T(2));
    const third = put('PM-1', 'task_updated', { action: 'reopened' }, T(3));
    put('PM-1', 'task_note', { text: 'later note' }, T(4));
    const other = stage('PM-2', 'done', T(2));
    stage('PM-2', 'development', T(10));
    expect(ids(reader().latestTaskStatesBefore('PM', ['PM-2', 'PM-1'], T(10)))).toEqual([third.id, other.id]);
    expect(ids(reader().latestTaskStatesBefore('PM', ['PM-1'], T(3)))).toEqual([second.id]);
    expect(ids(reader().latestTaskStatesBefore('PM', ['PM-1'], T(2)))).toEqual([first.id]);
    expect(reader().latestTaskStatesBefore('PM', ['PM-1'], T(1))).toEqual([]);
  });

  it('returns the selected events in ascending seq, whatever the order and repeats of the keys', () => {
    const a = stage('PM-1', 'done', T(1));
    const b = stage('PM-2', 'done', T(2));
    const c = stage('PM-3', 'done', T(3));
    expect(ids(reader().latestTaskStatesBefore('PM', ['PM-3', 'PM-1', 'PM-2', 'PM-1'], T(9)))).toEqual([
      a.id,
      b.id,
      c.id,
    ]);
  });

  it('takes the greatest seq of events created at the same time, and ignores the creation time order', () => {
    stage('PM-1', 'development', T(5));
    const lastSameTime = stage('PM-1', 'done', T(5));
    expect(ids(reader().latestTaskStatesBefore('PM', ['PM-1'], T(6)))).toEqual([lastSameTime.id]);
    // A later seq stored with an earlier time still wins, as long as it is before the limit.
    const backdated = stage('PM-1', 'review', T(4));
    expect(ids(reader().latestTaskStatesBefore('PM', ['PM-1'], T(6)))).toEqual([backdated.id]);
    expect(ids(reader().latestTaskStatesBefore('PM', ['PM-1'], T(5)))).toEqual([backdated.id]);
  });

  it('stays in the project and never rewrites or removes an event', () => {
    const mine = stage('PM-1', 'done', T(1));
    stage('PM-1', 'development', T(2), 'OT');
    expect(ids(reader().latestTaskStatesBefore('PM', ['PM-1'], T(9)))).toEqual([mine.id]);
    expect(ids(reader().latestTaskStatesBefore('OT', ['PM-1'], T(9)))).not.toContain(mine.id);
    expect(repos.timeline.list('PM', { taskKey: 'PM-1' })).toHaveLength(1);
  });
});

describe('query plans', () => {
  const plan = (sql: string, ...params: unknown[]) =>
    (repos.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[])
      .map((row) => row.detail)
      .join('\n');

  it('finds the last state event per named card by its partial index, never by the card events or the project', () => {
    const text = plan(TIMELINE_SQL.stateBefore, 'PM', 'PM', T(9), '[]');
    expect(text).toContain('timeline_task_state_before (project_key=? AND task_key=? AND created_at<?)');
    // The outer read only probes the selected seqs; nothing is scanned.
    expect(text).toContain('timeline_project (project_key=? AND seq=?)');
    expect(text).not.toMatch(/SCAN (t|timeline_events)\b/);
  });

  it('reads the window evidence through an index on the creation time, not a walk of the whole project', () => {
    const text = plan(TIMELINE_SQL.structuralEvidence, 'PM', T(1), T(2));
    expect(text).toContain('timeline_structural_window (project_key=? AND created_at>? AND created_at<?)');
    expect(text).not.toContain('timeline_project');
  });
});
