import { afterEach, describe, expect, it, vi } from 'vitest';
import { memberOf } from '@projectman/shared';
import type { AiMemberConfig, ProjectConfig } from '@projectman/shared';
import type { ToolContext } from '../src/contracts';
import { formatMemberStart } from '../src/mcp/format';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

let h: DomainHarness;
let ctx: ToolContext;
afterEach(() => h?.cleanup());
const by = { actor: OWNER_ACTOR, author: OWNER };

async function setup(adjust?: (config: ProjectConfig) => void) {
  h = await createDomainHarness({
    adjust: (config) => {
      config.team.members.push({
        ...(memberOf(config, 'dev-1') as AiMemberConfig),
        handle: 'devops',
        displayName: 'Devops',
        role: 'devops',
      });
      adjust?.(config);
    },
  });
  await h.domain.messaging.sendReporting('AR', 'owner', { to: ['operator'], text: 'Check the engine.' });
  await flush();
  ctx = {
    projectKey: 'AR',
    member: 'operator',
    taskKey: null,
    sessionId: h.domain.sessions.list('AR', { member: 'operator' })[0]!.id,
  };
}
const start = () => h.domain.teamTools.startMember(ctx, { member: 'devops', text: 'Check the engine.' });
const steps = () => h.repos.operatorRequests.steps(h.repos.operatorRequests.latest('AR', 1)[0]!.id);

describe('Operator member starts without a card (PM-546)', () => {
  it('starts a general conversation with the task and logs one unapproved start step', async () => {
    await setup();
    const result = await start();
    const session = h.domain.sessions.list('AR', { member: 'devops' })[0]!;
    expect(session.workItem).toEqual({ type: 'general' });
    expect(result.recipient).toEqual({
      handle: 'devops',
      delivery: 'wake',
      start: { state: 'started', sessionId: session.id },
    });
    expect(h.runner.started.find((s) => s.sessionId === session.id)!.initialMessage).toContain(
      'Check the engine.',
    );
    expect(h.repos.messages.get(result.messageId)).toMatchObject({
      from: 'operator',
      to: ['devops'],
      taskKey: null,
      kind: 'action',
    });
    expect(steps()).toMatchObject([
      { action: 'task_start', taskKey: null, member: 'devops', status: 'done' },
    ]);
    expect(formatMemberStart(result)).toContain(session.id);
  });

  it('reports leave and retries the stored task when leave ends', async () => {
    await setup((config) => {
      (memberOf(config, 'devops') as AiMemberConfig).onLeave = true;
    });
    const result = await start();
    expect(result.recipient.start).toEqual({ state: 'waiting', reason: 'member_on_leave' });
    expect(h.domain.sessions.list('AR', { member: 'devops' })).toEqual([]);
    await h.domain.members.update('AR', 'devops', { onLeave: false }, by);
    await h.domain.admission.retryDeferred();
    await vi.waitFor(() => expect(h.domain.sessions.list('AR', { member: 'devops' })).toHaveLength(1));
    expect(h.runner.started.at(-1)!.initialMessage).toContain('Check the engine.');
  });

  it('reports a paused project without losing the task', async () => {
    await setup();
    await h.domain.pauses.pause({ scope: 'project', projectKey: 'AR' }, { userId: null, source: 'system' });
    expect((await start()).recipient.start).toEqual({ state: 'waiting', reason: 'team_paused' });
  });

  it.each(['idle', 'working'] as const)(
    'delivers to a %s general session without another start',
    async (state) => {
      await setup();
      const first = await start();
      const sessionId = first.recipient.start!.state === 'started' ? first.recipient.start!.sessionId : '';
      h.runner.setState(sessionId, state);
      await flush();
      const count = h.runner.started.length;
      const result = await start();
      expect(result.recipient.delivery).toBe(state === 'idle' ? 'typed_now' : 'after_turn');
      expect(h.runner.started).toHaveLength(count);
    },
  );

  it('reports a failed start with its reason', async () => {
    await setup();
    h.runner.failNextStart = new Error('Cannot start the fake runner');
    const result = await start();
    expect(result.recipient.start).toMatchObject({ state: 'failed', code: expect.any(String) });
    expect(formatMemberStart(result)).toContain('the start failed');
  });

  it.each([
    ['owner', 'invalid', 'not_ai_member'],
    ['operator', 'invalid', 'cannot_start_self'],
    ['unknown', 'not_found', 'Unknown team member'],
  ])('refuses recipient %s before sending', async (member, code, message) => {
    await setup();
    const before = h.repos.messages.list('AR');
    await expect(h.domain.teamTools.startMember(ctx, { member, text: 'Work' })).rejects.toMatchObject({
      code,
      message: expect.stringContaining(message),
    });
    expect(h.repos.messages.list('AR')).toEqual(before);
    expect(steps().at(-1)).toMatchObject({ action: 'task_start', status: 'refused' });
  });

  it('refuses non-Operators and a closed owner request before sending', async () => {
    await setup();
    const before = h.repos.messages.list('AR');
    await expect(
      h.domain.teamTools.startMember({ ...ctx, member: 'dev-1' }, { member: 'devops', text: 'Work' }),
    ).rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('operator_only') });
    h.runner.setState(ctx.sessionId, 'working');
    h.runner.setState(ctx.sessionId, 'idle');
    await flush();
    await expect(start()).rejects.toMatchObject({
      code: 'forbidden',
      message: expect.stringContaining('operator_no_request'),
    });
    expect(h.repos.messages.list('AR')).toEqual(before);
  });

  it('refuses a guest conversation and logs the refusal without a task message', async () => {
    await setup((config) => {
      config.team.members.push({
        kind: 'human',
        handle: 'guest',
        displayName: 'Guest',
        access: 'developer',
        roles: [],
        email: 'guest@example.test',
      });
    });
    h.runner.setState(ctx.sessionId, 'working');
    h.runner.setState(ctx.sessionId, 'idle');
    await flush();
    await h.domain.sessions.close('AR', ctx.sessionId, { kind: 'idle', idleMinutes: 5 });
    await h.domain.messaging.sendReporting(
      'AR',
      'guest',
      { to: ['operator'], text: 'Start devops.' },
      { awaitWake: true },
    );
    await flush();
    ctx.sessionId = h.domain.sessions
      .list('AR', { member: 'operator' })
      .find((s) => s.workItem.type === 'general' && s.workItem.with === 'guest')!.id;
    const before = h.repos.messages.list('AR');
    await expect(start()).rejects.toMatchObject({
      code: 'forbidden',
      message: expect.stringContaining('operator_owner_only'),
    });
    expect(h.repos.messages.list('AR')).toEqual(before);
    expect(steps().at(-1)).toMatchObject({ action: 'task_start', status: 'refused' });
  });
});
