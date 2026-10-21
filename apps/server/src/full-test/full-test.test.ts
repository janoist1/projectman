import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fullTestSandbox } from '../runtime/sessions';
import {
  failedFiles,
  failureReport,
  FAILURE_REPORT_CHARS,
  outputTail,
  OutputTail,
  OUTPUT_LIMIT_BYTES,
  OUTPUT_TAIL_CHARS,
  passedOutputTail,
  stripAnsi,
} from './output';
import {
  canonicalRoot,
  closedStdin,
  fullTestEnv,
  installerSettings,
  niceSrtCommand,
  runDirOf,
  runPaths,
  srtSettings,
} from './sandbox';

describe('the output of a full test', () => {
  it('removes ANSI sequences', () => {
    expect(stripAnsi('\u001b[31mFAIL\u001b[39m a\u001b]0;title\u0007b')).toBe('FAIL ab');
  });

  it('names the files of vitest FAIL lines once, with or without a project name', () => {
    const output = [
      ' ✓ test/a.test.ts (3 tests)',
      '\u001b[41m FAIL \u001b[49m test/b.test.ts > suite > case',
      ' FAIL  |server| test/c.test.ts [ test/c.test.ts ]',
      ' FAIL  test/b.test.ts > suite > other case',
      'FAIL: not a vitest line is still a name-less colon',
    ].join('\n');
    expect(failedFiles(output)).toEqual(['test/b.test.ts', 'test/c.test.ts']);
  });

  it('prefers the merge-test failed marker lines to vitest FAIL lines', () => {
    const output = [
      ' FAIL  test/a.test.ts > x',
      ' FAIL  test/b.test.ts > x',
      'merge-test failed: apps/server/test/b.test.ts',
      'merge-test failed: apps/server/test/b.test.ts',
      'merge-test failed: /etc/passwd',
      'merge-test flaky: apps/web/src/c.test.ts',
    ].join('\n');
    expect(failedFiles(output)).toEqual(['apps/server/test/b.test.ts']);
    expect(failedFiles('merge-test flaky: apps/web/src/c.test.ts')).toEqual([]);
  });

  it('reports the flaky marker lines of a passed run, else nothing', () => {
    const output =
      '\u001b[2mmerge-test flaky: a/x.test.ts\u001b[0m\r\nnoise\nmerge-test flaky: a/y.test.ts\nmerge-test failed: a/z.test.ts\n';
    expect(passedOutputTail(output)).toBe('merge-test flaky: a/x.test.ts\nmerge-test flaky: a/y.test.ts\n');
    expect(passedOutputTail('all green\n')).toBe('');
  });

  it('names no file for a failure that is not a test, and at most 20', () => {
    expect(failedFiles('src/a.ts(1,1): error TS2322: Type')).toEqual([]);
    const many = Array.from({ length: 30 }, (_, i) => ` FAIL  test/f${i}.test.ts > x`).join('\n');
    expect(failedFiles(many)).toHaveLength(20);
  });

  it('shows vitest\'s "Failed Tests" section from its start, else the end of the output', () => {
    const output = `${'noise\n'.repeat(3000)}\n⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯\n FAIL  test/a.test.ts > x\nAssertionError\n${'tail\n'.repeat(500)}`;
    const shown = outputTail(output);
    expect(shown.startsWith('⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯')).toBe(true);
    expect(shown.length).toBeLessThanOrEqual(OUTPUT_TAIL_CHARS);
    const plain = outputTail(`${'x'.repeat(10_000)}END`);
    expect(plain.endsWith('END')).toBe(true);
    expect(plain).toHaveLength(OUTPUT_TAIL_CHARS);
  });

  describe('failureReport', () => {
    const vitestRun = (failed: boolean, errors = false) =>
      [
        ' RUN  v4.0.0 /repo/apps/web',
        ...Array.from({ length: 300 }, (_, i) => ` ✓ test/ok${i}.test.ts (3 tests) 4ms`),
        ...(failed
          ? [
              '⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯',
              ' FAIL  test/web.test.tsx > renders',
              'AssertionError: expected 1 to be 2',
            ]
          : []),
        ...(errors ? ['⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯', 'Error: boom in a timer'] : []),
        ' Test Files  1 failed | 299 passed (300)',
        '      Tests  1 failed | 900 passed (901)',
        ...(errors ? ['     Errors  2 errors'] : []),
        '   Duration  50s',
      ].join('\n');

    it('keeps the failure blocks and totals per workspace, not the start of the output', () => {
      const output = [
        'merge-test scope: all (--all)',
        '> @projectman/shared@0.0.0 test',
        '> vitest run',
        ' RUN  v4.0.0 /repo/packages/shared',
        ' Test Files  10 passed (10)',
        '      Tests  50 passed (50)',
        '> @projectman/web@0.0.0 test',
        '> vitest run',
        vitestRun(true, true),
        'npm error Lifecycle script `test` failed',
      ].join('\n');
      const report = failureReport(output);
      expect(report).toContain('## @projectman/shared test');
      expect(report).toContain('Tests  50 passed (50)');
      expect(report).toContain('## @projectman/web test');
      expect(report).toContain('FAIL  test/web.test.tsx > renders');
      expect(report).toContain('Unhandled Errors');
      expect(report).toContain('Errors  2 errors');
      expect(report).not.toContain('ok12.test.ts');
      expect(report.length).toBeLessThanOrEqual(FAILURE_REPORT_CHARS);
    });

    it('keeps server failures when a successful web run follows with a long output', () => {
      const report = failureReport(
        [
          '> @projectman/server@0.0.0 test',
          '> vitest run',
          ' RUN  v4.0.0 /repo/apps/server',
          '⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯',
          ' FAIL  src/domain/screenshot-runs.test.ts > take_screenshots > starts the run',
          'TypeError: Cannot read properties of undefined',
          '⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯',
          'Error: The scenario shots/login.mjs is not a file.',
          ' Test Files  1 failed | 299 passed (300)',
          '      Tests  1 failed | 900 passed (901)',
          '     Errors  2 errors',
          '> @projectman/web@0.0.0 test',
          '> vitest run',
          ' RUN  v4.0.0 /repo/apps/web',
          ' ✓ src/passing.test.ts (3 tests)\n'.repeat(1_000),
          ' Test Files  300 passed (300)',
          '      Tests  900 passed (900)',
        ].join('\n'),
      );
      expect(report).toContain('## @projectman/server test');
      expect(report).toContain(
        'FAIL  src/domain/screenshot-runs.test.ts > take_screenshots > starts the run',
      );
      expect(report).toContain('The scenario shots/login.mjs is not a file.');
      expect(report).toContain('Errors  2 errors');
      expect(report).toContain('## @projectman/web test');
      expect(report).not.toContain('src/passing.test.ts');
      expect(report.length).toBeLessThanOrEqual(FAILURE_REPORT_CHARS);
    });

    it('says a workspace stopped without a report', () => {
      const output = [
        '> @projectman/server@0.0.0 test',
        '> vitest run',
        ' RUN  v4.0.0 /repo/apps/server',
        ' ✓ test/a.test.ts (2 tests)',
        ' ❯ test/b.test.ts (3 tests | 1 failed)',
      ].join('\n');
      const report = failureReport(output);
      expect(report).toContain('## @projectman/server test');
      expect(report).toContain('stopped without reporting');
      expect(report).toContain('❯ test/b.test.ts');
    });

    it('keeps the error lines of a failed type check', () => {
      const output = [
        '> @projectman/web@0.0.0 typecheck',
        '> tsc -p tsconfig.json',
        'src/a.ts(1,1): error TS2322: Type string is not assignable to number.',
      ].join('\n');
      expect(failureReport(output)).toBe(
        '## @projectman/web typecheck\nsrc/a.ts(1,1): error TS2322: Type string is not assignable to number.',
      );
    });

    it('gives every failing workspace room and keeps the totals when cutting', () => {
      const big = (name: string) =>
        [
          `> @projectman/${name}@0.0.0 test`,
          '> vitest run',
          ' RUN  v4.0.0 /repo',
          '⎯⎯⎯⎯⎯⎯ Failed Tests 40 ⎯⎯⎯⎯⎯⎯',
          ...Array.from({ length: 400 }, (_, i) => ` FAIL  test/${name}${i}.test.ts > case ${i}`),
          ` Test Files  40 failed (40)`,
        ].join('\n');
      const report = failureReport(`${big('server')}\n${big('web')}`);
      expect(report.length).toBeLessThanOrEqual(FAILURE_REPORT_CHARS);
      expect(report).toContain('## @projectman/server test');
      expect(report).toContain('## @projectman/web test');
      expect(report.match(/Test Files {2}40 failed/g)).toHaveLength(2);
    });

    it('falls back to the end of the output when nothing is recognised', () => {
      expect(failureReport(`${'x'.repeat(10_000)}END`, 100)).toHaveLength(100);
      expect(failureReport('')).toBe('');
    });
  });

  it('keeps only the end of what a process wrote', () => {
    const tail = new OutputTail();
    for (let i = 0; i < 20; i++) tail.push('a'.repeat(OUTPUT_LIMIT_BYTES / 4));
    tail.push('END');
    expect(tail.value().length).toBeLessThanOrEqual(OUTPUT_LIMIT_BYTES);
    expect(tail.value().endsWith('END')).toBe(true);
  });
});

