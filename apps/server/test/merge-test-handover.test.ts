import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TARGETED_TEST_FILES_MAX } from '@projectman/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  handoverSelection,
  matchesPattern,
  NAME_TESTS_ALWAYS,
  SELECTION_RULES,
} from '../../../scripts/merge-test/handover';
import { runHandoverCheck } from '../../../scripts/merge-test/handover-run';
import type { MergeTestFile } from '../../../scripts/merge-test/impact';
import type { StepRun } from '../../../scripts/merge-test/steps';

const file = (path: string, source = ''): MergeTestFile => ({ path, source });
const select = (tree: MergeTestFile[], changed: string[], added: string[] = [], deleted: string[] = []) =>
  handoverSelection({ changed, added, deleted, before: tree, after: tree });

/** A changed `a.ts` and `count` tests that reach it only through `b.ts` (the farther `graph` tier). */
const farTree = (count: number): MergeTestFile[] => [
  file('apps/server/src/core/a.ts', 'export const a = { onLeave: false };'),
  file('apps/server/src/core/b.ts', "import { a } from './a';\nexport const b = a;"),
  ...Array.from({ length: count }, (_, i) =>
    file(`apps/server/src/core/f${String(i).padStart(2, '0')}.test.ts`, "import { b } from './b';"),
  ),
];

const SNAPSHOT_TEST = 'apps/server/src/mcp/tools.test.ts';
const teamToolTree = [
  file('packages/shared/src/index.ts', "export * from './team-tool';\nexport * from './other';"),
  file('packages/shared/src/team-tool.ts', 'export const TeamToolInput = 1;'),
  file('packages/shared/src/other.ts', 'export const Other = 1;'),
  file(
    'apps/server/src/mcp/tools.ts',
    "import { TeamToolInput } from '@projectman/shared';\nexport const tools = [TeamToolInput];",
  ),
  file(SNAPSHOT_TEST, "import { tools } from './tools';"),
  file('apps/server/src/mcp/__snapshots__/tools.test.ts.snap'),
  file(
    'apps/server/src/mcp/unrelated.ts',
    "import { Other } from '@projectman/shared';\nexport const unrelated = Other;",
  ),
  file('apps/server/src/mcp/unrelated.test.ts', "import { unrelated } from './unrelated';"),
];

