import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMergeTest } from '../../../scripts/merge-test/run';
import { mergeTestStepKey, typecheckStep } from '../../../scripts/merge-test/steps';
import type { StepRun } from '../../../scripts/merge-test/steps';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));
const spawn = vi.mocked(spawnSync);
const ended = (stdout = '', status = 0) => ({ stdout, stderr: '', status, signal: null, pid: 1, output: [] });
const done = (output = '', code = 0): StepRun => ({ code, signaled: false, output });
const npm = vi.fn<(args: string[]) => Promise<StepRun>>();
const run = (argv: string[], exists: (file: string) => boolean = () => true) =>
  runMergeTest(argv, { npm, exists });
const npmCalls = () => npm.mock.calls.map(([args]) => args);
const gitCalls = () => spawn.mock.calls.map(([, args]) => args);

beforeEach(() => {
  // The members' sandboxes carry the PTY skip; the merge runs without it (PM-754).
  vi.stubEnv('PROJECTMAN_SKIP_PTY_TESTS', '');
  // The merge sandbox sets the worker count; the tests decide it themselves.
  vi.stubEnv('VITEST_MAX_FORKS', '');
});
afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('merge test runner', () => {
  const output = () => vi.spyOn(console, 'log').mockImplementation(() => undefined);
  /** HEAD with these parents, whose first-parent diff is `changed`. */
  function mockHead(parents: string, changed: string[] = []) {
    spawn.mockImplementation((_command, args) => {
      if (args?.[0] === 'rev-parse') return ended(args[1] === 'HEAD^{tree}' ? 'candidate-tree' : 'head');
      if (args?.[0] === 'rev-list') return ended(`head ${parents}`);
      if (args?.[0] === 'diff') return ended(changed.map((file) => `${file}\0`).join(''));
      throw new Error('unexpected command');
    });
    npm.mockResolvedValue(done());
  }
  it('stops at the first failed step and ends with the scope', async () => {
    const log = output();
    mockHead('first second');
    npm.mockResolvedValueOnce(done('', 7));
    expect(await run(['--all'])).toBe(7);
    expect(npm).toHaveBeenCalledTimes(1);
    expect(log.mock.calls).toEqual([
      ['merge-test scope: all (--all); modules: all; tests: all; fallback: --all'],
      ['merge-test workers: unset'],
      [expect.stringContaining('merge-test timing: {"index":0,"kind":"typecheck"')],
      [expect.stringContaining('merge-test timing: {"index":0,"kind":"typecheck"')],
      ['merge-test scope: all (--all); modules: all; tests: all; fallback: --all'],
    ]);
  });
  it.each([
    ['2', '2'],
    ['0', 'unset'],
    ['many', 'unset'],
  ])('prints the worker count of the steps (VITEST_MAX_FORKS %s)', async (forks, printed) => {
    const log = output();
    mockHead('first second');
    vi.stubEnv('VITEST_MAX_FORKS', forks);
    expect(await run(['--all'])).toBe(0);
    expect(log.mock.calls).toContainEqual([`merge-test workers: ${printed}`]);
  });
  it('runs everything by workspace when HEAD is not a merge', async () => {
    output();
    mockHead('parent');
    expect(await run([])).toBe(0);
    expect(npmCalls()).toEqual([
      ...['packages/shared', 'packages/templates', 'apps/feedback-widget', 'apps/server', 'apps/web'].map(
        (ws) => ['run', 'typecheck', '-w', ws, '--if-present'],
      ),
      ...['packages/shared', 'packages/templates', 'apps/feedback-widget', 'apps/server', 'apps/web'].map(
        (ws) => ['test', '-w', ws, '--if-present'],
      ),
    ]);
  });
  it.each([false, true])('reads the passed-key list unless --no-cache is present (%s)', async (noCache) => {
    const log = output();
    mockHead('first second');
    const root = mkdtempSync(resolve(tmpdir(), 'pm-cli-cache-'));
    const file = resolve(root, 'keys');
    const step = typecheckStep('packages/shared', true);
    const key = mergeTestStepKey('candidate-tree', step.args);
    writeFileSync(file, `${key}\n`);
    vi.stubEnv('PROJECTMAN_MERGE_TEST_PASSED_KEYS', file);
    try {
      expect(await run(['--all', ...(noCache ? ['--no-cache'] : [])])).toBe(0);
      expect(npm).toHaveBeenCalledTimes(noCache ? 10 : 9);
      expect(log.mock.calls.some(([line]) => String(line).startsWith('merge-test cached:'))).toBe(!noCache);
      expect(log.mock.calls).toContainEqual([`merge-test step passed: ${key}`]);
      expect(log.mock.calls.at(-1)?.[0]).toContain('merge-test scope:');
      expect(gitCalls()).toContainEqual(['rev-parse', 'HEAD^{tree}']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('lists exactly the workspaces of the repository', async () => {
    const root = fileURLToPath(new URL('../../..', import.meta.url));
    const found = ['packages', 'apps'].flatMap((dir) =>
      readdirSync(resolve(root, dir))
        .filter((name) => existsSync(resolve(root, dir, name, 'package.json')))
        .map((name) => `${dir}/${name}`),
    );
    output();
    mockHead('parent');
    await run([]);
    const tested = npmCalls()
      .filter((args) => args[0] === 'test')
      .map((args) => args[2]);
    expect(tested.sort()).toEqual(found.sort());
  });
  it('uses the first-parent diff and does no checks for docs only', async () => {
    output();
    mockHead('first second', ['docs/a.md', 'README.md']);
    expect(await run([])).toBe(0);
    expect(spawn).toHaveBeenCalledWith(
      'git',
      ['diff', '--name-only', '--no-renames', '-z', 'HEAD^1', 'HEAD'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    expect(npm).not.toHaveBeenCalled();
  });
  it('rejects invalid flags without running commands', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await run(['--unknown'])).toBe(2);
    expect(spawn).not.toHaveBeenCalled();
    expect(npm).not.toHaveBeenCalled();
  });
  describe('--shard', () => {
    const timingIndexes = (log: { mock: { calls: unknown[][] } }) =>
      log.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.startsWith('merge-test timing: '))
        .map((line) => JSON.parse(line.slice('merge-test timing: '.length)).index);
    it('runs its type check and a vitest shard of every workspace, timed by the original index', async () => {
      const log = output();
      mockHead('first second');
      expect(await run(['--all', '--shard', '2/4'])).toBe(0);
      expect(npmCalls()).toEqual([
        ['run', 'typecheck', '-w', 'packages/templates', '--if-present'],
        ...['packages/shared', 'packages/templates', 'apps/feedback-widget', 'apps/server', 'apps/web'].map(
          (ws) => ['test', '-w', ws, '--if-present', '--', '--shard=2/4'],
        ),
      ]);
      expect(timingIndexes(log)).toEqual([1, 5, 6, 7, 8, 9, 1, 5, 6, 7, 8, 9]);
    });
    it('reruns a failed file without the shard flags', async () => {
      output();
      mockHead('first second');
      vi.stubEnv('MERGE_TEST_FILES', JSON.stringify(['apps/server/test/b.test.ts']));
      npm.mockResolvedValueOnce(done(' FAIL  test/a.test.ts > suite > test\n', 1)).mockResolvedValue(done());
      expect(await run(['--shard', '1/2', '--files-from-env'])).toBe(0);
      expect(npmCalls().at(-1)).toEqual([
        'test',
        '-w',
        'apps/server',
        '--',
        resolve('apps/server/test/a.test.ts'),
      ]);
    });
    it('prints only the steps of the shard for a dry run, wherever the flag stands', async () => {
      const log = output();
      mockHead('');
      expect(await run(['--dry-run', 'root', '--shard', '4/4'])).toBe(0);
      expect(
        log.mock.calls.map(([line]) => line).filter((line) => line.startsWith('merge-test step:')),
      ).toEqual([
        'merge-test step: npm run typecheck -w apps/server --if-present',
        ...['packages/shared', 'packages/templates', 'apps/feedback-widget', 'apps/server', 'apps/web'].map(
          (ws) => `merge-test step: npm test -w ${ws} --if-present -- --shard=4/4`,
        ),
      ]);
      expect(npm).not.toHaveBeenCalled();
    });
    it.each([['0/4'], ['5/4'], ['1/9'], ['1.5/4'], ['a/4'], ['2'], ['-1/4']])(
      'refuses %s with a usage error',
      async (value) => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        expect(await run(['--shard', value])).toBe(2);
        expect(spawn).not.toHaveBeenCalled();
        expect(npm).not.toHaveBeenCalled();
      },
    );
    it.each([[['--shard']], [['--shard', '1/2', '--shard', '2/2']]])(
      'refuses %j with a usage error',
      async (argv) => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        expect(await run(argv)).toBe(2);
        expect(npm).not.toHaveBeenCalled();
      },
    );
  });
  describe('--files-from-env', () => {
    const files = JSON.stringify(['apps/server/test/b.test.ts', 'apps/web/src/a.test.tsx']);
    it('runs the listed files exactly as --files does', async () => {
      const log = output();
      mockHead('first second');
      vi.stubEnv('MERGE_TEST_FILES', files);
      expect(await run(['--files-from-env'])).toBe(0);
      expect(npmCalls()).toEqual([
        ['test', '-w', 'apps/server', '--', resolve('apps/server/test/b.test.ts')],
        ['test', '-w', 'apps/web', '--', resolve('apps/web/src/a.test.tsx')],
      ]);
      expect(log.mock.calls[0]?.[0]).toContain('merge-test scope: files (2)');
    });
    it.each([undefined, '', '  '])('is the plain scope mode when the list is %j', async (value) => {
      output();
      mockHead('first second', ['docs/a.md']);
      vi.stubEnv('MERGE_TEST_FILES', value);
      expect(await run(['--files-from-env'])).toBe(0);
      expect(npm).not.toHaveBeenCalled();
      expect(gitCalls()).toContainEqual(['diff', '--name-only', '--no-renames', '-z', 'HEAD^1', 'HEAD']);
    });
    it('shards the listed files too', async () => {
      output();
      mockHead('first second');
      vi.stubEnv('MERGE_TEST_FILES', files);
      expect(await run(['--no-cache', '--shard', '1/4', '--files-from-env'])).toBe(0);
      expect(npmCalls()[0]).toEqual([
        'test',
        '-w',
        'apps/server',
        '--',
        resolve('apps/server/test/b.test.ts'),
        '--shard=1/4',
      ]);
    });
    it.each([
      ['not json', 'is not valid JSON'],
      ['{"a":1}', 'not a JSON array'],
      ['[1]', 'not a JSON array'],
      ['[]', '1 to 20'],
      [JSON.stringify(Array.from({ length: 21 }, (_, i) => `apps/server/test/f${i}.test.ts`)), '1 to 20'],
      ['["scripts/a.test.ts"]', 'not of a known workspace'],
      ['["../etc/passwd"]', 'not of a known workspace'],
    ])('refuses the list %s with exit 2 and says why', async (value, reason) => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      vi.stubEnv('MERGE_TEST_FILES', value);
      expect(await run(['--files-from-env'])).toBe(2);
      expect(String(error.mock.calls[0]?.[0])).toContain(reason);
      expect(spawn).not.toHaveBeenCalled();
      expect(npm).not.toHaveBeenCalled();
    });
    it.each([
      [['--files-from-env', '--all']],
      [['--files-from-env', '--files', 'apps/server/test/a.test.ts']],
      [['--files', 'apps/server/test/a.test.ts', '--files-from-env']],
      [['--dry-run', '--files-from-env']],
    ])('refuses %j with a usage error', async (argv) => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      vi.stubEnv('MERGE_TEST_FILES', files);
      expect(await run(argv)).toBe(2);
      expect(npm).not.toHaveBeenCalled();
    });
  });
  const sourceTree = [
    ['apps/server/src/logging/index.ts', 'export const value = 1;'],
    ['apps/server/src/logging/index.test.ts', "import './index';"],
    ['apps/server/test/golden-path-example.test.ts', ''],
  ];
  function mockTrees(changed: string[], tree = sourceTree, after = tree, revision = 'HEAD') {
    let current = tree;
    spawn.mockImplementation((_command, args) => {
      if (args?.[0] === 'rev-parse') return ended(args[1] === 'HEAD^{tree}' ? 'candidate-tree' : revision);
      if (args?.[0] === 'rev-list') return ended('head first second');
      if (args?.[0] === 'diff') return ended(changed.join('\0') + '\0');
      if (args?.[0] === 'ls-tree') {
        current = args[3] === revision ? after : tree;
        return ended(current.map(([path], i) => `100644 blob oid${i}\t${path}\0`).join(''));
      }
      if (args?.[0] === 'cat-file')
        return {
          ...ended(),
          stdout: Buffer.concat(
            current.flatMap(([, source], i) => [
              Buffer.from(`oid${i} blob ${Buffer.byteLength(source!)}\n`),
              Buffer.from(source!),
              Buffer.from('\n'),
            ]),
          ),
          stderr: Buffer.alloc(0),
        };
      throw new Error('unexpected command');
    });
    npm.mockResolvedValue(done());
  }
  const sharedTree = [
    ...sourceTree,
    ['packages/shared/src/index.ts', "export * from './leaf';\nexport * from './other';"],
    ['packages/shared/src/leaf.ts', 'export const Value = 1;'],
    ['packages/shared/src/other.ts', 'export const Other = 1;'],
    ['apps/server/src/logging/shared.ts', "import { Value } from '@projectman/shared';"],
    ['apps/web/src/value.ts', "import { Other } from '@projectman/shared';"],
  ];
  const sharedChecks = [
    'packages/shared',
    'packages/templates',
    'apps/feedback-widget',
    'apps/server',
    'apps/web',
  ].map((ws) => ['run', 'typecheck', '-w', ws, '--if-present']);
  it('runs every type check, shared tests and only affected server tests', async () => {
    const log = output();
    mockTrees(['packages/shared/src/leaf.ts'], sharedTree);
    expect(await run([])).toBe(0);
    expect(npmCalls()).toEqual([
      ...sharedChecks,
      ['test', '-w', 'packages/shared', '--if-present'],
      [
        'test',
        '-w',
        'apps/server',
        '--if-present',
        '--',
        resolve('apps/server/src/logging/index.test.ts'),
        resolve('apps/server/test/golden-path-example.test.ts'),
      ],
    ]);
    expect(log.mock.calls[0]?.[0]).toBe(
      'merge-test scope: shared (exports: 1); workspaces: packages/shared, apps/server; typecheck: all; fallback: none; selected tests: apps/server/src/logging/index.test.ts, apps/server/test/golden-path-example.test.ts',
    );
    expect(log.mock.calls[0]).toEqual(log.mock.calls.at(-1));
    expect(
      gitCalls()
        .filter((args) => args?.[0] === 'ls-tree')
        .every((args) => args?.includes('packages/templates')),
    ).toBe(true);
  });
  it('skips server tests without a server consumer or server changes', async () => {
    output();
    const files = sharedTree.filter(([path]) => path !== 'apps/server/src/logging/shared.ts');
    mockTrees(['packages/shared/src/leaf.ts'], files);
    expect(await run([])).toBe(0);
    expect(npmCalls()).toEqual([...sharedChecks, ['test', '-w', 'packages/shared', '--if-present']]);
  });
  it('selects server tests for an export consumed only by scripts', async () => {
    const log = output();
    const scriptTree = [
      ...sharedTree.filter(([path]) => path !== 'apps/server/src/logging/shared.ts'),
      ['scripts/live/watch.ts', "import { Value } from '@projectman/shared';"],
      [
        'apps/server/test/scripts-only.test.ts',
        "import '../../../scripts/live/watch'; import '../src/logging';",
      ],
    ];
    mockTrees(['packages/shared/src/leaf.ts'], scriptTree);
    expect(await run([])).toBe(0);
    expect(npmCalls()).toEqual([
      ...sharedChecks,
      ['test', '-w', 'packages/shared', '--if-present'],
      [
        'test',
        '-w',
        'apps/server',
        '--if-present',
        '--',
        resolve('apps/server/test/golden-path-example.test.ts'),
        resolve('apps/server/test/scripts-only.test.ts'),
      ],
    ]);
    expect(
      gitCalls()
        .filter((args) => args?.[0] === 'ls-tree')
        .map((args) => args?.slice(3)),
    ).toEqual(
      ['HEAD^1', 'HEAD'].map((revision) => [
        revision,
        '--',
        'packages/shared',
        'packages/templates',
        'apps/feedback-widget',
        'apps/server',
        'apps/web',
        'scripts',
      ]),
    );
    expect(log.mock.calls[0]?.[0]).toContain('fallback: none');
  });
  it('keeps own web changes and widget consumers from either revision', async () => {
    output();
    const before = [
      ...sharedTree,
      ['apps/web/src/old.ts', "export { Value } from '@projectman/shared';"],
      ['apps/feedback-widget/src/a.ts', "import { Value } from '@projectman/shared';"],
    ];
    mockTrees(['packages/shared/src/leaf.ts', 'apps/web/src/local.ts'], before, sharedTree);
    expect(await run([])).toBe(0);
    expect(
      npmCalls()
        .filter((args) => args[0] === 'test')
        .map((args) => args[2]),
    ).toEqual(['packages/shared', 'apps/feedback-widget', 'apps/server', 'apps/web']);
  });
  it('keeps the full run for own widget changes mixed with shared changes', async () => {
    const log = output();
    mockTrees(['packages/shared/src/leaf.ts', 'apps/feedback-widget/src/a.ts'], sharedTree);
    expect(await run([])).toBe(0);
    expect(npmCalls()).toHaveLength(10);
    expect(log.mock.calls[0]?.[0]).toContain('fallback: apps/feedback-widget/src/a.ts');
  });
  it('runs own server changes even without a shared server consumer', async () => {
    output();
    mockTrees(
      ['packages/shared/src/leaf.ts', 'apps/server/src/logging/index.ts'],
      sharedTree.filter(([path]) => path !== 'apps/server/src/logging/shared.ts'),
    );
    expect(await run([])).toBe(0);
    expect(
      npmCalls()
        .filter((args) => args[0] === 'test')
        .map((args) => args[2]),
    ).toEqual(['packages/shared', 'apps/server']);
  });
  it('keeps server fallback local while checking all types for shared changes', async () => {
    const log = output();
    mockTrees(['packages/shared/src/leaf.ts', 'apps/server/test/fixtures/a.ts'], sharedTree);
    expect(await run([])).toBe(0);
    expect(npmCalls()).toEqual([
      ...sharedChecks,
      ['test', '-w', 'packages/shared', '--if-present'],
      ['test', '-w', 'apps/server', '--if-present'],
    ]);
    expect(log.mock.calls[0]?.[0]).toContain('fallback: test support changed');
  });
  it('runs everything when a template consumes an affected export', async () => {
    const log = output();
    mockTrees(
      ['packages/shared/src/leaf.ts'],
      [...sharedTree, ['packages/templates/src/a.ts', "import { Value } from '@projectman/shared';"]],
    );
    expect(await run([])).toBe(0);
    expect(npmCalls()).toHaveLength(10);
    expect(log.mock.calls[0]?.[0]).toContain('fallback: shared consumer in packages/templates');
  });
  it('runs everything with an explicit shared-analysis fallback reason', async () => {
    const log = output();
    mockTrees(
      ['packages/shared/src/leaf.ts'],
      sharedTree.map(([path, source]) => [
        path!,
        path === 'packages/shared/src/leaf.ts' ? 'export default 1;' : source!,
      ]),
    );
    expect(await run([])).toBe(0);
    expect(npmCalls()).toHaveLength(10);
    expect(log.mock.calls[0]?.[0]).toContain('fallback: unsupported shared export');
  });
  it('runs only shared tests for its non-source changes, with all type checks', async () => {
    output();
    mockTrees(['packages/shared/test/a.test.ts'], sharedTree);
    expect(await run([])).toBe(0);
    expect(npmCalls()).toEqual([...sharedChecks, ['test', '-w', 'packages/shared', '--if-present']]);
  });
  it('reads both trees as blobs and runs modules followed by the web workspace', async () => {
    const log = output();
    mockTrees(['apps/server/src/logging/index.ts', 'apps/web/src/a.ts']);
    expect(await run([])).toBe(0);
    expect(npmCalls()).toEqual([
      ['run', 'typecheck', '-w', 'apps/server'],
      [
        'test',
        '-w',
        'apps/server',
        '--',
        resolve('apps/server/src/logging/index.test.ts'),
        resolve('apps/server/test/golden-path-example.test.ts'),
      ],
      ['run', 'typecheck', '-w', 'apps/web'],
      ['test', '-w', 'apps/web'],
    ]);
    expect(
      gitCalls()
        .filter((args) => args?.[0] === 'ls-tree')
        .map((args) => args?.slice(3)),
    ).toEqual(['HEAD^1', 'HEAD'].map((rev) => [rev, '--', 'apps/server', 'scripts']));
    expect(log.mock.calls[0]?.[0]).toContain('tests: 2');
    expect(log.mock.calls[0]).toEqual(log.mock.calls.at(-1));
  });
  it('keeps full workspace fallback with its reason for fixture changes', async () => {
    const log = output();
    mockTrees(['apps/server/test/fixtures/a.ts']);
    expect(await run([])).toBe(0);
    expect(npmCalls()).toEqual([
      ['run', 'typecheck', '-w', 'apps/server'],
      ['test', '-w', 'apps/server'],
    ]);
    expect(log.mock.calls[0]?.[0]).toContain('fallback: test support changed');
  });
  it('keeps script edges when shared and server changes are combined', async () => {
    const log = output();
    const tree = [
      ...sharedTree,
      ['scripts/a.ts', "import { Value } from '@projectman/shared';"],
      ['apps/server/test/script.test.ts', "import '../../../scripts/a';"],
    ];
    mockTrees(['packages/shared/src/leaf.ts'], tree);
    expect(await run([])).toBe(0);
    expect(log.mock.calls[0]?.[0]).toContain('apps/server/test/script.test.ts');
    expect(log.mock.calls[0]?.[0]).not.toContain('fallback: unresolved');
  });
  it.each(['contracts', 'config'])(
    'follows a changed %s source through a script into its test',
    async (module) => {
      const log = output();
      const path = `apps/server/src/${module}/example.ts`;
      const tree = [
        ...sourceTree,
        [path, 'export const value = 1;'],
        ['scripts/example.ts', `import '../${path.slice(0, -3)}';`],
        ['apps/server/test/script.test.ts', "import '../../../scripts/example';"],
      ];
      mockTrees([path], tree);
      expect(await run([])).toBe(0);
      expect(log.mock.calls[0]?.[0]).toContain(`modules (${module})`);
      expect(npmCalls().flat()).toContain(resolve('apps/server/test/script.test.ts'));
      expect(npmCalls()).toHaveLength(2);
    },
  );
  it('selects a changed script without running an unrelated source test', async () => {
    const log = output();
    mockTrees(
      ['scripts/example.ts'],
      [
        ...sourceTree,
        ['scripts/example.ts', 'export const value = 1;'],
        ['apps/server/test/script.test.ts', "import '../../../scripts/example';"],
      ],
    );
    expect(await run([])).toBe(0);
    expect(log.mock.calls[0]?.[0]).toContain('scope: modules (); tests: 2;');
    expect(npmCalls().flat()).toContain(resolve('apps/server/test/script.test.ts'));
    expect(npmCalls().flat()).not.toContain(resolve('apps/server/src/logging/index.test.ts'));
  });
  it.each(
    ['HEAD', 'historic'].flatMap((revision) => [false, true].map((noCache) => ({ revision, noCache }))),
  )(
    'prints the commands for $revision without executing any check (noCache: $noCache)',
    async ({ revision, noCache }) => {
      const log = output();
      mockTrees(['apps/server/src/logging/index.ts'], sourceTree, sourceTree, revision);
      expect(
        await run([
          '--dry-run',
          ...(revision === 'HEAD' ? [] : [revision]),
          ...(noCache ? ['--no-cache'] : []),
        ]),
      ).toBe(0);
      expect(npm).not.toHaveBeenCalled();
      expect(log.mock.calls.map(([line]) => line)).toEqual([
        expect.stringContaining('merge-test scope: modules (logging); tests: 2;'),
        'merge-test step: npm run typecheck -w apps/server',
        `merge-test step: npm test -w apps/server -- ${resolve('apps/server/src/logging/index.test.ts')} ${resolve('apps/server/test/golden-path-example.test.ts')}`,
      ]);
      expect(
        gitCalls()
          .filter((args) => args?.[0] === 'ls-tree')
          .map((args) => args?.[3]),
      ).toEqual([`${revision}^1`, revision]);
      expect(gitCalls()).toContainEqual([
        'diff',
        '--name-only',
        '--no-renames',
        '-z',
        `${revision}^1`,
        revision,
      ]);
      expect(gitCalls().some((args) => args?.[0] === 'checkout')).toBe(false);
      expect(gitCalls()).not.toContainEqual(['rev-parse', 'HEAD^{tree}']);
    },
  );
  it('reports all steps for a dry run of a non-merge commit, including a root commit', async () => {
    const log = output();
    mockHead('');
    expect(await run(['--dry-run', 'root'])).toBe(0);
    expect(log.mock.calls[0]?.[0]).toContain('all (root has no second parent)');
    expect(log.mock.calls.filter(([line]) => line.startsWith('merge-test step:'))).toHaveLength(10);
    expect(npm).not.toHaveBeenCalled();
    expect(gitCalls().some((args) => args?.[0] === 'diff')).toBe(false);
  });
  it('returns a git error from a dry run without executing checks', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    spawn.mockReturnValue({ ...ended('', 128), stderr: 'unknown revision' });
    expect(await run(['--dry-run', 'missing'])).toBe(2);
    expect(error).toHaveBeenCalledWith('merge-test: unknown revision');
    expect(npm).not.toHaveBeenCalled();
  });
  it.each([
    ['--dry-run', 'a', 'b'],
    ['--dry-run', '--all'],
    ['--dry-run', '--files'],
    ['--all', '--dry-run'],
    ['--dry-run', ''],
    ['--dry-run', '--help'],
  ])('rejects an invalid dry run %j before git', async (...argv) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await run(argv)).toBe(2);
    expect(spawn).not.toHaveBeenCalled();
    expect(npm).not.toHaveBeenCalled();
  });
  it('runs only the filtered cloud checks for a cloud-only first-parent diff', async () => {
    const log = output();
    mockTrees(['scripts/cloud/a.ts', 'deploy/aws/b.tf', 'docs/CLOUD.md']);
    expect(await run([])).toBe(0);
    expect(npmCalls()).toEqual([
      ['run', 'typecheck', '-w', 'apps/server'],
      [
        'test',
        '-w',
        'apps/server',
        '--',
        resolve('apps/server/test/cloud-'),
        resolve('apps/server/test/deploy-'),
        resolve('apps/server/test/release-'),
        resolve('apps/server/test/architecture'),
        resolve('apps/server/test/merge-test-'),
        resolve('apps/server/test/control-relay.integration.test.ts'),
        resolve('apps/server/test/control-socket.integration.test.ts'),
      ],
    ]);
    expect(gitCalls().some((args) => args?.[0] === 'ls-tree')).toBe(false);
    expect(log.mock.calls.filter(([line]) => String(line).startsWith('merge-test scope:'))).toHaveLength(2);
    expect(log.mock.calls[0]?.[0]).toContain('merge-test scope: cloud');
    expect(log.mock.calls[0]).toEqual(log.mock.calls.at(-1));
  });
  it('stops the cloud branch on its first failed check with its exit code', async () => {
    const log = output();
    mockTrees(['scripts/cloud/a.ts']);
    npm.mockResolvedValue(done('', 5));
    expect(await run([])).toBe(5);
    expect(npm).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]).toEqual(log.mock.calls.at(-1));
  });
  it('keeps the full run for a cloud diff that also changes shared code', async () => {
    const log = output();
    mockTrees(['scripts/cloud/a.ts', 'packages/shared/src/a.ts']);
    expect(await run([])).toBe(0);
    expect(npmCalls()).toHaveLength(10);
    expect(npmCalls()[0]).toEqual(['run', 'typecheck', '-w', 'packages/shared', '--if-present']);
    expect(log.mock.calls[0]?.[0]).toContain('merge-test scope: all');
  });
  it('stops the module branch on its first failed check', async () => {
    output();
    mockTrees(['apps/server/src/logging/index.ts']);
    npm.mockResolvedValue(done('', 9));
    expect(await run([])).toBe(9);
    expect(npm).toHaveBeenCalledTimes(1);
  });
  describe('with the members’ PTY skip set (PM-754)', () => {
    const refused = () => {
      vi.stubEnv('PROJECTMAN_SKIP_PTY_TESTS', '1');
      return vi.spyOn(console, 'error').mockImplementation(() => undefined);
    };
    it.each([
      ['all', ['apps/server/src/logging/index.ts', 'packages/shared/src/a.ts']],
      ['cloud', ['scripts/cloud/a.ts']],
      ['modules', ['apps/server/src/logging/index.ts']],
      ['server workspace fallback', ['apps/server/test/helpers/a.ts']],
    ])('exits 2 before any check for the %s scope', async (_name, changed) => {
      output();
      mockTrees(changed);
      const error = refused();
      expect(await run([])).toBe(2);
      expect(error).toHaveBeenCalledWith(
        'merge-test: server checks require PTY and Unix socket integration tests',
      );
      expect(npm).not.toHaveBeenCalled();
    });
    it('exits 2 for --all too', async () => {
      output();
      mockHead('first second');
      const error = refused();
      expect(await run(['--all'])).toBe(2);
      expect(error).toHaveBeenCalledTimes(1);
      expect(npm).not.toHaveBeenCalled();
    });
    it('keeps the web-only and the none scopes unchanged', async () => {
      output();
      refused();
      mockTrees(['apps/web/src/a.ts']);
      expect(await run([])).toBe(0);
      expect(npmCalls()).toEqual([
        ['run', 'typecheck', '-w', 'apps/web'],
        ['test', '-w', 'apps/web'],
      ]);
      npm.mockClear();
      mockTrees(['docs/a.md']);
      expect(await run([])).toBe(0);
      expect(npm).not.toHaveBeenCalled();
    });
  });
  it('fails closed for malformed batch output', async () => {
    output();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockTrees(['apps/server/src/logging/index.ts']);
    const original = spawn.getMockImplementation()!;
    spawn.mockImplementation((...args) =>
      args[1]?.[0] === 'cat-file'
        ? { ...ended(), stdout: Buffer.from('missing\n'), stderr: Buffer.alloc(0) }
        : original(...args),
    );
    expect(await run([])).toBe(2);
    expect(npm).not.toHaveBeenCalled();
  });
  it('returns 127 when npm cannot start', async () => {
    output();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockHead('first second');
    npm.mockRejectedValue(new Error('spawn npm ENOENT'));
    expect(await run(['--all'])).toBe(127);
  });
});

