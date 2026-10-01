import { EventEmitter } from 'node:events';
import { duplexPair, PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { BoundaryConfig } from '../config';
import { testBoundaryConfig as makeTestBoundaryConfig } from '../test-helpers';
import { parsePasswd } from './accounts';
import { createLauncherClient, LauncherClientError, LOST_EXIT_CODE } from './client';
import {
  checkCwd,
  createLauncher,
  LauncherRefusal,
  runCommand,
  sessionCommand,
  workerAccount,
  workerEnvironment,
} from './daemon';
import type { AccountLookup, LauncherChild, LauncherPty, WorkerAccount } from './daemon';
import { frame, lineReader } from './protocol';
import type { StartRequest } from './protocol';

const testBoundaryConfig: BoundaryConfig = makeTestBoundaryConfig();

const PASSWD = [
  'root:x:0:0:root:/root:/bin/bash',
  'projectman:x:19000:19000::/var/lib/projectman:/usr/sbin/nologin',
  'pmw-dev:x:20001:20001::/var/lib/projectman-work/pmw-dev:/usr/sbin/nologin',
  'pmw-qa:x:20002:20002::/var/lib/projectman-work/pmw-qa:/usr/sbin/nologin',
  'pmw-odd:x:20003:20003::/home/odd:/usr/sbin/nologin',
  'pmw-low:x:1500:1500::/var/lib/projectman-work/pmw-low:/usr/sbin/nologin',
].join('\n');

const accounts: AccountLookup = {
  byName: (name) => parsePasswd(PASSWD).get(name) ?? null,
  list: () => [...parsePasswd(PASSWD).values()],
};
const dev: WorkerAccount = {
  user: 'pmw-dev',
  uid: 20001,
  gid: 20001,
  home: '/var/lib/projectman-work/pmw-dev',
};
const TOKEN = 'egress-token-0123456789';

const startRequest = (patch: Partial<StartRequest> = {}): StartRequest => ({
  op: 'start',
  sessionId: 'ses_abc123',
  member: 'dev',
  provider: 'claude',
  args: [
    '--session-id',
    '0b5c2f2e-0000-4000-8000-000000000000',
    '--append-system-prompt',
    'Use ${HOME} as %h',
  ],
  cwd: '/var/lib/projectman-work/pmw-dev/workspaces/PM/dev/projectman/repo',
  cols: 120,
  rows: 40,
  egressToken: TOKEN,
  ...patch,
});

class FakePty implements LauncherPty {
  readonly pid = 4242;
  readonly written: string[] = [];
  readonly sizes: Array<[number, number]> = [];
  private dataListener: ((data: string) => void) | null = null;
  private exitListener: ((event: { exitCode: number; signal?: number }) => void) | null = null;
  readonly file: string;
  readonly args: string[];
  readonly opts: { cols: number; rows: number; env: Record<string, string> };
  constructor(
    file: string,
    args: string[],
    opts: { cols: number; rows: number; env: Record<string, string> },
  ) {
    this.file = file;
    this.args = args;
    this.opts = opts;
  }
  write(data: string) {
    this.written.push(data);
  }
  resize(cols: number, rows: number) {
    this.sizes.push([cols, rows]);
  }
  kill() {}
  onData(listener: (data: string) => void) {
    this.dataListener = listener;
  }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    this.exitListener = listener;
  }
  emitData(data: string) {
    this.dataListener?.(data);
  }
  exit(exitCode: number) {
    this.exitListener?.({ exitCode });
  }
}

class FakeChild extends EventEmitter implements LauncherChild {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed: string[] = [];
  readonly file: string;
  readonly args: string[];
  constructor(file: string, args: string[]) {
    super();
    this.file = file;
    this.args = args;
  }
  kill(signal?: NodeJS.Signals) {
    this.killed.push(signal ?? 'SIGTERM');
    return true;
  }
}

