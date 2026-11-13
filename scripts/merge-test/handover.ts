import { TARGETED_TEST_FILES_MAX } from '@projectman/shared';
import { importGraph, isCode, isServerTest, snapshotTest } from './impact';
import type { MergeTestFile } from './impact';
import { checkedBy, importersOf, refineScope } from './refine';
import { CLOUD_TEST_FILTERS, isDocumentFile, mergeTestScope, TEST_READ_DOCS } from './scope';
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
  /** The sources are so wide that matching one does not make a file mapped to a test (the unmapped list). */
  broad?: boolean;
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
    reason: 'registry tests read both barrel folders and the error-code registry by path',
    sources: [
      'packages/shared/src/',
      'apps/server/src/contracts/',
      'apps/server/src/mcp/tools.ts',
      'scripts/barrels/',
    ],
    tests: ['apps/server/test/architecture/registries.test.ts'],
  },
  {
    reason: 'the architecture tests read the server source folder, the module map and the structure map',
    sources: ['apps/server/', 'scripts/', STRUCTURE_MAP],
    broad: true,
    tests: ['apps/server/test/architecture/'],
  },
  {
    reason: 'the session-state list test reads the web, widget and shared sources by path (PM-1357)',
    sources: ['apps/web/src/', 'apps/feedback-widget/src/', 'packages/'],
    tests: ['apps/server/test/architecture/session-state-lists.test.ts'],
  },
  {
    reason: 'the structure map test reads every tracked file of the repository',
    sources: ['**'],
    on: 'add-delete',
    broad: true,
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
  {
    reason:
      'the alert path (provider outage signal, item route) is reached through the app harness: the tests use `outages.` or `work_outage` on the domain, and the screening tests through the operator signals, not by import (PM-1399)',
    sources: [
      'apps/server/src/runtime/watchers/outages.ts',
      'apps/server/src/core/inbox/inbox.ts',
      'apps/server/src/core/inbox/alert-todo.ts',
      'apps/server/src/core/inbox/apply-route.ts',
      'packages/shared/src/domain/item-route.ts',
    ],
    tests: [
      'apps/server/test/alert-routing.test.ts',
      'apps/server/test/operator-signals.test.ts',
      'apps/server/test/outages.test.ts',
      'apps/server/test/outages-api.test.ts',
      'apps/server/test/periodic-work-performance.test.ts',
      'apps/server/test/provider-login-wait.test.ts',
      'apps/server/test/question-screening-offline.test.ts',
    ],
  },
  {
    reason:
      'the migration tests build an old schema from the migration list; some import it through the db facade, not db/migrations; the schema registry tests read the migrated schema (PM-1324, PM-1325)',
    sources: ['apps/server/src/db/migrations.ts'],
    tests: [
      'apps/server/test/*-migration.test.ts',
      'apps/server/test/db.test.ts',
      'apps/server/test/history-index.test.ts',
      'apps/server/test/hot-read-indexes.test.ts',
      'apps/server/test/project-change-journal.test.ts',
      'apps/server/test/member-handles-columns.test.ts',
    ],
  },
  ...Object.entries(TEST_READ_DOCS).map(([doc, tests]): SelectionRule => ({
    reason: `the tests read ${doc} by path, so a change to it is not a documentation-only change (PM-1337)`,
    sources: [doc],
    tests,
  })),
  {
    reason:
      'the context pack test writes and reads the prompt snapshots (.txt files next to it) with toMatchFileSnapshot, which are no .snap files',
    sources: ['apps/server/src/context/'],
    tests: ['apps/server/src/context/context-pack.test.ts'],
  },
  {
    reason:
      'the visibility test drives the timeline and comment visibility rules through the app, not by import (PM-1331)',
    sources: ['packages/shared/src/domain/timeline-visibility.ts', 'packages/shared/src/domain/comments.ts'],
    tests: ['apps/server/test/visibility.test.ts'],
  },
  {
    reason: 'the workflow tests read the workflow files by path',
    sources: ['.github/workflows/merge-check.yml'],
    tests: ['apps/server/test/merge-check-workflow.test.ts'],
  },
  {
    reason: 'the workflow tests read the workflow files by path',
    sources: ['.github/workflows/projectman-engine-release.yml'],
    tests: ['apps/server/test/engine-release-workflow.test.ts'],
  },
  {
    reason: 'the workflow tests read the workflow files by path',
    sources: ['.github/workflows/projectman-job.yml'],
    tests: ['apps/server/test/projectman-job-workflow.test.ts'],
  },
  {
    reason: 'the engine app and service tests read the plist, the menu bar app and the app files by path',
    sources: ['deploy/mac/'],
    tests: [
      'apps/server/test/engine-menubar.test.ts',
      'apps/server/test/engine-app-*.test.ts',
      'apps/server/test/engine-service*.test.ts',
    ],
  },
  {
    reason:
      'the deploy tests read the cloud and host files by path (the cloud scope runs the same filters when nothing else changed)',
    sources: ['deploy/aws/', 'deploy/cloud/', 'scripts/cloud/'],
    tests: [
      'apps/server/test/cloud-*.test.ts',
      'apps/server/test/deploy-*.test.ts',
      'apps/server/test/release-*.test.ts',
      'apps/server/test/memory-profile.test.ts',
      'apps/server/test/history-semantic-profile.test.ts',
    ],
  },
  {
    reason: 'the web PWA tests read the public files, the index page and the style tokens by path',
    sources: ['apps/web/public/', 'apps/web/index.html', 'apps/web/src/styles/'],
    tests: ['apps/web/src/pwa/*.test.ts'],
  },
  {
    reason: 'the error code test reads every server source file; the selection test reads the source tree',
    sources: ['apps/server/src/'],
    broad: true,
    tests: ['apps/server/test/error-codes.test.ts', 'apps/server/test/merge-test-impact.test.ts'],
  },
  {
    reason: 'the isolation test checks that every file it lists still exists',
    sources: ['apps/server/test/'],
    on: 'add-delete',
    broad: true,
    tests: ['apps/server/test/isolation.test.ts'],
  },
  {
    reason:
      'the merge check tests read the workspaces, their package scripts and the runtime entries by path',
    sources: ['apps/*/package.json', 'packages/*/package.json'],
    tests: ['apps/server/test/merge-test-cli.test.ts', 'apps/server/test/merge-test-steps.test.ts'],
  },
  {
    reason: 'the merge check tests read the scripts and the runtime entries by path',
    sources: ['scripts/merge-test/'],
    tests: ['apps/server/test/merge-test-*.test.ts'],
  },
  {
    reason: 'the merge check watchdog test (CLAUDE.md: after changing merge-test execution or reporting)',
    sources: ['scripts/merge-test/', 'scripts/full-test/', 'apps/server/src/full-test/'],
    tests: ['apps/server/test/merge-test-watchdog.test.ts'],
  },
  {
    reason:
      'the web GET contract test meters the routes and their queries through the app (CLAUDE.md: after changing web GET responses or hot-read query costs)',
    sources: ['apps/server/src/api/', 'apps/server/src/http/', 'apps/server/src/db/'],
    tests: ['apps/server/test/web-get-contracts.test.ts'],
  },
  {
    reason:
      'the start offer and golden path tests drive admission and start timing through the domain, not by import (CLAUDE.md: after changing admission wake-ups or start timing)',
    sources: [
      'apps/server/src/runtime/admission/',
      'apps/server/src/agent-text/start-offer.ts',
      'apps/server/src/core/tasks/service.ts',
    ],
    tests: ['apps/server/test/start-offer.test.ts', 'apps/server/test/golden-path-*.test.ts'],
  },
  {
    reason: 'the tool scripts are started from their tests as programs, not imported',
    sources: ['scripts/heavy/', 'scripts/lib/', 'apps/server/src/full-test/heavy-lock.ts'],
    tests: ['apps/server/test/heavy-cli.test.ts'],
  },
  {
    reason: 'the migration verify test starts scripts/migrate/cli.ts',
    sources: ['scripts/migrate/', 'apps/server/src/db/'],
    tests: ['apps/server/test/migration-verify.test.ts'],
  },
  {
    reason: 'the projectman CLI test reads the client scripts by path',
    sources: ['scripts/projectman/'],
    tests: ['apps/server/test/projectman-cli.test.ts'],
  },
  {
    reason: 'the shots tests start scripts/shots.mjs and read its scenarios and machine fixtures',
    sources: ['scripts/shots.mjs', 'scripts/scenarios/', 'scripts/fixtures/'],
    tests: ['apps/server/test/shots.test.ts', 'apps/server/test/shots-browser.test.ts'],
  },
];