describe('the rerun of failed test files', () => {
  const output = () => vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const serverFail = ' FAIL  test/a.test.ts > suite > test\n';
  /** A merge of `parents` that changed `changed`; the server test step fails with `serverFail`. */
  function mockMerge(changed: string[], rerun: StepRun = done()) {
    spawn.mockImplementation((_command, args) => {
      if (args?.[0] === 'rev-list') return ended('head first second');
      if (args?.[0] === 'rev-parse') return ended('candidate-tree');
      if (args?.[0] === 'diff') return ended(changed.map((file) => `${file}\0`).join(''));
      throw new Error('unexpected command');
    });
    npm.mockImplementation(async (args) => {
      if (args.join(' ') === 'test -w apps/server --if-present') return done(serverFail, 1);
      if (args.includes('--')) return rerun;
      return done();
    });
  }
  it('passes a flaky file and prints its marker before the closing scope line', async () => {
    const log = output();
    mockMerge(['packages/shared/src/a.ts']);
    expect(await run(['--all'])).toBe(0);
    const lines = log.mock.calls.map(([line]) => line);
    expect(lines.at(-2)).toBe('merge-test flaky: apps/server/test/a.test.ts');
    expect(lines.at(-1)).toContain('merge-test scope:');
    expect(npmCalls().filter((args) => args.includes('--'))).toEqual([
      ['test', '-w', 'apps/server', '--', resolve('apps/server/test/a.test.ts')],
    ]);
    // The web test step still ran after the rerun.
    expect(npmCalls().at(-1)).toEqual(['test', '-w', 'apps/web', '--if-present']);
  });
  it('fails with a marker when the file fails again', async () => {
    const log = output();
    mockMerge(['packages/shared/src/a.ts'], done(serverFail, 1));
    expect(await run(['--all'])).toBe(1);
    expect(log.mock.calls.map(([line]) => line)).toContain('merge-test failed: apps/server/test/a.test.ts');
    expect(npmCalls().at(-1)).toEqual([
      'test',
      '-w',
      'apps/server',
      '--',
      resolve('apps/server/test/a.test.ts'),
    ]);
  });
  it('does not rerun a test file the merge changed', async () => {
    const log = output();
    mockMerge(['apps/server/test/a.test.ts']);
    expect(await run(['--all'])).toBe(1);
    expect(npmCalls().some((args) => args.includes('--'))).toBe(false);
    expect(log.mock.calls.map(([line]) => line)).toContain('merge-test failed: apps/server/test/a.test.ts');
  });
  it('does not rerun when HEAD has no parent to compare with', async () => {
    output();
    spawn.mockImplementation((_command, args) => {
      if (args?.[0] === 'rev-list') return ended('head');
      if (args?.[0] === 'rev-parse') return ended('candidate-tree');
      throw new Error('unexpected command');
    });
    npm.mockImplementation(async (args) =>
      args.join(' ') === 'test -w apps/server --if-present' ? done(serverFail, 1) : done(),
    );
    expect(await run([])).toBe(1);
    expect(npmCalls().some((args) => args.includes('--'))).toBe(false);
  });
});

