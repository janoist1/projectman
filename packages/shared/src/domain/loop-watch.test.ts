import { describe, expect, it } from 'vitest';
import { DEFAULT_LOOP_WATCH, ProjectConfig, TeamLimits } from '../config/schema';
import { applyConfigPatch } from '../config/edit';
import { countsForLoop, findLoop, isLoopWork, loopDeciders, loopWatchOf, loopWatchers } from './loop-watch';
import type { LoopTalk } from './loop-watch';

function config(extra: object[] = []) {
  return ProjectConfig.parse({
    schemaVersion: 1,
    project: { key: 'EX', name: 'Example', workspacePath: '/tmp/example', repos: [] },
    team: {
      members: [
        {
          kind: 'human',
          handle: 'owner',
          displayName: 'Owner',
          access: 'owner',
          roles: ['operator', 'product_owner'],
        },
        { kind: 'ai', handle: 'dev', displayName: 'Dev', role: 'developer', sponsor: 'owner' },
        { kind: 'ai', handle: 'rev', displayName: 'Rev', role: 'code_review', sponsor: 'owner' },
        { kind: 'ai', handle: 'pm', displayName: 'PM', role: 'project_manager', sponsor: 'owner' },
        ...extra,
      ],
      limits: {},
    },
    pipeline: {
      columns: [{ id: 'all', name: 'All' }],
      stages: [
        { id: 'queue', name: 'Queue', kind: 'queue', columnId: 'all' },
        { id: 'done', name: 'Done', kind: 'done', columnId: 'all' },
      ],
    },
  });
}

const MINUTE = 60_000;
const T0 = Date.parse('2026-10-01T12:00:00.000Z');
const at = (minutes: number) => new Date(T0 + minutes * MINUTE).toISOString();
const talk = (minutes: number, from: string, ...to: string[]): LoopTalk => ({ at: at(minutes), from, to });
const watch = { enabled: true, count: 3, minutes: 30 };

describe('loopWatchOf', () => {
  it('is on, six in thirty minutes by default', () => {
    expect(DEFAULT_LOOP_WATCH).toEqual({ enabled: true, count: 6, minutes: 30 });
    expect(loopWatchOf(undefined)).toEqual(DEFAULT_LOOP_WATCH);
    expect(loopWatchOf({})).toEqual(DEFAULT_LOOP_WATCH);
    expect(loopWatchOf({ loopWatch: watch })).toEqual(watch);
  });

  it('is kept within its bounds by the schema', () => {
    expect(TeamLimits.safeParse({ loopWatch: { enabled: true, count: 2, minutes: 30 } }).success).toBe(false);
    expect(TeamLimits.safeParse({ loopWatch: { enabled: true, count: 51, minutes: 30 } }).success).toBe(
      false,
    );
    expect(TeamLimits.safeParse({ loopWatch: { enabled: true, count: 6, minutes: 4 } }).success).toBe(false);
    expect(TeamLimits.safeParse({ loopWatch: { enabled: false, count: 6, minutes: 241 } }).success).toBe(
      false,
    );
    expect(TeamLimits.safeParse({ loopWatch: { enabled: false, count: 3, minutes: 5 } }).success).toBe(true);
  });

  it('is set through a configuration patch, and the rest of the limits stay', () => {
    const next = applyConfigPatch(config(), { baseVersion: 'v1', limits: { loopWatch: watch } });
    expect(next.team.limits.loopWatch).toEqual(watch);
    expect(next.team.limits.pauseAbovePlanUsagePercent).toBe(config().team.limits.pauseAbovePlanUsagePercent);
  });
});

describe('countsForLoop', () => {
  const c = config();

  it('counts a message between AI members', () => {
    expect(countsForLoop(c, talk(0, 'dev', 'rev'), [])).toBe(true);
    expect(countsForLoop(c, talk(0, 'dev', 'rev', 'pm'), [])).toBe(true);
  });

  it('does not count a message of a person, to a person, to nobody, or from an unknown sender', () => {
    expect(countsForLoop(c, talk(0, 'owner', 'dev'), [])).toBe(false);
    expect(countsForLoop(c, talk(0, 'dev', 'owner'), [])).toBe(false);
    expect(countsForLoop(c, talk(0, 'dev', 'rev', 'owner'), [])).toBe(false);
    expect(countsForLoop(c, talk(0, 'dev'), [])).toBe(false);
    expect(countsForLoop(c, talk(0, 'ghost', 'dev'), [])).toBe(false);
  });

  it('leaves out what the told member writes and what is written only to it', () => {
    expect(countsForLoop(c, talk(0, 'pm', 'dev'), ['pm'])).toBe(false);
    expect(countsForLoop(c, talk(0, 'dev', 'pm'), ['pm'])).toBe(false);
    expect(countsForLoop(c, talk(0, 'dev', 'pm', 'rev'), ['pm'])).toBe(true);
  });
});

