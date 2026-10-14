import { afterEach, describe, expect, it } from 'vitest';
import type { AiMemberConfig, ProjectConfig } from '@projectman/shared';
import { TeamToolError } from '../../../contracts';
import type { MessageStateReport, ToolContext } from '../../../contracts';
import { aiActor } from '../../../kernel';
import { WAKE_REPLY_WAIT_MS } from '../messaging';
import { formatProjectState, formatSentMessage } from '../../../mcp/format';
import { createDomainHarness, OWNER_ACTOR } from '../../../../test/helpers/domain-harness';
import type { DomainHarness } from '../../../../test/helpers/domain-harness';
import { flush } from '../../../../test/helpers/fakes';

let h: DomainHarness;
afterEach(() => h?.cleanup());

const BY = { userId: null, source: 'system' } as const;
const PROJECT = { scope: 'project', projectKey: 'AR' } as const;

function ai(config: ProjectConfig, handle: string): AiMemberConfig {
  return config.team.members.find((m) => m.handle === handle) as AiMemberConfig;
}

/** A project whose Operator may write: the owner asked it something, so a request is open. */
async function setup(adjust?: (config: ProjectConfig) => void): Promise<void> {
  h = await createDomainHarness({ adjust });
  await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
  await h.domain.messaging.sendReporting('AR', 'owner', { to: ['operator'], text: 'Wake dev-1 up' });
  await flush();
}

const operatorTool = (): ToolContext => ({
  projectKey: 'AR',
  member: 'operator',
  sessionId: h.domain.sessions.list('AR', { member: 'operator' })[0]!.id,
  taskKey: null,
});

const stateOf = async (messageId: string): Promise<MessageStateReport> =>
  (await h.domain.teamTools.getProjectState(operatorTool(), { messageId })) as MessageStateReport;

