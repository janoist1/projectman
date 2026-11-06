import { TARGETED_TEST_FILES_MAX } from '@projectman/shared';
import { sourceImports } from '../../apps/server/test/architecture/check';
import { importGraph, isCode, isServerTest } from './impact';
import type { MergeTestFile } from './impact';
import { refineScope } from './refine';
import { CLOUD_TEST_FILTERS, isDocumentFile, mergeTestScope } from './scope';
import type { MergeTestScope, MergeTestWorkspace } from './scope';
import { sharedImpact } from './shared-impact';
import { MERGE_TEST_WORKSPACES, workspaceOf } from './steps';

/** What a change did to the repository, as repository paths. */
export interface HandoverChange {
  changed: readonly string[];
  added: readonly string[];
  deleted: readonly string[];
}

/**
 * A dependency no import shows: a test reads the repository by path (a glob, a directory walk, the
 * structure map), or reaches the code over HTTP or a domain call. When a changed path matches one of
 * `sources`, every test file matching one of `tests` runs (at most the cap, after the changed tests).
 * Patterns are repository paths: `*` is within a folder, `**` crosses folders, a trailing `/` stands for
 * the folder's whole subtree. A new such dependency goes here, not into a hand-over list; a guard test
 * checks that every `import.meta.glob` test is covered by a rule.
 */
export interface SelectionRule {
  /** Why no import leads from the sources to the tests. */
  reason: string;
  /** Source path patterns: a changed (or, per `on`, added or deleted) file matching one selects the tests. */
  sources: readonly string[];
  /** Test file patterns that run. */
  tests: readonly string[];
  /** `any`: a changed, added or deleted file counts (the default); `add-delete`: only an added or deleted one. */
  on?: 'any' | 'add-delete';
}

const STRUCTURE_MAP = 'projectman.structure.yaml';
const WEB_CODE = ['apps/web/src/**/*.ts', 'apps/web/src/**/*.tsx'];

