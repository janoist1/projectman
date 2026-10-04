import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fullTestSandbox } from '../domain';
import {
  failedFiles,
  outputTail,
  OutputTail,
  OUTPUT_LIMIT_BYTES,
  OUTPUT_TAIL_CHARS,
  stripAnsi,
} from './output';
import { closedStdin, fullTestEnv, niceSrtCommand, runDirOf, runPaths, srtSettings } from './sandbox';

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

  it('keeps only the end of what a process wrote', () => {
    const tail = new OutputTail();
    for (let i = 0; i < 20; i++) tail.push('a'.repeat(OUTPUT_LIMIT_BYTES / 4));
    tail.push('END');
    expect(tail.value().length).toBeLessThanOrEqual(OUTPUT_LIMIT_BYTES);
    expect(tail.value().endsWith('END')).toBe(true);
  });
});

describe('the directory of a full test run', () => {
  // A Unix socket path must stay below macOS's 104 bytes: the sandbox's TMPDIR holds srt's socket.
  const socketPathOf = (runDir: string) => path.join(runPaths(runDir).tmp, 'srt-mux-9999999-99.sock');

  it('is short, under the temporary directory, named by the end of the run id', () => {
    const tmp = '/var/folders/4w/d7bbmg9x6_53p3cstdbcv4b40000gn/T';
    const dir = runDirOf(tmp, '/private/tmp', 'ftr_mgabc12345ef01234567');
    expect(dir).toBe(`${tmp}/pmft-01234567`);
    expect(socketPathOf(dir).length).toBeLessThanOrEqual(103);
  });

  it('moves to the short root when the temporary directory is too deep for the socket', () => {
    const deep = `/private/var/folders/4w/d7bbmg9x6_53p3cstdbcv4b40000gn/T/pm-full-test-eusHub/runs`;
    const dir = runDirOf(deep, '/private/tmp', 'ftr_mgabc12345ef01234567');
    expect(dir).toBe('/private/tmp/pmft-01234567');
    expect(socketPathOf(dir).length).toBeLessThanOrEqual(103);
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
      network: { allowedDomains: [], deniedDomains: [], allowLocalBinding: true },
      filesystem: {
        denyRead: ['/Users/anna', '/Users/anna/.ssh'],
        allowRead: ['/work/checkout', '/tmp/projectman-full-test-ftr_1/sandbox'],
        allowWrite: ['/tmp/projectman-full-test-ftr_1/sandbox'],
        denyWrite: [],
      },
      allowPty: true,
    });
    // The settings file is in the run directory's root: not writable for the command.
    expect(paths.settings).toBe('/tmp/projectman-full-test-ftr_1/settings.json');
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
});
