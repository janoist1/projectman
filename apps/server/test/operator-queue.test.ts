import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MEMBER_QUEUE_MAX_ATTEMPTS, operatorQueueAvailable, questionPayloadOf } from '@projectman/shared';
import type { MemberQueueItem, ProjectConfig } from '@projectman/shared';
import { TeamToolError } from '../src/contracts';
import type { ToolContext } from '../src/contracts';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { rejection } from './helpers/errors';
import { flush, settle } from './helpers/fakes';

/**
 * The Operator's lane of the per-member work queue (PM-885): the todos and held fix round decisions the system
 * opens and the action messages of AI members wake the Operator one item at a time, and the Operator ends each
 * with `finish_queue_item` — done, or handed to the owner with a reason.
 */
const todo = { what: 'Measure the hub', where: 'Hub', expected: 'A latency report' };

const operatorItems = (h: DomainHarness): MemberQueueItem[] =>
  h.repos.memberQueue.listOpen('AR', 'operator').map((item) => h.domain.memberQueue.get(item.id)!);

describe('the Operator queue', () => {
  let h: DomainHarness;
  let available = true;
  beforeEach(async () => {
    available = true;
    h = await createDomainHarness({
      integratorTodoAccess: { available: (config) => available && operatorQueueAvailable(config) },
    });
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
  });
  afterEach(async () => {
    await h.domain.stop();
    await h.cleanup();
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

  describe('handing an item to the owner', () => {
    it.each(['no_grant', 'no_typed_operation'] as const)(
      'gives a todo to the owners with the reason %s and closes the queue item as handed off',
      async (reason) => {
        const opened = await openTodo();
        const { queueItem, ctx } = await working();

        const result = await finish(ctx, queueItem.id, {
          outcome: 'handed_off',
          handoff: { reason, action: 'Decide whether the hub may be measured' },
        });

        expect(result.item).toMatchObject({ state: 'handed_off', outcome: { handoff: { reason } } });
        const handed = h.domain.inbox.get('AR', opened.itemId);
        expect(handed.state).toBe('open');
        expect(handed.assignees).toContain('owner');
        expect(questionPayloadOf(handed)).toMatchObject({
          recipient: 'owner',
          operatorHandoff: { queueItemId: queueItem.id, reason },
        });
      },
    );

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
    it('reminds it once in the same session, then hands the item to the owner as processing_failed', async () => {
      const opened = await openTodo();
      const { queueItem, ctx } = await working();

      endTurn(ctx.sessionId);
      await settle();
      expect(item(queueItem.id).state).toBe('processing');
      expect(h.repos.memberQueue.payloadOf<{ reminded?: boolean }>(queueItem.id)).toMatchObject({
        reminded: true,
      });

      endTurn(ctx.sessionId);
      await settle();

      expect(item(queueItem.id)).toMatchObject({
        state: 'handed_off',
        outcome: { handoff: { reason: 'processing_failed' } },
      });
      expect(questionPayloadOf(h.domain.inbox.get('AR', opened.itemId))).toMatchObject({
        recipient: 'owner',
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
  });

  it('starts the Operator for its queue although the project cap of running AI sessions is reached', async () => {
    await h.domain.stop();
    await h.cleanup();
    h = await createDomainHarness({
      adjust: (config) => void (config.team.limits.maxConcurrentAi = 1),
      integratorTodoAccess: { available: operatorQueueAvailable },
    });
    await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'general' });
    const opened = await openTodo();

    const { queueItem } = await working();

    expect(queueItem.source).toMatchObject({ inboxItemId: opened.itemId });
    expect(h.runner.started.some((spec) => spec.member === 'operator')).toBe(true);
  });

  describe('when the Operator becomes unavailable', () => {
    it('gives the open todo and its queue item to the owners at the next sweep', async () => {
      const opened = await openTodo();
      await settle();
      available = false;

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
    const aiOff = (config: ProjectConfig): void => void (config.team.limits.aiEnabled = false);

    it('gives the todo to the owners at once', async () => {
      await h.domain.stop();
      await h.cleanup();
      h = await createDomainHarness({
        adjust: aiOff,
        integratorTodoAccess: { available: operatorQueueAvailable },
      });
      const opened = await openTodo();
      await settle();

      expect(questionPayloadOf(h.domain.inbox.get('AR', opened.itemId))).toMatchObject({
        recipient: 'owner',
      });
      expect(h.repos.memberQueue.listOpen('AR', 'operator')).toEqual([]);
    });
  });
});
