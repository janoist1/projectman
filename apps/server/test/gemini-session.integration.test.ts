import { readFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { routes, type Task, type TaskDetail, type ChatItem } from '@projectman/shared';
import { afterEach, expect, it, vi } from 'vitest';
import { waitFor } from '../src/runner/test-helpers';
import { geminiSpec } from '../src/runner/providers/gemini/test-helpers';
import {
  createAppHarness,
  createProject,
  setupOwner,
  OWNER_LOGIN,
  type CliAppHarness,
} from './helpers/app-harness';
let h: CliAppHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

it(
  'runs Gemini hooks, MCP, permissions, transcript and resume through the app',
  { timeout: 90000 },
  async () => {
    vi.stubEnv('NANOGPT_API_KEY', 'fictional-nanogpt-isolation-sentinel');
    h = await createAppHarness({ runner: 'fake-cli', real: { mcp: true } });
    const { app, home, userHome } = h;
    const argsFile = join(home, 'gemini-args.json');
    vi.stubEnv('FAKE_GEMINI_ARGS_FILE', argsFile);
    const cookie = await setupOwner(app);
    await createProject(h, cookie);
    const { domain } = app.projectman;
    await domain.projects.update(
      'AR',
      { actor: { kind: 'human', handle: 'owner' }, author: OWNER_LOGIN },
      (config) => {
        const dev = config.team.members.find((m) => m.handle === 'dev-1');
        if (dev?.kind === 'ai') {
          dev.provider = 'gemini';
          dev.model = 'gemini-3.8-flash';
          dev.permissionMode = 'acceptEdits';
          dev.approver = 'human';
        }
        return 'Run dev-1 with Gemini';
      },
    );
    const created = await app.inject({
      method: 'POST',
      url: routes.tasks('AR'),
      headers: { cookie },
      payload: { title: 'Gemini test', repo: 'web' },
    });
    expect(created.statusCode).toBe(201);
    const { key } = created.json<Task>();
    const start = async () => {
      const response = await app.inject({
        method: 'POST',
        url: routes.startTask('AR', key),
        headers: { cookie },
        payload: { assignee: 'dev-1' },
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json<TaskDetail>().sessions[0]!;
    };
    const session = await start();
    const chat = async (): Promise<ChatItem[]> => (await domain.sessions.detail('AR', session.id)).chat;
    await vi.waitFor(async () => expect((await chat()).some((i) => i.kind === 'assistant_text')).toBe(true), {
      timeout: 20000,
    });
    expect(JSON.parse(readFileSync(argsFile, 'utf8')).env).not.toHaveProperty('NANOGPT_API_KEY');
    const send = async (text: string) => {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: routes.sessionMessages('AR', session.id),
            headers: { cookie },
            payload: { text },
          })
        ).statusCode,
      ).toBe(202);
    };
    const done = async (text: string) => {
      await vi.waitFor(
        async () =>
          expect((await chat()).some((i) => i.kind === 'assistant_text' && i.text === `DONE: ${text}`)).toBe(
            true,
          ),
        { timeout: 20000 },
      );
      await waitFor(() => domain.sessions.get('AR', session.id).state === 'idle');
    };
    await send('team');
    await done('team');
    expect((await chat()).some((i) => i.kind === 'tool_call' && i.name === 'mcp__team__get_task')).toBe(true);
    await send('command:npm test');
    await done('command:npm test');
    expect(domain.inbox.list('AR', { kind: 'permission', state: 'open' })).toHaveLength(0);
    await send('command:curl https://example.com/');
    const item = await waitFor(() => domain.inbox.list('AR', { kind: 'permission', state: 'open' })[0], {
      what: 'Gemini permission inbox',
    });
    expect(domain.sessions.get('AR', session.id).state).toBe('waiting_permission');
    const resolved = await app.inject({
      method: 'POST',
      url: routes.resolveInbox('AR', item.id),
      headers: { cookie },
      payload: { optionId: 'allow' },
    });
    expect(resolved.statusCode, resolved.body).toBe(200);
    await done('command:curl https://example.com/');
    const conversation = domain.sessions.get('AR', session.id).claudeSessionId;
    await domain.sessions.stop('AR', session.id);
    await waitFor(() => !app.projectman.runnerModule.runner.isRunning(session.id));
    await start();
    await waitFor(() => JSON.parse(readFileSync(argsFile, 'utf8')).argv.includes('--conversation'));
    expect(JSON.parse(readFileSync(argsFile, 'utf8')).argv).toContain(conversation);
    expect(JSON.parse(readFileSync(argsFile, 'utf8')).env).not.toHaveProperty('NANOGPT_API_KEY');
    await expect(access(join(userHome, '.gemini'))).rejects.toThrow();
  },
);

it('refuses a logged-out Gemini member before spawning a conversation', { timeout: 30000 }, async () => {
  h = await createAppHarness({ runner: 'fake-cli' });
  const cookie = await setupOwner(h.app);
  await createProject(h, cookie);
  vi.stubEnv('FAKE_GEMINI_LOGGED_OUT', '1');
  const status = await h.app.projectman.runnerModule.runner.providerStatus!('gemini', { refresh: true });
  expect(status).toMatchObject({ loggedIn: false, problem: 'not_logged_in' });
  await expect(h.app.projectman.runnerModule.runner.start(geminiSpec(h.workspace))).rejects.toMatchObject({
    code: 'provider_not_logged_in',
  });
});