export interface HandoverSelection {
  /** `none`: only the dead-code check; `cloud`: the vitest filters of a path-owned scope (cloud, owned); `targeted`: the chosen test files. */
  kind: 'none' | 'cloud' | 'targeted';
  typecheck: MergeTestWorkspace[];
  /** The test files to run after the cap, by workspace in run order. */
  tests: { workspace: MergeTestWorkspace; files: string[] }[];
  /** The vitest filters of the path-owned scope. */
  testFilters: string[];
  /** How many tests the change reaches (M), the cap, the nearest ones that run beyond it, and how many were left to the merge check. */
  reached: number;
  cap: number;
  nearest: number;
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
/** How many of the `name` tests run whatever the cap says (the best-ranked ones). */
export const NAME_TESTS_ALWAYS = 10;
export type Proximity = (typeof PROXIMITIES)[number];

const empty = (kind: HandoverSelection['kind']): HandoverSelection => ({
  kind,
  typecheck: [],
  tests: [],
  testFilters: [],
  reached: 0,
  cap: TARGETED_TEST_FILES_MAX,
  nearest: 0,
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
          .map((text) => text.replace(/\s\/\/.*$/, ''))
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
/** What a test gives a name to set it (`onLeave: true`): a literal, not a stubbed function or a lookup. */
const LITERAL = '(?:true\\b|false\\b|null\\b|-?\\d|[\'"`])';

/**
 * The candidate tests that use a changed name, nearest first: those in the workspace the change touched
 * most (by changed files), then those that set a changed name (`name: value`, `name = value`) rather than only read it, then
 * those that use more, and rarer, changed names (a name only a few tests use says the most), then the
 * tests that need no pseudo-terminal, then by path. A name nearly every test uses is ignored.
 */
function nameUsers(
  symbols: readonly string[],
  candidates: readonly MergeTestFile[],
  changedWorkspaces: ReadonlyMap<MergeTestWorkspace, number>,
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
      const setting = new RegExp(
        `(?<![\\w$.])${name.replace(/\$/g, '\\$')}\\s*\\??(?::|=(?!=))\\s*${LITERAL}`,
      );
      for (const { path, source } of files) {
        score.set(path, (score.get(path) ?? 0) + 1 / files.length);
        if (setting.test(source)) setters.add(path);
      }
    }
  const here = (path: string) => changedWorkspaces.get(workspaceOf(path)!) ?? 0;
  return [...score.keys()].sort(
    (a, b) =>
      here(b) - here(a) ||
      Number(setters.has(b)) - Number(setters.has(a)) ||
      score.get(b)! - score.get(a)! ||
      Number(isIntegration(a)) - Number(isIntegration(b)) ||
      a.localeCompare(b),
  );
}

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
  if (coarse.kind === 'owned')
    return { ...empty('cloud'), typecheck: ['apps/server'], testFilters: coarse.tests };

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
    const owner = snapshotTest(file);
    if (owner) {
      if (isServerTest(owner) && afterPaths.has(owner)) snapshotOwners.add(owner);
      else unmapped.push(file);
      continue;
    }
    const workspace = checkedBy(file);
    // A fixture, a configuration file, a file outside the workspaces or a non-code file nothing imports:
    // no test follows from it here, and the merge check covers it.
    const mapped =
      !isTestSupport(file) && !isConfig(file) && workspace && (isCode(file) || reverse.has(file));
    const ruled = SELECTION_RULES.some((rule) => !rule.broad && matchesPattern(file, rule.sources));
    if (!mapped && !ruled && !reverse.has(file) && file !== STRUCTURE_MAP) unmapped.push(file);
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
  const testsWithSnapshots = new Set([...afterPaths].map(snapshotTest));
  const hasSnapshot = (path: string): boolean => testsWithSnapshots.has(path);

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
  const changedPerWorkspace = new Map<MergeTestWorkspace, number>();
  for (const file of changed) {
    const workspace = checkedBy(file);
    if (workspace) changedPerWorkspace.set(workspace, (changedPerWorkspace.get(workspace) ?? 0) + 1);
  }
  const nameTests = nameUsers(
    changedSymbols(changed, input.before, input.after),
    input.after.filter((file) => isTest(file.path) && mergeRuns(merge, file.path)),
    changedPerWorkspace,
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
  // The cap cuts the farther tests only: the direct and the rule tests and the first name tests always run.
  let nameSeen = 0;
  const nearest = ordered.filter((path) => {
    const proximity = proximityOf.get(path)!;
    return (
      proximity === 'direct' ||
      proximity === 'rule' ||
      (proximity === 'name' && ++nameSeen <= NAME_TESTS_ALWAYS)
    );
  });
  const farther = ordered.filter((path) => !nearest.includes(path));
  const room = Math.max(0, TARGETED_TEST_FILES_MAX - nearest.length);
  const run = [...nearest, ...farther.slice(0, room)];
  const left = farther.slice(room);
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
    nearest: nearest.length,
    omitted: left.length,
    omittedByProximity: Object.fromEntries(
      PROXIMITIES.map((proximity) => [proximity, left.filter((path) => proximityOf.get(path) === proximity)]),
    ) as Record<Proximity, string[]>,
    unmapped,
  };
}
