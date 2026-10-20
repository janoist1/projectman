import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/**
 * Which server test files may share one module graph per worker (PM-865).
 *
 * vitest loads the server's module graph again for every test file (`isolate: true`, the default),
 * which was about a third of the work of a full run (PM-849). The `pooled` project of
 * `vitest.config.ts` runs with `isolate: false`: the files of one worker share their modules, the
 * process and the globals. That is safe only for a file that leaves nothing behind, and a lexical
 * rule can see the common ways of leaving something behind. Every other file stays in the `isolated`
 * project, which behaves as before.
 */

/**
 * The tests that run real agent sessions (the fake CLIs in pseudo-terminals) need a PTY, which
 * Claude Code's sandbox forbids. `vitest.config.ts` leaves them out when `PROJECTMAN_SKIP_PTY_TESTS=1`
 * says so, and they never join the `pooled` project: a pseudo-terminal child and a shared worker
 * do not mix. The two lists below say the same thing; `isolation.test.ts` keeps them in step.
 */
export const PTY_TESTS: readonly string[] = ['**/*.integration.test.ts', 'test/golden-path-*.test.ts'];
const PTY_TEST_PATTERN = /(?:\.integration\.test\.ts$|^test\/golden-path-[^/]*\.test\.ts$)/;

/** Whether `file` (relative to apps/server, with `/`) matches one of `PTY_TESTS`. */
export function isPtyTest(file: string): boolean {
  return PTY_TEST_PATTERN.test(file);
}

/** Patterns that need a fresh module graph per file (module mocks, process-wide state). */
export const ISOLATION_REQUIRED: readonly RegExp[] = [
  // Module mocks replace a module for every importer that comes after; the next file would get the mock.
  /\bvi\.(?:mock|doMock|unmock|doUnmock|resetModules)\(/,
  // The working directory belongs to the process.
  /\bprocess\.chdir\(/,
  // A listener, an exit code or a mask set by one file is still there for the next one.
  /\bprocess\.(?:on|once|addListener|prependListener|off|removeListener|removeAllListeners)\(/,
  /\bprocess\.(?:exitCode|title)\b/,
  /\bprocess\.umask\(/,
  // process.env writes (stubEnv is allowed: `setup/unstub-after-file.ts` puts the values back).
  /\bprocess\.env(?:\.[A-Za-z_$][\w$]*|\[[^\]\n]+\])?\s*=(?!=)/,
  /\bdelete\s+process\.env\b/,
  /\bObject\.assign\(\s*process\.env\b/,
  // A global or a process property replaced by hand (stubGlobal is allowed, as above).
  /\b(?:globalThis|global)(?:\.[A-Za-z_$][\w$]*|\[[^\]\n]+\])\s*=(?!=)/,
  /\bObject\.(?:defineProperty|defineProperties|assign)\(\s*(?:globalThis|global|process)\b/,
  /\bReflect\.(?:set|defineProperty|deleteProperty)\(\s*(?:globalThis|global|process)\b/,
  // A spy on the process or a global stays installed until someone restores it.
  /\bvi\.spyOn\(\s*(?:process|globalThis|global)\b/,
];

/** The timers rule: a fake clock that no `afterEach` gives back is the next file's clock. */
const FAKE_TIMERS = /\bvi\.useFakeTimers\(/;
const TIMERS_GIVEN_BACK = /\bafterEach\([\s\S]{0,300}?\bvi\.useRealTimers\b/;

/**
 * Test files the rule misses but that leak (found by the shuffled runs of PM-865), relative to
 * apps/server, each with the reason.
 */
export const ALWAYS_ISOLATED: readonly string[] = [];

/** Whether `source` holds something that needs a fresh module graph. */
export function needsIsolation(source: string): boolean {
  if (ISOLATION_REQUIRED.some((pattern) => pattern.test(source))) return true;
  return FAKE_TIMERS.test(source) && !TIMERS_GIVEN_BACK.test(source);
}

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'coverage']);
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
/** A test-side file: its patterns count for every test that imports it. */
const TEST_SIDE = /(?:^|\/)(?:tests?|test-fixtures)\/|test-helpers|fixture/;
const IMPORT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*|\brequire\(\s*|\bvi\.(?:mock|doMock)\(\s*)['"](\.{1,2}\/[^'"]*)['"]/g;

function listFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...listFiles(path));
    else if (TEST_FILE.test(entry.name)) found.push(path);
  }
  return found;
}

function resolveImport(from: string, specifier: string): string | undefined {
  const base = resolve(dirname(from), specifier);
  const withoutJs = base.replace(/\.js$/, '');
  const candidates = [
    base,
    ...['.ts', '.mts', '.js', '.mjs'].map((extension) => `${withoutJs}${extension}`),
    ...['.ts', '.js'].map((extension) => join(base, `index${extension}`)),
  ];
  return candidates.find(
    (candidate) => SOURCE_FILE.test(candidate) && existsSync(candidate) && isFile(candidate),
  );
}

function isFile(path: string): boolean {
  return statSync(path).isFile();
}

/** Whether the test at `file` or a test-side file it imports (transitively) needs isolation. */
function filesNeedingIsolation(root: string, files: readonly string[]): Set<string> {
  const verdicts = new Map<string, boolean>();
  const sources = new Map<string, string>();
  const read = (path: string): string => {
    let source = sources.get(path);
    if (source === undefined) {
      source = readFileSync(path, 'utf8');
      sources.set(path, source);
    }
    return source;
  };
  const needs = (path: string, trail: readonly string[]): boolean => {
    const known = verdicts.get(path);
    if (known !== undefined) return known;
    if (trail.includes(path)) return false;
    const source = read(path);
    let result = needsIsolation(source);
    if (!result) {
      for (const match of source.matchAll(IMPORT_SPECIFIER)) {
        const target = resolveImport(path, match[1] ?? '');
        if (!target || !TEST_SIDE.test(relative(root, target).split('\\').join('/'))) continue;
        if (needs(target, [...trail, path])) {
          result = true;
          break;
        }
      }
    }
    // A verdict reached inside a cycle may be missing the part the cycle hid: keep only the sure ones.
    if (result || trail.length === 0) verdicts.set(path, result);
    return result;
  };
  return new Set(files.filter((path) => needs(path, [])));
}

/**
 * Test files (relative to apps/server, with `/`) that may share one module graph per worker: those
 * that are not PTY tests, not in `ALWAYS_ISOLATED`, and neither they nor the test-side files they
 * import (helpers under `test/`, `*test-helpers*`, fixtures) hold an `ISOLATION_REQUIRED` pattern.
 * Sorted, so that the vitest include list is stable.
 */
export function pooledTests(root: string): string[] {
  const all = listFiles(root).filter((path) => {
    const file = relative(root, path).split('\\').join('/');
    return !isPtyTest(file) && !ALWAYS_ISOLATED.includes(file);
  });
  const isolated = filesNeedingIsolation(root, all);
  return all
    .filter((path) => !isolated.has(path))
    .map((path) => relative(root, path).split('\\').join('/'))
    .sort();
}