function harness() {
  const ptys: FakePty[] = [];
  const children: FakeChild[] = [];
  const logs: Array<{ level: string; message: string }> = [];
  const launcher = createLauncher({
    config: testBoundaryConfig,
    accounts,
    spawnPty: (file, args, opts) => {
      const pty = new FakePty(file, args, opts);
      ptys.push(pty);
      return pty;
    },
    spawnChild: (file, args) => {
      const child = new FakeChild(file, args);
      children.push(child);
      return child;
    },
    log: (level, _fields, message) => logs.push({ level, message }),
  });
  const connect = () => {
    const [client, server] = duplexPair();
    launcher.handle(server);
    return client;
  };
  const client = createLauncherClient({ socketPath: '/unused', connect, answerTimeoutMs: 2000 });
  /** Sends one raw request line and collects the answer lines until the launcher ends. */
  const raw = (line: string) =>
    new Promise<unknown[]>((resolve) => {
      const conn = connect();
      const answers: unknown[] = [];
      conn.on(
        'data',
        lineReader(
          1 << 20,
          (v) => answers.push(v),
          () => undefined,
        ),
      );
      conn.on('end', () => resolve(answers));
      conn.write(line);
    });
  const systemctl = () => children.filter((c) => c.file === testBoundaryConfig.systemctl).map((c) => c.args);
  return { launcher, client, ptys, children, logs, raw, systemctl };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('worker accounts and directories', () => {
  it('accepts only the configured worker of a member: its name, uid range and home', () => {
    expect(workerAccount(testBoundaryConfig, accounts, 'dev')).toEqual(dev);
    for (const member of ['nobody', 'odd', 'low'])
      expect(() => workerAccount(testBoundaryConfig, accounts, member)).toThrow(LauncherRefusal);
  });

  it('accepts a working directory only inside the worker home, as a normalized absolute path', () => {
    expect(checkCwd(dev, dev.home)).toBe(dev.home);
    expect(checkCwd(dev, `${dev.home}/sessions/PM`)).toBe(`${dev.home}/sessions/PM`);
    for (const cwd of [
      '/var/lib/projectman/data',
      '/var/lib/projectman-work/pmw-qa',
      '/var/lib/projectman-work/pmw-dev-evil',
      `${dev.home}/../qa`,
      `${dev.home}/sessions/`,
      'relative/path',
    ])
      expect(() => checkCwd(dev, cwd), cwd).toThrow(LauncherRefusal);
  });
});

describe('the unit command line', () => {
  it('starts the pinned CLI as the worker, sandboxed, with arguments kept verbatim', () => {
    const command = sessionCommand(testBoundaryConfig, dev, startRequest());
    expect(command.file).toBe('/usr/bin/systemd-run');
    expect(command.unit).toBe('projectman-session-ses-abc123');
    const args = command.args;
    const program = args.indexOf('--');
    expect(args.slice(0, 7)).toEqual([
      '--quiet',
      '--collect',
      '--wait',
      '--pty',
      '--expand-environment=no',
      '--unit=projectman-session-ses-abc123',
      `--working-directory=${startRequest().cwd}`,
    ]);
    expect(args.slice(program + 1)).toEqual(['/opt/projectman/cli/bin/claude', ...startRequest().args]);
    const properties = args.slice(0, program).filter((_, i, all) => all[i - 1] === '-p');
    expect(properties).toEqual(
      expect.arrayContaining([
        'User=pmw-dev',
        'Group=20001',
        'NoNewPrivileges=yes',
        'CapabilityBoundingSet=',
        'ProtectSystem=strict',
        `ReadWritePaths=${dev.home} -/var/lib/projectman-spool/dev/out`,
        'ProtectProc=invisible',
        'RestrictNamespaces=yes',
        'IPAddressDeny=any',
        'IPAddressAllow=localhost',
        'UMask=0027',
        'Slice=projectman-workers.slice',
      ]),
    );
    const inaccessible = properties.find((p) => p.startsWith('InaccessiblePaths='))!;
    for (const path of ['/run/dbus', '/run/systemd/transient', '/run/systemd/resolve', '/var/lib/projectman'])
      expect(inaccessible).toContain(`-${path}`);
  });

  it('builds the environment from nothing but the configuration and the session ids', () => {
    const env = workerEnvironment(testBoundaryConfig, dev, { sessionId: 'ses_abc123', egressToken: TOKEN });
    expect(env).toMatchObject({
      HOME: dev.home,
      USER: 'pmw-dev',
      PATH: testBoundaryConfig.workerPath,
      HTTPS_PROXY: `http://projectman:${TOKEN}@127.0.0.1:4780`,
      https_proxy: `http://projectman:${TOKEN}@127.0.0.1:4780`,
      NO_PROXY: '127.0.0.1,localhost,::1',
      PROJECTMAN_SESSION_ID: 'ses_abc123',
      DISABLE_AUTOUPDATER: '1',
    });
    for (const name of Object.keys(env))
      expect(name).not.toMatch(/API_KEY|AUTH_TOKEN|BASE_URL|SSH_AUTH_SOCK/);
    const command = sessionCommand(testBoundaryConfig, dev, startRequest());
    expect(command.args).toContain(`--setenv=HTTPS_PROXY=http://projectman:${TOKEN}@127.0.0.1:4780`);
    // A one-off program has no session credentials: base destinations only.
    expect(workerEnvironment(testBoundaryConfig, dev, null).HTTPS_PROXY).toBe('http://127.0.0.1:4780');
  });

  it('runs a one-off program piped, through its pinned path', () => {
    const command = runCommand(
      testBoundaryConfig,
      dev,
      { op: 'run', member: 'dev', program: 'claude-trust', args: [`${dev.home}/x`], cwd: dev.home },
      'abc',
    );
    expect(command.args).toContain('--pipe');
    expect(command.args).not.toContain('--pty');
    expect(command.unit).toBe('projectman-run-dev-abc');
    expect(command.args.slice(command.args.indexOf('--') + 1)).toEqual([
      '/usr/local/bin/node',
      '/srv/projectman/apps/server/dist/claude-trust.js',
      `${dev.home}/x`,
    ]);
  });

  it('refuses agent arguments that name a billing variable', () => {
    expect(() =>
      sessionCommand(
        testBoundaryConfig,
        dev,
        startRequest({ args: ['--settings', '{"env":{"ANTHROPIC_API_KEY":"x"}}'] }),
      ),
    ).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('runs the boundary probe from the deployed app, as the worker', () => {
    const command = runCommand(
      testBoundaryConfig,
      dev,
      { op: 'run', member: 'dev', program: 'boundary-probe', args: ['{}'], cwd: dev.home },
      'p1',
    );
    expect(command.args).toContain('-p');
    expect(command.args).toContain('User=pmw-dev');
    expect(command.args.slice(command.args.indexOf('--') + 1)).toEqual([
      '/usr/local/bin/node',
      '/srv/projectman/apps/server/dist/boundary-worker-probe.js',
      '{}',
    ]);
  });
});

describe('the launcher protocol', () => {
  it('answers a ping', async () => {
    const { client } = harness();
    await expect(client.ping()).resolves.toBe(true);
  });

  it('refuses malformed requests and every field it does not know: no shell, environment or uid', async () => {
    const { raw, ptys, children } = harness();
    expect(await raw('not json\n')).toEqual([
      expect.objectContaining({ ok: false, error: 'invalid_request' }),
    ]);
    expect(await raw(frame({ op: 'exec', command: 'sh -c id' }))).toEqual([
      expect.objectContaining({ ok: false, error: 'invalid_request' }),
    ]);
    for (const extra of [{ env: { LD_PRELOAD: '/tmp/x.so' } }, { uid: 0 }, { file: '/bin/sh' }])
      expect(await raw(frame({ ...startRequest(), ...extra }))).toEqual([
        expect.objectContaining({ ok: false, error: 'invalid_request' }),
      ]);
    expect(await raw(frame({ op: 'run', member: 'dev', program: 'bash', args: [], cwd: dev.home }))).toEqual([
      expect.objectContaining({ ok: false, error: 'invalid_request' }),
    ]);
    expect(ptys).toEqual([]);
    expect(children).toEqual([]);
  });

  it('refuses an unknown member and a directory outside the home with their codes', async () => {
    const { client } = harness();
    await expect(client.start({ ...startRequest(), member: 'nobody' })).rejects.toMatchObject({
      code: 'unknown_worker',
    });
    await expect(client.start({ ...startRequest(), cwd: '/var/lib/projectman/data' })).rejects.toMatchObject({
      code: 'cwd_outside_home',
    });
  });

  it('relays a session terminal both ways and stops the unit when it ends', async () => {
    const h = harness();
    const { op: _op, ...request } = startRequest();
    const session = await h.client.start(request);
    expect(session.pid).toBe(4242);
    const pty = h.ptys[0]!;
    expect(pty.file).toBe('/usr/bin/systemd-run');
    expect(pty.opts.env).toEqual({ PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' });
    const seen: string[] = [];
    session.onData((data) => seen.push(data));
    pty.emitData('hello é\n');
    session.write('typed');
    session.resize(100, 30);
    await tick();
    await tick();
    expect(seen).toEqual(['hello é\n']);
    expect(pty.written).toEqual(['typed']);
    expect(pty.sizes).toEqual([[100, 30]]);
    session.kill('SIGKILL');
    await tick();
    await tick();
    expect(h.systemctl()).toContainEqual([
      'kill',
      '--signal=SIGKILL',
      '--',
      'projectman-session-ses-abc123.service',
    ]);
    const exited = new Promise<{ exitCode: number }>((resolve) => session.onExit(resolve));
    pty.exit(3);
    await expect(exited).resolves.toEqual({ exitCode: 3 });
    expect(h.systemctl()).toContainEqual([
      'stop',
      '--no-block',
      '--',
      'projectman-session-ses-abc123.service',
    ]);
    expect(h.launcher.sessionCount()).toBe(0);
  });

  it('stops the session when the service goes away', async () => {
    const h = harness();
    const { op: _op, ...request } = startRequest();
    const session = await h.client.start(request);
    const exited = new Promise<{ exitCode: number }>((resolve) => session.onExit(resolve));
    // The service hangs up (as a dying process's socket does).
    (session as unknown as { conn: { end(): void; destroy(): void } }).conn.end();
    (session as unknown as { conn: { end(): void; destroy(): void } }).conn.destroy();
    await expect(exited).resolves.toEqual({ exitCode: LOST_EXIT_CODE });
    await tick();
    expect(h.systemctl()).toContainEqual([
      'stop',
      '--no-block',
      '--',
      'projectman-session-ses-abc123.service',
    ]);
  });

  it('limits running sessions and refuses a second start of the same session', async () => {
    const h = harness();
    const { op: _op, ...request } = startRequest();
    await h.client.start(request);
    await expect(h.client.start(request)).rejects.toMatchObject({ code: 'session_exists' });
    await h.client.start({ ...request, sessionId: 'ses_two' });
    await expect(h.client.start({ ...request, sessionId: 'ses_three' })).rejects.toMatchObject({
      code: 'too_many_sessions',
    });
  });

  it('runs a program and returns its output and exit code', async () => {
    const h = harness();
    const result = h.client.run({ member: 'dev', program: 'git', args: ['status'], cwd: dev.home });
    await tick();
    await tick();
    const child = h.children.find((c) => c.file === '/usr/bin/systemd-run')!;
    expect(child.args.slice(child.args.indexOf('--') + 1)).toEqual(['/usr/bin/git', 'status']);
    child.stdout.write('clean\n');
    child.stderr.write('note\n');
    await tick();
    child.emit('close', 1);
    await expect(result).resolves.toEqual({
      exitCode: 1,
      stdout: 'clean\n',
      stderr: 'note\n',
      timedOut: false,
    });
  });

  it('kills a program at its timeout', async () => {
    const h = harness();
    const result = h.client.run({
      member: 'dev',
      program: 'git',
      args: ['fetch'],
      cwd: dev.home,
      timeoutMs: 1000,
    });
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const child = h.children.find((c) => c.file === '/usr/bin/systemd-run')!;
    expect(child.killed).toEqual(['SIGKILL']);
    child.emit('close', null);
    await expect(result).resolves.toMatchObject({ exitCode: null, timedOut: true });
    expect(h.systemctl()[0]!.slice(0, 2)).toEqual(['kill', '--signal=SIGKILL']);
  });

  it('reports an unreachable launcher', async () => {
    const client = createLauncherClient({
      socketPath: '/unused',
      connect: () => {
        throw new Error('ECONNREFUSED');
      },
    });
    await expect(client.ping()).resolves.toBe(false);
    await expect(
      client.run({ member: 'dev', program: 'git', args: [], cwd: dev.home }),
    ).rejects.toBeInstanceOf(LauncherClientError);
  });
});
