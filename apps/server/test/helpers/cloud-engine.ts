import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Socket as NetSocket } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { expect, vi } from 'vitest';
import { routes } from '@projectman/shared';
import { decodeFrame, encodeFrame, ENGINE_PROTOCOL_VERSION } from '../../src/engine-link';
import type { EngineErrorCode, EngineFrame, Hello } from '../../src/engine-link';
import { createHybridPackage } from '../../../../scripts/migrate/hybrid';
import { copyTree } from '../../../../scripts/migrate/copy';
import type { HybridPackageResult } from '../../../../scripts/migrate/hybrid';
import { engineHome } from '../../../../scripts/migrate/instance';
import { buildApp } from '../../src/app';
import { createTemplateRegistry } from '../../src/core/base';
import type { WorktreeManager } from '../../src/contracts';
import { buildEngineApp } from '../../src/engine-app';
import type { EngineApp, EngineAppOptions } from '../../src/engine-app';
import { freePort } from '../../src/runner/test-helpers';
import { cookieOf, inject, OWNER_LOGIN } from './app-harness';
import { createFakeRunnerModule, FakeContextBuilder, FakeMachineGithub, FakeMemoryStore } from './fakes';
import type { FakeRunnerModule } from './fakes';
import { stoppedSourceHomes } from './migration-source';
import type { SourceHome } from './migration-source';
import { testTemplate } from './test-template';

/**
 * The hybrid mode as one machine runs it in a test (PM-667): the real cloud composition
 * (`buildApp({ engineMode: 'cloud' })`) listening on a loopback port over the data a hybrid package
 * carries, and the real engine process (`buildEngineApp`) on the Mac's home, joined by the real machine-key
 * link. Both use disposable homes and a disposable repository; the CLIs are the fake runner (no process, no
 * pseudo-terminal), so nothing of the live installation, a real `claude`, `codex` or `gh` is touched.
 */

const CLOUD_VERSION = 'integration-version';
/** The core count the engine's fake machine probe reports: it proves a machine display came from the engine. */
export const ENGINE_CORES = 42;
const AT = new Date('2026-10-09T10:00:00.000Z');

export interface CloudEngineWorld {
  /** The Mac's home as it was before the move (the engine's home afterwards), with its repository. */
  src: SourceHome;
  /** The package the cloud's data came from. */
  packaged: HybridPackageResult;
  /** The cloud's data: a copy of the package's `home/`. */
  cloudHome: string;
  cloudUrl: string;
  cloudPort: number;
  /** The engine's key file; its content is for the tests of the link only. */
  keyFile: string;
  /** The running cloud, or null between a `stopCloud` and the next `startCloud`. */
  cloud: FastifyInstance | null;
  /** The running engine and the fake runner module it was built with, or null while none runs. */
  engine: EngineApp | null;
  fake: FakeRunnerModule | null;
  /** Everything the cloud's own worktree manager was asked: the cloud must not touch a repository. */
  cloudWorktreeCalls: string[];
  cookie: string;
  /**
   * The random number the engine's reconnect delay is taken from, 0 to 1: 0 reconnects in half the backoff
   * base (fast), 1 in the full base (a window of about a second in which the link is observably down).
   */
  reconnectJitter: number;
  startCloud(): Promise<FastifyInstance>;
  stopCloud(): Promise<void>;
  startEngine(over?: Partial<EngineAppOptions>): Promise<EngineApp>;
  stopEngine(): Promise<void>;
  /** The running engine's link is up in the cloud's registry. */
  engineOnline(): boolean;
  cleanup(): Promise<void>;
}

/** A worktree manager that records every call and refuses it: the cloud composition never uses one. */
function forbiddenWorktrees(calls: string[]): WorktreeManager {
  return new Proxy({} as WorktreeManager, {
    get(_target, name) {
      if (typeof name !== 'string' || name === 'then') return undefined;
      return () => {
        calls.push(name);
        throw new Error(`the cloud composition must not call worktrees.${name}`);
      };
    },
  });
}

interface CloudEngineOptions {
  /** What the cloud reports as its own version (the engine reports the same unless it is changed). */
  version?: string;
}

/** The stopped source home every world starts from: built once, put back for each world. */
const sourceHomes = stoppedSourceHomes();

