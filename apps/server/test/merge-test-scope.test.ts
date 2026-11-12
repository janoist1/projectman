import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { refineScope } from '../../../scripts/merge-test/refine';
import { CLOUD_TEST_FILTERS, mergeTestScope, OWNED_PATH_RULES } from '../../../scripts/merge-test/scope';
import { mergeTestSteps, scopeLine } from '../../../scripts/merge-test/run';
import type { MergeTestScope } from '../../../scripts/merge-test/scope';

const file = (path: string, source = '') => ({ path, source });
const mergeTestCommands = (scope: MergeTestScope) => mergeTestSteps(scope).map((step) => step.args);

describe('merge test scope', () => {
  it('ignores documentation and root markdown', () => {
    expect(mergeTestScope([])).toEqual({ kind: 'none' });
    expect(mergeTestScope(['docs/design/a.ts', 'CLAUDE.md'])).toEqual({ kind: 'none' });
  });
  it.each(['docs/HYBRID.md', 'docs/MACHINE-DEPENDENT.md', 'docs/ARCHITECTURE.md', 'docs/EFFECT.md'])(
    'runs the server tests for %s, which a test reads by path (PM-1337)',
    (doc) => {
      expect(mergeTestScope([doc, 'docs/DECISIONS.md'])).toEqual({
        kind: 'workspaces',
        workspaces: ['apps/server'],
      });
    },
  );
  it('adds the tests that read a changed document to the refined merge scope (PM-1337)', () => {
    const tree = [
      file('apps/server/src/logging/index.ts', 'export const log = 1;'),
      file('apps/server/test/history-semantic-recall.test.ts', "import '../src/logging';"),
      file('apps/server/test/other.test.ts', "import '../src/logging';"),
    ];
    const changed = ['docs/ARCHITECTURE.md'];
    const scope = refineScope(mergeTestScope(changed), changed, tree, tree);
    expect(scope).toMatchObject({ kind: 'modules' });
    expect((scope as Extract<MergeTestScope, { kind: 'modules' }>).tests).toContain(
      'apps/server/test/history-semantic-recall.test.ts',
    );
    expect((scope as Extract<MergeTestScope, { kind: 'modules' }>).tests).not.toContain(
      'apps/server/test/other.test.ts',
    );
  });
  it.each([
    'packages/templates/package.json',
    'packages/shared/package.json',
    'packages/shared/src/vitest.config.ts',
    'scripts/a.sh',
    'scripts/readme.md',
    'scripts/merge-test/package.json',
    'scripts/full-test/cli.ts',
    'package-lock.json',
    'unknown/file',
    'apps/server/package.json',
    'apps/web/tsconfig.app.json',
    'apps/server/vitest.config.ts',
    'deploy/other/a.sh',
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
  it.each(['apps/server', 'apps/web', 'apps/feedback-widget'] as const)('selects only %s', (ws) => {
    expect(mergeTestScope([`${ws}/src/a.ts`, 'docs/a.md'])).toEqual({ kind: 'workspaces', workspaces: [ws] });
  });
  it('leaves ignore and dead-code configuration to the dedicated checks', () => {
    expect(mergeTestScope(['.gitignore', 'knip.json'])).toEqual({ kind: 'none' });
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
      'deploy/projectman-other.service',
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
      expect(mergeTestScope(['deploy/mac/a.plist']).kind).toBe('owned');
      expect(mergeTestScope(['deploy/other/a.plist'])).toEqual({
        kind: 'all',
        reason: 'deploy/other/a.plist',
      });
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
        // The tests that read the deploy documents and the memory profile by path (PM-1337).
        'apps/server/test/memory-profile.test.ts',
        'apps/server/test/history-semantic-profile.test.ts',
        // The real Unix socket boundary (PM-754): the exact files, so a cloud merge cannot skip them.
        'apps/server/test/control-socket.integration.test.ts',
      ]);
      expect(scopeLine(cloud)).toBe(
        'merge-test scope: cloud; workspaces: apps/server; test filters: apps/server/test/cloud-, apps/server/test/deploy-, apps/server/test/release-, apps/server/test/architecture/, apps/server/test/merge-test-, apps/server/test/memory-profile.test.ts, apps/server/test/history-semantic-profile.test.ts, apps/server/test/control-socket.integration.test.ts; fallback: none',
      );
    });
  });
  describe('path-owned tests', () => {
    const owned = (files: string[]) => {
      const scope = mergeTestScope(files);
      if (scope.kind !== 'owned') throw new Error(`not owned: ${JSON.stringify(scope)}`);
      return scope;
    };
    it.each([
      [
        'deploy/mac/menubar/Sources/App.swift',
        'deploy-mac-workflows',
        'apps/server/test/engine-menubar.test.ts',
      ],
      [
        'deploy/mac/com.projectman.engine.plist',
        'deploy-mac-workflows',
        'apps/server/test/engine-app-package.test.ts',
      ],
      [
        '.github/workflows/merge-check.yml',
        'deploy-mac-workflows',
        'apps/server/test/merge-check-workflow.test.ts',
      ],
      ['projectman.structure.yaml', 'structure-map', 'apps/server/test/structure-api.test.ts'],
      ['apps/server/test/architecture/module-map.ts', 'structure-map', 'apps/server/test/architecture/'],
      ['scripts/merge-test/run.ts', 'merge-test-scripts', 'apps/server/test/merge-test-'],
    ])('selects the rule tests, not the whole suite, for %s', (file, rule, test) => {
      const scope = owned([file]);
      expect(scope.rules).toEqual([rule]);
      expect(scope.tests).toContain(test);
    });
    it('keeps the web, shared and widget workspaces out of a structure map change', () => {
      expect(mergeTestCommands(owned(['projectman.structure.yaml']))).toEqual([
        ['run', 'typecheck', '-w', 'apps/server'],
        expect.arrayContaining(['test', '-w', 'apps/server', '--']),
      ]);
    });
    it('joins the tests of several rules and ignores documentation', () => {
      const scope = owned(['docs/a.md', 'deploy/mac/a.plist', 'projectman.structure.yaml']);
      expect(scope.rules).toEqual(['deploy-mac-workflows', 'structure-map']);
      expect(scope.tests).toEqual(
        expect.arrayContaining([
          'apps/server/test/engine-menubar.test.ts',
          'apps/server/test/structure-api.test.ts',
        ]),
      );
      expect(new Set(scope.tests).size).toBe(scope.tests.length);
    });
    it('adds the tests that read a changed document by path', () => {
      const scope = owned(['deploy/mac/a.plist', 'docs/MACHINE-DEPENDENT.md']);
      expect(scope.tests).toContain('apps/server/test/memory-profile.test.ts');
    });
    it('also runs a changed test file of another rule', () => {
      const scope = owned(['deploy/mac/a.plist', 'apps/server/test/structure-api.test.ts']);
      expect(scope.tests).toContain('apps/server/test/structure-api.test.ts');
    });
    it.each(['apps/server/src/a.ts', 'apps/web/src/a.ts', 'package.json', 'scripts/merge-test/package.json'])(
      'does not narrow when %s is also changed',
      (other) => {
        expect(mergeTestScope(['deploy/mac/a.plist', other]).kind).not.toBe('owned');
        expect(mergeTestScope([other, 'projectman.structure.yaml']).kind).not.toBe('owned');
      },
    );
    it('prints the rules and the filters', () => {
      const scope = owned(['.github/workflows/merge-check.yml']);
      expect(scopeLine(scope)).toContain(
        'merge-test scope: owned (deploy-mac-workflows); workspaces: apps/server;',
      );
    });
    it('selects only the templates workspace for a templates change', () => {
      expect(mergeTestScope(['packages/templates/src/x.ts'])).toEqual({
        kind: 'workspaces',
        workspaces: ['packages/templates'],
      });
      expect(mergeTestScope(['packages/templates/src/x.ts', 'apps/web/src/a.ts'])).toEqual({
        kind: 'workspaces',
        workspaces: ['apps/web', 'packages/templates'],
      });
    });
    it('names every test that reads deploy/mac, .github or the structure map in a rule', () => {
      const root = fileURLToPath(new URL('../../../', import.meta.url));
      const reading = /deploy\/mac|\.github\/workflows|projectman\.structure\.yaml|STRUCTURE_MAP_PATH/;
      const fsRead = /readFileSync|readdirSync|existsSync|statSync|readFile\(/;
      const tracked = execFileSync('git', ['ls-files', 'apps/server'], { cwd: root, encoding: 'utf8' })
        .split('\n')
        .filter((path) => /\.test\.ts$/.test(path));
      const named = [...OWNED_PATH_RULES.flatMap((rule) => rule.tests), ...CLOUD_TEST_FILTERS];
      const unnamed = tracked.filter((path) => {
        const source = readFileSync(`${root}${path}`, 'utf8');
        return reading.test(source) && fsRead.test(source) && !named.some((entry) => path.startsWith(entry));
      });
      expect(unnamed, 'add the test to a rule of OWNED_PATH_RULES in scripts/merge-test/scope.ts').toEqual(
        [],
      );
    });
    it('names only tests that exist', () => {
      const root = fileURLToPath(new URL('../../../', import.meta.url));
      const tracked = execFileSync('git', ['ls-files', 'apps/server'], { cwd: root, encoding: 'utf8' }).split(
        '\n',
      );
      const stale = OWNED_PATH_RULES.flatMap((rule) =>
        rule.tests.filter((entry) => !tracked.some((path) => path.startsWith(entry))),
      );
      expect(stale).toEqual([]);
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
