import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { describe, expect, test } from 'vitest';

/**
 * `docs/EFFECT.md` ("Where Effect is allowed") lists the files that may import `effect`. This test
 * keeps the code and that list the same: a file outside the list that imports it fails, and so
 * does a listed file that no longer does.
 */

/**
 * Files that import `effect` without an item in `docs/EFFECT.md`, each with a one-line reason.
 * Empty today. An entry is a debt, not a permission: it fails once the file stops importing
 * `effect`, so remove it then.
 */
const KNOWN_DEVIATIONS: Record<string, string> = {};

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const SCANNED_ROOTS = ['apps/server/src', 'apps/web/src', ...packageSourceRoots()];

function packageSourceRoots(): string[] {
  return readdirSync(join(repoRoot, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}/src`);
}

const SOURCE_LOADERS: Record<string, 'ts' | 'tsx'> = { '.ts': 'ts', '.tsx': 'tsx' };

function isProductionSource(name: string): boolean {
  return extname(name) in SOURCE_LOADERS && !/\.(?:test|d)\.tsx?$/.test(name);
}

function sourceFiles(folder: string): string[] {
  return readdirSync(join(repoRoot, folder), { withFileTypes: true }).flatMap((entry) => {
    const path = `${folder}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path);
    return entry.isFile() && isProductionSource(entry.name) ? [path] : [];
  });
}

const isEffectPackage = (path: string) =>
  path === 'effect' || path.startsWith('effect/') || path.startsWith('@effect/');

/** True when the source loads `effect` (static, dynamic or require); type-only imports are erased. */
function importsEffect(source: string, loader: 'ts' | 'tsx' = 'ts'): boolean {
  const result = buildSync({
    stdin: { contents: source, loader },
    write: false,
    bundle: false,
    metafile: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
    tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
  });
  return Object.values(result.metafile!.outputs).some((output) =>
    output.imports.some((entry) => isEffectPackage(entry.path)),
  );
}

interface EffectList {
  /** Every path the list names: an importer may be any of them. */
  allowed: Set<string>;
  /** The `File:`/`Files:` paths: each must still import `effect`. */
  files: Set<string>;
}

function repoPath(listed: string): string {
  return /^(?:apps|packages|scripts)\//.test(listed) ? listed : `apps/server/src/${listed}`;
}