export async function createCloudEngineWorld(options: CloudEngineOptions = {}): Promise<CloudEngineWorld> {
  const version = options.version ?? CLOUD_VERSION;
  const { src } = await sourceHomes();
  const cloudPort = await freePort();
  const cloudUrl = `http://127.0.0.1:${cloudPort}`;
  const out = join(src.root, 'cloud-package');
  const packaged = await createHybridPackage({
    home: src.home,
    out,
    engineName: 'MacBook',
    cloudUrl,
    now: () => AT,
  });
  const cloudHome = join(src.root, 'cloud-data');
  copyTree(join(out, 'home'), cloudHome);
  chmodSync(cloudHome, 0o700);
  // The move is complete: the Mac's home works as the engine's from now on.
  engineHome(src.home, 'hybrid', AT);

  const world = { cloudWorktreeCalls: [] as string[] };
  const keyFile = join(src.home, 'engine.key');
  const tmpdir = join(src.root, 'system-tmp');
  mkdirSync(tmpdir, { recursive: true });
  const userHome = join(src.root, 'user');
  mkdirSync(userHome, { recursive: true });

  const state: CloudEngineWorld = {
    src,
    packaged,
    cloudHome,
    cloudUrl,
    cloudPort,
    keyFile,
    cloud: null,
    engine: null,
    fake: null,
    cloudWorktreeCalls: world.cloudWorktreeCalls,
    cookie: '',
    reconnectJitter: 0,
    async startCloud() {
      if (state.cloud) throw new Error('the cloud is running');
      const app = await buildApp({
        home: cloudHome,
        engineMode: 'cloud',
        appVersion: version,
        logger: false,
        webDistDir: null,
        planUsageTtlMs: 0,
        doneCleanupDelayMs: 0,
        screenQuestions: false,
        freeDiskBytes: async () => null,
        controlSocket: false,
        claudeTmpRoots: [],
        shutdownPauseMs: 0,
        modules: {
          contextPackBuilder: new FakeContextBuilder(),
          memberMemory: new FakeMemoryStore(),
          worktrees: forbiddenWorktrees(world.cloudWorktreeCalls),
          templates: createTemplateRegistry([testTemplate]),
        },
      });
      await app.listen({ host: '127.0.0.1', port: cloudPort });
      state.cloud = app;
      const login = await inject(app, 'POST', routes.login(), null, {
        email: OWNER_LOGIN.email,
        password: OWNER_LOGIN.password,
      });
      if (login.statusCode !== 200) throw new Error(`login failed: ${login.statusCode} ${login.body}`);
      state.cookie = cookieOf(login);
      return app;
    },
    async stopCloud() {
      const app = state.cloud;
      state.cloud = null;
      await app?.close();
    },
    async startEngine(over = {}) {
      if (state.engine) throw new Error('the engine is running');
      const fake = createFakeRunnerModule();
      const engine = await buildEngineApp({
        home: src.home,
        userHome,
        port: await freePort(),
        version,
        installDir: src.root,
        tmpdir,
        // The session folders the engine process keeps below the system temp directory, as `index.ts` names them.
        sessionFoldersDir: join(tmpdir, 'projectman-sessions', 'engine'),
        agentEnv: {},
        heavyLockDir: join(src.root, 'heavy'),
        permissionTimeoutMs: 2000,
        relayWaitMs: 1500,
        shutdownPauseMs: 0,
        logger: false,
        modules: {
          createRunnerModule: (opts) => fake.create(opts),
          github: new FakeMachineGithub(),
          createFullTestExecutor: () =>
            ({ available: async () => ({ ok: true }), run: async () => ({}) }) as never,
          createScreenshotExecutor: () => ({ run: async () => ({}) }) as never,
          createMachineProbe: () => ({
            machine: async () => ({
              cpu: null,
              cores: ENGINE_CORES,
              memoryUsedBytes: null,
              memoryTotalBytes: null,
              memoryPressure: null,
              swapUsedBytes: null,
              swapTotalBytes: null,
            }),
            processes: async () => [],
            envValues: async () => new Map(),
            signal: async () => 'gone',
          }),
          statusDelayMs: 5,
          random: () => state.reconnectJitter,
          // PM-1086: a test never starts the real caffeinate.
          keepAwake: { platform: 'linux' },
        },
        ...over,
      });
      state.engine = engine;
      state.fake = fake;
      await engine.start();
      return engine;
    },
    async stopEngine() {
      const engine = state.engine;
      state.engine = null;
      await engine?.close().catch(() => undefined);
    },
    engineOnline() {
      return (
        state.cloud?.projectman.engineRegistry
          ?.status()
          .some((item) => item.id === packaged.engine.id && item.online) ?? false
      );
    },
    async cleanup() {
      await state.stopEngine();
      await state.stopCloud();
      await src.cleanup();
    },
  };
  return state;
}

interface RawSocket {
  send(data: string): void;
  terminate(): void;
  on(event: 'message', listener: (data: Buffer) => void): void;
  on(event: 'close', listener: (code: number) => void): void;
}

