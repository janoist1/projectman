import path from 'node:path';

/** The two LaunchAgents of the live instance (PM-493): the server, and the watcher that deploys approved releases. */
export const SERVER_LABEL = 'com.projectman.live';
export const WATCHER_LABEL = 'com.projectman.live-watcher';

/**
 * The two launchers the plists start instead of `node` (PM-514): macOS names a background item after the
 * first element of `ProgramArguments`. They are files of the checkout, so they come with every release.
 */
export const SERVER_LAUNCHER = 'projectman-live';
export const WATCHER_LAUNCHER = 'projectman-release-watcher';
export const launcherFile = (root: string, name: string) => path.join(root, 'scripts', 'live', 'bin', name);

/** The port, the release target and the shutdown pause the install falls back to. */
export const DEFAULT_PORT = 4800;
export const DEFAULT_TARGET = 'PM/projectman';
export const DEFAULT_SHUTDOWN_PAUSE_MS = 60_000;

/** An error that ends a live command with a message and an exit status (2: refused, 1: failed). */
export class LiveError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

/** `^(git@github.com:|https://github.com/)owner/repo(.git)?$`: the only remotes a release is fetched from and tagged on. */
export const GITHUB_REMOTE_PATTERN = /^(git@github\.com:|https:\/\/github\.com\/)[\w.-]+\/[\w.-]+?(\.git)?$/;

/** `owner/repo` of a GitHub remote, or null. */
export function githubSlug(remote: string): string | null {
  if (!GITHUB_REMOTE_PATTERN.test(remote)) return null;
  return remote.replace(/^(git@github\.com:|https:\/\/github\.com\/)/, '').replace(/\.git$/, '');
}

export const SHA40 = /^[0-9a-f]{40}$/;

/** Everything the watcher keeps lives in the app home, where the members' sandboxes cannot read it (the backups hold all data). */
export function releaseDir(home: string): string {
  return path.join(home, 'release');
}
export const journalFile = (home: string) => path.join(releaseDir(home), 'journal.json');
export const lockFile = (home: string) => path.join(releaseDir(home), 'watch.lock');
export const backupsDir = (home: string) => path.join(releaseDir(home), 'backups');
export const serverLog = (home: string) => path.join(home, 'logs', 'live-server.log');
export const watcherLog = (home: string) => path.join(home, 'logs', 'live-watcher.log');
export const dbFile = (home: string) => path.join(home, 'db.sqlite');

/** The builds sit beside the root, on the same volume, so that renaming them is atomic. */
export const nextDir = (root: string) => `${root}-next`;
export const prevDir = (root: string, commit: string) => `${root}-prev-${commit}`;
export const failedDir = (root: string, commit: string) => `${root}-failed-${commit}`;

export const agentsDir = (homeDir: string) => path.join(homeDir, 'Library', 'LaunchAgents');
export const plistFile = (homeDir: string, label: string) => path.join(agentsDir(homeDir), `${label}.plist`);

export const domainTarget = (uid: number, label: string) => `gui/${uid}/${label}`;

/** The last `max` characters of some output, for a failure message the server stores (at most 2000). */
function tail(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : trimmed.slice(trimmed.length - max);
}

/** `prefix` and the end of `output`, in at most 2000 characters. */
export function failureMessage(prefix: string, output: string): string {
  const head = prefix.length > 400 ? prefix.slice(0, 400) : prefix;
  const rest = tail(output, 2000 - head.length - 1);
  return rest ? `${head}\n${rest}` : head;
}
