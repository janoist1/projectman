import { existsSync, lstatSync, readdirSync, realpathSync, renameSync, statfsSync } from 'node:fs';
import path from 'node:path';
import { execCommand, ExecCommandError } from '../../apps/server/src/exec';
import {
  EngineConfig,
  EngineConfigError,
  saveEngineConfig,
} from '../../apps/server/src/engine-link/engine-config';
import { resolveWorkRoots, WorkRootError } from '../../apps/server/src/engine-host/work-roots';

/**
 * `npm run engine -- move-work-root <path>` (PM-846): copies the engine's `worktrees/` and `workspaces/`
 * to a work volume, repairs the git links, checks them, renames the old directories to `*.pre-PM-846` and
 * only then writes `workRoot` into `engine.json`. It copies instead of moving: until the last step the old
 * directories are the way back.
 */

/** The old directories keep this suffix until the owner deletes them. */
const OLD_SUFFIX = '.pre-PM-846';

/** Runs a program without a shell; resolves with its standard output, rejects with its error text. */
export type Exec = (file: string, args: string[]) => Promise<string>;

export const defaultExec: Exec = async (file, args) => {
  try {
    const { stdout } = await execCommand(file, args, {
      env: { ...process.env },
      maxOutputBytes: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    if (!(error instanceof ExecCommandError)) throw error;
    throw new Error(`${file} ${args.join(' ')} failed: ${(error.stderr || error.message).trim()}`);
  }
};

interface MoveWorkRootDeps {
  home: string;
  config: EngineConfig;
  /** The path as the owner typed it. */
  target: string;
  exec: Exec;
  platform: NodeJS.Platform;
  /** The engine runs: its status file names a live pid, or launchd runs the service of this home. */
  engineRunning: () => boolean;
  /** `resolveEngineConfig` on the new config; throws what the engine would refuse at start. */
  validate: (config: EngineConfig) => void;
  out: (text: string) => void;
}

const DIRECTORIES = ['worktrees', 'workspaces'] as const;

/** Disk space in use below a path (blocks, so sparse files and clones are not under-counted); symlinks are not followed. */
function usedBytes(entry: string): number {
  const stat = lstatSync(entry);
  if (!stat.isDirectory()) return stat.blocks * 512;
  let total = stat.blocks * 512;
  for (const name of readdirSync(entry)) total += usedBytes(path.join(entry, name));
  return total;
}

/**
 * The directories below `root` whose `.git` is a file: git worktrees. `<root>/<PROJECT>/<TASK>-<repo>`,
 * `<root>/<PROJECT>/_merge/*` and `<root>/<PROJECT>/_merge-fix/*` are at most four levels down; a directory
 * with a `.git` is not searched further.
 */
export function findWorktrees(root: string, depth = 4): string[] {
  const found: string[] = [];
  const visit = (dir: string, left: number): void => {
    const git = path.join(dir, '.git');
    if (existsSync(git)) {
      if (lstatSync(git).isFile()) found.push(dir);
      return;
    }
    if (left === 0) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== 'node_modules') visit(path.join(dir, entry.name), left - 1);
    }
  };
  if (existsSync(root)) visit(root, depth);
  return found;
}

/** The worktree paths of `git worktree list --porcelain` that are not prunable (their directory is there). */
export function listedWorktrees(porcelain: string): string[] {
  return porcelain
    .split(/\n\n+/)
    .filter((block) => block.trim() !== '' && !/^prunable\b/m.test(block))
    .map((block) => /^worktree (.+)$/m.exec(block)?.[1])
    .filter((value): value is string => value !== undefined);
}

const refuse = (code: string, message: string): never => {
  throw new EngineConfigError(code, message);
};

