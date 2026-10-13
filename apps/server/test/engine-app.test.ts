import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertEngineProfile, buildEngineApp } from '../src/engine-app';
import type { EngineApp, EngineAppOptions } from '../src/engine-app';
import {
  EngineConfig,
  EngineConfigError,
  saveEngineConfig,
  writeSecretFile,
} from '../src/engine-link/engine-config';
import type { MethodParams } from '../src/engine-link';
import { InstanceMarkerError, writeInstanceMarker } from '../src/instance';
import { createFakeRunnerModule } from './helpers/fakes';
import type { FakeRunnerModule } from './helpers/fakes';
import { FakeGithub } from './helpers/fakes';
import { startFakeCloud } from './helpers/fake-cloud';
import type { FakeCloud } from './helpers/fake-cloud';

const KEY = 'machine-key-0123456789abcdef';
const TOKEN = 'tok_abcdefgh12345678';
const NANOGPT_KEY = 'ng-secret-KEY-1234567890';
/** A place that is not below any root of the engine (the temp directory is one). */
const OUTSIDE = '/etc';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(check: () => boolean, what: string, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A request with chosen headers (fetch cannot set `Host`). */
function rawRequest(
  port: number,
  options: { method?: string; path: string; headers?: Record<string, string>; body?: string },
) {
  return new Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }>((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'POST',
        path: options.path,
        headers: options.headers,
      },
      (res) => {
        responded = true;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    // A server that refuses a large body may answer and close before the body is written.
    let responded = false;
    req.on('error', (error) => {
      if (!responded) reject(error);
    });
    req.end(options.body);
  });
}

