import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PermissionBroker, RunnerEvent, RunnerModule, StartSessionSpec } from '../contracts';
import { createRunnerModule } from './index';
import { FAKE_CLAUDE, freePort, silentLogger, tempDirs, waitFor } from './test-helpers';

/** Claude Code's login: checked before a session starts, and watched during it. */

const dirs = tempDirs();
const savedEnv = { ...process.env };

let app: FastifyInstance;
let runner: RunnerModule;
let events: RunnerEvent[];
let cwd: string;

const broker: PermissionBroker = { decide: async () => ({ behavior: 'deny' }) };

beforeEach(async () => {
  events = [];
  cwd = await dirs.make('ws-');
  const home = await dirs.make('claude-home-');
  const configFile = path.join(home, '.claude.json');
  await writeFile(configFile, JSON.stringify({ projects: {} }));
  process.env.FAKE_CLAUDE_TRANSCRIPT_DIR = await dirs.make('transcripts-');
  process.env.FAKE_CLAUDE_CONFIG_FILE = configFile;
  const port = await freePort();
  app = Fastify({ logger: false });
  runner = createRunnerModule({
    claudeBin: FAKE_CLAUDE,
    publicBaseUrl: `http://127.0.0.1:${port}`,
    broker,
    permissionTimeoutMs: 5_000,
    logger: silentLogger(),
    claudeConfigPath: configFile,
  });
  runner.registerHookRoutes(app);
  await app.listen({ host: '127.0.0.1', port });
  runner.runner.onEvent((event) => events.push(event));
});

afterEach(async () => {
  await runner?.runner.shutdown();
  await app?.close();
  await dirs.cleanup();
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

function spec(extra: Partial<StartSessionSpec> = {}): StartSessionSpec {
  return {
    sessionId: `ses_${randomUUID().slice(0, 8)}`,
    claudeSessionId: randomUUID(),
    resume: false,
    cwd,
    displayName: 'Anna · fe-1',
    appendSystemPrompt: 'You are fe-1.',
    initialMessage: null,
    mcpUrl: 'http://127.0.0.1:1/mcp/token',
    allowedTools: ['mcp__team'],
    member: 'fe-1',
    ...extra,
  };
}

describe('Claude Code login', { timeout: 30_000 }, () => {
  it('refuses to spawn a session while Claude Code is not logged in with a subscription', async () => {
    process.env.FAKE_CLAUDE_LOGGED_OUT = '1';
    await expect(runner.runner.start(spec())).rejects.toMatchObject({
      code: 'provider_not_logged_in',
      provider: 'claude',
      message: expect.stringContaining('not logged in'),
    });
    expect(runner.runner.list()).toEqual([]);
    expect(await runner.runner.providerStatus!('claude')).toMatchObject({
      provider: 'claude',
      loggedIn: false,
      method: 'none',
      checkedAt: expect.any(String),
    });

    delete process.env.FAKE_CLAUDE_LOGGED_OUT;
    process.env.FAKE_CLAUDE_AUTH_METHOD = 'api_key';
    expect(await runner.runner.providerStatus!('claude', { refresh: true })).toMatchObject({
      loggedIn: false,
      method: 'api_key',
      detail: expect.stringContaining('bills the API'),
    });

    delete process.env.FAKE_CLAUDE_AUTH_METHOD;
    expect(await runner.runner.providerStatus!('claude', { refresh: true })).toMatchObject({
      loggedIn: true,
      method: 'claude.ai',
    });
    const s = spec();
    await runner.runner.start(s);
    expect(runner.runner.isRunning(s.sessionId)).toBe(true);
  });

  it('fails a session whose login expires mid-session, and checks the login again next time', async () => {
    const s = spec({ initialMessage: 'hello' });
    await runner.runner.start(s);
    await waitFor(
      () => events.some((e) => e.type === 'state' && e.sessionId === s.sessionId && e.state === 'idle'),
      {
        what: 'idle',
      },
    );
    await runner.runner.sendUserMessage(s.sessionId, 'EXPIRE please');
    const authError = await waitFor(
      () => events.find((e) => e.type === 'auth_error' && e.sessionId === s.sessionId),
      { what: 'auth_error' },
    );
    expect(authError).toEqual({
      type: 'auth_error',
      sessionId: s.sessionId,
      provider: 'claude',
      message: 'Login expired · Please run /login',
    });
    await waitFor(() => events.some((e) => e.type === 'exit' && e.sessionId === s.sessionId), {
      what: 'exit',
    });
    const states = events.filter((e) => e.type === 'state' && e.sessionId === s.sessionId);
    expect(states.at(-1)).toMatchObject({ state: 'failed', activity: 'Login expired · Please run /login' });
    expect(
      states.some(
        (e) => e.type === 'state' && e.state === 'idle' && events.indexOf(e) > events.indexOf(authError),
      ),
    ).toBe(false);

    // The lost login invalidated the cached check: a new start sees the logged-out CLI.
    process.env.FAKE_CLAUDE_LOGGED_OUT = '1';
    await expect(runner.runner.start(spec())).rejects.toMatchObject({ code: 'provider_not_logged_in' });
  });
});
