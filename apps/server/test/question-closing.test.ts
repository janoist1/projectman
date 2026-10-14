import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InboxItem, ProjectConfig } from '@projectman/shared';
import type { ToolContext } from '../src/contracts';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush, settle } from './helpers/fakes';
import { aiActor, SYSTEM_ACTOR } from '../src/kernel';

const WAITING = 'waiting-answer';

function withWaitingLabel(config: ProjectConfig): void {
  // Not blocking here, so that the card can reach Done while it carries the label; the real one blocks moves.
  config.pipeline.labels.push({ id: WAITING, name: 'Waiting for an answer', setBy: 'anyone', blocks: false });
}

/**
 * A question that became moot closes by itself (PM-556, part 3): the card is done or cancelled, or the
 * member who asked no longer holds it. AR-1 is carried by `dev-1`, who has a running session.
 */
describe('a question that became moot', () => {
  let h: DomainHarness;
  let sessionId: string;
  beforeEach(async () => {
    h = await createDomainHarness({ adjust: withWaitingLabel });
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
    const started = await h.domain.taskStarts.start('AR', 'AR-1', { actor: OWNER_ACTOR, author: OWNER });
    sessionId = started.session!.id;
    await flush();
  });
  afterEach(async () => {
    await h.domain.stop();
    await h.cleanup();
  });

  const as = (member: string, taskKey = 'AR-1'): ToolContext => ({
    sessionId,
    projectKey: 'AR',
    member,
    taskKey,
  });

  async function ask(member = 'dev-1', taskKey = 'AR-1', question = 'Which font?'): Promise<string> {
    const { inboxItemId } = await h.domain.teamTools.askHuman(as(member, taskKey), {
      question,
      options: ['Yes', 'No'],
    });
    return inboxItemId;
  }
  const screen = (id: string) =>
    h.repos.db.prepare("UPDATE inbox_items SET state = 'screening' WHERE id = ?").run(id);
  const item = (id: string): InboxItem => h.domain.inbox.get('AR', id);
  const labels = (key = 'AR-1') => h.domain.tasks.get('AR', key).labels;
  const closedEvents = (taskKey = 'AR-1') =>
    h.domain.timeline.list('AR', { taskKey }).filter((event) => event.type === 'question_closed');
  const typedInto = () => h.runner.messages.filter((m) => m.sessionId === sessionId).map((m) => m.text);

  function expectClosed(id: string, rule: string, by = 'system', note: string | null = null): void {
    expect(item(id)).toMatchObject({
      state: 'cancelled',
      resolution: { optionId: 'closed', by, note, rule },
    });
    expect(closedEvents(item(id).taskKey!).map((event) => event.data)).toContainEqual(
      expect.objectContaining({ inboxItemId: id, asker: item(id).source, rule, note }),
    );
  }

  describe('the card is done or cancelled', () => {
    it('closes an open and a screened question when the card is done, and takes the waiting label off', async () => {
      const open = await ask('dev-1', 'AR-1', 'Open one?');
      const screened = await ask('dev-1', 'AR-1', 'Screened one?');
      screen(screened);
      expect(labels()).toEqual([WAITING]);

      // The gates of the stages the move to done passes: the review, the merge and the release.
      const { tasks } = h.domain;
      await tasks.changeLabels('AR', 'AR-1', { add: ['code-review-ok'] }, aiActor('cr'));
      await tasks.changeLabels('AR', 'AR-1', { add: ['merge-ok', 'release-ok'] }, OWNER_ACTOR);
      await tasks.changeLabels('AR', 'AR-1', { add: ['pr-merged'] }, SYSTEM_ACTOR);
      await tasks.moveToStage('AR', 'AR-1', 'done', OWNER_ACTOR);
      await flush();

      expect(h.domain.tasks.get('AR', 'AR-1').status).toBe('done');
      expectClosed(open, 'task_done');
      expectClosed(screened, 'task_done');
      expect(labels()).not.toContain(WAITING);
    });

    it('closes an open and a screened question when the card is cancelled', async () => {
      const open = await ask('dev-1', 'AR-1', 'Open one?');
      const screened = await ask('dev-1', 'AR-1', 'Screened one?');
      screen(screened);

      await h.domain.tasks.cancel('AR', 'AR-1', { reason: 'Fictional scope changed.' }, OWNER_ACTOR);
      await flush();

      expectClosed(open, 'task_cancelled');
      expectClosed(screened, 'task_cancelled');
      expect(labels()).toEqual([]);
    });

    it('closes the questions of every asker on the card but leaves other cards alone', async () => {
      await h.domain.tasks.create('AR', { title: 'Another card' }, OWNER_ACTOR);
      const mine = await ask('dev-1');
      const other = await ask('dev-2');
      const elsewhere = await ask('dev-1', 'AR-2');

      await h.domain.tasks.cancel('AR', 'AR-1', {}, OWNER_ACTOR);
      await flush();

      expectClosed(mine, 'task_cancelled');
      expectClosed(other, 'task_cancelled');
      expect(item(elsewhere).state).toBe('open');
      expect(closedEvents('AR-2')).toEqual([]);
    });

    it('tells the running asking session why the question closed', async () => {
      // Not on AR-1, whose sessions end with a cancel: the asking session of AR-2 goes on running.
      await h.domain.tasks.create('AR', { title: 'Second card' }, OWNER_ACTOR);
      const id = await ask('dev-1', 'AR-2', 'Which font?');
      const before = typedInto().length;
      await h.domain.tasks.cancel('AR', 'AR-2', {}, OWNER_ACTOR);
      await settle();

      const added = typedInto().slice(before);
      expect(added.some((text) => text.includes('Your question "Which font?" was closed'))).toBe(true);
      expect(item(id).state).toBe('cancelled');
    });

    it('leaves an answered question as it is', async () => {
      const id = await ask();
      await h.domain.inbox.resolve('AR', id, { optionId: 'option_1' }, { handle: 'owner', access: 'owner' });
      await h.domain.tasks.cancel('AR', 'AR-1', {}, OWNER_ACTOR);
      await flush();
      expect(item(id).state).toBe('resolved');
      expect(closedEvents()).toEqual([]);
    });
  });

  describe('the card changes its assignee', () => {
    it('closes the previous assignee’s question as handed_off while a handoff from them is open', async () => {
      const open = await ask('dev-1', 'AR-1', 'Open one?');
      const screened = await ask('dev-1', 'AR-1', 'Screened one?');
      screen(screened);
      expect(labels()).toEqual([WAITING]);

      await h.domain.tasks.update('AR', 'AR-1', { assignee: 'dev-2' }, OWNER_ACTOR);
      await flush();

      // The handoff from dev-1 ran when the questions closed.
      expect(h.repos.taskHandoffs.latestClosed('AR-1')?.from).toBe('dev-1');
      expectClosed(open, 'handed_off');
      expectClosed(screened, 'handed_off');
      expect(labels()).toEqual([]);
    });

    it('closes it as assignee_changed when no handoff runs', async () => {
      await h.domain.tasks.create('AR', { title: 'Second card' }, OWNER_ACTOR);
      h.domain.tasks.assign('AR', 'AR-2', 'dev-1', OWNER_ACTOR);
      expect(h.repos.taskHandoffs.open('AR-2')).toBeNull();
      const id = await ask('dev-1', 'AR-2');

      await h.domain.tasks.update('AR', 'AR-2', { assignee: 'dev-2' }, OWNER_ACTOR);
      await flush();

      expect(h.repos.taskHandoffs.open('AR-2')).toBeNull();
      expectClosed(id, 'assignee_changed');
    });

    it('closes only the previous assignee’s questions, not those of other askers', async () => {
      const previous = await ask('dev-1');
      const other = await ask('dev-2');

      await h.domain.tasks.update('AR', 'AR-1', { assignee: 'owner' }, OWNER_ACTOR);
      await flush();

      expectClosed(previous, 'handed_off');
      expect(item(other).state).toBe('open');
      expect(labels()).toEqual([WAITING]);
    });

    it('leaves the new assignee’s own earlier question open', async () => {
      const id = await ask('dev-2');
      await h.domain.tasks.update('AR', 'AR-1', { assignee: 'dev-2' }, OWNER_ACTOR);
      await flush();
      expect(item(id).state).toBe('open');
    });

    it('does not close anything for a first assignment', async () => {
      await h.domain.tasks.create('AR', { title: 'Second card' }, OWNER_ACTOR);
      const id = await ask('dev-1', 'AR-2');
      await h.domain.tasks.update('AR', 'AR-2', { assignee: 'dev-2' }, OWNER_ACTOR);
      await flush();
      // AR-2 had no assignee before: there was nobody whose questions could be moot.
      expect(item(id).state).toBe('open');
    });
  });

  describe('the end of a session', () => {
    it('does not close the question', async () => {
      const id = await ask();
      h.runner.emit({ type: 'exit', sessionId, exitCode: 0, signal: null });
      await flush();
      expect(item(id).state).toBe('open');
      expect(closedEvents()).toEqual([]);
    });
  });

  describe('withdraw_question', () => {
    it('closes the asker’s own open or screened question with the reason and the caller as closer', async () => {
      const open = await ask('dev-1', 'AR-1', 'Open one?');
      const screened = await ask('dev-1', 'AR-1', 'Screened one?');
      screen(screened);
      expect(labels()).toEqual([WAITING]);

      for (const id of [open, screened]) {
        await expect(
          h.domain.teamTools.withdrawQuestion(as('dev-1'), { itemId: id, reason: 'Decided elsewhere.' }),
        ).resolves.toEqual({ itemId: id });
        expectClosed(id, 'withdrawn', 'dev-1', 'Decided elsewhere.');
      }
      await flush();
      expect(labels()).toEqual([]);
      expect(closedEvents().every((event) => event.actor.kind === 'ai')).toBe(true);
    });

    it('answers not_found for a question that does not exist, is not a question or is in another project', async () => {
      await expect(
        h.domain.teamTools.withdrawQuestion(as('dev-1'), { itemId: 'inb_nope', reason: 'Moot.' }),
      ).rejects.toMatchObject({ code: 'not_found' });

      const permission = h.domain.inbox.list('AR', { kind: 'permission' })[0];
      if (permission)
        await expect(
          h.domain.teamTools.withdrawQuestion(as('dev-1'), { itemId: permission.id, reason: 'Moot.' }),
        ).rejects.toMatchObject({ code: 'not_found' });

      const id = await ask();
      await expect(
        h.domain.teamTools.withdrawQuestion(
          { ...as('dev-1'), projectKey: 'OTHER' },
          { itemId: id, reason: 'x' },
        ),
      ).rejects.toBeTruthy();
      expect(item(id).state).toBe('open');
    });

    it('refuses forbidden not_your_question to anyone but the asker', async () => {
      const id = await ask('dev-1');
      const error = await h.domain.teamTools
        .withdrawQuestion(as('dev-2'), { itemId: id, reason: 'Not mine, but moot.' })
        .catch((err: unknown) => err);
      expect(error).toMatchObject({ code: 'forbidden' });
      expect((error as Error).message).toMatch(/^not_your_question:/);
      expect(item(id).state).toBe('open');
    });

    it('refuses invalid question_closed once the question is not pending any more', async () => {
      const answered = await ask('dev-1', 'AR-1', 'Answered one?');
      await h.domain.inbox.resolve(
        'AR',
        answered,
        { optionId: 'option_1' },
        { handle: 'owner', access: 'owner' },
      );
      const withdrawn = await ask('dev-1', 'AR-1', 'Withdrawn one?');
      await h.domain.teamTools.withdrawQuestion(as('dev-1'), { itemId: withdrawn, reason: 'Moot.' });

      for (const id of [answered, withdrawn]) {
        const error = await h.domain.teamTools
          .withdrawQuestion(as('dev-1'), { itemId: id, reason: 'Again.' })
          .catch((err: unknown) => err);
        expect(error).toMatchObject({ code: 'invalid' });
        expect((error as Error).message).toMatch(/^question_closed:/);
      }
      expect(item(answered).state).toBe('resolved');
    });
  });
});
