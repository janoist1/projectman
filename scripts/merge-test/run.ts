import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { isRepoFilePath, MERGE_TEST_WORKERS_PREFIX } from '@projectman/shared';
import { readGitTree, runGit } from './git-tree';
import { runNpm } from './npm';
import { refineRoots, refineScope } from './refine';
import { CLOUD_TEST_FILTERS, mergeTestScope } from './scope';
import type { MergeTestScope } from './scope';
import {
  filesSteps,
  MERGE_TEST_SHARDS_MAX,
  MERGE_TEST_WORKSPACES,
  runSteps,
  shardSteps,
  testStep,
  typecheckStep,
  workspaceOf,
} from './steps';
import type { MergeTestShard, MergeTestStep, StepRun } from './steps';

const USAGE =
  'usage: npm run merge-test -- [--no-cache] [--shard <k>/<n>] [--all | --dry-run [<commit>] | --files-from-env | --files <repository path of a test file>...]';

/** Whether the scope runs the server's tests, which include the PTY and Unix socket integration tests. */
function runsServerTests(scope: MergeTestScope): boolean {
  if (scope.kind === 'all' || scope.kind === 'cloud' || scope.kind === 'modules') return true;
  return scope.kind === 'workspaces' && scope.workspaces.includes('apps/server');
}

export function scopeLine(scope: MergeTestScope): string {
  if (scope.kind === 'shared')
    return `merge-test scope: shared (exports: ${scope.exports.length}); workspaces: ${scope.workspaces.join(', ')}; typecheck: all; fallback: ${scope.fallback ?? 'none'}; selected tests: ${scope.tests?.join(', ') ?? (scope.workspaces.includes('apps/server') ? 'apps/server/*' : 'none')}`;
  if (scope.kind === 'cloud')
    return `merge-test scope: cloud; workspaces: apps/server; test filters: ${CLOUD_TEST_FILTERS.join(', ')}; fallback: none`;
  if (scope.kind === 'owned')
    return `merge-test scope: owned (${scope.rules.join(', ')}); workspaces: apps/server; test filters: ${scope.tests.join(', ')}; fallback: none`;
  if (scope.kind === 'modules')
    return `merge-test scope: modules (${scope.modules.join(', ')}); tests: ${scope.tests.length}; workspaces: ${scope.workspaces.join(', ')}; fallback: none; selected tests: ${scope.tests.join(', ')}`;
  if (scope.kind === 'workspaces' && scope.fallback)
    return `merge-test scope: workspaces (${scope.workspaces.join(', ')}); modules: unavailable; tests: all; fallback: ${scope.fallback}`;
  if (scope.kind === 'all')
    return `merge-test scope: all (${scope.reason}); modules: all; tests: all; fallback: ${scope.reason}`;
  if (scope.kind === 'none') return 'merge-test scope: none; modules: none; tests: 0; fallback: none';
  return `merge-test scope: workspaces (${scope.workspaces.join(', ')}); modules: all; tests: all; fallback: none`;
}

function filesScopeLine(files: readonly string[]): string {
  const workspaces = MERGE_TEST_WORKSPACES.filter((workspace) =>
    files.some((file) => workspaceOf(file) === workspace),
  );
  return `merge-test scope: files (${files.length}); workspaces: ${workspaces.join(', ')}; tests: ${files.length}; fallback: none; selected tests: ${files.join(', ')}`;
}

/**
 * The commands of a scope. The full run goes by workspace (every type check, then every test), so a
 * failed test file can be tied to its workspace and rerun there (PM-842).
 */
export function mergeTestSteps(scope: MergeTestScope): MergeTestStep[] {
  if (scope.kind === 'none') return [];
  if (scope.kind === 'all')
    return [
      ...MERGE_TEST_WORKSPACES.map((workspace) => typecheckStep(workspace, true)),
      ...MERGE_TEST_WORKSPACES.map((workspace) => testStep(workspace, undefined, true)),
    ];
  if (scope.kind === 'cloud')
    return [typecheckStep('apps/server'), testStep('apps/server', CLOUD_TEST_FILTERS)];
  if (scope.kind === 'owned') return [typecheckStep('apps/server'), testStep('apps/server', scope.tests)];
  if (scope.kind === 'shared')
    return [
      ...MERGE_TEST_WORKSPACES.map((workspace) => typecheckStep(workspace, true)),
      ...MERGE_TEST_WORKSPACES.filter((ws) => scope.workspaces.includes(ws)).map((ws) =>
        testStep(ws, ws === 'apps/server' ? scope.tests : undefined, true),
      ),
    ];
  if (scope.kind === 'modules')
    return [
      typecheckStep('apps/server'),
      testStep('apps/server', scope.tests),
      ...scope.workspaces.flatMap((ws) => [typecheckStep(ws), testStep(ws)]),
    ];
  return scope.workspaces.flatMap((ws) => [typecheckStep(ws), testStep(ws)]);
}

