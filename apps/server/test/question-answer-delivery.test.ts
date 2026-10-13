import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

describe('question answer delivery (PM-560)', () => {
  let h: DomainHarness;
  afterEach(async () => {
    vi.restoreAllMocks();
    await h?.cleanup();
  });

  async function question() {
    h = await createDomainHarness();
    await h.domain.tasks.create('AR', { title: 'Layout' }, OWNER_ACTOR);
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', {
      type: 'task',
      taskKey: 'AR-1',
    });
    const asked = await h.domain.teamTools.askHuman(
      { projectKey: 'AR', member: 'dev-1', taskKey: 'AR-1', sessionId: session.id },
      { question: 'Which layout?', options: ['First', 'Second'] },
    );
    await h.domain.sessions.stop('AR', session.id);
    return asked.inboxItemId;
  }
  const answer = (id: string) =>
    h.domain.inbox.resolve('AR', id, { optionId: 'option_1' }, { handle: 'owner', access: 'owner' });
  const leave = (onLeave: boolean) =>
    h.domain.members.update('AR', 'dev-1', { onLeave }, { actor: OWNER_ACTOR, author: OWNER });
  const events = () =>
    h.domain.timeline.list('AR', { taskKey: 'AR-1' }).filter((e) => e.type === 'question_answer_delivery');

  it('restarts a stopped asker and returns delivery in the resolve response', async () => {
    const id = await question();
    const resolved = await answer(id);
    expect(resolved.payload.answerDelivery).toMatchObject({ state: 'delivered', at: expect.any(String) });
    await vi.waitFor(() => expect(h.repos.messages.pending('AR', 'dev-1')).toHaveLength(0));
    expect(h.runner.lastStarted().initialMessage).toContain('First');
    expect(events()).toHaveLength(0);
  });

  it('keeps an answer across a stage change while the asker is on leave', async () => {
    const id = await question();
    await leave(true);
    const resolved = await answer(id);
    expect(resolved.payload.answerDelivery).toMatchObject({
      state: 'waiting',
      reason: 'member_on_leave',
      since: expect.any(String),
    });
    expect(events().map((e) => e.data)).toEqual([
      { inboxItemId: id, asker: 'dev-1', state: 'waiting', reason: 'member_on_leave' },
    ]);
    const task = h.repos.tasks.get('AR-1')!;
    h.repos.tasks.update(task.id, { stageId: 'development' });
    expect(h.repos.tasks.get(task.key)?.stageId).toBe('development');
    const rebuilt = h.domain.messageStarts.rebuild({
      kind: 'message_wake',
      projectKey: 'AR',
      handle: 'dev-1',
      workItem: { type: 'task', taskKey: task.key },
      stageId: task.stageId,
    });
    expect(rebuilt.stillValid(h.domain.tasks.get('AR', task.key))).toBe(true);
    expect(rebuilt.spec()).toMatchObject({ stageId: 'development' });
    h.domain.admission.discardStale(h.domain.tasks.get('AR', task.key));
    expect(h.repos.deferredStarts.list()).toHaveLength(1);
    await leave(false);
    await h.domain.admission.retryDeferred();
    await vi.waitFor(() =>
      expect(h.domain.inbox.get('AR', id).payload.answerDelivery).toMatchObject({ state: 'delivered' }),
    );
    expect(h.runner.lastStarted().initialMessage).toContain('First');
    expect(events().map((e) => e.data.state)).toEqual(['waiting', 'delivered']);
  });

  it('records a deferral discovered after the bounded resolve wait', async () => {
    const id = await question();
    await leave(true);
    const check = h.domain.admission.check.bind(h.domain.admission);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(h.domain.admission, 'check').mockImplementationOnce(async (request) => {
      await gate;
      await check(request);
    });
    h.domain.messaging.useMessageStarts(h.domain.messageStarts, 1);
    const resolved = await answer(id);
    expect(resolved.payload.answerDelivery).toBeUndefined();
    release();
    await vi.waitFor(() =>
      expect(h.domain.inbox.get('AR', id).payload.answerDelivery).toMatchObject({
        state: 'waiting',
        reason: 'member_on_leave',
      }),
    );
    await leave(false);
    await h.domain.admission.retryDeferred();
    await vi.waitFor(() =>
      expect(h.domain.inbox.get('AR', id).payload.answerDelivery).toMatchObject({ state: 'delivered' }),
    );
    expect(events()).toHaveLength(2);
  });

  it('does not revive a deferred answer on a closed card', async () => {
    const id = await question();
    await leave(true);
    await answer(id);
    h.domain.tasks.cancel('AR', 'AR-1', { reason: 'No longer needed' }, OWNER_ACTOR);
    await leave(false);
    await h.domain.admission.retryDeferred();
    await flush();
    expect(h.domain.sessions.findRunning('AR', 'dev-1', { type: 'task', taskKey: 'AR-1' })).toBeNull();
    expect(h.repos.deferredStarts.list()).toHaveLength(0);
  });

  it.each(['question_forward', 'ordinary'] as const)(
    'handles a stage change for a %s message',
    async (kind) => {
      await question();
      await leave(true);
      await h.domain.messaging.sendReporting(
        'AR',
        'owner',
        { to: ['dev-1'], text: 'Follow up', taskKey: 'AR-1' },
        {
          awaitWake: true,
          ...(kind === 'question_forward'
            ? { origin: { kind: 'question_forward', inboxItemId: 'inb_forward' } as const }
            : {}),
        },
      );
      h.repos.tasks.update(h.repos.tasks.get('AR-1')!.id, { stageId: 'development' });
      h.domain.admission.discardStale(h.domain.tasks.get('AR', 'AR-1'));
      expect(h.repos.deferredStarts.list()).toHaveLength(kind === 'question_forward' ? 1 : 0);
      await leave(false);
      await h.domain.admission.retryDeferred();
      await flush();
      const running = h.domain.sessions.findRunning('AR', 'dev-1', { type: 'task', taskKey: 'AR-1' });
      if (kind === 'question_forward') {
        expect(running).not.toBeNull();
        expect(h.runner.lastStarted().initialMessage).toContain('Follow up');
      } else expect(running).toBeNull();
    },
  );

  it('previews leave and capacity without storing deferred starts', async () => {
    await question();
    const workItem = { type: 'task', taskKey: 'AR-1' } as const;
    expect(await h.domain.messageStarts.waitingReason('AR', 'dev-1', workItem)).toBeNull();
    await leave(true);
    expect(await h.domain.messageStarts.waitingReason('AR', 'dev-1', workItem)).toBe('member_on_leave');
    await leave(false);
    await h.domain.members.update('AR', 'dev-1', { capacity: 1 }, { actor: OWNER_ACTOR, author: OWNER });
    await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'general' });
    expect(await h.domain.messageStarts.waitingReason('AR', 'dev-1', workItem)).toBe('member_at_capacity');
    expect(h.repos.deferredStarts.list()).toHaveLength(0);
  });
});
