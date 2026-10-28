import { posix } from 'node:path';
import { moduleOf, sourceImports } from '../../apps/server/test/architecture/check';
import type { ModuleEntry } from '../../apps/server/test/architecture/module-map';
import { RUNTIME_ENTRIES } from './runtime-entries';

export type MergeTestFile = { path: string; source: string };
type ServerTestImpact = { modules: string[]; tests: string[]; fallback?: string };
const src = 'apps/server/src/';
const isCode = (path: string): boolean => /\.[cm]?[jt]sx?$/.test(path);
export const isRuntimeImport = (specifier: string): boolean =>
  /^(?:node:)?(?:child_process|worker_threads|vm|module)$/.test(specifier) ||
  specifier === '@lydell/node-pty';
export const isServerTest = (path: string): boolean => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path);
const isTestSupport = (path: string): boolean =>
  /\/(?:fixtures|test-fixtures|tests)\//.test(path) || /\/test-helpers\.[cm]?[jt]sx?$/.test(path);
const isProduction = (path: string): boolean =>
  path.startsWith(src) && isCode(path) && !isServerTest(path) && !isTestSupport(path);
const sorted = (values: Iterable<string>) => [...new Set(values)].sort();

export function serverTestImpact(input: {
  changed: readonly string[];
  seeds?: readonly string[];
  before: readonly MergeTestFile[];
  after: readonly MergeTestFile[];
  modules: readonly ModuleEntry[];
}): ServerTestImpact {
  const selected = new Set<string>();
  const seeded = new Set(input.seeds);
  const reverse = new Map<string, Set<string>>();
  const edges = new Map<string, Set<string>>();
  const uncertain = new Set<string>();
  const owner = (path: string) =>
    path.startsWith(src) ? moduleOf(path.slice(src.length), input.modules)?.id : undefined;
  const fail = (fallback: string): ServerTestImpact => ({ modules: sorted(selected), tests: [], fallback });
  const afterPaths = new Set(input.after.map((file) => file.path));
  for (const path of input.changed.filter((p) => p.startsWith('apps/server/') || p.startsWith('scripts/'))) {
    if (/\/(?:fixtures|test-fixtures)\//.test(path) || path.startsWith('apps/server/test/setup/'))
      return fail(`test support changed: ${path}`);
    const snapshot = /^(.*)\/__snapshots__\/([^/]+)\.snap$/.exec(path);
    if (snapshot) {
      const test = `${snapshot[1]}/${snapshot[2]}`;
      if (!isServerTest(test) || !afterPaths.has(test)) return fail(`unmapped snapshot: ${path}`);
      seeded.add(test);
    } else if (path.startsWith('apps/server/') && path.endsWith('.md')) continue;
    else if (!isCode(path)) return fail(`test support changed: ${path}`);
    else if (isProduction(path)) {
      const id = owner(path);
      if (!id) return fail(`unmapped source: ${path}`);
      selected.add(id);
    } else if (!isServerTest(path) || afterPaths.has(path)) seeded.add(path);
  }
  for (const path of seeded) {
    if (isServerTest(path)) continue;
    if (!isProduction(path)) continue;
    const id = owner(path);
    if (!id) return fail(`unmapped source: ${path}`);
    selected.add(id);
  }
  for (const tree of [input.before, input.after]) {
    const paths = new Set(tree.map((f) => f.path));
    for (const file of tree) {
      if (!isCode(file.path)) continue;
      const production = isProduction(file.path);
      const from = owner(file.path);
      if (production && !from) return fail(`unmapped source: ${file.path}`);
      const imports = sourceImports(file.source);
      if (imports.uncertain) {
        if (production) return fail(`nonliteral dependency: ${file.path}`);
        uncertain.add(file.path);
      }
      const addEdge = (target: string): void => {
        const deps = edges.get(file.path) ?? new Set<string>();
        deps.add(target);
        edges.set(file.path, deps);
        const to = owner(target);
        if (production && from && to && from !== to) {
          const dependents = reverse.get(to) ?? new Set<string>();
          dependents.add(from);
          reverse.set(to, dependents);
        }
      };
      if (Object.hasOwn(RUNTIME_ENTRIES, file.path)) {
        for (const target of RUNTIME_ENTRIES[file.path]!) {
          // A historical revision may predate an entry. Keep its callers in the baseline.
          if (!paths.has(target)) uncertain.add(file.path);
          else addEdge(target);
        }
      }
      for (const specifier of imports.specifiers) {
        if (!specifier.startsWith('.')) {
          // Audited runtime entries supply explicit edges; unknown launchers stay conservative.
          if (isRuntimeImport(specifier) && !Object.hasOwn(RUNTIME_ENTRIES, file.path))
            uncertain.add(file.path);
          // Node builtins and packages are external; aliases cannot be resolved safely.
          if (specifier.startsWith('/') || specifier.startsWith('#') || specifier.startsWith('@/')) {
            if (production) return fail(`unresolved internal import: ${file.path}: ${specifier}`);
            uncertain.add(file.path);
          }
          continue;
        }
        const base = posix.normalize(posix.join(posix.dirname(file.path), specifier));
        const stem = base.replace(/\.[cm]?js$/, '');
        const target = [
          base,
          ...['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json'].map((ext) => stem + ext),
          `${base}/index.ts`,
          `${base}/index.js`,
        ].find((p) => paths.has(p));
        if (!target) {
          if (production) return fail(`unresolved internal import: ${file.path}: ${specifier}`);
          uncertain.add(file.path);
          continue;
        }
        addEdge(target);
      }
    }
  }
  for (const id of selected) for (const dependent of reverse.get(id) ?? []) selected.add(dependent);
  function reachesSelected(path: string, visited = new Set<string>()): boolean {
    if (visited.has(path)) return false;
    visited.add(path);
    if (seeded.has(path) || uncertain.has(path) || (owner(path) && selected.has(owner(path)!))) return true;
    return [...(edges.get(path) ?? [])].some((dep) => reachesSelected(dep, visited));
  }
  function hasSourceDependency(path: string, visited = new Set<string>()): boolean {
    if (visited.has(path)) return false;
    visited.add(path);
    if (isProduction(path) || (path.startsWith('scripts/') && isCode(path) && !isServerTest(path)))
      return true;
    return [...(edges.get(path) ?? [])].some((dep) => hasSourceDependency(dep, visited));
  }
  const tests = sorted(
    input.after
      .filter((f) => f.path.startsWith('apps/server/') && isServerTest(f.path))
      .filter(
        (f) =>
          seeded.has(f.path) ||
          f.path.startsWith('apps/server/test/architecture/') ||
          f.path === 'apps/server/test/merge-test-runtime-entries.test.ts' ||
          f.path.endsWith('.integration.test.ts') ||
          /^apps\/server\/test\/golden-path-.*\.test\.ts$/.test(f.path) ||
          reachesSelected(f.path) ||
          !hasSourceDependency(f.path),
      )
      .map((f) => f.path),
  );
  if (!tests.length) return fail('no tests selected');
  // Vitest CLI filters are substrings, not exact paths. Refuse collisions.
  const matched = input.after
    .filter(
      (f) =>
        f.path.startsWith('apps/server/') &&
        isServerTest(f.path) &&
        tests.some((t) =>
          f.path
            .slice('apps/server/'.length)
            .toLowerCase()
            .includes(t.slice('apps/server/'.length).toLowerCase()),
        ),
    )
    .map((f) => f.path);
  if (matched.some((p) => !tests.includes(p))) return fail('ambiguous Vitest file filter');
  return { modules: sorted(selected), tests };
}
