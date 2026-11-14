import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectConfig, StartCondition } from '@projectman/shared';
import type { Task } from '@projectman/shared';
import { createRepositories, openDatabase } from '../src/db';
import { createDomainContext } from '../src/core/base';
import { StartConditionMarks } from '../src/runtime/admission';
import { capturingLogger } from './helpers/fakes';
import { openMigratedMemoryDatabase } from './helpers/database-seed';

afterEach(() => vi.useRealTimers());

it('persists marks across database reopening and applies removals atomically within the project', () => {
  const folder = mkdtempSync(join(tmpdir(), 'start-marks-'));
  const path = join(folder, 'db.sqlite');
  let db = openDatabase(path);
  try {
    createRepositories(db).startConditionMarks.apply('AC', {
      add: [{ taskKey: 'AC-1', metSince: '2026-11-14T00:00:00.000Z' }],
      remove: [],
    });
    db.close();
    db = openDatabase(path);
    const repo = createRepositories(db).startConditionMarks;
    expect(repo.ofProject('AC').get('AC-1')).toBe('2026-11-14T00:00:00.000Z');
    repo.apply('OTHER', { add: [], remove: ['AC-1'] });
    expect(repo.ofProject('AC').size).toBe(1);
    repo.apply('AC', { add: [{ taskKey: 'AC-2', metSince: 'later' }], remove: ['AC-1'] });
    expect([...repo.ofProject('AC')]).toEqual([['AC-2', 'later']]);
    repo.clearProject('AC');
    expect(repo.ofProject('AC').size).toBe(0);
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

it('serializes updates, schedules the next deadline, restarts after a hold and clears on disable', async () => {
  vi.useFakeTimers();
  vi.setSystemTime('2026-11-14T00:00:00.000Z');
  const db = openMigratedMemoryDatabase();
  const config = ProjectConfig.parse({
    schemaVersion: 1,
    project: { key: 'AC', name: 'Acme', workspacePath: '/work', repos: [] },
    team: {
      members: [{ kind: 'human', handle: 'owner', displayName: 'Owner', access: 'owner' }],
      limits: {},
      startCondition: { priority: 'any', hold: ['hold'] },
    },
    pipeline: {
      columns: [{ id: 'all', name: 'All' }],
      stages: [
        { id: 'ready', name: 'Ready', kind: 'queue', columnId: 'all' },
        { id: 'dev', name: 'Work', kind: 'work', columnId: 'all' },
      ],
      labels: [],
    },
  });
  const task = {
    key: 'AC-1',
    kind: 'task',
    stageId: 'ready',
    status: 'active',
    priority: 'high',
    labels: [],
    links: [],
  } as unknown as Task;
  const ctx = createDomainContext({
    repos: createRepositories(db),
    bus: { publish: () => {}, subscribe: () => () => {} },
    logger: capturingLogger().logger,
    now: () => new Date(),
  });
  const onDue = vi.fn();
  const tracker = new StartConditionMarks({
    ctx,
    projects: { config: async () => config },
    tasks: {
      readSchedulingTasks: (_key, query) => (query.kind === 'queue' ? [task] : []),
    },
    onDue,
  });
  try {
    const results = await Promise.all([tracker.update('AC'), tracker.update('AC')]);
    expect([...results[0]!]).toEqual([...results[1]!]);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(onDue).not.toHaveBeenCalled();
    task.labels = ['hold'];
    expect((await tracker.update('AC')).size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    task.labels = [];
    const restarted = await tracker.update('AC');
    expect(restarted.get(task.key)).toBe(new Date().toISOString());
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(onDue).toHaveBeenCalledExactlyOnceWith('AC');
    await tracker.update('AC');
    expect(vi.getTimerCount()).toBe(0);
    delete config.team.startCondition;
    expect((await tracker.update('AC')).size).toBe(0);
    config.team.startCondition = StartCondition.parse({ priority: 'any' });
    await tracker.update('AC');
    tracker.dispose();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    tracker.dispose();
    db.close();
  }
});
