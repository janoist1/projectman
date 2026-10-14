import { posix } from 'node:path';
import { moduleOf, sourceImports } from '../../apps/server/test/architecture/check';
import type { ModuleEntry } from '../../apps/server/test/architecture/module-map';

export type MergeTestFile = { path: string; source: string };
export type ServerTestImpact = { modules: string[]; tests: string[]; fallback?: string };
const src = 'apps/server/src/';
export const isServerTest = (path: string): boolean => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path);
const isTestSupport = (path: string): boolean =>
  /\/(?:fixtures|test-fixtures)\//.test(path) || /\/test-helpers\.[cm]?[jt]sx?$/.test(path);
const sorted = (values: Iterable<string>) => [...new Set(values)].sort();

export function serverTestImpact(input: {
  changed: readonly string[];
  before: readonly MergeTestFile[];
  after: readonly MergeTestFile[];
  modules: readonly ModuleEntry[];
}): ServerTestImpact {
  const selected = new Set<string>();
  const reverse = new Map<string, Set<string>>();
  const edges = new Map<string, Set<string>>();
  const uncertain = new Set<string>();
  const owner = (path: string) =>
    path.startsWith(src) ? moduleOf(path.slice(src.length), input.modules)?.id : undefined;
  const fail = (fallback: string): ServerTestImpact => ({ modules: sorted(selected), tests: [], fallback });
  for (const path of input.changed.filter((p) => p.startsWith('apps/server/'))) {
    if (!path.startsWith(src) || isServerTest(path) || isTestSupport(path))
      return fail(`test, helper or fixture changed: ${path}`);
    const id = owner(path);
    if (!id) return fail(`unmapped source: ${path}`);
    selected.add(id);
  }
  for (const tree of [input.before, input.after]) {
    const paths = new Set(tree.map((f) => f.path));
    for (const file of tree) {
      if (!/\.[cm]?[jt]sx?$/.test(file.path)) continue;
      const production = file.path.startsWith(src) && !isServerTest(file.path) && !isTestSupport(file.path);
      const from = owner(file.path);
      if (production && !from) return fail(`unmapped source: ${file.path}`);
      const imports = sourceImports(file.source);
      if (imports.uncertain) {
        if (production) return fail(`nonliteral dependency: ${file.path}`);
        uncertain.add(file.path);
      }
      for (const specifier of imports.specifiers) {
        if (!specifier.startsWith('.')) {
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
        const deps = edges.get(file.path) ?? new Set<string>();
        deps.add(target);
        edges.set(file.path, deps);
        const to = owner(target);
        if (production && from && to && from !== to) {
          const dependents = reverse.get(to) ?? new Set<string>();
          dependents.add(from);
          reverse.set(to, dependents);
        }
      }
    }
  }
  for (const id of selected) for (const dependent of reverse.get(id) ?? []) selected.add(dependent);
  function reachesSelected(path: string, visited = new Set<string>()): boolean {
    if (visited.has(path)) return false;
    visited.add(path);
    if (uncertain.has(path) || (owner(path) && selected.has(owner(path)!))) return true;
    return [...(edges.get(path) ?? [])].some((dep) => reachesSelected(dep, visited));
  }
  function hasSourceDependency(path: string, visited = new Set<string>()): boolean {
    if (visited.has(path)) return false;
    visited.add(path);
    if (path.startsWith(src) && !isServerTest(path) && owner(path)) return true;
    return [...(edges.get(path) ?? [])].some((dep) => hasSourceDependency(dep, visited));
  }
  const tests = sorted(
    input.after
      .filter((f) => isServerTest(f.path))
      .filter(
        (f) =>
          f.path.startsWith('apps/server/test/architecture/') ||
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
