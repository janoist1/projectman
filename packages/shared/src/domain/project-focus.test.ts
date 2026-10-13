import { describe, expect, it } from 'vitest';
import { ProjectConfig } from '../config/schema';
import {
  ProjectFocus,
  PROJECT_FOCUS_MAX_ITEMS,
  compareStartClass,
  projectFocusPlaces,
  projectFocusRefusal,
  pullCandidates,
  pullSourceStage,
  startClass,
} from './project-focus';
import type { Task } from './task';

const config = ProjectConfig.parse({
  schemaVersion: 1,
  project: { key: 'AC', name: 'Acme', workspacePath: '/work/acme', repos: [] },
  team: {
    members: [
      { kind: 'human', handle: 'owner', displayName: 'Owner', access: 'owner', roles: ['operator'] },
      { kind: 'human', handle: 'po', displayName: 'PO', access: 'developer', roles: ['product_owner'] },
      { kind: 'human', handle: 'dev', displayName: 'Dev', access: 'developer', roles: ['developer'] },
      { kind: 'ai', handle: 'pm-ai', displayName: 'AI PO', role: 'product_owner', sponsor: 'owner' },
    ],
    limits: {},
  },
  pipeline: {
    columns: [{ id: 'all', name: 'All' }],
    stages: [
      { id: 'ideas', name: 'Ideas', kind: 'queue', columnId: 'all' },
      { id: 'done', name: 'Done', kind: 'done', columnId: 'all' },
    ],
    labels: [],
  },
});

describe('projectFocusRefusal', () => {
  it('allows the owner and a person who prioritizes, the integrator included', () => {
    expect(projectFocusRefusal(config, { kind: 'human', handle: 'owner' })).toBeNull();
    expect(projectFocusRefusal(config, { kind: 'human', handle: 'po' })).toBeNull();
    expect(projectFocusRefusal(config, { kind: 'human', handle: 'owner', via: 'integrator' })).toBeNull();
  });
  it('refuses any other person', () => {
    expect(projectFocusRefusal(config, { kind: 'human', handle: 'dev' })).toBe('focus_not_allowed');
    expect(projectFocusRefusal(config, { kind: 'human', handle: 'ghost' })).toBe('focus_not_allowed');
    expect(projectFocusRefusal(config, { kind: 'human', handle: null })).toBe('focus_not_allowed');
  });
  it('refuses an AI member and the system, even one that prioritizes', () => {
    expect(projectFocusRefusal(config, { kind: 'ai', handle: 'pm-ai' })).toBe('focus_humans_only');
    expect(projectFocusRefusal(config, { kind: 'ai', handle: 'owner' })).toBe('focus_humans_only');
    expect(projectFocusRefusal(config, { kind: 'system', handle: null })).toBe('focus_humans_only');
  });
});

const task = (key: string, extra: Partial<Task> = {}): Task =>
  ({ key, status: 'active', kind: 'task', parentKey: null, themeKey: null, ...extra }) as Task;
const items = (...keys: string[]) => keys.map((key) => ({ key }));

describe('projectFocusPlaces', () => {
  it('lets a card cover itself and its subtasks', () => {
    const places = projectFocusPlaces(items('AC-1'), [
      task('AC-1'),
      task('AC-2', { parentKey: 'AC-1' }),
      task('AC-3'),
    ]);
    expect(places.get('AC-1')).toEqual({ position: 1 });
    expect(places.get('AC-2')).toEqual({ position: 1, via: 'AC-1' });
    expect(places.has('AC-3')).toBe(false);
  });
  it('lets a theme cover itself, its cards and their subtasks', () => {
    const places = projectFocusPlaces(items('AC-9', 'AC-1'), [
      task('AC-9', { kind: 'theme' }),
      task('AC-1', { themeKey: 'AC-9' }),
      task('AC-2', { parentKey: 'AC-1', themeKey: 'AC-9' }),
      // A subtask whose theme is not filled in reads its parent's.
      task('AC-4', { parentKey: 'AC-1' }),
      task('AC-5'),
    ]);
    expect(places.get('AC-9')).toEqual({ position: 1 });
    expect(places.get('AC-1')).toEqual({ position: 1, via: 'AC-9' });
    expect(places.get('AC-2')).toEqual({ position: 1, via: 'AC-9' });
    expect(places.get('AC-4')).toEqual({ position: 1, via: 'AC-9' });
    expect(places.has('AC-5')).toBe(false);
  });
  it('gives a card covered twice the smaller place', () => {
    const places = projectFocusPlaces(items('AC-1', 'AC-9'), [
      task('AC-9', { kind: 'theme' }),
      task('AC-1', { themeKey: 'AC-9' }),
      task('AC-2', { themeKey: 'AC-9' }),
    ]);
    expect(places.get('AC-1')).toEqual({ position: 1 });
    expect(places.get('AC-2')).toEqual({ position: 2, via: 'AC-9' });
    expect(places.get('AC-9')).toEqual({ position: 2 });
  });
  it('covers nothing with a closed item, but the closed item still takes its number', () => {
    const places = projectFocusPlaces(items('AC-9', 'AC-1', 'AC-8'), [
      task('AC-9', { kind: 'theme', status: 'cancelled' }),
      task('AC-3', { themeKey: 'AC-9' }),
      task('AC-1', { status: 'done' }),
      task('AC-2', { parentKey: 'AC-1' }),
      task('AC-8'),
    ]);
    expect(places.has('AC-9')).toBe(false);
    expect(places.has('AC-3')).toBe(false);
    expect(places.has('AC-2')).toBe(false);
    expect(places.get('AC-8')).toEqual({ position: 3 });
  });
  it('gives a closed card no place, and ignores an item whose card is unknown', () => {
    const places = projectFocusPlaces(items('GONE-1', 'AC-9'), [
      task('AC-9', { kind: 'theme' }),
      task('AC-1', { themeKey: 'AC-9', status: 'done' }),
      task('AC-2', { themeKey: 'AC-9' }),
    ]);
    expect(places.has('AC-1')).toBe(false);
    expect(places.get('AC-2')).toEqual({ position: 2, via: 'AC-9' });
    expect(places.has('GONE-1')).toBe(false);
  });
});