describe('the --files mode', () => {
  const output = () => vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const fail = ' FAIL  test/a.test.ts > suite > test\n';
  function mockHead(parents: string, changed: string[] = []) {
    spawn.mockImplementation((_command, args) => {
      if (args?.[0] === 'rev-list') return ended(`head ${parents}`);
      if (args?.[0] === 'rev-parse') return ended('candidate-tree');
      if (args?.[0] === 'diff') return ended(changed.map((file) => `${file}\0`).join(''));
      throw new Error('unexpected command');
    });
    npm.mockResolvedValue(done());
  }
  it('runs the given files grouped by workspace, with no type check', async () => {
    const log = output();
    mockHead('first second');
    expect(
      await run([
        '--files',
        'apps/web/src/a.test.tsx',
        'apps/server/test/b.test.ts',
        'apps/server/test/c.test.ts',
      ]),
    ).toBe(0);
    expect(npmCalls()).toEqual([
      [
        'test',
        '-w',
        'apps/server',
        '--',
        resolve('apps/server/test/b.test.ts'),
        resolve('apps/server/test/c.test.ts'),
      ],
      ['test', '-w', 'apps/web', '--', resolve('apps/web/src/a.test.tsx')],
    ]);
    expect(log.mock.calls[0]?.[0]).toContain('merge-test scope: files (3)');
    expect(log.mock.calls[0]).toEqual(log.mock.calls.at(-1));
  });
  it('skips an absent file with a line and runs the others', async () => {
    const log = output();
    mockHead('first second');
    expect(
      await run(['--files', 'apps/server/test/new.test.ts', 'apps/server/test/old.test.ts'], (file) =>
        file.endsWith('old.test.ts'),
      ),
    ).toBe(0);
    expect(log.mock.calls.map(([line]) => line)).toContain(
      'merge-test skipped (absent): apps/server/test/new.test.ts',
    );
    expect(npmCalls()).toEqual([
      ['test', '-w', 'apps/server', '--', resolve('apps/server/test/old.test.ts')],
    ]);
  });
  it('ends with 0 and calls no npm when every file is absent', async () => {
    const log = output();
    mockHead('first second');
    expect(await run(['--files', 'apps/server/test/new.test.ts'], () => false)).toBe(0);
    expect(npm).not.toHaveBeenCalled();
    expect(log.mock.calls.map(([line]) => line)).toContain(
      'merge-test skipped (absent): apps/server/test/new.test.ts',
    );
  });
  it('reruns a failed file once and marks it flaky', async () => {
    const log = output();
    mockHead('first second', ['packages/shared/src/x.ts']);
    npm.mockResolvedValueOnce(done(fail, 1)).mockResolvedValue(done());
    expect(await run(['--files', 'apps/server/test/a.test.ts'])).toBe(0);
    expect(log.mock.calls.map(([line]) => line)).toContain('merge-test flaky: apps/server/test/a.test.ts');
    expect(npm).toHaveBeenCalledTimes(2);
  });
  it('does not rerun a file the two-parent HEAD changed', async () => {
    const log = output();
    mockHead('first second', ['apps/server/test/a.test.ts']);
    npm.mockResolvedValue(done(fail, 1));
    expect(await run(['--files', 'apps/server/test/a.test.ts'])).toBe(1);
    expect(npm).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.map(([line]) => line)).toContain('merge-test failed: apps/server/test/a.test.ts');
  });
  it('has no merge condition when HEAD is not a merge', async () => {
    output();
    mockHead('parent', ['apps/server/test/a.test.ts']);
    npm.mockResolvedValueOnce(done(fail, 1)).mockResolvedValue(done());
    expect(await run(['--files', 'apps/server/test/a.test.ts'])).toBe(0);
    expect(npm).toHaveBeenCalledTimes(2);
    expect(gitCalls().some((args) => args?.[0] === 'diff')).toBe(false);
  });
  it.each([
    ['--files'],
    ['--all', '--files', 'apps/server/test/a.test.ts'],
    ['--files', 'apps/server/test/a.test.ts', '--all'],
    ['--files', 'scripts/a.test.ts'],
    ['--files', 'apps/serverless/a.test.ts'],
    ['--files', '/etc/passwd'],
    ['--files', 'apps/server/../web/a.test.ts'],
    ['--files', '.git/config'],
  ])('refuses %j with a usage error', async (...argv) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await run(argv)).toBe(2);
    expect(spawn).not.toHaveBeenCalled();
    expect(npm).not.toHaveBeenCalled();
  });
});
