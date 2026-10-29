import type { ProjectConfig, WorkItemRef } from '@projectman/shared';
import { MEMBER_QUEUE_MAX_ATTEMPTS } from '@projectman/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemberQueueLane } from '../src/runtime/member-queue';
import { createDomainHarness, OWNER_ACTOR, restartDomainHarness } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush, settle } from './helpers/fakes';

/**
 * The member queue's driver (PM-925): the queue is worked through level by level, so a wake an event lost, a
 * limit that lifted without an event and a restart are all found by the sweep, and what cannot start waits in
 * the queue with the code of what stops it.
 */
const task = (taskKey: string): WorkItemRef => ({ type: 'task', taskKey });
const general: WorkItemRef = { type: 'general' };

const oneAiSlot = (config: ProjectConfig) => void (config.team.limits.maxConcurrentAi = 1);

describe('the member queue driver', () => {
  let h: DomainHarness;
  afterEach(async () => {
    await h.domain.stop();
    await h.cleanup();
  });

  const driver = () => h.domain.memberQueueDriver;
  const items = (member = 'dev-1') => h.repos.memberQueue.listOpen('AR', member);
  /** A message recorded without anything waking its recipient: only the queue knows about it. */
  const record = (
    to: string,
    taskKey: string | null,
    extra: { from?: string; kind?: 'info' | 'action' } = {},
  ) =>
    h.domain.messages.record({
      projectKey: 'AR',
      from: extra.from ?? 'owner',
      to: [to],
      taskKey,
      body: 'Fictional news.',
      actor: OWNER_ACTOR,
      ...(extra.kind ? { kind: extra.kind } : {}),
    });
  /** Every queued item that wakes its member has a live session at its place, or says what stops it. */
  const expectNothingForgotten = () => {
    for (const { projectKey, member } of h.repos.memberQueue.listOpenMembers())
      for (const item of h.repos.memberQueue.listOpen(projectKey, member)) {
        if (item.state !== 'queued' || !item.wake) continue;
        const session = h.domain.sessions.findRunning(projectKey, member, item.place);
        expect(session !== null || item.wait !== null, `item ${item.id} is forgotten`).toBe(true);
      }
  };
  const closedStates = () =>
    h.repos.db
      .prepare(
        "SELECT state, close_reason AS reason FROM member_queue_items WHERE kind = 'message' ORDER BY rowid",
      )
      .all() as Array<{ state: string; reason: string | null }>;

  describe('waking', () => {
    beforeEach(async () => {
      h = await createDomainHarness({ adjust: oneAiSlot });
      await h.domain.tasks.create('AR', { title: 'Fictional card' }, OWNER_ACTOR);
    });

    it('keeps a message queued with the limit as its wait, and delivers it when the sweep finds the limit lifted', async () => {
      const busy = (await h.domain.sessions.ensureSession('AR', 'dev-2', general)).session;
      h.runner.setState(busy.id, 'working');
      const started = h.runner.started.length;
      const message = record('dev-1', 'AR-1');
      await driver().ensure('AR', 'dev-1');

      expect(h.runner.started).toHaveLength(started);
      expect(items()).toEqual([
        expect.objectContaining({ wait: expect.objectContaining({ code: 'ai_limit_reached' }) }),
      ]);
      // The wait lives on the item: no deferred start row is kept for the message.
      expect(h.repos.deferredStarts.list()).toEqual([]);
      expectNothingForgotten();

      h.runner.setState(busy.id, 'idle');
      await driver().sweep();
      expectNothingForgotten();

      expect(h.runner.started).toHaveLength(started + 1);
      expect(h.runner.lastStarted().initialMessage).toContain('Fictional news.');
      expect(h.repos.messages.get(message.id)?.deliveredAt).toBeTruthy();
      expect(items()).toEqual([]);
    });

    it('finds the work of a message at the sweep, and starts nothing twice', async () => {
      const message = record('dev-1', 'AR-1');
      await driver().sweep();
      await driver().sweep();

      expect(h.runner.started).toHaveLength(1);
      expect(h.repos.messages.get(message.id)?.deliveredAt).toBeTruthy();
    });

    it('starts one session when two runs ask for it at once, and does not deliver twice', async () => {
      record('dev-1', 'AR-1');
      await Promise.all([driver().ensure('AR', 'dev-1'), driver().ensure('AR', 'dev-1'), driver().sweep()]);

      expect(h.runner.started).toHaveLength(1);
      expect(h.runner.messages).toEqual([]);
      // A message is delivered, never worked: its item is never `processing`.
      expect(closedStates()).toEqual([{ state: 'done', reason: 'delivered' }]);
    });
  });

  describe('where a message waits', () => {
    beforeEach(async () => {
      h = await createDomainHarness();
      await h.domain.tasks.create('AR', { title: 'Fictional card' }, OWNER_ACTOR);
      await h.domain.tasks.cancel('AR', 'AR-1', {}, OWNER_ACTOR);
    });

    it('ends an info message that waits on a closed card, and moves a person message to the desk and wakes', async () => {
      record('dev-2', 'AR-1', { from: 'dev-1', kind: 'info' });
      record('dev-2', 'AR-1');
      await driver().ensure('AR', 'dev-2');
      await flush();

      expect(closedStates()).toEqual([
        { state: 'cancelled', reason: 'place_closed' },
        { state: 'done', reason: 'delivered' },
      ]);
      expect(h.domain.sessions.list('AR', { member: 'dev-2' }).map((s) => s.workItem)).toEqual([general]);
      expect(h.runner.started).toHaveLength(1);
    });
  });

  describe('holds', () => {
    beforeEach(async () => {
      h = await createDomainHarness();
      await h.domain.tasks.create('AR', { title: 'Fictional card' }, OWNER_ACTOR);
    });

    it('does not wake the old assignee while the handoff runs, and wakes it after the release', async () => {
      h.repos.taskHandoffs.create({
        id: 'handoff-1',
        projectKey: 'AR',
        taskKey: 'AR-1',
        from: 'dev-1',
        to: 'dev-2',
        fromProvider: 'claude',
        toProvider: 'claude',
        fromSessionId: null,
        reason: 'manual',
        step: 'writing',
        startedAt: new Date().toISOString(),
        deadlineAt: null,
        outcome: null,
        fallbackReason: null,
        note: null,
        branch: null,
        lastCommit: null,
        uncommitted: null,
        summary: null,
        closingAt: null,
        endedAt: null,
        takenOverAt: null,
        takenOverSessionId: null,
      });
      record('dev-1', 'AR-1');
      await driver().ensure('AR', 'dev-1');

      expect(h.runner.started).toHaveLength(0);
      expect(items()).toEqual([
        expect.objectContaining({ wait: expect.objectContaining({ code: 'hold_handoff' }) }),
      ]);

      const open = h.repos.taskHandoffs.open('AR-1')!;
      h.repos.taskHandoffs.save({ ...open, outcome: 'cancelled', endedAt: new Date().toISOString() });
      await driver().sweep();

      expect(h.runner.started).toHaveLength(1);
      expect(items()).toEqual([]);
    });

    it('queues a message of an AI member for a member without a role on the card, and starts nobody (decision 44)', async () => {
      const message = record('dev-2', 'AR-1', { from: 'dev-1' });
      await driver().sweep();
      await settle();

      expect(h.runner.started).toHaveLength(0);
      expect(items('dev-2')).toEqual([expect.objectContaining({ wake: false, wait: null })]);
      expect(h.repos.messages.get(message.id)?.deliveredAt).toBeNull();
    });

    it('asks a lane that decides its holds together once per run, not once per item (PM-1106)', async () => {
      const holdAll = vi.fn(
        async (queued: { id: string }[]) => new Map(queued.map((i) => [i.id, 'hold_test'])),
      );
      const hold = vi.fn(async () => null);
      driver().register({
        kinds: ['todo'],
        completion: 'source',
        oneAtATime: true,
        cause: () => ({ kind: 'message', by: { kind: 'system', handle: null } }),
        render: (item) => item.title,
        stillOwed: () => true,
        hold,
        holdAll,
      });
      for (const id of ['probe-1', 'probe-2', 'probe-3'])
        h.repos.memberQueue.insert({
          id,
          projectKey: 'AR',
          member: 'dev-1',
          kind: 'todo',
          source: { type: 'inbox', id },
          place: general,
          taskKey: null,
          wake: true,
          title: id,
          from: null,
          queuedAt: new Date().toISOString(),
        });
      await driver().ensure('AR', 'dev-1');

      expect(holdAll).toHaveBeenCalledTimes(1);
      expect(holdAll.mock.calls[0]![0]).toHaveLength(3);
      expect(hold).not.toHaveBeenCalled();
      expect(items().map((item) => item.wait?.code)).toEqual(['hold_test', 'hold_test', 'hold_test']);
      expect(h.runner.started).toHaveLength(0);
    });
  });

  describe('a lane that works its items', () => {
    const at = () => new Date().toISOString();
    const lane: MemberQueueLane = {
      kinds: ['todo'],
      completion: 'source',
      oneAtATime: true,
      cause: () => ({ kind: 'message', by: { kind: 'system', handle: null } }),
      render: (item) => `Please do: ${item.title}`,
      stillOwed: () => true,
      hold: async () => null,
    };
    const enqueue = (id: string, wake = false) =>
      h.repos.memberQueue.insert({
        id,
        projectKey: 'AR',
        member: 'dev-1',
        kind: 'todo',
        source: { type: 'inbox', id },
        place: general,
        taskKey: null,
        wake,
        title: id,
        from: null,
        queuedAt: at(),
      });

    beforeEach(async () => {
      h = await createDomainHarness();
      driver().register(lane);
    });

    it('lets only one claimer take an item', async () => {
      enqueue('probe-1');
      expect(h.repos.memberQueue.claim('probe-1', 'ses-a', at())).toBe(true);
      expect(h.repos.memberQueue.claim('probe-1', 'ses-b', at())).toBe(false);
      expect(h.repos.memberQueue.get('probe-1')).toMatchObject({ state: 'processing', sessionId: 'ses-a' });
    });

    it('types one item into an idle session at its turn and holds the next until it is finished', async () => {
      const chat = (await h.domain.sessions.ensureSession('AR', 'dev-1', general)).session;
      h.runner.setState(chat.id, 'idle');
      enqueue('probe-1');
      enqueue('probe-2');
      await driver().ensure('AR', 'dev-1');

      expect(h.runner.messages.map((m) => m.sessionId)).toEqual([chat.id]);
      expect(h.runner.messages[0]!.text).toContain('Please do: probe-1');
      expect(h.repos.memberQueue.get('probe-1')).toMatchObject({ state: 'processing', sessionId: chat.id });
      expect(h.repos.memberQueue.get('probe-2')).toMatchObject({ state: 'queued' });
    });

    it('does not hold the run until the started session takes its first input, and leaves the item alone meanwhile', async () => {
      h.runner.holdFirstInput = true;
      enqueue('probe-1', true);
      await driver().ensure('AR', 'dev-1');

      expect(h.runner.started.map((spec) => spec.member)).toEqual(['dev-1']);
      await driver().ensure('AR', 'dev-1', { net: true });
      expect(h.runner.started).toHaveLength(1);
      expect(h.runner.messages).toHaveLength(0);
      expect(h.repos.memberQueue.get('probe-1')).toMatchObject({ state: 'queued' });

      h.runner.emit({ type: 'first_input_sent', sessionId: h.runner.started[0]!.sessionId });
      await vi.waitFor(() =>
        expect(h.repos.memberQueue.get('probe-1')).toMatchObject({
          state: 'processing',
          sessionId: h.runner.started[0]!.sessionId,
        }),
      );
    });

    it('puts an item back whose session is gone, and hands it off after the last attempt', async () => {
      enqueue('probe-1');
      for (let attempt = 1; attempt < MEMBER_QUEUE_MAX_ATTEMPTS; attempt++) {
        expect(h.repos.memberQueue.claim('probe-1', 'ses-gone', at())).toBe(true);
        await driver().ensure('AR', 'dev-1');
        expect(h.repos.memberQueue.get('probe-1')).toMatchObject({ state: 'queued', attempts: attempt });
      }
      expect(h.repos.memberQueue.claim('probe-1', 'ses-gone', at())).toBe(true);
      await driver().ensure('AR', 'dev-1');

      expect(h.repos.memberQueue.get('probe-1')).toMatchObject({
        state: 'handed_off',
        closeReason: 'attempts_exhausted',
      });
    });

    it('stops the session of an item stuck for too long and puts the item back', async () => {
      const chat = (await h.domain.sessions.ensureSession('AR', 'dev-1', general)).session;
      enqueue('probe-1');
      expect(h.repos.memberQueue.claim('probe-1', chat.id, at())).toBe(true);
      await driver().ensure('AR', 'dev-1');
      // Fresh: the session keeps it.
      expect(h.repos.memberQueue.get('probe-1')).toMatchObject({ state: 'processing' });

      h.repos.db
        .prepare("UPDATE member_queue_items SET started_at = '2020-01-01T00:00:00.000Z' WHERE id = 'probe-1'")
        .run();
      await driver().ensure('AR', 'dev-1');

      expect(h.repos.memberQueue.get('probe-1')).toMatchObject({
        state: 'queued',
        attempts: 1,
        sessionId: null,
      });
    });
  });

  describe('a message that came from before the queue woke members (phase-out)', () => {
    beforeEach(async () => {
      h = await createDomainHarness({
        persistent: true,
        adjust: (config) => void (config.team.limits.aiEnabled = false),
      });
      await h.domain.tasks.create('AR', { title: 'Fictional card' }, OWNER_ACTOR);
    });

    it('drops an old message wake start row at a restart, and the queue delivers the message', async () => {
      const message = record('dev-1', 'AR-1');
      h.repos.deferredStarts.save({
        key: 'message-wake:AR:dev-1',
        projectKey: 'AR',
        taskKey: 'AR-1',
        spec: {
          kind: 'message_wake',
          projectKey: 'AR',
          handle: 'dev-1',
          workItem: task('AR-1'),
          stageId: null,
        },
        waiting: null,
      });

      h = await restartDomainHarness(h);
      await vi.waitFor(() => expect(h.repos.deferredStarts.list()).toEqual([]));
      expect(h.runner.started).toHaveLength(0);
      expect(items()).toHaveLength(1);

      await h.domain.projects.update(
        'AR',
        { actor: OWNER_ACTOR, author: { name: 'Owner', email: 'owner@example.com' } },
        (config) => {
          config.team.limits.aiEnabled = true;
          return 'Set AI admission';
        },
      );
      await vi.waitFor(() => expect(h.repos.messages.get(message.id)?.deliveredAt).toBeTruthy());
      expect(h.runner.started).toHaveLength(1);
    });
  });
});
