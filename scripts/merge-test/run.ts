import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { isRepoFilePath, MERGE_TEST_WORKERS_PREFIX } from '@projectman/shared';
import { MODULES } from '../../apps/server/test/architecture/module-map';
import { serverTestImpact } from './impact';
import type { MergeTestFile } from './impact';
import { runNpm } from './npm';
import { mergeTestScope } from './scope';
import type { MergeTestScope } from './scope';
import { sharedImpact } from './shared-impact';
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

const CLOUD_TEST_FILTERS = [
  'apps/server/test/cloud-',
  'apps/server/test/deploy-',
  'apps/server/test/release-',
  'apps/server/test/architecture/',
  'apps/server/test/merge-test-',
  // The real Unix control socket boundary (PM-754): never skipped in a merge.
  'apps/server/test/control-socket.integration.test.ts',
];

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

function sharedScope(
  scope: Extract<MergeTestScope, { kind: 'workspaces' }>,
  changed: readonly string[],
  before: readonly MergeTestFile[],
  after: readonly MergeTestFile[],
): MergeTestScope {
  // Non-source shared changes need no consumer analysis, but still check every workspace's types.
  const shared = scope.sharedChanged?.length
    ? sharedImpact({ changed: scope.sharedChanged, before, after })
    : {
        exports: [],
        consumers: {
          'apps/server': [],
          'apps/web': [],
          'apps/feedback-widget': [],
          'packages/templates': [],
        },
      };
  if ('fallback' in shared) return { kind: 'all', reason: shared.fallback };
  if (shared.consumers['packages/templates'].length)
    return { kind: 'all', reason: 'shared consumer in packages/templates' };
  const workspaces = MERGE_TEST_WORKSPACES.filter(
    (ws) => scope.workspaces.includes(ws) || (ws !== 'packages/shared' && shared.consumers[ws].length > 0),
  );
  const server = workspaces.includes('apps/server')
    ? serverTestImpact({
        changed,
        seeds: shared.consumers['apps/server'],
        before: before.filter(
          (file) => file.path.startsWith('apps/server/') || file.path.startsWith('scripts/'),
        ),
        after: after.filter(
          (file) => file.path.startsWith('apps/server/') || file.path.startsWith('scripts/'),
        ),
        modules: MODULES,
      })
    : undefined;
  return {
    kind: 'shared',
    exports: shared.exports,
    workspaces,
    ...(server?.fallback ? { fallback: server.fallback } : server ? { tests: server.tests } : {}),
  };
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
    const git = (args: string[]): string => {
      const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(result.stderr.trim() || 'git failed');
      return result.stdout;
    };
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
        if (
          scope.kind === 'workspaces' &&
          (scope.sharedChanged !== undefined || scope.workspaces.includes('apps/server'))
        ) {
          const roots =
            scope.sharedChanged === undefined
              ? ['apps/server', 'scripts']
              : [...MERGE_TEST_WORKSPACES, 'scripts'];
          const readTree = (revision: string): MergeTestFile[] => {
            const entries = git(['ls-tree', '-r', '-z', revision, '--', ...roots])
              .split('\0')
              .filter(Boolean)
              .map((entry) => {
                const tab = entry.indexOf('\t');
                return { oid: entry.slice(0, tab).split(' ')[2]!, path: entry.slice(tab + 1) };
              });
            const result = spawnSync('git', ['cat-file', '--batch'], {
              input: entries.map((entry) => entry.oid).join('\n') + '\n',
              maxBuffer: 64 * 1024 * 1024,
            });
            if (result.error) throw result.error;
            if (result.status !== 0) throw new Error('git cat-file failed');
            let offset = 0;
            return entries.map(({ path }) => {
              const end = result.stdout.indexOf(10, offset);
              const header = result.stdout.subarray(offset, end).toString('utf8').split(' ');
              const size = Number(header[2]);
              if (
                end < 0 ||
                header[1] !== 'blob' ||
                !Number.isSafeInteger(size) ||
                size < 0 ||
                end + size + 1 >= result.stdout.length
              )
                throw new Error('invalid git blob response');
              const source = result.stdout.subarray(end + 1, end + 1 + size).toString('utf8');
              offset = end + size + 2;
              return { path, source };
            });
          };
          const before = readTree(`${commit}^1`);
          const after = readTree(commit);
          if (scope.sharedChanged !== undefined) {
            scope = sharedScope(scope, files, before, after);
          } else {
            const impact = serverTestImpact({ changed: files, before, after, modules: MODULES });
            scope = impact.fallback
              ? { ...scope, fallback: impact.fallback }
              : {
                  kind: 'modules',
                  modules: impact.modules,
                  tests: impact.tests,
                  workspaces: scope.workspaces.filter((ws) => ws !== 'apps/server'),
                };
          }
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
