import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { aiActor } from '../src/domain';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

/**
 * PM-204: a card whose prerequisite is open is not started by a person without the warning being
 * accepted, and its timeline records each prerequisite that closes. Cards AR-1 (the dependent) and
 * AR-2, AR-3 (its prerequisites) are created in the queue stage for each test.
 */
let h: DomainHarness;

beforeEach(async () => {
  h = await createDomainHarness({
    // No gates, so that a card can move straight to done.
    adjust: (config) => {
      for (const stage of config.pipeline.stages) if (stage.kind !== 'release') delete stage.gate;
      config.pipeline.stages = config.pipeline.stages.filter((stage) => stage.kind !== 'release');
    },
  });
  for (const title of ['Dependent', 'First', 'Second'])
    await h.domain.tasks.create('AR', { title }, OWNER_ACTOR);
  await h.domain.tasks.update(
    'AR',
    'AR-1',
    {
      relations: {
        add: [
          { kind: 'prerequisite', key: 'AR-2' },
          { kind: 'prerequisite', key: 'AR-3' },
        ],
      },
    },
    OWNER_ACTOR,
  );
});
afterEach(() => h.cleanup());

const start = (despite?: boolean, actor = OWNER_ACTOR) =>
  h.domain.taskStarts.start('AR', 'AR-1', { actor, author: OWNER, despitePrerequisites: despite });
const closures = () =>
  h.domain.timeline
    .list('AR', { taskKey: 'AR-1' })
    .filter((event) => event.type === 'task_prerequisite_closed')
    .map((event) => event.data);

describe('a person starting a card with an open prerequisite', () => {
  it('is refused with the open keys, and nothing is started or changed', async () => {
    await expect(start()).rejects.toMatchObject({
      code: 'prerequisite_open',
      details: { prerequisites: ['AR-2', 'AR-3'] },
    });
    expect(h.runner.started).toHaveLength(0);
    expect(h.domain.tasks.get('AR', 'AR-1')).toMatchObject({ stageId: 'backlog', assignee: null });
  });

  it('names only the prerequisites that are still open', async () => {
    await h.domain.tasks.moveToStage('AR', 'AR-2', 'done', OWNER_ACTOR);
    await expect(start()).rejects.toMatchObject({ details: { prerequisites: ['AR-3'] } });
  });

  it('starts once the warning is accepted', async () => {
    const result = await start(true);
    expect(result.session).not.toBeNull();
    expect(h.domain.tasks.get('AR', 'AR-1').stageId).toBe('development');
    expect(h.runner.started).toHaveLength(1);
  });

  it('is not let through by an AI actor that sends the flag', async () => {
    await expect(start(true, aiActor('dev-1'))).rejects.toMatchObject({ code: 'prerequisite_open' });
    expect(h.runner.started).toHaveLength(0);
  });

  it('starts without the warning when every prerequisite is closed', async () => {
    await h.domain.tasks.moveToStage('AR', 'AR-2', 'done', OWNER_ACTOR);
    await h.domain.tasks.cancel('AR', 'AR-3', {}, OWNER_ACTOR);
    expect((await start()).session).not.toBeNull();
  });
});

describe('the timeline of a card that waits for prerequisites', () => {
  it('records each prerequisite that closes, with how it closed and what is still open', async () => {
    await h.domain.tasks.moveToStage('AR', 'AR-2', 'done', OWNER_ACTOR);
    await flush();
    await h.domain.tasks.cancel('AR', 'AR-3', {}, OWNER_ACTOR);
    await flush();
    expect(closures()).toEqual([
      { ref: 'AR-2', status: 'done', remaining: ['AR-3'] },
      { ref: 'AR-3', status: 'cancelled', remaining: [] },
    ]);
  });

  it('records nothing on a card that is closed itself, or when a card moves between open stages', async () => {
    await h.domain.tasks.moveToStage('AR', 'AR-2', 'development', OWNER_ACTOR);
    await flush();
    expect(closures()).toEqual([]);
    await h.domain.tasks.cancel('AR', 'AR-1', {}, OWNER_ACTOR);
    await h.domain.tasks.cancel('AR', 'AR-3', {}, OWNER_ACTOR);
    await flush();
    expect(closures()).toEqual([]);
  });
});