describe('findLoop', () => {
  const since = at(-10);
  const round = [talk(0, 'dev', 'rev'), talk(1, 'rev', 'dev'), talk(2, 'dev', 'rev')];

  it('finds the count in the window, from two senders, and names who took part', () => {
    expect(findLoop(round, since, at(3), watch)).toEqual({
      count: 3,
      members: ['dev', 'rev'],
      startedAt: at(0),
      lastMessageAt: at(2),
    });
    expect(findLoop(round.slice(0, 2), since, at(3), watch)).toBeNull();
  });

  it('is none when one member writes alone', () => {
    expect(
      findLoop([talk(0, 'dev', 'rev'), talk(1, 'dev', 'rev'), talk(2, 'dev', 'pm')], since, at(3), watch),
    ).toBeNull();
  });

  it('counts only what is after the last progress', () => {
    expect(findLoop(round, at(0), at(3), watch)).toBeNull();
    expect(findLoop(round, at(0), at(3), { ...watch, count: 2 })).toMatchObject({ count: 2 });
    expect(findLoop(round, at(-1), at(3), watch)).toMatchObject({ count: 3 });
  });

  it('counts only what is within the window', () => {
    expect(findLoop(round, since, at(31), watch)).toBeNull();
    expect(findLoop(round, since, at(30), watch)).toMatchObject({ count: 3 });
    expect(findLoop(round, since, at(31), { ...watch, minutes: 40 })).toMatchObject({ count: 3 });
  });

  it('is none while the watch is off, and ignores messages from the future', () => {
    expect(findLoop(round, since, at(3), { ...watch, enabled: false })).toBeNull();
    expect(findLoop(round, since, at(1), watch)).toBeNull();
  });
});

describe('loopWatchers', () => {
  it('lists the AI holders of the scheduling duty, without those taking part or on leave', () => {
    const c = config([
      { kind: 'ai', handle: 'pm2', displayName: 'PM 2', role: 'project_manager', sponsor: 'owner' },
      {
        kind: 'ai',
        handle: 'pm3',
        displayName: 'PM 3',
        role: 'project_manager',
        sponsor: 'owner',
        onLeave: true,
      },
    ]);
    expect(loopWatchers(c, [])).toEqual(['pm', 'pm2']);
    expect(loopWatchers(c, ['pm'])).toEqual(['pm2']);
    expect(loopWatchers(c, ['pm', 'pm2'])).toEqual([]);
  });

  it('is empty when nobody holds the duty', () => {
    const c = config();
    const without = { team: { ...c.team, members: c.team.members.filter((m) => m.handle !== 'pm') } };
    expect(loopWatchers(without, [])).toEqual([]);
  });
});

describe('loopDeciders', () => {
  it('is the people who hold the duty with owner or admin access, else the owners', () => {
    expect(loopDeciders(config(), ['owner'])).toEqual(['owner']);
    const c = config([
      { kind: 'human', handle: 'boss', displayName: 'Boss', access: 'admin', roles: ['project_manager'] },
      {
        kind: 'human',
        handle: 'guest',
        displayName: 'Guest',
        access: 'developer',
        roles: ['project_manager'],
      },
    ]);
    expect(loopDeciders(c, ['owner'])).toEqual(['boss']);
  });
});

describe('isLoopWork (PM-431)', () => {
  const event = (type: string, data: Record<string, unknown>) =>
    ({ type, data }) as Parameters<typeof isLoopWork>[0];

  it('takes a note, an attachment and a new description for work', () => {
    expect(isLoopWork(event('task_note', { text: 'Take two.' }))).toBe(true);
    expect(isLoopWork(event('attachment_added', { fileName: 'sketch.png' }))).toBe(true);
    expect(isLoopWork(event('task_updated', { fields: ['title', 'description'] }))).toBe(true);
  });

  it('does not take an imported comment, other field changes or other events for work', () => {
    expect(isLoopWork(event('task_note', { text: 'Old', importedAuthor: 'Someone' }))).toBe(false);
    expect(isLoopWork(event('task_note', { text: 'Old', importedAt: '2025-01-01T00:00:00.000Z' }))).toBe(
      false,
    );
    expect(isLoopWork(event('task_updated', { fields: ['title', 'priority'] }))).toBe(false);
    expect(isLoopWork(event('attachment_deleted', { fileName: 'sketch.png' }))).toBe(false);
    expect(isLoopWork(event('team_message', { from: 'a', to: ['b'] }))).toBe(false);
  });
});
