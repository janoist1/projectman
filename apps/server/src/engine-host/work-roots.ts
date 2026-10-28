import { lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { isWithin } from '../kernel';

/**
 * The work roots (PM-846): where the worktrees and the member workspaces live. By default they lie directly in the home; a `workRoot` moves them below one root, which a person
 * mounts as a separate volume (on a Mac: an APFS volume with `.fseventsd/no_log`, so the file-event daemon
 * does not log the churn of the checkouts and `node_modules`). The full test's run directories do not move
 * with them: the full test sandbox denies the home for reading and allows only the run's own directory, so
 * the run directory must stay outside the home (`os.tmpdir()`), or the run could not read its parents.
 */

/** The file a person puts in the root of the work volume; without it the root is an unmounted mount point. */
export const WORK_ROOT_MARKER = '.projectman-work-root';

export interface WorkRoots {
  /** The real path of workRoot, or null when it is not set. */
  workRoot: string | null;
  /** `<workRoot>/worktrees`, else `<home>/worktrees`. */
  worktrees: string;
  /** `<workRoot>/workspaces`, else `<home>/workspaces`. */
  workspaces: string;
}

type WorkRootProblem = 'not_absolute' | 'missing' | 'marker_missing' | 'outside_home';

/** The work root cannot be used; the start stops with the reason in the message (never a quiet fallback). */
export class WorkRootError extends Error {
  readonly code = 'work_root_invalid';
  readonly reason: WorkRootProblem;
  constructor(reason: WorkRootProblem, message: string) {
    super(message);
    this.name = 'WorkRootError';
    this.reason = reason;
  }
}

const SUBDIRS = ['worktrees', 'workspaces'] as const;

/**
 * Resolves the work roots under `home`. Without a `workRoot` these are today's paths and nothing is
 * created. With one, the root must be a real directory inside the home (the sandboxes deny the home, which
 * keeps the other members' work unreadable), must hold the marker file, and gets its three subdirectories.
 */
export function resolveWorkRoots(home: string, workRoot?: string): WorkRoots {
  if (workRoot === undefined) {
    return {
      workRoot: null,
      worktrees: path.join(home, 'worktrees'),
      workspaces: path.join(home, 'workspaces'),
    };
  }
  if (!path.isAbsolute(workRoot))
    throw new WorkRootError('not_absolute', `The work root must be an absolute path: ${workRoot}`);
  let real: string;
  try {
    real = realpathSync(workRoot);
    if (!statSync(real).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new WorkRootError('missing', `The work root does not exist or is not a directory: ${workRoot}`);
  }
  let markerIsFile = false;
  try {
    markerIsFile = lstatSync(path.join(real, WORK_ROOT_MARKER)).isFile();
  } catch {
    markerIsFile = false;
  }
  if (!markerIsFile)
    throw new WorkRootError(
      'marker_missing',
      `The work root ${real} has no ${WORK_ROOT_MARKER} file: is the volume mounted?`,
    );
  const realHome = realpathSync(home);
  if (real === realHome || !isWithin(realHome, real))
    throw new WorkRootError(
      'outside_home',
      `The work root ${real} must lie inside the engine home ${realHome}, or the sandboxes could not keep the other members' work unreadable.`,
    );
  for (const name of SUBDIRS) mkdirSync(path.join(real, name), { recursive: true, mode: 0o700 });
  return {
    workRoot: real,
    worktrees: path.join(real, 'worktrees'),
    workspaces: path.join(real, 'workspaces'),
  };
}
