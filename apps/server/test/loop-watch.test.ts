import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loopDecisionOf } from '@projectman/shared';
import type { InboxItem, ProjectConfig, TimelineEvent } from '@projectman/shared';
import { aiActor } from '../src/domain';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { settle } from './helpers/fakes';

/**
 * The loop watch (PM-261): AI members writing to each other on a card without progress. The first to
 * hear of it is the AI member who holds the scheduling duty (`pm`); people get a decision only when
 * that did not help or nobody holds the duty. Card AR-1 starts in `backlog`; three counted messages
 * in thirty minutes make a loop here.
 */

const MINUTE = 60_000;
const OWNER_ACCESS = { handle: 'owner', access: 'owner' } as const;

describe('loop watch', () => {
  let h: DomainHarness;
  let now: Date;

  const setup =
    (opts: { scheduler?: boolean; watch?: { enabled: boolean } } = {}) =>
    (config: ProjectConfig) => {
      config.team.limits.maxConcurrentAi = 10;
      config.team.limits.loopWatch = { enabled: opts.watch?.enabled ?? true, count: 3, minutes: 30 };
      config.pipeline.labels.push({ id: 'tag', name: 'Tag', setBy: 'anyone' });
      if (opts.scheduler ?? true)
        config.team.members.push({
          kind: 'ai',
          handle: 'pm',
          displayName: 'PM',
          role: 'project_manager',
          sponsor: 'owner',
        } as ProjectConfig['team']['members'][number]);
    };

  async function prepare(opts: Parameters<typeof setup>[0] = {}) {
    now = new Date('2026-10-01T12:00:00.000Z');
    h = await createDomainHarness({ now: () => now, adjust: setup(opts) });
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
    await h.domain.tasks.create('AR', { title: 'Other card' }, OWNER_ACTOR);
    tick(1);
  }
  afterEach(() => h?.cleanup());

  const tick = (minutes: number) => {
    now = new Date(now.getTime() + minutes * MINUTE);
  };
  /** A team message among members, as the messaging service records it, a minute after the last step. */
  async function talk(from: string, to: string[], taskKey = 'AR-1'): Promise<TimelineEvent> {
    const event = h.domain.timeline.append({
      projectKey: 'AR',
      taskKey,
      actor: from === 'owner' ? OWNER_ACTOR : aiActor(from),
      type: 'team_message',
      data: { messageId: `msg-${now.getTime()}`, from, to, excerpt: 'Please look.' },
    });
    await settle();
    tick(1);
    return event;
  }
  /** Three messages round the developers and the reviewer: a loop. */
  async function goRound(taskKey = 'AR-1') {
    await talk('dev-1', ['cr'], taskKey);
    await talk('cr', ['dev-1'], taskKey);
    await talk('dev-1', ['cr'], taskKey);
  }
  const loop = () => h.repos.taskLoops.open('AR-1');
  const items = (): InboxItem[] => h.domain.inbox.list('AR', { kind: 'decision', taskKey: 'AR-1' });
  const loopEvents = () =>
    h.repos.timeline.list('AR', { taskKey: 'AR-1' }).filter((event) => event.type === 'task_loop');
  const firstInputs = () => h.runner.started.map((spec) => spec.initialMessage ?? '');

  describe('finding a loop', () => {
    beforeEach(() => prepare());

    it('tells the scheduler once, without storing a message, and marks the card', async () => {
      await goRound();
      await vi.waitFor(() => expect(loop()).not.toBeNull());
      expect(loop()).toMatchObject({
        phase: 'notified',
        notified: 'pm',
        count: 3,
        members: ['cr', 'dev-1'],
      });
      expect(items()).toEqual([]);
      await vi.waitFor(() =>
        expect(firstInputs().some((text) => text.includes('[team message from projectman about AR-1]'))).toBe(
          true,
        ),
      );
      expect(h.runner.started.some((spec) => spec.member === 'pm')).toBe(true);
      // The notice is not a team message: only the three of the loop are stored.
      const stored = h.repos.timeline
        .list('AR', { taskKey: 'AR-1' })
        .filter((event) => event.type === 'team_message');
      expect(stored).toHaveLength(3);
      expect(loopEvents().map((event) => event.data)).toMatchObject([
        { phase: 'raised', notified: 'pm', count: 3, minutes: 30, members: ['cr', 'dev-1'] },
      ]);
      expect(h.domain.tasks.get('AR', 'AR-1').loop).toMatchObject({ phase: 'notified', notified: 'pm' });
      expect(h.domain.tasks.get('AR', 'AR-2').loop).toBeUndefined();
    });

    it('holds the notice while the team is paused (PM-219), and tells the scheduler once it is resumed', async () => {
      const by = { userId: null, source: 'system' } as const;
      await h.domain.pauses.pause({ scope: 'project', projectKey: 'AR' }, by);
      await goRound();
      await vi.waitFor(() =>
        expect(
          h.repos.deferredStarts.list().map((record) => (record.spec as { kind: string }).kind),
        ).toContain('loop_notice'),
      );
      expect(h.runner.started).toEqual([]);
      await h.domain.pauses.resume({ scope: 'project', projectKey: 'AR' }, by);
      await vi.waitFor(() => expect(h.runner.started.some((spec) => spec.member === 'pm')).toBe(true));
    });

    it('does not count notes, people, messages to people or one member writing alone', async () => {
      await talk('owner', ['dev-1']);
      await talk('dev-1', ['owner']);
      await talk('dev-1', ['cr', 'owner']);
      await h.domain.tasks.addNote('AR', 'AR-1', 'Update', OWNER_ACTOR);
      await h.domain.tasks.addNote('AR', 'AR-1', 'Update', aiActor('dev-1'));
      await talk('dev-1', ['cr']);
      await talk('dev-1', ['cr']);
      await talk('dev-1', ['dev-2']);
      expect(loop()).toBeNull();
      expect(firstInputs()).toEqual([]);
    });

    it('does not count messages on other cards or older than the window', async () => {
      await talk('dev-1', ['cr']);
      await talk('cr', ['dev-1']);
      tick(31);
      await talk('dev-1', ['cr']);
      await talk('cr', ['dev-1'], 'AR-2');
      expect(loop()).toBeNull();
    });

    it('counts again only what comes after a loop ended', async () => {
      await goRound();
      await vi.waitFor(() => expect(loop()).not.toBeNull());
      await h.domain.tasks.update('AR', 'AR-1', { addLabels: ['tag'] }, OWNER_ACTOR);
      await vi.waitFor(() => expect(loop()).toBeNull());
      tick(1);
      await talk('cr', ['dev-1']);
      expect(loop()).toBeNull();
      await talk('dev-1', ['cr']);
      await talk('cr', ['dev-1']);
      await vi.waitFor(() => expect(loop()).not.toBeNull());
    });

    it('finds no loop when the branch got a commit after the first messages', async () => {
      vi.spyOn(h.domain.sessions, 'sourceHead').mockResolvedValue({
        commit: 'c1',
        branch: 'task/AR-1',
        dirty: false,
        changes: 0,
        path: '/fake/worktree',
        committedAt: new Date(now.getTime() + MINUTE).toISOString(),
      });
      await talk('dev-1', ['cr']);
      await talk('cr', ['dev-1']);
      tick(1);
      await talk('dev-1', ['cr']);
      expect(loop()).toBeNull();
      await talk('cr', ['dev-1']);
      await talk('dev-1', ['cr']);
      await vi.waitFor(() => expect(loop()).toMatchObject({ count: 3, headCommit: 'c1' }));
    });
  });

  describe('when the scheduler cannot be told', () => {
    it('goes to the owner at once when nobody holds the duty', async () => {
      await prepare({ scheduler: false });
      await goRound();
      await vi.waitFor(() => expect(items()).toHaveLength(1));
      const [item] = items();
      expect(item).toMatchObject({
        kind: 'decision',
        state: 'open',
        assignees: ['owner'],
        taskKey: 'AR-1',
        options: [
          { id: 'stop_work', style: 'danger' },
          { id: 'let_run', style: 'secondary' },
        ],
      });
      expect(loopDecisionOf(item!)).toMatchObject({
        taskKey: 'AR-1',
        members: ['cr', 'dev-1'],
        count: 3,
        minutes: 30,
        reason: 'no_watcher',
        watcher: null,
      });
      expect(loop()).toMatchObject({ phase: 'owner', ownerReason: 'no_watcher', inboxItemId: item!.id });
      expect(h.runner.started).toEqual([]);
    });

    it('goes to the owner when admission refuses the scheduler for good, and says nobody was told', async () => {
      await prepare();
      vi.spyOn(h.domain.admission, 'start').mockRejectedValue(new Error('the session cannot start'));
      await goRound();
      await vi.waitFor(() => expect(items()).toHaveLength(1));
      expect(loopDecisionOf(items()[0]!)).toMatchObject({ reason: 'no_watcher', watcher: null });
      expect(loop()).toMatchObject({ phase: 'owner', ownerReason: 'no_watcher', notified: null });
      expect(loopEvents().map((event) => event.data)).toMatchObject([{ phase: 'raised', notified: null }]);
      expect(h.domain.tasks.get('AR', 'AR-1').loop).toMatchObject({ phase: 'owner', notified: null });
    });
  });

  describe('when admission only makes the scheduler wait', () => {
    const switchAi = (aiEnabled: boolean) =>
      h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (config) => {
        config.team.limits.aiEnabled = aiEnabled;
        return 'Switch AI';
      });

    it('keeps the loop with the scheduler, raises no item, and tells it once there is room', async () => {
      await prepare();
      await switchAi(false);
      await goRound();
      await vi.waitFor(() => expect(loop()).not.toBeNull());
      await settle();
      // Not told yet: no decision, no "raised" event, and the loop still belongs to the scheduler.
      expect(items()).toEqual([]);
      expect(loop()).toMatchObject({ phase: 'notified', notified: 'pm', notifiedCount: 0 });
      expect(loopEvents()).toEqual([]);
      expect(h.runner.started).toEqual([]);

      // Messages meanwhile do not count as "went on after the notice".
      await talk('dev-1', ['cr']);
      await talk('cr', ['dev-1']);
      await talk('dev-1', ['cr']);
      await talk('cr', ['dev-1']);
      expect(items()).toEqual([]);
      expect(loop()).toMatchObject({ phase: 'notified', count: 7 });

      await switchAi(true);
      await vi.waitFor(() => expect(h.runner.started.some((spec) => spec.member === 'pm')).toBe(true));
      await vi.waitFor(() => expect(loop()).toMatchObject({ notified: 'pm', notifiedCount: 7 }));
      expect(items()).toEqual([]);
      expect(loopEvents().map((event) => event.data)).toMatchObject([{ phase: 'raised', notified: 'pm' }]);
    });

    it('drops the waiting notice when the loop ends first', async () => {
      await prepare();
      await switchAi(false);
      await goRound();
      await vi.waitFor(() => expect(loop()).not.toBeNull());
      await h.domain.tasks.update('AR', 'AR-1', { addLabels: ['tag'] }, OWNER_ACTOR);
      await vi.waitFor(() => expect(loop()).toBeNull());
      await switchAi(true);
      await settle();
      expect(h.runner.started).toEqual([]);
      expect(items()).toEqual([]);
    });
  });

  describe('when the loop goes on after the scheduler was told', () => {
    beforeEach(async () => {
      await prepare();
      await goRound();
      await vi.waitFor(() => expect(loop()).not.toBeNull());
    });

    it('does not count the scheduler, and escalates after as many messages again', async () => {
      await talk('pm', ['dev-1', 'cr']);
      await talk('cr', ['pm']);
      await talk('pm', ['dev-1']);
      expect(items()).toEqual([]);
      expect(loop()).toMatchObject({ phase: 'notified', count: 3 });

      await talk('dev-1', ['cr']);
      await talk('cr', ['dev-1']);
      expect(items()).toEqual([]);
      await talk('dev-1', ['cr']);
      await vi.waitFor(() => expect(items()).toHaveLength(1));
      expect(loopDecisionOf(items()[0]!)).toMatchObject({ reason: 'continued', watcher: 'pm', count: 6 });
      expect(loop()).toMatchObject({ phase: 'owner', ownerReason: 'continued', deciders: ['owner'] });
      expect(loopEvents().map((event) => event.data.phase)).toEqual(['raised', 'escalated']);

      // Further messages feed the loop but raise no second item.
      await talk('cr', ['dev-1']);
      await talk('dev-1', ['cr']);
      await talk('cr', ['dev-1']);
      expect(items()).toHaveLength(1);
      expect(loop()!.count).toBe(9);
    });
  });

  describe('the decision', () => {
    beforeEach(async () => {
      await prepare({ scheduler: false });
      await goRound();
      await vi.waitFor(() => expect(items()).toHaveLength(1));
    });
    const resolve = (optionId: string) =>
      h.domain.inbox.resolve('AR', items()[0]!.id, { optionId }, OWNER_ACCESS);

    it("stop_work stops the card's sessions and ends the loop", async () => {
      const stop = vi.spyOn(h.domain.sessions, 'stopTask').mockResolvedValue();
      await resolve('stop_work');
      await vi.waitFor(() => expect(loop()).toBeNull());
      expect(stop).toHaveBeenCalledWith('AR', 'AR-1', {
        kind: 'loop_stopped',
        by: { kind: 'human', handle: 'owner' },
      });
      expect(items()[0]).toMatchObject({
        state: 'resolved',
        resolution: { optionId: 'stop_work', by: 'owner' },
      });
      expect(loopEvents().at(-1)!.data).toMatchObject({ phase: 'ended', endReason: 'stopped', by: 'owner' });
      expect(h.domain.tasks.get('AR', 'AR-1').loop).toBeUndefined();
    });

    it('let_run ends the loop at once, and only new talk with no progress raises another (PM-431)', async () => {
      const stop = vi.spyOn(h.domain.sessions, 'stopTask').mockResolvedValue();
      await resolve('let_run');
      await vi.waitFor(() => expect(loop()).toBeNull());
      expect(stop).not.toHaveBeenCalled();
      expect(loopEvents().at(-1)!.data).toMatchObject({ phase: 'ended', endReason: 'let_run', by: 'owner' });
      expect(h.domain.tasks.get('AR', 'AR-1').loop).toBeUndefined();
      expect(items()).toHaveLength(1);

      // The messages before the decision do not count again: two more are not a loop, three are.
      tick(1);
      await talk('dev-1', ['cr']);
      await talk('cr', ['dev-1']);
      expect(loop()).toBeNull();
      await talk('dev-1', ['cr']);
      await vi.waitFor(() => expect(loop()).not.toBeNull());
      expect(loop()).toMatchObject({ count: 3 });
      expect(h.domain.tasks.get('AR', 'AR-1').loop).toBeDefined();
    });
  });

  describe('when a loop is over', () => {
    const open = async (opts: Parameters<typeof setup>[0] = { scheduler: false }) => {
      await prepare(opts);
      await goRound();
      await vi.waitFor(() => expect(loop()).not.toBeNull());
    };
    const endedWith = () => loopEvents().at(-1)!.data;

    it('closes on a label change and closes its item by the system', async () => {
      await open();
      const item = items()[0]!;
      await h.domain.tasks.update('AR', 'AR-1', { addLabels: ['tag'] }, OWNER_ACTOR);
      await vi.waitFor(() => expect(loop()).toBeNull());
      expect(endedWith()).toMatchObject({ phase: 'ended', endReason: 'label' });
      expect(h.domain.inbox.get('AR', item.id)).toMatchObject({
        state: 'resolved',
        resolution: { optionId: 'ended', by: 'system', rule: 'loop_ended' },
      });
    });

    it('closes when the card changes stage', async () => {
      await open({ scheduler: true });
      await h.domain.tasks.moveToStage('AR', 'AR-1', 'development', OWNER_ACTOR);
      await vi.waitFor(() => expect(loop()).toBeNull());
      expect(endedWith()).toMatchObject({ endReason: 'stage' });
    });

    describe('when work is recorded on the card (PM-431)', () => {
      const work: Record<string, () => Promise<unknown>> = {
        'a note': () => h.domain.tasks.addNote('AR', 'AR-1', 'Hero copy, take two.', aiActor('dev-1')),
        'a new description': () =>
          h.domain.tasks.update(
            'AR',
            'AR-1',
            { description: 'The hero cards read better now.' },
            OWNER_ACTOR,
          ),
        'an attachment': async () =>
          h.domain.timeline.append({
            projectKey: 'AR',
            taskKey: 'AR-1',
            actor: aiActor('dev-1'),
            type: 'attachment_added',
            data: { attachmentId: 'att_1', fileName: 'sketch.png', size: 10, mediaType: 'image/png' },
          }),
      };

      for (const [name, record] of Object.entries(work)) {
        it(`closes on ${name}, and the count starts again`, async () => {
          await open();
          tick(1);
          await record();
          await vi.waitFor(() => expect(loop()).toBeNull());
          expect(endedWith()).toMatchObject({ phase: 'ended', endReason: 'work' });
          tick(1);
          await talk('dev-1', ['cr']);
          await talk('cr', ['dev-1']);
          expect(loop()).toBeNull();
          await talk('dev-1', ['cr']);
          await vi.waitFor(() => expect(loop()).not.toBeNull());
        });

        it(`does not count the messages before ${name} when it comes before the third`, async () => {
          await prepare();
          await talk('dev-1', ['cr']);
          await talk('cr', ['dev-1']);
          await record();
          await settle();
          tick(1);
          await talk('dev-1', ['cr']);
          expect(loop()).toBeNull();
        });
      }

      it('does not take an imported comment for work', async () => {
        await open();
        tick(1);
        await h.domain.tasks.addNote('AR', 'AR-1', 'Old history', OWNER_ACTOR, null, {
          importedAuthor: 'Someone',
          importedAt: '2025-01-01T00:00:00.000Z',
        });
        await settle();
        expect(loop()).not.toBeNull();
      });
    });

    it('closes when the card is cancelled', async () => {
      await open();
      await h.domain.tasks.cancel('AR', 'AR-1', {}, OWNER_ACTOR);
      await vi.waitFor(() => expect(loop()).toBeNull());
      expect(endedWith()).toMatchObject({ endReason: 'closed' });
    });

    it('closes when the branch got a commit', async () => {
      await open();
      const head = {
        commit: 'c2',
        branch: 'task/AR-1',
        dirty: false,
        changes: 0,
        path: '/fake/worktree',
        committedAt: now.toISOString(),
      };
      const read = vi.spyOn(h.domain.sessions, 'sourceHead').mockResolvedValue(null);
      await h.domain.loopWatch.sweep();
      expect(loop()).not.toBeNull();
      read.mockResolvedValue(head);
      await h.domain.loopWatch.sweep();
      expect(loop()).toBeNull();
      expect(endedWith()).toMatchObject({ endReason: 'commit' });
    });

    it('closes when nobody wrote for a whole window', async () => {
      await open();
      tick(20);
      await h.domain.loopWatch.sweep();
      expect(loop()).not.toBeNull();
      tick(15);
      await h.domain.loopWatch.sweep();
      expect(loop()).toBeNull();
      expect(endedWith()).toMatchObject({ endReason: 'quiet' });
      expect(items()[0]).toMatchObject({ state: 'resolved', resolution: { rule: 'loop_ended' } });
    });

    it('closes when the watch is switched off, and finds nothing while it is off', async () => {
      await open();
      await h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (config) => {
        config.team.limits.loopWatch = { enabled: false, count: 3, minutes: 30 };
        return 'Switch the loop watch off';
      });
      await vi.waitFor(() => expect(loop()).toBeNull());
      expect(endedWith()).toMatchObject({ endReason: 'disabled' });
      await goRound();
      expect(loop()).toBeNull();
    });
  });
});