describe('ProjectFocus', () => {
  const item = {
    key: 'AC-1',
    addedAt: '2026-10-09T10:00:00.000Z',
    addedBy: { kind: 'human', handle: 'owner' },
  };
  it('holds at most the maximum number of items', () => {
    const full = Array.from({ length: PROJECT_FOCUS_MAX_ITEMS }, () => item);
    expect(ProjectFocus.safeParse({ items: full }).success).toBe(true);
    expect(ProjectFocus.safeParse({ items: [...full, item] }).success).toBe(false);
  });
});

describe('the start class and the pull (PM-427)', () => {
  const pullConfig = ProjectConfig.parse({
    schemaVersion: 1,
    project: { key: 'AC', name: 'Acme', workspacePath: '/work/acme', repos: [] },
    team: {
      members: [
        { kind: 'human', handle: 'owner', displayName: 'Owner', access: 'owner', roles: ['operator'] },
      ],
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
  const places = (...keys: string[]) =>
    new Map(keys.map((key, index) => [key, { position: index + 1 }] as const));
  const pulled = (tasks: Task[], focus = places()) =>
    pullCandidates({ config: pullConfig, tasks, places: focus }).map((t) => t.key);

  describe('startClass', () => {
    it('is urgent for an urgent open card, even one in the focus', () => {
      expect(startClass(card('AC-1', { priority: 'urgent' }), places('AC-1'))).toEqual({ kind: 'urgent' });
    });
    it('is focus with the place for a card the focus covers', () => {
      expect(startClass(card('AC-1', { priority: 'high' }), places('AC-2', 'AC-1'))).toEqual({
        kind: 'focus',
        position: 2,
      });
    });
    it('is other for any other card, a closed one and a start with no card', () => {
      expect(startClass(card('AC-1'), places())).toEqual({ kind: 'other' });
      expect(startClass(card('AC-1', { priority: 'urgent', status: 'done' }), places())).toEqual({
        kind: 'other',
      });
      expect(startClass(null, places('AC-1'))).toEqual({ kind: 'other' });
    });
  });

  describe('compareStartClass', () => {
    it('orders urgent, then focus by place, then other', () => {
      const classes = [
        { kind: 'other' },
        { kind: 'focus', position: 2 },
        { kind: 'urgent' },
        { kind: 'focus', position: 1 },
      ] as const;
      expect([...classes].sort(compareStartClass)).toEqual([
        { kind: 'urgent' },
        { kind: 'focus', position: 1 },
        { kind: 'focus', position: 2 },
        { kind: 'other' },
      ]);
    });
    it('keeps two of the same class equal', () => {
      expect(compareStartClass({ kind: 'urgent' }, { kind: 'urgent' })).toBe(0);
      expect(compareStartClass({ kind: 'other' }, { kind: 'other' })).toBe(0);
    });
  });

  describe('pullSourceStage', () => {
    it('is the queue stage before the development stage', () => {
      expect(pullSourceStage(pullConfig)?.id).toBe('ready');
    });
    it('is null when the stage before is not a queue, or there is no development stage', () => {
      const stages = pullConfig.pipeline.stages;
      const noQueue = { pipeline: { ...pullConfig.pipeline, stages: stages.slice(1) } };
      const noWork = { pipeline: { ...pullConfig.pipeline, stages: [stages[0]!, stages[2]!] } };
      expect(pullSourceStage(noQueue)).toBeNull();
      expect(pullSourceStage(noWork)).toBeNull();
    });
  });

  describe('pullCandidates', () => {
    it('takes the urgent cards first, then the focus cards by place, in board order within one', () => {
      const tasks = [
        card('AC-1'),
        card('AC-2', { boardRank: 2 }),
        card('AC-3', { boardRank: 1 }),
        card('AC-4', { priority: 'urgent', boardRank: 5 }),
        card('AC-5', { priority: 'urgent', boardRank: 4 }),
      ];
      expect(pulled(tasks, places('AC-3', 'AC-2'))).toEqual(['AC-5', 'AC-4', 'AC-3', 'AC-2']);
    });
    it('leaves out the cards that are neither urgent nor in the focus', () => {
      expect(pulled([card('AC-1'), card('AC-2', { priority: 'high' })])).toEqual([]);
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
      const stages = pullConfig.pipeline.stages.slice(1);
      const config = { ...pullConfig, pipeline: { ...pullConfig.pipeline, stages } };
      const tasks = [card('AC-1', { priority: 'urgent', stageId: 'dev' })];
      expect(pullCandidates({ config, tasks, places: places() })).toEqual([]);
    });
  });
});
