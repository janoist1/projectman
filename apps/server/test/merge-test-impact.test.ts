import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { serverTestImpact } from '../../../scripts/merge-test/impact';
import type { MergeTestFile } from '../../../scripts/merge-test/impact';
import type { ModuleEntry } from './architecture/module-map';
import { MODULES } from './architecture/module-map';

const modules: ModuleEntry[] = ['a', 'b', 'c', 'd'].map((id) => ({
  id,
  layer: 'core',
  target: id,
  paths: [`${id}/`],
  sealed: true,
  pass: 'none',
}));
const file = (path: string, source = ''): MergeTestFile => ({ path: `apps/server/${path}`, source });
const tree = [
  file('src/a/index.ts'),
  file('src/b/index.ts', "import type { A } from '../a';"),
  file('src/c/index.ts', "export { B } from '../b';"),
  file('src/d/index.ts'),
  ...['a', 'b', 'c', 'd'].map((id) => file(`src/${id}/index.test.ts`, "import './index';")),
  file('test/helpers/a.ts', "import '../../src/a';"),
  file('test/external.test.ts', "import './helpers/a';"),
  file('test/independent.test.ts', "import '../src/d';"),
  file('test/uncertain.test.ts', 'import(variable);'),
  file('test/architecture/dependencies.test.ts'),
  file('test/golden-path-example.test.ts', "import '../src/d';"),
  file('src/d/session.integration.test.ts', "import './index';"),
];
const impact = (changed = ['apps/server/src/a/index.ts'], before = tree, after = tree) =>
  serverTestImpact({ changed, before, after, modules });

