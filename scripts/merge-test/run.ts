import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { isRepoFilePath } from '@projectman/shared';
import { MODULES } from '../../apps/server/test/architecture/module-map';
import { serverTestImpact } from './impact';
import type { MergeTestFile } from './impact';
import { runNpm } from './npm';
import { mergeTestScope } from './scope';
import type { MergeTestScope } from './scope';
import { sharedImpact } from './shared-impact';
import { filesSteps, MERGE_TEST_WORKSPACES, runSteps, testStep, typecheckStep, workspaceOf } from './steps';
import type { MergeTestStep, StepRun } from './steps';

const CLOUD_TEST_FILTERS = [
  'apps/server/test/cloud-',
  'apps/server/test/deploy-',
  'apps/server/test/release-',
  'apps/server/test/architecture/',
  'apps/server/test/merge-test-',
];

const USAGE = 'usage: npm run merge-test -- [--all | --files <repository path of a test file>...]';

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
        before: before.filter((file) => file.path.startsWith('apps/server/')),
        after: after.filter((file) => file.path.startsWith('apps/server/')),
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

type Parsed = { all: boolean } | { files: string[] } | { error: string };

function parseArgs(argv: readonly string[]): Parsed {
  const at = argv.indexOf('--files');
  if (at < 0) return argv.some((arg) => arg !== '--all') ? { error: USAGE } : { all: argv.length > 0 };
  const files = [...new Set(argv.slice(at + 1))];
  if (at > 0 || files.length === 0) return { error: USAGE };
  const unknown = files.find((file) => !isRepoFilePath(file) || !workspaceOf(file));
  return unknown === undefined
    ? { files }
    : { error: `merge-test: not a file of a known workspace: ${unknown}\n${USAGE}` };
}

export interface MergeTestIo {
  /** Whether a repository file exists in the checkout. */
  exists?: (file: string) => boolean;
  /** Runs `npm <args>`. */
  npm?: (args: string[]) => Promise<StepRun>;
}

export async function runMergeTest(argv: readonly string[], io: MergeTestIo = {}): Promise<number> {
  const parsed = parseArgs(argv);
  if ('error' in parsed) {
    console.error(parsed.error);
    return 2;
  }
  let steps: MergeTestStep[];
  let line: string;
  let changed: ReadonlySet<string> | null;
  const absent: string[] = [];
  try {
    const git = (args: string[]): string => {
      const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(result.stderr.trim() || 'git failed');
      return result.stdout;
    };
    const parents = git(['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(/\s+/).slice(1);
    let diffed: string[] | undefined;
    const firstParentDiff = (): string[] =>
      (diffed ??= git(['diff', '--name-only', '--no-renames', '-z', 'HEAD^1', 'HEAD'])
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
      if (parsed.all) scope = { kind: 'all', reason: '--all' };
      else if (parents.length < 2) scope = { kind: 'all', reason: 'HEAD has no second parent' };
      else {
        const files = firstParentDiff();
        scope = mergeTestScope(files);
        if (
          scope.kind === 'workspaces' &&
          (scope.sharedChanged !== undefined || scope.workspaces.includes('apps/server'))
        ) {
          const roots =
            scope.sharedChanged === undefined ? ['apps/server'] : [...MERGE_TEST_WORKSPACES, 'scripts'];
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
          const before = readTree('HEAD^1');
          const after = readTree('HEAD');
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
      // A file the merge changed is never rerun; with no parent to compare with, none is.
      changed = parents.length >= 1 ? new Set(firstParentDiff()) : null;
      steps = mergeTestSteps(scope);
      line = scopeLine(scope);
    }
  } catch (error) {
    console.error(`merge-test: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  console.log(line);
  try {
    for (const file of absent) console.log(`merge-test skipped (absent): ${file}`);
    return await runSteps(steps, {
      spawn: io.npm ?? runNpm,
      changed,
      log: (text) => console.log(text),
    });
  } catch (error) {
    console.error(`merge-test: ${error instanceof Error ? error.message : String(error)}`);
    return 127;
  } finally {
    console.log(line);
  }
}
