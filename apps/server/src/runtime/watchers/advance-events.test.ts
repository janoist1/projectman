import { describe, expect, it, vi } from 'vitest';
import type { Task } from '@projectman/shared';
import type { FastifyBaseLogger } from 'fastify';
import { createDomainEvents } from '../../core/base';
import type { BackgroundTasks } from '../../kernel';
import { wireCardAdvance } from './advance-events';

function setup() {
  const logger = { warn: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger;
  const events = createDomainEvents(logger);
  const merges = { reconcile: vi.fn(async () => {}), pump: vi.fn() };
  const background = { run: (work: () => Promise<void>) => void work() } as unknown as BackgroundTasks;
  wireCardAdvance({
    events,
    tasks: { find: () => null },
    merges,
    autoAdvance: { check: vi.fn(async () => {}) },
    background,
    logger,
  });
  return { events, merges };
}

const task = (status: string) => ({ projectKey: 'AR', key: 'AR-1', status }) as unknown as Task;

describe('card advance events', () => {
  it('pumps the merge queue when a card is done, so a merge waiting for it starts', async () => {
    const { events, merges } = setup();
    await events.emit('task_stage_changed', { task: task('done') } as never);
    expect(merges.pump).toHaveBeenCalledTimes(1);
  });

  it('does not pump for a card that only moved to another working stage', async () => {
    const { events, merges } = setup();
    await events.emit('task_stage_changed', { task: task('active') } as never);
    expect(merges.pump).not.toHaveBeenCalled();
  });

  it.each(['task_cancelled', 'task_prerequisite_removed'] as const)(
    'pumps the merge queue on %s',
    async (type) => {
      const { events, merges } = setup();
      await events.emit(type, task('active') as never);
      expect(merges.pump).toHaveBeenCalledTimes(1);
    },
  );
});
