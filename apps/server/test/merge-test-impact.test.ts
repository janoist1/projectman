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
  file('test/merge-test-runtime-entries.test.ts', "import '../src/d';"),
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
    // The real Unix control socket boundary is in every module selection (PM-754).
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
      'apps/server/test/merge-test-runtime-entries.test.ts',
      'apps/server/test/uncertain.test.ts',
    ]);
  });
  it('uses a shared-consuming production seed as a changed module', () => {
    expect(
      serverTestImpact({
        changed: [],
        seeds: ['apps/server/src/a/index.ts'],
        before: tree,
        after: tree,
        modules,
      }),
    ).toEqual(impact());
  });
  it('selects a test seed directly without selecting its production module', () => {
    const result = serverTestImpact({
      changed: [],
      seeds: ['apps/server/test/independent.test.ts'],
      before: tree,
      after: tree,
      modules,
    });
    expect(result.fallback).toBeUndefined();
    expect(result.modules).toEqual([]);
    expect(result.tests).toContain('apps/server/test/independent.test.ts');
    expect(result.tests).not.toContain('apps/server/src/d/index.test.ts');
  });
  it('follows shared-consuming helper seeds and changed tests', () => {
    const seeded = serverTestImpact({
      changed: [],
      seeds: ['apps/server/test/helpers/a.ts'],
      before: tree,
      after: tree,
      modules,
    });
    expect(seeded.fallback).toBeUndefined();
    expect(seeded.tests).toContain('apps/server/test/external.test.ts');
    expect(
      serverTestImpact({
        changed: ['apps/server/test/independent.test.ts'],
        seeds: ['apps/server/test/independent.test.ts'],
        before: tree,
        after: tree,
        modules,
      }).tests,
    ).toContain('apps/server/test/independent.test.ts');
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
    'src/a/test-fixtures/x.ts',
    'test/fixtures/fake.mjs',
    'test/setup/wait.ts',
    'test/data.json',
    'src/a/data.yaml',
  ])('falls back for changed test support %s', (path) => {
    expect(impact([`apps/server/${path}`]).fallback).toBe(`test support changed: apps/server/${path}`);
  });
  it('selects a changed test directly, ignores a deleted test and keeps other modules out', () => {
    const path = 'apps/server/test/independent.test.ts';
    const result = impact([path]);
    expect(result.fallback).toBeUndefined();
    expect(result.modules).toEqual([]);
    expect(result.tests).toContain(path);
    expect(result.tests).not.toContain('apps/server/src/d/index.test.ts');
    expect(
      impact(
        [path],
        tree,
        tree.filter((f) => f.path !== path),
      ),
    ).toEqual(
      impact(
        [],
        tree,
        tree.filter((f) => f.path !== path),
      ),
    );
  });
  it('maps snapshots to their test and refuses orphaned snapshots', () => {
    const path = 'apps/server/test/__snapshots__/independent.test.ts.snap';
    expect(impact([path]).tests).toContain('apps/server/test/independent.test.ts');
    expect(impact(['apps/server/test/__snapshots__/missing.test.ts.snap']).fallback).toBe(
      'unmapped snapshot: apps/server/test/__snapshots__/missing.test.ts.snap',
    );
  });
  it.each(['test/helpers/a.ts', 'src/a/test-helpers.ts', 'src/a/tests/helper.ts'])(
    'follows changed helper %s through both trees without selecting its module',
    (path) => {
      const before = [
        ...tree,
        file(path),
        file('test/helper-consumer.test.ts', `import '../${path}'; import '../src/d';`),
      ];
      // Remove the helper and its import: the old edge must still select the surviving test.
      const after = before
        .filter((f) => f.path !== `apps/server/${path}`)
        .map((f) =>
          f.path.endsWith('/helper-consumer.test.ts') ? { ...f, source: "import '../src/d';" } : f,
        );
      const result = impact([`apps/server/${path}`], before, after);
      expect(result.fallback).toBeUndefined();
      expect(result.modules).toEqual([]);
      expect(result.tests).toContain('apps/server/test/helper-consumer.test.ts');
      expect(result.tests).not.toContain('apps/server/src/a/index.test.ts');
    },
  );
  it('follows scripts and their server dependencies, while skipping unrelated script tests', () => {
    const after = [
      ...tree,
      { path: 'scripts/example.ts', source: "import '../apps/server/src/d';" },
      { path: 'scripts/other.ts', source: '' },
      file('test/script.test.ts', "import '../../../scripts/example';"),
      file('test/other-script.test.ts', "import '../../../scripts/other';"),
    ];
    expect(impact(['scripts/example.ts'], after, after).tests).toContain('apps/server/test/script.test.ts');
    expect(impact(['apps/server/src/d/index.ts'], after, after).tests).toContain(
      'apps/server/test/script.test.ts',
    );
    expect(impact([], after, after).tests).not.toContain('apps/server/test/script.test.ts');
    expect(impact(['scripts/example.ts'], after, after).tests).not.toContain(
      'apps/server/test/other-script.test.ts',
    );
  });
  it('ignores server markdown', () => {
    expect(impact(['apps/server/src/a/README.md', 'apps/server/test/README.md'])).toEqual(impact([]));
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
  it.each(['fs', 'node:fs', 'fs/promises', 'node:fs/promises'])(
    'does not make filesystem access uncertain: %s',
    (specifier) => {
      const after = [
        ...tree,
        file('test/helpers/fs.ts', `import '${specifier}'; import '../../src/d';`),
        file('test/fs.test.ts', "import './helpers/fs';"),
      ];
      expect(impact([], after, after).tests).not.toContain('apps/server/test/fs.test.ts');
      expect(impact(['apps/server/src/d/index.ts'], after, after).tests).toContain(
        'apps/server/test/fs.test.ts',
      );
    },
  );
  it('uses audited runtime entries as graph edges and retains missing historical entries', () => {
    const files = [
      ...tree,
      { path: 'scripts/engine/cli.ts', source: "import 'node:child_process';" },
      file('src/index.ts', "import './d';"),
      file('test/engine-cli.test.ts', "import '../../../scripts/engine/cli';"),
    ];
    const mapped = modules.map((m) => (m.id === 'd' ? { ...m, paths: [...m.paths, 'index.ts'] } : m));
    const select = (changed: string[], before = files) =>
      serverTestImpact({ changed, before, after: files, modules: mapped });
    expect(select([]).tests).not.toContain('apps/server/test/engine-cli.test.ts');
    expect(select(['apps/server/src/d/index.ts']).tests).toContain('apps/server/test/engine-cli.test.ts');
    expect(select(['apps/server/src/index.ts']).tests).toContain('apps/server/test/engine-cli.test.ts');
    expect(
      select(
        [],
        files.filter((f) => f.path !== 'apps/server/src/index.ts'),
      ).tests,
    ).toContain('apps/server/test/engine-cli.test.ts');
  });
  it('does not make an audited package loader uncertain', () => {
    const files = [
      ...tree,
      file('src/runner/terminal.ts', "import 'node:module';"),
      file('test/terminal.test.ts', "import '../src/runner/terminal';"),
    ];
    const mapped = [...modules, { ...modules[0]!, id: 'runner', target: 'runner', paths: ['runner/'] }];
    const result = serverTestImpact({ changed: [], before: files, after: files, modules: mapped });
    expect(result.fallback).toBeUndefined();
    expect(result.tests).not.toContain('apps/server/test/terminal.test.ts');
    const unsafe = files.map((f) =>
      f.path.endsWith('/terminal.ts') ? { ...f, source: 'import(variable)' } : f,
    );
    expect(
      serverTestImpact({ changed: [], before: unsafe, after: unsafe, modules: mapped }).fallback,
    ).toContain('nonliteral dependency');
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
