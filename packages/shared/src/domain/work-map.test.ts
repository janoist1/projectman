import { describe, it, expect } from 'vitest';
import { workMap, isStale, staleDays, STALE_AFTER_MS, MAP_OTHER_GROUP_KEY, mapStateOf } from './work-map';
import type { MapTask, MapState, TaskPhase } from './work-map';
import type { StageKind } from './pipeline';

describe('isStale', () => {
  const ONE_DAY = 24 * 60 * 60 * 1000;

  it('unknown stage is not stale', () => {
    const task: MapTask = {
      key: 'PM-1',
      kind: 'task',
      status: 'active',
      stageId: 's1',
      createdAt: new Date().toISOString(),
    };
    expect(isStale(task, 'waiting', undefined, Date.now() + STALE_AFTER_MS)).toBe(false);
  });

  it('queue stage is never stale', () => {
    const task: MapTask = {
      key: 'PM-1',
      kind: 'task',
      status: 'active',
      stageId: 's1',
      createdAt: new Date().toISOString(),
    };
    expect(isStale(task, 'waiting', 'queue', Date.now() + STALE_AFTER_MS)).toBe(false);
  });

  it('waiting or ready phase can be stale', () => {
    const t0 = Date.now();
    const task: MapTask = {
      key: 'PM-1',
      kind: 'task',
      status: 'active',
      stageId: 's1',
      createdAt: new Date(t0).toISOString(),
    };

    // Bounds (24h - 1ms vs 24h)
    expect(isStale(task, 'waiting', 'work', t0 + STALE_AFTER_MS - 1)).toBe(false);
    expect(isStale(task, 'waiting', 'work', t0 + STALE_AFTER_MS)).toBe(true);

    expect(isStale(task, 'ready', 'step', t0 + STALE_AFTER_MS - 1)).toBe(false);
    expect(isStale(task, 'ready', 'step', t0 + STALE_AFTER_MS)).toBe(true);
  });

  it('other phases are not stale', () => {
    const t0 = Date.now();
    const task: MapTask = {
      key: 'PM-1',
      kind: 'task',
      status: 'active',
      stageId: 's1',
      createdAt: new Date(t0).toISOString(),
    };
    expect(isStale(task, 'working', 'work', t0 + STALE_AFTER_MS)).toBe(false);
    expect(isStale(task, 'blocked', 'work', t0 + STALE_AFTER_MS)).toBe(false);
  });
});

describe('staleDays', () => {
  it('returns floored days since entered', () => {
    const t0 = Date.now();
    const task: MapTask = {
      key: 'PM-1',
      kind: 'task',
      status: 'active',
      stageId: 's1',
      createdAt: new Date(t0).toISOString(),
    };
    expect(staleDays(task, t0)).toBe(0);
    expect(staleDays(task, t0 + STALE_AFTER_MS - 1)).toBe(0);
    expect(staleDays(task, t0 + STALE_AFTER_MS)).toBe(1);
    expect(staleDays(task, t0 + 2.5 * STALE_AFTER_MS)).toBe(2);
  });
});

describe('mapStateOf', () => {
  it('maps phases to states correctly', () => {
    expect(mapStateOf('cancelled', false)).toBe(null);
    expect(mapStateOf('waiting', false)).toBe('waiting');
    expect(mapStateOf('waiting', true)).toBe('blocked');
    expect(mapStateOf('ready', false)).toBe('waiting');
    expect(mapStateOf('ready', true)).toBe('blocked');
    expect(mapStateOf('needs_you', false)).toBe('needs_you');
    expect(mapStateOf('working', false)).toBe('working');
    expect(mapStateOf('blocked', false)).toBe('blocked');
  });

  it('keeps a card that stands on an outage waiting, even when it is stale (PM-468)', () => {
    expect(mapStateOf('stuck', false)).toBe('waiting');
    expect(mapStateOf('stuck', true)).toBe('waiting');
  });
});

