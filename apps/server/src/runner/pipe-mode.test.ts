import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ChatItem, SessionState } from '@projectman/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionBroker, RunnerEvent, RunnerModule, StartSessionSpec } from '../contracts';
import { buildSessionPolicy } from '../../test/helpers/session-policy';
import { testConfig } from '../../test/helpers/test-template';
import { createRunnerModule } from './index';
import {
  FAKE_CLAUDE,
  FAKE_CODEX,
  fixtureScopeProcesses,
  freePort,
  silentLogger,
  tempDirs,
  waitFor,
} from './test-helpers';

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
let configRoot: string;

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
  process.env.FAKE_SCOPE_RECORDS_DIR = await dirs.make('scope-records-');
  // A dead proxy: the hook forwarders only reach the server because the runner sets no_proxy.
  process.env.http_proxy = 'http://127.0.0.1:9';
  process.env.HTTP_PROXY = 'http://127.0.0.1:9';
  configRoot = path.join(await dirs.make('run-'), 'run');
  const port = await freePort();
  app = Fastify({ logger: false });
  runner = createRunnerModule({
    claudeBin: FAKE_CLAUDE,
    codexBin: FAKE_CODEX,
    codexHome: process.env.CODEX_HOME,
    publicBaseUrl: `http://127.0.0.1:${port}`,
    sessionConfigRoot: configRoot,
    broker,
    permissionTimeoutMs: 10_000,
    logger: silentLogger(),
    claudeConfigPath: configFile,
    terminal: 'pipe',
    scopeProcesses: fixtureScopeProcesses(process.env.FAKE_SCOPE_RECORDS_DIR!),
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

it('closes a marked, detached TERM-resistant grandchild before reporting exit', async () => {
  const file = path.join(cwd, 'grandchild.json');
  process.env.FAKE_SCOPE_CHILD_FILE = file;
  const session = await runner.runner.start(spec('claude'));
  let child: { pid: number; scopeId: string } | undefined;
  try {
    await vi.waitFor(
      async () => {
        child = await readFile(file, 'utf8').then(
          (text) => JSON.parse(text),
          () => undefined,
        );
        expect(child).toBeDefined();
      },
      { timeout: 5000 },
    );
    expect(child!.scopeId).toBe(session.scopeId);
    await runner.runner.stop(session.sessionId);
    expect(() => process.kill(child!.pid, 0)).toThrow();
    expect(events.find((e) => e.type === 'exit' && e.sessionId === session.sessionId)).toMatchObject({
      cleanup: { outcome: 'clean', killed: true },
    });
  } finally {
    if (child) {
      try {
        process.kill(child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
}, 15_000);
const chatOf = (id: string): ChatItem[] =>
  events.flatMap((e) => (e.type === 'chat' && e.sessionId === id ? e.items : []));
const assistantSaid = (id: string, text: string) =>
  waitFor(() => chatOf(id).find((i) => i.kind === 'assistant_text' && i.text === text), {
    what: `assistant: ${text}`,
  });
const waitIdle = (id: string) =>
  waitFor(() => statesOf(id).at(-1) === 'idle', { what: `idle (now ${statesOf(id).at(-1)})` });

describe('Codex project configuration admission (PM-357)', () => {
  it('rejects unsafe configuration without starting a session, then accepts model settings', async () => {
    await mkdir(path.join(cwd, '.codex'));
    const file = path.join(cwd, '.codex/config.toml');
    await writeFile(file, '[mcp_servers.x]\ncommand = "fictional-command"');
    const start = spec('codex');
    await expect(runner.runner.start(start)).rejects.toMatchObject({ code: 'workspace_codex_config' });
    expect(events).toEqual([]);
    expect(runner.runner.isRunning(start.sessionId)).toBe(false);
    await writeFile(file, 'model = "fictional-model"');
    await runner.runner.start(start);
    await waitIdle(start.sessionId);
  });
  it('leaves Claude and NanoGPT workspace preflight alone', async () => {
    await mkdir(path.join(cwd, '.codex'));
    await writeFile(path.join(cwd, '.codex/hooks.json'), '{}');
    await expect(runner.runner.assertWorkspaceConfig!({ provider: 'claude', cwd })).resolves.toBeUndefined();
    await expect(runner.runner.assertWorkspaceConfig!({ provider: 'nanogpt', cwd })).resolves.toBeUndefined();
  });
});

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

describe('the private launch files of a Claude Code session (PM-156)', () => {
  const MCP_CANARY = 'mcp-canary-7d1f09ab';
  const sandbox = { allowWrite: [], allowedDomains: [], allowLocalBinding: true };
  const sessionDirs = async () => (await readdir(configRoot).catch(() => [])).sort();
  const mode = async (file: string) => (await stat(file)).mode & 0o777;
  const launchSpec = (sandboxed: boolean, extra: Partial<StartSessionSpec> = {}) =>
    spec('claude', {
      mcpUrl: `http://127.0.0.1:1/mcp/${MCP_CANARY}`,
      initialMessage: 'Hello',
      ...(sandboxed ? { sandbox } : {}),
      ...extra,
    });
  const launchedArgs = async (file: string) => {
    const raw = await readFile(file, 'utf8');
    return { raw, argv: JSON.parse(raw).argv as string[] };
  };

  it.each([false, true])(
    'keeps the tokens off the command line, in files that go with the session (sandboxed: %s)',
    { timeout: 30_000 },
    async (sandboxed) => {
      const argsFile = path.join(cwd, 'args.json');
      process.env.FAKE_CLAUDE_ARGS_FILE = argsFile;
      const s = launchSpec(sandboxed);
      await runner.runner.start(s);
      // The turn ends with the Stop hook, which came through the settings the CLI was given.
      await assistantSaid(s.sessionId, 'Echo: Hello');
      await waitIdle(s.sessionId);

      const [name, ...others] = await sessionDirs();
      expect(others).toEqual([]);
      const dir = path.join(configRoot, name!);
      expect(name).toMatch(new RegExp(`^${s.sessionId}\\.[0-9a-f]{16}$`));
      expect(await mode(configRoot)).toBe(0o700);
      expect(await mode(dir)).toBe(0o700);
      const files = await readdir(dir);
      expect(files).toEqual(expect.arrayContaining(['claude-settings.json', 'claude-mcp.json', 'hook.curl']));
      for (const file of files) expect(await mode(path.join(dir, file))).toBe(0o600);

      const hookToken = /\/hooks\/([^"/]+)/.exec(await readFile(path.join(dir, 'hook.curl'), 'utf8'))?.[1];
      expect(hookToken).toBeTruthy();
      expect(await readFile(path.join(dir, 'claude-mcp.json'), 'utf8')).toContain(MCP_CANARY);
      const settings = await readFile(path.join(dir, 'claude-settings.json'), 'utf8');
      // Command hooks name the target file only; the CLI's own http hooks keep the URL in this private file.
      if (sandboxed) {
        expect(settings).toContain(path.join(dir, 'hook.curl'));
        expect(settings).not.toContain(hookToken);
      } else expect(settings).toContain(hookToken);

      const { raw, argv } = await launchedArgs(argsFile);
      expect(argv[argv.indexOf('--settings') + 1]).toBe(path.join(dir, 'claude-settings.json'));
      expect(argv[argv.indexOf('--mcp-config') + 1]).toBe(path.join(dir, 'claude-mcp.json'));
      expect(raw).not.toContain(MCP_CANARY);
      expect(raw).not.toContain(hookToken);
      expect(raw).not.toContain('/hooks/');
      expect(raw).not.toContain('/mcp/');

      await runner.runner.stop(s.sessionId);
      await waitFor(async () => (await sessionDirs()).length === 0, {
        what: 'the private folder to be removed',
      });
    },
  );

  it('gives a resumed session new files, and removes them again', { timeout: 30_000 }, async () => {
    const argsFile = path.join(cwd, 'args.json');
    process.env.FAKE_CLAUDE_ARGS_FILE = argsFile;
    const s = launchSpec(false);
    await runner.runner.start(s);
    // The conversation exists once the first turn is answered.
    await assistantSaid(s.sessionId, 'Echo: Hello');
    await waitIdle(s.sessionId);
    const [first] = await sessionDirs();
    await runner.runner.stop(s.sessionId);
    await waitFor(async () => (await sessionDirs()).length === 0, { what: 'the first folder to be removed' });

    await runner.runner.start({ ...s, resume: true, initialMessage: null });
    await waitIdle(s.sessionId);
    const [second, ...others] = await sessionDirs();
    expect(others).toEqual([]);
    expect(second).not.toBe(first);
    const { raw, argv } = await launchedArgs(argsFile);
    expect(argv).toContain('--resume');
    expect(argv[argv.indexOf('--settings') + 1]).toBe(path.join(configRoot, second!, 'claude-settings.json'));
    expect(raw).not.toContain(MCP_CANARY);
    await runner.runner.shutdown();
    await waitFor(async () => (await sessionDirs()).length === 0, {
      what: 'the folder to go with the shutdown',
    });
  });

  it('removes the folder when the session cannot be started', { timeout: 30_000 }, async () => {
    await expect(
      runner.runner.start(launchSpec(false, { cwd: path.join(cwd, 'missing', 'deeper') })),
    ).rejects.toThrow();
    expect(await sessionDirs()).toEqual([]);
  });

  it(
    'sweeps the folder of a runner that is gone and leaves the running session alone',
    { timeout: 30_000 },
    async () => {
      await mkdir(configRoot, { mode: 0o700 });
      const orphan = path.join(configRoot, 'ses_orphan.0123456789abcdef');
      await mkdir(orphan, { mode: 0o700 });
      await writeFile(
        path.join(orphan, 'owner.json'),
        JSON.stringify({
          version: 1,
          sessionId: 'ses_orphan',
          instanceTag: null,
          runnerPid: 2_000_000_000,
          runnerStartedAt: null,
          createdAt: Date.now() - 60_000,
        }),
      );
      await writeFile(path.join(orphan, 'hook.curl'), 'url = "http://127.0.0.1:1/hooks/old"\n');
      const port = await freePort();
      const second = createRunnerModule({
        claudeBin: FAKE_CLAUDE,
        codexBin: FAKE_CODEX,
        codexHome: process.env.CODEX_HOME,
        publicBaseUrl: `http://127.0.0.1:${port}`,
        sessionConfigRoot: configRoot,
        broker,
        permissionTimeoutMs: 10_000,
        logger: silentLogger(),
        claudeConfigPath: process.env.FAKE_CLAUDE_CONFIG_FILE,
        terminal: 'pipe',
        scopeProcesses: fixtureScopeProcesses(process.env.FAKE_SCOPE_RECORDS_DIR!),
      });
      try {
        const s = launchSpec(false);
        await second.runner.start(s);
        const names = await sessionDirs();
        expect(names).toHaveLength(1);
        expect(names[0]).toMatch(new RegExp(`^${s.sessionId}\\.`));
      } finally {
        await second.runner.shutdown();
      }
    },
  );
});
