import { describe, it, expect } from 'vitest';
import { isStale, staleDays, STALE_AFTER_MS, mapStateOf } from './work-map';
import type { MapTask, TaskPhase } from './work-map';
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
