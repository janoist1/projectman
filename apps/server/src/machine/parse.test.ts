import { describe, expect, it } from 'vitest';
import {
  diffPsEnvironment,
  parseCpuTime,
  parseEnvironFile,
  parseLstart,
  parseMeminfo,
  parseMemoryPressure,
  parsePsCommands,
  parsePsList,
  parseSwapUsage,
  parseVmStat,
  shortName,
} from './parse';

const MAC_PS = `    1     0     0  13520   0.0   1:09.31 Thu Sep 25 08:01:02 2026 /sbin/launchd
  412     1   501 120304   2.5  12:34.56 Sat Oct  4 09:15:30 2026 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
  980   412   501 450000  10.5 123:45.67 Sat Oct  4 09:15:40 2026 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/129/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer --lang=en-US
 5100  5000   501   2048   0.0   0:00.01 Sat Oct  4 21:20:11 2026 sleep 600
this line is not a process`;

const LINUX_PS = `    1     0     0  11000  0.0 00:00:03 Mon Sep 29 06:00:01 2026 /sbin/init
 2201     1  1000 204800 12.3 1-02:03:04 Mon Sep 29 06:10:00 2026 node /srv/app/node_modules/vitest/vitest.mjs run
 2300  2201  1000   5000  0.0 00:00:00 Sat Oct  4 21:20:11 2026 /bin/sh -c echo hi`;

describe('parseLstart', () => {
  it('reads the local start time with a space-padded day', () => {
    expect(parseLstart('Sat Oct  4 21:20:11 2026')).toBe(new Date(2026, 9, 4, 21, 20, 11).getTime());
    expect(parseLstart('Mon Sep 29 06:10:00 2026')).toBe(new Date(2026, 8, 29, 6, 10, 0).getTime());
  });

  it('refuses text that is no time', () => {
    expect(parseLstart('not a time')).toBeNull();
    expect(parseLstart('Sat Xyz  4 21:20:11 2026')).toBeNull();
  });
});

describe('parseCpuTime', () => {
  it('reads the macOS and the Linux shapes', () => {
    expect(parseCpuTime('0:00.42')).toBeCloseTo(0.42);
    expect(parseCpuTime('12:34.56')).toBeCloseTo(12 * 60 + 34.56);
    expect(parseCpuTime('123:45.67')).toBeCloseTo(123 * 60 + 45.67);
    expect(parseCpuTime('00:00:03')).toBe(3);
    expect(parseCpuTime('01:02:03')).toBe(3723);
    expect(parseCpuTime('1-02:03:04')).toBe(86_400 + 2 * 3600 + 3 * 60 + 4);
  });

  it('refuses anything else', () => {
    expect(parseCpuTime('abc')).toBeNull();
    expect(parseCpuTime('')).toBeNull();
  });
});

