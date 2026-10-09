import { routes } from '@projectman/shared';
import type { ChatItem, Task, TaskDetail } from '@projectman/shared';
import { afterEach, expect, it, vi } from 'vitest';
import { waitFor } from '../src/runner/test-helpers';
import { createAppHarness, createProject, OWNER_LOGIN, setupOwner } from './helpers/app-harness';
import type { CliAppHarness } from './helpers/app-harness';

/**
 * A long team message to a Codex member's running session, through the real runner and the fake Codex
 * CLI (PM-144): the whole text arrives behind the `[team message from …]` prefix, whether the session is
 * idle (typed now) or in the middle of a turn (typed when the turn ends), and the sender is told which.
 */

let h: CliAppHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

/** More than 4000 characters over several paragraphs, one line longer than a paste chunk (500). */
const LONG_BODY = [
  'Review of the checkout form.',
  Array.from({ length: 8 }, (_, i) =>
    `Point ${i + 1}: ${'the details of this point '.repeat(8)}`.trim(),
  ).join('\n'),
  `One long line: ${'a very long observation without any line break '.repeat(14)}`.trim(),
  Array.from({ length: 12 }, (_, i) =>
    `Follow-up ${i + 1}: ${'please check this as well '.repeat(7)}`.trim(),
  ).join('\n'),
  'End of the review.',
].join('\n\n');

/** What the session was told, in order: a human's turn as its text, a team message as `from: body`. */
const told = (chat: ChatItem[]) =>
  chat.flatMap((i) =>
    i.kind === 'user_text'
      ? [i.text]
      : i.kind === 'team_message' && i.direction === 'in'
        ? [`${i.from}: ${i.text}`]
        : [],
  );

it(
  'starts another manager turn for idle, busy and resumed conversations with or without a card',
  { timeout: 120_000 },
  async () => {
    h = await createAppHarness({ runner: 'fake-cli', real: { context: true } });
    const cookie = await setupOwner(h.app);
    await createProject(h, cookie);
    await h.app.projectman.domain.projects.update(
      'AR',
      {
        actor: { kind: 'human', handle: 'owner' },
        author: OWNER_LOGIN,
      },
      (config) => {
        const pm = config.team.members.find((m) => m.handle === 'pm');
        if (pm?.kind === 'ai') {
          pm.onLeave = false;
          pm.capacity = 1;
        }
        return 'Enable project manager';
      },
    );
    const task = await h.app.projectman.domain.tasks.create(
      'AR',
      { title: 'Manager request' },
      { kind: 'human', handle: 'owner' },
    );
    const { session } = await h.app.projectman.domain.sessions.ensureSession('AR', 'pm', { type: 'general' });
    const idle = () =>
      waitFor(() => h!.app.projectman.domain.sessions.get('AR', session.id).state === 'idle', {
        what: 'manager idle',
      });
    await idle();
    for (const phase of ['idle', 'busy', 'resumed'] as const) {
      if (phase === 'resumed') {
        await h.app.projectman.domain.sessions.stop('AR', session.id);
        const resumed = await h.app.projectman.domain.sessions.ensureSession(
          'AR',
          'pm',
          { type: 'general' },
          { messages: ['Resume manager work'] },
        );
        expect(resumed.session.id).toBe(session.id);
        await idle();
      }
      for (const taskKey of [undefined, task.key]) {
        const domain = h.app.projectman.domain;
        if (phase === 'busy') {
          await domain.messaging.sendToSession('AR', session.id, 'SLOW manager work', 'owner');
          await waitFor(() => domain.sessions.get('AR', session.id).state === 'working', {
            what: 'manager working',
          });
        }
        const body = `Manager request ${phase} ${taskKey ?? 'general'}`;
        const echo = `Echo: [team message from owner${taskKey ? ` about ${taskKey}` : ''}]`;
        const previousReplies = (await domain.sessions.detail('AR', session.id)).chat.filter(
          (i) => i.kind === 'assistant_text' && i.text === echo,
        ).length;
        const sent = await domain.messaging.send('AR', 'owner', { to: ['pm'], taskKey, text: body });
        await vi.waitFor(
          async () => {
            const chat = (await domain.sessions.detail('AR', session.id)).chat;
            expect(chat.filter((i) => i.kind === 'assistant_text' && i.text === echo)).toHaveLength(
              previousReplies + 1,
            );
            expect(told(chat).some((text) => text.includes(body))).toBe(true);
            expect(domain.messages.get(sent.id)?.receipts?.[0]?.deliveredAt).toBeTruthy();
          },
          { timeout: 30_000 },
        );
        await idle();
        expect(domain.sessions.list('AR', { member: 'pm' })).toHaveLength(1);
      }
    }
  },
);