export async function moveWorkRoot(deps: MoveWorkRootDeps): Promise<number> {
  const { home, config, exec, out } = deps;
  if (!path.isAbsolute(deps.target))
    refuse('work_root_invalid', `The work root must be an absolute path: ${deps.target}`);
  if (deps.engineRunning())
    refuse(
      'engine_running',
      'The engine is running. Stop it first (npm run engine -- service uninstall, or end the "start" process).',
    );
  if (config.workRoot !== undefined)
    refuse('work_root_set', `engine.json already has a workRoot (${config.workRoot}); nothing to move.`);

  let roots;
  try {
    roots = resolveWorkRoots(home, deps.target);
  } catch (error) {
    if (error instanceof WorkRootError) return refuse(error.code, error.message);
    throw error;
  }
  const workRoot = roots.workRoot!;
  deps.validate(EngineConfig.parse({ ...config, workRoot }));

  const oldHome = realpathSync(home);
  const sources = DIRECTORIES.map((name) => ({
    name,
    from: path.join(oldHome, name),
    to: name === 'worktrees' ? roots.worktrees : roots.workspaces,
  }));
  for (const { from, to } of sources) {
    if (existsSync(`${from}${OLD_SUFFIX}`))
      refuse('target_exists', `${from}${OLD_SUFFIX} exists already; delete it or move it away first.`);
    if (existsSync(to) && readdirSync(to).length > 0)
      refuse('target_not_empty', `${to} is not empty; the work root must be a fresh volume.`);
  }

  const present = sources.filter(({ from }) => existsSync(from));
  const needed = present.reduce((sum, { from }) => sum + usedBytes(from), 0);
  const stat = statfsSync(workRoot);
  const free = stat.bavail * stat.bsize;
  if (free < needed * 1.1)
    refuse(
      'not_enough_space',
      `The work volume has ${Math.floor(free / 1e9)} GB free; ${Math.ceil((needed * 1.1) / 1e9)} GB are needed (the copy is complete: clones do not cross volumes).`,
    );

  out(
    `copying ${present.map(({ name }) => name).join(' and ') || 'nothing'} (${Math.ceil(needed / 1e6)} MB) to ${workRoot}`,
  );
  for (const { from, to } of present) {
    if (deps.platform === 'darwin') await exec('ditto', [from, to]);
    else await exec('cp', ['-a', `${from}/.`, to]);
  }

  const oldWorktrees = findWorktrees(path.join(oldHome, 'worktrees'));
  const repair = async (directories: string[]): Promise<void> => {
    for (const directory of directories) await exec('git', ['-C', directory, 'worktree', 'repair']);
  };
  try {
    await repair(findWorktrees(roots.worktrees));
    const old = [path.join(oldHome, 'worktrees'), path.join(home, 'worktrees')];
    const stale: string[] = [];
    for (const repo of new Set(config.repos.map((entry) => entry.path))) {
      const listed = listedWorktrees(await exec('git', ['-C', repo, 'worktree', 'list', '--porcelain']));
      for (const worktree of listed)
        if (old.some((root) => worktree === root || worktree.startsWith(`${root}${path.sep}`)))
          stale.push(worktree);
    }
    if (stale.length > 0)
      refuse(
        'worktree_not_repaired',
        `${stale.length} worktree(s) still point at the old directory: ${stale.slice(0, 5).join(', ')}`,
      );
  } catch (error) {
    // Point the repositories back at the old worktrees; the copies stay for the owner to look at.
    await repair(oldWorktrees).catch(() => undefined);
    const reason = error instanceof Error ? error.message : String(error);
    throw new EngineConfigError(
      error instanceof EngineConfigError ? error.code : 'move_failed',
      `${reason}\nengine.json is unchanged and the old directories are in place. Delete the copies in ${roots.worktrees} and ${roots.workspaces} before trying again.`,
    );
  }

  for (const { from } of present) renameSync(from, `${from}${OLD_SUFFIX}`);
  saveEngineConfig(home, EngineConfig.parse({ ...config, workRoot }));
  out(`workRoot is ${workRoot}; the old directories are renamed to *${OLD_SUFFIX}`);
  out('next: start the engine (npm run engine -- service install, or start) and check that the team works');
  out(
    `then delete ${present.map(({ from }) => `${from}${OLD_SUFFIX}`).join(' and ')} (a running session starts a new conversation with a summary; the files stay)`,
  );
  return 0;
}
