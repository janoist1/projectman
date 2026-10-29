import { posix } from 'node:path';
import type { DependencyException, Layer, ModuleEntry } from './module-map';

export interface SourceFile {
  readonly path: string;
  readonly source: string;
}
type ViolationKind =
  | 'unmapped-file'
  | 'stale-path'
  | 'duplicate-path'
  | 'unknown-module'
  | 'layer'
  | 'sealed'
  | 'stale-exception';
interface Violation {
  readonly kind: ViolationKind;
  readonly from?: string;
  readonly to?: string;
  readonly file?: string;
  readonly target?: string;
  readonly detail: string;
}

export function importSpecifiers(source: string): string[] {
  return sourceImports(source).specifiers;
}

// Only proven expression starts admit a regex literal; a slash after an identifier or a
// closing delimiter stays visible. In particular, a division must never hide an import.
const SOURCE_TRIVIA =
  /\/\/[^\n]*|\/\*[\s\S]*?\*\/|(?<=(?:^|[(,=:[!&|?;{]|(?:^|[;{}])\s*return)\s*)\/(?![*/])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+\/[a-z]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g;

/** Preserve offsets while removing trivia; `code` also masks ordinary string literals. */
export function sourceSyntax(source: string): { clean: string; code: string } {
  const blank = (text: string) => text.replace(/[^\r\n]/g, ' ');
  return {
    clean: source.replace(SOURCE_TRIVIA, (token) => (token.startsWith('/') ? blank(token) : token)),
    code: source.replace(SOURCE_TRIVIA, blank),
  };
}

/** Parse dependencies without evaluating either revision's code. */
export function sourceImports(source: string): { specifiers: string[]; uncertain: boolean } {
  // Consume comments and ordinary strings so examples cannot become edges.
  // A dynamic literal prefix followed by an expression is still uncertain.
  const pattern = new RegExp(
    SOURCE_TRIVIA.source +
      /|\bimport\s*\(\s*(['"`])([^'"`\n]*)\1\s*\)|\b(?:import\s*|(?:import|export)\s+[^;'"`]*?\bfrom\s*)(['"])([^'"\n]+)\3|\bimport\s*\.\s*meta\b|\b(import)\b/
        .source,
    'g',
  );
  const specifiers: string[] = [];
  let uncertain = false;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[2] ?? match[4];
    if (match[5] || (specifier !== undefined && (specifier.includes('\\') || specifier.includes('${'))))
      uncertain = true;
    else if (specifier !== undefined) specifiers.push(specifier);
    else if (match[0].startsWith('`') && match[0].includes('${') && /\bimport\s*\(/.test(match[0]))
      uncertain = true;
  }
  return { specifiers, uncertain };
}

function matches(path: string, pattern: string): boolean {
  return pattern.endsWith('/') ? path.startsWith(pattern) : path === pattern;
}

export function moduleOf(path: string, modules: readonly ModuleEntry[]): ModuleEntry | null {
  let result: ModuleEntry | null = null;
  let length = -1;
  for (const module of modules) {
    for (const pattern of module.paths) {
      if (matches(path, pattern) && pattern.length > length) {
        result = module;
        length = pattern.length;
      }
    }
  }
  return result;
}

export function checkDependencies(
  files: readonly SourceFile[],
  modules: readonly ModuleEntry[],
  rules: Readonly<Record<Layer, readonly Layer[]>>,
  exceptions: readonly DependencyException[],
): Violation[] {
  const violations: Violation[] = [];
  const paths = new Set(files.map((file) => file.path));
  const ids = new Set(modules.map((module) => module.id));
  const owners = new Map<string, string>();
  const pair = (from: string, to: string) => JSON.stringify([from, to]);
  const excepted = new Set(exceptions.map(({ from, to }) => pair(from, to)));
  const forbidden = new Set<string>();
  const edges = new Map<string, Violation & { examples: string[] }>();

  for (const module of modules) {
    for (const path of module.paths) {
      const previous = owners.get(path);
      if (previous !== undefined) {
        violations.push({
          kind: 'duplicate-path',
          from: previous,
          to: module.id,
          target: path,
          detail: `Duplicate path: ${path}`,
        });
      }
      owners.set(path, module.id);
      if (!files.some((file) => matches(file.path, path))) {
        violations.push({
          kind: 'stale-path',
          from: module.id,
          target: path,
          detail: `No source file matches ${path}`,
        });
      }
    }
  }
  for (const exception of exceptions) {
    if (!ids.has(exception.from) || !ids.has(exception.to)) {
      violations.push({
        kind: 'unknown-module',
        from: exception.from,
        to: exception.to,
        detail: 'Exception names an unknown module',
      });
    }
  }
  function edge(kind: 'layer' | 'sealed', from: string, to: string, file: string, target: string) {
    const key = kind + pair(from, to);
    const existing = edges.get(key);
    if (existing) existing.examples.push(`${file} → ${target}`);
    else edges.set(key, { kind, from, to, file, target, detail: '', examples: [`${file} → ${target}`] });
  }
  for (const file of files) {
    const from = moduleOf(file.path, modules);
    if (!from) {
      violations.push({
        kind: 'unmapped-file',
        file: file.path,
        detail: `Unmapped source file: ${file.path}`,
      });
      continue;
    }
    for (const specifier of importSpecifiers(file.source)) {
      // Workspace packages are contracts, accessible to every layer; npm is external.
      if (!specifier.startsWith('.')) continue;
      const base = posix.normalize(posix.join(posix.dirname(file.path), specifier));
      if (base === '..' || base.startsWith('../')) continue;
      const target = [`${base}.ts`, `${base}/index.ts`, base].find((path) => paths.has(path));
      if (!target) continue;
      const to = moduleOf(target, modules);
      if (!to || from.id === to.id) continue;
      const key = pair(from.id, to.id);
      if (!rules[from.layer].includes(to.layer)) {
        forbidden.add(key);
        if (!excepted.has(key)) edge('layer', from.id, to.id, file.path, target);
      }
      if (
        to.sealed &&
        !(to.entries ?? ['index.ts']).some((entry) => target === posix.join(to.target, entry))
      ) {
        edge('sealed', from.id, to.id, file.path, target);
      }
    }
  }
  for (const { examples, ...violation } of edges.values()) {
    violations.push({
      ...violation,
      detail: examples.slice(0, 4).join('; ') + (examples.length > 4 ? `; … (${examples.length} edges)` : ''),
    });
  }
  for (const exception of exceptions) {
    if (
      ids.has(exception.from) &&
      ids.has(exception.to) &&
      !forbidden.has(pair(exception.from, exception.to))
    ) {
      violations.push({
        kind: 'stale-exception',
        from: exception.from,
        to: exception.to,
        detail: `Remove exception (${exception.removedBy}): no forbidden edge remains`,
      });
    }
  }
  return violations;
}
