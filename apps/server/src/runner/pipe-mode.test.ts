import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ChatItem, SessionState } from '@projectman/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PermissionBroker, RunnerEvent, RunnerModule, StartSessionSpec } from '../contracts';
import { buildSessionPolicy } from '../domain';
import { testConfig } from '../../test/helpers/test-template';
import { createRunnerModule } from './index';
import { FAKE_CLAUDE, FAKE_CODEX, freePort, silentLogger, tempDirs, waitFor } from './test-helpers';

/**
 * The runner in pipe mode (PM-267): the fake CLIs run without a pseudo-terminal, so these tests
 * also run where there is none (not named `*.integration.test.ts`, so the PTY skip leaves them in).
 */

const dirs = tempDirs();
const savedEnv = { ...process.env };

let app: FastifyInstance;
let runner: RunnerModule;
let events: RunnerEvent[];
let cwd: string;

const broker: PermissionBroker = {
  decide: () => Promise.resolve({ behavior: 'deny', message: 'no answer configured' }),
};

beforeEach(async () => {
  events = [];
  cwd = await dirs.make('ws-');
  const home = await dirs.make('home-');
  const configFile = path.join(home, '.claude.json');
  await writeFile(configFile, JSON.stringify({ numStartups: 1, projects: {} }));
  process.env.FAKE_CLAUDE_TRANSCRIPT_DIR = await dirs.make('transcripts-');
  process.env.FAKE_CLAUDE_CONFIG_FILE = configFile;
  process.env.CODEX_HOME = await dirs.make('codex-home-');
  // A dead proxy: the hook forwarders only reach the server because the runner sets no_proxy.
  process.env.http_proxy = 'http://127.0.0.1:9';
  process.env.HTTP_PROXY = 'http://127.0.0.1:9';
  const port = await freePort();
  app = Fastify({ logger: false });
  runner = createRunnerModule({
    claudeBin: FAKE_CLAUDE,
    codexBin: FAKE_CODEX,
    codexHome: process.env.CODEX_HOME,
    publicBaseUrl: `http://127.0.0.1:${port}`,
    broker,
    permissionTimeoutMs: 10_000,
    logger: silentLogger(),
    claudeConfigPath: configFile,
    terminal: 'pipe',
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

function spec(provider: 'claude' | 'codex', extra: Partial<StartSessionSpec> = {}): StartSessionSpec {
  return {
    sessionId: `ses_${randomUUID().slice(0, 8)}`,
    claudeSessionId: randomUUID(),
    resume: false,
    cwd,
    displayName: 'Anna · fe-1',
    appendSystemPrompt: 'You are fe-1, a developer.',
    initialMessage: null,
    mcpUrl: 'http://127.0.0.1:1/mcp/token',
    allowedTools: ['mcp__team__*'],
    policy: buildSessionPolicy({
      config: testConfig(),
      role: 'developer',
      task: { repo: 'web' },
      permissionMode: 'acceptEdits',
      placement: { kind: 'task_worktree', path: cwd },
    }),
    member: 'fe-1',
    model: 'opus',
    permissionMode: 'acceptEdits',
    provider,
    cols: 100,
    rows: 30,
    ...extra,
  };
}

const statesOf = (id: string): SessionState[] =>
  events
    .filter((e): e is Extract<RunnerEvent, { type: 'state' }> => e.type === 'state' && e.sessionId === id)
    .map((e) => e.state);
const chatOf = (id: string): ChatItem[] =>
  events.flatMap((e) => (e.type === 'chat' && e.sessionId === id ? e.items : []));
const assistantSaid = (id: string, text: string) =>
  waitFor(() => chatOf(id).find((i) => i.kind === 'assistant_text' && i.text === text), {
    what: `assistant: ${text}`,
  });
const waitIdle = (id: string) =>
  waitFor(() => statesOf(id).at(-1) === 'idle', { what: `idle (now ${statesOf(id).at(-1)})` });

describe('the fake CLIs and a closed standard input', () => {
  it.each([FAKE_CLAUDE, FAKE_CODEX])('%s exits when its input ends, as when the server dies', async (bin) => {
    const child = spawn(process.execPath, [bin], { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.resume();
    child.stderr.resume();
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 300));
    child.stdin.end();
    await Promise.race([
      closed,
      new Promise((_resolve, reject) =>
        setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('the fake CLI did not exit when its input ended'));
        }, 8_000),
      ),
    ]);
  });
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};

describe.each(['claude', 'codex'] as const)('the fake %s CLI without a terminal', (provider) => {
  it(
    'answers the brief and a typed message, and the turns end with the Stop hook',
    { timeout: 30_000 },
    async () => {
      const s = spec(provider, { initialMessage: 'Hello from the brief' });
      await runner.runner.start(s);
      await assistantSaid(s.sessionId, 'Echo: Hello from the brief');
      await waitIdle(s.sessionId);

      await runner.runner.sendUserMessage(s.sessionId, 'second message');
      await assistantSaid(s.sessionId, 'Echo: second message');
      await waitFor(() => statesOf(s.sessionId).filter((state) => state === 'idle').length >= 3, {
        what: 'idle after the second turn',
      });
    },
  );

  it('leaves no process behind after shutdown', { timeout: 30_000 }, async () => {
    const info = await runner.runner.start(spec(provider));
    await waitIdle(info.sessionId);
    expect(info.pid).toBeGreaterThan(0);
    await runner.runner.shutdown();
    await waitFor(() => !alive(info.pid), { what: 'the process to be gone' });
  });
});
