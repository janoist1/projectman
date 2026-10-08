import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';

describe('stageEnteredAt moves', () => {
  let h: DomainHarness;
  beforeEach(async () => {
    h = await createDomainHarness();
  });
  afterEach(() => h.cleanup());

  it('updates stageEnteredAt when stage changes, leaves it unchanged on state updates, defaults to createdAt on create', async () => {
    const t0 = h.domain.ctx.now().toISOString();

    // Create a task
    const task = await h.domain.tasks.create(
      'AR',
      { title: 'Test stage entered at', repo: 'web' },
      OWNER_ACTOR,
    );

    // On create, stageEnteredAt should equal createdAt if backend sets it initially.
    expect(task.stageEnteredAt).toBeDefined();
    expect(task.stageEnteredAt).toBe(task.createdAt);

    const beforeMove = task.stageEnteredAt;

    // advance time to ensure timestamp difference
    vi.setSystemTime(new Date(Date.now() + 5000));

    // Move task to another stage
    const moved = await h.domain.tasks.moveToStage('AR', 'AR-1', 'development', OWNER_ACTOR);

    expect(moved.task.stageEnteredAt).toBeDefined();
    expect(moved.task.stageEnteredAt).not.toBe(beforeMove);
    expect(moved.task.stageEnteredAt! > beforeMove!).toBe(true);

    const afterMove = moved.task.stageEnteredAt;

    // advance time again
    vi.setSystemTime(new Date(Date.now() + 5000));

    // Update task labels, not stage
    const unchanged = await h.domain.tasks.update('AR', 'AR-1', { addLabels: ['waiting'] }, OWNER_ACTOR);

    // stageEnteredAt should not change
    expect(unchanged.stageEnteredAt).toBe(afterMove);

    vi.useRealTimers();
  });
});
