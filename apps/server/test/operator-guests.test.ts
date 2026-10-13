import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { OperatorChannel, routes } from '@projectman/shared';
import type { ProjectConfig, Session } from '@projectman/shared';
import { TeamToolError } from '../src/contracts';
import type { ToolContext } from '../src/contracts';
import { OPERATOR_GUEST_TOOLS } from '../src/domain/operator-requests';
import { humanActor } from '../src/domain/util';
import { buildClaudeArgs, buildSettings } from '../src/runner/providers/claude/args';
import { canSeeProjectEvent } from '../src/domain/visibility';
import { waitFor } from '../src/runner/test-helpers';
import { pdfBytes } from './helpers/attachments';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { addHumanAndLogin, createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { rejection } from './helpers/errors';
import { settle } from './helpers/fakes';

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

async function setup(opts: { appHome?: string; sessionFolders?: boolean } = {}): Promise<void> {
  h = await createDomainHarness({ adjust: withGuests, ...opts });
  await h.domain.tasks.create('AR', { title: 'Internal plan' }, OWNER_ACTOR);
  await h.domain.tasks.create('AR', { title: 'Shared page', visibility: 'shared' }, OWNER_ACTOR);
}

/** A person writes to the Operator with their own login. */
async function say(from: string, text = 'Hello', { waitsAtCapacity = false } = {}) {
  const result = await h.domain.messaging.sendReporting(
    'AR',
    from,
    { to: ['operator'], text },
    { awaitWake: true },
  );
  await settle();
  if (!waitsAtCapacity)
    await waitFor(
      () => {
        const session = from === 'owner' ? ownerConversation() : conversationWith(from);
        return (
          session &&
          h.runner.started.some((spec) => spec.sessionId === session.id) &&
          h.repos.messages.get(result.message.id)?.deliveredAt
        );
      },
      { what: `${from}’s message to reach the Operator conversation` },
    );
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
  await settle();
  await h.domain.sessions.close('AR', session!.id, { kind: 'idle', idleMinutes: 5 });
  await settle();
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
    const cleoId = conversationWith('cleo')!.id;
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
    expect(h.runner.started).toHaveLength(4);
    expect(h.runner.started.at(-1)).toMatchObject({ sessionId: cleoId });
    expect(h.runner.started.at(-1)!.initialMessage).toContain('Again');
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
    await say('dana', 'Hello', { waitsAtCapacity: true });
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
    // The owners' system signals never reach a person reading along.
    expect(channel).toMatchObject({ signals: [], openSignals: 0 });
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
    await say('dana', 'Hello', { waitsAtCapacity: true });
    expect(conversationWith('dana')).toBeUndefined();
    await finish(cleo);
    await waitFor(() => conversationWith('dana'), { what: 'the waiting Operator conversation' });
    expect(conversationWith('dana')).toBeDefined();
    // The client’s next message continues the same conversation.
    const back = await say('cleo', 'Back again', { waitsAtCapacity: true });
    await finish(conversationWith('dana'));
    await waitFor(() => h.repos.messages.get(back.message.id)?.deliveredAt, {
      what: 'the returning client’s message to reach the Operator conversation',
    });
    expect(h.runner.started.at(-1)).toMatchObject({ sessionId: cleo.id });
    expect(h.runner.started.at(-1)!.initialMessage).toContain('Back again');
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
      'read_message_attachment',
      'send_message',
    ]);
  });

  it('opens a message file for a guest only as that person, never one of someone else’s message', async () => {
    await setup();
    const sendFile = async (to: string, fileName: string) => {
      const file = await h.domain.messageAttachments.upload({
        projectKey: 'AR',
        actor: OWNER_ACTOR,
        fileName,
        content: Readable.from([Buffer.from(`content of ${fileName}`)]),
      });
      await h.domain.messaging.send(
        'AR',
        'owner',
        { to: [to], text: 'A file', taskKey: null, attachmentIds: [file.id] },
        { actor: OWNER_ACTOR },
      );
      return file;
    };
    const forCleo = await sendFile('cleo', 'for-cleo.txt');
    const forDana = await sendFile('dana', 'for-dana.txt');
    await say('cleo', 'What did you send me?');
    const tool = toolOf(conversationWith('cleo'));
    const own = await h.domain.teamTools.readMessageAttachment(tool, { attachmentId: forCleo.id });
    expect(own.content).toEqual({ kind: 'text', text: 'content of for-cleo.txt' });
    // The Operator itself could see the other message, but the guest's conversation answers as the guest.
    const refused = await rejection(
      h.domain.teamTools.readMessageAttachment(tool, { attachmentId: forDana.id }),
      TeamToolError,
    );
    expect(refused.code).toBe('not_found');
    expect(refused.message).not.toContain('for-dana');
  });

  it('puts a message file into the session folder of the owner’s conversation, never a guest’s (PM-518)', async () => {
    await setup({ sessionFolders: true });
    const sendPdf = async (to: string) => {
      const file = await h.domain.messageAttachments.upload({
        projectKey: 'AR',
        actor: OWNER_ACTOR,
        fileName: 'plan.pdf',
        content: Readable.from([pdfBytes()]),
      });
      await h.domain.messaging.send(
        'AR',
        'owner',
        { to: [to], text: 'A file', taskKey: null, attachmentIds: [file.id] },
        { actor: OWNER_ACTOR },
      );
      return file;
    };
    const forCleo = await sendPdf('cleo');
    const forOperator = await sendPdf('operator');
    await say('cleo', 'What did you send me?');
    const guestSession = await waitFor(() => conversationWith('cleo'), {
      what: 'the guest’s Operator conversation',
    });
    const guest = await h.domain.teamTools.readMessageAttachment(toolOf(guestSession), {
      attachmentId: forCleo.id,
    });
    expect(guest.content).toEqual({ kind: 'none', reason: 'type' });
    expect(guest.file).toBeUndefined();

    await h.domain.messaging.sendReporting('AR', 'owner', { to: ['operator'], text: 'And this?' });
    const ownerSession = await waitFor(ownerConversation, {
      what: 'the owner’s Operator conversation',
    });
    const own = await h.domain.teamTools.readMessageAttachment(toolOf(ownerSession), {
      attachmentId: forOperator.id,
    });
    expect(own.file?.path).toContain(`${forOperator.id}-plan.pdf`);
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

  it('attaches a file of its directory to the answer, to the guest alone (PM-520)', async () => {
    // The conversation's own directory is below the app home: a temporary one, never the real home.
    const appHome = mkdtempSync(path.join(tmpdir(), 'pm-guest-home-'));
    try {
      await setup({ appHome });
      await say('cleo');
      const session = conversationWith('cleo');
      mkdirSync(session!.cwd, { recursive: true });
      writeFileSync(path.join(session!.cwd, 'answer.txt'), 'the answer');
      const send = (to: string[], attachments = ['answer.txt']) =>
        h.domain.teamTools.sendMessage(toolOf(session), { to, text: 'See this', kind: 'info', attachments });
      const sent = await send(['cleo']);
      expect(h.repos.messages.get(sent.messageId)?.attachments).toEqual([
        expect.objectContaining({ fileName: 'answer.txt', size: 10 }),
      ]);
      // The rule of the conversation stays: nobody else, and no file stored for a refused message.
      expect(await refusal(send(['owner']))).toMatch(/^operator_owner_only:/);
      const stored = () => readdirSync(path.join(h.messageAttachmentsDir, 'AR')).length;
      const before = stored();
      expect(await refusal(send(['cleo'], ['missing.txt']))).toContain('missing.txt');
      expect(stored()).toBe(before);
    } finally {
      rmSync(appHome, { recursive: true, force: true });
    }
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

describe('a guest conversation has the team tools alone (PM-475)', () => {
  const startOf = (session: Session | undefined) =>
    h.runner.started.find((spec) => spec.sessionId === session!.id)!;

  it('starts with no file or shell tool, an empty directory of its own and nothing else to read', async () => {
    await setup();
    await say('cleo', 'What is stuck?');
    await say('owner', 'Hello');
    const guest = startOf(conversationWith('cleo'));
    const owner = startOf(ownerConversation());
    expect(guest.policy).toMatchObject({ tools: { team: { all: true }, files: [], shell: [] } });
    expect(guest.allowedTools.every((rule) => rule.startsWith('mcp__team'))).toBe(true);
    expect(guest.policy!.filesystem.readableRoots).toEqual([guest.cwd]);
    expect(guest.policy!.filesystem.readOnlyPaths ?? []).toEqual([]);
    expect(guest.permissionMode).toBe('default');
    expect(guest.cwd).toContain(path.join('operator-guests', 'AR', 'cleo'));
    expect(guest.cwd).not.toBe(owner.cwd);
    expect(guest.cwd).not.toBe(h.workspace);
  });

  it('renders settings and arguments that leave the CLI the team tools alone, however the sandbox is set', async () => {
    await setup();
    await say('cleo', 'What is stuck?');
    await say('owner', 'Hello');
    const guest = startOf(conversationWith('cleo'));
    const owner = startOf(ownerConversation());
    const render = (spec: typeof guest) => {
      const settings = buildSettings({
        hookUrl: 'http://127.0.0.1:1/hook',
        allowedTools: spec.allowedTools,
        deniedTools: spec.deniedTools,
        policy: spec.policy,
        permissionTimeoutMs: 1000,
        sandbox: spec.sandbox,
      });
      return { settings, args: buildClaudeArgs(spec, settings) };
    };
    const { settings, args } = render(guest);
    expect(guest.policy).toMatchObject({ teamToolsOnly: true });
    // The one built-in tool left is ToolSearch, which reaches the deferred team tools.
    expect(args[args.indexOf('--tools') + 1]).toBe('ToolSearch');
    expect(args).not.toContain('--add-dir');
    expect(settings.permissions.allow.length).toBeGreaterThan(0);
    expect(settings.permissions.allow.every((rule) => rule.startsWith('mcp__team__'))).toBe(true);
    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining(['Bash', 'Read', 'Edit', 'Write', 'WebFetch', 'WebSearch', 'Agent']),
    );
    // No rule opens a session folder (the others' included), the workspace or a command.
    expect(guest.policy!.filesystem.sessionFolder).toBeUndefined();
    expect(guest.policy!.filesystem.sessionFoldersRoot).toBeUndefined();
    expect(JSON.stringify(settings.permissions.allow)).not.toMatch(/Read\(|Edit\(|Bash\(/);
    // Nothing runs in the sandbox without asking either.
    expect(settings.sandbox?.autoAllowBashIfSandboxed ?? false).toBe(false);

    // The owner's conversation keeps its tools.
    const ownerRendered = render(owner);
    expect(owner.policy!.teamToolsOnly).toBeUndefined();
    expect(ownerRendered.args[ownerRendered.args.indexOf('--tools') + 1]).toContain('Bash');
  });

  it('refuses to start where the CLI cannot be limited to the team tools', async () => {
    h = await createDomainHarness({
      adjust: (config) => {
        withGuests(config);
        for (const member of config.team.members)
          if (member.kind === 'ai' && member.role === 'ai_operator') member.provider = 'codex';
      },
    });
    const error = await rejection(
      h.domain.messageStarts.startConversation('AR', 'operator', humanActor('dana')),
    );
    expect(error).toMatchObject({ code: 'provider_unsupported' });
    // The owners' conversation is not limited.
    await expect(
      h.domain.messageStarts.startConversation('AR', 'operator', OWNER_ACTOR),
    ).resolves.toMatchObject({ workItem: { type: 'general' } });
  });

  it('refuses a permission request at once, with no item for the owner, and notes it on the timeline', async () => {
    await setup();
    await say('cleo', 'Read the internal notes');
    const session = conversationWith('cleo')!;
    const decide = (toolName: string, toolInput: unknown) =>
      h.runnerModule
        .broker()
        .decide({ sessionId: session.id, toolName, toolInput, raw: {} }, new AbortController().signal);
    expect(await decide('Read', { file_path: '/etc/hosts' })).toMatchObject({ behavior: 'deny' });
    expect(await decide('Bash', { command: 'git log' })).toMatchObject({ behavior: 'deny' });
    expect(h.domain.inbox.list('AR', {})).toEqual([]);
    expect(
      h.domain.timeline
        .list('AR', {})
        .filter((e) => e.type === 'permission_refused' && e.sessionId === session.id),
    ).toHaveLength(2);
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
    const { domain } = app.app.projectman;
    const session = await waitFor(() => domain.sessions.list('AR', { member: 'operator' })[0], {
      what: 'the client’s Operator conversation over HTTP',
    });
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
