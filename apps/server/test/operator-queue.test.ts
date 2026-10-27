import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MEMBER_QUEUE_MAX_ATTEMPTS,
  FIX_ANOTHER_ROUND_OPTION,
  integratorSideAvailable,
  questionPayloadOf,
} from '@projectman/shared';
import type { MemberQueueItem } from '@projectman/shared';
import { TeamToolError } from '../src/contracts';
import type { ToolContext } from '../src/contracts';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { rejection } from './helpers/errors';
import { flush, settle } from './helpers/fakes';

/**
 * The Operator's lane of the per-member work queue (PM-885): the todos and held fix round decisions the system
 * opens and the action messages of AI members wake the Operator one item at a time, and the Operator ends each
 * with `finish_queue_item` — done, or handed off with a reason.
 */
const todo = { what: 'Measure the hub', where: 'Hub', expected: 'A latency report' };

const operatorItems = (h: DomainHarness): MemberQueueItem[] =>
  h.repos.memberQueue.listOpen('AR', 'operator').map((item) => h.domain.memberQueue.get(item.id)!);

describe('the Operator queue', () => {
  let h: DomainHarness;
  beforeEach(async () => {
    h = await createDomainHarness({
      integratorTodoAccess: { available: integratorSideAvailable },
      // A todo reaches the queue only from a member with machine access (decision 66).
      adjust: (config) => {
        const dev = config.team.members.find((m) => m.handle === 'dev-1');
        if (dev?.kind === 'ai') dev.machineAccess = true;
      },
    });
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
  });
  afterEach(async () => {
    await h.domain.stop();
    await h.cleanup();
    vi.restoreAllMocks();
  });

  const openTodo = (question = 'The hub needs a measurement') =>
    h.domain.inbox.openIntegratorTodo({
      projectKey: 'AR',
      taskKey: null,
      askedBy: 'system',
      question,
      todo,
    });
  const item = (id: string) => h.domain.memberQueue.get(id)!;
  const tool = (sessionId: string): ToolContext => ({
    projectKey: 'AR',
    member: 'operator',
    sessionId,
    taskKey: null,
  });
  /** The Operator's session started for its queue and the item it works. */
  async function working(): Promise<{ queueItem: MemberQueueItem; ctx: ToolContext }> {
    await settle();
    const queueItem = operatorItems(h).find((candidate) => candidate.state === 'processing')!;
    expect(queueItem).toBeDefined();
    return { queueItem, ctx: tool(queueItem.sessionId!) };
  }
  const finish = (ctx: ToolContext, itemId: string, extra: Record<string, unknown> = {}) =>
    h.domain.teamTools.finishQueueItem(ctx, {
      itemId,
      outcome: 'done',
      summary: 'Measured.',
      operationIds: [],
      ...extra,
    });
  /** The Operator's turn ends in its session. */
  function endTurn(sessionId: string): void {
    h.runner.setState(sessionId, 'working');
    h.runner.setState(sessionId, 'idle');
  }

  it('wakes the Operator for a todo with no person writing, and closes the todo when it is done', async () => {
    const opened = await openTodo();
    const { queueItem, ctx } = await working();
    expect(queueItem).toMatchObject({ kind: 'todo', source: { type: 'inbox', inboxItemId: opened.itemId } });
    expect(h.runner.started.some((spec) => spec.member === 'operator')).toBe(true);
    expect(h.runner.started.at(-1)?.initialMessage).toContain(queueItem.id);

    const result = await finish(ctx, queueItem.id, { operationIds: [] });

    expect(result.item).toMatchObject({ state: 'done', outcome: { summary: 'Measured.', handoff: null } });
    expect(h.domain.inbox.get('AR', opened.itemId)).toMatchObject({
      state: 'resolved',
      resolution: { optionId: 'todo_done', by: 'operator', operatorQueue: true },
    });
  });

  it('gives the Operator one item at a time and types the next one at the turn boundary', async () => {
    const first = await openTodo('First');
    const { queueItem, ctx } = await working();
    const second = await openTodo('Second');
    await settle();

    const waiting = operatorItems(h).filter((candidate) => candidate.id !== queueItem.id);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ state: 'queued', source: { inboxItemId: second.itemId } });
    expect(first.itemId).not.toBe(second.itemId);

    await finish(ctx, queueItem.id);
    endTurn(ctx.sessionId);
    await settle();

    expect(item(waiting[0]!.id)).toMatchObject({ state: 'processing', sessionId: ctx.sessionId });
  });

  it('refuses to end an item that is already closed, however it was closed', async () => {
    const opened = await openTodo();
    const { queueItem, ctx } = await working();
    // Closed from outside the queue, as the keyed integrator route does.
    await h.domain.inbox.resolveForOperatorQueue(
      'AR',
      opened.itemId,
      'todo_done',
      'Done elsewhere',
      'operator',
    );
    await flush();

    const refused = await rejection(finish(ctx, queueItem.id), TeamToolError);

    expect(refused.message).toContain('queue_item_not_processing');
  });

  it('refuses the owner-only writes (knowledge, project documents, decision offers) from a queue request', async () => {
    await openTodo();
    const { ctx } = await working();

    const refusals = await Promise.all([
      rejection(
        h.domain.teamTools.proposeOperatorKnowledge(ctx, {
          expected_revision: 0,
          title: 'Proposed knowledge',
          change: {
            kind: 'agreement_replace',
            agreement: { summary: 'Ask first.', involvement: 'important', extraCritical: [] },
          },
          operations: [],
        }),
        TeamToolError,
      ),
      rejection(
        h.domain.teamTools.writeProjectDocs(ctx, {
          baseCommit: 'abc',
          message: 'Note',
          edits: [{ doc: 'decisions', old_text: 'a', new_text: 'b' }],
        }),
        TeamToolError,
      ),
      rejection(h.domain.teamTools.markDecisionCandidates(ctx, { items: [] }), TeamToolError),
    ]);

    for (const refusal of refusals) expect(refusal.code).toBe('forbidden');
  });

  describe('handing an item off', () => {
    it('leaves a no_grant todo for the super side and closes its queue item without requeueing it', async () => {
      const reason = 'no_grant';
      const opened = await openTodo();
      const { queueItem, ctx } = await working();

      const result = await finish(ctx, queueItem.id, {
        outcome: 'handed_off',
        handoff: { reason, action: 'Measure the hub' },
      });

      expect(result.item).toMatchObject({
        state: 'handed_off',
        outcome: { handoff: { reason, to: 'super' } },
      });
      const handed = h.domain.inbox.get('AR', opened.itemId);
      expect(handed.state).toBe('open');
      expect(handed.assignees).toContain('owner');
      expect(questionPayloadOf(handed)).toMatchObject({
        recipient: 'integrator',
        operatorHandoff: { queueItemId: queueItem.id, reason },
      });
      expect(h.domain.inbox.countOpenFor('AR', 'owner')).toBe(0);
      await h.domain.memberQueue.recover();
      expect(operatorItems(h)).toEqual([]);
      expect(item(queueItem.id).state).toBe('handed_off');
    });

    it('keeps a no_typed_operation fix limit decision with the super side and its card held', async () => {
      const config = await h.domain.projects.config('AR');
      const created = h.domain.inbox.createFixLimitDecision(config, {
        projectKey: 'AR',
        taskKey: 'AR-1',
        assignees: ['owner'],
        fixLimit: {
          taskKey: 'AR-1',
          rounds: 3,
          limit: 3,
          changeRequests: 3,
          designChangeRequests: 0,
          sendBacks: 0,
          reason: 'passed_on',
          decider: 'lead',
          note: null,
        },
        options: [FIX_ANOTHER_ROUND_OPTION],
      });
      h.repos.taskFixLimits.save({
        taskKey: 'AR-1',
        projectKey: 'AR',
        countedFrom: null,
        extraRounds: 0,
        holdPhase: 'owner',
        heldAt: created.createdAt,
        decider: null,
        deciders: ['owner'],
        reason: 'passed_on',
        inboxItemId: created.id,
      });
      const { queueItem, ctx } = await working();
      const before = h.repos.taskFixLimits.get('AR-1');

      const result = await finish(ctx, queueItem.id, {
        outcome: 'handed_off',
        handoff: { reason: 'no_typed_operation', action: 'Review the fix history' },
      });

      expect(result.item).toMatchObject({ state: 'handed_off', outcome: { handoff: { to: 'super' } } });
      expect(h.domain.inbox.get('AR', created.id)).toMatchObject({
        state: 'open',
        assignees: created.assignees,
        options: created.options,
        payload: { recipient: 'integrator', operatorHandoff: { reason: 'no_typed_operation' } },
      });
      expect(h.repos.taskFixLimits.get('AR-1')).toEqual(before);
    });

    it('serializes simultaneous super handoffs and keeps the first action', async () => {
      const opened = await openTodo();
      const { queueItem } = await working();
      const handoff = {
        queueItemId: queueItem.id,
        reason: 'no_grant' as const,
        action: 'Measure the hub',
        detail: null,
        operationId: null,
      };

      const results = await Promise.allSettled([
        h.domain.inbox.passOnToSuper('AR', opened.itemId, handoff),
        h.domain.inbox.passOnToSuper('AR', opened.itemId, { ...handoff, action: 'Restart the machine' }),
      ]);

      expect(results[0].status).toBe('fulfilled');
      expect(results[1]).toMatchObject({
        status: 'rejected',
        reason: { status: 403, code: 'super_relay_refused' },
      });
      expect(h.domain.inbox.get('AR', opened.itemId).payload.operatorHandoff).toEqual(handoff);
    });

    it('refuses a super handoff after the integrator todo was resolved', async () => {
      const opened = await openTodo();
      const { queueItem, ctx } = await working();
      await finish(ctx, queueItem.id);

      await expect(
        h.domain.inbox.passOnToSuper('AR', opened.itemId, {
          queueItemId: queueItem.id,
          reason: 'no_grant',
          action: 'Measure the hub',
          detail: null,
          operationId: null,
        }),
      ).rejects.toMatchObject({ status: 409, code: 'inbox_item_closed' });
    });

    it('still gives an owner_reserved todo to the owners', async () => {
      const opened = await openTodo();
      const { queueItem, ctx } = await working();

      const result = await finish(ctx, queueItem.id, {
        outcome: 'handed_off',
        handoff: { reason: 'owner_reserved', action: 'Choose the security setting' },
      });

      expect(result.item).toMatchObject({ state: 'handed_off', outcome: { handoff: { to: 'owner' } } });
      expect(questionPayloadOf(h.domain.inbox.get('AR', opened.itemId))).toMatchObject({
        recipient: 'owner',
      });
      expect(h.domain.inbox.countOpenFor('AR', 'owner')).toBe(1);
    });

    it('uses an owner_reserved operation question without opening a second owner todo', async () => {
      const opened = await openTodo();
      const { queueItem, ctx } = await working();
      const question = h.domain.inbox.create({
        projectKey: 'AR',
        kind: 'question',
        source: 'system',
        assignees: ['owner'],
        title: 'Approve deletion',
        payload: {},
        options: [{ id: 'yes', label: 'Yes', style: 'primary' }],
      });
      const at = new Date().toISOString();
      h.repos.superHandoffs.insertOperation({
        id: 'sop_owner',
        projectKey: 'AR',
        taskKey: null,
        keyId: 'key_test',
        requestId: 'request_test',
        handoffId: null,
        command: { kind: 'operate', operation: { op: 'member_retire', handle: 'dev-1' } },
        commandHash: 'hash',
        expectedConfigVersion: null,
        state: 'waiting_owner',
        ownerQuestionId: question.id,
        expiresAt: null,
        errorCode: null,
        revision: 0,
        createdAt: at,
        updatedAt: at,
      });

      const result = await finish(ctx, queueItem.id, {
        outcome: 'handed_off',
        handoff: {
          reason: 'owner_reserved',
          action: 'Approve deletion',
          operationId: 'sop_owner',
        },
      });

      expect(result.item).toMatchObject({
        state: 'handed_off',
        outcome: { handoff: { to: 'owner', inboxItemId: question.id } },
      });
      expect(h.domain.inbox.get('AR', opened.itemId).state).toBe('resolved');
      expect(h.domain.inbox.countOpenFor('AR', 'owner')).toBe(1);
    });

    it('refuses owner_reserved with an operation that does not exist', async () => {
      await openTodo();
      const { queueItem, ctx } = await working();

      const refused = await rejection(
        finish(ctx, queueItem.id, {
          outcome: 'handed_off',
          handoff: { reason: 'owner_reserved', action: 'Approve it', operationId: 'op_missing' },
        }),
        TeamToolError,
      );

      expect(refused.code).toBe('invalid');
      expect(item(queueItem.id).state).toBe('processing');
    });

    it('refuses a hand-off without a handoff and a fix option on a todo', async () => {
      await openTodo();
      const { queueItem, ctx } = await working();

      for (const extra of [{ outcome: 'handed_off' }, { outcome: 'done', fixLimitOption: 'replan' }] as const)
        expect((await rejection(finish(ctx, queueItem.id, extra), TeamToolError)).code).toBe('invalid');
    });
  });

  describe('when the Operator does not finish', () => {
    it('reminds it once in the same session, then hands the item to the super side as processing_failed', async () => {
      const opened = await openTodo();
      const { queueItem, ctx } = await working();

      endTurn(ctx.sessionId);
      await settle();
      expect(item(queueItem.id).state).toBe('processing');
      expect(h.repos.memberQueue.payload<{ reminded?: boolean }>(queueItem.id)).toMatchObject({
        reminded: true,
      });

      endTurn(ctx.sessionId);
      await settle();

      expect(item(queueItem.id)).toMatchObject({
        state: 'handed_off',
        outcome: { handoff: { reason: 'processing_failed', to: 'super' } },
      });
      expect(questionPayloadOf(h.domain.inbox.get('AR', opened.itemId))).toMatchObject({
        recipient: 'integrator',
        operatorHandoff: { reason: 'processing_failed' },
      });
    });

    it('puts the item back in the queue after the session was stopped, until the attempts run out', async () => {
      await openTodo();
      const { queueItem } = await working();
      expect(MEMBER_QUEUE_MAX_ATTEMPTS).toBeGreaterThan(1);

      let current = queueItem;
      for (let attempt = 1; attempt < MEMBER_QUEUE_MAX_ATTEMPTS; attempt++) {
        await h.runner.stop(current.sessionId!);
        await h.domain.memberQueueDriver.ensure('AR', 'operator');
        await settle();
        const restarted = item(queueItem.id);
        expect(restarted).toMatchObject({ state: 'processing', attempts: attempt });
        expect(h.runner.started).toHaveLength(attempt + 1);
        current = restarted;
      }
      await h.runner.stop(current.sessionId!);
      await h.domain.memberQueueDriver.ensure('AR', 'operator');
      await settle();

      expect(item(queueItem.id)).toMatchObject({
        state: 'handed_off',
        outcome: { handoff: { reason: 'processing_failed' } },
      });
    });
  });

  describe('answering the question of an AI member (PM-1009)', () => {
    const askAs = (askedBy: string, obligation?: { id: string; kind: 'start'; responsible: string }) =>
      h.domain.inbox.openIntegratorTodo({
        projectKey: 'AR',
        taskKey: 'AR-1',
        askedBy,
        question: 'May I rerun the flaky test?',
        todo,
        ...(obligation ? { obligation: { ...obligation, openedAt: new Date().toISOString() } } : {}),
      });
    const answer = (ctx: ToolContext, itemId: string, extra: Record<string, unknown> = {}) =>
      finish(ctx, itemId, { outcome: 'answered', answer: 'Yes, rerun it once.', ...extra });

    it('delivers the answer to the asker as the Operator’s, closes the todo and the row', async () => {
      const opened = await askAs('dev-1');
      const { queueItem, ctx } = await working();

      const result = await answer(ctx, queueItem.id, { summary: 'A known flaky test.' });

      expect(result.item).toMatchObject({ state: 'done', outcome: { summary: 'A known flaky test.' } });
      const resolved = h.domain.inbox.get('AR', opened.itemId);
      expect(resolved).toMatchObject({
        state: 'resolved',
        resolution: { rule: 'operator_answered', by: 'operator', note: 'Yes, rerun it once.' },
      });
      expect(resolved.resolution).not.toHaveProperty('integratorTodo');
      const sent = h.repos.messages.list('AR').find((m) => m.body.includes('Yes, rerun it once.'));
      expect(sent).toMatchObject({ from: 'operator' });
      expect(sent?.body).not.toContain('integrator resolved');
    });

    it('lets the asker ask the answered question again, once', async () => {
      const opened = await askAs('dev-1');
      const { queueItem, ctx } = await working();
      await answer(ctx, queueItem.id);

      const dev = { projectKey: 'AR', member: 'dev-1', sessionId: 'ses_dev', taskKey: 'AR-1' };
      const again = await h.domain.teamTools.askHuman(dev, {
        question: 'Really?',
        recipient: 'integrator',
        reaskOf: opened.itemId,
        reaskReason: 'The test failed again.',
      });

      expect(again.screening).toBeUndefined();
      expect(
        await rejection(
          h.domain.teamTools.askHuman(dev, {
            question: 'Really?',
            recipient: 'integrator',
            reaskOf: opened.itemId,
            reaskReason: 'Once more.',
          }),
          Error,
        ),
      ).toHaveProperty('message', expect.stringContaining('already asked again'));
    });

    it('refuses the answer on a todo the system opened, and on one with no answer', async () => {
      await askAs('pm', { id: 'obl_start', kind: 'start', responsible: 'dev-1' });
      const { queueItem, ctx } = await working();

      expect((await rejection(answer(ctx, queueItem.id), TeamToolError)).message).toContain(
        'question_not_answerable',
      );
      expect((await rejection(finish(ctx, queueItem.id, { outcome: 'answered' }), TeamToolError)).code).toBe(
        'invalid',
      );
      expect(item(queueItem.id).state).toBe('processing');
    });

    it('refuses an answer on a todo of a non-AI asker', async () => {
      await askAs('system');
      const { queueItem, ctx } = await working();

      expect((await rejection(answer(ctx, queueItem.id), TeamToolError)).message).toContain(
        'question_not_answerable',
      );
    });

    it('refuses an answer on a message, and an answer next to another outcome', async () => {
      await h.domain.messaging.send(
        'AR',
        'dev-1',
        { to: ['operator'], text: 'Please look at the hub.', taskKey: 'AR-1' },
        { kind: 'action' },
      );
      const message = await working();
      expect((await rejection(answer(message.ctx, message.queueItem.id), TeamToolError)).code).toBe(
        'invalid',
      );
      expect(
        (await rejection(finish(message.ctx, message.queueItem.id, { answer: 'Yes' }), TeamToolError)).code,
      ).toBe('invalid');
    });

    it('refuses the answer once the item was closed meanwhile', async () => {
      const opened = await askAs('dev-1');
      const { queueItem, ctx } = await working();
      await h.domain.inbox.resolveForOperatorQueue('AR', opened.itemId, 'todo_done', 'Done', 'operator');
      await flush();

      const refused = await rejection(answer(ctx, queueItem.id), TeamToolError);

      expect(refused.message).toContain('queue_item_not_processing');
    });
  });

  describe('messages', () => {
    const record = (from: string, kind: 'action' | 'info') =>
      h.domain.messaging.send(
        'AR',
        from,
        { to: ['operator'], text: 'Please look at the hub.', taskKey: 'AR-1' },
        { kind },
      );

    it('wakes the Operator for an action message of an AI member and ends the item with finish_queue_item', async () => {
      await record('dev-1', 'action');
      const { queueItem, ctx } = await working();
      expect(queueItem.kind).toBe('message');

      const result = await finish(ctx, queueItem.id, { summary: 'Looked at it.' });

      expect(result.item).toMatchObject({ state: 'done', outcome: { summary: 'Looked at it.' } });
    });

    it('does not wake the Operator for an information message of an AI member', async () => {
      await record('dev-1', 'info');
      await settle();

      expect(h.runner.started.some((spec) => spec.member === 'operator')).toBe(false);
    });

    it('opens a super todo for a handed-off message without queueing that todo for the Operator', async () => {
      await record('dev-1', 'action');
      const { queueItem, ctx } = await working();

      const result = await finish(ctx, queueItem.id, {
        outcome: 'handed_off',
        handoff: { reason: 'no_typed_operation', action: 'Inspect the machine' },
      });

      expect(result.item).toMatchObject({ state: 'handed_off', outcome: { handoff: { to: 'super' } } });
      const created = h.domain.inbox.get('AR', result.item.outcome!.handoff!.inboxItemId);
      expect(questionPayloadOf(created)).toMatchObject({
        recipient: 'integrator',
        requestedRecipient: 'integrator',
        operatorHandoff: { reason: 'no_typed_operation' },
        screening: { todo: { recipient: 'integrator' } },
      });
      await h.domain.memberQueue.recover();
      expect(operatorItems(h)).toEqual([]);
      expect(h.domain.inbox.countOpenFor('AR', 'owner')).toBe(0);
    });
  });

  it('starts the Operator for its queue although the project cap of running AI sessions is reached', async () => {
    await h.domain.stop();
    await h.cleanup();
    h = await createDomainHarness({
      adjust: (config) => void (config.team.limits.maxConcurrentAi = 1),
      integratorTodoAccess: { available: integratorSideAvailable },
    });
    await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'general' });
    const opened = await openTodo();

    const { queueItem } = await working();

    expect(queueItem.source).toMatchObject({ inboxItemId: opened.itemId });
    expect(h.runner.started.some((spec) => spec.member === 'operator')).toBe(true);
  });

  describe('when the Operator becomes unavailable', () => {
    it('gives the open todo to the owners only after the Operator is removed', async () => {
      const opened = await openTodo();
      await settle();
      // A restored configuration can lack the fixed Operator; normal config edits cannot remove it.
      const config = structuredClone(await h.domain.projects.config('AR'));
      config.team.members = config.team.members.filter((member) => member.handle !== 'operator');
      vi.spyOn(h.domain.projects, 'config').mockResolvedValue(config);

      await h.domain.inbox.sweepIntegratorTodos();
      await settle();

      const moved = h.domain.inbox.get('AR', opened.itemId);
      expect(moved.state).toBe('open');
      expect(moved.assignees).toContain('owner');
      expect(moved.payload).toMatchObject({
        recipient: 'owner',
        integratorEscalationReason: 'integrator_unavailable',
      });
      expect(operatorItems(h)).toEqual([]);
    });
  });

  describe('when the Operator cannot be woken', () => {
    it.each(['ai_off', 'on_leave'] as const)(
      'keeps the todo queued for the integrator with %s',
      async (state) => {
        const config = structuredClone(await h.domain.projects.config('AR'));
        if (state === 'ai_off') config.team.limits.aiEnabled = false;
        else {
          const operator = config.team.members.find((member) => member.handle === 'operator')!;
          if (operator.kind === 'ai') operator.onLeave = true;
        }
        vi.spyOn(h.domain.projects, 'config').mockResolvedValue(config);
        vi.spyOn(h.domain.projects, 'cachedConfig').mockReturnValue(config);
        const opened = await openTodo();
        await settle();

        expect(questionPayloadOf(h.domain.inbox.get('AR', opened.itemId))).toMatchObject({
          recipient: 'integrator',
        });
        await h.domain.inbox.sweepIntegratorTodos();
        expect(h.repos.memberQueue.listOpen('AR', 'operator')).toMatchObject([{ state: 'queued' }]);
        expect(h.domain.inbox.countOpenFor('AR', 'owner')).toBe(0);
      },
    );
  });
});
