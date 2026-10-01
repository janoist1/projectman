import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { BILLING_ENV_VARS } from '../../runner';
import type { WorkerProgram } from '../../contracts';
import type { BoundaryConfig } from '../config';
import { isWithin } from '../config';
import {
  ClientFrame,
  DEFAULT_RUN_TIMEOUT_MS,
  LAUNCHER_PROTOCOL_VERSION,
  LauncherRequest,
  MAX_FRAME_BYTES,
  MAX_REQUEST_BYTES,
  frame,
  lineReader,
} from './protocol';
import type { LauncherErrorCode, RunRequest, StartRequest } from './protocol';

/**
 * The protected launcher (PM-140). It runs as root, reachable only through its socket (root and
 * the service's group, mode 0660), and does exactly two things for the service: start an agent
 * session as a member's worker account and relay its terminal, and run one pinned program as a
 * worker and return its output. Each runs as a transient systemd unit with the worker's uid and
 * a fixed sandbox (below); the caller chooses none of the account, the program path, the
 * environment or the sandbox. It holds no secret and writes no audit: the service does.
 */

export interface WorkerAccount {
  user: string;
  uid: number;
  gid: number;
  home: string;
}

/** Account lookup (`/etc/passwd` in production). */
export interface AccountLookup {
  byName(name: string): WorkerAccount | null;
  /** Every account (the egress proxy maps a socket's uid back to its worker). */
  list(): WorkerAccount[];
}

/** A process in a pseudo-terminal (node-pty in production). */
export interface LauncherPty {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
}

