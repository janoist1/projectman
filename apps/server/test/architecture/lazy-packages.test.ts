import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { describe, expect, test } from 'vitest';

const LAZY_PACKAGES = [
  '@lydell/node-pty',
  '@xterm/headless',
  '@xterm/addon-serialize',
  '@anthropic-ai/sandbox-runtime',
  '@aws-sdk/client-sesv2',
  'sharp',
  '@huggingface/transformers',
  'sqlite-vec',
];

/** Parse TypeScript without executing it; erased type imports do not load a package. */
function forbiddenPackages(source: string): string[] {
  const result = buildSync({
    stdin: { contents: source, loader: 'ts' },
    write: false,
    bundle: false,
    metafile: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
    tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
  });
  const forbidden = new Set(
    Object.values(result.metafile!.outputs)
      .flatMap((input) => input.imports)
      .filter((entry) => entry.kind === 'import-statement' && LAZY_PACKAGES.includes(entry.path))
      .map((entry) => entry.path),
  );
  const output = result.outputFiles![0]!.text;
  const createRequire = output.match(
    /import\s*{[^}]*\bcreateRequire(?:\s+as\s+(\w+))?\s*[,}][^;]*from\s*["']node:module["']/,
  );
  const factory = createRequire?.[1] ?? 'createRequire';
  const localRequire =
    createRequire &&
    new RegExp(`\\b(?:const|let|var) require = ${factory}\\(import\\.meta\\.url\\)`).test(output);
  if (!localRequire) {
    for (const match of output.matchAll(/\brequire\(["']([^"']+)["']\)/g)) {
      if (LAZY_PACKAGES.includes(match[1]!)) forbidden.add(match[1]!);
    }
  }
  return [...forbidden];
}

const root = fileURLToPath(new URL('../../src/', import.meta.url));
function sources(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.isFile() && entry.name.endsWith('.ts') && !/\.(?:test|d)\.ts$/.test(entry.name)
      ? [path]
      : [];
  });
}

test('server packages used only on demand have no static value imports', () => {
  const violations = sources(root).flatMap((file) =>
    forbiddenPackages(readFileSync(file, 'utf8')).map((pkg) => `${relative(root, file)}: ${pkg}`),
  );
  expect(violations, violations.join('\n')).toEqual([]);
});

// The engine CLI is one short-lived node process per menu bar poll (PM-1130): a package loaded eagerly on any
// path (the kernel barrel pulls in `effect`) costs every poll. esbuild hoists external packages behind a lazy
// `import()` to the top of the bundle too, so the list below also guards the lazy paths of the CLI.
test('the engine CLI bundle loads only its light packages eagerly', () => {
  const result = buildSync({
    entryPoints: [fileURLToPath(new URL('../../../../scripts/engine/cli.ts', import.meta.url))],
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  const eager = new Set(
    Object.values(result.metafile!.outputs)
      .flatMap((output) => output.imports)
      .filter(
        (entry) => entry.kind === 'import-statement' && entry.external && !entry.path.startsWith('node:'),
      )
      .map((entry) => entry.path),
  );
  expect([...eager].sort()).toEqual(['@projectman/shared', 'execa', 'zod']);
});

describe.each(LAZY_PACKAGES)('%s import guard', (pkg) => {
  test.each([
    'import value from PKG;',
    'import * as value from PKG;',
    'import { value } from PKG;',
    'import {\n value as alias,\n} from PKG;',
    'import PKG;',
    'export { value } from PKG;',
    'export * from PKG;',
    'const value = require(PKG);',
  ])('rejects a runtime import: %s', (source) => {
    expect(forbiddenPackages(source.replace('PKG', JSON.stringify(pkg)))).toEqual([pkg]);
  });

  test('allows type imports, dynamic imports and a local createRequire', () => {
    expect(
      forbiddenPackages(`
        import { createRequire } from 'node:module';
        import type { Value } from '${pkg}';
        const require = createRequire(import.meta.url);
        const sync = () => require('${pkg}');
        const async = () => import('${pkg}');
        type Module = typeof import('${pkg}');
      `),
    ).toEqual([]);
  });

  test('ignores import examples in comments and strings', () => {
    expect(
      forbiddenPackages(`
        // import value from '${pkg}';
        /* export * from '${pkg}'; */
        const example = "import value from '${pkg}';";
      `),
    ).toEqual([]);
  });
});
