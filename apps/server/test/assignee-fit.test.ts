import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectConfig } from '@projectman/shared';
import { aiActor, SYSTEM_AUTHOR } from '../src/kernel';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';

/**
 * PM-1136: with `team.assigneeFit` an AI actor's named assignee has to fit the card's complexity limit;
 * a person names anyone, and without the setting nothing changes. `dev-2` has the limit 13, `dev-1` keeps 5.
 */
describe('the assignee an AI member names (team.assigneeFit)', () => {
  let h: DomainHarness;
  afterEach(() => h?.cleanup());

  const harness = async (assigneeFit?: 'automatic' | 'automatic_and_ai') => {
    h = await createDomainHarness({
      adjust: (c: ProjectConfig) => {
        c.team.limits.maxConcurrentAi = 10;
        if (assigneeFit) c.team.assigneeFit = assigneeFit;
        // The project manager is on duty from the start: it is the AI actor that reassigns.
        const pm = c.team.members.find((m) => m.handle === 'pm');
        if (pm?.kind === 'ai') pm.onLeave = false;
        const senior = c.team.members.find((m) => m.handle === 'dev-2');
        if (senior?.kind === 'ai') senior.complexityLimit = 13;
      },
    });
  };
  const create = async (points: 3 | 8 = 8) =>
    (
      await h.domain.tasks.create(
        'AR',
        { title: 'Card', complexity: { points, reason: 'Fictional.' } },
        OWNER_ACTOR,
      )
    ).key;
  const task = (key: string) => h.domain.tasks.get('AR', key);
  /** A scored card in the work stage that the automatic choice gave to `dev-2`. */
  const startedCard = async () => {
    const key = await create();
    await h.domain.tasks.moveToStage('AR', key, 'development', OWNER_ACTOR);
    await vi.waitFor(() => expect(task(key).assignee).toBe('dev-2'));
    return key;
  };
  const reassign = (key: string, assignee: string, actor = aiActor('pm')) =>
    h.domain.tasks.update('AR', key, { assignee }, actor);

  it('refuses a named developer whose limit is below the points and keeps the assignee', async () => {
    await harness('automatic_and_ai');
    const key = await startedCard();
    await expect(reassign(key, 'dev-1')).rejects.toMatchObject({
      status: 409,
      code: 'assignee_unfit',
      details: { member: 'dev-1', reason: 'over_complexity_limit', points: 8, limit: 5 },
    });
    expect(task(key).assignee).toBe('dev-2');
  });

  it('refuses the unfit assignee of a card that still waits in a queue stage', async () => {
    await harness('automatic_and_ai');
    const key = await create();
    expect(task(key).stageId).not.toBe('development');
    await expect(reassign(key, 'dev-1')).rejects.toMatchObject({ status: 409, code: 'assignee_unfit' });
    expect(task(key).assignee).toBeNull();
  });

  it('accepts a named developer that fits, and any developer for a small card', async () => {
    await harness('automatic_and_ai');
    const key = await create(3);
    await h.domain.tasks.moveToStage('AR', key, 'development', OWNER_ACTOR);
    await vi.waitFor(() => expect(task(key).assignee).not.toBeNull());
    const other = task(key).assignee === 'dev-1' ? 'dev-2' : 'dev-1';
    expect((await reassign(key, other)).assignee).toBe(other);
  });

  it('lets a person name a developer beyond the limit', async () => {
    await harness('automatic_and_ai');
    const key = await startedCard();
    expect((await reassign(key, 'dev-1', OWNER_ACTOR)).assignee).toBe('dev-1');
  });

  it('keeps today’s behaviour when the setting is off', async () => {
    await harness();
    const key = await startedCard();
    expect((await reassign(key, 'dev-1')).assignee).toBe('dev-1');
  });

  it('refuses start_task with an unfit assignee and assigns nobody', async () => {
    await harness('automatic_and_ai');
    const key = await create();
    await expect(
      h.domain.taskStarts.start('AR', key, {
        actor: aiActor('pm'),
        author: SYSTEM_AUTHOR,
        assignee: 'dev-1',
      }),
    ).rejects.toMatchObject({ status: 409, code: 'assignee_unfit' });
    expect(task(key).assignee).toBeNull();
  });
});