/** A piped child process (child_process.spawn in production). */
export interface LauncherChild {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

export interface LauncherDeps {
  config: BoundaryConfig;
  accounts: AccountLookup;
  spawnPty(
    file: string,
    args: string[],
    opts: { cols: number; rows: number; env: Record<string, string> },
  ): LauncherPty;
  spawnChild(file: string, args: string[], opts: { env: Record<string, string> }): LauncherChild;
  log(level: 'info' | 'warn' | 'error', fields: Record<string, unknown>, message: string): void;
}

const MAX_OUTPUT = 8 * 1024 * 1024;
/** The launcher's own environment for systemd-run: nothing of the caller's. */
const LAUNCHER_ENV = { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' };

/**
 * Paths a worker process never sees: the system bus and systemd's private and transient unit
 * files (their command lines hold other sessions' tokens), the resolver's sockets (DNS would be a
 * way out), container and Tailscale sockets, the service's home and the launcher's own socket.
 * Most are closed by permissions already; this is the second lock. `-` ignores a missing path.
 */
const INACCESSIBLE = [
  '/run/dbus',
  '/run/systemd/private',
  '/run/systemd/transient',
  '/run/systemd/resolve',
  '/run/systemd/userdb',
  '/run/tailscale',
  '/var/run/tailscale',
  '/run/docker.sock',
  '/var/run/docker.sock',
  '/run/containerd',
  '/run/podman',
  '/var/lib/projectman',
  '/var/lib/projectman-boundary',
];

export class LauncherRefusal extends Error {
  readonly code: LauncherErrorCode;
  constructor(code: LauncherErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** The worker account of a member, checked against the configuration. */
export function workerAccount(
  config: BoundaryConfig,
  accounts: AccountLookup,
  member: string,
): WorkerAccount {
  const user = `${config.workers.prefix}${member}`;
  const account = accounts.byName(user);
  const home = path.posix.join(config.workers.homeRoot, member);
  if (
    !account ||
    account.user !== user ||
    account.uid < config.workers.uidMin ||
    account.uid > config.workers.uidMax ||
    account.gid < 1000 ||
    account.home !== home
  )
    throw new LauncherRefusal('unknown_worker', `no worker account for ${member}`);
  return account;
}

/** A working directory: normalized, absolute and inside the worker's home. */
export function checkCwd(worker: WorkerAccount, cwd: string): string {
  if (!path.posix.isAbsolute(cwd) || path.posix.normalize(cwd) !== cwd || (cwd.endsWith('/') && cwd !== '/'))
    throw new LauncherRefusal(
      'cwd_outside_home',
      'the working directory must be an absolute, normalized path',
    );
  if (!isWithin(cwd, worker.home))
    throw new LauncherRefusal('cwd_outside_home', 'the working directory must be inside the worker home');
  return cwd;
}

/** The program a request names, as a fixed command line prefix. */
export function programArgv(config: BoundaryConfig, program: WorkerProgram): string[] {
  if (program === 'claude-trust')
    return [config.programs.node, path.posix.join(config.appDir, 'apps/server/dist/claude-trust.js')];
  return [config.programs[program]];
}

/** Agent CLI arguments must not name a billing variable (an inline settings `env`, for example). */
function checkArguments(program: WorkerProgram, args: string[]): void {
  if (program !== 'claude' && program !== 'codex' && program !== 'claude-trust') return;
  for (const arg of args)
    for (const name of BILLING_ENV_VARS)
      if (arg.includes(name))
        throw new LauncherRefusal('forbidden_argument', `arguments must not name ${name}`);
}

/** The worker's environment, built from nothing but the configuration and the request's ids. */
export function workerEnvironment(
  config: BoundaryConfig,
  worker: WorkerAccount,
  session: { sessionId: string; egressToken: string } | null,
): Record<string, string> {
  const proxyAuth = session ? `projectman:${session.egressToken}@` : '';
  const proxy = `http://${proxyAuth}${config.egress.host}:${config.egress.port}`;
  const noProxy = '127.0.0.1,localhost,::1';
  return {
    HOME: worker.home,
    USER: worker.user,
    LOGNAME: worker.user,
    SHELL: '/bin/bash',
    PATH: config.workerPath,
    LANG: 'C.UTF-8',
    TERM: session ? 'xterm-256color' : 'dumb',
    ...(session ? { COLORTERM: 'truecolor', PROJECTMAN_SESSION_ID: session.sessionId } : {}),
    // The pinned CLIs never update themselves and send no telemetry or error reports.
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    GIT_TERMINAL_PROMPT: '0',
    // Every way out goes through the egress proxy; programs that ignore these fail closed.
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    ALL_PROXY: proxy,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    NODE_USE_ENV_PROXY: '1',
  };
}

/** The sandbox of every worker unit (systemd properties). */
export function unitProperties(config: BoundaryConfig, worker: WorkerAccount, member: string): string[] {
  const spoolOut = path.posix.join(config.workers.spoolRoot, member, 'out');
  const properties = [
    `User=${worker.user}`,
    `Group=${worker.gid}`,
    'NoNewPrivileges=yes',
    'CapabilityBoundingSet=',
    'AmbientCapabilities=',
    'PrivateTmp=yes',
    'PrivateDevices=yes',
    'PrivateIPC=yes',
    'ProtectSystem=strict',
    'ProtectHome=yes',
    `ReadWritePaths=${worker.home} -${spoolOut}`,
    'ProtectProc=invisible',
    'ProtectKernelTunables=yes',
    'ProtectKernelModules=yes',
    'ProtectKernelLogs=yes',
    'ProtectControlGroups=yes',
    'ProtectClock=yes',
    'ProtectHostname=yes',
    'RestrictSUIDSGID=yes',
    'RestrictRealtime=yes',
    'RestrictNamespaces=yes',
    'LockPersonality=yes',
    'KeyringMode=private',
    'UMask=0027',
    'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK',
    // Loopback only, enforced by the kernel for the unit's cgroup (the nft gate is the first lock).
    'IPAddressDeny=any',
    'IPAddressAllow=localhost',
    `InaccessiblePaths=${INACCESSIBLE.map((p) => `-${p}`).join(' ')}`,
    'SystemCallArchitectures=native',
    'SystemCallFilter=~@mount @swap @reboot @raw-io @module @clock @cpu-emulation @obsolete',
    'TasksMax=1024',
    'LimitCORE=0',
    'Slice=projectman-workers.slice',
  ];
  return properties.flatMap((p) => ['-p', p]);
}

function setenvArgs(env: Record<string, string>): string[] {
  return Object.entries(env).map(([k, v]) => `--setenv=${k}=${v}`);
}

/** systemd-run command line of an interactive session (its terminal is systemd-run's). */
export function sessionCommand(
  config: BoundaryConfig,
  worker: WorkerAccount,
  request: StartRequest,
): { file: string; args: string[]; unit: string } {
  const unit = `projectman-session-${request.sessionId.replace(/_/g, '-')}`;
  const cwd = checkCwd(worker, request.cwd);
  checkArguments(request.provider, request.args);
  return {
    file: config.systemdRun,
    unit,
    args: [
      '--quiet',
      '--collect',
      '--wait',
      '--pty',
      // Arguments are data: no ${VAR} expansion of a system prompt or a path.
      '--expand-environment=no',
      `--unit=${unit}`,
      `--working-directory=${cwd}`,
      ...unitProperties(config, worker, request.member),
      ...setenvArgs(workerEnvironment(config, worker, request)),
      '--',
      ...programArgv(config, request.provider),
      ...request.args,
    ],
  };
}

/** systemd-run command line of a one-off program (piped output, no terminal). */
export function runCommand(
  config: BoundaryConfig,
  worker: WorkerAccount,
  request: RunRequest,
  id: string,
): { file: string; args: string[]; unit: string } {
  const unit = `projectman-run-${request.member}-${id}`;
  const cwd = checkCwd(worker, request.cwd);
  checkArguments(request.program, request.args);
  return {
    file: config.systemdRun,
    unit,
    args: [
      '--quiet',
      '--collect',
      '--wait',
      '--pipe',
      '--expand-environment=no',
      `--unit=${unit}`,
      `--working-directory=${cwd}`,
      ...unitProperties(config, worker, request.member),
      ...setenvArgs(workerEnvironment(config, worker, null)),
      '--',
      ...programArgv(config, request.program),
      ...request.args,
    ],
  };
}

interface LiveSession {
  pty: LauncherPty;
  unit: string;
}

/** The launcher's request handling; `main.ts` binds it to the socket. */
export function createLauncher(deps: LauncherDeps) {
  const { config } = deps;
  const sessions = new Map<string, LiveSession>();

  function stopUnit(unit: string, signal?: string): void {
    const args = signal
      ? ['kill', `--signal=${signal}`, '--', `${unit}.service`]
      : ['stop', '--no-block', '--', `${unit}.service`];
    try {
      const child = deps.spawnChild(config.systemctl, args, { env: LAUNCHER_ENV });
      child.on('error', () => undefined);
      child.on('close', () => undefined);
    } catch (err) {
      deps.log('warn', { unit, err: (err as Error).message }, 'could not stop a worker unit');
    }
  }

  function refuse(conn: Duplex, code: LauncherErrorCode, message: string): void {
    conn.end(frame({ ok: false, error: code, message: message.slice(0, 500) }));
  }

  function handleRun(conn: Duplex, request: RunRequest): void {
    const worker = workerAccount(config, deps.accounts, request.member);
    const id = randomBytes(6).toString('hex');
    const command = runCommand(config, worker, request, id);
    const child = deps.spawnChild(command.file, command.args, { env: LAUNCHER_ENV });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const collect = (stream: NodeJS.ReadableStream | null, into: 'out' | 'err') => {
      stream?.setEncoding('utf8');
      stream?.on('data', (chunk: string) => {
        if (into === 'out' && stdout.length < MAX_OUTPUT) stdout += chunk;
        if (into === 'err' && stderr.length < MAX_OUTPUT) stderr += chunk;
      });
    };
    collect(child.stdout, 'out');
    collect(child.stderr, 'err');
    const timer = setTimeout(() => {
      timedOut = true;
      stopUnit(command.unit, 'SIGKILL');
      child.kill('SIGKILL');
    }, request.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS);
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.end(frame({ ok: true, exitCode: timedOut ? null : exitCode, stdout, stderr, timedOut }));
    };
    child.on('error', (err) => {
      deps.log('warn', { member: request.member, program: request.program, err: err.message }, 'run failed');
      finish(null);
    });
    child.on('close', (code) => finish(code));
    // The caller gave up: the unit goes too.
    conn.on('close', () => {
      if (!settled) {
        stopUnit(command.unit, 'SIGKILL');
        child.kill('SIGKILL');
      }
    });
  }

  function handleStart(conn: Duplex, request: StartRequest): void {
    if (sessions.has(request.sessionId))
      throw new LauncherRefusal('session_exists', 'the session is running');
    if (sessions.size >= config.launcher.maxSessions)
      throw new LauncherRefusal('too_many_sessions', 'too many sessions are running');
    const worker = workerAccount(config, deps.accounts, request.member);
    const command = sessionCommand(config, worker, request);
    let pty: LauncherPty;
    try {
      pty = deps.spawnPty(command.file, command.args, {
        cols: request.cols,
        rows: request.rows,
        env: LAUNCHER_ENV,
      });
    } catch (err) {
      throw new LauncherRefusal('spawn_failed', `could not start the session: ${(err as Error).message}`);
    }
    const live: LiveSession = { pty, unit: command.unit };
    sessions.set(request.sessionId, live);
    let exited = false;
    deps.log(
      'info',
      { sessionId: request.sessionId, member: request.member, unit: command.unit },
      'session started',
    );
    conn.write(frame({ ok: true, pid: pty.pid }));
    pty.onData((data) => {
      if (!conn.destroyed) conn.write(frame({ t: 'data', data }));
    });
    pty.onExit(({ exitCode, signal }) => {
      exited = true;
      sessions.delete(request.sessionId);
      // systemd-run may end before its unit (a lost bus): make sure nothing of it stays.
      stopUnit(command.unit);
      deps.log('info', { sessionId: request.sessionId, exitCode, signal: signal ?? null }, 'session ended');
      if (!conn.destroyed) conn.end(frame({ t: 'exit', exitCode, signal: signal ?? null }));
    });
    const read = lineReader(
      MAX_FRAME_BYTES * 2,
      (value) => {
        const parsed = ClientFrame.safeParse(value);
        if (!parsed.success) return;
        const message = parsed.data;
        if (message.t === 'input') pty.write(message.data);
        else if (message.t === 'resize') pty.resize(message.cols, message.rows);
        else stopUnit(command.unit, message.signal ?? 'SIGTERM');
      },
      () => conn.destroy(),
    );
    conn.on('data', read);
    // The service went away (restart, crash) or hung up: the session does not outlive its relay.
    let relayLost = false;
    const lost = () => {
      if (exited || relayLost) return;
      relayLost = true;
      stopUnit(command.unit);
    };
    conn.on('end', lost);
    conn.on('close', lost);
  }

  function handle(conn: Duplex): void {
    let answered = false;
    const read = lineReader(
      MAX_REQUEST_BYTES + 1024,
      (value) => {
        if (answered) return;
        answered = true;
        conn.removeListener('data', read);
        const parsed = LauncherRequest.safeParse(value);
        if (!parsed.success) return refuse(conn, 'invalid_request', 'invalid request');
        const request = parsed.data;
        try {
          if (request.op === 'ping') conn.end(frame({ ok: true, version: LAUNCHER_PROTOCOL_VERSION }));
          else if (request.op === 'run') handleRun(conn, request);
          else handleStart(conn, request);
        } catch (err) {
          if (err instanceof LauncherRefusal) {
            deps.log('warn', { op: request.op, code: err.code }, 'request refused');
            refuse(conn, err.code, err.message);
          } else {
            deps.log('error', { op: request.op, err: (err as Error).message }, 'request failed');
            refuse(conn, 'spawn_failed', 'the launcher could not handle the request');
          }
        }
      },
      () => refuse(conn, 'invalid_request', 'invalid request'),
    );
    conn.on('data', read);
    conn.on('error', () => undefined);
  }

  return {
    handle,
    /** Live sessions (for tests and the shutdown). */
    sessionCount: () => sessions.size,
    /** Stops every session (launcher shutdown). */
    stopAll(): void {
      for (const live of sessions.values()) stopUnit(live.unit);
    },
  };
}
