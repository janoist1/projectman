import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { LiveDeps, RunResult } from './deps';
import { readJournal } from './journal';
import {
  bootout,
  bootstrap,
  isLoaded,
  launchctl,
  pauseAndWait,
  requireMac,
  resume,
  tryControl,
  verifyServer,
  waitPortFree,
} from './launchd';
import {
  agentsDir,
  backupsDir,
  domainTarget,
  GITHUB_REMOTE_PATTERN,
  launcherFile,
  LiveError,
  plistFile,
  releaseDir,
  serverLog,
  SERVER_LABEL,
  SERVER_LAUNCHER,
  SHA40,
  watcherLog,
  WATCHER_LABEL,
  WATCHER_LAUNCHER,
} from './paths';
import { isVersionedNodePath, stableNodePath } from './node-path';
import {
  buildServerPlist,
  buildWatcherPlist,
  exitTimeoutSeconds,
  installedProgramArguments,
  unescapeXml,
} from './plist';

/**
 * `npm run live -- install | uninstall | status` (PM-493): the live instance under launchd, and the
 * watcher that deploys approved releases. docs/DEPLOY.md has the procedure.
 */

export interface InstallArgs {
  root: string;
  home: string;
  port: number;
  /** `<project key>/<repository>`: the instance itself, for the release record (`PROJECTMAN_RELEASE_TARGET`). */
  target: string;
  /** The GitHub remote; null: the origin of the root (and of its origin, when that is a local path). */
  remote: string | null;
}

const git = (deps: LiveDeps, cwd: string, args: string[]): Promise<RunResult> =>
  deps.run('git', args, { cwd, timeoutMs: 120_000, env: { GIT_TERMINAL_PROMPT: '0' } });

async function originOf(deps: LiveDeps, directory: string): Promise<string> {
  const result = await git(deps, directory, ['remote', 'get-url', 'origin']);
  const url = result.stdout.trim();
  if (result.status !== 0 || !url)
    throw new LiveError(`${directory} has no origin remote: name the GitHub remote with --remote`, 2);
  return url;
}

const isLocalPath = (remote: string): boolean =>
  path.isAbsolute(remote) || remote.startsWith('.') || remote.startsWith('~');

/** The remote the watcher fetches releases from and tags on; it must be GitHub, and reachable from this shell. */
async function resolveRemote(deps: LiveDeps, args: InstallArgs): Promise<string> {
  let remote = args.remote ?? (await originOf(deps, args.root));
  // Today's checkout is cloned from the owner's working repository: the remote is that repository's origin.
  if (isLocalPath(remote)) remote = await originOf(deps, path.resolve(remote));
  if (!GITHUB_REMOTE_PATTERN.test(remote))
    throw new LiveError(
      `${remote} is not a GitHub remote (git@github.com:owner/repo or https://github.com/owner/repo)`,
      2,
    );
  const listed = await git(deps, args.home, ['ls-remote', '--exit-code', remote, 'HEAD']);
  if (listed.status !== 0)
    throw new LiveError(
      `git ls-remote ${remote} failed from this shell: ${listed.stderr.trim() || listed.stdout.trim()}`,
      2,
    );
  const auth = await deps.run('gh', ['auth', 'status'], { cwd: args.home, timeoutMs: 60_000 });
  if (auth.status !== 0)
    throw new LiveError(
      `gh is not signed in from this shell: ${auth.stderr.trim() || auth.stdout.trim()}`,
      2,
    );
  return remote;
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function writePlist(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, { mode: 0o644 });
  chmodSync(file, 0o644);
}

/** The pids that listen on the port (a server that was started by hand, not by launchd). */
async function listeners(deps: LiveDeps, port: number): Promise<number[]> {
  const result = await deps.run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
    cwd: deps.homeDir,
    timeoutMs: 30_000,
  });
  return result.stdout
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