describe('parsePsList', () => {
  it('parses the macOS list and skips lines that do not parse', () => {
    const records = parsePsList(MAC_PS);
    expect(records.map((r) => r.pid)).toEqual([1, 412, 980, 5100]);
    expect(records[1]).toEqual({
      pid: 412,
      ppid: 1,
      uid: 501,
      rssBytes: 120304 * 1024,
      cpuSeconds: 12 * 60 + 34.56,
      cpuPercent: 2.5,
      startedAt: new Date(2026, 9, 4, 9, 15, 30).getTime(),
      args: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
    expect(records[3]!.args).toBe('sleep 600');
    expect(records[2]!.cpuSeconds).toBeCloseTo(123 * 60 + 45.67);
  });

  it('parses the Linux list with day-long CPU times', () => {
    const records = parsePsList(LINUX_PS);
    expect(records.map((r) => [r.pid, r.ppid, r.uid])).toEqual([
      [1, 0, 0],
      [2201, 1, 1000],
      [2300, 2201, 1000],
    ]);
    expect(records[1]!.cpuSeconds).toBe(86_400 + 2 * 3600 + 3 * 60 + 4);
    expect(records[2]!.args).toBe('/bin/sh -c echo hi');
  });

  it('keeps a process without a command line', () => {
    const [record] = parsePsList('  77     1   501   100   0.0   0:00.00 Sat Oct  4 21:20:11 2026 ');
    expect(record).toMatchObject({ pid: 77, args: '' });
  });
});

describe('the environment of a process on macOS (ps -E)', () => {
  const plain = parsePsCommands(
    ' 5100 sleep 600\n 5200 node server.js --port 1\n 5300 /usr/libexec/other-user-daemon\n',
  );
  const withEnvironment = parsePsCommands(
    [
      ' 5100 sleep 600 HOME=/Users/i PROJECTMAN_SESSION_ID=ses_abc PROJECTMAN_INSTANCE=0123456789abcdef PATH=/usr/bin',
      ' 5200 node server.js --port 1 TERM=xterm-256color',
      ' 5300 /usr/libexec/other-user-daemon',
    ].join('\n'),
  );

  it('is what follows the command that ps prints without -E', () => {
    const environment = diffPsEnvironment(withEnvironment, plain, [
      'PROJECTMAN_SESSION_ID',
      'PROJECTMAN_INSTANCE',
    ]);
    expect(environment.get(5100)).toEqual({
      PROJECTMAN_SESSION_ID: 'ses_abc',
      PROJECTMAN_INSTANCE: '0123456789abcdef',
    });
    // A process without the variables is known, with no values.
    expect(environment.get(5200)).toEqual({});
  });

  it('leaves out a process whose environment ps does not print', () => {
    const environment = diffPsEnvironment(withEnvironment, plain, ['PROJECTMAN_SESSION_ID']);
    expect(environment.has(5300)).toBe(false);
  });

  it('does not read a variable out of the command line', () => {
    const commands = parsePsCommands(' 9 echo PROJECTMAN_SESSION_ID=ses_fake\n');
    const withEnv = parsePsCommands(' 9 echo PROJECTMAN_SESSION_ID=ses_fake HOME=/h\n');
    expect(diffPsEnvironment(withEnv, commands, ['PROJECTMAN_SESSION_ID']).get(9)).toEqual({});
  });
});

describe('parseEnvironFile', () => {
  it('takes the named variables of a NUL separated environment', () => {
    const content = 'HOME=/home/me\0PROJECTMAN_SESSION_ID=ses_1\0EMPTY=\0PROJECTMAN_INSTANCE=ab=cd\0';
    expect(parseEnvironFile(content, ['PROJECTMAN_SESSION_ID', 'PROJECTMAN_INSTANCE', 'MISSING'])).toEqual({
      PROJECTMAN_SESSION_ID: 'ses_1',
      PROJECTMAN_INSTANCE: 'ab=cd',
    });
  });
});

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               3338.
Pages active:                           222222.
Pages inactive:                         218000.
Pages speculative:                        4000.
Pages throttled:                             0.
Pages wired down:                        86000.
Pages purgeable:                          2000.
"Translation faults":                 99999999.
Pages copy-on-write:                   1111111.
Anonymous pages:                        260000.
Pages stored in compressor:             300000.
"Pages occupied by compressor":          88000.
`;

describe('parseVmStat', () => {
  it('counts wired, compressed and anonymous pages without the purgeable ones', () => {
    expect(parseVmStat(VM_STAT)).toBe((86000 + 88000 + 260000 - 2000) * 16384);
  });

  it('is unknown when the page size or a counter is missing', () => {
    expect(parseVmStat('Pages free: 1.')).toBeNull();
    expect(parseVmStat(VM_STAT.replace('Anonymous pages:', 'Other pages:'))).toBeNull();
  });
});

describe('parseSwapUsage', () => {
  it('reads megabytes and gigabytes', () => {
    expect(parseSwapUsage('total = 2048.00M  used = 1024.50M  free = 1023.50M  (encrypted)')).toEqual({
      totalBytes: 2048 * 1024 ** 2,
      usedBytes: Math.round(1024.5 * 1024 ** 2),
    });
    expect(parseSwapUsage('total = 16.00G  used = 15.60G  free = 0.40G  (encrypted)')).toEqual({
      totalBytes: 16 * 1024 ** 3,
      usedBytes: Math.round(15.6 * 1024 ** 3),
    });
  });

  it('is unknown for anything else', () => {
    expect(parseSwapUsage('')).toBeNull();
    expect(parseSwapUsage('vm.swapusage: unknown oid')).toBeNull();
  });
});

describe('parseMemoryPressure', () => {
  it('maps the kernel levels', () => {
    expect(parseMemoryPressure('1\n')).toBe('normal');
    expect(parseMemoryPressure('2\n')).toBe('warn');
    expect(parseMemoryPressure('4\n')).toBe('critical');
    expect(parseMemoryPressure('3')).toBeNull();
    expect(parseMemoryPressure('')).toBeNull();
  });
});

describe('parseMeminfo', () => {
  it('reads the totals in bytes', () => {
    const content = `MemTotal:       16384000 kB
MemFree:         1000000 kB
MemAvailable:    6384000 kB
SwapTotal:       2097152 kB
SwapFree:        2000000 kB
`;
    expect(parseMeminfo(content)).toEqual({
      totalBytes: 16384000 * 1024,
      availableBytes: 6384000 * 1024,
      swapTotalBytes: 2097152 * 1024,
      swapFreeBytes: 2000000 * 1024,
    });
  });

  it('leaves a missing line null', () => {
    expect(parseMeminfo('MemTotal: 100 kB\n')).toMatchObject({ totalBytes: 102400, availableBytes: null });
  });
});

describe('shortName', () => {
  it('takes the last part of the program', () => {
    expect(shortName('/usr/bin/sleep 600')).toBe('sleep');
    expect(shortName('/sbin/launchd')).toBe('launchd');
    expect(shortName('-zsh')).toBe('zsh');
    expect(shortName('')).toBe('');
  });

  it('names an interpreter by its first argument that is no flag', () => {
    expect(shortName('node /srv/app/server.js --port 1')).toBe('server');
    expect(shortName('/opt/homebrew/bin/node --enable-source-maps /srv/run.mjs')).toBe('run');
    expect(shortName('python3 -m pytest -q')).toBe('pytest');
    expect(shortName('python3.12 tool.py')).toBe('tool.py');
    expect(shortName('bash ./scripts/deploy.sh')).toBe('deploy.sh');
    expect(shortName('node')).toBe('node');
    expect(shortName('/bin/sh -c echo hi')).toBe('echo');
  });

  it('names a package run from node_modules by the package', () => {
    expect(shortName('node /x/node_modules/vitest/vitest.mjs run')).toBe('vitest');
    expect(shortName('node /x/node_modules/vitest/dist/workers/forks.js')).toBe('vitest');
    expect(shortName('node /x/node_modules/vite/bin/vite.js --port 5173')).toBe('vite');
    expect(shortName('node /x/node_modules/typescript/bin/tsc --noEmit')).toBe('tsc');
    expect(shortName('node /x/node_modules/playwright/cli.js test')).toBe('playwright');
    expect(shortName('node /x/node_modules/.bin/vite')).toBe('vite');
    expect(shortName('node /x/node_modules/@esbuild/darwin-arm64/bin/esbuild --service')).toBe('esbuild');
  });

  it('skips the run word of a package runner', () => {
    expect(shortName('npm run dev')).toBe('dev');
    expect(shortName('npm test')).toBe('test');
    expect(shortName('npx vitest')).toBe('vitest');
  });

  it('keeps the spaces of a macOS application and drops its role in brackets', () => {
    expect(shortName('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')).toBe('Google Chrome');
    expect(
      shortName(
        '/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/129/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer --lang=en-US',
      ),
    ).toBe('Google Chrome Helper');
  });

  it('is at most 40 characters', () => {
    expect(shortName(`/usr/bin/${'x'.repeat(80)}`)).toHaveLength(40);
  });
});