describe('server test impact', () => {
  it('can select modules from the repository source tree without a permanent fallback', () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    function sources(folder: string): MergeTestFile[] {
      return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
        const path = join(folder, entry.name);
        if (entry.isDirectory()) return sources(path);
        if (!entry.isFile() || !/\.[cm]?[jt]sx?$/.test(entry.name)) return [];
        return [
          {
            path: `apps/server/${relative(root, path).replaceAll('\\', '/')}`,
            source: readFileSync(path, 'utf8'),
          },
        ];
      });
    }
    const files = [...sources(join(root, 'src')), ...sources(join(root, 'test'))];
    const result = serverTestImpact({
      changed: ['apps/server/src/logging/index.ts'],
      before: files,
      after: files,
      modules: MODULES,
    });
    expect(result.fallback).toBeUndefined();
    expect(result.modules).toContain('logging');
    expect(result.tests.length).toBeGreaterThan(0);
    // The real Unix socket boundary of the admin channel is in every module selection (PM-754).
    expect(result.tests).toContain('apps/server/test/control-relay.integration.test.ts');
    expect(result.tests).toContain('apps/server/test/control-socket.integration.test.ts');
    for (const changed of ['apps/server/src/index.ts', 'apps/server/src/db/migrations.ts']) {
      const entryImpact = serverTestImpact({
        changed: [changed],
        before: files,
        after: files,
        modules: MODULES,
      });
      expect(entryImpact.fallback).toBeUndefined();
      expect(entryImpact.tests).toContain('apps/server/test/removed-vm-settings.test.ts');
    }
  });
  it('selects reverse transitive modules, helper consumers and the safety baseline', () => {
    const result = impact();
    expect(result.modules).toEqual(['a', 'b', 'c']);
    expect(result.fallback).toBeUndefined();
    expect(result.tests).toEqual([
      'apps/server/src/a/index.test.ts',
      'apps/server/src/b/index.test.ts',
      'apps/server/src/c/index.test.ts',
      'apps/server/src/d/session.integration.test.ts',
      'apps/server/test/architecture/dependencies.test.ts',
      'apps/server/test/external.test.ts',
      'apps/server/test/golden-path-example.test.ts',
      'apps/server/test/uncertain.test.ts',
    ]);
  });
  it('preserves old importers after deletion or rename and returns only candidate tests', () => {
    const after = tree
      .filter((f) => !f.path.includes('/a/'))
      .map((f) => (f.path.endsWith('/b/index.ts') ? { ...f, source: '' } : f))
      .filter(
        (f) => f.path !== 'apps/server/test/helpers/a.ts' && f.path !== 'apps/server/test/external.test.ts',
      );
    expect(impact(undefined, tree, after).modules).toEqual(['a', 'b', 'c']);
    expect(impact(undefined, tree, after).tests).not.toContain('apps/server/src/a/index.test.ts');
    const renamed = [...after, file('src/d/renamed.ts')];
    expect(
      impact(['apps/server/src/a/index.ts', 'apps/server/src/d/renamed.ts'], tree, renamed).modules,
    ).toEqual(['a', 'b', 'c', 'd']);
  });
  it('includes literal dynamic and import-type dependencies without reading examples in strings', () => {
    const after = tree.map((f) =>
      f.path.endsWith('/b/index.ts')
        ? {
            ...f,
            source:
              "const x = import('../a'); type A = import('../a').A; // import(unknown)\nconst text = \"import(unknown)\";",
          }
        : f,
    );
    expect(impact(undefined, after, after).modules).toEqual(['a', 'b', 'c']);
  });
  it.each([
    ['src/a/index.ts', 'import(missing)', 'nonliteral'],
    ['src/a/index.ts', "import './missing';", 'unresolved'],
    ['src/unknown.ts', '', 'unmapped'],
  ])('falls back for unsafe source %s', (path, source, reason) => {
    expect(
      impact(undefined, tree, [...tree.filter((f) => f.path !== `apps/server/${path}`), file(path, source)])
        .fallback,
    ).toContain(reason);
  });
  it.each([
    'test/helpers/a.ts',
    'test/external.test.ts',
    'src/a/index.test.ts',
    'src/a/test-fixtures/x.ts',
    'src/a/test-helpers.ts',
  ])('falls back for changed test support %s', (path) => {
    expect(impact([`apps/server/${path}`]).fallback).toContain('test, helper or fixture');
  });
  it('propagates uncertain helper dependencies and refuses empty test selection', () => {
    expect(
      impact(undefined, tree, [
        ...tree,
        file('test/helpers/d.ts', 'import(variable)'),
        file('test/helper-uncertain.test.ts', "import './helpers/d';"),
      ]).tests,
    ).toContain('apps/server/test/helper-uncertain.test.ts');
    expect(impact(undefined, [file('src/a/index.ts')], [file('src/a/index.ts')]).fallback).toBe(
      'no tests selected',
    );
  });
  it('keeps tests whose helper graph never proves a server source dependency', () => {
    const after = [
      ...tree,
      file('test/helpers/unknown.ts'),
      file('test/unknown-helper.test.ts', "import './helpers/unknown';"),
    ];
    expect(impact(undefined, tree, after).tests).toContain('apps/server/test/unknown-helper.test.ts');
  });
  it.each([
    'node:child_process',
    'child_process',
    'node:worker_threads',
    'node:module',
    'node:vm',
    'node:fs/promises',
    '@lydell/node-pty',
  ])('keeps tests reaching runtime dependencies through helpers: %s', (specifier) => {
    const after = [
      ...tree,
      file('test/helpers/runtime.ts', `import '${specifier}'; import '../../src/d';`),
      file('test/runtime.test.ts', "import './helpers/runtime';"),
    ];
    const result = impact(undefined, after, after);
    expect(result.fallback).toBeUndefined();
    expect(result.modules).not.toContain('d');
    expect(result.tests).toContain('apps/server/test/runtime.test.ts');
    expect(result.tests).not.toContain('apps/server/test/independent.test.ts');
  });
  it('keeps tests whose production dependency hides a spawned entrypoint', () => {
    const after = tree.map((f) =>
      f.path === 'apps/server/src/d/index.ts'
        ? { ...f, source: "import { spawn } from 'node:child_process'; spawn('node', ['src/index.ts']);" }
        : f,
    );
    const result = impact(undefined, after, after);
    expect(result.fallback).toBeUndefined();
    expect(result.tests).toContain('apps/server/test/independent.test.ts');
  });
  it('refuses substring collisions instead of running a different test set', () => {
    expect(
      impact(undefined, tree, [
        ...tree,
        file('src/d/nested/src/a/index.ts'),
        file('src/d/nested/src/a/index.test.ts.extra.test.ts', "import './index';"),
      ]).fallback,
    ).toBe('ambiguous Vitest file filter');
  });
});
