import { describe, expect, it } from 'vitest';
import { mergeTestScope } from '../../../scripts/merge-test/scope';
import { mergeTestCommands, scopeLine } from '../../../scripts/merge-test/run';

describe('merge test scope', () => {
  it('ignores documentation and root markdown', () => {
    expect(mergeTestScope([])).toEqual({ kind: 'none' });
    expect(mergeTestScope(['docs/design/a.ts', 'CLAUDE.md'])).toEqual({ kind: 'none' });
  });
  it.each([
    'packages/shared/src/x.ts',
    'scripts/a.ts',
    'package-lock.json',
    'unknown/file',
    'apps/server/package.json',
    'apps/web/tsconfig.app.json',
    'apps/server/vitest.config.ts',
    'apps/server/test/architecture/modules/core-base.ts',
    'apps/server/src/contracts/tasks.ts',
    'apps/server/src/config/migrations.ts',
  ])('runs everything for %s', (file) => {
    expect(mergeTestScope(['docs/a.md', 'apps/server/src/a.ts', file])).toEqual({
      kind: 'all',
      reason: file,
    });
  });
  it('selects both workspaces without duplicates in stable order', () => {
    expect(mergeTestScope(['apps/web/a.ts', 'apps/server/b.ts', 'apps/web/c.ts'])).toEqual({
      kind: 'workspaces',
      workspaces: ['apps/server', 'apps/web'],
    });
  });
  it.each(['apps/server', 'apps/web'] as const)('selects only %s', (ws) => {
    expect(mergeTestScope([`${ws}/src/a.ts`, 'docs/a.md'])).toEqual({ kind: 'workspaces', workspaces: [ws] });
  });
  it('keeps the first full-scope reason', () => {
    expect(mergeTestScope(['scripts/a.ts', 'package.json'])).toEqual({ kind: 'all', reason: 'scripts/a.ts' });
  });
  it('builds checks in order and prints the scope', () => {
    expect(mergeTestCommands({ kind: 'none' })).toEqual([]);
    expect(mergeTestCommands({ kind: 'all', reason: '--all' })).toEqual([['run', 'typecheck'], ['test']]);
    expect(mergeTestCommands({ kind: 'workspaces', workspaces: ['apps/server'] })).toEqual([
      ['run', 'typecheck', '-w', 'apps/server'],
      ['test', '-w', 'apps/server'],
    ]);
    expect(scopeLine({ kind: 'all', reason: 'packages/shared/src/x.ts' })).toBe(
      'merge-test scope: all (packages/shared/src/x.ts); modules: all; tests: all; fallback: packages/shared/src/x.ts',
    );
  });
});