export async function install(deps: LiveDeps, args: InstallArgs): Promise<number> {
  requireMac(deps);
  for (const value of [args.root, args.home])
    if (!path.isAbsolute(value)) throw new LiveError(`${value} is not an absolute path`, 2);
  const journal = readJournal(args.home);
  if (journal.kind !== 'none')
    throw new LiveError(
      `a release is in progress (${releaseDir(args.home)}/journal.json): wait for the watcher, or see docs/DEPLOY.md`,
      2,
    );
  if (!existsSync(path.join(args.root, 'apps', 'server', 'dist', 'index.js')))
    throw new LiveError(
      `${args.root} has no built server (apps/server/dist/index.js): run npm run build there`,
      2,
    );
  for (const name of [SERVER_LAUNCHER, WATCHER_LAUNCHER])
    if (!isExecutable(launcherFile(args.root, name)))
      throw new LiveError(
        `${launcherFile(args.root, name)} is missing or not executable: the LaunchAgents start the launchers, not node itself`,
        2,
      );
  const nodePath = stableNodePath(deps.nodePath, deps.env.PATH);
  if (!isExecutable(nodePath)) throw new LiveError(`${nodePath} is not an executable node`, 2);
  const head = await git(deps, args.root, ['rev-parse', 'HEAD']);
  if (head.status !== 0 || !SHA40.test(head.stdout.trim()))
    throw new LiveError(`${args.root} is not a git checkout with a commit`, 2);
  const commit = head.stdout.trim();
  const remote = await resolveRemote(deps, args);

  const common = {
    nodePath,
    root: args.root,
    home: args.home,
    userHome: deps.homeDir,
    port: args.port,
    env: deps.env,
  };
  const server = buildServerPlist({ ...common, target: args.target, logFile: serverLog(args.home) });
  const watcher = buildWatcherPlist({ ...common, remote, logFile: watcherLog(args.home) });

  // Take over: the sessions come to a safe point, and the server that runs now stops.
  const exitTimeout = exitTimeoutSeconds(deps.env);
  if (await isLoaded(deps, WATCHER_LABEL)) await bootout(deps, WATCHER_LABEL);
  const serverLoaded = await isLoaded(deps, SERVER_LABEL);
  const listening = await deps.portListening(args.port);
  if (listening) {
    const paused = await pauseAndWait(deps, 'live install');
    if (!paused.ok) {
      await resume(deps);
      throw new LiveError(`the running server did not pause: ${paused.message}`);
    }
  }
  if (serverLoaded) {
    const stopped = await bootout(deps, SERVER_LABEL);
    if (stopped.status !== 0) {
      if (listening) await resume(deps);
      throw new LiveError(`launchctl bootout failed (${stopped.status}): ${stopped.stderr.trim()}`);
    }
  } else if (listening) {
    const pids = await listeners(deps, args.port);
    if (pids.length === 0) {
      await resume(deps);
      throw new LiveError(`port ${args.port} is in use, but no process that listens on it was found`);
    }
    for (const pid of pids) deps.kill(pid, 'SIGTERM');
  }
  if (listening && !(await waitPortFree(deps, args.port, exitTimeout * 1000))) {
    await resume(deps);
    throw new LiveError(`the server on port ${args.port} did not stop within ${exitTimeout} s`);
  }

  mkdirSync(path.dirname(serverLog(args.home)), { recursive: true, mode: 0o700 });
  mkdirSync(releaseDir(args.home), { recursive: true, mode: 0o700 });
  chmodSync(releaseDir(args.home), 0o700);
  const serverPlist = plistFile(deps.homeDir, SERVER_LABEL);
  const watcherPlist = plistFile(deps.homeDir, WATCHER_LABEL);
  writePlist(serverPlist, server.text);
  writePlist(watcherPlist, watcher.text);

  const undo = async (why: string): Promise<never> => {
    await bootout(deps, SERVER_LABEL);
    rmSync(serverPlist, { force: true });
    rmSync(watcherPlist, { force: true });
    throw new LiveError(
      `${why}\nthe pause stays open and the LaunchAgents are removed; the log: ${serverLog(args.home)}. docs/DEPLOY.md says how to start the server by hand and resume.`,
    );
  };
  const loaded = await bootstrap(deps, SERVER_LABEL);
  if (loaded.status !== 0)
    return undo(`launchctl bootstrap of the server failed (${loaded.status}): ${loaded.stderr.trim()}`);
  if (!(await verifyServer(deps, { port: args.port, commit })))
    return undo(`the server did not come up with the commit ${commit.slice(0, 12)}`);
  await resume(deps);
  const watching = await bootstrap(deps, WATCHER_LABEL);
  if (watching.status !== 0)
    throw new LiveError(
      `launchctl bootstrap of the watcher failed (${watching.status}): ${watching.stderr.trim()}`,
    );

  deps.out(`live server installed: ${serverPlist}\n`);
  deps.out(`release watcher installed: ${watcherPlist}\n`);
  deps.out(`node: ${nodePath}\n`);
  if (isVersionedNodePath(nodePath))
    deps.out(
      `warning: ${nodePath} has a version in its path and disappears with the next upgrade of node: install again after it, or run the install with a node that has a stable path on the PATH\n`,
    );
  deps.out(`the server runs ${commit.slice(0, 12)} on port ${args.port}; remote: ${remote}\n`);
  deps.out(`variables of the server (names only): ${server.variables.join(', ')}\n`);
  deps.out(`logs: ${serverLog(args.home)}, ${watcherLog(args.home)}\n`);
  return 0;
}

