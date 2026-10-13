import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { RELEASE_TAG_PATTERN, releaseTagName } from '@projectman/shared';
import type { PauseStatus, Release, ReleaseFailure, ReleaseReport, ReleaseStep } from '@projectman/shared';
import type { LiveDeps, RunResult } from './deps';
import { deleteJournal, readJournal, writeJournal } from './journal';
import type { LiveJournal } from './journal';
import { bootout, bootstrap, pauseAndWait, resume, tryControl, verifyServer, waitPortFree } from './launchd';
import {
  backupsDir,
  dbFile,
  failedDir,
  failureMessage,
  githubSlug,
  lockFile,
  nextDir,
  plistFile,
  prevDir,
  releaseDir,
  SERVER_LABEL,
  SHA40,
} from './paths';
import { installedExitTimeout } from './plist';

/**
 * One round of the release watcher (PM-493), started by launchd every minute: finds the release the
 * owner approved and deploys it (fetch, build, test, config check, pause, stop, backup, switch, verify)
 * with a rollback, then tags it and makes the GitHub release. The journal (`journal.ts`) records the
 * step before it starts, so that a round that was stopped can put things right in the next one.
 *
 * The switch renames the checkout this very code runs from. So this module and everything it imports
 * is loaded before the first step (static imports only), the process leaves the checkout after the
 * lock (`deps.chdir`), every child process gets an explicit `cwd`, and only absolute paths are used.
 */

export interface WatchOptions {
  /** The live checkout (`~/projectman-live`). */
  root: string;
  /** The app home (`~/.projectman`). */
  home: string;
  port: number;
  /** The GitHub remote the release is fetched from and tagged on. */
  remote: string;
}

const MINUTE_MS = 60_000;
const CLONE_TIMEOUT_MS = 20 * MINUTE_MS;
const NPM_TIMEOUT_MS = 20 * MINUTE_MS;
const TEST_TIMEOUT_MS = 90 * MINUTE_MS;
const GIT_TIMEOUT_MS = 5 * MINUTE_MS;
const HEAVY_QUEUE_SECONDS = 3600;
const HEAVY_QUEUE_EXPIRED = 75;
const PUBLISH_RETRY_MS = 60 * MINUTE_MS;
const DEFAULT_EXIT_TIMEOUT_S = 90;
const KEEP_BACKUPS = 10;
const KEEP_DIRECTORIES = 2;
const RESUME_TRIES = 3;
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' };

/** A step that failed, with the message the server shows the owners. */
class StepError extends Error {
  readonly step: ReleaseStep;
  constructor(step: ReleaseStep, message: string) {
    super(message);
    this.step = step;
  }
}

const output = (result: RunResult): string => `${result.stdout}\n${result.stderr}`;

