import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CardBusyDetails, memberOf } from '@projectman/shared';
import type { AiMemberConfig } from '@projectman/shared';
import { aiActor, SYSTEM_ACTOR } from '../src/kernel';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

describe('same-role card workers before sending', () => {
  let h: DomainHarness;
  beforeEach(async () => {
    h = await createDomainHarness({
      adjust: (config) => {
        config.team.members.push({ ...(memberOf(config, 'cr') as AiMemberConfig), handle: 'cr-2' });
      },
    });
    await h.domain.tasks.create('AR', { title: 'Checkout' }, OWNER_ACTOR);
  });
  afterEach(async () => {
    await h.cleanup();
    vi.restoreAllMocks();
  });

  const send = (
    to: string[],
    opts: Parameters<typeof h.domain.messaging.sendReporting>[3] = {},
    from = 'owner',
  ) =>
    h.domain.messaging.sendReporting(
      'AR',
      from,
      { to, text: 'Work on checkout.', taskKey: 'AR-1' },
      { workerCheck: true, ...opts },
    );
  async function run(member: string, taskKey = 'AR-1') {
    const { session } = await h.domain.sessions.ensureSession('AR', member, { type: 'task', taskKey });
    h.runner.setState(session.id, 'working');
    await flush();
    return session;
  }

  it('refuses two same-role recipients in one send before either starts', async () => {
    await expect(send(['dev-1', 'dev-2'])).rejects.toMatchObject({
      code: 'card_busy',
      status: 409,
      details: { taskKey: 'AR-1', groups: [{ role: 'developer', working: [], joining: ['dev-1', 'dev-2'] }] },
    });
    expect(h.runner.started).toEqual([]);
    expect(h.repos.messages.list('AR')).toEqual([]);
  });

  it('names the current worker and state when another member would join', async () => {
    await run('dev-1');
    await expect(send(['dev-2'])).rejects.toMatchObject({
      details: CardBusyDetails.parse({
        taskKey: 'AR-1',
        groups: [{ role: 'developer', working: [{ handle: 'dev-1', state: 'working' }], joining: ['dev-2'] }],
      }),
    });
  });

  it('permits developer and reviewer collaboration and addressing an existing worker', async () => {
    await run('dev-1');
    expect((await send(['cr'])).message.to).toEqual(['cr']);
    expect((await send(['dev-1'])).message.to).toEqual(['dev-1']);
  });

  it('excludes the sender from the other workers', async () => {
    await run('dev-1');
    expect((await send(['dev-2'], {}, 'dev-1')).message.to).toEqual(['dev-2']);
    // An answer bypasses the role-based wake restriction, so this recipient would actually join.
    expect(
      (await send(['dev-2'], { origin: { kind: 'answer', inboxItemId: 'ib_answer' } }, 'dev-1'))
        .recipients[0]!.delivery,
    ).toBe('wake');
  });

  it('excludes the outgoing handoff worker', async () => {
    await h.domain.taskStarts.start('AR', 'AR-1', { assignee: 'dev-1', actor: OWNER_ACTOR, author: OWNER });
    const session = await run('dev-1');
    h.runner.emit({ type: 'transcript_path', sessionId: session.id, path: `${h.dir}/conversation.jsonl` });
    await h.domain.tasks.update('AR', 'AR-1', { assignee: 'dev-2' }, OWNER_ACTOR);
    await flush();
    expect(h.domain.tasks.get('AR', 'AR-1').handoff?.from).toBe('dev-1');
    expect((await send(['dev-2'])).message.to).toEqual(['dev-2']);
  });

  it('MCP send_message reports the worker and permits an explicit override', async () => {
    const session = await run('dev-1');
    await run('cr');
    const ctx = { projectKey: 'AR', member: 'dev-1', taskKey: 'AR-1', sessionId: session.id };
    const args = { to: ['cr-2'], text: 'Review checkout.', kind: 'action' as const };
    const before = h.repos.messages.list('AR');
    await expect(h.domain.teamTools.sendMessage(ctx, args)).rejects.toMatchObject({
      code: 'invalid',
      message:
        'card_busy: AR-1: cr (working) already works on it as code_review; this message would also put cr-2 to work on it. Nothing was sent. Send it to the member already working, wait until they finish, send it as info, or send again with despite_workers: true if the parallel work is intended.',
    });
    expect(h.repos.messages.list('AR')).toEqual(before);
    expect(
      (await h.domain.teamTools.sendMessage(ctx, { ...args, despiteWorkers: true })).deliveredTo,
    ).toEqual(['cr-2']);
  });

  it('MCP send_message explains a collision between two new recipients', async () => {
    const session = await run('dev-1');
    await expect(
      h.domain.teamTools.sendMessage(
        { projectKey: 'AR', member: 'dev-1', taskKey: 'AR-1', sessionId: session.id },
        { to: ['cr-2', 'cr'], text: 'Review checkout.', kind: 'action' },
      ),
    ).rejects.toMatchObject({
      code: 'invalid',
      message: expect.stringContaining(
        'card_busy: AR-1: this message would put cr-2, cr to work on it as code_review. Nothing was sent.',
      ),
    });
  });

  it('PM start_member reports card_busy and permits an explicit override', async () => {
    await h.domain.members.update('AR', 'pm', { onLeave: false }, { actor: OWNER_ACTOR, author: OWNER });
    await h.domain.messaging.send('AR', 'owner', { to: ['pm'], text: 'Arrange checkout review.' });
    await flush();
    await run('cr');
    const session = h.domain.sessions.list('AR', { member: 'pm' })[0]!;
    const ctx = { projectKey: 'AR', member: 'pm', taskKey: null, sessionId: session.id };
    const args = { member: 'cr-2', taskKey: 'AR-1', text: 'Review checkout.' };
    const before = h.repos.messages.list('AR');
    await expect(h.domain.teamTools.startMember(ctx, args)).rejects.toMatchObject({
      code: 'invalid',
      message: expect.stringContaining('card_busy: AR-1: cr (working)'),
    });
    expect(h.repos.messages.list('AR')).toEqual(before);
    const result = await h.domain.teamTools.startMember(ctx, { ...args, despiteWorkers: true });
    expect(result.recipient.handle).toBe('cr-2');
    expect(result.recipient.start?.state).toBe('started');
  });

  it.each([false, undefined])(
    'permits opt-out or internal sends with workerCheck %s',
    async (workerCheck) => {
      expect((await send(['dev-1', 'dev-2'], { workerCheck })).message.to).toEqual(['dev-1', 'dev-2']);
    },
  );

  it('permits info even with workerCheck and leaves system notifications unchecked', async () => {
    await run('dev-1');
    expect((await send(['dev-2'], { kind: 'info', actor: aiActor('cr') }, 'cr')).recipients[0]).toMatchObject(
      { delivery: 'next_input', info: true },
    );
    expect(
      (await send(['dev-2'], { workerCheck: undefined, actor: SYSTEM_ACTOR }, 'system')).message.to,
    ).toEqual(['dev-2']);
  });

  it('does not count recipients that would not wake or that are held', async () => {
    await run('dev-1');
    expect((await send(['dev-2'], { actor: aiActor('cr') }, 'cr')).recipients[0]).toMatchObject({
      noWake: 'no_card_role',
    });
    h.domain.tasks.assign('AR', 'AR-1', 'dev-2', OWNER_ACTOR);
    h.domain.messaging.registerCardHold('fix_limit', { holds: () => true });
    expect((await send(['dev-2'], { actor: aiActor('cr') }, 'cr')).recipients[0]).toMatchObject({
      delivery: 'held',
      hold: 'fix_limit',
    });
  });

  it('does not count a recipient placed on a running family card', async () => {
    await h.domain.tasks.create('AR', { title: 'Cart', parentKey: 'AR-1' }, OWNER_ACTOR);
    await run('dev-1');
    await run('dev-2', 'AR-2');
    expect((await send(['dev-2'])).recipients[0]).toMatchObject({ delivery: 'after_turn' });
    await expect(send(['dev-2'], { ownCard: true })).rejects.toMatchObject({ code: 'card_busy' });
  });

  it('records no message, review request, repin, callback or event on refusal', async () => {
    h.domain.tasks.assign('AR', 'AR-1', 'dev-1', OWNER_ACTOR);
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', OWNER_ACTOR);
    await flush();
    const messages = h.repos.messages.list('AR');
    const timeline = h.domain.timeline.list('AR', { taskKey: 'AR-1' });
    const rounds = vi.spyOn(h.domain.sessions, 'requestReviewRound');
    const repin = vi.spyOn(h.domain.tasks, 'repinReview');
    const events = vi.spyOn(h.domain.bus, 'publish');
    const beforeRecord = vi.fn();
    await expect(
      send(['cr', 'cr-2'], { actor: aiActor('dev-1'), beforeRecord }, 'dev-1'),
    ).rejects.toMatchObject({ code: 'card_busy' });
    expect(rounds).not.toHaveBeenCalled();
    expect(repin).not.toHaveBeenCalled();
    expect(events).not.toHaveBeenCalled();
    expect(beforeRecord).not.toHaveBeenCalled();
    expect(h.repos.messages.list('AR')).toEqual(messages);
    expect(h.domain.timeline.list('AR', { taskKey: 'AR-1' })).toEqual(timeline);
  });
});
