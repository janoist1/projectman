import { describe, expect, it } from 'vitest';
import { mergeTestScope } from '../../../scripts/merge-test/scope';
import { mergeTestSteps, scopeLine } from '../../../scripts/merge-test/run';
import type { MergeTestScope } from '../../../scripts/merge-test/scope';

const mergeTestCommands = (scope: MergeTestScope) => mergeTestSteps(scope).map((step) => step.args);

describe('merge test scope', () => {
  it('ignores documentation and root markdown', () => {
    expect(mergeTestScope([])).toEqual({ kind: 'none' });
    expect(mergeTestScope(['docs/design/a.ts', 'CLAUDE.md'])).toEqual({ kind: 'none' });
  });
  it.each([
    'packages/templates/src/x.ts',
    'apps/feedback-widget/src/a.ts',
    'packages/shared/package.json',
    'packages/shared/src/vitest.config.ts',
    'scripts/a.sh',
    'scripts/readme.md',
    'scripts/merge-test/impact.ts',
    'scripts/full-test/cli.ts',
    'package-lock.json',
    'unknown/file',
    'apps/server/package.json',
    'apps/web/tsconfig.app.json',
    'apps/server/vitest.config.ts',
    'apps/server/test/architecture/modules/core-base.ts',
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
  it.each([
    'apps/server/src/contracts/tasks.ts',
    'apps/server/src/config/migrations.ts',
    'scripts/live/config-check.ts',
    'scripts/example.cjs',
    'scripts/example.mtsx',
  ])('uses the server graph for %s', (path) => {
    expect(mergeTestScope([path])).toEqual({ kind: 'workspaces', workspaces: ['apps/server'] });
  });
  it('records shared sources and always selects its own tests', () => {
    expect(
      mergeTestScope(['packages/shared/src/a.ts', 'packages/shared/src/a.ts', 'apps/web/src/a.ts']),
    ).toEqual({
      kind: 'workspaces',
      workspaces: ['apps/web', 'packages/shared'],
      sharedChanged: ['packages/shared/src/a.ts'],
    });
    expect(mergeTestScope(['packages/shared/test/a.test.ts'])).toEqual({
      kind: 'workspaces',
      workspaces: ['packages/shared'],
      sharedChanged: [],
    });
  });
  it.each(['apps/server', 'apps/web'] as const)('selects only %s', (ws) => {
    expect(mergeTestScope([`${ws}/src/a.ts`, 'docs/a.md'])).toEqual({ kind: 'workspaces', workspaces: [ws] });
  });
  it('keeps the first full-scope reason', () => {
    expect(mergeTestScope(['scripts/a.sh', 'package.json'])).toEqual({ kind: 'all', reason: 'scripts/a.sh' });
  });
  describe('cloud infrastructure', () => {
    const cloud = { kind: 'cloud' } as const;
    it.each(['scripts/cloud/up.sh', 'deploy/aws/main.tf', 'deploy/cloud/compose.yml'])(
      'selects %s alone',
      (file) => {
        expect(mergeTestScope([file])).toEqual(cloud);
      },
    );
    it('selects all three roots together, ignoring documentation', () => {
      expect(
        mergeTestScope([
          'docs/CLOUD.md',
          'scripts/cloud/a.ts',
          'deploy/aws/b.tf',
          'deploy/cloud/c.yml',
          'README.md',
        ]),
      ).toEqual(cloud);
    });
    it.each(['cloud-engine.test.ts', 'deploy-aws.test.ts', 'release-prepare.test.ts'])(
      'allows the related test %s in either order',
      (name) => {
        const test = `apps/server/test/${name}`;
        expect(mergeTestScope(['scripts/cloud/a.ts', test])).toEqual(cloud);
        expect(mergeTestScope([test, 'scripts/cloud/a.ts'])).toEqual(cloud);
      },
    );
    it('keeps a test-only diff on the existing selection', () => {
      expect(mergeTestScope(['apps/server/test/cloud-engine.test.ts'])).toEqual({
        kind: 'workspaces',
        workspaces: ['apps/server'],
      });
    });
    it.each([
      'scripts/cloudy/a.ts',
      'scripts/cloud.ts',
      'deploy/aws-extra/a.tf',
      'deploy/cloudflare/a.yml',
      'deploy/mac/a.plist',
      'deploy/other/a.yml',
      'deploy/projectman-administration.service',
      'apps/server/test/helpers/cloud-fixture.ts',
      'apps/server/test/fixtures/cloud-fake.mjs',
      'apps/server/test/cloud-sub/a.test.ts',
      'apps/server/test/cloud-engine.ts',
      'apps/server/src/cloud/a.ts',
      'apps/web/src/a.ts',
      'packages/shared/src/a.ts',
      'package.json',
      'package-lock.json',
      'tsconfig.base.json',
      'vitest.config.ts',
      'apps/server/test/architecture/modules/core-base.ts',
      'scripts/merge-test/run.ts',
      'unknown/file',
      'deploy/aws/package.json',
      'scripts/cloud/tsconfig.json',
      'scripts/cloud/vitest.config.ts',
    ])('does not narrow when %s is also changed', (other) => {
      const first = mergeTestScope(['scripts/cloud/a.ts', other]);
      const second = mergeTestScope([other, 'scripts/cloud/a.ts']);
      expect(first.kind).not.toBe('cloud');
      expect(second.kind).not.toBe('cloud');
      if (first.kind === 'all') expect(second.kind).toBe('all');
    });
    it('does not treat the other deploy areas alone as cloud', () => {
      expect(mergeTestScope(['deploy/mac/a.plist'])).toEqual({ kind: 'all', reason: 'deploy/mac/a.plist' });
    });
    it('prints the same filter line the commands use', () => {
      const commands = mergeTestCommands(cloud);
      expect(commands[0]).toEqual(['run', 'typecheck', '-w', 'apps/server']);
      expect(commands).toHaveLength(2);
      const [npmArgs, ...filters] = [commands[1]!.slice(0, 4), ...commands[1]!.slice(4)];
      expect(npmArgs).toEqual(['test', '-w', 'apps/server', '--']);
      expect(filters.every((filter) => filter.startsWith('/'))).toBe(true);
      expect(filters.map((filter) => filter.slice(filter.indexOf('/apps/server/test/') + 1))).toEqual([
        'apps/server/test/cloud-',
        'apps/server/test/deploy-',
        'apps/server/test/release-',
        'apps/server/test/architecture',
        'apps/server/test/merge-test-',
        // The real Unix socket boundary (PM-754): the exact files, so a cloud merge cannot skip them.
        'apps/server/test/control-relay.integration.test.ts',
        'apps/server/test/control-socket.integration.test.ts',
      ]);
      expect(scopeLine(cloud)).toBe(
        'merge-test scope: cloud; workspaces: apps/server; test filters: apps/server/test/cloud-, apps/server/test/deploy-, apps/server/test/release-, apps/server/test/architecture/, apps/server/test/merge-test-, apps/server/test/control-relay.integration.test.ts, apps/server/test/control-socket.integration.test.ts; fallback: none',
      );
    });
  });
  it('builds checks in order and prints the scope', () => {
    expect(mergeTestCommands({ kind: 'none' })).toEqual([]);
    expect(mergeTestCommands({ kind: 'all', reason: '--all' })).toHaveLength(10);
    expect(mergeTestCommands({ kind: 'workspaces', workspaces: ['apps/server'] })).toEqual([
      ['run', 'typecheck', '-w', 'apps/server'],
      ['test', '-w', 'apps/server'],
    ]);
    expect(scopeLine({ kind: 'all', reason: 'packages/shared/src/x.ts' })).toBe(
      'merge-test scope: all (packages/shared/src/x.ts); modules: all; tests: all; fallback: packages/shared/src/x.ts',
    );
  });
});
