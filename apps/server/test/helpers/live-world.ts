import {
  chmodSync,
  copyFileSync,
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
import type { ControlRequest, ControlResponse, PauseStatus, Release } from '@projectman/shared';
import { ControlUnreachable } from '../../../../scripts/control/client';
import type { LiveDeps, RunOptions, RunResult } from '../../../../scripts/live/deps';
import { launcherFile, SERVER_LAUNCHER, WATCHER_LAUNCHER } from '../../../../scripts/live/paths';

/**
 * A fake machine for the live scripts (PM-493): a temporary root, home and user home; a virtual clock; a
 * launchd that knows two jobs; a live server that is up while its job is loaded; a control socket with the
 * release record of PM-491; and git, npm, sqlite3 and gh that do what the scripts need and fail when a
 * test says so. Nothing leaves the temporary directory.
 */

export const OLD = 'a'.repeat(40);
export const NEW = 'b'.repeat(40);
export const REMOTE = 'git@github.com:owner/projectman.git';
export const SERVER_LABEL = 'com.projectman.live';
export const WATCHER_LABEL = 'com.projectman.live-watcher';

export interface RunRecord {
  key: string;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv | undefined;
  unsetEnv: readonly string[] | undefined;
}

export function makeRelease(overrides: Partial<Release> = {}): Release {
  return {
    id: 'rel_1',
    projectKey: 'PM',
    repo: 'projectman',
    taskKey: 'PM-600',
    state: 'approved',
    commit: NEW,
    baseCommit: OLD,
    tasks: ['PM-1', 'PM-2'],
    summary: 'Fixes a few things.',
    proposedBy: 'devops',
    proposedAt: '2026-10-11T10:00:00.000Z',
    decidedBy: 'owner',
    decidedAt: '2026-10-11T10:05:00.000Z',
    deployStartedAt: null,
    previousCommit: null,
    liveAt: null,
    tag: null,
    url: null,
    publishedAt: null,
    failure: null,
    publishError: null,
    ...overrides,
  } as Release;
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
  release: Release | null = null;
  pause: PauseStatus | null = null;
  /** The live server: up while its job is loaded (and the build is not broken). */
  server = { running: false, version: null as string | null };
  loaded = new Set<string>();
  /** Status polls that answer `pausing` before the pause is `paused`; Infinity: never. */
  pausingPolls = 0;
  /** Roots with these commits load into a server that never listens. */
  brokenCommits = new Set<string>();
  /** What a build that went live writes into the database. */
  newBuildWrites = 'new-data';

  calls: RunRecord[] = [];
  requests: ControlRequest[] = [];
  chdirs: string[] = [];
  outLines: string[] = [];
  /** Failures by command key (see `keyOf`), with the exit status and the error output. */
  private failures = new Map<string, { status: number; stdout: string; stderr: string }>();
  private overrides: ((record: RunRecord) => RunResult | undefined)[] = [];
  /** A hook that may answer a control request instead of the fake server. */
  controlHook: ((request: ControlRequest) => ControlResponse | undefined) | null = null;
  /** The tags on the remote: name -> commit (annotated, as the watcher creates them). */
  remoteTags = new Map<string, string>();
  localTags = new Map<string, string>();
  ghReleases = new Map<string, string>();
  lastNotes: string | null = null;
  /** `git remote get-url origin` by working directory. */
  remotes = new Map<string, string>();
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
    for (const name of [SERVER_LAUNCHER, WATCHER_LAUNCHER]) {
      writeFileSync(launcherFile(this.root, name), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
      chmodSync(launcherFile(this.root, name), 0o755);
    }
    mkdirSync(path.dirname(this.nodePath), { recursive: true });
    writeFileSync(this.nodePath, '#!/bin/sh\n', { mode: 0o755 });
    chmodSync(this.nodePath, 0o755);
    this.remotes.set(this.root, REMOTE);
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

  approve(overrides: Partial<Release> = {}): Release {
    this.release = makeRelease(overrides);
    return this.release;
  }

  fail(key: string, status = 1, stderr = 'boom', stdout = ''): void {
    this.failures.set(key, { status, stdout, stderr });
  }

  clearFail(key: string): void {
    this.failures.delete(key);
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
    if (version === NEW) writeFileSync(path.join(this.home, 'db.sqlite'), this.newBuildWrites);
    this.server = { running: true, version };
  }

  keyOf(command: string, args: string[]): string {
    const [first = '', second = ''] = args;
    if (command === 'git') {
      if (first === 'clone') return 'clone';
      if (first === 'merge-base') return 'merge-base';
      if (first === 'checkout') return 'checkout';
      if (first === 'rev-parse') return 'rev-parse';
      if (first === 'remote') return 'remote-url';
      if (first === 'ls-remote') return args.includes('--tags') ? 'ls-tags' : 'ls-remote';
      if (first === 'tag') return second === '-d' ? 'tag-delete' : 'tag';
      if (first === 'push') return 'push';
    }
    if (command === 'npm') {
      if (first === 'ci') return 'npm-ci';
      if (first === 'run' && second === 'build') return 'npm-build';
      if (first === 'run' && second === 'heavy') return 'heavy';
    }
    if (command === 'sqlite3') return second.startsWith('.backup') ? 'backup' : 'integrity';
    if (command === 'launchctl') return `launchctl-${first}`;
    if (command === 'gh') return first === 'auth' ? 'gh-auth' : second === 'view' ? 'gh-view' : 'gh-create';
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
      case 'clone': {
        const destination = args[args.length - 1]!;
        mkdirSync(destination, { recursive: true });
        writeFileSync(path.join(destination, 'VERSION'), 'unchecked');
        return ok();
      }
      case 'checkout':
        writeFileSync(path.join(cwd, 'VERSION'), args[args.length - 1]!);
        return ok();
      case 'rev-parse': {
        const version = this.versionOf(cwd);
        return version === null
          ? { status: 128, stdout: '', stderr: 'not a git repository' }
          : ok(`${version}\n`);
      }
      case 'remote-url': {
        const url = this.remotes.get(cwd);
        return url ? ok(`${url}\n`) : { status: 2, stdout: '', stderr: 'no such remote' };
      }
      case 'ls-tags': {
        const lines = [...this.remoteTags].flatMap(([name, commit]) => [
          `${'c'.repeat(40)}\trefs/tags/${name}`,
          `${commit}\trefs/tags/${name}^{}`,
        ]);
        return ok(lines.length ? `${lines.join('\n')}\n` : '');
      }
      case 'tag-delete':
        return this.localTags.delete(args[2]!) ? ok() : { status: 1, stdout: '', stderr: 'no such tag' };
      case 'tag':
        this.localTags.set(args[2]!, args[3]!);
        return ok();
      case 'push': {
        const name = args[args.length - 1]!.replace('refs/tags/', '');
        this.remoteTags.set(name, this.localTags.get(name)!);
        return ok();
      }
      case 'backup': {
        const destination = /'(.*)'/.exec(args[1]!)![1]!;
        copyFileSync(args[0]!, destination);
        return ok();
      }
      case 'integrity':
        return ok('ok\n');
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
      case 'gh-view': {
        const url = this.ghReleases.get(args[2]!);
        return url
          ? ok(`${JSON.stringify({ url })}\n`)
          : { status: 1, stdout: '', stderr: 'release not found' };
      }
      case 'gh-create': {
        const tag = args[2]!;
        this.lastNotes = readFileSync(args[args.indexOf('--notes-file') + 1]!, 'utf8');
        const url = `https://github.com/owner/projectman/releases/tag/${tag}`;
        this.ghReleases.set(tag, url);
        return ok(`${url}\n`);
      }
      case 'lsof':
        return this.listeners.length
          ? ok(`${this.listeners.join('\n')}\n`)
          : { status: 1, stdout: '', stderr: '' };
      default:
        return ok();
    }
  }

  private release_(request: ControlRequest): ControlResponse {
    const appVersion = this.server.version;
    const answer = (release: Release | null): ControlResponse => ({
      ok: true,
      pause: this.pause,
      release,
      appVersion,
    });
    const conflict = (message: string): ControlResponse => ({
      ok: false,
      error: { code: 'release_state_conflict', message },
    });
    const current = this.release;
    switch (request.op) {
      case 'release_next':
        return answer(current && ['approved', 'deploying', 'live'].includes(current.state) ? current : null);
      case 'release_claim':
        if (!current || current.id !== request.releaseId || current.state !== 'approved')
          return conflict('cannot claim');
        this.release = { ...current, state: 'deploying', previousCommit: request.previousCommit };
        return answer(this.release);
      case 'release_report': {
        if (!current || current.id !== request.releaseId) return conflict('no such release');
        const report = request.report;
        const need = (...states: Release['state'][]) => states.includes(current.state);
        switch (report.outcome) {
          case 'live':
            if (!need('deploying') || appVersion !== current.commit) return conflict('cannot report live');
            this.release = { ...current, state: 'live', liveAt: iso(this.time) };
            return answer(this.release);
          case 'failed':
            if (!need('deploying')) return conflict('cannot report failed');
            this.release = { ...current, state: 'failed', failure: report.failure };
            return answer(this.release);
          case 'published':
            if (!need('live')) return conflict('cannot report published');
            this.release = { ...current, state: 'published', tag: report.tag, url: report.url };
            return answer(this.release);
          case 'publish_failed':
            if (!need('live')) return conflict('cannot report publish_failed');
            this.release = { ...current, publishError: report.message };
            return answer(this.release);
        }
      }
    }
    throw new Error('unreachable');
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
      default:
        return this.release_(request);
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
      chdir: (directory) => {
        this.chdirs.push(directory);
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
    return this.requests.map((request) =>
      request.op === 'release_report' ? `report:${request.report.outcome}` : request.op,
    );
  }

  reports(): ControlRequest[] {
    return this.requests.filter((request) => request.op === 'release_report');
  }

  version(root = this.root): string | null {
    return this.versionOf(root);
  }

  db(): string {
    return readFileSync(path.join(this.home, 'db.sqlite'), 'utf8');
  }

  next(): string {
    return `${this.root}-next`;
  }

  prev(commit = OLD): string {
    return `${this.root}-prev-${commit}`;
  }

  failedBuild(commit = NEW): string {
    return `${this.root}-failed-${commit}`;
  }

  journalPath(): string {
    return path.join(this.home, 'release', 'journal.json');
  }

  journal(): Record<string, unknown> | null {
    return existsSync(this.journalPath()) ? JSON.parse(readFileSync(this.journalPath(), 'utf8')) : null;
  }

  writeJournal(overrides: Record<string, unknown>): void {
    mkdirSync(path.join(this.home, 'release'), { recursive: true, mode: 0o700 });
    writeFileSync(
      this.journalPath(),
      JSON.stringify({
        version: 1,
        releaseId: 'rel_1',
        commit: NEW,
        previousCommit: OLD,
        step: 'fetch',
        claimed: true,
        failure: null,
        backup: null,
        prevDir: null,
        publishAttemptAt: null,
        startedAt: iso(this.time),
        updatedAt: iso(this.time),
        ...overrides,
      }),
      { mode: 0o600 },
    );
  }

  /** The state a stopped switch leaves: the new build in the root, the old one beside it, the backup taken. */
  setupSwitched(): string {
    this.setupLive();
    const backup = path.join(
      this.home,
      'release',
      'backups',
      `db-20261011T120000Z-${OLD.slice(0, 12)}.sqlite`,
    );
    mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
    writeFileSync(backup, 'old-data');
    chmodSync(backup, 0o600);
    // The old build moved aside, the new one in its place.
    rmSync(this.next(), { recursive: true, force: true });
    mkdirSync(this.prev(), { recursive: true });
    writeFileSync(path.join(this.prev(), 'VERSION'), OLD);
    writeFileSync(path.join(this.root, 'VERSION'), NEW);
    writeFileSync(path.join(this.home, 'db.sqlite'), 'new-data');
    return backup;
  }

  cleanup(): void {
    rmSync(this.base, { recursive: true, force: true });
  }
}