/** The lock is the file with the pid of the round that holds it; a dead pid's lock is taken over. */
function acquireLock(deps: LiveDeps, home: string): boolean {
  const file = lockFile(home);
  mkdirSync(releaseDir(home), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(file, `${deps.pid}\n`, { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(readFileSync(file, 'utf8').trim());
      if (Number.isInteger(pid) && pid > 0 && pid !== deps.pid) {
        try {
          deps.kill(pid, 0);
          return false;
        } catch (killError) {
          if ((killError as NodeJS.ErrnoException).code === 'EPERM') return false;
        }
      }
      rmSync(file, { force: true });
    }
  }
  return false;
}

/** Runs one round; returns the exit status (0: nothing wrong, 1: something needs a look). */
export async function runWatch(deps: LiveDeps, options: WatchOptions): Promise<number> {
  for (const value of [options.root, options.home])
    if (!path.isAbsolute(value)) throw new Error(`the watcher takes absolute paths, not ${value}`);
  if (!acquireLock(deps, options.home)) return 0;
  const watcher = new Watcher(deps, options);
  try {
    deps.chdir(options.home);
    return await watcher.round();
  } catch (error) {
    watcher.log(
      `the round failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    return 1;
  } finally {
    rmSync(lockFile(options.home), { force: true });
  }
}

type ReportResult =
  | { kind: 'ok'; release: Release | null }
  | { kind: 'conflict' }
  | { kind: 'unreachable' }
  | { kind: 'refused' };

interface NextRelease {
  release: Release | null;
  appVersion: string | null;
  pause: PauseStatus | null;
}

class Watcher {
  private journal: LiveJournal | null = null;
  private readonly next: string;
  private readonly deps: LiveDeps;
  private readonly o: WatchOptions;

  constructor(deps: LiveDeps, options: WatchOptions) {
    this.deps = deps;
    this.o = options;
    this.next = nextDir(options.root);
  }

  log(message: string): void {
    this.deps.out(`${this.deps.now().toISOString()} ${message}\n`);
  }

  // --- one round

  async round(): Promise<number> {
    const read = readJournal(this.o.home);
    if (read.kind === 'invalid') {
      this.log(
        `the journal ${path.join(releaseDir(this.o.home), 'journal.json')} is unreadable (${read.reason}): a release may be half done. Nothing was touched; docs/DEPLOY.md says what to do by hand.`,
      );
      return 1;
    }
    if (read.kind === 'ok') {
      this.journal = read.journal;
      return this.recover();
    }
    return this.fresh();
  }

  private async fresh(): Promise<number> {
    const next = await this.nextRelease();
    if (!next) return 1;
    const { release, appVersion, pause } = next;
    if (!release) return 0;
    switch (release.state) {
      case 'live':
        if (pause?.reason === `release ${release.id}`) await this.resumeWithRetry();
        return this.publishPhase(release);
      case 'deploying':
        return this.lostJournal(release, appVersion);
      case 'approved':
        return this.startDeploy(release, appVersion, pause);
      default:
        return 0;
    }
  }

  /** The server says the release is deploying but there is no journal: it is live, or it is lost. */
  private async lostJournal(release: Release, appVersion: string | null): Promise<number> {
    if (appVersion === release.commit) {
      await this.resumeWithRetry();
      const reported = await this.report(release.id, { outcome: 'live' });
      if (reported.kind === 'ok') return this.publishPhase(reported.release ?? release);
      return 1;
    }
    this.log(`release ${release.id} is deploying but the watcher has no journal: reporting it failed`);
    const failure: ReleaseFailure = {
      step: 'fetch',
      message: 'the watcher lost its journal',
      rolledBack: false,
    };
    const reported = await this.report(release.id, { outcome: 'failed', failure });
    return reported.kind === 'ok' ? 0 : 1;
  }

  private async startDeploy(
    release: Release,
    appVersion: string | null,
    pause: PauseStatus | null,
  ): Promise<number> {
    if (pause && pause.reason !== `release ${release.id}`) {
      this.log(`a pause is open (${pause.reason ?? 'no reason'}): release ${release.id} waits`);
      return 0;
    }
    if (appVersion === null || !SHA40.test(appVersion)) {
      // Nothing was started: the claim only makes the failure reportable.
      const claimed = await this.tryClaim(release.id, null);
      if (claimed.kind !== 'ok') return claimed.kind === 'conflict' ? 0 : 1;
      const failure: ReleaseFailure = {
        step: 'fetch',
        message: 'the live build has no commit',
        rolledBack: false,
      };
      const reported = await this.report(release.id, { outcome: 'failed', failure });
      return reported.kind === 'ok' ? 0 : 1;
    }
    if (!SHA40.test(release.commit)) {
      this.log(`release ${release.id} names ${release.commit}, which is not a commit id: not started`);
      return 1;
    }
    const at = this.deps.now().toISOString();
    this.journal = {
      version: 1,
      releaseId: release.id,
      commit: release.commit,
      previousCommit: appVersion,
      step: 'fetch',
      claimed: false,
      failure: null,
      backup: null,
      prevDir: null,
      publishAttemptAt: null,
      startedAt: at,
      updatedAt: at,
    };
    writeJournal(this.o.home, this.journal);
    const claimed = await this.tryClaim(release.id, appVersion);
    if (claimed.kind === 'conflict') {
      this.dropJournal();
      return 0;
    }
    if (claimed.kind !== 'ok') return 1;
    this.setJournal({ claimed: true });
    this.log(`deploying release ${release.id}: ${appVersion.slice(0, 12)} -> ${release.commit.slice(0, 12)}`);
    return this.deploy();
  }

  private async tryClaim(
    releaseId: string,
    previousCommit: string | null,
  ): Promise<{ kind: 'ok' } | { kind: 'conflict' } | { kind: 'other' }> {
    const answer = await tryControl(this.deps, { op: 'release_claim', releaseId, previousCommit });
    if (!answer) {
      this.log('the server does not answer on its control socket');
      return { kind: 'other' };
    }
    if (answer.ok) return { kind: 'ok' };
    if (answer.error.code === 'release_state_conflict') return { kind: 'conflict' };
    this.log(`release_claim refused: ${answer.error.code}: ${answer.error.message}`);
    return { kind: 'other' };
  }

  // --- the journal and the server's answers

  private setJournal(patch: Partial<LiveJournal>): void {
    this.journal = { ...this.journal!, ...patch, updatedAt: this.deps.now().toISOString() };
    writeJournal(this.o.home, this.journal);
  }

  private dropJournal(): void {
    deleteJournal(this.o.home);
    this.journal = null;
  }

  private async nextRelease(): Promise<NextRelease | null> {
    const answer = await tryControl(this.deps, { op: 'release_next' });
    if (!answer) {
      this.log('the server does not answer on its control socket');
      return null;
    }
    if (!answer.ok) {
      this.log(`release_next refused: ${answer.error.code}: ${answer.error.message}`);
      return null;
    }
    return { release: answer.release ?? null, appVersion: answer.appVersion ?? null, pause: answer.pause };
  }

  private async report(releaseId: string, report: ReleaseReport): Promise<ReportResult> {
    const answer = await tryControl(this.deps, { op: 'release_report', releaseId, report });
    if (!answer) {
      this.log('the server does not answer on its control socket');
      return { kind: 'unreachable' };
    }
    if (answer.ok) return { kind: 'ok', release: answer.release ?? null };
    if (answer.error.code === 'release_state_conflict') return { kind: 'conflict' };
    this.log(`release_report ${report.outcome} refused: ${answer.error.code}: ${answer.error.message}`);
    return { kind: 'refused' };
  }

  /**
   * After `release_state_conflict` the server's view decides: when the release is gone from `release_next`
   * (or another one is), the journal has nothing left to do; when it is still this one, in a state the
   * journal does not fit, a person has to look.
   */
  private async settle(): Promise<number> {
    const next = await this.nextRelease();
    if (!next) return 1;
    if (!next.release || next.release.id !== this.journal!.releaseId) {
      this.dropJournal();
      return 0;
    }
    this.log(
      `release ${next.release.id} is ${next.release.state} on the server, which does not fit the journal (${this.journal!.step}): docs/DEPLOY.md says what to do by hand`,
    );
    return 1;
  }

  /** The closing report; once the server accepted it, the journal is deleted. */
  private async close(report: ReleaseReport): Promise<number> {
    const result = await this.report(this.journal!.releaseId, report);
    if (result.kind === 'ok') {
      this.dropJournal();
      return 0;
    }
    return result.kind === 'conflict' ? this.settle() : 1;
  }

  private async closeFailed(): Promise<number> {
    return this.close({ outcome: 'failed', failure: this.journal!.failure! });
  }

  private async resumeWithRetry(): Promise<void> {
    for (let attempt = 0; attempt < RESUME_TRIES; attempt += 1) {
      if (await resume(this.deps)) return;
      await this.deps.sleep(2_000);
    }
    this.log('the pause could not be released: resume it by hand (npm run control -- resume)');
  }

  // --- the deploy

  private async deploy(): Promise<number> {
    try {
      await this.fetchStep();
      await this.run('build', 'npm ci', 'npm', ['ci'], this.next, NPM_TIMEOUT_MS);
      await this.run('build', 'npm run build', 'npm', ['run', 'build'], this.next, NPM_TIMEOUT_MS);
      await this.testStep();
      await this.configCheckStep();
    } catch (error) {
      if (!(error instanceof StepError)) throw error;
      this.log(`release ${this.journal!.releaseId} failed in ${error.step}: ${error.message.split('\n')[0]}`);
      rmSync(this.next, { recursive: true, force: true });
      this.setJournal({ failure: { step: error.step, message: error.message, rolledBack: false } });
      return this.closeFailed();
    }
    return this.cutover();
  }

  /** Runs a command of a step in a directory; a non-zero status is the step's failure. */
  private async run(
    step: ReleaseStep,
    label: string,
    command: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
  ): Promise<RunResult> {
    this.setJournal({ step });
    const result = await this.deps.run(command, args, { cwd, timeoutMs, env: GIT_ENV });
    if (result.status !== 0)
      throw new StepError(step, failureMessage(`${label} exited with ${result.status}`, output(result)));
    return result;
  }

  private async fetchStep(): Promise<void> {
    const { commit } = this.journal!;
    this.setJournal({ step: 'fetch' });
    rmSync(this.next, { recursive: true, force: true });
    await this.run(
      'fetch',
      'git clone',
      'git',
      ['clone', '--no-checkout', this.o.remote, this.next],
      this.o.home,
      CLONE_TIMEOUT_MS,
    );
    const ancestor = await this.deps.run('git', ['merge-base', '--is-ancestor', commit, 'origin/main'], {
      cwd: this.next,
      timeoutMs: GIT_TIMEOUT_MS,
    });
    if (ancestor.status === 1)
      throw new StepError('fetch', `the commit ${commit.slice(0, 12)} is not on GitHub main`);
    if (ancestor.status !== 0)
      throw new StepError(
        'fetch',
        failureMessage(`git merge-base exited with ${ancestor.status}`, output(ancestor)),
      );
    await this.run(
      'fetch',
      'git checkout',
      'git',
      ['checkout', '--detach', commit],
      this.next,
      GIT_TIMEOUT_MS,
    );
  }

  private async testStep(): Promise<void> {
    this.setJournal({ step: 'test' });
    const result = await this.deps.run(
      'npm',
      [
        'run',
        'heavy',
        '--',
        '--label',
        'release-test',
        '--max-wait',
        String(HEAVY_QUEUE_SECONDS),
        '--',
        'npm',
        'run',
        'release-test',
      ],
      { cwd: this.next, timeoutMs: TEST_TIMEOUT_MS, env: GIT_ENV },
    );
    if (result.status === HEAVY_QUEUE_EXPIRED)
      throw new StepError('test', 'the heavy-run queue did not come to the release test within an hour');
    if (result.status !== 0)
      throw new StepError(
        'test',
        failureMessage(`the release test exited with ${result.status}`, output(result)),
      );
  }

  private async configCheckStep(): Promise<void> {
    await this.run(
      'config_check',
      'config-check',
      this.deps.nodePath,
      [
        '--import',
        'tsx',
        path.join(this.next, 'scripts', 'live', 'cli.ts'),
        'config-check',
        '--home',
        this.o.home,
      ],
      this.next,
      NPM_TIMEOUT_MS,
    );
  }

  // --- the cutover: from here on the live server is touched

  private exitTimeoutSeconds(): number {
    const file = plistFile(this.deps.homeDir, SERVER_LABEL);
    return (
      (existsSync(file) ? installedExitTimeout(readFileSync(file, 'utf8')) : null) ?? DEFAULT_EXIT_TIMEOUT_S
    );
  }

  private async cutover(): Promise<number> {
    const { releaseId, commit, previousCommit } = this.journal!;

    this.setJournal({ step: 'pause' });
    const paused = await pauseAndWait(this.deps, `release ${releaseId}`);
    if (!paused.ok)
      return this.abortBeforeSwitch({
        step: 'pause',
        message: `the sessions did not pause: ${paused.message}`,
        rolledBack: false,
      });

    this.setJournal({ step: 'stop' });
    const stopped = await bootout(this.deps, SERVER_LABEL);
    if (stopped.status !== 0)
      return this.abortBeforeSwitch({
        step: 'stop',
        message: failureMessage(`launchctl bootout exited with ${stopped.status}`, output(stopped)),
        rolledBack: false,
      });
    if (!(await waitPortFree(this.deps, this.o.port, (this.exitTimeoutSeconds() + 15) * 1000)))
      return this.abortBeforeSwitch({
        step: 'stop',
        message: `the server still listens on port ${this.o.port}`,
        rolledBack: false,
      });

    this.setJournal({ step: 'backup' });
    let backup: string;
    try {
      backup = await this.backupStep();
    } catch (error) {
      if (!(error instanceof StepError)) throw error;
      return this.abortBeforeSwitch({ step: 'backup', message: error.message, rolledBack: false });
    }

    const previous = prevDir(this.o.root, previousCommit);
    this.setJournal({ step: 'switch', backup, prevDir: previous });
    try {
      rmSync(previous, { recursive: true, force: true });
      renameSync(this.o.root, previous);
      renameSync(this.next, this.o.root);
    } catch (error) {
      return this.rollback({
        step: 'switch',
        message: failureMessage(
          'renaming the builds failed',
          error instanceof Error ? error.message : String(error),
        ),
        rolledBack: false,
      });
    }
    const loaded = await bootstrap(this.deps, SERVER_LABEL);
    if (loaded.status !== 0)
      return this.rollback({
        step: 'switch',
        message: failureMessage(`launchctl bootstrap exited with ${loaded.status}`, output(loaded)),
        rolledBack: false,
      });

    this.setJournal({ step: 'verify' });
    if (!(await verifyServer(this.deps, { port: this.o.port, commit })))
      return this.rollback({
        step: 'verify',
        message: `the new build did not come up with the commit ${commit.slice(0, 12)}`,
        rolledBack: false,
      });
    return this.finishLive();
  }

  /** The database is copied while the server is stopped; the copy must pass SQLite's own check. */
  private async backupStep(): Promise<string> {
    const { previousCommit } = this.journal!;
    mkdirSync(backupsDir(this.o.home), { recursive: true, mode: 0o700 });
    const stamp = this.deps
      .now()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d+Z$/, 'Z');
    const destination = path.join(
      backupsDir(this.o.home),
      `db-${stamp}-${previousCommit.slice(0, 12)}.sqlite`,
    );
    if (destination.includes("'"))
      throw new StepError('backup', `the backup path ${destination} holds a quote`);
    const copied = await this.deps.run('sqlite3', [dbFile(this.o.home), `.backup '${destination}'`], {
      cwd: this.o.home,
      timeoutMs: 10 * MINUTE_MS,
    });
    if (copied.status !== 0)
      throw new StepError(
        'backup',
        failureMessage(`sqlite3 .backup exited with ${copied.status}`, output(copied)),
      );
    const checked = await this.deps.run('sqlite3', [destination, 'PRAGMA integrity_check'], {
      cwd: this.o.home,
      timeoutMs: 10 * MINUTE_MS,
    });
    if (checked.status !== 0 || checked.stdout.trim() !== 'ok')
      throw new StepError('backup', failureMessage('the backup failed the integrity check', output(checked)));
    chmodSync(destination, 0o600);
    const old = readdirSync(backupsDir(this.o.home))
      .filter((name) => /^db-.*\.sqlite$/.test(name))
      .sort()
      .reverse()
      .slice(KEEP_BACKUPS);
    for (const name of old) rmSync(path.join(backupsDir(this.o.home), name), { force: true });
    return destination;
  }

  /**
   * A failure before the switch: the live build and the database were not touched. The server goes back
   * to work (started again when the stop had taken it down), and the failure is reported.
   */
  private async abortBeforeSwitch(failure: ReleaseFailure): Promise<number> {
    this.setJournal({ failure });
    return this.restoreAndFail();
  }

  private async restoreAndFail(): Promise<number> {
    const { previousCommit } = this.journal!;
    this.log(
      `release ${this.journal!.releaseId} failed in ${this.journal!.failure!.step}: ${this.journal!.failure!.message.split('\n')[0]}`,
    );
    rmSync(this.next, { recursive: true, force: true });
    if (!(await this.deps.portListening(this.o.port))) {
      const loaded = await bootstrap(this.deps, SERVER_LABEL);
      if (loaded.status !== 0) {
        this.log(
          `the live server could not be started again: ${loaded.stderr.trim() || loaded.stdout.trim()}`,
        );
        return 1;
      }
      if (!(await verifyServer(this.deps, { port: this.o.port, commit: previousCommit }))) {
        this.log(
          `the live server does not come up with ${previousCommit.slice(0, 12)}: the next round tries again`,
        );
        return 1;
      }
    }
    await this.resumeWithRetry();
    return this.closeFailed();
  }

  /** The new build runs: release the pause, tell the server, and go on to the publishing. */
  private async finishLive(): Promise<number> {
    const journal = this.journal!;
    await this.resumeWithRetry();
    const reported = await this.report(journal.releaseId, { outcome: 'live' });
    let release = reported.kind === 'ok' ? reported.release : null;
    if (reported.kind === 'conflict') {
      // The server may have taken it already (the round was stopped after the report).
      const next = await this.nextRelease();
      if (!next) return 1;
      if (!next.release || next.release.id !== journal.releaseId) {
        this.dropJournal();
        return 0;
      }
      if (next.release.state !== 'live') return this.settle();
      release = next.release;
    } else if (reported.kind !== 'ok') {
      return 1;
    }
    this.setJournal({ step: 'publish' });
    this.prune('prev', journal.prevDir);
    this.prune('failed', null);
    this.log(`release ${journal.releaseId} is live: ${journal.commit.slice(0, 12)}`);
    return release ? this.publish(release) : this.publishPhase(null);
  }

  /** Keeps the newest `KEEP_DIRECTORIES` builds of a kind, and never the one `protect` names. */
  private prune(kind: 'prev' | 'failed', protect: string | null): void {
    const parent = path.dirname(this.o.root);
    const prefix = `${path.basename(this.o.root)}-${kind}-`;
    const found = readdirSync(parent)
      .filter((name) => name.startsWith(prefix) && SHA40.test(name.slice(prefix.length)))
      .map((name) => {
        const full = path.join(parent, name);
        const stat = statSync(full);
        return { full, time: Math.max(stat.mtimeMs, stat.ctimeMs) };
      })
      .filter((entry) => entry.full !== protect)
      .sort((a, b) => b.time - a.time);
    const keep = protect ? KEEP_DIRECTORIES - 1 : KEEP_DIRECTORIES;
    for (const entry of found.slice(keep)) rmSync(entry.full, { recursive: true, force: true });
  }

  // --- the rollback

  /**
   * Puts the previous build and the backed-up database back and reports the failure. Every part can be
   * repeated: a round that is stopped half way is continued by the next one (journal step `rollback`).
   */
  private async rollback(failure: ReleaseFailure): Promise<number> {
    this.setJournal({ step: 'rollback', failure });
    const { commit, previousCommit, backup, prevDir: previous, releaseId } = this.journal!;
    this.log(
      `release ${releaseId} failed in ${failure.step}: ${failure.message.split('\n')[0]}; rolling back`,
    );
    const stopped = await bootout(this.deps, SERVER_LABEL);
    if (stopped.status !== 0) {
      this.log(
        `launchctl bootout exited with ${stopped.status}: ${stopped.stderr.trim()}; the next round tries again`,
      );
      return 1;
    }
    rmSync(this.next, { recursive: true, force: true });
    if (existsSync(this.o.root)) {
      const head = await this.deps.run('git', ['rev-parse', 'HEAD'], {
        cwd: this.o.root,
        timeoutMs: GIT_TIMEOUT_MS,
      });
      if (head.status === 0 && head.stdout.trim() === commit) {
        const failed = failedDir(this.o.root, commit);
        rmSync(failed, { recursive: true, force: true });
        renameSync(this.o.root, failed);
      }
    }
    if (previous && existsSync(previous) && !existsSync(this.o.root)) renameSync(previous, this.o.root);
    if (backup && existsSync(backup)) {
      const database = dbFile(this.o.home);
      rmSync(`${database}-wal`, { force: true });
      rmSync(`${database}-shm`, { force: true });
      const temporary = `${database}.tmp`;
      copyFileSync(backup, temporary);
      chmodSync(temporary, 0o600);
      renameSync(temporary, database);
    } else {
      this.log('there is no backup to restore: the database stays as it is');
    }
    const loaded = await bootstrap(this.deps, SERVER_LABEL);
    if (loaded.status !== 0) {
      this.log(
        `launchctl bootstrap exited with ${loaded.status}: ${loaded.stderr.trim()}; the next round tries again`,
      );
      return 1;
    }
    if (!(await verifyServer(this.deps, { port: this.o.port, commit: previousCommit }))) {
      this.log(
        `the previous build does not come up with ${previousCommit.slice(0, 12)}; the next round tries again`,
      );
      return 1;
    }
    await this.resumeWithRetry();
    this.setJournal({ failure: { ...failure, rolledBack: true } });
    return this.closeFailed();
  }

  // --- recovery from the journal

  private async recover(): Promise<number> {
    const journal = this.journal!;
    this.log(`continuing release ${journal.releaseId} from the journal (step ${journal.step})`);
    const interrupted = (step: ReleaseStep, message: string): ReleaseFailure =>
      journal.failure ?? { step, message, rolledBack: false };
    switch (journal.step) {
      case 'fetch':
      case 'build':
      case 'test':
      case 'config_check': {
        if (!journal.claimed && !journal.failure) {
          const next = await this.nextRelease();
          if (!next) return 1;
          if (next.release?.id === journal.releaseId && next.release.state === 'approved') {
            this.dropJournal();
            return this.fresh();
          }
        }
        rmSync(this.next, { recursive: true, force: true });
        this.setJournal({ failure: interrupted(journal.step, `the watcher stopped during ${journal.step}`) });
        return this.closeFailed();
      }
      case 'pause':
      case 'stop':
      case 'backup':
        this.setJournal({ failure: interrupted(journal.step, `the watcher stopped during ${journal.step}`) });
        return this.restoreAndFail();
      case 'switch':
      case 'verify':
        if (await verifyServer(this.deps, { port: this.o.port, commit: journal.commit }))
          return this.finishLive();
        return this.rollback(interrupted(journal.step, `the watcher stopped during ${journal.step}`));
      case 'rollback':
        return this.rollback(interrupted('rollback', 'the rollback was interrupted'));
      case 'publish': {
        const next = await this.nextRelease();
        if (!next) return 1;
        if (!next.release || next.release.id !== journal.releaseId || next.release.state !== 'live') {
          this.dropJournal();
          return 0;
        }
        if (next.pause?.reason === `release ${journal.releaseId}`) await this.resumeWithRetry();
        return this.publish(next.release);
      }
    }
  }

  // --- the publishing: the tag and the GitHub release

  /** A live release without a journal gets one; the publishing is repeated from it. */
  private async publishPhase(release: Release | null): Promise<number> {
    if (!release) {
      const next = await this.nextRelease();
      if (!next?.release) return next ? 0 : 1;
      release = next.release;
    }
    if (!this.journal) {
      if (!SHA40.test(release.commit)) {
        this.log(`release ${release.id} names ${release.commit}, which is not a commit id: not published`);
        return 1;
      }
      const at = this.deps.now().toISOString();
      this.journal = {
        version: 1,
        releaseId: release.id,
        commit: release.commit,
        previousCommit:
          release.previousCommit && SHA40.test(release.previousCommit)
            ? release.previousCommit
            : release.commit,
        step: 'publish',
        claimed: true,
        failure: null,
        backup: null,
        prevDir: null,
        publishAttemptAt: null,
        startedAt: at,
        updatedAt: at,
      };
      writeJournal(this.o.home, this.journal);
    } else if (this.journal.step !== 'publish') {
      this.setJournal({ step: 'publish' });
    }
    return this.publish(release);
  }

  private async publish(release: Release): Promise<number> {
    const attempt = this.journal!.publishAttemptAt;
    if (attempt !== null && this.deps.now().getTime() - Date.parse(attempt) < PUBLISH_RETRY_MS) return 0;
    this.setJournal({ publishAttemptAt: this.deps.now().toISOString() });
    let published: { tag: string; url: string };
    try {
      published = await this.createRelease(release);
    } catch (error) {
      const message = failureMessage(
        'publishing failed',
        error instanceof Error ? error.message : String(error),
      );
      this.log(`release ${release.id}: ${message.split('\n')[0]}`);
      const reported = await this.report(release.id, { outcome: 'publish_failed', message });
      if (reported.kind === 'conflict') return this.settle();
      return 1;
    }
    this.log(`release ${release.id} published: ${published.tag} ${published.url}`);
    return this.close({ outcome: 'published', ...published });
  }

  /** The tag (a tag already on the commit is reused) and the GitHub release (an existing one is reused). */
  private async createRelease(release: Release): Promise<{ tag: string; url: string }> {
    const git = async (args: string[]): Promise<RunResult> =>
      this.deps.run('git', args, { cwd: this.o.root, timeoutMs: GIT_TIMEOUT_MS, env: GIT_ENV });
    const listed = await git(['ls-remote', '--tags', this.o.remote]);
    if (listed.status !== 0)
      throw new Error(failureMessage(`git ls-remote exited with ${listed.status}`, output(listed)));
    const tags = new Map<string, string>();
    for (const line of listed.stdout.split('\n')) {
      const match = /^([0-9a-f]{40})\s+refs\/tags\/(.+?)(\^\{\})?$/.exec(line.trim());
      if (!match) continue;
      // The peeled line (`^{}`) is the commit of an annotated tag; it comes after the tag object's own line.
      if (match[3] || !tags.has(match[2]!)) tags.set(match[2]!, match[1]!);
    }
    let tag = [...tags].find(
      ([name, commit]) => RELEASE_TAG_PATTERN.test(name) && commit === release.commit,
    )?.[0];
    if (!tag) {
      tag = releaseTagName(release.liveAt ? new Date(release.liveAt) : this.deps.now(), [...tags.keys()]);
      await git(['tag', '-d', tag]);
      const created = await git(['tag', '-a', tag, release.commit, '-m', tag]);
      if (created.status !== 0)
        throw new Error(failureMessage(`git tag exited with ${created.status}`, output(created)));
      const pushed = await git(['push', this.o.remote, `refs/tags/${tag}`]);
      if (pushed.status !== 0)
        throw new Error(failureMessage(`git push of ${tag} exited with ${pushed.status}`, output(pushed)));
    }
    const slug = githubSlug(this.o.remote);
    if (!slug) throw new Error(`${this.o.remote} is not a GitHub remote`);
    const gh = (args: string[]) =>
      this.deps.run('gh', args, { cwd: this.o.home, timeoutMs: GIT_TIMEOUT_MS, env: GIT_ENV });
    const viewed = await gh(['release', 'view', tag, '--repo', slug, '--json', 'url']);
    if (viewed.status === 0) {
      try {
        const url = (JSON.parse(viewed.stdout) as { url?: unknown }).url;
        if (typeof url === 'string' && url) return { tag, url };
      } catch {
        // Not JSON: treated as no release; creating one fails if it exists, and says why.
      }
    }
    const notes = path.join(releaseDir(this.o.home), `notes-${release.id}.md`);
    writeFileSync(
      notes,
      `${release.summary.trim()}\n\nCards: ${release.tasks.join(', ')}\nCommit: ${release.commit}\n`,
      { mode: 0o600 },
    );
    try {
      const made = await gh([
        'release',
        'create',
        tag,
        '--repo',
        slug,
        '--title',
        tag,
        '--notes-file',
        notes,
        '--verify-tag',
      ]);
      if (made.status !== 0)
        throw new Error(failureMessage(`gh release create exited with ${made.status}`, output(made)));
      const url = made.stdout.trim().split('\n').pop()?.trim();
      if (!url) throw new Error('gh release create printed no URL');
      return { tag, url };
    } finally {
      rmSync(notes, { force: true });
    }
  }
}