/** The hello of an engine that is only a socket in a test (it owns no session and answers nothing). */
export function rawHello(over: Partial<Hello> = {}): Hello {
  return {
    t: 'hello',
    protocol: ENGINE_PROTOCOL_VERSION,
    version: CLOUD_VERSION,
    hostname: 'raw-engine',
    platform: 'darwin',
    paths: {
      userHome: '/fictional/user',
      home: '/fictional/engine',
      worktreesRoot: '/fictional/engine/worktrees',
      workspacesRoot: null,
      installDir: null,
      sessionFoldersRoot: '/fictional/engine/folders',
      sessionTmpRoot: null,
      claudeTmpRoots: [],
      browsersDir: null,
      heavyLockDir: null,
      gitExcludesFile: null,
    },
    projects: [],
    repos: [],
    providers: [],
    running: [],
    nextSeq: 1,
    instanceTag: 'fedcba9876543210',
    pid: 4242,
    uid: 501,
    bootId: 'dddddddddddddddd',
    ...over,
  };
}

interface RawEngine {
  /** Sends a request to the cloud over this link and waits for its reply frame. */
  call(method: string, params: unknown): Promise<Extract<EngineFrame, { t: 'res' }>>;
  /** The close code once the cloud closed the link. */
  closed(): number | undefined;
  close(): void;
}

/** What a `connectRawEngine` answer returns to refuse a request with the link's own error code (e.g. `path_outside_roots`). */
export class RawEngineRefusal {
  readonly code: EngineErrorCode;
  readonly message = 'refused';
  constructor(code: EngineErrorCode) {
    this.code = code;
  }
}

/**
 * A second engine as a bare socket on the cloud's real link route: it says hello with the key of another
 * engine record and can call the cloud, which is how a session token of one engine is tried from another.
 * With `answer` it also replies to the cloud's requests (the result it returns); without, it leaves them unanswered.
 */
export async function connectRawEngine(
  cloud: FastifyInstance,
  key: string,
  greeting: Hello = rawHello(),
  answer?: (method: string, params: unknown) => unknown,
): Promise<RawEngine> {
  const frames: EngineFrame[] = [];
  let closed: number | undefined;
  const ws = (await cloud.injectWS(
    routes.engineLink(),
    {
      socket: { remoteAddress: '127.0.0.1' } as NetSocket,
      headers: { host: 'localhost', authorization: `Bearer ${key}` },
    },
    {
      onInit: (raw) => {
        const socket = raw as unknown as RawSocket;
        socket.on('message', (data) => {
          const frame = decodeFrame(data);
          frames.push(frame);
          if (answer && frame.t === 'req') {
            // An answer that returns `RawEngineRefusal` replies with a wire error instead of a result.
            const result = answer(frame.method, frame.params);
            socket.send(
              encodeFrame(
                result instanceof RawEngineRefusal
                  ? {
                      t: 'res',
                      id: frame.id,
                      ok: false,
                      error: { code: result.code, message: result.message },
                    }
                  : { t: 'res', id: frame.id, ok: true, result },
              ),
            );
          }
        });
        socket.on('close', (code) => {
          closed = code;
        });
      },
    },
  )) as unknown as RawSocket;
  ws.send(encodeFrame(greeting));
  await vi.waitFor(() => expect(frames.some((frame) => frame.t === 'welcome')).toBe(true));
  let calls = 0;
  return {
    async call(method, params) {
      const id = `raw-${++calls}`;
      ws.send(encodeFrame({ t: 'req', id, method, params }));
      await vi.waitFor(() => expect(frames.some((frame) => frame.t === 'res' && frame.id === id)).toBe(true));
      const reply = frames.find((frame) => frame.t === 'res' && frame.id === id);
      if (reply?.t !== 'res') throw new Error('no reply');
      return reply;
    },
    closed: () => closed,
    close: () => ws.terminate(),
  };
}

/** Ends every link the cloud holds from the cloud's side, without revoking anything (a network drop). */
export function dropLinks(cloud: FastifyInstance): void {
  for (const client of cloud.websocketServer.clients) client.terminate();
}

/** Says a hello on the link and returns the code the cloud closes it with (the hello is not welcomed). */
export async function closeCodeOfHello(
  cloud: FastifyInstance,
  key: string,
  greeting: Hello,
): Promise<number> {
  let closed: number | undefined;
  const ws = (await cloud.injectWS(
    routes.engineLink(),
    {
      socket: { remoteAddress: '127.0.0.1' } as NetSocket,
      headers: { host: 'localhost', authorization: `Bearer ${key}` },
    },
    {
      onInit: (raw) => {
        (raw as unknown as RawSocket).on('close', (code) => {
          closed = code;
        });
      },
    },
  )) as unknown as RawSocket;
  ws.send(encodeFrame(greeting));
  await vi.waitFor(() => expect(closed).toBeDefined());
  return closed!;
}

/** The file names below a directory, sorted (the empty list when it does not exist). */
export function filesIn(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

/** The machine key as the Mac keeps it (for the tests of the link itself). */
export function readEngineKey(world: CloudEngineWorld): string {
  return readFileSync(world.keyFile, 'utf8').trim();
}