type Parsed = { all: boolean } | { dryRun: string } | { files: string[] } | { error: string };

const FILES_FROM_ENV_MAX = 20;

/** The `--files-from-env` list: a JSON array in `MERGE_TEST_FILES`; empty or absent means no list. */
function filesFromEnv(raw: string | undefined): Parsed | undefined {
  if (!raw?.trim()) return undefined;
  const fail = (reason: string): Parsed => ({ error: `merge-test: MERGE_TEST_FILES ${reason}\n${USAGE}` });
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    return fail('is not valid JSON');
  }
  if (!Array.isArray(list) || list.some((file) => typeof file !== 'string'))
    return fail('is not a JSON array of strings');
  if (list.length === 0 || list.length > FILES_FROM_ENV_MAX)
    return fail(`must hold 1 to ${FILES_FROM_ENV_MAX} files`);
  const files = [...new Set(list as string[])];
  const unknown = files.find((file) => !isRepoFilePath(file) || !workspaceOf(file));
  return unknown === undefined
    ? { files }
    : fail(`names a file that is not of a known workspace: ${unknown}`);
}

/** `--shard k/n`, taken out of the arguments wherever it stands. */
function takeShard(argv: readonly string[]): { rest: string[]; shard?: MergeTestShard } | { error: string } {
  const at = argv.indexOf('--shard');
  if (at < 0) return { rest: [...argv] };
  const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(argv[at + 1] ?? '');
  const shard = match && { index: Number(match[1]), count: Number(match[2]) };
  const rest = [...argv.slice(0, at), ...argv.slice(at + 2)];
  if (!shard || shard.index > shard.count || shard.count > MERGE_TEST_SHARDS_MAX || rest.includes('--shard'))
    return { error: `merge-test: --shard takes k/n with 1 <= k <= n <= ${MERGE_TEST_SHARDS_MAX}\n${USAGE}` };
  return { rest, shard };
}

function parseArgs(argv: readonly string[]): Parsed {
  const fromEnv = argv.indexOf('--files-from-env');
  if (fromEnv >= 0) {
    // Not with any other mode; with an empty list it is the plain scope mode.
    if (argv.length > 1) return { error: USAGE };
    return filesFromEnv(process.env.MERGE_TEST_FILES) ?? { all: false };
  }
  if (argv[0] === '--dry-run') {
    if (argv.length > 2 || (argv[1] !== undefined && (!argv[1] || argv[1].startsWith('-'))))
      return { error: USAGE };
    return { dryRun: argv[1] ?? 'HEAD' };
  }
  const at = argv.indexOf('--files');
  if (at < 0)
    return argv.length === 0 || (argv.length === 1 && argv[0] === '--all')
      ? { all: argv.length > 0 }
      : { error: USAGE };
  const files = [...new Set(argv.slice(at + 1))];
  if (at > 0 || files.length === 0) return { error: USAGE };
  const unknown = files.find((file) => !isRepoFilePath(file) || !workspaceOf(file));
  return unknown === undefined
    ? { files }
    : { error: `merge-test: not a file of a known workspace: ${unknown}\n${USAGE}` };
}

interface MergeTestIo {
  /** Runs the repository-wide dead-code check, once on the first shard. */
  deadCode?: () => Promise<StepRun>;
  /** Whether a repository file exists in the checkout. */
  exists?: (file: string) => boolean;
  /** Runs `npm <args>`. */
  npm?: (args: string[]) => Promise<StepRun>;
}