describe('the directory of a full test run', () => {
  const RUN_ID = 'ftr_mgabc12345ef01234567';
  // A Unix socket path must stay within 100 bytes (macOS's limit is 104): the sandbox's TMPDIR holds
  // srt's socket, and its HOME the control socket. The longest names that go below them:
  const SRT_SOCKET = 'srt-mux-9999999-99.sock';
  const CONTROL_SOCKET = 'control.sock';
  const bytes = (value: string) => Buffer.byteLength(value, 'utf8');
  const socketPathsOf = (runDir: string) => {
    const paths = runPaths(runDir);
    return [path.join(paths.tmp, SRT_SOCKET), path.join(paths.home, CONTROL_SOCKET)];
  };
  const expectRoomFor = (runDir: string) => {
    const paths = runPaths(runDir);
    for (const socketPath of socketPathsOf(runDir)) expect(bytes(socketPath)).toBeLessThanOrEqual(100);
    // The frame itself: at least 40 bytes below both, the separator included.
    for (const dir of [paths.tmp, paths.home]) expect(bytes(dir) + 40).toBeLessThanOrEqual(100);
  };

  it('is short, under the temporary directory, named by the end of the run id', () => {
    const tmp = '/private/tmp';
    const dir = runDirOf(tmp, '/private/tmp', RUN_ID);
    expect(dir).toBe(`${tmp}/pmft-01234567`);
    expectRoomFor(dir);
  });

  it('moves to the short root when the temporary directory is too deep for the socket', () => {
    const deep = `/private/var/folders/4w/d7bbmg9x6_53p3cstdbcv4b40000gn/T/pm-full-test-eusHub/runs`;
    const dir = runDirOf(deep, '/private/tmp', RUN_ID);
    expect(dir).toBe('/private/tmp/pmft-01234567');
    expectRoomFor(dir);
  });

  it('counts the extra bytes of the canonical path: /var/folders resolves to /private/var/folders', () => {
    // 26 bytes as the link, 34 as the real path: the link would fit, the real path leaves 39 bytes.
    const link = '/var/folders/ab/cdefghij/T';
    const real = '/private/var/folders/ab/cdefghij/T';
    expect(runDirOf(link, '/private/tmp', RUN_ID)).toBe(`${link}/pmft-01234567`);
    expect(runDirOf(real, '/private/tmp', RUN_ID)).toBe('/private/tmp/pmft-01234567');
    // The edge: one byte less in the root and the 40 bytes are there.
    const edge = '/private/var/folders/ab/cdefghi/T';
    expect(runDirOf(edge, '/private/tmp', RUN_ID)).toBe(`${edge}/pmft-01234567`);
    expectRoomFor(`${edge}/pmft-01234567`);
  });

  it('measures bytes, not characters', () => {
    // 18 characters but 35 bytes: the root leaves 38 bytes, not the 40 the frame needs.
    const multibyte = `/${'é'.repeat(17)}`;
    expect(multibyte.length).toBe(18);
    expect(bytes(multibyte)).toBe(35);
    expect(runDirOf(multibyte, '/private/tmp', RUN_ID)).toBe('/private/tmp/pmft-01234567');
    // The same number of bytes in ASCII is the same decision.
    expect(runDirOf(`/${'e'.repeat(34)}`, '/private/tmp', RUN_ID)).toBe('/private/tmp/pmft-01234567');
    expect(runDirOf(`/${'e'.repeat(32)}`, '/private/tmp', RUN_ID)).toBe(`/${'e'.repeat(32)}/pmft-01234567`);
  });

  it('checks the frame of the short root too, and throws when no root has room', () => {
    const deep = `/private/var/folders/4w/d7bbmg9x6_53p3cstdbcv4b40000gn/T/pm-full-test-eusHub/runs`;
    expect(() => runDirOf(deep, deep, RUN_ID)).toThrow(/no root leaves 40 bytes/);
    expect(() => runDirOf(deep, `/${'é'.repeat(20)}`, RUN_ID)).toThrow(/no root leaves 40 bytes/);
    // A suitable short root is used even though it is not `/private/tmp`.
    expect(runDirOf(deep, '/tmp', RUN_ID)).toBe('/tmp/pmft-01234567');
  });

  it('resolves links of an existing root, and leaves a missing one where it is', () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'pm-canonical-'));
    try {
      mkdirSync(path.join(base, 'real'));
      symlinkSync(path.join(base, 'real'), path.join(base, 'link'));
      expect(canonicalRoot(path.join(base, 'link'))).toBe(realpathSync(path.join(base, 'real')));
      expect(canonicalRoot(path.join(base, 'missing'))).toBe(path.join(base, 'missing'));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('the sandbox of a full test run', () => {
  const paths = runPaths('/tmp/projectman-full-test-ftr_1');
  const spec = {
    runId: 'ftr_1',
    cwd: '/work/checkout',
    command: 'npm test',
    maxWorkers: 3,
    timeoutMs: 1000,
    sandbox: { denyRead: ['/Users/anna', '/Users/anna/.ssh'], allowRead: ['/work/checkout'] },
  };

  it('writes only its own sandbox directory, reads the checkout and nothing outward', () => {
    expect(srtSettings(spec, paths)).toEqual({
      network: {
        allowedDomains: [],
        deniedDomains: [],
        allowLocalBinding: true,
        allowUnixSockets: ['/tmp/projectman-full-test-ftr_1/sandbox/tmp'],
        allowAllUnixSockets: false,
      },
      filesystem: {
        denyRead: ['/Users/anna', '/Users/anna/.ssh'],
        allowRead: ['/work/checkout', '/tmp/projectman-full-test-ftr_1/sandbox'],
        allowWrite: ['/tmp/projectman-full-test-ftr_1/sandbox'],
        denyWrite: ['/tmp/claude', '/private/tmp/claude'],
      },
      allowPty: true,
    });
    // The settings file is in the run directory's root: not writable for the command.
    expect(paths.settings).toBe('/tmp/projectman-full-test-ftr_1/settings.json');
  });

  it('opens Unix sockets only below the run own tmp, never all of them', () => {
    const { network } = srtSettings(spec, paths);
    expect(network.allowUnixSockets).toEqual([paths.tmp]);
    expect(network.allowAllUnixSockets).toBe(false);
    // Not the sandbox root, the run directory (the settings are there) or the home.
    for (const other of [paths.sandbox, paths.runDir, paths.home, '/tmp', '/private/tmp'])
      expect(network.allowUnixSockets).not.toContain(other);
  });

  it('gives the installer no socket permission and keeps its two hosts', () => {
    const { network } = installerSettings(spec, paths, ['/work/checkout/node_modules']);
    expect(network).toEqual({
      allowedDomains: ['registry.npmjs.org', 'nodejs.org'],
      deniedDomains: [],
      allowLocalBinding: false,
    });
  });

  it('takes nothing but an allow list from the server environment', () => {
    const env = fullTestEnv(paths, 3, {
      PATH: '/usr/bin',
      LANG: 'en_US.UTF-8',
      PROJECTMAN_SKIP_PTY_TESTS: '1',
      PROJECTMAN_HOME: '/x',
      GH_TOKEN: 't',
      SSH_AUTH_SOCK: '/s',
      ANTHROPIC_API_KEY: 'k',
      HOME: '/Users/anna',
    });
    expect(env).toEqual({
      PATH: '/usr/bin',
      LANG: 'en_US.UTF-8',
      HOME: '/tmp/projectman-full-test-ftr_1/sandbox/home',
      TMPDIR: '/tmp/projectman-full-test-ftr_1/sandbox/tmp',
      CLAUDE_CODE_TMPDIR: '/tmp/projectman-full-test-ftr_1/sandbox/tmp',
      npm_config_cache: '/tmp/projectman-full-test-ftr_1/sandbox/npm-cache',
      npm_config_update_notifier: 'false',
      GIT_CONFIG_GLOBAL: '/tmp/projectman-full-test-ftr_1/sandbox/gitconfig',
      GIT_CONFIG_NOSYSTEM: '1',
      VITEST_MAX_FORKS: '3',
      VITEST_MAX_THREADS: '3',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      PROJECTMAN_HEAVY_LOCK_HELD: '1',
      PROJECTMAN_FULL_TEST_SANDBOX: '1',
    });
  });

  it('closes the standard input of the whole command, a chain included', () => {
    expect(closedStdin('npm run typecheck && npm test')).toBe(
      'exec </dev/null; npm run typecheck && npm test',
    );
  });

  it('starts the sandbox at low priority, outside it, with the command as one argument', () => {
    expect(
      niceSrtCommand('/usr/bin/node', '/x/cli.js', '/run/settings.json', "echo 'a b' && npm test"),
    ).toEqual({
      file: '/usr/bin/nice',
      args: [
        '-n',
        '10',
        '/usr/bin/node',
        '/x/cli.js',
        '--settings',
        '/run/settings.json',
        '-c',
        "echo 'a b' && npm test",
      ],
    });
  });
});

describe('fullTestSandbox', () => {
  it('closes the home and the app home, and re-opens the checkout and its git directory', () => {
    const sandbox = fullTestSandbox({
      checkout: '/Users/anna/.projectman/worktrees/PM/PM-1-x',
      gitDir: '/Users/anna/Dev/x/.git',
      userHome: '/Users/anna',
      appHome: '/Users/anna/.projectman',
    });
    expect(sandbox.denyRead).toEqual(
      expect.arrayContaining([
        '/Users/anna',
        '/Users/anna/.ssh',
        '/Users/anna/.projectman/db.sqlite*',
        '/Users/anna/.projectman/secret',
      ]),
    );
    // The app home lies inside the user's home: one rule for both.
    expect(sandbox.denyRead).not.toContain('/Users/anna/.projectman');
    expect(sandbox.allowRead).toEqual([
      '/Users/anna/.projectman/worktrees/PM/PM-1-x',
      '/Users/anna/Dev/x/.git',
    ]);
  });

  it('closes an app home outside the home too, and never re-opens a sensitive path', () => {
    const sandbox = fullTestSandbox({
      checkout: '/Users/anna/.ssh/repo',
      gitDir: '/srv/git/x/.git',
      userHome: '/Users/anna',
      appHome: '/srv/projectman',
    });
    expect(sandbox.denyRead).toContain('/srv/projectman');
    expect(sandbox.allowRead).toEqual(['/srv/git/x/.git']);
  });

  it('closes the temporary roots the machine’s sessions share (PM-353)', () => {
    const closedTmpRoots = ['/tmp/claude-501', '/private/tmp/claude-501', '/private/tmp/projectman-501-tmp'];
    const sandbox = fullTestSandbox({
      checkout: '/Users/anna/.projectman/worktrees/PM/PM-1-x',
      userHome: '/Users/anna',
      appHome: '/Users/anna/.projectman',
      closedTmpRoots,
    });
    expect(sandbox.denyRead).toEqual(expect.arrayContaining(closedTmpRoots));
    // The run's own directory (a short root below the real `/tmp`, or the tmp root) is none of them.
    const own = runDirOf('/private/tmp/pmft-x', '/private/tmp', 'ftr_mgabc12345ef01234567');
    for (const root of closedTmpRoots) expect(own === root || own.startsWith(`${root}/`)).toBe(false);
    // Without them nothing is added.
    expect(
      fullTestSandbox({ checkout: '/c', userHome: '/Users/anna', appHome: '/Users/anna/.projectman' })
        .denyRead,
    ).not.toContain('/tmp/claude-501');
  });
});
