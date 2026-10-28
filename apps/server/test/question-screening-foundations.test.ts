import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { questionPayloadOf, QUESTION_SCREENING_MINUTES, turnStalled } from '@projectman/shared';
import type { InboxItem, ProjectConfig, TeamMessage } from '@projectman/shared';
import type { ToolContext } from '../src/contracts';
import { canSeeInboxItem } from '../src/core/projects';
import { wakeFactsFor } from '../src/core/messages';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

const WAITING = 'waiting-answer';
const owner = { handle: 'owner', access: 'owner' as const };

function withWaitingLabel(config: ProjectConfig): void {
  config.pipeline.labels.push({ id: WAITING, name: 'Waiting for an answer', setBy: 'anyone', blocks: true });
}

/**
 * The foundations of the Operator's screening of AI questions (PM-556, part 1): nobody creates a
 * `screening` item yet, so the tests put an asked question into that state by hand and check that every
 * reader that must see a pending question does, and that the closing and release write only where they
 * may.
 */
describe('a question the project manager screens: the foundations', () => {
  let h: DomainHarness;
  let dev: ToolContext;
  let sessionId: string;
  beforeEach(async () => {
    h = await createDomainHarness({ adjust: withWaitingLabel });
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
    const started = await h.domain.taskStarts.start('AR', 'AR-1', { actor: OWNER_ACTOR, author: OWNER });
    sessionId = started.session!.id;
    dev = { sessionId, projectKey: 'AR', member: 'dev-1', taskKey: 'AR-1' };
    await flush();
  });
  afterEach(async () => {
    await h.domain.stop();
    await h.cleanup();
  });

  async function ask(question = 'Which font?'): Promise<string> {
    const { inboxItemId } = await h.domain.teamTools.askHuman(dev, { question, options: ['Yes', 'No'] });
    return inboxItemId;
  }
  function screen(id: string): void {
    h.repos.db.prepare("UPDATE inbox_items SET state = 'screening' WHERE id = ?").run(id);
  }
  const item = (id: string) => h.domain.inbox.get('AR', id);
  const labels = () => h.domain.tasks.get('AR', 'AR-1').labels;
  const timelineOf = (type: string) =>
    h.domain.timeline.list('AR', { taskKey: 'AR-1' }).filter((event) => event.type === type);
  const typedInto = () => h.runner.messages.filter((m) => m.sessionId === sessionId).map((m) => m.text);

  describe('the store', () => {
    it('releases only an item in screening, with the new payload and options', async () => {
      const id = await ask();
      const at = '2026-10-13T10:00:00.000Z';
      const payload = { ...item(id).payload, screening: { until: at, outcome: 'todo' } };
      const options = [{ id: 'done', label: 'Done', style: 'primary' as const }];

      const original = item(id).options;

      expect(h.repos.inbox.release(id, { payload, options, at })).toBe(false);
      expect(item(id).options).toEqual(original);

      screen(id);
      expect(h.repos.inbox.countOpenFor('AR', 'owner')).toBe(0);
      expect(h.repos.inbox.release(id, { payload, options, at })).toBe(true);
      expect(item(id)).toMatchObject({ state: 'open', payload, options });
      expect(h.repos.inbox.countOpenFor('AR', 'owner')).toBe(1);
      expect(h.repos.inbox.release(id, { payload, options, at })).toBe(false);
    });

    it('closes an item in screening and leaves a decided one alone', async () => {
      const id = await ask();
      screen(id);
      const resolution = { optionId: 'closed', by: 'system', at: '2026-10-13T10:00:00.000Z', note: null };
      expect(h.repos.inbox.close(id, 'cancelled', resolution, resolution.at)?.state).toBe('cancelled');
      expect(h.repos.inbox.close(id, 'expired', resolution, resolution.at)).toBeNull();
      expect(item(id).state).toBe('cancelled');
    });

    it('lists by several states, and counts only open items as the member’s to answer', async () => {
      const open = await ask('Open?');
      const screened = await ask('Screened?');
      screen(screened);
      expect(h.repos.inbox.list('AR', { state: ['open', 'screening'] }).map((i) => i.id)).toEqual([
        open,
        screened,
      ]);
      expect(h.repos.inbox.list('AR', { state: 'screening' }).map((i) => i.id)).toEqual([screened]);
      expect(h.repos.inbox.list('AR', { state: 'open' }).map((i) => i.id)).toEqual([open]);
      expect(h.repos.inbox.countOpenFor('AR', 'owner')).toBe(1);
    });

    it('keeps an answered question by the Operator out of the decision candidates', async () => {
      const id = await ask();
      const at = '2026-10-13T10:00:00.000Z';
      const answered = (rule?: 'operator_answered') =>
        h.repos.inbox.close(
          id,
          'resolved',
          { optionId: 'answer', by: 'operator', at, note: 'Yes', ...(rule ? { rule } : {}) },
          at,
        );
      answered('operator_answered');
      expect(h.repos.inbox.listAnsweredQuestions('AR', '2026-10-13T09:00:00.000Z')).toEqual([]);

      const other = await ask('Another one?');
      h.repos.inbox.close(other, 'resolved', { optionId: 'answer', by: 'owner', at, note: 'Yes' }, at);
      expect(h.repos.inbox.listAnsweredQuestions('AR', '2026-10-13T09:00:00.000Z').map((i) => i.id)).toEqual([
        other,
      ]);
    });
  });

  describe('closing a pending question', () => {
    it('cancels it with the rule, writes the timeline and takes the waiting label off', async () => {
      const id = await ask();
      screen(id);
      expect(labels()).toEqual([WAITING]);

      const closed = await h.domain.inbox.closeQuestion(id, {
        rule: 'task_done',
        by: 'system',
        note: 'The card is Done.',
      });
      await flush();

      expect(closed).toMatchObject({
        state: 'cancelled',
        resolution: { optionId: 'closed', by: 'system', note: 'The card is Done.', rule: 'task_done' },
      });
      expect(timelineOf('question_closed')).toHaveLength(1);
      expect(timelineOf('question_closed')[0]).toMatchObject({
        actor: { kind: 'system' },
        data: { inboxItemId: id, asker: 'dev-1', rule: 'task_done', note: 'The card is Done.' },
      });
      expect(labels()).toEqual([]);
    });

    it('closes an open question too, attributing it to the member who closed it', async () => {
      const id = await ask();
      const closed = await h.domain.inbox.closeQuestion(id, { rule: 'withdrawn', by: 'dev-1', note: null });
      expect(closed?.resolution).toMatchObject({ by: 'dev-1', rule: 'withdrawn', note: null });
      expect(timelineOf('question_closed')[0]?.actor).toMatchObject({ kind: 'ai', handle: 'dev-1' });
    });

    it('does nothing to a decided question, a missing one or an item that is not a question', async () => {
      const id = await ask();
      await h.domain.inbox.resolve('AR', id, { optionId: 'option_1' }, owner);
      expect(
        await h.domain.inbox.closeQuestion(id, { rule: 'task_done', by: 'system', note: null }),
      ).toBeNull();
      expect(item(id).state).toBe('resolved');
      expect(
        await h.domain.inbox.closeQuestion('inb_nope', { rule: 'task_done', by: 'system', note: null }),
      ).toBeNull();

      const pending = h.domain.inbox
        .list('AR', { kind: 'permission' })
        .concat(h.domain.inbox.list('AR', { kind: 'alert' }));
      for (const other of pending)
        expect(
          await h.domain.inbox.closeQuestion(other.id, { rule: 'task_done', by: 'system', note: null }),
        ).toBeNull();
      expect(timelineOf('question_closed')).toEqual([]);
    });

    it('tells the running asking session why, without waking anything', async () => {
      const id = await ask('Which font?');
      screen(id);
      const before = typedInto().length;
      await h.domain.inbox.closeQuestion(id, { rule: 'handed_off', by: 'system', note: 'dev-2 took it.' });
      await flush();

      const added = typedInto().slice(before);
      expect(added).toHaveLength(1);
      expect(added[0]).toContain('Your question "Which font?" was closed');
      expect(added[0]).toContain('Do not wait for its answer.');
      expect(added[0]).toContain('dev-2 took it.');
    });

    it('tells nobody when the asking session no longer runs', async () => {
      const id = await ask('Which font?');
      await h.domain.sessions.stop('AR', sessionId);
      await flush();
      const before = h.runner.messages.length;

      await h.domain.inbox.closeQuestion(id, { rule: 'task_cancelled', by: 'system', note: null });
      await flush();
      expect(h.runner.messages).toHaveLength(before);
    });

    it('does not tell the session of an answer or of an ordinary cancel', async () => {
      const answered = await ask('First?');
      await h.domain.inbox.resolve('AR', answered, { optionId: 'option_1' }, owner);
      const cancelled = await ask('Second?');
      await flush();
      const before = typedInto().length;
      h.domain.inbox.cancel(cancelled);
      await flush();
      expect(
        typedInto()
          .slice(before)
          .filter((text) => text.includes('was closed')),
      ).toEqual([]);
    });
  });

  describe('the readers of pending questions', () => {
    it('keeps the waiting label while the question is screened', async () => {
      const id = await ask();
      screen(id);
      // Another question answered meanwhile does not take the label off: the screened one is pending.
      const second = await ask('Second?');
      await h.domain.inbox.resolve('AR', second, { optionId: 'option_1' }, owner);
      await flush();
      expect(labels()).toEqual([WAITING]);
    });

    it('lists it among the open questions of the card', async () => {
      const id = await ask('Which font?');
      screen(id);
      const questions = h.domain.cardQuestions.list('AR', 'AR-1', { limit: 6 });
      expect(questions).toMatchObject([{ inboxItemId: id, asker: 'dev-1', state: 'open' }]);
    });

    it('reports it in the project state as an open question', async () => {
      const id = await ask('Which font?');
      screen(id);
      const state = await h.domain.projectState.task('AR', 'AR-1');
      expect(state.openQuestions.map((q) => q.id)).toEqual([id]);
    });

    it('does not let the card refinement stall while the asking member waits', async () => {
      const id = await ask();
      screen(id);
      const config = await h.domain.projects.config('AR');
      const items = h.domain.inbox.list('AR', { taskKey: 'AR-1' });
      expect(turnStalled(items, config)).toBe(false);
    });

    it('is on no one’s list while screened: the card waits for it as its member working', async () => {
      const id = await ask();
      const config = await h.domain.projects.config('AR');
      const wait = () => h.domain.taskWaits.ofCard(config, h.domain.tasks.get('AR', 'AR-1'), 'owner');
      expect(wait()).toMatchObject({ reason: 'inbox', inboxItemId: id });

      screen(id);
      expect(wait()?.reason).toBe('working');
      expect(wait()?.inboxItemId).toBeNull();
    });
  });

  describe('who sees it', () => {
    it('shows a screened question to an owner and an admin only', async () => {
      const id = await ask();
      screen(id);
      const screened: InboxItem = item(id);
      expect(canSeeInboxItem({ handle: 'owner', access: 'owner' }, screened)).toBe(true);
      expect(canSeeInboxItem({ handle: 'boss', access: 'admin' }, screened)).toBe(true);
      expect(canSeeInboxItem({ handle: 'dev-human', access: 'developer' }, screened)).toBe(false);
      expect(canSeeInboxItem({ handle: 'owner-2', access: 'client' }, screened)).toBe(false);
    });

    it('does not change who sees an open item', async () => {
      const id = await ask();
      const open: InboxItem = item(id);
      expect(canSeeInboxItem({ handle: 'dev-human', access: 'developer' }, open)).toBe(true);
      expect(canSeeInboxItem({ handle: 'someone', access: 'client' }, open)).toBe(true);
      expect(canSeeInboxItem({ handle: 'owner', access: 'client' }, open)).toBe(true);
    });
  });

  describe('the people it concerns', () => {
    it('cancels a screened question of a member who leaves, like an open one', async () => {
      const id = await ask();
      screen(id);
      await h.domain.members.retire('AR', 'dev-1', {}, { actor: OWNER_ACTOR, author: OWNER });
      expect(item(id).state).toBe('cancelled');
      expect(labels()).toEqual([]);
    });

    it('gives a screened question to the owners when its only assignee is removed', async () => {
      const id = await ask();
      screen(id);
      h.domain.inbox.reassignRemovedHuman('AR', 'owner', ['boss']);
      expect(item(id).assignees).toEqual(['boss']);
    });
  });

  it('reads the screening fields of a stored question payload', async () => {
    const id = await ask();
    const payload = {
      ...item(id).payload,
      screening: { until: '2026-10-13T10:10:00.000Z', fallback: 'timeout' },
    };
    h.repos.db.prepare('UPDATE inbox_items SET payload = ? WHERE id = ?').run(JSON.stringify(payload), id);
    expect(questionPayloadOf(item(id))?.screening?.fallback).toBe('timeout');
    expect(QUESTION_SCREENING_MINUTES).toBe(10);
  });
});

describe('the wake of an answer or a forwarded question', () => {
  let h: DomainHarness;
  afterEach(() => h.cleanup());

  const message = (origin: TeamMessage['origin'], from = 'operator'): TeamMessage =>
    ({ from, to: ['dev-2'], taskKey: 'AR-1', origin }) as TeamMessage;

  it('flags a message that answers or forwards a question, and nothing else', async () => {
    h = await createDomainHarness();
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
    const config = await h.domain.projects.config('AR');
    const facts = (origin: TeamMessage['origin']) =>
      wakeFactsFor(h.domain.ctx, config, message(origin), 'dev-2');

    expect(facts({ kind: 'answer', inboxItemId: 'inb_1' }).answersQuestion).toBe(true);
    expect(facts({ kind: 'question_forward', inboxItemId: 'inb_1' }).answersQuestion).toBe(true);
    expect(facts({ kind: 'note', eventId: 'evt_1' }).answersQuestion).toBe(false);
    expect(facts(undefined).answersQuestion).toBe(false);
  });
});