export async function uninstall(deps: LiveDeps, args: { home: string }): Promise<number> {
  requireMac(deps);
  if (readJournal(args.home).kind !== 'none')
    throw new LiveError(
      `a release is in progress (${releaseDir(args.home)}/journal.json): wait for the watcher, or see docs/DEPLOY.md`,
      2,
    );
  for (const label of [WATCHER_LABEL, SERVER_LABEL]) {
    const result = await bootout(deps, label);
    if (result.status !== 0)
      throw new LiveError(`launchctl bootout of ${label} failed (${result.status}): ${result.stderr.trim()}`);
    const file = plistFile(deps.homeDir, label);
    const had = existsSync(file);
    rmSync(file, { force: true });
    deps.out(had ? `removed ${file}\n` : `${label} was not installed\n`);
  }
  deps.out('the live server is stopped; start it by hand (docs/DEPLOY.md) if it should keep running\n');
  return 0;
}

/** What `launchctl print` says about a job: loaded, and its state, pid and last exit code. */
async function agentState(deps: LiveDeps, label: string): Promise<{ loaded: boolean; text: string }> {
  const printed = await launchctl(deps, ['print', domainTarget(deps.uid, label)]);
  if (printed.status !== 0) return { loaded: false, text: 'not loaded' };
  const state = /^\s*state = (.+)$/m.exec(printed.stdout)?.[1];
  const pid = /^\s*pid = (\d+)/m.exec(printed.stdout)?.[1];
  const exit = /^\s*last exit code = (.+)$/m.exec(printed.stdout)?.[1];
  return {
    loaded: true,
    text: `loaded, ${state ?? 'unknown state'}${pid ? ` (pid ${pid})` : ''}${exit ? `, last exit code ${exit}` : ''}`,
  };
}

/**
 * What an installed plist starts: the launcher and node must exist (PM-514), or the job cannot start and
 * launchd, with `KeepAlive`, tries in vain. Returns whether both do.
 */
