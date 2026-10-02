import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectConfig } from '@projectman/shared';
import { aiActor } from '../src/domain';
import { createDomainHarness, OWNER, OWNER_ACTOR, restartDomainHarness } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

/**
 * PM-204: a card moved into the work stage with an open prerequisite waits, durably, and starts
 * once when the last prerequisite closes (done or withdrawn) or its relation is removed. Cards
 * AR-1 (the dependent), AR-2 and AR-3 (prerequisites) are created in the queue stage.
 */
describe('work start of a card with open prerequisites', () => {
  let h: DomainHarness;
  afterEach(() => h?.cleanup());

  /** Room for every session and no gates, so that a card moves straight to done. */
  const setup = (config: ProjectConfig) => {
    config.team.limits.maxConcurrentAi = 10;
    for (const stage of config.pipeline.stages) if (stage.kind !== 'release') delete stage.gate;
    config.pipeline.stages = config.pipeline.stages.filter((stage) => stage.kind !== 'release');
  };
  const task = (key: string) => h.domain.tasks.get('AR', key);
  const waiting = (key: string) => task(key).startWaiting;
  const storedKeys = () => h.repos.deferredStarts.list().map((record) => record.key);
  const sessionsOf = (key: string) => h.domain.sessions.list('AR', { taskKey: key });
  const move = (key: string, stage = 'development') =>
    h.domain.tasks.moveToStage('AR', key, stage, OWNER_ACTOR);
  const prerequisites = (...keys: string[]) =>
    h.domain.tasks.update(
      'AR',
      'AR-1',
      { relations: { add: keys.map((key) => ({ kind: 'prerequisite' as const, key })) } },
      OWNER_ACTOR,
    );

  async function prepare(prerequisiteCount = 1) {
    h = await createDomainHarness({ persistent: true, adjust: setup });
    for (const title of ['Dependent', 'First', 'Second'])
      await h.domain.tasks.create('AR', { title }, OWNER_ACTOR);
    await prerequisites(...['AR-2', 'AR-3'].slice(0, prerequisiteCount));
  }

  it('waits with the open prerequisites named, assigns nobody and keeps the wait durably', async () => {
    await prepare(2);
    await move('AR-1');
    await vi.waitFor(() => expect(waiting('AR-1')).toMatchObject({ reason: 'prerequisite_open' }));
    expect(waiting('AR-1')?.prerequisites).toEqual(['AR-2', 'AR-3']);
    expect(task('AR-1').assignee).toBeNull();
    expect(storedKeys()).toEqual(['work-start:AR:AR-1']);
    expect(h.runner.started).toHaveLength(0);
    // The timer's retry changes nothing while the same prerequisites are open.
    const before = waiting('AR-1');
    await h.domain.admission.retryDeferred();
    expect(waiting('AR-1')).toEqual(before);
    expect(h.runner.started).toHaveLength(0);
  });

  it('does not wait, and starts as before, when the card has no open prerequisite', async () => {
    await prepare(0);
    await move('AR-1');
    await vi.waitFor(() => expect(task('AR-1').assignee).toBe('dev-1'));
    expect(waiting('AR-1')).toBeUndefined();
  });

  it.each([
    ['done', (key: string) => move(key, 'done')],
    ['withdrawn', (key: string) => h.domain.tasks.cancel('AR', key, {}, OWNER_ACTOR)],
  ])('starts once when its prerequisite is %s', async (_how, close) => {
    await prepare();
    await move('AR-1');
    await vi.waitFor(() => expect(storedKeys()).toEqual(['work-start:AR:AR-1']));

    await close('AR-2');

    await vi.waitFor(() => expect(task('AR-1').assignee).toBe('dev-1'));
    await vi.waitFor(() => expect(h.runner.started).toHaveLength(1));
    expect(waiting('AR-1')).toBeUndefined();
    expect(storedKeys()).toEqual([]);
    await h.domain.admission.retryDeferred();
    await flush();
    expect(sessionsOf('AR-1')).toHaveLength(1);
    expect(h.runner.started).toHaveLength(1);
  });

  it('starts when the relation is removed', async () => {
    await prepare();
    await move('AR-1');
    await vi.waitFor(() => expect(storedKeys()).toEqual(['work-start:AR:AR-1']));

    await h.domain.tasks.update(
      'AR',
      'AR-1',
      { relations: { remove: [{ kind: 'prerequisite', key: 'AR-2' }] } },
      OWNER_ACTOR,
    );

    await vi.waitFor(() => expect(task('AR-1').assignee).toBe('dev-1'));
    expect(h.runner.started).toHaveLength(1);
  });

  it('with two prerequisites, starts only after the last one and shows what is still open', async () => {
    await prepare(2);
    await move('AR-1');
    await vi.waitFor(() => expect(waiting('AR-1')?.prerequisites).toEqual(['AR-2', 'AR-3']));

    await move('AR-2', 'done');

    await vi.waitFor(() => expect(waiting('AR-1')?.prerequisites).toEqual(['AR-3']));
    expect(h.runner.started).toHaveLength(0);
    expect(task('AR-1').assignee).toBeNull();

    await h.domain.tasks.cancel('AR', 'AR-3', {}, OWNER_ACTOR);

    await vi.waitFor(() => expect(task('AR-1').assignee).toBe('dev-1'));
    expect(h.runner.started).toHaveLength(1);
  });

  it('keeps the wait over a restart, and starts once the prerequisite is closed', async () => {
    await prepare();
    await move('AR-1');
    await vi.waitFor(() => expect(storedKeys()).toEqual(['work-start:AR:AR-1']));
    const before = waiting('AR-1');

    h = await restartDomainHarness(h);
    await vi.waitFor(() => expect(waiting('AR-1')).toEqual(before));
    expect(storedKeys()).toEqual(['work-start:AR:AR-1']);
    expect(h.runner.started).toHaveLength(0);

    await move('AR-2', 'done');
    await vi.waitFor(() => expect(task('AR-1').assignee).toBe('dev-1'));
    expect(h.runner.started).toHaveLength(1);
    expect(storedKeys()).toEqual([]);
  });

  it('starts nothing twice when the prerequisite closes while a person starts the card', async () => {
    await prepare();
    await move('AR-1');
    await vi.waitFor(() => expect(storedKeys()).toEqual(['work-start:AR:AR-1']));

    await Promise.allSettled([
      move('AR-2', 'done'),
      h.domain.taskStarts.start('AR', 'AR-1', { actor: OWNER_ACTOR, author: OWNER }),
    ]);
    await h.domain.admission.retryDeferred();
    await vi.waitFor(() => expect(task('AR-1').assignee).not.toBeNull());
    await flush();

    expect(sessionsOf('AR-1')).toHaveLength(1);
    expect(h.runner.started).toHaveLength(1);
    expect(storedKeys()).toEqual([]);
  });

  it('starts at once when a person moves the card after the warning', async () => {
    await prepare();
    await h.domain.tasks.update(
      'AR',
      'AR-1',
      { stageId: 'development', despitePrerequisites: true },
      OWNER_ACTOR,
    );
    await vi.waitFor(() => expect(task('AR-1').assignee).toBe('dev-1'));
    expect(waiting('AR-1')).toBeUndefined();
    expect(storedKeys()).toEqual([]);
    expect(h.runner.started).toHaveLength(1);
  });

  it('waits when an AI member moves the card, whatever the request says', async () => {
    await prepare();
    await h.domain.tasks.update(
      'AR',
      'AR-1',
      { stageId: 'development', despitePrerequisites: true },
      aiActor('dev-1'),
    );
    await vi.waitFor(() => expect(waiting('AR-1')).toMatchObject({ reason: 'prerequisite_open' }));
    expect(task('AR-1').assignee).toBeNull();
    expect(h.runner.started).toHaveLength(0);
  });

  it('does not start a card in a queue stage when its prerequisite closes', async () => {
    await prepare();
    expect(storedKeys()).toEqual([]);
    await move('AR-2', 'done');
    await h.domain.admission.retryDeferred();
    await flush();
    expect(task('AR-1')).toMatchObject({ stageId: 'backlog', assignee: null });
    expect(h.runner.started).toHaveLength(0);
  });

  it('lets a card that was started before the prerequisite was added carry on', async () => {
    await prepare(0);
    await move('AR-1');
    await vi.waitFor(() => expect(h.runner.started).toHaveLength(1));
    await prerequisites('AR-2');
    await flush();
    expect(h.runner.started).toHaveLength(1);
    expect(task('AR-1').assignee).toBe('dev-1');
    expect(waiting('AR-1')).toBeUndefined();
  });
});
