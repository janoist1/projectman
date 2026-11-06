import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TARGETED_TEST_FILES_MAX } from '@projectman/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handoverSelection, PATH_READ_TESTS } from '../../../scripts/merge-test/handover';
import { runHandoverCheck } from '../../../scripts/merge-test/handover-run';
import type { MergeTestFile } from '../../../scripts/merge-test/impact';
import type { StepRun } from '../../../scripts/merge-test/steps';

const file = (path: string, source = ''): MergeTestFile => ({ path, source });
const select = (tree: MergeTestFile[], changed: string[], added: string[] = [], deleted: string[] = []) =>
  handoverSelection({ changed, added, deleted, before: tree, after: tree });

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
      'apps/web/src/i18n/i18n.test.ts',
      'apps/web/src/features/x.test.ts',
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

  it('caps the run and reports how many tests it left to the merge check', () => {
    const tests = Array.from({ length: TARGETED_TEST_FILES_MAX + 5 }, (_, i) =>
      file(`apps/server/src/core/t${String(i).padStart(2, '0')}.test.ts`, "import { a } from './a';"),
    );
    const tree = [file('apps/server/src/core/a.ts', 'export const a = 1;'), ...tests];
    const selection = select(tree, ['apps/server/src/core/a.ts']);
    expect(selection.tests[0]!.files).toHaveLength(TARGETED_TEST_FILES_MAX);
    expect(selection).toMatchObject({
      reached: TARGETED_TEST_FILES_MAX + 5,
      cap: TARGETED_TEST_FILES_MAX,
      omitted: 5,
    });
  });

  it('selects nothing but the dead-code check for a documentation-only change', () => {
    expect(select(teamToolTree, ['docs/ARCHITECTURE.md'])).toMatchObject({
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

describe('path-read tests', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const tracked = execFileSync('git', ['ls-files', 'apps', 'packages'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((path) => /\.test\.tsx?$/.test(path));
  const listed = (path: string) =>
    PATH_READ_TESTS.some(({ test }) => (test.endsWith('/') ? path.startsWith(test) : path === test));

  it('lists every test that reads its sources with import.meta.glob', () => {
    const unlisted = tracked.filter(
      (path) =>
        readFileSync(`${root}${path}`, 'utf8').includes(['import', 'meta', 'glob('].join('.')) &&
        !listed(path),
    );
    expect(unlisted, 'add the test to PATH_READ_TESTS in scripts/merge-test/handover.ts').toEqual([]);
  });

  it('lists only tests that exist', () => {
    const stale = PATH_READ_TESTS.filter(
      ({ test }) =>
        !tracked.some((path) => listed(path) && (test.endsWith('/') ? path.startsWith(test) : path === test)),
    );
    expect(stale.map(({ test }) => test)).toEqual([]);
  });
});

describe('handover-check command', () => {
  afterEach(() => vi.restoreAllMocks());

  const ok: StepRun = { code: 0, signaled: false, output: '' };
  const tree = [
    file('apps/server/src/core/a.ts', 'export const a = 1;'),
    ...Array.from({ length: TARGETED_TEST_FILES_MAX + 5 }, (_, i) =>
      file(`apps/server/src/core/t${String(i).padStart(2, '0')}.test.ts`, "import { a } from './a';"),
    ),
  ];
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
      `ran ${TARGETED_TEST_FILES_MAX} of ${TARGETED_TEST_FILES_MAX + 5} (cap ${TARGETED_TEST_FILES_MAX}); the merge-test runs the other 5`,
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
