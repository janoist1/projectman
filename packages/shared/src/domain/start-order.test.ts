import { describe, expect, it } from 'vitest';
import { ProjectConfig } from '../config/schema';
import { compareStartClass, pullCandidates, pullSourceStage, startClass, startableCards } from './start-order';
import type { Task } from './task';

const task = (key: string, extra: Partial<Task> = {}): Task =>
  ({ key, status: 'active', kind: 'task', parentKey: null, themeKey: null, ...extra }) as Task;

const config = ProjectConfig.parse({
  schemaVersion: 1,
  project: { key: 'AC', name: 'Acme', workspacePath: '/work/acme', repos: [] },
  team: {
    members: [{ kind: 'human', handle: 'owner', displayName: 'Owner', access: 'owner', roles: ['operator'] }],
    limits: {},
  },
  pipeline: {
    columns: [{ id: 'all', name: 'All' }],
    stages: [
      { id: 'ready', name: 'Ready', kind: 'queue', columnId: 'all' },
      {
        id: 'dev',
        name: 'Development',
        kind: 'work',
        columnId: 'all',
        gate: { conditions: [{ type: 'has_label', label: 'design-ok' }] },
      },
      { id: 'done', name: 'Done', kind: 'done', columnId: 'all' },
    ],
    labels: [
      { id: 'design-ok', name: 'Design ok', setBy: 'anyone' },
      { id: 'waiting', name: 'Waiting', setBy: 'anyone', blocks: true },
      { id: 'refine', name: 'Refine', setBy: 'anyone' },
    ],
  },
});
const card = (key: string, extra: Partial<Task> = {}): Task =>
  task(key, {
    stageId: 'ready',
    assignee: null,
    priority: null,
    labels: ['design-ok'],
    links: [],
    boardRank: 0,
    updatedAt: '2026-10-09T10:00:00.000Z',
    ...extra,
  });
const pulled = (tasks: Task[]) => pullCandidates({ config, tasks }).map((t) => t.key);

describe('startClass', () => {
  it('is urgent for an urgent open card', () => {
    expect(startClass(card('AC-1', { priority: 'urgent' }))).toEqual({ kind: 'urgent' });
  });
  it('is other for any other card, a closed one and a start with no card', () => {
    expect(startClass(card('AC-1'))).toEqual({ kind: 'other' });
    expect(startClass(card('AC-1', { priority: 'urgent', status: 'done' }))).toEqual({ kind: 'other' });
    expect(startClass(null)).toEqual({ kind: 'other' });
  });
});

describe('compareStartClass', () => {
  it('orders urgent before other and keeps two of the same class equal', () => {
    expect([{ kind: 'other' } as const, { kind: 'urgent' } as const].sort(compareStartClass)).toEqual([
      { kind: 'urgent' },
      { kind: 'other' },
    ]);
    expect(compareStartClass({ kind: 'urgent' }, { kind: 'urgent' })).toBe(0);
  });
});

describe('pullSourceStage', () => {
  it('is the queue stage before the development stage', () => {
    expect(pullSourceStage(config)?.id).toBe('ready');
  });
  it('is null when the stage before is not a queue, or there is no development stage', () => {
    const stages = config.pipeline.stages;
    const noQueue = { pipeline: { ...config.pipeline, stages: stages.slice(1) } };
    const noWork = { pipeline: { ...config.pipeline, stages: [stages[0]!, stages[2]!] } };
    expect(pullSourceStage(noQueue)).toBeNull();
    expect(pullSourceStage(noWork)).toBeNull();
  });
});

