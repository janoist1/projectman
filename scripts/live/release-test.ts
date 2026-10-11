import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { LiveDeps } from './deps';

/**
 * The release test (PM-493, PM-386): the tests the merge sandbox leaves out run outside the sandbox
 * before every switch of the live instance. A test file takes part by naming the marker literally;
 * the sandbox's own line that sets the variable (`PROJECTMAN_FULL_TEST_SANDBOX: '1'`) is not one.
 */

export const RELEASE_TEST_MARKER = "process.env.PROJECTMAN_FULL_TEST_SANDBOX === '1'";
const TEST_FILE = /\.test\.(ts|tsx|js|mjs)$/;
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist']);
/** The variables the sandboxed run sets, which the release test must not inherit. */
const SANDBOX_VARIABLES = ['PROJECTMAN_FULL_TEST_SANDBOX', 'PROJECTMAN_SKIP_PTY_TESTS', 'PROJECTMAN_HOME'];

export interface WorkspaceFiles {
  /** Absolute path of the workspace. */
  workspace: string;
  /** Paths relative to the workspace, sorted. */
  files: string[];
}

/** The workspace folders of the root `package.json`: `packages/*` names every folder under `packages`. */
function workspaceDirectories(root: string): string[] {
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    workspaces?: string[] | { packages?: string[] };
  };
  const patterns = Array.isArray(manifest.workspaces)
    ? manifest.workspaces
    : (manifest.workspaces?.packages ?? []);
  const directories: string[] = [];
  for (const pattern of patterns) {
    if (pattern.endsWith('/*')) {
      const parent = path.join(root, pattern.slice(0, -2));
      if (!existsSync(parent)) continue;
      for (const entry of readdirSync(parent, { withFileTypes: true }))
        if (entry.isDirectory()) directories.push(path.join(parent, entry.name));
    } else {
      directories.push(path.join(root, pattern));
    }
  }
  return directories.filter((directory) => existsSync(path.join(directory, 'package.json'))).sort();
}

function testFiles(directory: string, base: string, found: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) testFiles(full, base, found);
    else if (
      entry.isFile() &&
      TEST_FILE.test(entry.name) &&
      readFileSync(full, 'utf8').includes(RELEASE_TEST_MARKER)
    )
      found.push(path.relative(base, full));
  }
}

/** The test files that carry the marker, by workspace (workspaces without one are left out). */
export function releaseTestFiles(root: string): WorkspaceFiles[] {
  const result: WorkspaceFiles[] = [];
  for (const workspace of workspaceDirectories(root)) {
    const files: string[] = [];
    testFiles(workspace, workspace, files);
    if (files.length > 0) result.push({ workspace, files: files.sort() });
  }
  return result;
}

/** Runs them workspace by workspace; returns the exit status (0: none to run, or all green). */
export async function runReleaseTest(deps: LiveDeps, root: string): Promise<number> {
  const groups = releaseTestFiles(root);
  const count = groups.reduce((sum, group) => sum + group.files.length, 0);
  deps.out(`release-test: ${count} files in ${groups.length} workspaces\n`);
  let failed: { workspace: string; status: number } | null = null;
  for (const group of groups) {
    const result = await deps.run(
      path.join(root, 'node_modules', '.bin', 'vitest'),
      ['run', '--configLoader', 'runner', ...group.files],
      // Its own environment, without the variables the sandboxed run sets.
      { cwd: group.workspace, unsetEnv: SANDBOX_VARIABLES },
    );
    if (result.stdout) deps.out(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
    if (result.stderr) deps.out(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
    if (result.status !== 0) {
      failed = { workspace: path.basename(group.workspace), status: result.status };
      break;
    }
  }
  deps.out(failed ? `release-test: failed (${failed.workspace})\n` : 'release-test: passed\n');
  return failed ? failed.status : 0;
}