export async function runMergeTest(argv: readonly string[], io: MergeTestIo = {}): Promise<number> {
  const noCache = argv.includes('--no-cache');
  const taken = takeShard(argv.filter((arg) => arg !== '--no-cache'));
  const parsed = 'error' in taken ? taken : parseArgs(taken.rest);
  if ('error' in parsed) {
    console.error(parsed.error);
    return 2;
  }
  const shard = 'shard' in taken ? taken.shard : undefined;
  let steps: MergeTestStep[];
  let line: string;
  let changed: ReadonlySet<string> | null;
  let tree: string;
  const absent: string[] = [];
  try {
    const git = runGit;
    tree = 'dryRun' in parsed ? '' : git(['rev-parse', 'HEAD^{tree}']).trim();
    const revision = 'dryRun' in parsed ? parsed.dryRun : 'HEAD';
    // Verify a single commit before passing an optional revision to any other git command.
    const commit =
      'dryRun' in parsed
        ? git(['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`]).trim()
        : revision;
    const parents = git(['rev-list', '--parents', '-n', '1', commit]).trim().split(/\s+/).slice(1);
    let diffed: string[] | undefined;
    const firstParentDiff = (): string[] =>
      (diffed ??= git(['diff', '--name-only', '--no-renames', '-z', `${commit}^1`, commit])
        .split('\0')
        .filter(Boolean));
    let scope: MergeTestScope;
    if ('files' in parsed) {
      // Only a merge commit says what the merge changed; any other HEAD has no such condition.
      changed = new Set(parents.length >= 2 ? firstParentDiff() : []);
      const selected = filesSteps(parsed.files, io.exists ?? ((file) => existsSync(resolve(file))));
      steps = selected.steps;
      absent.push(...selected.absent);
      line = filesScopeLine(parsed.files);
    } else {
      if ('all' in parsed && parsed.all) scope = { kind: 'all', reason: '--all' };
      else if (parents.length < 2) scope = { kind: 'all', reason: `${revision} has no second parent` };
      else {
        const files = firstParentDiff();
        scope = mergeTestScope(files);
        const roots = refineRoots(scope);
        if (roots) {
          scope = refineScope(
            scope,
            files,
            readGitTree(`${commit}^1`, roots, git),
            readGitTree(commit, roots, git),
          );
        }
      }
      // A merge never counts a run that leaves the PTY and socket integration tests out as a pass. The variable is
      // the members' own sandbox signal: the full test sandbox does not carry it (`fullTestEnv`).
      if (runsServerTests(scope) && process.env.PROJECTMAN_SKIP_PTY_TESTS === '1') {
        console.error('merge-test: server checks require PTY and Unix socket integration tests');
        return 2;
      }
      // A file the merge changed is never rerun; with no parent to compare with, none is.
      changed = parents.length >= 1 ? new Set(firstParentDiff()) : null;
      steps = mergeTestSteps(scope);
      line = scopeLine(scope);
    }
    if (shard) steps = shardSteps(steps, shard);
  } catch (error) {
    console.error(`merge-test: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  console.log(line);
  if ('dryRun' in parsed) {
    if (!shard || shard.index === 1) console.log('merge-test step: npm run dead-code');
    for (const step of steps) console.log(`merge-test step: npm ${step.args.join(' ')}`);
    return 0;
  }
  // The worker count the steps run with (it is also part of the step cache key): PM-876.
  const workers = process.env.VITEST_MAX_FORKS ?? '';
  console.log(`${MERGE_TEST_WORKERS_PREFIX}${/^[1-9][0-9]{0,5}$/.test(workers) ? workers : 'unset'}`);
  try {
    if (!shard || shard.index === 1) {
      const checked = await (io.deadCode ?? (() => runNpm(['run', 'dead-code'])))();
      if (checked.signaled || checked.code !== 0) return checked.code || 1;
    }
    for (const file of absent) console.log(`merge-test skipped (absent): ${file}`);
    return await runSteps(steps, {
      spawn: io.npm ?? runNpm,
      changed,
      tree,
      noCache,
      passedKeysFile: process.env.PROJECTMAN_MERGE_TEST_PASSED_KEYS,
      log: (text) => console.log(text),
    });
  } catch (error) {
    console.error(`merge-test: ${error instanceof Error ? error.message : String(error)}`);
    return 127;
  } finally {
    console.log(line);
  }
}
