import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sharedImpact } from '../../../scripts/merge-test/shared-impact';
import { isServerTest, serverTestImpact } from '../../../scripts/merge-test/impact';
import type { MergeTestFile } from '../../../scripts/merge-test/impact';
import { MODULES } from './architecture/module-map';

const shared = (path: string, source: string): MergeTestFile => ({
  path: `packages/shared/src/${path}`,
  source,
});
const consumer = (path: string, source: string): MergeTestFile => ({ path, source });
const tree = [
  shared('index.ts', "export * from './a';\nexport * from './b';"),
  shared('a.ts', 'export const A = 1;\nexport type A = number;'),
  shared('b.ts', 'export const B = 2;'),
  consumer('apps/server/src/a.ts', "import { A as Local } from '@projectman/shared';"),
  consumer('apps/web/src/b.ts', "import type { B } from '@projectman/shared';"),
  consumer('apps/feedback-widget/src/a.ts', "export { type A } from '@projectman/shared';"),
];
const impact = (before = tree, after = before, changed = ['packages/shared/src/a.ts']) =>
  sharedImpact({ changed, before, after });

describe('shared export impact', () => {
  it('selects only consumers of the changed leaf, including type imports and aliases', () => {
    expect(impact()).toEqual({
      exports: ['A'],
      consumers: {
        'apps/server': ['apps/server/src/a.ts'],
        'apps/web': [],
        'apps/feedback-widget': ['apps/feedback-widget/src/a.ts'],
        'packages/templates': [],
      },
    });
  });
  it('assigns script consumers from both revisions to the server test workspace', () => {
    const before = [
      ...tree,
      consumer('scripts/live/install.ts', "import { A } from '@projectman/shared';"),
      consumer('scripts/projectman/events.ts', "import { B } from '@projectman/shared';"),
    ];
    const after = [
      ...tree,
      consumer('scripts/engine-app/package.ts', "export { A } from '@projectman/shared';"),
    ];
    expect(impact(before, after)).toMatchObject({
      exports: ['A'],
      consumers: {
        'apps/server': ['apps/server/src/a.ts', 'scripts/engine-app/package.ts', 'scripts/live/install.ts'],
      },
    });
  });
  it('follows transitive dependencies in both revisions, including cycles and deleted consumers', () => {
    const before = [...tree, shared('internal.ts', "import './a';\nexport const internal = 1;")].map((f) =>
      f.path.endsWith('/a.ts') && f.path.startsWith('packages/')
        ? { ...f, source: "import './internal';\nexport const A = 1;" }
        : f,
    );
    const after = tree;
    const result = impact(before, after, ['packages/shared/src/internal.ts']);
    expect(result).toMatchObject({ exports: ['A'], consumers: { 'apps/server': ['apps/server/src/a.ts'] } });
  });
  it('includes added, removed and moved definitions even when their old consumers disappear', () => {
    const before = tree;
    const after = [
      shared('index.ts', "export * from './moved';\nexport * from './b';"),
      shared('moved.ts', 'export const A = 1;\nexport const Added = 2;'),
      shared('b.ts', 'export const Other = 1;'),
    ];
    expect(impact(before, after, [])).toMatchObject({ exports: ['A', 'Added', 'B', 'Other'] });
  });
  it('resolves named and recursive star re-exports and local aliases', () => {
    const files = [
      shared('index.ts', "export type { Public } from './middle';"),
      shared('middle.ts', "export { Local as Public } from './leaf';"),
      shared('leaf.ts', 'const privateName = 1;\nexport { privateName as Local };'),
      consumer('apps/web/src/a.ts', "import { type Public as Alias } from '@projectman/shared';"),
    ];
    expect(impact(files, files, ['packages/shared/src/leaf.ts'])).toMatchObject({
      exports: ['Public'],
      consumers: { 'apps/web': ['apps/web/src/a.ts'] },
    });
  });
  it('keeps consumers when a forwarding file or the public barrel changes', () => {
    const files = [
      shared('index.ts', "export * from './forward';\nexport * from './b';"),
      shared('forward.ts', "export { A } from './a';"),
      shared('a.ts', 'export const A = 1;'),
      shared('b.ts', 'export const B = 2;'),
    ];
    expect(impact(files, files, ['packages/shared/src/forward.ts'])).toMatchObject({ exports: ['A'] });
    expect(impact(files, files, ['packages/shared/src/index.ts'])).toMatchObject({ exports: ['A', 'B'] });
  });
  it.each([
    'export declare const Value: number;',
    'export async function Value() {}',
    'export function* Value() {}',
    'export abstract class Value {}',
    'export interface Value {}',
    'export type Value = number;',
    'export enum Value {}',
    'export let Value = 1;',
    'export var Value = 1;',
  ])('recognizes declaration %s', (source) => {
    const files = [shared('index.ts', "export * from './a';"), shared('a.ts', source)];
    expect(impact(files)).toMatchObject({ exports: ['Value'] });
  });
  it.each([
    'export default 1;',
    'export = value;',
    "export * as values from './b';",
    "export type * from './b';",
    'export const { value } = object;',
    'export const [value] = array;',
    'export import value = other;',
    'export namespace value {}',
    'export const A = 1; export const Hidden = 2;',
    'export const A = 1, Hidden = 2;',
    'export declare const A: number, Hidden: number;',
    'export let A = x < y, Hidden = z > 1;',
    'export let A = x < y, Hidden;',
  ])('falls back for an unsupported export: %s', (source) => {
    const files = tree.map((f) => (f.path === 'packages/shared/src/a.ts' ? { ...f, source } : f));
    expect(impact(files)).toHaveProperty('fallback');
  });
  it.each([
    "import './a';\nexport * from './a';",
    'export const A = 1;',
    "export * from './a';\nconsole.log('side effect');",
    "export * from 'external';",
  ])('falls back for a non-barrel statement: %s', (source) => {
    expect(impact(tree.map((f) => (f.path.endsWith('/index.ts') ? { ...f, source } : f)))).toHaveProperty(
      'fallback',
    );
  });
  it.each([
    ['duplicate shared export', 'export const A = 2;'],
    ['uncertain shared import', 'import(variable);\nexport const B = 2;'],
    ['outside src', "import '../outside';\nexport const B = 2;"],
    ['unresolved shared import', "import './missing';\nexport const B = 2;"],
  ])('falls back for %s in either revision', (reason, source) => {
    const unsafe = tree.map((f) => (f.path === 'packages/shared/src/b.ts' ? { ...f, source } : f));
    expect(impact(tree, unsafe)).toMatchObject({ fallback: expect.stringContaining(reason) });
    expect(impact(unsafe, tree)).toMatchObject({ fallback: expect.stringContaining(reason) });
  });
  it.each([
    "import * as Shared from '@projectman/shared';",
    "import '@projectman/shared';",
    "import('@projectman/shared');",
    "import Default, { B } from '@projectman/shared';",
    "import { B } from '@projectman/shared'; import(variable);",
  ])('keeps an uncertain consumer: %s', (source) => {
    expect(impact([...tree, consumer('apps/web/src/consumer.ts', source)])).toMatchObject({
      consumers: { 'apps/web': ['apps/web/src/consumer.ts'] },
    });
  });
  it('does not mistake named-import examples for a real namespace import', () => {
    const source =
      'const text = "import { B } from \'@projectman/shared\';";\n' +
      "import * as Shared from '@projectman/shared';";
    expect(impact([...tree, consumer('apps/web/src/example.ts', source)])).toMatchObject({
      consumers: { 'apps/web': ['apps/web/src/example.ts'] },
    });
  });
  it('ignores comments, strings and external shared dependencies', () => {
    const files = tree.map((f) =>
      f.path === 'packages/shared/src/a.ts'
        ? {
            ...f,
            source:
              "import { z } from 'zod';\n// export default 1;\n/* export = 1; */\n" +
              'const text = `\nexport default 1;`;\nexport const A = "https://example.test";',
          }
        : f,
    );
    expect(impact(files)).toMatchObject({ exports: ['A'] });
  });
  it('ignores import and export words in regular expression literals', () => {
    const files = tree.map((f) =>
      f.path === 'packages/shared/src/a.ts'
        ? { ...f, source: 'export const A = /(?:import|export)[\\w-]*/;' }
        : f,
    );
    expect(impact(files)).toMatchObject({ exports: ['A'] });
  });
  it('preserves real imports after a division operator', () => {
    const files = tree.map((f) =>
      f.path === 'packages/shared/src/a.ts'
        ? { ...f, source: 'export const A = value / import(variable) / 2;' }
        : f,
    );
    expect(impact(files)).toMatchObject({ fallback: expect.stringContaining('uncertain shared import') });
  });
  it('falls back for shared subpath imports, including in a previous revision', () => {
    const before = [...tree, consumer('apps/web/src/a.mjs', "import '@projectman/shared/internal';")];
    expect(impact(before, tree)).toMatchObject({ fallback: expect.stringContaining('shared subpath') });
  });
  it('catches malformed inputs rather than throwing', () => {
    const file = {
      path: 'packages/shared/src/index.ts',
      get source(): string {
        throw new Error('broken blob');
      },
    };
    expect(impact([file])).toEqual({ fallback: 'broken blob' });
  });
  it('selects fewer than all server tests for a small leaf in the real HEAD tree', () => {
    const cwd = fileURLToPath(new URL('../../..', import.meta.url));
    const listing = execFileSync(
      'git',
      ['ls-tree', '-r', '-z', 'HEAD', '--', 'packages', 'apps', 'scripts'],
      {
        cwd,
        encoding: 'utf8',
      },
    );
    const entries = listing
      .split('\0')
      .filter(Boolean)
      .map((entry) => {
        const [header, path] = entry.split('\t');
        return { oid: header!.split(' ')[2]!, path: path! };
      })
      .filter(({ path }) => /\.[cm]?[jt]sx?$/.test(path));
    const batch = execFileSync('git', ['cat-file', '--batch'], {
      cwd,
      input: entries.map(({ oid }) => oid).join('\n') + '\n',
      maxBuffer: 64 * 1024 * 1024,
    });
    let offset = 0;
    const files = entries.map(({ path }) => {
      const end = batch.indexOf(10, offset);
      const size = Number(batch.subarray(offset, end).toString().split(' ')[2]);
      const source = batch.subarray(end + 1, end + 1 + size).toString('utf8');
      offset = end + size + 2;
      return { path, source };
    });
    const result = sharedImpact({
      changed: ['packages/shared/src/domain/email-mask.ts'],
      before: files,
      after: files,
    });
    expect(result).not.toHaveProperty('fallback');
    if ('fallback' in result) return;
    expect(result.exports).toContain('maskEmail');
    const server = files.filter((f) => f.path.startsWith('apps/server/'));
    const selected = serverTestImpact({
      changed: [],
      seeds: result.consumers['apps/server'],
      before: server,
      after: server,
      modules: MODULES,
    });
    expect(selected.fallback).toBeUndefined();
    expect(selected.tests.length).toBeGreaterThan(0);
    expect(selected.tests.length).toBeLessThan(server.filter((f) => isServerTest(f.path)).length);
    for (const [changed, scripts, tests] of [
      [
        'packages/shared/src/domain/release.ts',
        ['scripts/engine-app/package.ts'],
        ['apps/server/test/engine-app-package.test.ts'],
      ],
      [
        'packages/shared/src/domain/project-change.ts',
        ['scripts/projectman/events.ts'],
        ['apps/server/test/projectman-events.test.ts'],
      ],
    ] as const) {
      const changedImpact = sharedImpact({ changed: [changed], before: files, after: files });
      expect(changedImpact).not.toHaveProperty('fallback');
      if ('fallback' in changedImpact) continue;
      expect(changedImpact.consumers['apps/server']).toEqual(expect.arrayContaining([...scripts]));
      const scriptTests = serverTestImpact({
        changed: [],
        seeds: changedImpact.consumers['apps/server'],
        before: server,
        after: server,
        modules: MODULES,
      });
      expect(scriptTests.fallback).toBeUndefined();
      expect(scriptTests.tests).toEqual(expect.arrayContaining([...tests]));
    }
  });
});
