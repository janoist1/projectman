import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectConfig } from '@projectman/shared';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

/**
 * PM-121 with PM-119: a collecting card dropped on the work column with its subtasks enters the work
 * stage card by card, and the admission starts each one on its own event: as many as there are free
 * developers, the rest wait durably, and nothing starts twice.
 */
describe('a group move into the work column', () => {
  let h: DomainHarness;
  afterEach(() => h?.cleanup());

  const roomy = (c: ProjectConfig) => void (c.team.limits.maxConcurrentAi = 10);
  const task = (key: string) => h.domain.tasks.get('AR', key);
  const sessionsOf = (key: string) => h.domain.sessions.list('AR', { taskKey: key });
  const storedKeys = () => h.repos.deferredStarts.list().map((r) => r.key);
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

  it('starts one card per free developer and keeps the others waiting, with no double start', async () => {
    h = await createDomainHarness({ persistent: true, adjust: roomy });
    await family();
    const result = await drop();
    expect(result.group?.map((item) => item.outcome)).toEqual(['moved', 'moved', 'moved']);
    await vi.waitFor(() => expect(h.runner.started).toHaveLength(2));
    await flush();
    // The collecting card is told first and takes the first free developer, as a card of its own would.
    expect(task('AR-1').assignee).toBe('dev-1');
    const assignees = ['AR-1', 'AR-3', 'AR-2'].map((key) => task(key).assignee);
    expect(assignees.filter(Boolean)).toHaveLength(2);
    const waitingKey = ['AR-1', 'AR-3', 'AR-2'].find((key) => !task(key).assignee)!;
    expect(task(waitingKey).startWaiting).toMatchObject({ reason: 'no_free_member' });
    expect(storedKeys()).toEqual([`work-start:AR:${waitingKey}`]);
    expect(['AR-1', 'AR-2', 'AR-3'].flatMap((key) => sessionsOf(key))).toHaveLength(2);

    // Once a developer is free the waiting card starts, and the others do not start again.
    const running = ['AR-1', 'AR-2', 'AR-3'].find((key) => task(key).assignee && key !== waitingKey)!;
    await h.domain.tasks.cancel('AR', running, { reason: 'Fictional scope changed.' }, OWNER_ACTOR);
    await vi.waitFor(() => expect(task(waitingKey).assignee).toBeTruthy());
    await flush();
    expect(h.runner.started).toHaveLength(3);
    expect(['AR-1', 'AR-2', 'AR-3'].flatMap((key) => sessionsOf(key))).toHaveLength(3);
    expect(storedKeys()).toEqual([]);
  });
});
