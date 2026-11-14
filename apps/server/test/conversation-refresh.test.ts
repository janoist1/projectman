import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDomainHarness, OWNER } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { settle } from './helpers/fakes';
import type { ToolContext } from '../src/contracts';

/*
 * PM-1461: the project manager's long general conversation continues in a new one, with a server-built
 * handover. The context window is the default 200000 tokens, so the refresh is due above 120000.
 */

const NOW = '2026-11-14T10:00:00.000Z';
const OPEN_ABOVE = 120_000;
const GENERAL = { type: 'general' } as const;

describe('the refresh of the project manager general conversation (PM-1461)', () => {
  let h: DomainHarness;
  let ctx: ToolContext;
  afterEach(() => h?.cleanup());

  beforeEach(async () => {
    h = await createDomainHarness({
      adjust: (config) => {
        const pm = config.team.members.find((candidate) => candidate.handle === 'pm')!;
        if (pm.kind === 'ai') pm.onLeave = false;
      },
    });
    h.repos.users.insert({
      id: 'user-1',
      name: OWNER.name,
      email: OWNER.email,
      passwordHash: 'unused-test-hash',
      createdAt: NOW,
      language: 'hu',
    });
    h.runner.idleOnStart = true;
    const { session } = await h.domain.sessions.ensureSession('AR', 'pm', GENERAL);
    ctx = { projectKey: 'AR', member: 'pm', sessionId: session.id, taskKey: null };
    await settle();
  });

  const refresh = () => h.repos.sessions.conversationRefresh(ctx.sessionId);
  const measured = (contextTokens: number) =>
    h.runner.emit({ type: 'usage', sessionId: ctx.sessionId, entries: [], contextTokens });
  /** A turn ends: the session goes idle. */
  const turnEnds = async () => {
    h.runner.setState(ctx.sessionId, 'working');
    h.runner.setState(ctx.sessionId, 'idle');
    await settle();
  };
  /** The refresh looks at the session as an idle moment's listener does, without the other listeners. */
  const idleCheck = () => h.domain.conversationRefreshes.sessionIdle(h.repos.sessions.get(ctx.sessionId)!);
  const openRequest = (id = 'opr_refresh_1') =>
    h.repos.projectManagerRequests.insert({
      id,
      projectKey: 'AR',
      sessionId: ctx.sessionId,
      source: 'message',
      messageId: null,
      inboxItemId: null,
      fromHandle: 'owner',
      quote: 'Do it.',
      openedAt: NOW,
    });
  const asked = () => h.runner.messages.some((message) => message.text.includes('save_handover'));
  const restartEvents = () =>
    h.repos.timeline.list('AR', {}).filter((event) => event.type === 'session_conversation_restarted');
  /** An operation of the project manager that waits for an owner's yes. */
  async function waitingOperation() {
    openRequest('opr_refresh_op');
    const result = await h.domain.teamTools.operate(ctx, {
      title: 'Change developer access',
      operation: { op: 'member_update', handle: 'dev-1', changes: { outboundNetwork: false } },
    });
    h.repos.projectManagerRequests.close('opr_refresh_op', NOW);
    const operationId = h.repos.projectManagerRequests.steps('opr_refresh_op')[0]!.operationId!;
    return { operationId, itemId: result.inbox_item_id! };
  }

  describe('when the refresh starts', () => {
    it.each([
      [OPEN_ABOVE - 1, false],
      [OPEN_ABOVE, false],
      [OPEN_ABOVE + 1, true],
    ])('asks for the note at %i context tokens: %s', async (tokens, due) => {
      measured(tokens);
      await turnEnds();
      await settle();
      expect(refresh()?.state ?? null).toBe(due ? 'note_requested' : null);
      expect(asked()).toBe(due);
    });

    it('leaves a conversation without a measured context alone', async () => {
      await turnEnds();
      expect(refresh()).toBeNull();
    });

    it('leaves another member`s general conversation alone', async () => {
      const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', GENERAL);
      await settle();
      h.runner.emit({ type: 'usage', sessionId: session.id, entries: [], contextTokens: 190_000 });
      h.runner.setState(session.id, 'working');
      h.runner.setState(session.id, 'idle');
      await settle();
      expect(h.repos.sessions.conversationRefresh(session.id)).toBeNull();
    });

    it('waits while an owner request is open, and asks once it is closed', async () => {
      measured(OPEN_ABOVE + 1);
      openRequest();
      // The idle moment closes the session's requests first; a request that opens after that is still respected.
      await idleCheck();
      expect(refresh()).toBeNull();
      h.repos.projectManagerRequests.close('opr_refresh_1', NOW);
      await idleCheck();
      expect(refresh()?.state).toBe('note_requested');
    });

    it('waits while an operation of its own runs', async () => {
      const { operationId } = await waitingOperation();
      const stored = h.repos.superHandoffs.operation('AR', operationId)!;
      h.repos.superHandoffs.casOperation('AR', operationId, stored.revision, {
        state: 'running',
        updatedAt: NOW,
      });
      measured(OPEN_ABOVE + 1);
      await turnEnds();
      expect(refresh()).toBeNull();
      expect(h.runner.stopped).toEqual([]);
    });

    it('does not ask while a turn runs: a review request waits for the idle moment', async () => {
      h.runner.setState(ctx.sessionId, 'working');
      await expect(h.domain.conversationRefreshes.requestRefresh('AR', 'review')).resolves.toBe(true);
      expect(refresh()).toMatchObject({ state: 'note_requested', reason: 'review' });
      expect(refresh()?.askedAt).toBeUndefined();
      expect(asked()).toBe(false);
      expect(h.runner.stopped).toEqual([]);
      h.runner.setState(ctx.sessionId, 'idle');
      await vi.waitFor(() => expect(asked()).toBe(true));
      expect(refresh()?.askedAt).toBeDefined();
    });
  });

  describe('save_handover', () => {
    it('is not saved while no note is asked for', async () => {
      await expect(h.domain.teamTools.saveHandover(ctx, { note: 'Remember this.' })).resolves.toEqual({
        saved: false,
      });
      expect(refresh()).toBeNull();
    });

    it('keeps the note and readies the refresh when it is asked for', async () => {
      measured(OPEN_ABOVE + 1);
      await turnEnds();
      await expect(
        h.domain.teamTools.saveHandover(ctx, { note: ' I wait for the budget.  ' }),
      ).resolves.toEqual({
        saved: true,
      });
      expect(refresh()).toMatchObject({ state: 'pending', note: 'I wait for the budget.' });
    });

    it('is refused outside the project manager general conversation', async () => {
      const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', GENERAL);
      await expect(
        h.domain.teamTools.saveHandover(
          { projectKey: 'AR', member: 'dev-1', sessionId: session.id, taskKey: null },
          { note: 'Not mine.' },
        ),
      ).rejects.toMatchObject({ code: 'forbidden' });
    });

    it('is refused in a conversation the project manager has with someone else', async () => {
      const { session } = await h.domain.sessions.ensureSession('AR', 'pm', {
        type: 'general',
        with: 'dev-1',
      });
      await expect(
        h.domain.teamTools.saveHandover(
          { projectKey: 'AR', member: 'pm', sessionId: session.id, taskKey: null },
          { note: 'Not here.' },
        ),
      ).rejects.toMatchObject({ code: 'forbidden' });
    });
  });

  describe('the switch', () => {
    /** The pm is asked, answers with its note, and goes idle: the process ends. */
    async function refreshed(note = 'I am waiting for the budget answer.') {
      measured(OPEN_ABOVE + 1);
      await turnEnds();
      await h.domain.teamTools.saveHandover(ctx, { note });
      await turnEnds();
      await vi.waitFor(() => expect(h.runner.stopped).toEqual([ctx.sessionId]));
    }

    it('does not end the process at the idle moment that asked for the note', async () => {
      measured(OPEN_ABOVE + 1);
      await turnEnds();
      expect(refresh()?.state).toBe('note_requested');
      expect(h.runner.stopped).toEqual([]);
    });

    it('starts a new conversation on the same session row, with the handover and without the old state', async () => {
      const { operationId } = await waitingOperation();
      const before = h.repos.sessions.get(ctx.sessionId)!;
      await refreshed();
      expect(h.repos.sessions.get(ctx.sessionId)!.id).toBe(ctx.sessionId);

      await h.domain.sessions.ensureSession('AR', 'pm', GENERAL);
      await vi.waitFor(() =>
        expect(h.runner.started.filter((spec) => spec.sessionId === ctx.sessionId)).toHaveLength(2),
      );
      // The context pack is told the conversation is new, with the note and the operation waiting for the owner.
      const previous = h.contextBuilder.inputs.at(-1)!.previousConversation;
      expect(previous).toMatchObject({
        reason: 'refreshed',
        handover: {
          note: 'I am waiting for the budget answer.',
          items: [
            expect.objectContaining({ kind: 'operation', text: expect.stringContaining('waiting_owner') }),
          ],
        },
      });
      expect(previous?.handover?.items[0]?.id).toBe(operationId);
      expect(h.repos.sessions.get(ctx.sessionId)!.claudeSessionId).not.toBe(before.claudeSessionId);
      expect(refresh()).toBeNull();
      expect(restartEvents()).toMatchObject([{ taskKey: null, data: { reason: 'refreshed' } }]);
    });

    it('hands over the open questions and the owners` recent answers of the project manager', async () => {
      const open = await h.domain.teamTools.askHuman(ctx, {
        question: 'Which budget line?',
        options: ['A', 'B'],
        ownerTopic: 'cost',
      });
      const answered = await h.domain.teamTools.askHuman(ctx, {
        question: 'Which font?',
        options: ['Serif', 'Sans'],
        ownerTopic: 'cost',
      });
      const serif = h.domain.inbox.get('AR', answered.inboxItemId).options[0]!;
      await h.domain.inbox.resolve(
        'AR',
        answered.inboxItemId,
        { optionId: serif.id },
        { handle: 'owner', access: 'owner' },
      );
      await refreshed();
      await h.domain.sessions.ensureSession('AR', 'pm', GENERAL);
      const items = h.contextBuilder.inputs.at(-1)!.previousConversation?.handover?.items ?? [];
      expect(items.map((item) => [item.kind, item.id])).toEqual([
        ['question', open.inboxItemId],
        ['answer', answered.inboxItemId],
      ]);
      expect(items[1]!.text).toContain('Serif');
    });

    it('runs the owner`s yes to an approval asked before the switch in the new conversation', async () => {
      const { operationId, itemId } = await waitingOperation();
      await refreshed();
      await h.domain.sessions.ensureSession('AR', 'pm', GENERAL);
      await settle();

      await h.domain.inbox.resolve('AR', itemId, { optionId: 'yes' }, { handle: 'owner', access: 'owner' });
      await vi.waitFor(() =>
        expect(['succeeded', 'failed']).toContain(h.domain.superHandoffs.operation('AR', operationId).state),
      );
      expect(h.domain.superHandoffs.operation('AR', operationId)).toMatchObject({
        state: 'succeeded',
        errorCode: null,
      });
    });

    it('goes on in the old process when an owner request opened before the end', async () => {
      measured(OPEN_ABOVE + 1);
      await turnEnds();
      await h.domain.teamTools.saveHandover(ctx, { note: 'Note.' });
      openRequest();
      await idleCheck();
      expect(refresh()?.state).toBe('pending');
      expect(h.runner.stopped).toEqual([]);
      h.repos.projectManagerRequests.close('opr_refresh_1', NOW);
      await idleCheck();
      await vi.waitFor(() => expect(h.runner.stopped).toEqual([ctx.sessionId]));
    });

    it('summarizes the old conversation when the project manager left no note', async () => {
      h.runner.emit({
        type: 'transcript_path',
        sessionId: ctx.sessionId,
        path: `/tmp/${ctx.sessionId}.jsonl`,
      });
      h.runnerModule.summaries.set(`/tmp/${ctx.sessionId}.jsonl`, {
        source: 'last_replies',
        text: 'The budget was discussed.',
        at: null,
      });
      await h.domain.sessions.stop('AR', ctx.sessionId, { kind: 'restart', restartFor: 'new_round' });
      await settle();
      // No process runs: the next start is the new conversation at once.
      await expect(h.domain.conversationRefreshes.requestRefresh('AR', 'review')).resolves.toBe(true);
      expect(refresh()?.state).toBe('pending');
      await h.domain.sessions.ensureSession('AR', 'pm', GENERAL);
      await vi.waitFor(() =>
        expect(h.runner.started.filter((spec) => spec.sessionId === ctx.sessionId)).toHaveLength(2),
      );
      expect(h.contextBuilder.inputs.at(-1)!.previousConversation).toMatchObject({
        reason: 'refreshed',
        summary: { text: 'The budget was discussed.' },
        handover: { note: null },
      });
    });
  });
});
