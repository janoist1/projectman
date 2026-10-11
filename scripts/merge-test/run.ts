import { spawnSync } from 'node:child_process';
import { constants } from 'node:os';
import { mergeTestScope } from './scope';
import type { MergeTestScope } from './scope';

export function scopeLine(scope: MergeTestScope): string {
  return `merge-test scope: ${scope.kind}${scope.kind === 'all' ? ` (${scope.reason})` : scope.kind === 'workspaces' ? ` (${scope.workspaces.join(', ')})` : ''}`;
}

export function mergeTestCommands(scope: MergeTestScope): string[][] {
  if (scope.kind === 'none') return [];
  if (scope.kind === 'all') return [['run', 'typecheck'], ['test']];
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
      const result = spawnSync('git', args, { encoding: 'utf8' });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(result.stderr.trim() || 'git failed');
      return result.stdout;
    };
    if (argv.includes('--all')) scope = { kind: 'all', reason: '--all' };
    else if (git(['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(/\s+/).length < 3)
      scope = { kind: 'all', reason: 'HEAD has no second parent' };
    else
      scope = mergeTestScope(
        git(['diff', '--name-only', '-z', 'HEAD^1', 'HEAD']).split('\0').filter(Boolean),
      );
  } catch (error) {
    console.error(`merge-test: ${error instanceof Error ? error.message : String(error)}`);
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