describe('handover selection', () => {
  it('selects the tool snapshot test when a shared schema used by a team tool changes (PM-1285)', () => {
    const selection = select(teamToolTree, ['packages/shared/src/team-tool.ts']);
    expect(selection.kind).toBe('targeted');
    expect(selection.tests).toEqual([{ workspace: 'apps/server', files: [SNAPSHOT_TEST] }]);
    expect(selection.typecheck).toContain('apps/server');
  });

  it('runs no test of a workspace that only type-imports a changed package, but still type checks it', () => {
    const tree = [
      file('packages/templates/src/types.ts', 'export type Template = string;'),
      file(
        'apps/web/src/a.ts',
        "import type { Template } from '@projectman/templates';\nexport const a = 1;",
      ),
      file('apps/web/src/a.test.ts', "import { a } from './a';"),
    ];
    const selection = select(tree, ['packages/templates/src/types.ts']);
    expect(selection.kind).toBe('targeted');
    expect(selection.tests).toEqual([]);
    expect(selection.typecheck).toEqual(expect.arrayContaining(['apps/web', 'packages/templates']));
  });

  it('runs the tests of a value importer of a changed package', () => {
    const tree = [
      file('packages/templates/src/render.ts', 'export const render = 1;'),
      file('apps/web/src/b.ts', "import { render } from '@projectman/templates';\nexport const b = render;"),
      file('apps/web/src/b.test.ts', "import { b } from './b';"),
    ];
    expect(select(tree, ['packages/templates/src/render.ts']).tests).toEqual([
      { workspace: 'apps/web', files: ['apps/web/src/b.test.ts'] },
    ]);
  });

  it('stays inside the workspace of a web-only change and runs the path-reading web tests', () => {
    const tree = [
      file('apps/web/src/features/x.ts', 'export const x = 1;'),
      file('apps/web/src/features/x.test.ts', "import { x } from './x';"),
      file('apps/web/src/i18n/i18n.test.ts', ''),
      file('apps/server/src/other.ts', 'export const other = 1;'),
      file('apps/server/src/other.test.ts', "import { other } from './other';"),
    ];
    const selection = select(tree, ['apps/web/src/features/x.ts']);
    expect(selection.tests.map(({ workspace }) => workspace)).toEqual(['apps/web']);
    expect(selection.tests[0]!.files).toEqual([
      'apps/web/src/features/x.test.ts',
      'apps/web/src/i18n/i18n.test.ts',
    ]);
  });

  it('puts the changed test and a snapshot test before the other reached tests', () => {
    const tree = [
      file('apps/server/src/core/a.ts', 'export const a = 1;'),
      file('apps/server/src/core/plain.test.ts', "import { a } from './a';"),
      file('apps/server/src/core/snap.test.ts', "import { a } from './a';"),
      file('apps/server/src/core/__snapshots__/snap.test.ts.snap'),
      file('apps/server/src/core/own.test.ts', "import { a } from './a';"),
    ];
    const files = select(tree, ['apps/server/src/core/a.ts', 'apps/server/src/core/own.test.ts']).tests[0]!
      .files;
    expect(files).toEqual([
      'apps/server/src/core/own.test.ts',
      'apps/server/src/core/snap.test.ts',
      'apps/server/src/core/plain.test.ts',
    ]);
  });

  it('caps the farther tests and reports how many tests it left to the merge check', () => {
    const selection = select(farTree(TARGETED_TEST_FILES_MAX + 5), ['apps/server/src/core/a.ts']);
    expect(selection.tests[0]!.files).toHaveLength(TARGETED_TEST_FILES_MAX);
    expect(selection).toMatchObject({
      reached: TARGETED_TEST_FILES_MAX + 5,
      cap: TARGETED_TEST_FILES_MAX,
      nearest: 0,
      omitted: 5,
    });
  });

  it('never cuts the direct tests, even beyond the cap (PM-1337)', () => {
    const direct = Array.from({ length: TARGETED_TEST_FILES_MAX + 5 }, (_, i) =>
      file(`apps/server/src/core/d${String(i).padStart(2, '0')}.test.ts`, "import { a } from './a';"),
    );
    const selection = select(
      [file('apps/server/src/core/a.ts', 'export const a = 1;'), ...direct],
      ['apps/server/src/core/a.ts'],
    );
    expect(selection.tests[0]!.files).toHaveLength(TARGETED_TEST_FILES_MAX + 5);
    expect(selection).toMatchObject({ nearest: TARGETED_TEST_FILES_MAX + 5, omitted: 0 });
  });

  it('runs the first name tests whatever the cap says and fills the rest with farther tests (PM-1337)', () => {
    const names = Array.from({ length: NAME_TESTS_ALWAYS + 5 }, (_, i) =>
      file(`apps/server/test/n${String(i).padStart(2, '0')}.test.ts`, 'setup({ onLeave: true });'),
    );
    const tree = [...farTree(TARGETED_TEST_FILES_MAX - 10), ...names];
    const after = tree.map((f) =>
      f.path.endsWith('/a.ts') ? file(f.path, 'export const a = { onLeave: true };') : f,
    );
    const selection = handoverSelection({
      changed: ['apps/server/src/core/a.ts'],
      added: [],
      deleted: [],
      before: tree,
      after,
    });
    const files = selection.tests.flatMap((entry) => entry.files);
    expect(files.slice(0, NAME_TESTS_ALWAYS).every((path) => path.includes('/n'))).toBe(true);
    expect(files).toHaveLength(TARGETED_TEST_FILES_MAX);
    expect(selection).toMatchObject({ nearest: NAME_TESTS_ALWAYS, omitted: 5 });
    expect(selection.omittedByProximity.graph).toHaveLength(5);
  });

  it('keeps the direct and the name-using test inside the cap when many farther tests are reached (PM-1306)', () => {
    const far = Array.from({ length: TARGETED_TEST_FILES_MAX + 5 }, (_, i) =>
      file(`apps/server/src/core/f${String(i).padStart(2, '0')}.test.ts`, "import { b } from './b';"),
    );
    const tree = [
      file('apps/server/src/core/a.ts', 'export const a = { onLeave: false };'),
      file('apps/server/src/core/b.ts', "import { a } from './a';\nexport const b = a;"),
      ...far,
      file('apps/server/src/core/zz-direct.test.ts', "import { a } from './a';"),
      file('apps/server/src/core/zz-name.test.ts', 'setup({ onLeave: true });'),
    ];
    const after = tree.map((f) =>
      f.path.endsWith('/a.ts') ? file(f.path, 'export const a = { onLeave: true };') : f,
    );
    const selection = handoverSelection({
      changed: ['apps/server/src/core/a.ts'],
      added: [],
      deleted: [],
      before: tree,
      after,
    });
    const files = selection.tests[0]!.files;
    expect(files.slice(0, 2)).toEqual([
      'apps/server/src/core/zz-direct.test.ts',
      'apps/server/src/core/zz-name.test.ts',
    ]);
    expect(files).toHaveLength(TARGETED_TEST_FILES_MAX);
    expect(selection.omitted).toBe(7);
    expect(selection.omittedByProximity).toMatchObject({ direct: [], rule: [], name: [] });
    expect(selection.omittedByProximity.graph).toHaveLength(7);
  });

  it('does not count the consumers of a changed package export as direct, and ranks a rarely used name first (PM-1306)', () => {
    const consumers = Array.from({ length: TARGETED_TEST_FILES_MAX + 20 }, (_, i) =>
      file(
        `apps/server/test/c${String(i).padStart(3, '0')}.test.ts`,
        // Some of them use `onLeave` too: it is used by many tests, yet not by nearly all.
        `import { LEAVE } from '@projectman/shared';\n${i % 8 === 1 ? 'x({ onLeave: false });' : ''}`,
      ),
    );
    const tree = [
      file('packages/shared/src/index.ts', "export * from './leave';"),
      file('packages/shared/src/leave.ts', 'export const LEAVE = { onLeave: false };'),
      ...consumers,
      file('apps/server/test/zz-name.test.ts', 'x({ onLeave: true });'),
    ];
    const after = tree.map((f) =>
      f.path.endsWith('/leave.ts') ? file(f.path, 'export const LEAVE = { onLeave: true };') : f,
    );
    const selection = handoverSelection({
      changed: ['packages/shared/src/leave.ts'],
      added: [],
      deleted: [],
      before: tree,
      after,
    });
    expect(selection.omittedByProximity.direct).toEqual([]);
    expect(selection.tests.flatMap((entry) => entry.files)).toContain('apps/server/test/zz-name.test.ts');
  });

  it('ranks a test that sets the changed name before one that only reads it, and integration tests last (PM-1306)', () => {
    const tree = [
      file('apps/server/src/core/a.ts', 'export const a = { onLeave: false };'),
      file('apps/server/test/m-read.test.ts', 'expect(member.onLeave).toBe(true);'),
      file('apps/server/test/m-read.integration.test.ts', 'expect(member.onLeave).toBe(true);'),
      file('apps/server/test/z-set.test.ts', 'update({ onLeave: true });'),
    ];
    const after = tree.map((f) =>
      f.path.endsWith('/a.ts') ? file(f.path, 'export const a = { onLeave: true };') : f,
    );
    const selection = handoverSelection({
      changed: ['apps/server/src/core/a.ts'],
      added: [],
      deleted: [],
      before: tree,
      after,
    });
    expect(selection.tests[0]!.files).toEqual([
      'apps/server/test/z-set.test.ts',
      'apps/server/test/m-read.test.ts',
      'apps/server/test/m-read.integration.test.ts',
    ]);
  });

  it('follows a shared function called on a changed line to the fields it reads (PM-1308)', () => {
    const far = Array.from({ length: TARGETED_TEST_FILES_MAX + 5 }, (_, i) =>
      file(`apps/server/src/core/f${String(i).padStart(2, '0')}.test.ts`, "import { b } from './b';"),
    );
    const leave = [
      '/** Whether a member is on leave (onLeaveRule). */',
      'export function isOnLeave(member: { kind: string; onLeave?: boolean }): boolean {',
      "  return member.kind === 'ai' && member.onLeave === true;",
      '}',
      'export const unrelatedShared = { someOtherField: 1 };',
    ].join('\n');
    const tree = [
      file('packages/shared/src/leave.ts', leave),
      file(
        'apps/server/src/core/a.ts',
        "import { isOnLeave } from '@projectman/shared';\nexport const a = (m) => isOnLeave(m);",
      ),
      file('apps/server/src/core/b.ts', "import { a } from './a';\nexport const b = a;"),
      ...far,
      file('apps/server/src/core/zz-name.test.ts', 'setup({ onLeave: true });'),
    ];
    const after = tree.map((f) =>
      f.path.endsWith('/a.ts')
        ? file(
            f.path,
            "import { isOnLeave } from '@projectman/shared';\nexport const a = (m) => isOnLeave(m) || m.paused;",
          )
        : f,
    );
    const selection = handoverSelection({
      changed: ['apps/server/src/core/a.ts'],
      added: [],
      deleted: [],
      before: tree,
      after,
    });
    expect(selection.tests[0]!.files[0]).toBe('apps/server/src/core/zz-name.test.ts');
    expect(selection.omittedByProximity.name).toEqual([]);
  });

  it('ranks a test that sets a name to a literal before one that stubs a rarer name (PM-1308)', () => {
    const tree = [
      file('apps/server/src/core/a.ts', 'export const a = { onLeave: false, findRunning: 1 };'),
      file('apps/server/test/m-stub.test.ts', 'make({ findRunning: () => [] });'),
      file('apps/server/test/z-set.test.ts', 'update({ onLeave: true });'),
    ];
    const after = tree.map((f) =>
      f.path.endsWith('/a.ts') ? file(f.path, 'export const a = { onLeave: true, findRunning: 2 };') : f,
    );
    const selection = handoverSelection({
      changed: ['apps/server/src/core/a.ts'],
      added: [],
      deleted: [],
      before: tree,
      after,
    });
    expect(selection.tests.find((entry) => entry.workspace === 'apps/server')!.files).toEqual([
      'apps/server/test/z-set.test.ts',
      'apps/server/test/m-stub.test.ts',
    ]);
  });

  it('selects nothing but the dead-code check for a documentation-only change', () => {
    expect(select(teamToolTree, ['docs/DECISIONS.md'])).toMatchObject({
      kind: 'none',
      typecheck: [],
      tests: [],
    });
  });

  it('runs the structure map test when a file is added', () => {
    const tree = [
      file('apps/server/test/architecture/structure-map.test.ts'),
      file('apps/web/src/new.ts', ''),
    ];
    expect(select(tree, ['apps/web/src/new.ts'], ['apps/web/src/new.ts']).tests).toEqual([
      { workspace: 'apps/server', files: ['apps/server/test/architecture/structure-map.test.ts'] },
    ]);
  });
});

