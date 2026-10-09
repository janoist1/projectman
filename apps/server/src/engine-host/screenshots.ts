import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ScenarioRefusal } from '../contracts';
import { isWithin } from './within';

/**
 * The disk of a screenshot run (PM-351), on the engine the session runs on: the scenario the agent
 * names and the images the run wrote (`EngineHost.resolveScenario`, `EngineHost.listImages`).
 */

/** The most images named, the most directory entries looked at, and how deep. */
const FILES_LIMIT = 100;
const SCAN_LIMIT = 5_000;
const SCAN_DEPTH = 6;
const IMAGE = /\.(?:png|jpe?g)$/i;

/**
 * The scenario's real path: it exists, is a file, and lies in the session's working directory or its
 * own folder after links are resolved. The run gets this path, not the one the agent wrote.
 */
export async function resolveScenario(
  roots: { cwd: string; sessionDir: string },
  requested: string,
): Promise<{ path: string } | { refused: ScenarioRefusal }> {
  let real: string;
  try {
    real = await realpath(path.resolve(roots.cwd, requested));
  } catch {
    return { refused: 'missing' };
  }
  const resolved = await Promise.all(
    [roots.cwd, roots.sessionDir].map((root) => realpath(root).catch(() => root)),
  );
  if (!resolved.some((root) => isWithin(root, real))) return { refused: 'outside' };
  const info = await stat(real).catch(() => null);
  if (!info?.isFile()) return { refused: 'not_file' };
  return { path: real };
}

/** The images below `dir` (`.png`, `.jpg`, `.jpeg`) written at or after `since` (ms), absolute, sorted. */
export async function listImages(dir: string, since: number): Promise<string[]> {
  const found: string[] = [];
  let seen = 0;
  const walk = async (current: string, depth: number): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (++seen > SCAN_LIMIT) return;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (depth < SCAN_DEPTH) await walk(full, depth + 1);
      } else if (entry.isFile() && IMAGE.test(entry.name)) {
        const info = await lstat(full).catch(() => null);
        // Whole milliseconds: a file written in the same millisecond the run started counts.
        if (info && Math.floor(info.mtimeMs) >= Math.floor(since)) found.push(full);
      }
    }
  };
  await walk(dir, 0);
  return found.sort().slice(0, FILES_LIMIT);
}
