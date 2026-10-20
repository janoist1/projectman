import { posix } from 'node:path';
import { sourceImports, sourceSyntax } from '../../apps/server/test/architecture/check';
import type { MergeTestFile } from './impact';

const ROOT = 'packages/shared/src/';
const CONSUMERS = ['apps/server', 'apps/web', 'apps/feedback-widget', 'packages/templates'] as const;
const CONSUMER_ROOTS = [...CONSUMERS, 'scripts'] as const;
type Consumer = (typeof CONSUMERS)[number];
export type SharedImpact =
  { fallback: string } | { exports: string[]; consumers: Record<Consumer, string[]> };
const sorted = (values: Iterable<string>) => [...new Set(values)].sort();
const SOURCE = /\.[cm]?[jt]sx?$/;
const NAME = '[$A-Z_a-z][$\\w]*';

function names(list: string): { original: string; exported: string }[] {
  return list
    .split(',')
    .filter((part) => part.trim())
    .map((part) => {
      const match = new RegExp(`^\\s*(?:type\\s+)?(${NAME})(?:\\s+as\\s+(${NAME}))?\\s*$`).exec(part);
      if (!match) throw new Error('unsupported export/import name');
      return { original: match[1]!, exported: match[2] ?? match[1]! };
    });
}

/** Multiple variable bindings need more than the first declaration's name. Refuse them. */
function checkVariable(code: string, path: string): void {
  let depth = 0;
  let typeDepth = 0;
  let initializer = false;
  for (const char of code) {
    if ('([{'.includes(char)) depth++;
    else if (')]}'.includes(char)) depth--;
    else if (depth === 0) {
      if (char === '<') typeDepth++;
      if (char === '>' && typeDepth > 0) typeDepth--;
      if (char === '=' && initializer && typeDepth > 0)
        throw new Error(`ambiguous exported variable initializer: ${path}`);
      if (char === '=') initializer = true;
      if (char === ';') break;
      if (char === ',' && typeDepth === 0) throw new Error(`multiple exported variable bindings: ${path}`);
    }
  }
  if (typeDepth !== 0) throw new Error(`ambiguous exported variable type: ${path}`);
}

function sharedTree(files: readonly MergeTestFile[]) {
  const sources = new Map(files.filter((file) => file.path.startsWith(ROOT)).map((f) => [f.path, f.source]));
  const edges = new Map<string, string[]>();
  const exportsByFile = new Map<string, Map<string, string>>();
  const routesByFile = new Map<string, Map<string, Set<string>>>();
  function target(path: string, specifier: string): string {
    if (!specifier.startsWith('.')) throw new Error(`nonrelative shared re-export: ${path}`);
    const base = posix.join(posix.dirname(path), specifier);
    if (!base.startsWith(ROOT)) throw new Error(`shared import outside src: ${path}: ${specifier}`);
    const stem = base.replace(/\.[cm]?js$/, '');
    const found = [
      base,
      ...['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json'].map((ext) => stem + ext),
      `${base}/index.ts`,
      `${base}/index.js`,
    ].find((candidate) => sources.has(candidate));
    if (!found) throw new Error(`unresolved shared import: ${path}: ${specifier}`);
    return found;
  }
  function dependencies(path: string): string[] {
    const cached = edges.get(path);
    if (cached) return cached;
    const source = sources.get(path);
    if (source === undefined) throw new Error(`missing shared source: ${path}`);
    const imports = sourceImports(source);
    if (imports.uncertain) throw new Error(`uncertain shared import: ${path}`);
    const deps = imports.specifiers.filter((s) => s.startsWith('.')).map((s) => target(path, s));
    edges.set(path, deps);
    for (const dep of deps) dependencies(dep);
    return deps;
  }
  function closure(path: string, visited = new Set<string>()): Set<string> {
    if (visited.has(path)) return visited;
    visited.add(path);
    for (const dep of dependencies(path)) closure(dep, visited);
    return visited;
  }
  function fileExports(path: string, visiting = new Set<string>()): Map<string, string> {
    const cached = exportsByFile.get(path);
    if (cached) return cached;
    if (visiting.has(path)) throw new Error(`cyclic shared re-export: ${path}`);
    const source = sources.get(path);
    if (source === undefined) throw new Error(`missing shared barrel: ${path}`);
    dependencies(path);
    visiting.add(path);
    const { clean, code } = sourceSyntax(source);
    const result = new Map<string, string>();
    const routes = new Map<string, Set<string>>();
    function add(name: string, origin: string, via: Iterable<string> = []) {
      const previous = result.get(name);
      if (previous && previous !== origin) throw new Error(`duplicate shared export: ${name}`);
      result.set(name, origin);
      const route = routes.get(name) ?? new Set<string>();
      route.add(path);
      for (const step of via) route.add(step);
      routes.set(name, route);
    }
    const pattern = /^[\t ]*export\b/gm;
    let processed = 0;
    let barrelEnd = 0;
    for (const match of code.matchAll(pattern)) {
      const start = match.index;
      if (path === `${ROOT}index.ts` && code.slice(barrelEnd, start).trim())
        throw new Error('unsupported shared barrel statement');
      const rest = clean.slice(start);
      const reexport =
        /^\s*export\s+(?!type\s+\*)(?:type\s+)?(\*|\{[^}]*\})\s+from\s+(['"])([^'"\n]+)\2\s*;?/.exec(rest);
      if (reexport) {
        const dependency = target(path, reexport[3]!);
        const exported = fileExports(dependency, new Set(visiting));
        const via = routesByFile.get(dependency)!;
        if (reexport[1] === '*') for (const [name, origin] of exported) add(name, origin, via.get(name));
        else
          for (const { original, exported: name } of names(reexport[1]!.slice(1, -1))) {
            const origin = exported.get(original);
            if (!origin) throw new Error(`missing re-export: ${path}: ${original}`);
            add(name, origin, via.get(original));
          }
        barrelEnd = start + reexport[0].length;
      } else {
        if (path === `${ROOT}index.ts`) throw new Error('unsupported shared barrel export');
        const declaration = new RegExp(
          `^\\s*export\\s+(?:declare\\s+)?(?:async\\s+)?(function\\s*\\*?|const|let|var|class|abstract\\s+class|interface|type|enum)\\s+(${NAME})(?=\\s|[=:(<;{])`,
        ).exec(rest);
        const local = /^\s*export\s+(?:type\s+)?\{([^}]*)\}\s*;?/.exec(rest);
        if (declaration) {
          add(declaration[2]!, path);
          if (['const', 'let', 'var'].includes(declaration[1]!))
            checkVariable(code.slice(start + declaration[0].length), path);
        } else if (local) {
          for (const { exported } of names(local[1]!)) add(exported, path);
        } else throw new Error(`unsupported shared export: ${path}`);
      }
      processed++;
    }
    if (processed !== [...code.matchAll(/\bexport\b/g)].length)
      throw new Error(`unprocessed shared export: ${path}`);
    if (path === `${ROOT}index.ts` && code.slice(barrelEnd).trim())
      throw new Error('unsupported shared barrel statement');
    exportsByFile.set(path, result);
    routesByFile.set(path, routes);
    return result;
  }
  const exported = fileExports(`${ROOT}index.ts`);
  const routes = routesByFile.get(`${ROOT}index.ts`)!;
  return {
    exported,
    dependsOn: (name: string, changed: readonly string[]) => {
      const origin = exported.get(name);
      return (
        origin !== undefined &&
        changed.some((path) => closure(origin).has(path) || routes.get(name)?.has(path))
      );
    },
  };
}

