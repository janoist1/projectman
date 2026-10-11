import { afterEach, describe, expect, it } from 'vitest';
import { OperatorChannel, routes } from '@projectman/shared';
import type { ProjectConfig, Session } from '@projectman/shared';
import { TeamToolError } from '../src/contracts';
import type { ToolContext } from '../src/contracts';
import { OPERATOR_GUEST_TOOLS } from '../src/domain/operator-requests';
import { humanActor } from '../src/domain/util';
import { canSeeProjectEvent } from '../src/domain/visibility';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { addHumanAndLogin, createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { rejection } from './helpers/errors';
import { flush } from './helpers/fakes';

let h: DomainHarness;
let app: AppHarness | undefined;
afterEach(async () => {
  await h?.cleanup();
  await app?.close();
  app = undefined;
});

/** People who are no owner: a developer, a client and a read-only member. */
function withGuests(config: ProjectConfig): void {
  for (const [handle, access] of [
    ['dana', 'developer'],
    ['cleo', 'client'],
    ['vera', 'viewer'],
  ] as const)
    config.team.members.push({
      kind: 'human',
      handle,
      displayName: handle,
      email: `${handle}@example.test`,
      access,
      roles: [],
    });
}

async function setup(): Promise<void> {
  h = await createDomainHarness({ adjust: withGuests });
  await h.domain.tasks.create('AR', { title: 'Internal plan' }, OWNER_ACTOR);
  await h.domain.tasks.create('AR', { title: 'Shared page', visibility: 'shared' }, OWNER_ACTOR);
}

/** A person writes to the Operator with their own login. */
async function say(from: string, text = 'Hello') {
  const result = await h.domain.messaging.sendReporting('AR', from, { to: ['operator'], text });
  await flush();
  return result;
}
const operatorSessions = (): Session[] => h.domain.sessions.list('AR', { member: 'operator' });
const conversationWith = (handle: string): Session | undefined =>
  operatorSessions().find((s) => s.workItem.type === 'general' && s.workItem.with === handle);
const ownerConversation = (): Session | undefined =>
  operatorSessions().find((s) => s.workItem.type === 'general' && s.workItem.with === undefined);
const toolOf = (session: Session | undefined): ToolContext => ({
  projectKey: 'AR',
  member: 'operator',
  sessionId: session!.id,
  taskKey: null,
});
/** The Operator’s turn ends, and its conversation closes for being idle: the place is free for the next one. */
async function finish(session: Session | undefined): Promise<void> {
  h.runner.setState(session!.id, 'working');
  h.runner.setState(session!.id, 'idle');
  await flush();
  await h.domain.sessions.close('AR', session!.id, { kind: 'idle', idleMinutes: 5 });
  await flush();
}
const refusal = async (promise: Promise<unknown>) => (await rejection(promise, TeamToolError)).message;

describe('the Operator talks with every person in a conversation of their own (PM-475)', () => {
  it('wakes the client’s own conversation, which opens a request of theirs', async () => {
    await setup();
    await say('cleo', 'What is going on?');
    const session = conversationWith('cleo');
    expect(session).toBeDefined();
    expect(ownerConversation()).toBeUndefined();
    expect(h.runner.started).toHaveLength(1);
    expect(h.repos.operatorRequests.openOfSession(session!.id)).toMatchObject([{ fromHandle: 'cleo' }]);
  });

  it('gives two people two sessions, and keeps the owners in the shared general chat', async () => {
    await setup();
    await say('cleo');
    await finish(conversationWith('cleo'));
    await say('dana');
    await finish(conversationWith('dana'));
    await say('owner');
    expect(operatorSessions().map((s) => s.workItem)).toEqual(
      expect.arrayContaining([
        { type: 'general', with: 'cleo' },
        { type: 'general', with: 'dana' },
        { type: 'general' },
      ]),
    );
    expect(operatorSessions()).toHaveLength(3);
    // The same person comes back to the same conversation.
    await say('cleo', 'Again');
    expect(operatorSessions()).toHaveLength(3);
  });

  it('opens a conversation of their own when a person starts the Operator’s chat, the owners’ one for an owner', async () => {
    await setup();
    const dana = await h.domain.messageStarts.startConversation('AR', 'operator', humanActor('dana'));
    expect(dana.workItem).toEqual({ type: 'general', with: 'dana' });
    const owner = await h.domain.messageStarts.startConversation('AR', 'operator', OWNER_ACTOR);
    expect(owner.workItem).toEqual({ type: 'general' });
    expect(owner.id).not.toBe(dana.id);
  });

  it('does not wake for an AI member or the integrator key', async () => {
    await setup();
    const sent = await h.domain.messaging.sendReporting('AR', 'dev-1', { to: ['operator'], text: 'FYI' });
    expect(sent.recipients).toEqual([
      { handle: 'operator', delivery: 'next_input', noWake: 'operator_owner_only' },
    ]);
    expect(
      await rejection(
        h.domain.messaging.sendReporting(
          'AR',
          'owner',
          { to: ['operator'], text: 'Change it' },
          { actor: { ...OWNER_ACTOR, via: 'integrator' } },
        ),
      ),
    ).toMatchObject({ code: 'operator_owner_only', status: 403 });
    expect(h.runner.started).toHaveLength(0);
  });

  it('lets one guest conversation run at a time, and never makes the owner wait behind it', async () => {
    await setup();
    await say('cleo');
    expect(h.runner.started).toHaveLength(1);
    await say('dana');
    // The client’s session is still running (it only idles): the developer waits for the free place.
    expect(conversationWith('dana')).toBeUndefined();
    expect(h.runner.started).toHaveLength(1);
    const channel = await h.domain.projectManagerChannels.operatorView('AR', 'dana');
    expect(channel.sessionId).toBeNull();
    expect(channel).toMatchObject({
      readOnly: true,
      state: 'waiting',
      waiting: { reason: 'member_at_capacity' },
    });
    // The owner has the Operator at once.
    await say('owner');
    expect(ownerConversation()).toBeDefined();
    expect(h.runner.started).toHaveLength(2);
    const ownerChannel = OperatorChannel.parse(
      await h.domain.projectManagerChannels.operatorView('AR', 'owner'),
    );
    expect(ownerChannel).toMatchObject({ readOnly: false, sessionId: ownerConversation()!.id });
  });

  it('closes a guest’s conversation after five idle minutes and starts the next waiting one', async () => {
    await setup();
    await say('cleo');
    const cleo = conversationWith('cleo')!;
    await say('dana');
    expect(conversationWith('dana')).toBeUndefined();
    await finish(cleo);
    expect(conversationWith('dana')).toBeDefined();
    // The client’s next message continues the same conversation.
    await say('cleo', 'Back again');
    expect(
      operatorSessions().filter((s) => s.workItem.type === 'general' && s.workItem.with === 'cleo'),
    ).toHaveLength(1);
  });
});

describe('the Operator only reads and answers in a guest’s conversation (PM-475)', () => {
  it('refuses a write with 403 and records it as a refused step', async () => {
    await setup();
    await say('cleo', 'Please move the card');
    const session = conversationWith('cleo');
    const message = await refusal(
      h.domain.teamTools.updateTask(toolOf(session), { taskKey: 'AR-2', title: 'Renamed' }),
    );
    expect(message).toMatch(/^operator_owner_only:/);
    const [request] = h.repos.operatorRequests.openOfSession(session!.id);
    expect(h.repos.operatorRequests.steps(request!.id)).toMatchObject([
      { action: 'task_update', status: 'refused', refusal: { code: 'operator_owner_only' } },
    ]);
    expect(h.domain.tasks.get('AR', 'AR-2').title).toBe('Shared page');
    const context = toolOf(session);
    for (const call of [
      () => h.domain.teamTools.createTask(context, { title: 'New card' }),
      () => h.domain.teamTools.saveMemory(context, { note: 'secret' }),
      () => h.domain.teamTools.getRemoteState(context, { taskKey: 'AR-2' }),
      () => h.domain.teamTools.listNetworkDenials(context),
      () => h.domain.teamTools.askHuman(context, { question: 'May I?' }),
    ])
      expect(await refusal(call())).toMatch(/^operator_owner_only:/);
  });

  it('keeps the project state closed to a guest until it has a viewer filter', async () => {
    await setup();
    await say('cleo', 'Why is the card stuck?');
    const guard = h.domain.teamTools['callerWithRequest'].bind(h.domain.teamTools);
    expect(await refusal(guard(toolOf(conversationWith('cleo')), 'get_project_state'))).toMatch(
      /^operator_owner_only:/,
    );
    expect(OPERATOR_GUEST_TOOLS.has('get_project_state')).toBe(false);
    expect([...OPERATOR_GUEST_TOOLS].sort()).toEqual([
      'get_task',
      'list_attachments',
      'list_members',
      'list_tasks',
      'read_attachment',
      'send_message',
    ]);
  });

  it('answers only the person it talks with', async () => {
    await setup();
    await say('cleo');
    const session = conversationWith('cleo');
    const send = (to: string[]) =>
      h.domain.teamTools.sendMessage(toolOf(session), { to, text: 'Here is the answer', kind: 'info' });
    await expect(send(['cleo'])).resolves.toMatchObject({ deliveredTo: ['cleo'] });
    for (const to of [['owner'], ['cleo', 'owner'], ['dev-1'], ['dana']])
      expect(await refusal(send(to))).toMatch(/^operator_owner_only:/);
    // An answer is no step, a refused one is.
    const [request] = h.repos.operatorRequests.openOfSession(session!.id);
    expect(h.repos.operatorRequests.steps(request!.id).map((s) => [s.action, s.status])).toEqual([
      ['message', 'refused'],
      ['message', 'refused'],
      ['message', 'refused'],
      ['message', 'refused'],
    ]);
  });

  it('shows a client only the cards shared with them', async () => {
    await setup();
    await say('cleo');
    const tool = toolOf(conversationWith('cleo'));
    expect(await refusal(h.domain.teamTools.getTask(tool, { taskKey: 'AR-1' }))).toMatch(/does not exist/);
    expect(await refusal(h.domain.teamTools.listAttachments(tool, { taskKey: 'AR-1' }))).toMatch(
      /does not exist/,
    );
    const shared = await h.domain.teamTools.getTask(tool, { taskKey: 'AR-2' });
    expect(shared.task.key).toBe('AR-2');
    expect(shared).not.toHaveProperty('cardQuestions');
    expect(shared).not.toHaveProperty('workingSessionIds');
    expect((await h.domain.teamTools.listTasks(tool, {})).map((t) => t.key)).toEqual(['AR-2']);
    // A developer sees the whole project, and reads it the same way.
    await finish(conversationWith('cleo'));
    await say('dana');
    const developer = toolOf(conversationWith('dana'));
    expect((await h.domain.teamTools.getTask(developer, { taskKey: 'AR-1' })).task.key).toBe('AR-1');
    expect((await h.domain.teamTools.listTasks(developer, {})).map((t) => t.key).sort()).toEqual([
      'AR-1',
      'AR-2',
    ]);
  });
});

describe('who sees the Operator’s sessions (PM-475)', () => {
  it('hides them from a developer, a client and a read-only member, over REST and the websocket filter', async () => {
    app = await createAppHarness({ app: { claudeTmpRoots: [] } });
    const owner = await setupOwner(app.app);
    await createProject(app, owner);
    const cookies = new Map<string, string>();
    for (const [handle, access] of [
      ['dana', 'developer'],
      ['cleo', 'client'],
      ['vera', 'viewer'],
    ] as const)
      cookies.set(handle, await addHumanAndLogin(app.app, { handle, access }));
    // The client asks the Operator with their own login.
    const sent = await inject(app.app, 'POST', routes.sendTeamMessage('AR'), cookies.get('cleo')!, {
      to: ['operator'],
      text: 'What is going on?',
    });
    expect(sent.statusCode).toBe(202);
    await flush();
    const { domain } = app.app.projectman;
    const session = domain.sessions.list('AR', { member: 'operator' })[0]!;
    expect(session.workItem).toEqual({ type: 'general', with: 'cleo' });

    const read = (cookie: string) =>
      inject(app!.app, 'GET', routes.session('AR', session.id), cookie, undefined);
    expect((await read(owner)).statusCode).toBe(200);
    for (const handle of ['dana', 'vera'])
      expect((await read(cookies.get(handle)!)).statusCode, handle).toBe(404);
    // The client has no access to sessions at all.
    expect((await read(cookies.get('cleo')!)).statusCode).toBeGreaterThanOrEqual(403);

    // Live events: the developer gets neither the session nor its chat.
    const isOperatorSession = (id: string) => domain.sessions.isOperatorSession(id);
    const developer = { access: 'developer', handle: 'dana' } as const;
    const upsert = { type: 'session_upserted', projectKey: 'AR', session } as const;
    const chat = { type: 'chat_appended', projectKey: 'AR', sessionId: session.id } as never;
    expect(canSeeProjectEvent(developer, upsert, undefined, isOperatorSession)).toBe(false);
    expect(canSeeProjectEvent(developer, chat, undefined, isOperatorSession)).toBe(false);
    expect(
      canSeeProjectEvent({ access: 'owner', handle: 'owner' }, upsert, undefined, isOperatorSession),
    ).toBe(true);
    expect(canSeeProjectEvent({ access: 'admin', handle: 'ada' }, chat, undefined, isOperatorSession)).toBe(
      true,
    );

    // A person’s channel shows their own conversation and nobody else’s.
    const mine = await inject(app.app, 'GET', routes.operator('AR'), cookies.get('cleo')!, undefined);
    expect(OperatorChannel.parse(mine.json())).toMatchObject({ readOnly: true, sessionId: session.id });
    const theirs = await inject(app.app, 'GET', routes.operator('AR'), cookies.get('dana')!, undefined);
    expect(OperatorChannel.parse(theirs.json())).toMatchObject({ readOnly: true, sessionId: null });
  });
});
