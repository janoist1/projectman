import type { ProjectConfig, WorkItemRef } from '@projectman/shared';
import { MEMBER_QUEUE_MAX_ATTEMPTS } from '@projectman/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemberQueueLane } from '../src/runtime/member-queue';
import { createDomainHarness, OWNER_ACTOR, restartDomainHarness } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush, settle } from './helpers/fakes';
import { instrumentSql } from './helpers/sql-meter';

/**
 * The member queue's driver (PM-925): the queue is worked through level by level, so a wake an event lost, a
 * limit that lifted without an event and a restart are all found by the sweep, and what cannot start waits in
 * the queue with the code of what stops it.
 */
const task = (taskKey: string): WorkItemRef => ({ type: 'task', taskKey });
const general: WorkItemRef = { type: 'general' };

const oneAiSlot = (config: ProjectConfig) => void (config.team.limits.maxConcurrentAi = 1);
const pmOnDuty = (config: ProjectConfig) => {
  const pm = config.team.members.find((m) => m.handle === 'pm');
  if (pm?.kind === 'ai') pm.onLeave = false;
};

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

  it('bounds SQL across the real driver and per-message holds for a batch of distinct cards', async () => {
    h = await createDomainHarness();
    for (let n = 0; n < 20; n++) {
      const card = await h.domain.tasks.create('AR', { title: `Held card ${n}` }, OWNER_ACTOR);
      record('dev-1', card.key);
    }
    await flush();
    const meter = instrumentSql();
    try {
      meter.start();
      await driver().ensure('AR', 'dev-1');
      const count = meter.stop();
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThanOrEqual(1500);
    } finally {
      meter.restore();
    }
  });

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

  describe('what a run delivers and when it retries (PM-1108)', () => {
    const at = () => new Date().toISOString();
    const todoLane: MemberQueueLane = {
      kinds: ['todo'],
      completion: 'delivery',
      oneAtATime: false,
      cause: () => ({ kind: 'message', by: { kind: 'system', handle: null } }),
      render: (item) => `Please do: ${item.title}`,
      stillOwed: () => true,
      hold: async () => null,
    };
    const enqueueTodo = (id: string) =>
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
        queuedAt: at(),
      });

    describe('with a free slot', () => {
      beforeEach(async () => {
        h = await createDomainHarness();
        driver().register(todoLane);
      });

      it('does not hold the admission lock while the first input of a start is read from the engine', async () => {
        await h.domain.tasks.create('AR', { title: 'Fictional card' }, OWNER_ACTOR);
        let release: (head: null) => void = () => {};
        const reading = new Promise<null>((resolve) => (release = resolve));
        const read = vi.spyOn(h.domain.sessions, 'sourceHead').mockReturnValue(reading);
        const message = record('dev-1', 'AR-1');
        const run = driver().ensure('AR', 'dev-1');
        await vi.waitFor(() => expect(read).toHaveBeenCalled());

        expect(await h.domain.admission.exclusive('test', async () => 'free')).toBe('free');
        release(null);
        await run;
        expect(h.repos.messages.get(message.id)?.deliveredAt).toBeTruthy();
      });

      it('releases an item whose typing failed without counting an attempt, and counts the session that ended with it', async () => {
        driver().register({ ...todoLane, kinds: ['checklist'], completion: 'source', oneAtATime: true });
        const chat = (await h.domain.sessions.ensureSession('AR', 'dev-1', general)).session;
        h.runner.setState(chat.id, 'idle');
        h.repos.memberQueue.insert({
          id: 'probe-2',
          projectKey: 'AR',
          member: 'dev-1',
          kind: 'checklist',
          source: { type: 'inbox', id: 'probe-2' },
          place: general,
          taskKey: null,
          wake: false,
          title: 'probe-2',
          from: null,
          queuedAt: at(),
        });
        for (let failure = 0; failure < 2; failure++) {
          h.runner.failNextSend = new Error('the CLI did not take it');
          await driver().ensure('AR', 'dev-1');
          expect(h.repos.memberQueue.get('probe-2')).toMatchObject({
            state: 'queued',
            attempts: 0,
            sessionId: null,
          });
        }

        h.runner.setState(chat.id, 'working');
        expect(h.repos.memberQueue.claim('probe-2', 'ses-gone', at())).toBe(true);
        await driver().ensure('AR', 'dev-1');
        expect(h.repos.memberQueue.get('probe-2')).toMatchObject({ state: 'queued', attempts: 1 });
      });

      it('gives a call that comes while a run works to the next run, not to the one that works', async () => {
        const chat = (await h.domain.sessions.ensureSession('AR', 'dev-1', general)).session;
        h.runner.setState(chat.id, 'idle');
        let phase = 0;
        const phases: number[] = [];
        let release: () => void = () => {};
        const blocked = new Promise<void>((resolve) => (release = resolve));
        driver().register({
          ...todoLane,
          kinds: ['checklist'],
          render: () => null,
          hold: async () => {
            if (++phase === 1) await blocked;
            return null;
          },
          deliverLive: () => void phases.push(phase),
        });
        h.repos.memberQueue.insert({
          id: 'probe-3',
          projectKey: 'AR',
          member: 'dev-1',
          kind: 'checklist',
          source: { type: 'inbox', id: 'probe-3' },
          place: general,
          taskKey: null,
          wake: false,
          title: 'probe-3',
          from: null,
          queuedAt: at(),
        });

        const first = driver().ensure('AR', 'dev-1', { deliver: false });
        await vi.waitFor(() => expect(phase).toBe(1));
        const second = driver().ensure('AR', 'dev-1', { net: true });
        release();
        await Promise.all([first, second]);

        // The net the second call asked for was cast by its own run (the second hold), not by the first.
        expect(phases).toEqual([2]);
      });

      it('answers a sender for the place it asked about, not for another place of the member', async () => {
        enqueueTodo('probe-4');
        await expect(driver().wake('AR', 'dev-1', task('AR-1'))).resolves.toEqual({
          state: 'failed',
          code: 'not_started',
        });
        await expect(driver().wake('AR', 'dev-1', general)).resolves.toMatchObject({ state: 'started' });
      });

      it('closes the items of a member who left the team', async () => {
        h.repos.memberQueue.insert({
          id: 'probe-5',
          projectKey: 'AR',
          member: 'gone-member',
          kind: 'todo',
          source: { type: 'inbox', id: 'probe-5' },
          place: general,
          taskKey: null,
          wake: true,
          title: 'probe-5',
          from: null,
          queuedAt: at(),
        });

        await driver().ensure('AR', 'gone-member');

        expect(h.repos.memberQueue.get('probe-5')).toMatchObject({
          state: 'cancelled',
          closeReason: 'member_removed',
        });
      });

      it('ends the session of a start that failed like any other, and tells the timeline', async () => {
        enqueueTodo('probe-6');
        h.runner.failNextStart = new Error('fictional spawn failure');

        await driver().ensure('AR', 'dev-1');

        const [session] = h.repos.sessions.list('AR').filter((s) => s.member === 'dev-1');
        expect(session).toMatchObject({ state: 'failed', lastStop: { kind: 'failed' } });
        expect(h.repos.timeline.ofProjectType('AR', 'session_ended', 10)).toEqual([
          expect.objectContaining({ sessionId: session!.id }),
        ]);
      });
    });

    describe('with a screening of the project manager', () => {
      beforeEach(async () => {
        h = await createDomainHarness({ screenQuestions: true, adjust: pmOnDuty });
        await h.domain.tasks.create('AR', { title: 'Fictional card' }, OWNER_ACTOR);
      });

      it('keeps the project manager’s task message queued when the screening starts the session, and types it at the next idle', async () => {
        h.runner.holdFirstInput = true;
        // From a team member: a person's message is also typed by the session's own hooks, an AI's waits for its turn.
        const message = record('pm', 'AR-1', { from: 'dev-1' });
        h.domain.inbox.create({
          projectKey: 'AR',
          kind: 'question',
          source: 'dev-1',
          assignees: ['owner'],
          title: 'Which font?',
          payload: {
            question: 'Which font?',
            requestedRecipient: 'owner',
            recipient: 'owner',
            screening: { until: '2999-01-01T00:00:00.000Z' },
          },
          state: 'screening',
          options: [{ id: 'yes', label: 'Yes', style: 'primary' }],
        });
        await vi.waitFor(() => expect(h.runner.started).toHaveLength(1));
        const { sessionId, initialMessage } = h.runner.started[0]!;
        expect(initialMessage).toContain('Which font?');
        expect(initialMessage).not.toContain('Fictional news.');

        h.runner.emit({ type: 'first_input_sent', sessionId });
        await vi.waitFor(() =>
          expect(h.repos.memberQueue.listOpen('AR', 'pm').map((item) => [item.kind, item.state])).toEqual(
            expect.arrayContaining([['message', 'queued']]),
          ),
        );
        expect(h.repos.messages.get(message.id)?.deliveredAt).toBeNull();

        // The message is typed at the next turn boundary.
        h.runner.setState(sessionId, 'idle');
        await driver().ensure('AR', 'pm', { net: true });
        await vi.waitFor(() => expect(h.repos.messages.get(message.id)?.deliveredAt).toBeTruthy());
        expect(h.runner.messages.map((m) => m.text).join('\n')).toContain('Fictional news.');
      });
    });

    describe('with one slot', () => {
      beforeEach(async () => {
        h = await createDomainHarness({ adjust: oneAiSlot });
        await h.domain.tasks.create('AR', { title: 'Fictional card' }, OWNER_ACTOR);
      });

      it('retries the start that waits for capacity when another session ends, and leaves the other members alone', async () => {
        const busy = (await h.domain.sessions.ensureSession('AR', 'dev-2', general)).session;
        h.runner.setState(busy.id, 'working');
        const started = h.runner.started.length;
        // pm holds an item with no wait noted: a full sweep would note a wait on it, the retry must not.
        record('pm', 'AR-1', { from: 'dev-1' });
        await driver().ensure('AR', 'pm');
        for (const item of items('pm')) h.repos.memberQueue.clearWait(item.id);
        const message = record('dev-1', 'AR-1');
        await driver().ensure('AR', 'dev-1');
        expect(h.repos.memberQueue.listWaiting().map((item) => item.member)).toEqual(['dev-1']);

        // The session's end asks for the retry through the admission (a debounce of zero in the harness).
        const ensure = vi.spyOn(driver(), 'ensure');
        await h.runner.stop(busy.id);

        await vi.waitFor(() => expect(h.repos.messages.get(message.id)?.deliveredAt).toBeTruthy());
        expect(h.runner.started).toHaveLength(started + 1);
        expect(ensure.mock.calls.map(([, member]) => member)).not.toContain('pm');
        expect(items('pm')).toEqual([expect.objectContaining({ wait: null })]);
      });
    });

    describe('with a debounce', () => {
      beforeEach(async () => {
        h = await createDomainHarness({ retryDebounceMs: 30 });
      });

      it('runs one retry for a burst of requests, a moment later', async () => {
        const retry = vi.spyOn(h.domain.admission, 'retryDeferred');
        h.domain.admission.requestRetry();
        h.domain.admission.requestRetry();
        h.domain.admission.requestRetry();
        expect(retry).not.toHaveBeenCalled();

        await vi.waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
        await new Promise((resolve) => setTimeout(resolve, 80));
        expect(retry).toHaveBeenCalledTimes(1);
      });

      it('asks for no retry after the stop and waits for the round that runs', async () => {
        const retry = vi.spyOn(h.domain.admission, 'retryDeferred');
        h.domain.admission.requestRetry();
        const running = h.domain.admission.retryDeferred();
        let ended = false;
        void running.then(() => (ended = true));
        retry.mockClear();

        await h.domain.admission.dispose();
        expect(ended).toBe(true);

        h.domain.admission.requestRetry();
        await new Promise((resolve) => setTimeout(resolve, 80));
        expect(retry).not.toHaveBeenCalled();
      });
    });

    describe('after a restart', () => {
      beforeEach(async () => {
        h = await createDomainHarness({
          adjust: (config) => void (config.team.limits.aiEnabled = false),
        });
        await h.domain.tasks.create('AR', { title: 'Fictional card' }, OWNER_ACTOR);
      });

      const closeAsDelivered = (messageId: string, closedAt = at()) =>
        h.repos.db
          .prepare(
            "UPDATE member_queue_items SET state = 'done', close_reason = 'delivered', closed_at = ? WHERE source_id = ?",
          )
          .run(closedAt, messageId);
      /** The repair has run once at the harness' own startup: this is the database of before it. */
      const beforeTheRepair = () =>
        h.repos.db.prepare("DELETE FROM instance_meta WHERE key = 'untyped_message_repair'").run();

      it('opens a message again that was closed as delivered without being typed, whatever its age', async () => {
        const message = record('dev-1', 'AR-1');
        closeAsDelivered(message.id, '2020-01-01T00:00:00.000Z');
        h.repos.db
          .prepare("UPDATE member_queue_items SET queued_at = '2020-01-01T00:00:00.000Z' WHERE source_id = ?")
          .run(message.id);
        beforeTheRepair();
        expect(items()).toEqual([]);

        await h.domain.memberQueue.recover();

        expect(items()).toEqual([expect.objectContaining({ state: 'queued', closeReason: null })]);
        expect(h.repos.messages.get(message.id)?.deliveredAt).toBeNull();
      });

      it('repairs only once: a later start leaves a closed item alone', async () => {
        const message = record('dev-1', 'AR-1');
        closeAsDelivered(message.id);
        beforeTheRepair();
        await h.domain.memberQueue.recover();
        closeAsDelivered(message.id);

        await h.domain.memberQueue.recover();

        expect(items()).toEqual([]);
      });

      it('leaves a message closed as delivered alone once its receipt says it was typed', async () => {
        const message = record('dev-1', 'AR-1');
        h.domain.messages.markRecipientDelivered(message.id, 'dev-1');
        closeAsDelivered(message.id);
        beforeTheRepair();

        await h.domain.memberQueue.recover();

        expect(items()).toEqual([]);
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