describe('selection rules', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const tracked = execFileSync('git', ['ls-files', 'apps', 'packages'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((path) => /\.test\.tsx?$/.test(path));
  const listed = (path: string) => SELECTION_RULES.some(({ tests }) => matchesPattern(path, tests));
  // A test that resolves a repository path from its own location (`new URL('../../..', import.meta.url)`,
  // `import.meta.dirname`, `import.meta.glob`) and reads it. Its own fixtures and models are not a source.
  const READS = /readFileSync|readFile\(|readdirSync|readdir\(|existsSync|statSync|import\.meta\.glob/;
  const LOCATION =
    /import\.meta\.glob|(?:import\.meta\.(?:url|dirname)).*\.\.\/|\.\.\/.*import\.meta\.(?:url|dirname)/;
  const NOT_REPO_READERS: ReadonlySet<string> = new Set([
    // Import their own code into a child process, or read a fixture next to them; no repository file is a source.
    'apps/server/src/full-test/run-sandboxed-core.test.ts',
    'apps/server/src/exec/exec-command.test.ts',
  ]);
  const isPathReader = (path: string, source: string): boolean =>
    /^apps\/(?:server|web|feedback-widget)\//.test(path) &&
    !NOT_REPO_READERS.has(path) &&
    READS.test(source) &&
    source.split('\n').some((line) => !/fixtures|models\/|^\s*(?:\/\/|\*)/.test(line) && LOCATION.test(line));
  const operatorTree = [
    file('apps/server/src/services/coordination/requests.ts', 'export const r = 1;'),
    file('apps/server/test/operator-knowledge.test.ts'),
    file('apps/server/test/operator-signals.test.ts'),
    file('apps/server/test/operator-app-operations.test.ts'),
    file('apps/server/test/other.test.ts'),
    file('apps/server/src/mcp/caller.ts', 'export const c = 1;'),
    file('apps/server/src/core/unrelated.ts', 'export const u = 1;'),
  ];
  const OPERATOR_TESTS = [
    'apps/server/test/operator-app-operations.test.ts',
    'apps/server/test/operator-knowledge.test.ts',
    'apps/server/test/operator-signals.test.ts',
  ];

  it.each([
    'apps/server/src/services/coordination/requests.ts',
    'apps/server/src/mcp/caller.ts',
    'apps/server/src/mcp/project-manager/tools.ts',
  ])('selects every operator test when %s changes, although nothing imports them', (changed) => {
    const tree = [
      ...operatorTree,
      file('apps/server/src/mcp/project-manager/tools.ts', 'export const t = 1;'),
    ];
    const files = select(tree, [changed]).tests.flatMap((entry) => entry.files);
    expect(files).toEqual(expect.arrayContaining(OPERATOR_TESTS));
    expect(files).not.toContain('apps/server/test/other.test.ts');
  });

  it('selects no operator test for a change outside the rule sources', () => {
    const files = select(operatorTree, ['apps/server/src/core/unrelated.ts']).tests.flatMap(
      (entry) => entry.files,
    );
    expect(files.filter((path) => path.includes('/operator-'))).toEqual([]);
  });

  it('selects every migration test and schema registry test when db/migrations.ts changes (PM-1324, PM-1325)', () => {
    const tree = [
      file('apps/server/src/db/migrations.ts', 'export const migrations = [];'),
      file('apps/server/src/db/index.ts', "export { migrations } from './migrations';"),
      file('apps/server/test/merge-trains-migration.test.ts', "import { migrations } from '../src/db';"),
      file('apps/server/test/a-new-migration.test.ts'),
      file('apps/server/test/db.test.ts'),
      file('apps/server/test/project-change-journal.test.ts'),
      file('apps/server/test/member-handles-columns.test.ts'),
      file('apps/server/test/other.test.ts'),
    ];
    const files = select(tree, ['apps/server/src/db/migrations.ts']).tests.flatMap((entry) => entry.files);
    expect(files).toEqual(
      expect.arrayContaining([
        'apps/server/test/merge-trains-migration.test.ts',
        'apps/server/test/a-new-migration.test.ts',
        'apps/server/test/db.test.ts',
        'apps/server/test/project-change-journal.test.ts',
        'apps/server/test/member-handles-columns.test.ts',
      ]),
    );
    expect(files).not.toContain('apps/server/test/other.test.ts');
  });

  it('never cuts the rule tests, even beyond the cap (PM-1337)', () => {
    const operators = Array.from({ length: TARGETED_TEST_FILES_MAX + 2 }, (_, i) =>
      file(`apps/server/test/operator-t${String(i).padStart(2, '0')}.test.ts`),
    );
    const selection = select([...operatorTree.slice(0, 1), ...operators], [operatorTree[0]!.path]);
    expect(selection.tests[0]!.files).toHaveLength(TARGETED_TEST_FILES_MAX + 2);
    expect(selection.omittedByProximity.rule).toEqual([]);
  });

  it.each([
    'apps/server/src/runtime/watchers/outages.ts',
    'apps/server/src/core/inbox/inbox.ts',
    'apps/server/src/core/inbox/alert-todo.ts',
    'apps/server/src/core/inbox/apply-route.ts',
    'packages/shared/src/domain/item-route.ts',
  ])('selects the harness-driven alert tests when %s changes (PM-1399)', (changed) => {
    const tree = [
      file(changed, 'export const o = 1;'),
      file('apps/server/test/operator-signals.test.ts', "import { createApp } from './helpers/app-harness';"),
      file('apps/server/test/question-screening-offline.test.ts'),
      file('apps/server/test/other.test.ts'),
    ];
    const files = select(tree, [changed]).tests.flatMap((entry) => entry.files);
    expect(files).toEqual(
      expect.arrayContaining([
        'apps/server/test/operator-signals.test.ts',
        'apps/server/test/question-screening-offline.test.ts',
      ]),
    );
    expect(files).not.toContain('apps/server/test/other.test.ts');
  });

  it('keeps the alert rule tests ahead of the many farther tests that fill the cap (PM-1399)', () => {
    const outages = 'apps/server/src/runtime/watchers/outages.ts';
    const tree = [
      file(outages, 'export const o = 1;'),
      file(
        'apps/server/src/core/b.ts',
        "import { o } from '../runtime/watchers/outages';\nexport const b = o;",
      ),
      ...Array.from({ length: TARGETED_TEST_FILES_MAX + 5 }, (_, i) =>
        file(`apps/server/src/core/f${String(i).padStart(2, '0')}.test.ts`, "import { b } from './b';"),
      ),
      file('apps/server/test/operator-signals.test.ts'),
      file('apps/server/test/question-screening-offline.test.ts'),
    ];
    const selection = select(tree, [outages]);
    const files = selection.tests.flatMap((entry) => entry.files);
    expect(files).toEqual(
      expect.arrayContaining([
        'apps/server/test/operator-signals.test.ts',
        'apps/server/test/question-screening-offline.test.ts',
      ]),
    );
    expect(files).toHaveLength(TARGETED_TEST_FILES_MAX);
    expect(selection.omitted).toBeGreaterThan(0);
  });

  it.each(['apps/server/src/runtime/admission/task-starts.ts', 'apps/server/src/core/tasks/task-wait.ts'])(
    'selects the harness-driven start and wait tests when %s changes (PM-1345, PM-1402)',
    (changed) => {
      const tree = [
        file(changed, 'export const t = 1;'),
        file('apps/server/test/relation-notices.test.ts', "import { createDomain } from './helpers/domain';"),
        file('apps/server/test/structural-history-reads.test.ts'),
        file('apps/server/test/other.test.ts'),
      ];
      const files = select(tree, [changed]).tests.flatMap((entry) => entry.files);
      expect(files).toEqual(
        expect.arrayContaining([
          'apps/server/test/relation-notices.test.ts',
          'apps/server/test/structural-history-reads.test.ts',
        ]),
      );
      expect(files).not.toContain('apps/server/test/other.test.ts');
    },
  );

  it('keeps the tests named after a changed module ahead of the many tests only the central files reach (PM-1402)', () => {
    const admission = 'apps/server/src/runtime/admission/deferred-starts.ts';
    const kernel = 'apps/server/src/kernel/events.ts';
    const named = [
      'apps/server/test/automatic-session-starts.test.ts',
      'apps/server/test/admission.test.ts',
      'apps/server/test/deferred-starts.test.ts',
    ];
    const tree = [
      file(admission, 'export const a = 1;'),
      file(kernel, 'export const k = 1;'),
      file('apps/server/src/core/b.ts', "import { k } from '../kernel/events';\nexport const b = k;"),
      ...Array.from({ length: TARGETED_TEST_FILES_MAX + 5 }, (_, i) =>
        file(`apps/server/src/core/a${String(i).padStart(2, '0')}.test.ts`, "import { b } from './b';"),
      ),
      ...named.map((path) => file(path)),
      file('apps/server/test/unrelated-starter.test.ts'),
    ];
    const selection = select(tree, [admission, kernel]);
    const files = selection.tests.flatMap((entry) => entry.files);
    // The module tests lead the graph tests, which the alphabet would put before them; the cap cuts only the graph tests.
    expect(files.slice(0, named.length).sort()).toEqual([...named].sort());
    expect(selection.moduleTests.sort()).toEqual([...named].sort());
    expect(files).toHaveLength(TARGETED_TEST_FILES_MAX);
    expect(selection.omittedByProximity.module).toEqual([]);
    expect(selection.omitted).toBeGreaterThan(0);
    expect(files).not.toContain('apps/server/test/unrelated-starter.test.ts');
  });

  it('names a module after its folder, but not after a central file or a generic file name (PM-1402)', () => {
    const kernel = 'apps/server/src/kernel/events.ts';
    const tree = [
      file(kernel, 'export const k = 1;'),
      file('apps/server/src/core/tasks/index.ts', 'export const i = 1;'),
      file('apps/server/test/events.test.ts'),
      file('apps/server/test/tasks.test.ts'),
    ];
    expect(select(tree, [kernel, 'apps/server/src/core/tasks/index.ts']).moduleTests).toEqual([
      'apps/server/test/tasks.test.ts',
    ]);
  });

  it('selects the visibility test when the timeline visibility rule changes (PM-1331)', () => {
    const tree = [
      file('packages/shared/src/domain/timeline-visibility.ts', 'export const visible = 1;'),
      file('apps/server/test/visibility.test.ts', "import { createApp } from './helpers/app-harness';"),
    ];
    expect(select(tree, ['packages/shared/src/domain/timeline-visibility.ts']).tests).toEqual([
      { workspace: 'apps/server', files: ['apps/server/test/visibility.test.ts'] },
    ]);
  });

  it.each([
    ['docs/HYBRID.md', ['deploy-cloud', 'deploy-aws', 'memory-profile']],
    ['docs/MACHINE-DEPENDENT.md', ['memory-profile']],
    ['docs/ARCHITECTURE.md', ['history-semantic-recall']],
    ['docs/EFFECT.md', ['architecture/effect-allowlist']],
  ])(
    'selects the tests that read %s by path, which is no documentation-only change (PM-1337)',
    (doc, names) => {
      const tree = [
        ...[
          'deploy-cloud',
          'deploy-aws',
          'memory-profile',
          'history-semantic-recall',
          'architecture/effect-allowlist',
          'other',
        ].map((name) => file(`apps/server/test/${name}.test.ts`)),
      ];
      const selection = select(tree, [doc]);
      expect(selection.kind).toBe('targeted');
      expect(selection.tests.flatMap((entry) => entry.files)).toEqual(
        expect.arrayContaining(names.map((name) => `apps/server/test/${name}.test.ts`)),
      );
      expect(selection.tests.flatMap((entry) => entry.files)).not.toContain('apps/server/test/other.test.ts');
      expect(selection.unmapped).toEqual([]);
    },
  );

  it('selects the snapshot-reading context test when a prompt snapshot changes, though it is no .snap file', () => {
    const tree = [file('apps/server/src/context/context-pack.test.ts')];
    const changed = 'apps/server/src/context/__snapshots__/analyst.role-instructions.txt';
    const selection = select(tree, [changed]);
    expect(selection.tests).toEqual([
      { workspace: 'apps/server', files: ['apps/server/src/context/context-pack.test.ts'] },
    ]);
    expect(selection.unmapped).toEqual([]);
  });

  it('selects a test that imports a changed test helper as a direct test (the app harness line of CLAUDE.md)', () => {
    const tree = [
      file('apps/server/test/helpers/app-harness.ts', 'export const createAppHarness = 1;'),
      file(
        'apps/server/test/uses-harness.test.ts',
        "import { createAppHarness } from './helpers/app-harness';",
      ),
    ];
    const selection = select(tree, ['apps/server/test/helpers/app-harness.ts']);
    expect(selection.tests[0]!.files).toEqual(['apps/server/test/uses-harness.test.ts']);
  });

  it('covers every server or web test that reads a repository file by path', () => {
    const unlisted = tracked.filter(
      (path) => isPathReader(path, readFileSync(`${root}${path}`, 'utf8')) && !listed(path),
    );
    expect(unlisted, 'add a rule to SELECTION_RULES in scripts/merge-test/handover.ts').toEqual([]);
  });

  it.each([
    ['apps/web/src/**/*.ts', 'apps/web/src/a/b.ts', true],
    ['apps/web/src/**/*.ts', 'apps/web/src/b.ts', true],
    ['apps/server/test/operator-*.test.ts', 'apps/server/test/operator-x.test.ts', true],
    ['apps/server/test/operator-*.test.ts', 'apps/server/test/sub/operator-x.test.ts', false],
    ['apps/server/', 'apps/server/src/a.ts', true],
    ['apps/server/', 'apps/web/src/a.ts', false],
  ])('matches the pattern %s against %s: %s', (pattern, path, expected) => {
    expect(matchesPattern(path, [pattern])).toBe(expected);
  });

  it('covers every test that reads its sources with import.meta.glob', () => {
    const unlisted = tracked.filter(
      (path) =>
        readFileSync(`${root}${path}`, 'utf8').includes(['import', 'meta', 'glob('].join('.')) &&
        !listed(path),
    );
    expect(unlisted, 'add a rule to SELECTION_RULES in scripts/merge-test/handover.ts').toEqual([]);
  });

  it('names only tests that exist', () => {
    const stale = SELECTION_RULES.flatMap(({ tests }) =>
      tests.filter((pattern) => !tracked.some((path) => matchesPattern(path, [pattern]))),
    );
    expect(stale).toEqual([]);
  });
});

describe('handover-check command', () => {
  afterEach(() => vi.restoreAllMocks());

  const ok: StepRun = { code: 0, signaled: false, output: '' };
  const tree = farTree(TARGETED_TEST_FILES_MAX + 5);
  const git = (args: string[]): string => {
    if (args[0] === 'merge-base') return 'abc\n';
    if (args[0] === 'diff')
      return args.includes('--diff-filter=A') || args.includes('--diff-filter=D')
        ? ''
        : 'apps/server/src/core/a.ts\0';
    if (args[0] === 'ls-files')
      return args.includes('--others') && !args.includes('--cached')
        ? ''
        : tree.map((f) => f.path).join('\0');
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  const io = (extra = {}) => ({
    git,
    readBase: () => tree,
    readWorktree: () => tree,
    deadCode: async () => ok,
    npm: async () => ok,
    ...extra,
  });
  const printed = () =>
    (console.log as unknown as { mock: { calls: string[][] } }).mock.calls.map(([line]) => line);

  it('prints the cap message and exits 0 when tests were left to the merge check', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const npm = vi.fn(async () => ok);
    expect(await runHandoverCheck([], io({ npm }))).toBe(0);
    expect(printed().join('\n')).toContain(
      `ran ${TARGETED_TEST_FILES_MAX} of ${TARGETED_TEST_FILES_MAX + 5} (cap ${TARGETED_TEST_FILES_MAX} cuts only the farther tests, the 0 nearest always run); the merge-test runs the other 5`,
    );
    expect(printed()).toContain('handover-check: the cap cut 5 test(s)');
    expect(printed().join('\n')).toMatch(
      /left out by proximity: 0 direct[^,]*, 0 selection-rule[^,]*, 0 module-name[^,]*, 0 name[^,]*, 5 /,
    );
    expect(npm).toHaveBeenCalled();
  });

  it('lists the steps and runs none of them with --dry-run', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const npm = vi.fn(async () => ok);
    const deadCode = vi.fn(async () => ok);
    expect(await runHandoverCheck(['--dry-run'], io({ npm, deadCode }))).toBe(0);
    expect(npm).not.toHaveBeenCalled();
    expect(deadCode).not.toHaveBeenCalled();
    expect(printed()).toContain('handover-check step: npm run dead-code');
  });

  it('exits 1 without running the tests when the dead-code check fails', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const npm = vi.fn(async () => ok);
    expect(await runHandoverCheck([], io({ npm, deadCode: async () => ({ ...ok, code: 1 }) }))).toBe(1);
    expect(npm).not.toHaveBeenCalled();
  });

  it('exits 1 when a step fails', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await runHandoverCheck([], io({ npm: async () => ({ ...ok, code: 1 }) }))).toBe(1);
  });

  it.each([[['--nope']], [['--base']], [['--base', '--dry-run']]])(
    'exits 2 on the usage error %j',
    async (argv) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(await runHandoverCheck(argv, io())).toBe(2);
    },
  );

  it('exits 2 when git has no merge base with main', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = (args: string[]) => {
      if (args[0] === 'merge-base') throw new Error('fatal');
      return git(args);
    };
    expect(await runHandoverCheck([], io({ git: failing }))).toBe(2);
  });
});