describe('workMap', () => {
  it('groups themes and collectors', () => {
    const tasks: MapTask[] = [
      { key: 'T-1', kind: 'theme', status: 'active', stageId: 's1', createdAt: '' },
      { key: 'P-1', kind: 'task', status: 'active', stageId: 's1', createdAt: '', themeKey: 'T-1' },
      { key: 'C-1', kind: 'task', status: 'active', stageId: 's1', createdAt: '' },
      { key: 'P-2', kind: 'task', status: 'active', stageId: 's1', createdAt: '', parentKey: 'C-1' },
      { key: 'O-1', kind: 'task', status: 'active', stageId: 's1', createdAt: '' },
    ];

    const states = new Map<string, MapState | null>();
    const groups = workMap({ tasks, states });

    expect(groups.length).toBe(3);

    const themeGroup = groups.find((g) => g.key === 'T-1');
    expect(themeGroup).toBeDefined();
    expect(themeGroup?.kind).toBe('theme');
    expect(themeGroup?.cardKeys).toContain('P-1');

    const collectorGroup = groups.find((g) => g.key === 'C-1');
    expect(collectorGroup).toBeDefined();
    expect(collectorGroup?.kind).toBe('collector');
    expect(collectorGroup?.cardKeys).toContain('C-1');
    expect(collectorGroup?.cardKeys).toContain('P-2');

    const otherGroup = groups.find((g) => g.key === MAP_OTHER_GROUP_KEY);
    expect(otherGroup).toBeDefined();
    expect(otherGroup?.kind).toBe('other');
    expect(otherGroup?.cardKeys).toContain('O-1');
  });

  it('where children of done themes/collectors go', () => {
    const tasks: MapTask[] = [
      { key: 'T-1', kind: 'theme', status: 'done', stageId: 's1', createdAt: '' },
      { key: 'P-1', kind: 'task', status: 'active', stageId: 's1', createdAt: '', themeKey: 'T-1' },
      { key: 'C-1', kind: 'task', status: 'done', stageId: 's1', createdAt: '' },
      { key: 'P-2', kind: 'task', status: 'active', stageId: 's1', createdAt: '', parentKey: 'C-1' },
    ];

    const states = new Map<string, MapState | null>();
    const groups = workMap({ tasks, states });

    expect(groups.length).toBe(1);
    const group = groups[0]!;
    expect(group.key).toBe(MAP_OTHER_GROUP_KEY);
    expect(group.cardKeys).toContain('P-1');
    expect(group.cardKeys).toContain('P-2');
  });

  it('hidden parent: root is parent if in tasks, else card itself', () => {
    const tasks: MapTask[] = [
      { key: 'C-1', kind: 'task', status: 'active', stageId: 's1', createdAt: '', parentKey: 'HIDDEN' },
      { key: 'P-1', kind: 'task', status: 'active', stageId: 's1', createdAt: '', parentKey: 'C-1' },
    ];

    const states = new Map<string, MapState | null>();
    const groups = workMap({ tasks, states });

    expect(groups.length).toBe(1);
    const group = groups[0]!;
    expect(group.key).toBe('C-1');
    expect(group.kind).toBe('collector');
    expect(group.cardKeys).toContain('C-1');
    expect(group.cardKeys).toContain('P-1');
  });

  it('counts parameter filters groups and signals', () => {
    const tasks: MapTask[] = [
      { key: 'T-1', kind: 'theme', status: 'active', stageId: 's1', createdAt: '' },
      { key: 'P-1', kind: 'task', status: 'active', stageId: 's1', createdAt: '', themeKey: 'T-1' },
      { key: 'P-2', kind: 'task', status: 'active', stageId: 's1', createdAt: '', themeKey: 'T-1' },
    ];
    const states = new Map<string, MapState | null>([
      ['P-1', 'working'],
      ['P-2', 'waiting'],
    ]);

    const groups = workMap({ tasks, states, counts: (key) => key === 'P-1' });

    expect(groups.length).toBe(1);
    const group = groups[0]!;
    expect(group.key).toBe('T-1');
    expect(group.signals.working).toBe(1);
    expect(group.signals.waiting).toBe(0);
    expect(group.signals.open).toBe(1);
    expect(group.progress.total).toBe(2);
  });

  it('if counts accepts no card in group, group is dropped', () => {
    const tasks: MapTask[] = [
      { key: 'T-1', kind: 'theme', status: 'active', stageId: 's1', createdAt: '' },
      { key: 'P-1', kind: 'task', status: 'active', stageId: 's1', createdAt: '', themeKey: 'T-1' },
    ];
    const states = new Map<string, MapState | null>();

    const groups = workMap({ tasks, states, counts: () => false });
    expect(groups.length).toBe(0);
  });

  it('regression 1: empty collector groups are not pre-created inside themes', () => {
    const tasks: MapTask[] = [
      { key: 'PM-1', kind: 'theme', status: 'active', stageId: 's1', createdAt: '' },
      { key: 'PM-2', kind: 'task', status: 'active', stageId: 's1', createdAt: '', themeKey: 'PM-1' },
      {
        key: 'PM-3',
        kind: 'task',
        status: 'active',
        stageId: 's1',
        createdAt: '',
        themeKey: 'PM-1',
        parentKey: 'PM-2',
      },
    ];

    const states = new Map<string, MapState | null>();
    const groups = workMap({ tasks, states });

    // Should only have the theme group PM-1, not an empty collector group for PM-2
    expect(groups.length).toBe(1);
    expect(groups[0]!.key).toBe('PM-1');
    expect(groups[0]!.cardKeys).toContain('PM-2');
    expect(groups[0]!.cardKeys).toContain('PM-3');
  });

  it('regression 2: theme collector lane applies to done collectors if they have open children in the group', () => {
    const tasks: MapTask[] = [
      { key: 'PM-1', kind: 'theme', status: 'active', stageId: 's1', createdAt: '' },
      { key: 'PM-2', kind: 'task', status: 'done', stageId: 's1', createdAt: '', themeKey: 'PM-1' },
      {
        key: 'PM-3',
        kind: 'task',
        status: 'active',
        stageId: 's1',
        createdAt: '',
        themeKey: 'PM-1',
        parentKey: 'PM-2',
      },
    ];

    const states = new Map<string, MapState | null>();
    const groups = workMap({ tasks, states });

    expect(groups.length).toBe(1);
    const themeGroup = groups[0]!;

    // It should have a collector lane for PM-2
    const collectorLane = themeGroup.lanes.find((l) => l.kind === 'collector' && l.collectorKey === 'PM-2');
    expect(collectorLane).toBeDefined();
    expect(collectorLane!.cardKeys).toContain('PM-3');

    const looseLane = themeGroup.lanes.find((l) => l.kind === 'loose');
    expect(looseLane).toBeUndefined();
  });

  it('orders groups correctly by signals and task seq', () => {
    const tasks: MapTask[] = [
      { key: 'T-1', kind: 'theme', status: 'active', stageId: 's1', createdAt: '' },
      { key: 'C-1', kind: 'task', status: 'active', stageId: 's1', createdAt: '', themeKey: 'T-1' }, // needs_you
      { key: 'T-2', kind: 'theme', status: 'active', stageId: 's1', createdAt: '' },
      { key: 'C-2', kind: 'task', status: 'active', stageId: 's1', createdAt: '', themeKey: 'T-2' }, // blocked
      { key: 'T-3', kind: 'theme', status: 'active', stageId: 's1', createdAt: '' },
      { key: 'C-3', kind: 'task', status: 'active', stageId: 's1', createdAt: '', themeKey: 'T-3' }, // working
      { key: 'T-4', kind: 'theme', status: 'active', stageId: 's1', createdAt: '' },
      { key: 'C-4', kind: 'task', status: 'active', stageId: 's1', createdAt: '', themeKey: 'T-4' }, // waiting
      { key: 'T-5', kind: 'theme', status: 'active', stageId: 's1', createdAt: '' },
      { key: 'C-5', kind: 'task', status: 'active', stageId: 's1', createdAt: '', themeKey: 'T-5' }, // needs_you, wins tie by key seq
      { key: 'O-1', kind: 'task', status: 'active', stageId: 's1', createdAt: '' }, // other, always at end of level
    ];

    const states = new Map<string, MapState | null>([
      ['C-1', 'needs_you'],
      ['C-2', 'blocked'],
      ['C-3', 'working'],
      ['C-4', 'waiting'],
      ['C-5', 'needs_you'],
      ['O-1', 'needs_you'],
    ]);

    const groups = workMap({ tasks, states });

    // Order should be: T-1, T-5, other, T-2, T-3, T-4
    const keys = groups.map((g) => g.key);
    expect(keys).toEqual(['T-1', 'T-5', MAP_OTHER_GROUP_KEY, 'T-2', 'T-3', 'T-4']);
  });
});
