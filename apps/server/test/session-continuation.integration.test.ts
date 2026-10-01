import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { routes } from '@projectman/shared';
import type { AgentProvider, ChatItem, Task, TaskDetail } from '@projectman/shared';
import { afterEach, expect, it, vi } from 'vitest';
import { waitFor } from '../src/runner/test-helpers';
import { createAppHarness, createProject, OWNER_LOGIN, setupOwner } from './helpers/app-harness';
import type { CliAppHarness } from './helpers/app-harness';

/**
 * A stopped task session that starts again, through the real runner and the fake CLIs: it gets a
 * first input of its own, so it does not sit at its prompt. Codex has it on the command line of
 * `codex resume <id> -- <prompt>` (nothing depends on the screen), Claude Code has it typed once
 * SessionStart arrives; later messages are typed after the first turn in both.
 */

let h: CliAppHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const PROVIDERS: Array<[AgentProvider, string]> = [
  ['claude', 'dev-1'],
  ['codex', 'dev-2'],
];

const userTexts = (chat: ChatItem[]) => chat.flatMap((i) => (i.kind === 'user_text' ? [i.text] : []));

it.each(PROVIDERS)(
  'resumes a stopped %s task session with the continue message, or with the message that woke it',
  { timeout: 90_000 },
  async (provider, member) => {
    h = await createAppHarness({ runner: 'fake-cli', real: { context: true } });
    const { app, home } = h;
    const argsFile = join(home, `${provider}-args.json`);
    vi.stubEnv(provider === 'codex' ? 'FAKE_CODEX_ARGS_FILE' : 'FAKE_CLAUDE_ARGS_FILE', argsFile);
    const argv = (): string[] => JSON.parse(readFileSync(argsFile, 'utf8')).argv;
    const cookie = await setupOwner(app);
    const headers = { cookie };
    await createProject(h, cookie);
    const { domain } = app.projectman;
    await domain.projects.update(
      'AR',
      { actor: { kind: 'human', handle: 'owner' }, author: OWNER_LOGIN },
      (config) => {
        const dev = config.team.members.find((m) => m.handle === member);
        if (dev?.kind === 'ai') dev.provider = provider;
        return `Run ${member} on ${provider}`;
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
    const start = async () => {
      const res = await app.inject({
        method: 'POST',
        url: routes.startTask('AR', key),
        headers,
        payload: { assignee: member },
      });
      expect(res.statusCode).toBe(200);
      return res.json<TaskDetail>().sessions[0]!;
    };
    const chatOf = async (id: string) => (await domain.sessions.detail('AR', id)).chat;
    const idle = (id: string) =>
      waitFor(() => domain.sessions.get('AR', id).state === 'idle', { what: 'idle' });
    const stopped = async (id: string) => {
      await domain.sessions.stop('AR', id);
      await waitFor(() => !app.projectman.runnerModule.runner.isRunning(id), { what: 'the session to stop' });
    };
    const said = (id: string, text: string | RegExp) =>
      vi.waitFor(
        async () => {
          const chat = await chatOf(id);
          expect(chat.some((i) => i.kind === 'assistant_text' && String(i.text).match(text))).toBe(true);
        },
        { timeout: 20_000 },
      );

    // The first run: the brief starts the conversation.
    const first = await start();
    await waitFor(() => domain.sessions.get('AR', first.id).transcriptPath, { what: 'a transcript' });
    await idle(first.id);
    await said(first.id, /^Echo: # AR-1/);
    const conversation = domain.sessions.get('AR', first.id).claudeSessionId;
    await stopped(first.id);

    // Nothing but the start asks for the session again: it is told it was restarted.
    const resumed = await start();
    expect(resumed.id).toBe(first.id);
    await said(first.id, /^Echo: Your session was restarted\./);
    await idle(first.id);
    const continueMessage = userTexts(await chatOf(first.id)).at(-1)!;
    expect(continueMessage).toMatch(
      /^Your session was restarted\. You are working on AR-1 "Acme checkout", now in stage Development \(`development`\)\. Check where you left off \(git status in your working directory, and the task's comments and attachments in get_task\), then carry on as usual, writing in \w+ \(`\w+`\), the project's language\.$/,
    );
    if (provider === 'codex') {
      // On the command line of `codex resume`, so the session needs no composer on screen.
      expect(argv()[0]).toBe('resume');
      expect(argv().slice(-3)).toEqual(['--', conversation, continueMessage]);
    } else {
      expect(argv()).toEqual(expect.arrayContaining(['--resume', conversation]));
      expect(argv()).not.toContain(continueMessage);
    }
    await stopped(first.id);

    // A person writing to the stopped session: their message is the first input, typed once.
    const written = await app.inject({
      method: 'POST',
      url: routes.sessionMessages('AR', first.id),
      headers,
      payload: { text: 'Please rename the page.' },
    });
    expect(written.statusCode).toBe(202);
    await said(first.id, 'Echo: Please rename the page.');
    await idle(first.id);
    expect(
      userTexts(await chatOf(first.id)).filter((text) => text === 'Please rename the page.'),
    ).toHaveLength(1);
    expect(
      userTexts(await chatOf(first.id)).filter((text) => text.startsWith('Your session was restarted.')),
    ).toHaveLength(1);
    if (provider === 'codex')
      expect(argv().slice(-3)).toEqual(['--', conversation, 'Please rename the page.']);

    // A message after the first turn is typed into the running session.
    const later = await app.inject({
      method: 'POST',
      url: routes.sessionMessages('AR', first.id),
      headers,
      payload: { text: 'And the heading.' },
    });
    expect(later.statusCode).toBe(202);
    await said(first.id, 'Echo: And the heading.');
    expect(userTexts(await chatOf(first.id)).slice(-3)).toEqual([
      continueMessage,
      'Please rename the page.',
      'And the heading.',
    ]);
  },
);