/** The regular expression of a path pattern (`*`, `**`, a trailing `/`). */
const patternRegExp = (pattern: string): RegExp => {
  const body = (pattern.endsWith('/') ? `${pattern}**` : pattern)
    .split(/(\*\*\/|\*\*|\*)/)
    .map((part) =>
      part === '**/'
        ? '(?:.*/)?'
        : part === '**'
          ? '.*'
          : part === '*'
            ? '[^/]*'
            : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('');
  return new RegExp(`^${body}$`);
};
export const matchesPattern = (path: string, patterns: readonly string[]): boolean =>
  patterns.some((pattern) => patternRegExp(pattern).test(path));

const ruleApplies = (rule: SelectionRule, change: HandoverChange): boolean =>
  (rule.on === 'add-delete' ? [...change.added, ...change.deleted] : change.changed).some((path) =>
    matchesPattern(path, rule.sources),
  );

export const SELECTION_RULES: readonly SelectionRule[] = [
  {
    reason: 'the architecture tests read the server source folder, the module map and the structure map',
    sources: ['apps/server/', 'scripts/', STRUCTURE_MAP],
    tests: ['apps/server/test/architecture/'],
  },
  {
    reason: 'the structure map test reads every tracked file of the repository',
    sources: ['**'],
    on: 'add-delete',
    tests: ['apps/server/test/architecture/structure-map.test.ts'],
  },
  {
    reason: 'the structure map test reads the structure map',
    sources: [STRUCTURE_MAP],
    tests: ['apps/server/test/architecture/structure-map.test.ts'],
  },
  {
    reason: 'import.meta.glob over apps/web/src',
    sources: WEB_CODE,
    tests: ['apps/web/src/i18n/i18n.test.ts', 'apps/web/src/components/LeaveChip.test.tsx'],
  },
  {
    reason: 'import.meta.glob over apps/feedback-widget/src/ui/*.tsx',
    sources: ['apps/feedback-widget/src/ui/'],
    tests: ['apps/feedback-widget/src/ui/escaping.test.tsx'],
  },
  {
    reason:
      'the operator tests use the request and permission rules over HTTP or domain calls, not by import (PM-1287)',
    sources: [
      'apps/server/src/services/coordination/',
      'apps/server/src/mcp/caller.ts',
      'apps/server/src/mcp/project-manager/',
    ],
    tests: ['apps/server/test/operator-*.test.ts'],
  },
];

export interface HandoverSelection {
  /** `none`: only the dead-code check; `cloud`: the cloud filters; `targeted`: the chosen test files. */
  kind: 'none' | 'cloud' | 'targeted';
  typecheck: MergeTestWorkspace[];
  /** The test files to run after the cap, by workspace in run order. */
  tests: { workspace: MergeTestWorkspace; files: string[] }[];
  /** The vitest filters of the cloud scope. */
  testFilters: string[];
  /** How many tests the change reaches (M), the cap, and how many were left to the merge check. */
  reached: number;
  cap: number;
  omitted: number;
  /** The tests the cap left out, by how near they are to the change. */
  omittedByProximity: Record<Proximity, string[]>;
  /** Changed files no check of this command maps to a test. */
  unmapped: string[];
}

/**
 * How near a test is to the change, nearest first: `direct` (a changed test, or one that imports a
 * changed file), `rule` (chosen by a `SELECTION_RULES` entry), `name` (uses a changed name without
 * importing the file it is in), `graph` (reached through further imports).
 */
export const PROXIMITIES = ['direct', 'rule', 'name', 'graph'] as const;
export type Proximity = (typeof PROXIMITIES)[number];

const empty = (kind: HandoverSelection['kind']): HandoverSelection => ({
  kind,
  typecheck: [],
  tests: [],
  testFilters: [],
  reached: 0,
  cap: TARGETED_TEST_FILES_MAX,
  omitted: 0,
  omittedByProximity: { direct: [], rule: [], name: [], graph: [] },
  unmapped: [],
});

const EXPORTED_NAME =
  /^[\t ]*export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:const|let|var|function\*?|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
/** A compound identifier (`onLeave`, `TeamToolInput`): short or one-word names match too much. */
const COMPOUND_NAME = /\b[A-Za-z_$][\w$]*[a-z][A-Z][\w$]*\b/g;
/** A name the code declares as a property, a parameter or a typed variable (`onLeave: true`). */
const DECLARED_NAME = /[\s{,(;]([A-Za-z_$][\w$]*)\s*\??:(?!:)/g;

const CALLED_NAME = /\b([A-Za-z_$][\w$]*)\s*\(/g;
const SHARED_SOURCE = 'packages/shared/src/';
/** The longest function body read for the fields it uses (up to the next export). */
const CALLEE_BODY_LINES = 40;

/**
 * The bodies (comments left out) of the shared functions the changed lines call, one step and no
 * further: the fields they read are what a test sets to reach the changed behavior.
 */
function calledSharedBodies(texts: readonly string[], after: readonly MergeTestFile[]): string[] {
  const called = new Set<string>();
  for (const text of texts) for (const match of text.matchAll(CALLED_NAME)) called.add(match[1]!);
  const bodies: string[] = [];
  if (!called.size) return bodies;
  for (const { path, source } of after) {
    if (!path.startsWith(SHARED_SOURCE) || !isCode(path) || isServerTest(path) || isTestSupport(path))
      continue;
    const lines = source.split('\n');
    lines.forEach((line, index) => {
      const declared = /^export\s+(?:async\s+)?(?:function\*?|const)\s+([A-Za-z_$][\w$]*)/.exec(line)?.[1];
      if (!declared || !called.has(declared)) return;
      const rest = lines.slice(index + 1);
      const end = rest.findIndex((next) => /^export\s/.test(next));
      bodies.push(
        [line, ...rest.slice(0, end < 0 ? CALLEE_BODY_LINES : Math.min(end, CALLEE_BODY_LINES))]
          .filter((text) => !/^\s*(?:\/\/|\/?\*)/.test(text))
          .join('\n'),
      );
    });
  }
  return bodies;
}

/**
 * The names a change touched: exported names declared on, and compound identifiers used on, the lines
 * that differ between the base and the working tree of a changed non-test code file, and the fields
 * read by the shared functions those lines call.
 */
function changedSymbols(
  changed: readonly string[],
  before: readonly MergeTestFile[],
  after: readonly MergeTestFile[],
): string[] {
  const beforeSource = new Map(before.map((file) => [file.path, file.source]));
  const afterSource = new Map(after.map((file) => [file.path, file.source]));
  const symbols = new Set<string>();
  const compound = new Set<string>();
  const texts: string[] = [];
  for (const path of changed) {
    if (!isCode(path) || isServerTest(path) || isTestSupport(path)) continue;
    const was = (beforeSource.get(path) ?? '').split('\n');
    const is = (afterSource.get(path) ?? '').split('\n');
    const wasSet = new Set(was);
    const isSet = new Set(is);
    const differing = [...is.filter((line) => !wasSet.has(line)), ...was.filter((line) => !isSet.has(line))];
    // Comments name things without using them.
    const text = differing
      .filter((line) => !/^\s*(?:\/\/|\/?\*)/.test(line))
      .map((line) => line.replace(/\s\/\/.*$/, ''))
      .join('\n');
    texts.push(text);
    for (const match of text.matchAll(EXPORTED_NAME)) if (match[1]!.length >= 5) symbols.add(match[1]!);
    for (const match of text.matchAll(COMPOUND_NAME)) compound.add(match[0]);
  }
  // One step further: the fields the shared functions called on the changed lines read (`isOnLeave` -> `onLeave`).
  for (const body of calledSharedBodies(texts, after))
    for (const match of body.matchAll(COMPOUND_NAME)) compound.add(match[0]);
  // A compound name counts only when the code declares it (a property, a variable): not `localeCompare`.
  if (compound.size)
    for (const source of [...texts, ...after.filter((file) => isCode(file.path)).map((file) => file.source)])
      for (const match of source.matchAll(DECLARED_NAME)) if (compound.has(match[1]!)) symbols.add(match[1]!);
  return [...symbols];
}

/** Integration tests start programs (and are skipped in a sandbox): they go behind the others of a tier. */
const isIntegration = (path: string): boolean => path.includes('.integration.test.');

/** A name used by more than this share of the candidate tests (`toEqual`, `readFileSync`) tells nothing. */
const COMMON_NAME_SHARE = 0.25;
const COMMON_NAME_MIN = 10;

/**
 * The candidate tests that use a changed name, nearest first: those in a workspace the change touched,
 * then those that set a changed name (`name: value`, `name = value`) rather than only read it, then
 * those that use more, and rarer, changed names (a name only a few tests use says the most), then the
 * tests that need no pseudo-terminal, then by path. A name nearly every test uses is ignored.
 */
function nameUsers(
  symbols: readonly string[],
  candidates: readonly MergeTestFile[],
  changedWorkspaces: ReadonlySet<MergeTestWorkspace>,
): string[] {
  const wanted = new Set(symbols);
  const users = new Map<string, MergeTestFile[]>();
  for (const file of candidates)
    for (const name of new Set(file.source.match(/[\w$]+/g) ?? []))
      if (wanted.has(name)) users.set(name, [...(users.get(name) ?? []), file]);
  const score = new Map<string, number>();
  const setters = new Set<string>();
  for (const [name, files] of users)
    if (files.length <= Math.max(COMMON_NAME_MIN, candidates.length * COMMON_NAME_SHARE)) {
      const setting = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}\\s*\\??(?::|=(?!=))`);
      for (const { path, source } of files) {
        score.set(path, (score.get(path) ?? 0) + 1 / files.length);
        if (setting.test(source)) setters.add(path);
      }
    }
  const here = (path: string) => Number(changedWorkspaces.has(workspaceOf(path)!));
  return [...score.keys()].sort(
    (a, b) =>
      here(b) - here(a) ||
      Number(setters.has(b)) - Number(setters.has(a)) ||
      score.get(b)! - score.get(a)! ||
      Number(isIntegration(a)) - Number(isIntegration(b)) ||
      a.localeCompare(b),
  );
}

/** The workspace whose checks cover a path: the scripts belong to the server's. */
const checkedBy = (path: string): MergeTestWorkspace | undefined =>
  path.startsWith('scripts/') ? 'apps/server' : workspaceOf(path);
const SNAPSHOT = /^(.*)\/__snapshots__\/([^/]+)\.snap$/;
const isTestSupport = (path: string): boolean => /\/(?:fixtures|test-fixtures)\//.test(path);
const isConfig = (path: string): boolean =>
  /^(?:package(?:-lock)?\.json|tsconfig.*\.json|vitest\.config\..*)$/.test(path.split('/').at(-1)!);

/** Whether the merge check runs this test file for the change (the hand-over check stays inside it). */
function mergeRuns(scope: MergeTestScope, file: string): boolean {
  const workspace = workspaceOf(file);
  if (scope.kind === 'all') return true;
  if (!workspace) return false;
  if (scope.kind === 'workspaces') return scope.workspaces.includes(workspace);
  if (scope.kind === 'shared')
    return (
      scope.workspaces.includes(workspace) &&
      (workspace !== 'apps/server' || !scope.tests || scope.tests.includes(file))
    );
  if (scope.kind === 'modules')
    return workspace === 'apps/server' ? scope.tests.includes(file) : scope.workspaces.includes(workspace);
  return false;
}

/** The files that import `pkg` (or a subpath of it), and those that do it other than by type. */
function importersOf(files: readonly MergeTestFile[], pkg: string): { all: string[]; value: string[] } {
  const all: string[] = [];
  const value: string[] = [];
  for (const file of files) {
    if (!isCode(file.path) || !checkedBy(file.path)) continue;
    const imports = sourceImports(file.source);
    const own = (s: string) => s === pkg || s.startsWith(`${pkg}/`);
    if (!imports.specifiers.some(own)) continue;
    all.push(file.path);
    if (imports.specifiers.some((s) => own(s) && !imports.typeOnly.includes(s))) value.push(file.path);
  }
  return { all, value };
}

/**
 * The tests a change affects, nearest first. The merge check's scope is the upper bound: the shared
 * export analysis and the server module analysis give the same answers, then the file-level value
 * import graph narrows them to the tests that reach a changed file. `before` and `after` hold every
 * workspace and `scripts/` at the base and in the working tree.
 */
export function handoverSelection(
  input: HandoverChange & { before: readonly MergeTestFile[]; after: readonly MergeTestFile[] },
): HandoverSelection {
  const changed = [...new Set(input.changed)].filter((file) => !isDocumentFile(file)).sort();
  const coarse = mergeTestScope(changed);
  if (coarse.kind === 'none') return empty('none');
  if (coarse.kind === 'cloud')
    return { ...empty('cloud'), typecheck: ['apps/server'], testFilters: CLOUD_TEST_FILTERS };

  const merge = refineScope(coarse, changed, input.before, input.after);
  const afterPaths = new Set(input.after.map((file) => file.path));
  const graphs = [importGraph(input.before), importGraph(input.after)];
  const reverse = new Map<string, Set<string>>();
  for (const graph of graphs)
    for (const [from, targets] of graph.valueEdges)
      for (const target of targets) reverse.set(target, (reverse.get(target) ?? new Set()).add(from));

  const seeds = new Set<string>();
  const changedFiles: string[] = [];
  const snapshotOwners = new Set<string>();
  const unmapped: string[] = [];
  const typecheck = new Set<MergeTestWorkspace>();
  for (const file of changed) {
    const snapshot = SNAPSHOT.exec(file);
    if (snapshot) {
      const owner = `${snapshot[1]}/${snapshot[2]}`;
      if (isServerTest(owner) && afterPaths.has(owner)) snapshotOwners.add(owner);
      else unmapped.push(file);
      continue;
    }
    const workspace = checkedBy(file);
    // A fixture, a configuration file, a file outside the workspaces or a non-code file nothing imports:
    // no test follows from it here, and the merge check covers it.
    const mapped =
      !isTestSupport(file) && !isConfig(file) && workspace && (isCode(file) || reverse.has(file));
    if (!mapped && !reverse.has(file) && file !== STRUCTURE_MAP) unmapped.push(file);
    if (isCode(file) && workspace) typecheck.add(workspace);
    seeds.add(file);
    changedFiles.push(file);
  }

  // The packages other workspaces import by name: only a value import carries a change into their tests.
  const sharedSource = changed.filter((file) => file.startsWith('packages/shared/src/'));
  const shared = sharedSource.length
    ? sharedImpact({ changed: sharedSource, before: input.before, after: input.after })
    : undefined;
  if (shared && 'fallback' in shared) {
    for (const workspace of MERGE_TEST_WORKSPACES) typecheck.add(workspace);
    for (const file of importersOf(input.after, '@projectman/shared').value) seeds.add(file);
  } else if (shared) {
    for (const workspace of MERGE_TEST_WORKSPACES)
      if (workspace !== 'packages/shared' && shared.consumers[workspace].length) typecheck.add(workspace);
    for (const files of Object.values(shared.valueConsumers)) for (const file of files) seeds.add(file);
  }
  const templatesChanged =
    changed.some((file) => file.startsWith('packages/templates/')) ||
    (shared !== undefined &&
      !('fallback' in shared) &&
      shared.valueConsumers['packages/templates'].length > 0);
  if (templatesChanged) {
    const importers = importersOf(input.after, '@projectman/templates');
    for (const file of importers.value) seeds.add(file);
    for (const file of importers.all) typecheck.add(checkedBy(file)!);
  }

  // Walk the reverse value edges from the seeds; the distance orders the tests that are reached.
  const distance = new Map<string, number>([...seeds].map((seed) => [seed, 0]));
  for (let frontier = [...seeds]; frontier.length;) {
    const next: string[] = [];
    for (const path of frontier)
      for (const dependent of reverse.get(path) ?? [])
        if (!distance.has(dependent)) {
          distance.set(dependent, distance.get(path)! + 1);
          next.push(dependent);
        }
    frontier = next;
  }
  const isTest = (path: string): boolean =>
    isServerTest(path) && afterPaths.has(path) && !isTestSupport(path) && workspaceOf(path) !== undefined;
  const hasSnapshot = (path: string): boolean =>
    afterPaths.has(`${path.slice(0, path.lastIndexOf('/'))}/__snapshots__/${path.split('/').at(-1)}.snap`);

  const change: HandoverChange = { changed: input.changed, added: input.added, deleted: input.deleted };
  const ruleTests = [
    ...new Set(
      SELECTION_RULES.filter((rule) => ruleApplies(rule, change)).flatMap((rule) =>
        input.after
          .map((file) => file.path)
          .filter((path) => isTest(path) && matchesPattern(path, rule.tests)),
      ),
    ),
  ];
  const reachedTests = [...distance.keys()].filter(isTest).filter((path) => mergeRuns(merge, path));
  const byDistance = (a: string, b: string) => distance.get(a)! - distance.get(b)! || a.localeCompare(b);
  const bySnapshotThenDistance = (a: string, b: string) =>
    Number(hasSnapshot(b)) - Number(hasSnapshot(a)) ||
    Number(isIntegration(a)) - Number(isIntegration(b)) ||
    byDistance(a, b);
  // The names a test may use without importing a changed file (a setting, a method of an injected object).
  const nameTests = nameUsers(
    changedSymbols(changed, input.before, input.after),
    input.after.filter((file) => isTest(file.path) && mergeRuns(merge, file.path)),
    new Set(changed.map(checkedBy).filter((workspace) => workspace !== undefined)),
  );
  // The tests that import a changed file themselves; a consumer of a changed package export is not one.
  const importers = new Set(
    changedFiles
      .flatMap((file) => [...(reverse.get(file) ?? [])])
      .filter((path) => reachedTests.includes(path)),
  );

  // Nearest first. Alphabetical order only decides between tests of the same proximity.
  const tiers: Record<Proximity, string[]> = {
    // The change's own tests, then the tests that import a changed file themselves.
    direct: [
      ...[...snapshotOwners, ...changed.filter(isTest)].sort(),
      ...[...importers].sort(bySnapshotThenDistance),
    ],
    rule: ruleTests,
    name: nameTests,
    graph: reachedTests.sort(bySnapshotThenDistance),
  };
  const proximityOf = new Map<string, Proximity>();
  for (const proximity of PROXIMITIES)
    for (const path of tiers[proximity]) if (!proximityOf.has(path)) proximityOf.set(path, proximity);
  const ordered = [...proximityOf.keys()];
  const run = ordered.slice(0, TARGETED_TEST_FILES_MAX);
  const left = ordered.slice(TARGETED_TEST_FILES_MAX);
  return {
    kind: 'targeted',
    typecheck: MERGE_TEST_WORKSPACES.filter((workspace) => typecheck.has(workspace)),
    tests: MERGE_TEST_WORKSPACES.flatMap((workspace) => {
      const files = run.filter((path) => workspaceOf(path) === workspace);
      return files.length ? [{ workspace, files }] : [];
    }),
    testFilters: [],
    reached: ordered.length,
    cap: TARGETED_TEST_FILES_MAX,
    omitted: Math.max(0, ordered.length - TARGETED_TEST_FILES_MAX),
    omittedByProximity: Object.fromEntries(
      PROXIMITIES.map((proximity) => [proximity, left.filter((path) => proximityOf.get(path) === proximity)]),
    ) as Record<Proximity, string[]>,
    unmapped,
  };
}
