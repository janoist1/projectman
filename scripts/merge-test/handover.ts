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
 * A test that reads the repository by path (a glob, a directory walk, the structure map), so no import
 * leads to it. It runs when `when` holds for the change. A new such test goes here, not into a hand-over
 * list; a guard test checks that every glob or structure-map reading test is listed.
 */
export interface PathReadTest {
  /** A test file, or a folder (ending in `/`) whose test files all run. */
  test: string;
  /** What the test reads. */
  reads: string;
  when: (change: HandoverChange) => boolean;
}

const STRUCTURE_MAP = 'projectman.structure.yaml';
const changedUnder = (change: HandoverChange, prefixes: readonly string[]): boolean =>
  change.changed.some((file) => prefixes.some((prefix) => file.startsWith(prefix)));
const webCodeChanged = (change: HandoverChange): boolean =>
  change.changed.some((file) => file.startsWith('apps/web/src/') && isCode(file));

export const PATH_READ_TESTS: readonly PathReadTest[] = [
  {
    test: 'apps/server/test/architecture/',
    reads: 'the server source folder, the module map and the structure map',
    when: (change) =>
      changedUnder(change, ['apps/server/', 'scripts/']) || change.changed.includes(STRUCTURE_MAP),
  },
  {
    test: 'apps/server/test/architecture/structure-map.test.ts',
    reads: 'every tracked file of the repository',
    when: (change) =>
      change.added.length > 0 || change.deleted.length > 0 || change.changed.includes(STRUCTURE_MAP),
  },
  { test: 'apps/web/src/i18n/i18n.test.ts', reads: 'apps/web/src (import.meta.glob)', when: webCodeChanged },
  {
    test: 'apps/web/src/components/LeaveChip.test.tsx',
    reads: 'apps/web/src (import.meta.glob)',
    when: webCodeChanged,
  },
  {
    test: 'apps/feedback-widget/src/ui/escaping.test.tsx',
    reads: 'apps/feedback-widget/src/ui/*.tsx (import.meta.glob)',
    when: (change) => changedUnder(change, ['apps/feedback-widget/src/ui/']),
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
  /** Changed files no check of this command maps to a test. */
  unmapped: string[];
}

const empty = (kind: HandoverSelection['kind']): HandoverSelection => ({
  kind,
  typecheck: [],
  tests: [],
  testFilters: [],
  reached: 0,
  cap: TARGETED_TEST_FILES_MAX,
  omitted: 0,
  unmapped: [],
});

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
  const pathRead = PATH_READ_TESTS.filter((entry) => entry.when(change)).flatMap((entry) =>
    entry.test.endsWith('/')
      ? input.after.map((file) => file.path).filter((path) => path.startsWith(entry.test) && isTest(path))
      : isTest(entry.test)
        ? [entry.test]
        : [],
  );
  const reachedTests = [...distance.keys()].filter(isTest).filter((path) => mergeRuns(merge, path));
  const byDistance = (a: string, b: string) => distance.get(a)! - distance.get(b)! || a.localeCompare(b);
  // Nearest first: the change's own tests, the path readers, the snapshot tests, then by distance.
  const ordered = [
    ...new Set([
      ...[...snapshotOwners, ...changed.filter(isTest)].sort(),
      ...pathRead,
      ...reachedTests.filter(hasSnapshot).sort(byDistance),
      ...reachedTests.sort(byDistance),
    ]),
  ];
  const run = ordered.slice(0, TARGETED_TEST_FILES_MAX);
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
    unmapped,
  };
}