describe('engine process', () => {
  let base: string;
  let home: string;
  let userHome: string;
  let workspace: string;
  let repo: string;
  let cloud: FakeCloud;
  let fake: FakeRunnerModule;
  let engine: EngineApp | null;
  let port: number;
  let logLines: string[];

  const configure = (cloudUrl: string) => {
    mkdirSync(home, { recursive: true });
    writeSecretFile(path.join(home, 'engine.key'), `${KEY}\n`);
    saveEngineConfig(
      home,
      EngineConfig.parse({
        schemaVersion: 1,
        cloudUrl,
        engineId: 'eng_aaaaaaaaaaaa',
        name: 'test-mac',
        projects: [{ project: 'PM', workspacePath: workspace }],
        repos: [{ project: 'PM', repo: 'projectman', path: repo, fullTestCommand: 'npm test' }],
      }),
    );
  };

  const build = async (overrides: Partial<EngineAppOptions> = {}): Promise<EngineApp> => {
    const built = await buildEngineApp({
      home,
      userHome,
      port,
      version: '0.0.0-test',
      installDir: base,
      tmpdir: path.join(base, 'system-tmp'),
      agentEnv: {},
      heavyLockDir: path.join(base, 'heavy'),
      permissionTimeoutMs: 2000,
      relayWaitMs: 200,
      shutdownPauseMs: 5000,
      logger: { level: 'debug', stream: { write: (line: string) => void logLines.push(line) } },
      modules: {
        createRunnerModule: (opts) => fake.create(opts),
        github: new FakeGithub(),
        createFullTestExecutor: () =>
          ({ available: async () => ({ ok: true }), run: async () => ({}) }) as never,
        createScreenshotExecutor: () => ({ run: async () => ({}) }) as never,
        createMachineProbe: () =>
          ({
            machine: async () => ({}),
            processes: async () => [],
            envValues: async () => new Map(),
            signal: () => 'gone',
          }) as never,
        statusDelayMs: 5,
        random: () => 0,
      },
      ...overrides,
    });
    engine = built;
    return built;
  };

  const startEngine = async (overrides: Partial<EngineAppOptions> = {}) => {
    const built = await build(overrides);
    await built.start();
    return built;
  };

  /** The policy every start needs on an engine: the denied paths and the roots of a session come from it. */
  const policy = () => ({
    version: 1,
    enforcement: 'strict',
    access: 'task_worktree',
    placement: { kind: 'task_worktree', path: repo },
    tools: { team: { all: true, names: [] }, files: ['read'], shell: [] },
    filesystem: { readableRoots: [repo], writableRoots: [repo], protectedPaths: [] },
    deniedOperations: [],
    network: { allowedDomains: [], allowLocalBinding: false },
    outsideSandbox: 'deny',
    permissions: { claude: 'default', sandbox: 'workspace-write', approval: 'never' },
  });

  const startSpec = (overrides: Record<string, unknown> = {}) =>
    ({
      sessionId: 's1',
      claudeSessionId: 'c1',
      resume: false,
      cwd: repo,
      displayName: 'Dev',
      appendSystemPrompt: 'system',
      mcpToken: TOKEN,
      allowedTools: [],
      policy: policy(),
      ...overrides,
    }) as MethodParams<'session.start'>;

  beforeEach(async () => {
    base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'engine-app-')));
    home = path.join(base, 'home');
    userHome = path.join(base, 'user');
    workspace = path.join(base, 'work');
    repo = path.join(workspace, 'projectman');
    for (const dir of [userHome, repo]) mkdirSync(dir, { recursive: true });
    fake = createFakeRunnerModule();
    engine = null;
    logLines = [];
    port = await freePort();
    cloud = await startFakeCloud();
    configure(cloud.url);
  });

  afterEach(async () => {
    await engine?.close().catch(() => undefined);
    await cloud.close().catch(() => undefined);
    rmSync(base, { recursive: true, force: true });
  });

  describe('start-up', () => {
    it('connects with the machine key and tells the cloud what it serves', async () => {
      await startEngine();
      await cloud.connected();
      expect(cloud.authorizations).toEqual([`Bearer ${KEY}`]);
      const hello = cloud.hellos[0]!;
      expect(hello).toMatchObject({
        version: '0.0.0-test',
        projects: [{ project: 'PM', workspacePath: workspace }],
        repos: [{ project: 'PM', repo: 'projectman', fullTest: true }],
        pid: process.pid,
        uid: process.getuid?.() ?? null,
      });
      expect(hello.instanceTag).toMatch(/^[a-f0-9]{16}$/);
      expect(hello.bootId).toMatch(/^[a-f0-9]{16}$/);
      expect(hello.paths.home).toBe(realpathSync(home));
      // The hello is facts only: no key and no file contents.
      expect(JSON.stringify(hello)).not.toContain(KEY);
    });

    it('gives a new boot id at every start and the same instance tag for the same home', async () => {
      const first = await startEngine();
      await cloud.connected();
      await first.close();
      engine = null;
      port = await freePort();
      await startEngine();
      await cloud.connected(1);
      expect(cloud.hellos[1]!.bootId).not.toBe(cloud.hellos[0]!.bootId);
      expect(cloud.hellos[1]!.instanceTag).toBe(cloud.hellos[0]!.instanceTag);
    });

    it('refuses a key file that others can read, before it listens', async () => {
      chmodSync(path.join(home, 'engine.key'), 0o644);
      await expect(build()).rejects.toMatchObject({ code: 'secret_permissions' });
    });

    it('refuses a home that holds a projectman server database, before it listens', async () => {
      writeFileSync(path.join(home, 'db.sqlite-wal'), '');
      const error = await build().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(EngineConfigError);
      expect((error as EngineConfigError).code).toBe('home_in_use');
      expect((error as EngineConfigError).message).toContain('PROJECTMAN_HOME=~/.projectman-engine');
    });

    it('starts in the home of a move to the hybrid mode: the marker says the old database is a leftover (PM-318)', async () => {
      writeFileSync(path.join(home, 'db.sqlite'), '');
      writeInstanceMarker(home, 'engine', 'hybrid engine of the cloud');
      await startEngine();
      await cloud.connected();
      expect(statSync(path.join(home, 'db.sqlite')).size).toBe(0); // never opened, never changed
    });

    it('refuses a home with a damaged marker, before it listens (PM-318)', async () => {
      writeFileSync(path.join(home, 'instance.json'), '{nope');
      await expect(build()).rejects.toBeInstanceOf(InstanceMarkerError);
    });

    it('refuses a missing configuration with the way to fix it', async () => {
      rmSync(path.join(home, 'engine.json'));
      const error = await build().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(EngineConfigError);
      expect((error as EngineConfigError).code).toBe('config_missing');
      expect((error as EngineConfigError).message).toContain('init');
    });

    it('stops with a clear error for the managed VM profile', async () => {
      await expect(build({ executionProfile: 'managed_vm' })).rejects.toMatchObject({
        code: 'managed_vm_unsupported',
      });
      await expect(build({ boundaryConfig: '/etc/boundary.json' })).rejects.toMatchObject({
        code: 'managed_vm_unsupported',
      });
      expect(() => assertEngineProfile({ executionProfile: 'legacy' })).not.toThrow();
    });

    it('keeps the key file and the status file private', async () => {
      await startEngine();
      await cloud.connected();
      await waitFor(() => existsSync(path.join(home, 'engine-status.json')), 'the status file');
      for (const name of ['engine.key', 'engine.json', 'engine-status.json'])
        expect(fileMode(path.join(home, name))).toBe(0o600);
    });
  });

  describe('sessions for the cloud', () => {
    it('starts a session inside the registered workspace and gives the CLI the engine’s own address', async () => {
      await startEngine();
      const { call } = await cloud.connected();
      const info = await call('session.start', startSpec());
      expect(info.sessionId).toBe('s1');
      const spec = fake.runner.lastStarted();
      expect(spec.mcpUrl).toBe(`http://127.0.0.1:${port}/mcp/${TOKEN}`);
      // The sandbox is built here when the cloud sent none, and keeps the credential places out.
      expect(spec.sandbox?.denyRead).toContain(path.join(userHome, '.ssh'));
    });

    it('keeps the machine key out of every session, whatever the cloud sent', async () => {
      await startEngine();
      const { call } = await cloud.connected();
      const key = path.join(home, 'engine.key');
      await call('session.start', startSpec());
      expect(fake.runner.lastStarted().sandbox?.denyRead).toContain(key);
      expect(fake.runner.lastStarted().sandbox?.denyWrite).toEqual(
        expect.arrayContaining([key, path.join(home, 'engine.json')]),
      );
      await call('session.start', startSpec({ sessionId: 's-codex', provider: 'codex' }));
      expect(fake.runner.lastStarted().policy?.filesystem.deniedPaths).toContain(key);
    });

    it('refuses a start without a policy, whatever the provider, and starts nothing', async () => {
      await startEngine();
      const { call } = await cloud.connected();
      for (const provider of ['claude', 'codex', 'nanogpt', 'gemini'])
        await expect(
          call('session.start', { ...startSpec({ provider }), policy: undefined }),
        ).rejects.toMatchObject({ code: 'invalid_params' });
      expect(fake.runner.started).toHaveLength(0);
    });

    it('refuses a working directory outside the roots and starts nothing', async () => {
      await startEngine();
      const { call } = await cloud.connected();
      await expect(call('session.start', startSpec({ cwd: OUTSIDE }))).rejects.toMatchObject({
        code: 'path_outside_roots',
      });
      await expect(
        call('session.start', startSpec({ permissionMode: 'bypassPermissions' })),
      ).rejects.toMatchObject({
        code: 'permission_mode_too_high',
      });
      expect(fake.runner.started).toHaveLength(0);
    });

    it('refuses an mcp token that is not a token', async () => {
      await startEngine();
      const { call } = await cloud.connected();
      await expect(call('session.start', startSpec({ mcpToken: '../../x' }))).rejects.toMatchObject({
        code: 'invalid_params',
      });
      expect(fake.runner.started).toHaveLength(0);
    });

    it('refuses to signal a process that is not its own', async () => {
      await startEngine();
      const { call } = await cloud.connected();
      await expect(call('machine.signal', { pid: process.pid, signal: 'SIGTERM' })).rejects.toMatchObject({
        code: 'signal_not_allowed',
      });
    });

    it('refuses to make a session folder outside the roots', async () => {
      await startEngine({ sessionFoldersDir: path.join(home, 'session-folders') });
      const { call } = await cloud.connected();
      await expect(
        call('folders.make', { sessionId: 's1', dir: path.join(OUTSIDE, 'folder') }),
      ).rejects.toMatchObject({
        code: 'path_outside_roots',
      });
    });

    it('sends the runner’s events to the cloud in order, and terminal data only for an attached session', async () => {
      await startEngine();
      const { call } = await cloud.connected();
      await call('session.start', startSpec());
      fake.runner.setState('s1', 'working', 'thinking');
      fake.runner.emit({ type: 'terminal_data', sessionId: 's1', data: 'not attached' });
      await call('terminal.attach', { sessionId: 's1' });
      fake.runner.emit({ type: 'terminal_data', sessionId: 's1', data: 'attached' });
      await waitFor(() => cloud.terminals.length > 0, 'terminal data');
      expect(cloud.terminals).toEqual([{ sessionId: 's1', data: 'attached' }]);
      expect(
        cloud.received.some((entry) => entry.event.kind === 'runner' && entry.event.event.type === 'state'),
      ).toBe(true);
      const seqs = cloud.received.map((entry) => entry.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    });
  });

  describe('the NanoGPT key', () => {
    const nanogptKeyOf = () => fake.options()!.nanogptKey!;
    const readsKeyOnStart = () => {
      const original = fake.runner.start.bind(fake.runner);
      const seen: Array<string | null> = [];
      fake.runner.start = async (spec) => {
        // A real NanoGPT start asks for the key (twice here: it must still be one request).
        if (spec.provider === 'nanogpt') seen.push(await nanogptKeyOf()(), await nanogptKeyOf()());
        return original(spec);
      };
      return seen;
    };

    it('is requested for a starting NanoGPT session only, and not for any other start', async () => {
      const requests: string[] = [];
      cloud.handle('secret.nanogpt_key', ({ sessionId }) => {
        requests.push(sessionId);
        return { key: NANOGPT_KEY };
      });
      const seen = readsKeyOnStart();
      await startEngine();
      const { call } = await cloud.connected();
      await call('session.start', startSpec({ sessionId: 's-claude' }));
      await call('session.start', startSpec({ sessionId: 's-codex', provider: 'codex' }));
      expect(requests).toEqual([]);
      await call('session.start', startSpec({ sessionId: 's-nano', provider: 'nanogpt' }));
      expect(requests).toEqual(['s-nano']);
      expect(seen).toEqual([NANOGPT_KEY, NANOGPT_KEY]);
      // Outside a start (the plan usage, the login check) there is no key.
      await expect(nanogptKeyOf()()).resolves.toBeNull();
      expect(requests).toEqual(['s-nano']);
    });

    it('never reaches the log, the status file, the audit log or the hello', async () => {
      cloud.handle('secret.nanogpt_key', () => ({ key: NANOGPT_KEY }));
      readsKeyOnStart();
      await startEngine();
      const { call } = await cloud.connected();
      await call('session.start', startSpec({ sessionId: 's-nano', provider: 'nanogpt' }));
      await engine!.close();
      const texts = [
        logLines.join('\n'),
        readFileSync(path.join(home, 'engine-status.json'), 'utf8'),
        readFileSync(path.join(home, 'logs', 'engine-audit.jsonl'), 'utf8'),
        JSON.stringify(cloud.hellos),
      ];
      for (const text of texts) expect(text).not.toContain(NANOGPT_KEY);
    });

    it('is in the audit log with the method, the session and the outcome, without the key', async () => {
      cloud.handle('secret.nanogpt_key', ({ sessionId }) => {
        if (sessionId === 's-none') throw new Error('no key');
        return { key: NANOGPT_KEY };
      });
      readsKeyOnStart();
      await startEngine();
      const { call } = await cloud.connected();
      await call('session.start', startSpec({ sessionId: 's-nano', provider: 'nanogpt' }));
      await call('session.start', startSpec({ sessionId: 's-none', provider: 'nanogpt' }));
      await engine!.close();
      const text = readFileSync(path.join(home, 'logs', 'engine-audit.jsonl'), 'utf8');
      const records = text
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((record) => record.method === 'secret.nanogpt_key');
      // One record per start: the key is asked for once, however often the runner reads it.
      expect(records).toEqual([
        expect.objectContaining({ sessionId: 's-nano', outcome: 'ok', reqId: expect.any(String) }),
        expect.objectContaining({ sessionId: 's-none', outcome: 'error', code: 'internal' }),
      ]);
      expect(text).not.toContain(NANOGPT_KEY);
    });

    it('is not asked for again when the cloud has none to give', async () => {
      cloud.handle('secret.nanogpt_key', () => {
        throw new Error('no key');
      });
      const seen = readsKeyOnStart();
      await startEngine();
      const { call } = await cloud.connected();
      await call('session.start', startSpec({ provider: 'nanogpt' }));
      expect(seen).toEqual([null, null]);
    });
  });

  describe('team tools over the loopback address', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { note: 'SECRET-BODY-TEXT' },
    });
    const post = (token = TOKEN, headers: Record<string, string> = {}) =>
      rawRequest(port, {
        path: `/mcp/${token}`,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          host: `127.0.0.1:${port}`,
          ...headers,
        },
        body,
      });

    it('relays the call to the cloud and returns its answer', async () => {
      const relayed: Array<MethodParams<'mcp.relay'>> = [];
      cloud.handle('mcp.relay', (params) => {
        relayed.push(params);
        return { status: 200, contentType: 'application/json', body: '{"jsonrpc":"2.0","id":1,"result":{}}' };
      });
      await startEngine();
      await cloud.connected();
      const response = await post();
      expect(response.status).toBe(200);
      expect(response.body).toBe('{"jsonrpc":"2.0","id":1,"result":{}}');
      expect(relayed).toHaveLength(1);
      expect(relayed[0]).toMatchObject({
        token: TOKEN,
        contentType: 'application/json',
        accept: 'application/json',
        body,
      });
    });

    it('passes the cloud’s status through, and answers 502 for a status that cannot be one', async () => {
      let status = 202;
      cloud.handle('mcp.relay', () => ({ status, contentType: '', body: '' }));
      await startEngine();
      await cloud.connected();
      expect((await post()).status).toBe(202);
      status = 404;
      expect((await post()).status).toBe(404);
      status = 99;
      expect((await post()).status).toBe(502);
    });

    it('answers GET and DELETE with 405 and allow: POST', async () => {
      await startEngine();
      await cloud.connected();
      for (const method of ['GET', 'DELETE']) {
        const response = await rawRequest(port, {
          method,
          path: `/mcp/${TOKEN}`,
          headers: { host: `127.0.0.1:${port}` },
        });
        expect(response.status).toBe(405);
        expect(response.headers.allow).toBe('POST');
      }
    });

    it('answers 404 in JSON-RPC form for a malformed token, without asking the cloud', async () => {
      let asked = false;
      cloud.handle('mcp.relay', () => {
        asked = true;
        return { status: 200, contentType: '', body: '' };
      });
      await startEngine();
      await cloud.connected();
      const response = await post('x');
      expect(response.status).toBe(404);
      expect(JSON.parse(response.body)).toMatchObject({ jsonrpc: '2.0', error: { code: -32000 } });
      expect(asked).toBe(false);
    });

    it('answers 503 when the link is down', async () => {
      await cloud.close();
      await startEngine();
      const response = await post();
      expect(response.status).toBe(503);
      expect(JSON.parse(response.body)).toMatchObject({ jsonrpc: '2.0', error: { code: -32000 } });
    });

    it('refuses a request that is not local', async () => {
      let asked = false;
      cloud.handle('mcp.relay', () => {
        asked = true;
        return { status: 200, contentType: '', body: '' };
      });
      await startEngine();
      await cloud.connected();
      expect((await post(TOKEN, { host: 'engine.example.com' })).status).toBe(403);
      expect((await post(TOKEN, { 'x-forwarded-for': '203.0.113.9' })).status).toBe(403);
      expect((await post(TOKEN, { origin: 'https://evil.example.com' })).status).toBe(403);
      expect(asked).toBe(false);
    });

    it('refuses a body above 1 MiB', async () => {
      await startEngine();
      await cloud.connected();
      // The announced length is enough to refuse; the body is not written at all, so the answer
      // cannot race with a closing connection.
      const response = await rawRequest(port, {
        path: `/mcp/${TOKEN}`,
        headers: {
          'content-type': 'application/json',
          host: `127.0.0.1:${port}`,
          'content-length': String(1024 * 1024 + 10),
        },
      });
      expect(response.status).toBe(413);
    });

    it('has no /api, no web app and no control socket', async () => {
      await startEngine();
      await cloud.connected();
      for (const p of ['/api/projects', '/', '/engine/link', '/index.html'])
        expect(
          (await rawRequest(port, { method: 'GET', path: p, headers: { host: `127.0.0.1:${port}` } })).status,
        ).toBe(404);
      expect(existsSync(path.join(home, 'db.sqlite'))).toBe(false);
      expect(existsSync(path.join(home, 'control.sock'))).toBe(false);
    });

    it('listens on the loopback address only', async () => {
      const built = await startEngine();
      const address = built.app.server.address() as { address: string };
      expect(address.address).toBe('127.0.0.1');
    });
  });

  describe('permission decisions', () => {
    const request = { sessionId: 's1', toolName: 'Bash', toolInput: { command: 'ls' }, raw: {} };

    it('asks the cloud and returns its decision', async () => {
      cloud.handle('permission.decide', () => ({ behavior: 'allow' }));
      await startEngine();
      await cloud.connected();
      await expect(fake.broker().decide(request, new AbortController().signal)).resolves.toEqual({
        behavior: 'allow',
      });
    });

    it('denies and cancels the question when the wait is aborted', async () => {
      const decided: string[] = [];
      const cancelled: string[] = [];
      cloud.handle('permission.decide', (_params, context) => {
        decided.push(context.id);
        return new Promise(() => undefined);
      });
      cloud.handle('permission.cancel', ({ reqId }) => {
        cancelled.push(reqId);
        return null;
      });
      await startEngine();
      await cloud.connected();
      const controller = new AbortController();
      const decision = fake.broker().decide(request, controller.signal);
      await waitFor(() => decided.length === 1, 'the question to arrive');
      controller.abort();
      await expect(decision).resolves.toMatchObject({ behavior: 'deny' });
      await waitFor(() => cancelled.length === 1, 'the cancellation');
      expect(cancelled).toEqual(decided);
    });

    it('denies at once when the link is down, instead of leaving the agent waiting', async () => {
      await cloud.close();
      await startEngine({ relayWaitMs: 100 });
      await expect(fake.broker().decide(request, AbortSignal.timeout(150))).resolves.toMatchObject({
        behavior: 'deny',
      });
    });

    it('forwards a question, and gives false when the cloud cannot take it', async () => {
      cloud.handle('permission.forward_question', () => true);
      await startEngine();
      await cloud.connected();
      const info = { sessionId: 's1', toolName: 'AskUserQuestion', toolInput: {} };
      await expect(fake.broker().forwardQuestion!(info)).resolves.toBe(true);
    });

    it('reports a refusal of the agent’s auto mode as an event', async () => {
      await startEngine();
      await cloud.connected();
      fake.broker().refused!({ sessionId: 's1', toolName: 'Bash', toolInput: {}, reason: 'no' });
      await waitFor(
        () => cloud.received.some((entry) => entry.event.kind === 'refused'),
        'the refusal event',
      );
    });
  });

  describe('log and audit', () => {
    it('keeps prompts, messages, tokens and request bodies out of every log', async () => {
      cloud.handle('mcp.relay', () => ({ status: 200, contentType: 'application/json', body: '{}' }));
      await startEngine();
      const { call } = await cloud.connected();
      await call(
        'session.start',
        startSpec({ initialMessage: 'SECRET-PROMPT-TEXT', appendSystemPrompt: 'SECRET-SYSTEM-TEXT' }),
      );
      await call('session.send', { sessionId: 's1', message: 'SECRET-MESSAGE-TEXT' });
      await rawRequest(port, {
        path: `/mcp/${TOKEN}`,
        headers: { 'content-type': 'application/json', host: `127.0.0.1:${port}` },
        body: '{"note":"SECRET-BODY-TEXT"}',
      });
      await call('session.start', startSpec({ sessionId: 's2', cwd: OUTSIDE })).catch(() => undefined);
      await engine!.close();
      const everything = [
        logLines.join('\n'),
        readFileSync(path.join(home, 'logs', 'engine-audit.jsonl'), 'utf8'),
      ].join('\n');
      for (const secret of [
        'SECRET-PROMPT-TEXT',
        'SECRET-SYSTEM-TEXT',
        'SECRET-MESSAGE-TEXT',
        'SECRET-BODY-TEXT',
        TOKEN,
        KEY,
      ])
        expect(everything).not.toContain(secret);
    });

    it('records every request with its outcome, and the refused ones with a code', async () => {
      await startEngine();
      const { call } = await cloud.connected();
      await call('session.start', startSpec());
      await call('session.start', startSpec({ sessionId: 's2', cwd: OUTSIDE })).catch(() => undefined);
      await engine!.close();
      const records = readFileSync(path.join(home, 'logs', 'engine-audit.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records).toContainEqual(
        expect.objectContaining({ method: 'session.start', sessionId: 's1', outcome: 'ok' }),
      );
      expect(records).toContainEqual(
        expect.objectContaining({
          method: 'session.start',
          sessionId: 's2',
          outcome: 'refused',
          code: 'path_outside_roots',
        }),
      );
      for (const record of records) expect(typeof record.at).toBe('string');
    });

    it('records a request refused before any handler (an unknown method or invalid parameters)', async () => {
      await startEngine();
      await cloud.connected();
      cloud.sendRequest('bad1', 'session.start', { nope: true });
      cloud.sendRequest('bad2', 'no.such_method', {});
      const auditFile = path.join(home, 'logs', 'engine-audit.jsonl');
      const audit = () => (existsSync(auditFile) ? readFileSync(auditFile, 'utf8') : '');
      await waitFor(() => audit().includes('bad2'), 'the audit records');
      expect(audit()).toMatch(
        /"reqId":"bad1".*"outcome":"refused".*"code":"invalid_params"|"code":"invalid_params".*"reqId":"bad1"/,
      );
      expect(audit()).toContain('unknown_method');
    });
  });

  describe('shutdown', () => {
    it('pauses the running sessions first, then stops them and tells the cloud', async () => {
      const built = await startEngine();
      const { call } = await cloud.connected();
      await call('session.start', startSpec());
      await built.pauseForShutdown();
      expect(fake.runner.pauses).toEqual([{ sessionId: 's1', opts: { forceAfterMs: 5000 } }]);
      await built.close();
      engine = null;
      expect(fake.runner.stopped).toContain('s1');
      expect(
        cloud.received.some((entry) => entry.event.kind === 'runner' && entry.event.event.type === 'exit'),
      ).toBe(true);
      await waitFor(() => cloud.closeCodes.length > 0, 'the link to close');
      expect(JSON.parse(readFileSync(path.join(home, 'engine-status.json'), 'utf8'))).toMatchObject({
        connection: 'stopped',
      });
    });

    it('does not pause anything when the pause time is zero', async () => {
      const built = await startEngine({ shutdownPauseMs: 0 });
      const { call } = await cloud.connected();
      await call('session.start', startSpec());
      await built.pauseForShutdown();
      expect(fake.runner.pauses).toHaveLength(0);
    });

    it('closes twice without trouble', async () => {
      const built = await startEngine();
      await cloud.connected();
      await built.close();
      await built.close();
      engine = null;
    });
  });
});

function fileMode(file: string): number {
  return statSync(file).mode & 0o777;
}
