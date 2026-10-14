import { describe, expect, test } from 'vitest';
import { checkDependencies, importSpecifiers, moduleOf, sourceImports } from './check';
import type { SourceFile } from './check';
import { LAYER_RULES } from './module-map';
import type { DependencyException, ModuleEntry } from './module-map';

const core: ModuleEntry = {
  id: 'core',
  layer: 'core',
  target: 'core',
  pass: 'split',
  paths: ['core/'],
  sealed: false,
};
const service: ModuleEntry = {
  id: 'service',
  layer: 'service',
  target: 'service',
  pass: 'split',
  paths: ['service/'],
  sealed: false,
};
const exception: DependencyException = { from: 'core', to: 'service', removedBy: 'core' };
const files = (source: string): SourceFile[] => [
  { path: 'core/a.ts', source },
  { path: 'service/index.ts', source: '' },
  { path: 'service/internal.ts', source: '' },
];
const check = (source: string, exceptions: readonly DependencyException[] = [], modules = [core, service]) =>
  checkDependencies(files(source), modules, LAYER_RULES, exceptions);

describe('importSpecifiers', () => {
  test.each([
    'import(name)',
    "import('./prefix' + name)",
    'import(`./${name}`)',
    'import /* comment */ (name)',
  ])('marks dynamic expressions uncertain: %s', (source) => {
    expect(sourceImports(source)).toEqual({ specifiers: [], uncertain: true });
  });
  test('accepts literal templates and ignores ordinary method calls', () => {
    expect(
      sourceImports(
        'const value = import(`./literal`); this.themes.require(key); const url = import.meta.url;',
      ),
    ).toEqual({
      specifiers: ['./literal'],
      uncertain: false,
    });
  });
  test('reads type, multiline, re-export, side-effect and dynamic imports', () => {
    expect(
      importSpecifiers(`
      import type {
        A,
        B,
      } from './types';
      export { value } from "./value";
      export * from './all';
      import './setup';
      type M = import('./merges').Merges;
      const lazy = import("./lazy");
    `),
    ).toEqual(['./types', './value', './all', './setup', './merges', './lazy']);
  });
  test('ignores commented imports', () => {
    expect(importSpecifiers(`// import './fake';\n/* export * from './fake'; */\nimport './real';`)).toEqual([
      './real',
    ]);
  });
  test('ignores import examples in strings and unrelated from expressions', () => {
    expect(
      importSpecifiers(
        `const example = "import './fake'"; const from = './fake'; const text = \`export * from './fake'\`; import './real';`,
      ),
    ).toEqual(['./real']);
  });
});

describe('checkDependencies', () => {
  test('allows downward dependencies and imports within a module', () => {
    const input = files(`import './a';`);
    input[1] = { path: 'service/index.ts', source: `import '../core/a';` };
    expect(checkDependencies(input, [core, service], LAYER_RULES, [])).toEqual([]);
  });
  test('reports one forbidden pair with several example edges, including type imports', () => {
    const violations = check(`import type { A } from '../service';\nexport * from '../service/internal';`);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ kind: 'layer', from: 'core', to: 'service' });
    expect(violations[0]!.detail).toContain('core/a.ts → service/index.ts');
    expect(violations[0]!.detail).toContain('core/a.ts → service/internal.ts');
  });
  test('accepts an exception only for the matching forbidden direction', () => {
    expect(check(`import '../service';`, [exception])).toEqual([]);
    expect(check('', [exception])).toMatchObject([{ kind: 'stale-exception' }]);
  });
  test('rejects exceptions for allowed or same-module edges', () => {
    const input = files('');
    input[1] = { path: 'service/index.ts', source: `import '../core/a'; import './internal';` };
    const exceptions = [
      { from: 'service', to: 'core', removedBy: 'service' },
      { from: 'service', to: 'service', removedBy: 'service' },
    ];
    expect(checkDependencies(input, [core, service], LAYER_RULES, exceptions).map((v) => v.kind)).toEqual([
      'stale-exception',
      'stale-exception',
    ]);
  });
  test('enforces sealed index access even when the layer edge has an exception', () => {
    const sealed = { ...service, sealed: true };
    expect(check(`import '../service';`, [exception], [core, sealed])).toEqual([]);
    expect(
      check(`import '../service/internal'; import '../service/internal.ts';`, [exception], [core, sealed]),
    ).toMatchObject([{ kind: 'sealed' }]);
  });
  test('allows internal imports inside a sealed module', () => {
    const input = files('');
    input[1] = { path: 'service/index.ts', source: `import './internal';` };
    expect(checkDependencies(input, [core, { ...service, sealed: true }], LAYER_RULES, [])).toEqual([]);
  });
  test('reports unmapped files and paths with no source file', () => {
    expect(
      checkDependencies([{ path: 'unknown.ts', source: '' }], [core], LAYER_RULES, []).map((v) => v.kind),
    ).toEqual(['stale-path', 'unmapped-file']);
  });
  test('rejects duplicate paths and exceptions naming missing modules', () => {
    expect(
      checkDependencies(files(''), [core, service, { ...core, id: 'duplicate' }], LAYER_RULES, [
        { ...exception, to: 'missing' },
      ]).map((v) => v.kind),
    ).toEqual(['duplicate-path', 'unknown-module']);
  });
  test('uses the longest match and respects folder boundaries and exact files', () => {
    const nested = { ...service, paths: ['core/nested/'] };
    const exact = { ...service, id: 'exact', paths: ['core/nested/file.ts'] };
    expect(moduleOf('core/nested/file.ts', [core, nested, exact])).toBe(exact);
    expect(moduleOf('core/nested/other.ts', [nested, core])).toBe(nested);
    expect(moduleOf('core/nested-other.ts', [nested, core])).toBe(core);
    expect(moduleOf('core-other/file.ts', [core])).toBeNull();
    expect(moduleOf('core/nested/file.tsx', [exact])).toBeNull();
  });
  test('resolves .ts before index.ts and then exact paths, normalizing dot segments', () => {
    const input = [
      { path: 'core/a.ts', source: `import '../service/child/../index'; import '../service/exact.ts';` },
      { path: 'service/index.ts', source: '' },
      { path: 'service/index/index.ts', source: '' },
      { path: 'service/exact.ts', source: '' },
    ];
    const violations = checkDependencies(input, [core, service], LAYER_RULES, []);
    expect(violations[0]!.target).toBe('service/index.ts');
    expect(violations[0]!.detail).toContain('service/exact.ts');
    expect(violations[0]!.detail).not.toContain('service/index/index.ts');
  });
  test('ignores workspace contracts, node and npm packages, missing targets and paths outside src', () => {
    expect(
      check(`
      import type { Task } from '@projectman/shared';
      import { template } from '@projectman/templates';
      import fs from 'node:fs';
      import { z } from 'zod';
      import '../../test/helpers/harness';
      import './missing';
    `),
    ).toEqual([]);
  });
  test('reports a stale exact path even when a similarly named file exists', () => {
    expect(
      checkDependencies(
        [{ path: 'core/a.tsx', source: '' }],
        [{ ...core, paths: ['core/a.ts'] }],
        LAYER_RULES,
        [],
      ),
    ).toMatchObject([{ kind: 'stale-path' }, { kind: 'unmapped-file' }]);
  });
});
