import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ControlRequest, ControlResponse, PauseStatus } from '@projectman/shared';
import { ControlUnreachable } from '../../../../scripts/control/client';
import type { LiveDeps, RunOptions, RunResult } from '../../../../scripts/live/deps';
import { launcherFile, SERVER_LAUNCHER } from '../../../../scripts/live/paths';

/** A temporary single-mode recovery host with fake git, launchd and pause operations. */

export const OLD = 'a'.repeat(40);
export const SERVER_LABEL = 'com.projectman.live';

interface RunRecord {
  key: string;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv | undefined;
  unsetEnv: readonly string[] | undefined;
}

const iso = (ms: number) => new Date(ms).toISOString();

export class LiveWorld {
  readonly base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'live-world-')));
  readonly root = path.join(this.base, 'projectman-live');
  readonly home = path.join(this.base, 'data', '.projectman');
  readonly userHome = path.join(this.base, 'user');
  readonly port = 4800;
  /** The `node` of the installing shell (a file of `setupLive`). */
  readonly nodePath = path.join(this.base, 'node-bin', 'node');

  time = Date.parse('2026-10-11T12:00:00.000Z');
  pause: PauseStatus | null = null;
  /** The live server: up while its job is loaded (and the build is not broken). */
  server = { running: false, version: null as string | null };
  loaded = new Set<string>();
  /** Status polls that answer `pausing` before the pause is `paused`; Infinity: never. */
  pausingPolls = 0;
  /** Roots with these commits load into a server that never listens. */
  brokenCommits = new Set<string>();

  calls: RunRecord[] = [];
  requests: ControlRequest[] = [];
  outLines: string[] = [];
  /** Failures by command key (see `keyOf`), with the exit status and the error output. */
  private failures = new Map<string, { status: number; stdout: string; stderr: string }>();
  private overrides: ((record: RunRecord) => RunResult | undefined)[] = [];
  /** A hook that may answer a control request instead of the fake server. */
  controlHook: ((request: ControlRequest) => ControlResponse | undefined) | null = null;
  listeners: number[] = [];
  alivePids = new Set<number>();
  /** The environment of the installing shell. */
  env: NodeJS.ProcessEnv = { PATH: '/opt/node/bin:/usr/bin:/bin' };
  platform: NodeJS.Platform = 'darwin';

  constructor() {
    mkdirSync(this.userHome, { recursive: true });
    mkdirSync(this.home, { recursive: true });
  }

  // --- setup

  /** The live checkout at `OLD`, its database, a loaded and running server and both plists. */
  setupLive(options: { running?: boolean; shutdownPlist?: boolean } = {}): void {
    mkdirSync(path.join(this.root, 'apps', 'server', 'dist'), { recursive: true });
    writeFileSync(path.join(this.root, 'apps', 'server', 'dist', 'index.js'), '// built\n');
    writeFileSync(path.join(this.root, 'VERSION'), OLD);
    writeFileSync(path.join(this.home, 'db.sqlite'), 'old-data');
    // The launchers the plists start, and the node they run (PM-514).
    mkdirSync(path.dirname(launcherFile(this.root, SERVER_LAUNCHER)), { recursive: true });
    for (const name of [SERVER_LAUNCHER]) {
      writeFileSync(launcherFile(this.root, name), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
      chmodSync(launcherFile(this.root, name), 0o755);
    }
    mkdirSync(path.dirname(this.nodePath), { recursive: true });
    writeFileSync(this.nodePath, '#!/bin/sh\n', { mode: 0o755 });
    chmodSync(this.nodePath, 0o755);
    if (options.running !== false) {
      this.loaded.add(SERVER_LABEL);
      this.server = { running: true, version: OLD };
    }
    if (options.shutdownPlist !== false) {
      const agents = path.join(this.userHome, 'Library', 'LaunchAgents');
      mkdirSync(agents, { recursive: true });
      writeFileSync(
        path.join(agents, `${SERVER_LABEL}.plist`),
        '<plist><dict><key>ExitTimeOut</key>\n<integer>90</integer></dict></plist>\n',
      );
    }
  }

  fail(key: string, status = 1, stderr = 'boom', stdout = ''): void {
    this.failures.set(key, { status, stdout, stderr });
  }

  override(handler: (record: RunRecord) => RunResult | undefined): void {
    this.overrides.push(handler);
  }

  // --- the machine

  private versionOf(root: string): string | null {
    const file = path.join(root, 'VERSION');
    return existsSync(file) ? readFileSync(file, 'utf8').trim() : null;
  }

  private startServer(): void {
    const version = this.versionOf(this.root);
    if (version !== null && this.brokenCommits.has(version)) {
      this.server = { running: false, version };
      return;
    }
    this.server = { running: true, version };
  }

  keyOf(command: string, args: string[]): string {
    const [first = ''] = args;
    if (command === 'git' && first === 'rev-parse') return 'rev-parse';
    if (command === 'launchctl') return `launchctl-${first}`;
    if (command === 'lsof') return 'lsof';
    if (args.includes('config-check')) return 'config-check';
    return command;
  }

  private labelOf(args: string[]): string {
    const target = args[args.length - 1] ?? '';
    return path.basename(target).replace(/\.plist$/, '');
  }

  private runDefault(record: RunRecord): RunResult {
    const ok = (stdout = ''): RunResult => ({ status: 0, stdout, stderr: '' });
    const { args, cwd } = record;
    switch (record.key) {
      case 'rev-parse': {
        const version = this.versionOf(cwd);
        return version === null
          ? { status: 128, stdout: '', stderr: 'not a git repository' }
          : ok(`${version}\n`);
      }
      case 'launchctl-print':
        return this.loaded.has(this.labelOf(args))
          ? ok('state = running\n\tpid = 321\n\tlast exit code = 0\n')
          : { status: 113, stdout: '', stderr: 'could not find service' };
      case 'launchctl-bootout': {
        const label = this.labelOf(args);
        if (!this.loaded.delete(label)) return { status: 3, stdout: '', stderr: 'no such process' };
        if (label === SERVER_LABEL) this.server = { ...this.server, running: false };
        return ok();
      }
      case 'launchctl-bootstrap': {
        const label = this.labelOf(args);
        this.loaded.add(label);
        if (label === SERVER_LABEL) this.startServer();
        return ok();
      }
      case 'lsof':
        return this.listeners.length
          ? ok(`${this.listeners.join('\n')}\n`)
          : { status: 1, stdout: '', stderr: '' };
      default:
        return ok();
    }
  }

  private pauseStatus(reason: string | null, state: 'pausing' | 'paused'): PauseStatus {
    return {
      id: 'pau_1',
      scope: 'instance',
      projectKey: null,
      kind: 'manual',
      state,
      source: 'control',
      requestedBy: null,
      requestedAt: iso(this.time),
      reason,
      forceAt: iso(this.time + 300_000),
      sessions: [],
    };
  }

  /** Opens a pause as the control socket would have. */
  openPause(reason: string | null, state: 'pausing' | 'paused' = 'paused'): void {
    this.pause = this.pauseStatus(reason, state);
  }

  private async control(request: ControlRequest): Promise<ControlResponse> {
    this.requests.push(request);
    if (!this.server.running) throw new ControlUnreachable('nobody answers');
    const hooked = this.controlHook?.(request);
    if (hooked) return hooked;
    switch (request.op) {
      case 'status':
        if (this.pause?.state === 'pausing') {
          if (this.pausingPolls <= 0) this.pause = { ...this.pause, state: 'paused' };
          else this.pausingPolls -= 1;
        }
        return { ok: true, pause: this.pause, appVersion: this.server.version };
      case 'pause':
        this.pause = this.pauseStatus(request.reason ?? null, this.pausingPolls > 0 ? 'pausing' : 'paused');
        return { ok: true, pause: this.pause, appVersion: this.server.version };
      case 'resume':
        this.pause = null;
        return { ok: true, pause: null, appVersion: this.server.version };
      case 'force':
        return { ok: true, pause: this.pause, appVersion: this.server.version };
    }
  }

  deps(): LiveDeps {
    return {
      run: async (command: string, args: string[], options: RunOptions) => {
        const record: RunRecord = {
          key: this.keyOf(command, args),
          command,
          args,
          cwd: options.cwd,
          env: options.env,
          unsetEnv: options.unsetEnv,
        };
        this.calls.push(record);
        for (const handler of this.overrides) {
          const result = handler(record);
          if (result) return result;
        }
        const failure = this.failures.get(record.key);
        if (failure) return failure;
        return this.runDefault(record);
      },
      control: (request) => this.control(request),
      httpStatus: async () => (this.server.running ? 200 : null),
      portListening: async () => this.server.running,
      kill: (pid, signal) => {
        if (signal === 0) {
          if (this.alivePids.has(pid)) return;
          throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
        }
        this.server = { ...this.server, running: false };
      },
      now: () => new Date(this.time),
      sleep: async (ms) => {
        this.time += ms;
      },
      out: (text) => {
        this.outLines.push(text);
      },
      platform: this.platform,
      uid: 501,
      pid: 4242,
      nodePath: this.nodePath,
      env: this.env,
      homeDir: this.userHome,
    };
  }

  // --- reading the result

  get output(): string {
    return this.outLines.join('');
  }

  keys(): string[] {
    return this.calls.map((call) => call.key);
  }

  requestOps(): string[] {
    return this.requests.map((request) => request.op);
  }

  cleanup(): void {
    rmSync(this.base, { recursive: true, force: true });
  }
}
