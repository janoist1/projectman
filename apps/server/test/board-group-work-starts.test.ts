import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectConfig } from '@projectman/shared';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';
import { deferredStartRecords } from './helpers/deferred-starts';

/**
 * PM-121 with PM-119: a collecting card dropped on the work column with its subtasks enters the work
 * stage card by card. Admission starts the subtasks, leaving the collecting card unassigned.
 */
describe('a group move into the work column', () => {
  let h: DomainHarness;
  afterEach(() => h?.cleanup());

  const roomy = (c: ProjectConfig) => void (c.team.limits.maxConcurrentAi = 10);
  const task = (key: string) => h.domain.tasks.get('AR', key);
  const sessionsOf = (key: string) => h.domain.sessions.list('AR', { taskKey: key });
  const storedKeys = () => deferredStartRecords(h.repos).map((r) => r.key);
  const family = async () => {
    await h.domain.tasks.create('AR', { title: 'Collecting' }, OWNER_ACTOR);
    for (const title of ['One', 'Two'])
      await h.domain.tasks.create('AR', { title, parentKey: 'AR-1' }, OWNER_ACTOR);
  };
  const drop = () =>
    h.domain.tasks.moveOnBoard(
      'AR',
      'AR-1',
      { columnId: 'doing', fromStageId: 'backlog', placement: { at: 'top' }, withSubtasks: true },
      OWNER_ACTOR,
    );

  it('starts the subtasks without assigning or starting the collecting card', async () => {
    h = await createDomainHarness({ persistent: true, adjust: roomy });
    await family();
    const result = await drop();
    expect(result.group?.map((item) => item.outcome)).toEqual(['moved', 'moved', 'moved']);
    await vi.waitFor(() => expect(h.runner.started).toHaveLength(2));
    await flush();
    expect(task('AR-1').assignee).toBeNull();
    expect(task('AR-1').startWaiting).toBeUndefined();
    expect(sessionsOf('AR-1')).toEqual([]);
    expect([task('AR-2').assignee, task('AR-3').assignee].sort()).toEqual(['dev-1', 'dev-2']);
    expect(storedKeys()).toEqual([]);
    await h.domain.admission.retryDeferred();
    await flush();
    expect(h.runner.started).toHaveLength(2);
  });
});