describe('startableCards', () => {
  it('returns the non-urgent cards in input order, which the pull leaves out', () => {
    const tasks = [card('AC-10'), card('AC-2', { priority: 'normal' })];
    expect(startableCards({ config, tasks, fromStageId: 'ready', toStageId: 'dev' })).toEqual(tasks);
    expect(pulled(tasks)).toEqual([]);
  });
  it('excludes prerequisites, holding labels, refinement, assignees, open collectors and unmet gates', () => {
    const tasks = [
      card('AC-1', { links: [{ kind: 'prerequisite', ref: 'AC-9' }] }),
      card('AC-2', { labels: ['design-ok', 'waiting'] }),
      card('AC-3', { labels: ['design-ok', 'refine'] }),
      card('AC-4', { assignee: 'dev' }),
      card('AC-5'),
      card('AC-6', { parentKey: 'AC-5', assignee: 'dev' }),
      card('AC-7', { labels: [] }),
      card('AC-8'),
      card('AC-9', { stageId: 'dev' }),
    ];
    expect(
      startableCards({ config, tasks, fromStageId: 'ready', toStageId: 'dev' }).map((t) => t.key),
    ).toEqual(['AC-8']);
  });
});

describe('pullCandidates', () => {
  it('leaves the urgent collector and pulls its subtask', () => {
    expect(
      pulled([card('AC-1', { priority: 'urgent' }), card('AC-2', { parentKey: 'AC-1', priority: 'urgent' })]),
    ).toEqual(['AC-2']);
  });
  it('leaves a collector whose subtasks are all done or cancelled', () => {
    const tasks = [
      card('AC-1', { priority: 'urgent' }),
      card('AC-2', { parentKey: 'AC-1', status: 'done' }),
      card('AC-3', { parentKey: 'AC-1', status: 'cancelled' }),
    ];
    expect(pulled(tasks)).toEqual([]);
  });
  it.each(['waiting', 'blocked'] as const)('leaves a collector whose subtask is %s', (status) => {
    expect(pulled([card('AC-1', { priority: 'urgent' }), card('AC-2', { parentKey: 'AC-1', status })])).toEqual(
      [],
    );
  });
  it('takes only the urgent cards, in board order', () => {
    const tasks = [
      card('AC-1'),
      card('AC-2', { priority: 'high' }),
      card('AC-4', { priority: 'urgent', boardRank: 5 }),
      card('AC-5', { priority: 'urgent', boardRank: 4 }),
    ];
    expect(pulled(tasks)).toEqual(['AC-5', 'AC-4']);
  });
  it('leaves out a theme, a card with an assignee, a closed card and a card outside the queue', () => {
    const tasks = [
      card('AC-1', { kind: 'theme', priority: 'urgent' }),
      card('AC-2', { assignee: 'dev-2', priority: 'urgent' }),
      card('AC-3', { status: 'cancelled', priority: 'urgent' }),
      card('AC-4', { stageId: 'dev', priority: 'urgent' }),
      card('AC-5', { priority: 'urgent' }),
    ];
    expect(pulled(tasks)).toEqual(['AC-5']);
  });
  it('leaves out a card with an open prerequisite, but not one whose prerequisite is closed', () => {
    const open = card('AC-2');
    const closed = card('AC-3', { status: 'done' });
    const link = (key: string) =>
      ({ links: [{ kind: 'prerequisite', ref: key }] }) as unknown as Partial<Task>;
    const tasks = [open, closed, card('AC-1', { priority: 'urgent', ...link('AC-2') })];
    const withClosed = [open, closed, card('AC-4', { priority: 'urgent', ...link('AC-3') })];
    expect(pulled(tasks)).toEqual([]);
    expect(pulled(withClosed)).toEqual(['AC-4']);
  });
  it('leaves out a card with a holding label, and one the gates on the way ask more of', () => {
    const tasks = [
      card('AC-1', { priority: 'urgent', labels: ['design-ok', 'waiting'] }),
      card('AC-2', { priority: 'urgent', labels: [] }),
      card('AC-3', { priority: 'urgent' }),
    ];
    expect(pulled(tasks)).toEqual(['AC-3']);
  });
  it('is empty when the pipeline has no queue before development', () => {
    const noQueue = { ...config, pipeline: { ...config.pipeline, stages: config.pipeline.stages.slice(1) } };
    const tasks = [card('AC-1', { priority: 'urgent', stageId: 'dev' })];
    expect(pullCandidates({ config: noQueue, tasks })).toEqual([]);
  });
});