/** Reads the backticked `.ts` paths of the `File:`/`Facade:` text in the "Where Effect is allowed" items. */
function parseEffectList(markdown: string): EffectList {
  const start = markdown.indexOf('## Where Effect is allowed');
  if (start < 0) throw new Error('docs/EFFECT.md has no "## Where Effect is allowed" section');
  const rest = markdown.slice(start);
  const next = rest.search(/\n## /);
  const section = next < 0 ? rest : rest.slice(0, next);
  const allowed = new Set<string>();
  const files = new Set<string>();
  for (const item of section.split(/\n(?=- \*\*)/).slice(1)) {
    const text = item.replace(/\s+/g, ' ');
    const labels = [...text.matchAll(/\b(Files?|Facades?):/g)];
    labels.forEach((label, index) => {
      const segment = text.slice(label.index, labels[index + 1]?.index ?? text.length);
      for (const token of segment.matchAll(/([^`]{0,12})`([^`]+)`/g)) {
        const path = token[2]!;
        // A barrel that only re-exports the facade ("exported by `x/index.ts`") imports no effect.
        if (!path.includes('/') || !path.endsWith('.ts') || /exported by\s*$/.test(token[1]!)) {
          continue;
        }
        allowed.add(repoPath(path));
        if (label[1]!.startsWith('File')) files.add(repoPath(path));
      }
    });
  }
  return { allowed, files };
}

/** The problems between the files that import `effect`, the list and `KNOWN_DEVIATIONS`. */
function listProblems(
  importers: readonly string[],
  list: EffectList,
  deviations: Record<string, string>,
): string[] {
  const problems: string[] = [];
  for (const file of importers) {
    if (list.allowed.has(file) || file in deviations) continue;
    problems.push(
      `${file} imports effect but docs/EFFECT.md does not list it. Add an item there with this ` +
        `card's key (File:/Facade: lines), or remove the import.`,
    );
  }
  for (const file of Object.keys(deviations)) {
    if (!importers.includes(file)) {
      problems.push(`KNOWN_DEVIATIONS lists ${file} but it no longer imports effect: remove the entry.`);
    } else if (list.allowed.has(file)) {
      problems.push(`KNOWN_DEVIATIONS lists ${file} but docs/EFFECT.md lists it too: remove the entry.`);
    }
  }
  for (const file of list.files) {
    if (!importers.includes(file)) {
      problems.push(
        `docs/EFFECT.md lists ${file} under File: but it does not import effect: fix or remove the item.`,
      );
    }
  }
  return problems;
}

describe('effect allowlist (docs/EFFECT.md)', () => {
  test('only the listed files import effect', () => {
    const importers = SCANNED_ROOTS.flatMap(sourceFiles).filter((file) => {
      const source = readFileSync(join(repoRoot, file), 'utf8');
      return source.includes('effect') && importsEffect(source, SOURCE_LOADERS[extname(file)]);
    });
    const list = parseEffectList(readFileSync(join(repoRoot, 'docs/EFFECT.md'), 'utf8'));
    expect(importers.length).toBeGreaterThan(0);
    const problems = listProblems(importers, list, KNOWN_DEVIATIONS);
    expect(problems, problems.join('\n')).toEqual([]);
  });

  describe('the check itself', () => {
    const list = parseEffectList(
      [
        '# Effect',
        '## Where Effect is allowed',
        '- **a queue**',
        '  File: `apps/server/src/a/queue.ts`. Facade: `Q` (`a/q.ts`, exported by `a/index.ts`).',
        '- **b**',
        '  Files: `b/one.ts` (facade: `One`) and',
        '  `b/two.ts`. Facades: `Two` (`b/facade.ts`).',
        '## Version and bans',
        '  File: `c/outside.ts`.',
      ].join('\n'),
    );

    test('reads the File and Facade paths of the section, relative to apps/server/src', () => {
      expect([...list.allowed].sort()).toEqual([
        'apps/server/src/a/q.ts',
        'apps/server/src/a/queue.ts',
        'apps/server/src/b/facade.ts',
        'apps/server/src/b/one.ts',
        'apps/server/src/b/two.ts',
      ]);
      expect([...list.files].sort()).toEqual([
        'apps/server/src/a/queue.ts',
        'apps/server/src/b/one.ts',
        'apps/server/src/b/two.ts',
      ]);
    });

    test('fails for a file outside the list that imports effect', () => {
      const problems = listProblems(['apps/server/src/x/new.ts', ...list.files], list, {});
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('apps/server/src/x/new.ts');
    });

    test('fails for a listed File that no longer imports effect', () => {
      const importers = [...list.files].filter((file) => !file.endsWith('one.ts'));
      expect(listProblems(importers, list, {})).toEqual([
        expect.stringContaining('apps/server/src/b/one.ts'),
      ]);
    });

    test('accepts a known deviation and fails for a stale one', () => {
      const importers = [...list.files, 'apps/server/src/x/old.ts'];
      const deviations = { 'apps/server/src/x/old.ts': 'predates the list' };
      expect(listProblems(importers, list, deviations)).toEqual([]);
      expect(listProblems([...list.files], list, deviations)).toEqual([
        expect.stringContaining('apps/server/src/x/old.ts'),
      ]);
    });
  });

  describe('importsEffect', () => {
    test.each([
      "import { Effect } from 'effect';",
      "import * as Duration from 'effect/Duration';",
      "import { x } from '@effect/platform';",
      "export { Effect } from 'effect';",
      "const load = () => import('effect');",
    ])('detects %s', (source) => {
      expect(importsEffect(source)).toBe(true);
    });

    test('ignores type imports, comments, strings and other packages', () => {
      expect(
        importsEffect(`
          import type { Effect } from 'effect';
          import { effectful } from './effect-helpers';
          // import { Effect } from 'effect';
          const example = "import { Effect } from 'effect'";
        `),
      ).toBe(false);
    });
  });
});