/** Analyze immutable git blobs only. Anything not proven safe requests the full check. */
export function sharedImpact(input: {
  changed: readonly string[];
  before: readonly MergeTestFile[];
  after: readonly MergeTestFile[];
}): SharedImpact {
  try {
    const before = sharedTree(input.before);
    const after = sharedTree(input.after);
    const affected = new Set<string>();
    for (const name of new Set([...before.exported.keys(), ...after.exported.keys()])) {
      const old = before.exported.get(name);
      const next = after.exported.get(name);
      if (old !== next || before.dependsOn(name, input.changed) || after.dependsOn(name, input.changed))
        affected.add(name);
    }
    const consumers: Record<Consumer, string[]> = {
      'apps/server': [],
      'apps/web': [],
      'apps/feedback-widget': [],
      'packages/templates': [],
    };
    for (const file of [...input.before, ...input.after]) {
      const root = CONSUMER_ROOTS.find((path) => file.path.startsWith(`${path}/`));
      // Script behavior is covered by server tests. Their imports outside the server tree
      // remain uncertain in serverTestImpact, so those tests are kept in its safety baseline.
      const workspace = root === 'scripts' ? 'apps/server' : root;
      if (!workspace || !SOURCE.test(file.path)) continue;
      const imports = sourceImports(file.source);
      if (imports.specifiers.some((s) => s.startsWith('@projectman/shared/')))
        throw new Error(`shared subpath import: ${file.path}`);
      const count = imports.specifiers.filter((s) => s === '@projectman/shared').length;
      if (!count) {
        if (imports.uncertain) consumers[workspace].push(file.path);
        continue;
      }
      const { clean, code } = sourceSyntax(file.source);
      const named = [
        ...clean.matchAll(
          /\b(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s+from\s+(['"])@projectman\/shared\2/g,
        ),
      ].filter((match) => /^(?:import|export)\b/.test(code.slice(match.index)));
      let hit = imports.uncertain || count !== named.length;
      for (const match of named) {
        try {
          if (names(match[1]!).some(({ original }) => affected.has(original))) hit = true;
        } catch {
          hit = true;
        }
      }
      if (hit) consumers[workspace].push(file.path);
    }
    for (const ws of CONSUMERS) consumers[ws] = sorted(consumers[ws]);
    return { exports: sorted(affected), consumers };
  } catch (error) {
    return { fallback: error instanceof Error ? error.message : String(error) };
  }
}
