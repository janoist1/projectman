import { describe, expect, it } from 'vitest';
import { applyConfigPatch, PatchConfigRequest } from '../config/edit';
import { validateProjectConfig } from '../config/invariants';
import { ownerOnlyChanges } from '../config/owner-only';
import { ProjectConfig, StartCondition } from '../config/schema';
import {
  startConditionGoes,
  startConditionHeld,
  startConditionHolds,
  startConditionMarkChanges,
  startConditionShift,
  startConditionSummary,
  startConditionTracked,
} from './start-condition';
import { pullCandidates, startableCards } from './start-order';
import type { Task } from './task';

const base = ProjectConfig.parse({
  schemaVersion: 1,
  project: { key: 'AC', name: 'Acme', workspacePath: '/work', repos: [] },
  team: { members: [{ kind: 'human', handle: 'owner', displayName: 'Owner', access: 'owner' }], limits: {} },
  pipeline: {
    columns: [{ id: 'all', name: 'All' }],
    stages: [
      { id: 'ideas', name: 'Ideas', kind: 'queue', columnId: 'all' },
      { id: 'ready', name: 'Ready', kind: 'queue', columnId: 'all' },
      { id: 'dev', name: 'Work', kind: 'work', columnId: 'all' },
      { id: 'late', name: 'Later', kind: 'queue', columnId: 'all' },
      { id: 'done', name: 'Done', kind: 'done', columnId: 'all' },
    ],
    labels: [
      { id: 'go', name: 'Go', setBy: 'anyone' },
      { id: 'hold', name: 'Wait', setBy: 'anyone' },
    ],
  },
});
const config = (condition: unknown = { priority: 'any', hold: ['hold'] }): ProjectConfig => ({
  ...base,
  team: { ...base.team, startCondition: StartCondition.parse(condition) },
});
const card = (extra: Partial<Task> = {}): Task =>
  ({
    key: 'AC-1',
    kind: 'task',
    stageId: 'ready',
    status: 'active',
    archivedAt: null,
    priority: null,
    labels: [],
    links: [],
    assignee: null,
    parentKey: null,
    themeKey: null,
    ...extra,
  }) as Task;
const since = '2026-11-14T00:00:00.000Z';
const due = '2026-11-14T00:05:00.000Z';