describe('the Operator learns what became of its message (PM-543)', () => {
  it('starts the general session of a member without one, and reports it', async () => {
    await setup();
    const result = await h.domain.teamTools.sendMessage(operatorTool(), {
      to: ['dev-1'],
      text: 'Please look at the open cards.',
      kind: 'action',
    });
    const session = h.domain.sessions.list('AR', { member: 'dev-1' })[0]!;
    expect(session.workItem).toEqual({ type: 'general' });
    expect(result.recipients).toEqual([
      { handle: 'dev-1', delivery: 'wake', start: { state: 'started', sessionId: session.id } },
    ]);
    expect(result.operator).toBe(true);
    const state = await stateOf(result.messageId);
    expect(state.recipients[0]).toMatchObject({
      handle: 'dev-1',
      human: false,
      route: { type: 'general' },
      session: { id: session.id },
      waiting: null,
      lastStartFailure: null,
      noWake: null,
      stale: null,
    });
  });

  it('says a member on leave waits, and get_project_state says the same', async () => {
    await setup((config) => {
      ai(config, 'dev-1').onLeave = true;
    });
    const result = await h.domain.teamTools.sendMessage(operatorTool(), {
      to: ['dev-1'],
      text: 'Please look at the open cards.',
      kind: 'action',
    });
    expect(result.recipients[0]).toMatchObject({
      delivery: 'wake',
      start: { state: 'waiting', reason: 'member_on_leave' },
    });
    expect(h.domain.sessions.list('AR', { member: 'dev-1' })).toEqual([]);
    const state = await stateOf(result.messageId);
    expect(state.recipients[0]).toMatchObject({
      deliveredAt: null,
      session: null,
      waiting: { reason: 'member_on_leave' },
    });
    const text = formatProjectState(state);
    expect(text).toContain('member_on_leave');
    expect(text).toContain('no live session');
  });

  it('says a paused project waits', async () => {
    await setup();
    await h.domain.pauses.pause(PROJECT, BY);
    const result = await h.domain.teamTools.sendMessage(operatorTool(), {
      to: ['dev-1'],
      text: 'Please look at the open cards.',
      kind: 'action',
    });
    expect(result.recipients[0]).toMatchObject({ start: { state: 'waiting', reason: 'team_paused' } });
    expect((await stateOf(result.messageId)).recipients[0]!.waiting).toMatchObject({ reason: 'team_paused' });
    // Once the pause ends the start goes through and the state reads that too.
    await h.domain.pauses.resume(PROJECT, BY);
    await h.domain.admission.retryDeferred();
    await flush();
    const after = (await stateOf(result.messageId)).recipients[0]!;
    expect(after.waiting).toBeNull();
    expect(after.session).not.toBeNull();
  });

  it('reports a start that fails with its code and remembers it', async () => {
    await setup();
    h.runner.failNextStart = new Error('the CLI cannot start');
    const result = await h.domain.teamTools.sendMessage(operatorTool(), {
      to: ['dev-1'],
      text: 'Please look at the open cards.',
      kind: 'action',
    });
    expect(result.recipients[0]!.start).toMatchObject({ state: 'failed' });
    const failure = (await stateOf(result.messageId)).recipients[0]!.lastStartFailure;
    expect(failure).toMatchObject({ code: expect.any(String) });
    expect(failure!.at).toMatch(/^\d{4}-/);
    expect(formatSentMessage({ ...result, requested: ['dev-1'], taskKey: null })).toContain(
      'the start failed',
    );
  });

  it('says an info message and a message about a closed card start nothing', async () => {
    await setup();
    const info = await h.domain.teamTools.sendMessage(operatorTool(), {
      to: ['dev-1'],
      text: 'Just so you know.',
      kind: 'info',
    });
    expect(info.recipients).toEqual([{ handle: 'dev-1', delivery: 'next_input', info: true }]);
    expect((await stateOf(info.messageId)).recipients[0]).toMatchObject({ noWake: 'info', stale: null });

    h.domain.tasks.cancel('AR', 'AR-1', { reason: 'Fictional scope change.' }, OWNER_ACTOR);
    const closed = await h.domain.teamTools.sendMessage(operatorTool(), {
      to: ['dev-1'],
      text: 'Please finish the login page.',
      kind: 'action',
      taskKey: 'AR-1',
    });
    expect(closed.recipients).toEqual([{ handle: 'dev-1', delivery: 'next_input', stale: 'card_closed' }]);
    expect(h.domain.sessions.list('AR', { member: 'dev-1' })).toEqual([]);
    expect((await stateOf(closed.messageId)).recipients[0]).toMatchObject({
      stale: 'card_closed',
      route: { type: 'general' },
    });
    const text = formatSentMessage({ ...closed, requested: ['dev-1'], taskKey: 'AR-1' });
    expect(text).toContain('AR-1 is closed');
    expect(text).not.toContain('ask a person');
  });

  it('never sends the Operator to a person for a member without a role on the card', async () => {
    await setup();
    const result = await h.domain.teamTools.sendMessage(operatorTool(), {
      to: ['dev-1'],
      text: 'Please look at this card.',
      kind: 'action',
      taskKey: 'AR-1',
    });
    // Another AI member's message to a member without a role keeps today's text.
    const other = await h.domain.messaging.sendReporting(
      'AR',
      'cr',
      { to: ['dev-1'], text: 'Please look at this card.', taskKey: 'AR-1' },
      { actor: aiActor('cr'), kind: 'action' },
    );
    expect(other.recipients[0]).toMatchObject({ noWake: 'no_card_role' });
    expect(
      formatSentMessage({
        messageId: 'm1',
        requested: ['dev-1'],
        deliveredTo: ['dev-1'],
        taskKey: 'AR-1',
        recipients: other.recipients,
      }),
    ).toContain('ask a person to bring them in');
    const asOperator = formatSentMessage({
      messageId: 'm2',
      requested: ['dev-1'],
      deliveredTo: ['dev-1'],
      taskKey: 'AR-1',
      recipients: other.recipients,
      operator: true,
    });
    expect(asOperator).not.toContain('ask a person');
    expect(asOperator).toContain('so this starts nothing. They get it the next time they work on AR-1.');
    // The Operator's own send is told the fact, without the advice.
    expect(result.recipients[0]).toMatchObject({ delivery: 'next_input', noWake: 'no_card_role' });
    expect(formatSentMessage({ ...result, requested: ['dev-1'], taskKey: 'AR-1' })).not.toContain(
      'ask a person',
    );
  });

  it('answers "starting" when the start is not decided within the wait, and it goes on', async () => {
    await setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    h.domain.messaging.registerWaker(
      {
        wake: async (projectKey, handle, workItem) => {
          await gate;
          return h.domain.messageStarts.wake(projectKey, handle, workItem);
        },
      },
      20,
    );
    const result = await h.domain.teamTools.sendMessage(operatorTool(), {
      to: ['dev-1'],
      text: 'Please look at the open cards.',
      kind: 'action',
    });
    expect(result.recipients[0]).toEqual({ handle: 'dev-1', delivery: 'wake', start: { state: 'starting' } });
    expect(formatSentMessage({ ...result, requested: ['dev-1'], taskKey: null })).toContain(
      `get_project_state message_id ${result.messageId}`,
    );
    release();
    await flush();
    expect((await stateOf(result.messageId)).recipients[0]!.session).not.toBeNull();
  });

  it('refuses message_id together with task_key, and an unknown message', async () => {
    await setup();
    await expect(
      h.domain.teamTools.getProjectState(operatorTool(), { messageId: 'msg_x', taskKey: 'AR-1' }),
    ).rejects.toBeInstanceOf(TeamToolError);
    await expect(
      h.domain.teamTools.getProjectState(operatorTool(), { messageId: 'msg_unknown' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('another sender is not slowed by the start (PM-543)', () => {
  it('does not wait for the wake-up, reports no start, and still emits message_waiting', async () => {
    h = await createDomainHarness();
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
    const waiting: string[] = [];
    h.domain.ctx.events.on('message_waiting', (e) => void waiting.push(e.handle));
    let calls = 0;
    h.domain.messaging.registerWaker({
      wake: async () => {
        calls++;
        return { state: 'starting' };
      },
    });
    const sent = await h.domain.messaging.sendReporting(
      'AR',
      'cr',
      { to: ['dev-1'], text: 'Question about the cart.' },
      { actor: aiActor('cr'), kind: 'action' },
    );
    expect(sent.recipients).toEqual([{ handle: 'dev-1', delivery: 'wake' }]);
    expect(waiting).toEqual(['dev-1']);
    expect(calls).toBe(0);
    expect(WAKE_REPLY_WAIT_MS).toBe(5000);
  });
});
