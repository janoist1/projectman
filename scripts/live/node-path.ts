import { realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * The `node` a LaunchAgent runs (PM-514). `process.execPath` is the resolved binary, which under Homebrew is
 * `/opt/homebrew/Cellar/node/<version>/bin/node`: a `brew upgrade node` removes that directory and the job
 * would never start again. The same binary is reachable through a stable name on the PATH
 * (`/opt/homebrew/bin/node`), and that is the path the plist gets.
 */

/** A path inside Homebrew's versioned Cellar. */
export const isVersionedNodePath = (nodePath: string): boolean => nodePath.split(path.sep).includes('Cellar');

function realpathOrNull(file: string): string | null {
  try {
    return realpathSync(file);
  } catch {
    return null;
  }
}

/**
 * The first `node` on the PATH that is the running binary and has no versioned directory in its name;
 * `execPath` itself when there is none (the install then warns about a versioned path).
 */
export function stableNodePath(execPath: string, pathEnv: string | undefined): string {
  if (!isVersionedNodePath(execPath)) return execPath;
  const running = realpathOrNull(execPath);
  if (running === null) return execPath;
  for (const directory of (pathEnv ?? '').split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, 'node');
    if (isVersionedNodePath(candidate)) continue;
    if (realpathOrNull(candidate) === running) return candidate;
  }
  return execPath;
}