describe('start condition', () => {
  it.each([
    [{ stages: ['ready'] }, {}, true],
    [{ priority: 'any' }, {}, false],
    [{ priority: 'any' }, { priority: 'low' }, true],
    [{ priority: 'high' }, { priority: 'normal' }, false],
    [{ priority: 'high' }, { priority: 'urgent' }, true],
    [{ labels: ['go'] }, { labels: ['go'] }, true],
    [{ stages: ['ready'], priority: 'any', combine: 'all' }, {}, false],
    [{ stages: ['ready'], priority: 'any', combine: 'any' }, {}, true],
  ] as const)('evaluates forms %j with %j', (condition, extra, expected) => {
    const task = card(extra as Partial<Task>);
    expect(startConditionHolds(task, [task], config(condition))).toBe(expected);
  });

  it.each(['parent', 'theme', 'parent-theme'] as const)(
    'inherits priority, start labels and hold labels from %s',
    (source) => {
      const task = card(source === 'theme' ? { themeKey: 'AC-2' } : { parentKey: 'AC-2' });
      const ancestor = card({
        key: 'AC-2',
        ...(source === 'parent-theme' ? { themeKey: 'AC-3' } : { priority: 'high', labels: ['go'] }),
      });
      const origin =
        source === 'parent-theme'
          ? card({ key: 'AC-3', kind: 'theme', priority: 'high', labels: ['go'] })
          : ancestor;
      const tasks = [...new Map([task, ancestor, origin].map((row) => [row.key, row])).values()];
      expect(
        startConditionHolds(task, tasks, config({ priority: 'high', labels: ['go'], combine: 'all' })),
      ).toBe(true);
      origin.labels.push('hold');
      expect(startConditionHeld(task, tasks, config())).toBe(true);
      for (const inactive of [{ status: 'done' }, { archivedAt: since }] as const) {
        Object.assign(origin, { status: 'active', archivedAt: null }, inactive);
        expect(startConditionHeld(task, tasks, config())).toBe(false);
        expect(startConditionHolds(task, tasks, config())).toBe(false);
      }
    },
  );

  it('withholds urgent cards on their own hold label and rejects an urgent card that fails the forms', () => {
    const task = card({ priority: 'urgent', labels: ['hold'] });
    expect(pullCandidates({ config: config(), tasks: [task] })).toEqual([]);
    expect(
      pullCandidates({ config: config({ labels: ['go'] }), tasks: [card({ priority: 'urgent' })] }),
    ).toEqual([]);
  });

  it('waits until the grace boundary and bypasses it for effective urgent, zero grace and sufficient stage matches', () => {
    const task = card({ priority: 'high' });
    const goes = (c: ProjectConfig, now: string, metSince: string | null = since, tasks = [task]) =>
      startConditionGoes({ task, tasks, config: c, now, metSince });
    expect(goes(config(), '2026-11-14T00:04:59.999Z')).toBe(false);
    expect(goes(config(), due)).toBe(true);
    expect(goes(config(), due, null)).toBe(false);
    expect(goes(config({ priority: 'any', graceMinutes: 0 }), since, null)).toBe(true);
    expect(goes(config({ stages: ['ready'] }), since, null)).toBe(true);
    expect(goes(config({ stages: ['ready'], priority: 'any' }), since, null)).toBe(true);
    expect(goes(config({ stages: ['ready'], priority: 'any', combine: 'all' }), since, null)).toBe(false);
    task.parentKey = 'AC-2';
    expect(goes(config(), since, null, [task, card({ key: 'AC-2', priority: 'urgent' })])).toBe(true);
  });

  it('adds marks on activation, preserves them, removes failures and restarts after hold removal', () => {
    const task = card({ priority: 'high' });
    const marks = new Map<string, string>();
    const update = (c = config(), now = since) => {
      const changes = startConditionMarkChanges({ config: c, tasks: [task], marks, now });
      for (const key of changes.remove) marks.delete(key);
      for (const row of changes.add) marks.set(row.taskKey, row.metSince);
      return changes;
    };
    expect(update().add).toEqual([{ taskKey: task.key, metSince: since }]);
    expect(update(config(), due)).toEqual({ add: [], remove: [] });
    task.labels = ['hold'];
    expect(update().remove).toEqual([task.key]);
    task.labels = [];
    update(config(), due);
    expect(marks.get(task.key)).toBe(due);
    expect(update(base).remove).toEqual([task.key]);
  });

  it.each([
    { status: 'done' },
    { status: 'waiting' },
    { kind: 'theme' },
    { stageId: 'dev' },
    { stageId: 'late' },
    { archivedAt: since },
  ] as const)('does not track %j', (extra) => {
    expect(startConditionTracked(card(extra), config())).toBe(false);
  });

  it('filters only the source queue and preserves legacy offers and urgent pulls without a condition', () => {
    const task = card();
    const start = (c: ProjectConfig, tasks = [task], fromStageId = 'ready', marks?: Map<string, string>) =>
      startableCards({ config: c, tasks, fromStageId, toStageId: 'dev', marks, now: due });
    expect(start(base)).toEqual([task]);
    expect(pullCandidates({ config: base, tasks: [task] })).toEqual([]);
    expect(start(config())).toEqual([]);
    task.priority = 'high';
    expect(start(config())).toEqual([]);
    expect(start(config(), [task], 'ready', new Map([[task.key, since]]))).toEqual([task]);
    task.stageId = 'dev';
    task.priority = null;
    expect(start(config(), [task], 'dev')).toEqual([task]);
    task.stageId = 'ready';
    task.priority = 'urgent';
    expect(pullCandidates({ config: config(), tasks: [task] })).toEqual([task]);
    expect(pullCandidates({ config: base, tasks: [task] })).toEqual([task]);
  });

  it('patches and clears the owner-only setting without introducing a stored default', () => {
    expect(base.team.startCondition).toBeUndefined();
    const next = applyConfigPatch(
      base,
      PatchConfigRequest.parse({ baseVersion: 'v1', startCondition: { priority: 'any' } }),
    );
    expect(next.team.startCondition).toMatchObject({ graceMinutes: 5, combine: 'any', hold: [] });
    expect(ownerOnlyChanges(base, next)).toContain('project_manager_authority');
    const cleared = applyConfigPatch(
      next,
      PatchConfigRequest.parse({ baseVersion: 'v2', startCondition: null }),
    );
    expect(cleared.team.startCondition).toBeUndefined();
    expect(ownerOnlyChanges(next, cleared)).toContain('project_manager_authority');
  });

  it.each(['missing', 'dev', 'late'])('rejects invalid stage reference %s', (stage) => {
    expect(validateProjectConfig(config({ stages: [stage] }))).toContainEqual(
      expect.objectContaining({ code: 'start_condition_invalid_stage' }),
    );
  });
  it.each(['labels', 'hold'])('rejects undefined %s references', (field) => {
    expect(validateProjectConfig(config({ priority: 'any', [field]: ['missing'] }))).toContainEqual(
      expect.objectContaining({ code: 'unknown_label' }),
    );
  });
  it.each([{}, { labels: ['go'], hold: ['go'] }, { priority: 'any', graceMinutes: -1 }])(
    'rejects malformed conditions %j',
    (value) => {
      expect(StartCondition.safeParse(value).success).toBe(false);
    },
  );

  it('describes condition changes and limits the key lists', () => {
    const tasks = Array.from({ length: 25 }, (_, i) => card({ key: `AC-${i + 1}`, priority: 'high' }));
    const shift = startConditionShift({ before: config(), after: config({ labels: ['go'] }), tasks });
    expect(shift.stopped).toHaveLength(20);
    expect(shift.stoppedCount).toBe(25);
    expect(shift.startedCount).toBe(0);
    expect(startConditionSummary(config().team.startCondition!, base)).toContain('5');
  });
});
