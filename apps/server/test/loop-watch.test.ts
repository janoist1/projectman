import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loopDecisionOf } from '@projectman/shared';
import type { InboxItem, ProjectConfig, TimelineEvent } from '@projectman/shared';
import { aiActor } from '../src/kernel';
import {
  createDomainHarness,
  restartDomainHarness,
  OWNER,
  OWNER_ACTOR,
  waitForSession,
} from './helpers/domain-harness';
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
      // The test template's project manager (PM-429) is the scheduler; it is on leave, which leaves none.
      const manager = config.team.members.find((m) => m.handle === 'pm');
      if (manager?.kind === 'ai' && (opts.scheduler ?? true)) delete manager.onLeave;
    };

  async function prepare(opts: Parameters<typeof setup>[0] = {}, persistent = false) {
    now = new Date('2026-10-01T12:00:00.000Z');
    h = await createDomainHarness({ now: () => now, adjust: setup(opts), persistent });
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
  const signal = () => h.repos.operatorSignals.get(loop()!.triage!.pendingSignalId!);
  const pmContext = () => ({
    projectKey: 'AR',
    member: 'pm',
    taskKey: null,
    sessionId: h.domain.sessions
      .list('AR', { member: 'pm' })
      .find((s) => s.workItem.type === 'general' && !s.workItem.with)!.id,
  });
  const assess = (outcome: 'progress' | 'loop', evidenceIds: string[] = []) =>
    h.domain.teamTools.triageLoop(pmContext(), {
      signalId: signal()!.id,
      outcome,
      note: 'Checked current review findings and delivery.',
      evidenceIds,
    });

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
        expect(firstInputs().some((text) => text.includes('loop_suspected'))).toBe(true),
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
        ).toContain('operator_signals'),
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

    it('falls back once when AI work is disabled', async () => {
      await prepare();
      await h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (config) => {
        config.team.limits.aiEnabled = false;
        return 'Disable AI';
      });
      await goRound();
      await h.domain.loopWatch.sweep();
      expect(items()).toHaveLength(1);
      expect(loop()!.ownerReason).toBe('no_watcher');
    });

    it('falls back when the signal cannot be stored', async () => {
      await prepare();
      vi.spyOn(h.repos.operatorSignals, 'insert').mockImplementation(() => {
        throw new Error('storage failed');
      });
      await goRound();
      expect(items()).toHaveLength(1);
      expect(loop()!.ownerReason).toBe('no_watcher');
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
    const switchAi = (enabled: boolean) =>
      h.domain.pauses[enabled ? 'resume' : 'pause'](
        { scope: 'project', projectKey: 'AR' },
        { userId: null, source: 'system' },
      );

    it('keeps the loop with the scheduler, raises no item, and tells it once there is room', async () => {
      await prepare();
      await switchAi(false);
      await goRound();
      await vi.waitFor(() => expect(loop()).not.toBeNull());
      await settle();
      // Not told yet: no decision, no "raised" event, and the loop still belongs to the scheduler.
      expect(items()).toEqual([]);
      expect(loop()).toMatchObject({ phase: 'notified', notified: null, notifiedCount: 0 });
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
      await h.domain.loopWatch.sweep();
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

    it('counts a participating PM and waits for its assessment instead of escalating on more messages', async () => {
      await talk('pm', ['dev-1', 'cr']);
      await talk('cr', ['pm']);
      await talk('pm', ['dev-1']);
      expect(items()).toEqual([]);
      expect(loop()).toMatchObject({ phase: 'notified', count: 6 });

      await talk('dev-1', ['cr']);
      await talk('cr', ['dev-1']);
      expect(items()).toEqual([]);
      await talk('dev-1', ['cr']);
      expect(items()).toEqual([]);
      const id = signal()!.id;
      await assess('loop');
      await h.domain.teamTools.triageLoop(pmContext(), {
        signalId: id,
        outcome: 'loop',
        note: 'Same assessment.',
        evidenceIds: [],
      });
      await vi.waitFor(() => expect(items()).toHaveLength(1));
      expect(loopDecisionOf(items()[0]!)).toMatchObject({ reason: 'continued', watcher: 'pm', count: 9 });
      expect(loop()).toMatchObject({ phase: 'owner', ownerReason: 'continued', deciders: ['owner'] });
      expect(loopEvents().map((event) => event.data.phase)).toEqual(['raised', 'escalated']);

      // Further messages feed the loop but raise no second item.
      await talk('cr', ['dev-1']);
      await talk('dev-1', ['cr']);
      await talk('cr', ['dev-1']);
      expect(items()).toHaveLength(1);
      expect(loop()!.count).toBe(12);
    });
  });

  describe('PM filtering (PM-712)', () => {
    beforeEach(async () => {
      await prepare();
      await goRound();
    });

    it('keeps observing from the assessment count, and queues exactly one new generation at the next threshold', async () => {
      const stop = vi.spyOn(h.domain.sessions, 'stopTask');
      const id = signal()!.id;
      const first = await assess('progress');
      expect(first).toMatchObject({ state: 'observing', inboxItemId: null });
      expect(loop()).toMatchObject({
        phase: 'notified',
        triage: { generation: 0, assessed: { count: 3, outcome: 'progress', by: 'pm' } },
      });
      expect(h.repos.operatorSignals.get(id)?.state).toBe('resolved');
      await expect(
        h.domain.teamTools.triageLoop(pmContext(), {
          signalId: id,
          outcome: 'loop',
          note: 'A retry cannot change the result.',
          evidenceIds: [],
        }),
      ).resolves.toEqual(first);
      expect(stop).not.toHaveBeenCalled();
      expect(items()).toEqual([]);
      expect(
        loopEvents().some((event) => ['let_run', 'stopped'].includes(String(event.data.endReason))),
      ).toBe(false);
      await talk('cr', ['dev-1']);
      await talk('dev-1', ['cr']);
      expect(loop()!.triage!.generation).toBe(0);
      await talk('cr', ['dev-1']);
      expect(loop()!.triage).toMatchObject({ generation: 1, requestedCount: 6, assessed: null });
      await h.domain.loopWatch.sweep();
      expect(h.repos.operatorSignals.list('AR').filter((s) => s.kind === 'loop_suspected')).toHaveLength(2);
      await expect(
        h.domain.teamTools.triageLoop(pmContext(), {
          signalId: id,
          outcome: 'loop',
          note: 'Stale.',
          evidenceIds: [],
        }),
      ).rejects.toMatchObject({ code: 'invalid' });
      const event = h.repos.timeline.list('AR', { taskKey: 'AR-1' }).find((e) => e.type === 'loop_triaged')!;
      expect(event.actor).toEqual(aiActor('pm'));
      expect(event.data).toMatchObject({
        generation: 0,
        outcome: 'progress',
        evidenceIds: [],
        headCommit: null,
      });
      expect(event.data).not.toHaveProperty('note');
    });

    it('filters even when the selected PM took part before the threshold', async () => {
      await h.domain.tasks.addNote('AR', 'AR-1', 'New review round.', OWNER_ACTOR);
      tick(1);
      await talk('pm', ['dev-1']);
      await talk('dev-1', ['pm']);
      await talk('pm', ['dev-1']);
      expect(loop()).toMatchObject({ phase: 'notified', members: ['dev-1', 'pm'] });
      expect(items()).toEqual([]);
      expect(h.repos.operatorSignals.list('AR').filter((s) => s.kind === 'loop_suspected')).toHaveLength(2);
    });

    it('rechecks a new commit before the sixth message could reach an owner', async () => {
      const id = signal()!.id;
      await talk('cr', ['dev-1']);
      await talk('dev-1', ['cr']);
      vi.spyOn(h.domain.sessions, 'sourceHead').mockResolvedValue({
        commit: 'fixed-review',
        branch: 'task/AR-1',
        dirty: false,
        changes: 0,
        path: '/fake/worktree',
        committedAt: now.toISOString(),
      });
      await talk('cr', ['dev-1']);
      expect(loop()).toBeNull();
      expect(items()).toEqual([]);
      expect(h.repos.operatorSignals.get(id)?.state).toBe('resolved');
      expect(loopEvents().at(-1)?.data.endReason).toBe('commit');
    });

    it('resolves an assessment racing a fresh branch head without creating a human item', async () => {
      vi.spyOn(h.domain.sessions, 'sourceHead').mockResolvedValue({
        commit: 'fixed',
        branch: 'task/AR-1',
        dirty: false,
        changes: 0,
        path: '/fake/worktree',
        committedAt: now.toISOString(),
      });
      await expect(assess('loop')).resolves.toMatchObject({ state: 'resolved', inboxItemId: null });
      expect(loop()).toBeNull();
      expect(items()).toEqual([]);
    });

    it('rejects another card, message evidence and duplicate ids, but accepts this card check evidence', async () => {
      const wrong = h.domain.timeline.append({
        projectKey: 'AR',
        taskKey: 'AR-2',
        actor: aiActor('cr'),
        type: 'task_check_changed',
        data: { check: 'code_review', from: 'pending', to: 'failed' },
      });
      const message = h.repos.timeline
        .list('AR', { taskKey: 'AR-1' })
        .find((e) => e.type === 'team_message')!;
      const valid = h.domain.timeline.append({
        projectKey: 'AR',
        taskKey: 'AR-1',
        actor: aiActor('cr'),
        type: 'task_check_changed',
        data: { check: 'code_review', from: 'pending', to: 'failed' },
      });
      for (const ids of [[wrong.id], [message.id], [valid.id, valid.id], ['missing']]) {
        await expect(assess('loop', ids)).rejects.toMatchObject({ code: 'invalid' });
        expect(items()).toEqual([]);
      }
      await expect(assess('progress', [valid.id])).resolves.toMatchObject({ state: 'observing' });
    });

    it('allows concurrent assessments only one decision and one attributed event', async () => {
      const id = signal()!.id;
      await Promise.all(
        [1, 2].map(() =>
          h.domain.teamTools.triageLoop(pmContext(), {
            signalId: id,
            outcome: 'loop',
            note: 'The same review point repeats.',
            evidenceIds: [],
          }),
        ),
      );
      expect(items()).toHaveLength(1);
      expect(
        h.repos.timeline.list('AR', { taskKey: 'AR-1' }).filter((e) => e.type === 'loop_triaged'),
      ).toHaveLength(1);
    });

    it('rejects non-PMs and guest sessions, and a signal delivered to another handle', async () => {
      const args = { signalId: signal()!.id, outcome: 'loop' as const, note: 'Review.', evidenceIds: [] };
      await expect(
        h.domain.teamTools.triageLoop({ ...pmContext(), member: 'dev-1' }, args),
      ).rejects.toMatchObject({ code: 'forbidden' });
      const current = await waitForSession(h.domain, { member: 'pm' });
      h.repos.sessions.insert({ ...current, id: 'ses_guest', workItem: { type: 'general', with: 'owner' } });
      await expect(
        h.domain.teamTools.triageLoop({ ...pmContext(), sessionId: 'ses_guest' }, args),
      ).rejects.toMatchObject({ code: 'forbidden' });
      h.repos.operatorSignals.save({ ...signal()!, deliveredTo: 'dev-1' });
      await expect(h.domain.teamTools.triageLoop(pmContext(), args)).rejects.toMatchObject({
        code: 'invalid',
      });
      expect(items()).toEqual([]);
    });

    it('does not turn a report into an owner request or start permission at any watch level', async () => {
      const id = signal()!.id;
      expect(() => h.domain.operatorSignals.presentation('AR', id, 'pm')).toThrow('use triage_loop');
      for (const level of ['report', 'unblock', 'drive'] as const) {
        await h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (config) => {
          config.team.operatorWatch = level;
          return 'Change watch level';
        });
        await expect(
          h.domain.teamTools.startTask(pmContext(), { taskKey: 'AR-1', signalId: id }),
        ).rejects.toMatchObject({ code: 'forbidden' });
      }
      expect(h.repos.operatorRequests.latest('AR', 10)).toEqual([]);
      expect(items()).toEqual([]);
    });

    it('falls back once after ten online minutes', async () => {
      tick(9);
      await h.domain.loopWatch.sweep();
      expect(items()).toHaveLength(1);
      await h.domain.loopWatch.sweep();
      expect(items()).toHaveLength(1);
      expect(loop()!.phase).toBe('owner');
    });

    it('rechecks progress before a timed-out candidate creates a human decision', async () => {
      tick(12);
      vi.spyOn(h.domain.sessions, 'sourceHead').mockResolvedValue({
        commit: 'fixed-before-deadline',
        branch: 'task/AR-1',
        dirty: false,
        changes: 0,
        path: '/fake/worktree',
        committedAt: now.toISOString(),
      });
      await h.domain.loopWatch.sweep();
      expect(loop()).toBeNull();
      expect(items()).toEqual([]);
    });

    it('rechecks the PM after an asynchronous head read and refuses a stale member', async () => {
      const config = h.domain.projects.cachedConfig('AR')!;
      const pm = config.team.members.find((m) => m.handle === 'pm')!;
      vi.spyOn(h.domain.sessions, 'sourceHead').mockImplementation(async () => {
        if (pm.kind === 'ai') pm.onLeave = true;
        return null;
      });
      await expect(assess('loop')).rejects.toMatchObject({ code: 'forbidden' });
      expect(items()).toEqual([]);
    });

    it('keeps a legacy owner decision visible and never opens it again through AI triage', async () => {
      await assess('loop');
      const current = loop()!;
      const id = items()[0]!.id;
      h.repos.taskLoops.save({ ...current, triage: null });
      await h.domain.loopWatch.sweep();
      expect(items()).toHaveLength(1);
      expect(items()[0]).toMatchObject({ id, state: 'open' });
      expect(loop()!.triage).toBeNull();
    });
  });

  it('recovers an unassessed delivery and its remaining deadline across restart', async () => {
    await prepare({}, true);
    await goRound();
    const id = signal()!.id;
    tick(3);
    h = await restartDomainHarness(h, { now: () => now });
    await h.domain.loopWatch.sweep();
    expect(loop()!.triage).toMatchObject({
      generation: 0,
      pendingSignalId: id,
      deadline: { remainingMs: 6 * MINUTE, resumedAt: now.toISOString() },
    });
    expect(h.repos.operatorSignals.list('AR').filter((s) => s.kind === 'loop_suspected')).toHaveLength(1);
    expect(items()).toEqual([]);
  });

  it('recovers the same assessed generation and owner item across restart', async () => {
    await prepare({}, true);
    await goRound();
    const id = signal()!.id;
    await assess('loop');
    const itemId = items()[0]!.id;
    h = await restartDomainHarness(h, { now: () => now });
    await h.domain.loopWatch.sweep();
    const session = await h.domain.sessions.ensureSession('AR', 'pm', { type: 'general' });
    await expect(
      h.domain.teamTools.triageLoop(
        { projectKey: 'AR', member: 'pm', taskKey: null, sessionId: session.session.id },
        {
          signalId: id,
          outcome: 'loop',
          note: 'Retry after restart.',
          evidenceIds: [],
        },
      ),
    ).resolves.toMatchObject({ state: 'awaiting_owner', inboxItemId: itemId });
    expect(items()).toHaveLength(1);
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
