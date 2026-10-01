import { afterEach, describe, expect, it } from 'vitest';
import { questionPayloadOf } from '@projectman/shared';
import type { ProjectConfig } from '@projectman/shared';
import type { ToolContext } from '../src/contracts';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { rejection } from './helpers/errors';
import { flush } from './helpers/fakes';

const owner = { handle: 'owner', access: 'owner' as const };
const WAITING = 'waiting-answer';

function withWaitingLabel(config: ProjectConfig): void {
  config.pipeline.labels.push({ id: WAITING, name: 'Waiting for an answer', setBy: 'anyone', blocks: true });
}

/** The waiting label of an open AI question (PM-185): it goes on and off with the questions. */
describe('the waiting label of an open AI question', () => {
  let h: DomainHarness;
  let dev: ToolContext;
  afterEach(() => h.cleanup());

  /** AR-1 is started, so it stands in the development stage (a work stage) with `dev-1`'s session. */
  async function setup(adjust?: (config: ProjectConfig) => void): Promise<void> {
    h = await createDomainHarness({ adjust });
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
    const started = await h.domain.taskStarts.start('AR', 'AR-1', { actor: OWNER_ACTOR, author: OWNER });
    dev = { sessionId: started.session!.id, projectKey: 'AR', member: 'dev-1', taskKey: 'AR-1' };
  }

  const labels = (key = 'AR-1') => h.domain.tasks.get('AR', key).labels;
  const ask = (question: string, taskKey?: string) =>
    h.domain.teamTools.askHuman(dev, { question, options: ['Yes', 'No'], ...(taskKey ? { taskKey } : {}) });
  async function answer(inboxItemId: string): Promise<void> {
    await h.domain.inbox.resolve('AR', inboxItemId, { optionId: 'option_1' }, owner);
    await flush();
  }
  const timelineOf = (type: string) =>
    h.domain.timeline.list('AR', { taskKey: 'AR-1' }).filter((event) => event.type === type);
  const labelEvents = () => timelineOf('task_labels_changed');

  it('goes on with a question and comes off with its answer, by the system and with its reason', async () => {
    await setup(withWaitingLabel);
    expect(h.domain.tasks.get('AR', 'AR-1').stageId).toBe('development');

    const { inboxItemId } = await ask('Which font?');
    expect(labels()).toEqual([WAITING]);
    expect(questionPayloadOf(h.domain.inbox.get('AR', inboxItemId))?.autoLabel).toBe(true);
    expect(labelEvents().at(-1)).toMatchObject({
      actor: { kind: 'system' },
      data: { added: [WAITING], removed: [], reason: 'open_question' },
    });
    expect(timelineOf('task_note').at(-1)?.data.text).toContain('Which font?');

    await answer(inboxItemId);
    expect(labels()).toEqual([]);
    expect(labelEvents().at(-1)).toMatchObject({
      actor: { kind: 'system' },
      data: { added: [], removed: [WAITING], reason: 'open_question' },
    });
  });

  it('stays until the last of two open questions closes, whichever closes first', async () => {
    await setup(withWaitingLabel);
    const first = await ask('First question?');
    const second = await ask('Second question?');
    expect(labels()).toEqual([WAITING]);
    expect(questionPayloadOf(h.domain.inbox.get('AR', second.inboxItemId))?.autoLabel).toBe(true);

    await answer(first.inboxItemId);
    expect(labels()).toEqual([WAITING]);
    await answer(second.inboxItemId);
    expect(labels()).toEqual([]);

    const third = await ask('Third question?');
    const fourth = await ask('Fourth question?');
    await answer(fourth.inboxItemId);
    expect(labels()).toEqual([WAITING]);
    await answer(third.inboxItemId);
    expect(labels()).toEqual([]);
  });

  it('is not taken off when a person put it on before the question', async () => {
    await setup(withWaitingLabel);
    await h.domain.tasks.changeLabels('AR', 'AR-1', { add: [WAITING] }, OWNER_ACTOR);

    const { inboxItemId } = await ask('Which font?');
    expect(questionPayloadOf(h.domain.inbox.get('AR', inboxItemId))?.autoLabel).toBeUndefined();
    await answer(inboxItemId);
    expect(labels()).toEqual([WAITING]);
  });

  it('is not put back when a person took it off while the question was open', async () => {
    await setup(withWaitingLabel);
    const { inboxItemId } = await ask('Which font?');
    await h.domain.tasks.changeLabels('AR', 'AR-1', { remove: [WAITING] }, OWNER_ACTOR);
    expect(labels()).toEqual([]);

    await answer(inboxItemId);
    expect(labels()).toEqual([]);
    expect(labelEvents().filter((event) => event.actor.kind === 'system')).toHaveLength(1);
  });

  it('holds the card back from moving forward until the question closes', async () => {
    await setup(withWaitingLabel);
    const { inboxItemId } = await ask('Which font?');

    const refused = await rejection(h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', OWNER_ACTOR));
    expect(refused.code).toBe('gate_blocked');
    expect(refused.details).toMatchObject({
      unmet: expect.arrayContaining([
        { stageId: 'code_review', condition: { type: 'lacks_label', label: WAITING } },
      ]),
    });

    await answer(inboxItemId);
    expect((await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', OWNER_ACTOR)).moved).toBe(true);
  });

  it('is not put on a card in a queue stage', async () => {
    await setup(withWaitingLabel);
    await h.domain.tasks.create('AR', { title: 'Later' }, OWNER_ACTOR);
    expect(h.domain.tasks.get('AR', 'AR-2').stageId).toBe('backlog');

    const { inboxItemId } = await ask('About the later card?', 'AR-2');
    expect(labels('AR-2')).toEqual([]);
    expect(questionPayloadOf(h.domain.inbox.get('AR', inboxItemId))?.autoLabel).toBeUndefined();
  });

  it('is not put on a card by a question about no card', async () => {
    await setup(withWaitingLabel);
    const general = { ...dev, taskKey: null };
    const { inboxItemId } = await h.domain.teamTools.askHuman(general, { question: 'In general?' });
    expect(labels()).toEqual([]);
    expect(questionPayloadOf(h.domain.inbox.get('AR', inboxItemId))?.autoLabel).toBeUndefined();
  });

  it('does nothing in a project that does not define the label', async () => {
    await setup();
    const { inboxItemId } = await ask('Which font?');
    expect(labels()).toEqual([]);
    expect(questionPayloadOf(h.domain.inbox.get('AR', inboxItemId))?.autoLabel).toBeUndefined();
    await answer(inboxItemId);
    expect(labels()).toEqual([]);
    expect(labelEvents()).toEqual([]);
  });

  it('comes off when the question is cancelled because its member was retired', async () => {
    await setup(withWaitingLabel);
    await ask('Which font?');
    expect(labels()).toEqual([WAITING]);

    await h.domain.members.retire('AR', 'dev-1', {}, { actor: OWNER_ACTOR, author: OWNER });
    expect(labels()).toEqual([]);
  });
});