function reportProgram(deps: LiveDeps, label: string): boolean {
  const file = plistFile(deps.homeDir, label);
  if (!existsSync(file)) return true;
  const program = installedProgramArguments(readFileSync(file, 'utf8'));
  if (!program || program.length === 0) {
    deps.out(`  ${label}: the file has no ProgramArguments\n`);
    return false;
  }
  // A PM-493 file starts node itself (and shows up as "node" in macOS); install again for the launcher.
  const legacy = path.basename(program[0]!) === 'node';
  const launcher = legacy ? null : program[0]!;
  const nodePath = legacy ? program[0]! : (program[1] ?? '');
  let ok = true;
  if (launcher !== null) {
    const good = isExecutable(launcher);
    ok &&= good;
    deps.out(`  launcher: ${launcher}${good ? '' : ' (MISSING or not executable)'}\n`);
  } else {
    deps.out('  launcher: none (the file is from before PM-514: install again so that macOS names it)\n');
  }
  const goodNode = isExecutable(nodePath);
  ok &&= goodNode;
  deps.out(`  node: ${nodePath}${goodNode ? '' : ' (MISSING: node moved or was upgraded; install again)'}\n`);
  if (goodNode && isVersionedNodePath(nodePath))
    deps.out('  node: its path has a version in it and will not survive an upgrade; install again\n');
  return ok;
}

export async function status(deps: LiveDeps, args: { home: string }): Promise<number> {
  requireMac(deps);
  const server = await agentState(deps, SERVER_LABEL);
  const watcher = await agentState(deps, WATCHER_LABEL);
  deps.out(`${SERVER_LABEL}: ${server.text}\n`);
  const serverProgram = reportProgram(deps, SERVER_LABEL);
  deps.out(`${WATCHER_LABEL}: ${watcher.text}\n`);
  const watcherProgram = reportProgram(deps, WATCHER_LABEL);

  const answer = await tryControl(deps, { op: 'status' });
  if (!answer) deps.out('server: does not answer on its control socket\n');
  else if (!answer.ok) deps.out(`server: ${answer.error.code}: ${answer.error.message}\n`);
  else {
    deps.out(`running commit: ${answer.appVersion ?? 'unknown'}\n`);
    deps.out(
      answer.pause
        ? `pause: ${answer.pause.state}${answer.pause.reason ? ` (${answer.pause.reason})` : ''}\n`
        : 'pause: none\n',
    );
  }

  const journal = readJournal(args.home);
  if (journal.kind === 'none') deps.out('journal: none\n');
  else if (journal.kind === 'invalid') deps.out(`journal: unreadable (${journal.reason})\n`);
  else deps.out(`journal: release ${journal.journal.releaseId}, step ${journal.journal.step}\n`);

  const backups = existsSync(backupsDir(args.home))
    ? readdirSync(backupsDir(args.home))
        .filter((name) => /^db-.*\.sqlite$/.test(name))
        .sort()
    : [];
  deps.out(
    `latest backup: ${backups.length > 0 ? path.join(backupsDir(args.home), backups[backups.length - 1]!) : 'none'}\n`,
  );

  const watcherFile = plistFile(deps.homeDir, WATCHER_LABEL);
  const remoteMatch = existsSync(watcherFile)
    ? /<string>--remote<\/string>\s*<string>([^<]*)<\/string>/.exec(readFileSync(watcherFile, 'utf8'))
    : null;
  const remote = remoteMatch ? unescapeXml(remoteMatch[1]!) : null;
  deps.out(`remote: ${remote ?? 'unknown (the watcher is not installed)'}\n`);
  if (remote) {
    const listed = await git(deps, args.home, ['ls-remote', '--exit-code', remote, 'HEAD']);
    deps.out(`git ls-remote: ${listed.status === 0 ? 'ok' : `failed (${listed.status})`}\n`);
  }
  const auth = await deps.run('gh', ['auth', 'status'], { cwd: args.home, timeoutMs: 60_000 });
  deps.out(`gh auth status: ${auth.status === 0 ? 'ok' : `failed (${auth.status})`}\n`);
  deps.out(`LaunchAgents: ${agentsDir(deps.homeDir)}\n`);
  return server.loaded && watcher.loaded && serverProgram && watcherProgram ? 0 : 1;
}