it(
  'types a long team message into an idle and into a busy Codex session in full, and tells the sender which',
  { timeout: 120_000 },
  async () => {
    expect(LONG_BODY.length).toBeGreaterThan(4000);
    expect(LONG_BODY.split('\n').some((line) => line.length > 500)).toBe(true);
    h = await createAppHarness({ runner: 'fake-cli', real: { context: true } });
    const { app } = h;
    const cookie = await setupOwner(app);
    const headers = { cookie };
    await createProject(h, cookie);
    const { domain } = app.projectman;
    await domain.projects.update(
      'AR',
      { actor: { kind: 'human', handle: 'owner' }, author: OWNER_LOGIN },
      (config) => {
        const dev = config.team.members.find((m) => m.handle === 'dev-2');
        if (dev?.kind === 'ai') dev.provider = 'codex';
        return 'Run dev-2 on codex';
      },
    );
    const created = await app.inject({
      method: 'POST',
      url: routes.tasks('AR'),
      headers,
      payload: { title: 'Acme checkout' },
    });
    expect(created.statusCode).toBe(201);
    const { key } = created.json<Task>();
    const started = await app.inject({
      method: 'POST',
      url: routes.startTask('AR', key),
      headers,
      payload: { assignee: 'dev-2' },
    });
    expect(started.statusCode).toBe(200);
    const { id } = started.json<TaskDetail>().sessions[0]!;
    const chatOf = async () => (await domain.sessions.detail('AR', id)).chat;
    const state = () => domain.sessions.get('AR', id).state;
    const idle = () => waitFor(() => state() === 'idle', { what: 'idle' });
    const said = (text: string) =>
      vi.waitFor(
        async () => {
          expect((await chatOf()).some((i) => i.kind === 'assistant_text' && i.text.startsWith(text))).toBe(
            true,
          );
        },
        { timeout: 30_000 },
      );
    await said('Echo: # AR-1');
    await idle();

    // The sender is another AI member; its session does not matter to the delivery.
    const sender = { sessionId: 'ses_sender', projectKey: 'AR', member: 'dev-1', taskKey: key };
    // The transcript parser turns the `[team message from …]` prefix into an incoming team message.
    const arrived = (text: string) => text.startsWith('dev-1: action · sent ') && text.endsWith(LONG_BODY);

    // (a) An idle session gets it now, whole.
    const toIdle = await domain.teamTools.sendMessage(sender, {
      kind: 'action',
      to: ['dev-2'],
      text: LONG_BODY,
    });
    expect(toIdle.recipients).toEqual([{ handle: 'dev-2', delivery: 'typed_now' }]);
    await vi.waitFor(async () => expect(told(await chatOf()).filter(arrived)).toHaveLength(1), {
      timeout: 30_000,
    });
    await idle();

    // (b) A session in a slow turn gets it when the turn ends, whole.
    const slow = await app.inject({
      method: 'POST',
      url: routes.sessionMessages('AR', id),
      headers,
      payload: { text: 'SLOW first task' },
    });
    expect(slow.statusCode).toBe(202);
    await waitFor(() => state() === 'working', { what: 'a turn in progress' });
    const toBusy = await domain.teamTools.sendMessage(sender, {
      kind: 'action',
      to: ['dev-2'],
      text: LONG_BODY,
    });
    expect(toBusy.recipients).toEqual([{ handle: 'dev-2', delivery: 'after_turn' }]);
    await vi.waitFor(async () => expect(told(await chatOf()).filter(arrived)).toHaveLength(2), {
      timeout: 30_000,
    });
    await idle();
    const last = told(await chatOf()).slice(-2);
    expect(last[0]).toBe('SLOW first task');
    expect(arrived(last[1]!)).toBe(true);
  },
);
