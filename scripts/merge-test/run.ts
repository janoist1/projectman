import { spawnSync } from 'node:child_process';
import { constants } from 'node:os';
import { resolve } from 'node:path';
import { MODULES } from '../../apps/server/test/architecture/module-map';
import { serverTestImpact } from './impact';
import type { MergeTestFile } from './impact';
import { mergeTestScope } from './scope';
import type { MergeTestScope } from './scope';

const CLOUD_TEST_FILTERS = [
  'apps/server/test/cloud-',
  'apps/server/test/deploy-',
  'apps/server/test/release-',
  'apps/server/test/architecture/',
  'apps/server/test/merge-test-',
  // The real Unix socket boundary of the admin channel (PM-754): exact paths, never skipped in a merge.
  'apps/server/test/control-relay.integration.test.ts',
  'apps/server/test/control-socket.integration.test.ts',
];

/** Whether the scope runs the server's tests, which include the PTY and Unix socket integration tests. */
function runsServerTests(scope: MergeTestScope): boolean {
  if (scope.kind === 'all' || scope.kind === 'cloud' || scope.kind === 'modules') return true;
  return scope.kind === 'workspaces' && scope.workspaces.includes('apps/server');
}

export function scopeLine(scope: MergeTestScope): string {
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

export function mergeTestCommands(scope: MergeTestScope): string[][] {
  if (scope.kind === 'none') return [];
  if (scope.kind === 'all') return [['run', 'typecheck'], ['test']];
  if (scope.kind === 'cloud')
    return [
      ['run', 'typecheck', '-w', 'apps/server'],
      ['test', '-w', 'apps/server', '--', ...CLOUD_TEST_FILTERS.map((path) => resolve(path))],
    ];
  if (scope.kind === 'modules')
    return [
      ['run', 'typecheck', '-w', 'apps/server'],
      ['test', '-w', 'apps/server', '--', ...scope.tests.map((path) => resolve(path))],
      ...scope.workspaces.flatMap((ws) => [
        ['run', 'typecheck', '-w', ws],
        ['test', '-w', ws],
      ]),
    ];
  return scope.workspaces.flatMap((ws) => [
    ['run', 'typecheck', '-w', ws],
    ['test', '-w', ws],
  ]);
}

export function runMergeTest(argv: readonly string[]): number {
  if (argv.some((arg) => arg !== '--all')) {
    console.error('usage: npm run merge-test -- [--all]');
    return 2;
  }
  let scope: MergeTestScope;
  try {
    const git = (args: string[]): string => {
      const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(result.stderr.trim() || 'git failed');
      return result.stdout;
    };
    if (argv.includes('--all')) scope = { kind: 'all', reason: '--all' };
    else if (git(['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(/\s+/).length < 3)
      scope = { kind: 'all', reason: 'HEAD has no second parent' };
    else {
      const changed = git(['diff', '--name-only', '--no-renames', '-z', 'HEAD^1', 'HEAD'])
        .split('\0')
        .filter(Boolean);
      scope = mergeTestScope(changed);
      if (scope.kind === 'workspaces' && scope.workspaces.includes('apps/server')) {
        const readTree = (revision: string): MergeTestFile[] => {
          const entries = git(['ls-tree', '-r', '-z', revision, '--', 'apps/server'])
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
        const impact = serverTestImpact({
          changed,
          before: readTree('HEAD^1'),
          after: readTree('HEAD'),
          modules: MODULES,
        });
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
  } catch (error) {
    console.error(`merge-test: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  // A merge never counts a run that leaves the PTY and socket integration tests out as a pass. The variable is the
  // members' own sandbox signal: the full test sandbox does not carry it (`fullTestEnv`).
  if (runsServerTests(scope) && process.env.PROJECTMAN_SKIP_PTY_TESTS === '1') {
    console.error('merge-test: server checks require PTY and Unix socket integration tests');
    return 2;
  }
  const line = scopeLine(scope);
  console.log(line);
  try {
    for (const args of mergeTestCommands(scope)) {
      const result = spawnSync('npm', args, { stdio: 'inherit' });
      if (result.error) {
        console.error(`merge-test: ${result.error.message}`);
        return 127;
      }
      const code = result.status ?? (result.signal ? 128 + constants.signals[result.signal] : 1);
      if (code !== 0) return code;
    }
    return 0;
  } finally {
    console.log(line);
  }
}
