import { describe, expect, it } from 'vitest';
import { createMachineReader } from './machine';
import { fakeHost } from './test-helpers';

const PS_ARGS = '-axo pid=,ppid=,pgid=,uid=,pcpu=,rss=,etime=,comm=';

describe('machine snapshot on macOS', () => {
  const darwin = (psOutput: string) =>
    fakeHost({
      platform: 'darwin',
      exec: async (file, args) => {
        const outputs: Record<string, string> = {
          '/usr/sbin/sysctl -n vm.loadavg': '{ 1.52 1.80 2.01 }\n',
          '/usr/sbin/sysctl -n hw.memsize': '17179869184\n',
          '/usr/sbin/sysctl -n vm.swapusage':
            'total = 2048.00M  used = 1024.50M  free = 1023.50M  (encrypted)\n',
          '/usr/bin/vm_stat': [
            'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
            'Pages free:                               10000.',
            'Pages active:                            200000.',
            'Pages inactive:                           50000.',
            'Pages speculative:                         5000.',
          ].join('\n'),
          [`/bin/ps ${PS_ARGS}`]: psOutput,
        };
        const command = [file, ...args].join(' ');
        const output = outputs[command];
        if (output === undefined) throw new Error(`unexpected command ${command}`);
        return output;
      },
    });

  it('reads load, memory, swap and the supervisor user’s processes by base name', async () => {
    const host = darwin(
      [
        '  100     1   100   501   1.5  500000  02:03:04 /Applications/Foo Bar.app/Contents/MacOS/Foo Bar',
        '  200   100   100   501  12.0 2000000  01-02:03:04 /usr/local/bin/node',
        '    1     0     1     0   0.0    1000  10-00:00:00 /sbin/launchd',
      ].join('\n'),
    );
    expect(await createMachineReader(host).snapshot()).toEqual({
      at: '2026-10-17T10:00:00.000Z',
      loadAvg: [1.52, 1.8, 2.01],
      memory: { totalBytes: 17_179_869_184, availableBytes: 65_000 * 16_384 },
      swap: { totalBytes: 2048 * 1024 ** 2, usedBytes: Math.round(1024.5 * 1024 ** 2) },
      topProcesses: [
        { pid: 200, name: 'node', cpuPercent: 12, rssBytes: 2_000_000 * 1024 },
        { pid: 100, name: 'Foo Bar', cpuPercent: 1.5, rssBytes: 500_000 * 1024 },
      ],
    });
  });

  it('keeps the ten largest processes only', async () => {
    const lines = Array.from(
      { length: 12 },
      (_, index) => `${100 + index} 1 1 501 0.0 ${1000 + index} 05:00 /usr/bin/proc${index}`,
    );
    const { topProcesses } = await createMachineReader(darwin(lines.join('\n'))).snapshot();
    expect(topProcesses).toHaveLength(10);
    expect(topProcesses[0]).toMatchObject({ name: 'proc11' });
    expect(topProcesses.map((process) => process.name)).not.toContain('proc0');
  });
});

describe('machine snapshot on Linux', () => {
  it('reads /proc: load, memory, swap and the supervisor user’s processes', async () => {
    const files: Record<string, string> = {
      '/proc/loadavg': '0.10 0.20 0.30 1/234 5678\n',
      '/proc/meminfo': [
        'MemTotal:       16000000 kB',
        'MemFree:         1000000 kB',
        'MemAvailable:    8000000 kB',
        'SwapTotal:       2000000 kB',
        'SwapFree:        1500000 kB',
      ].join('\n'),
      '/proc/uptime': '1000.00 2000.00\n',
      '/proc/42/stat':
        '42 (node) S 1 42 42 0 -1 4194560 100 0 0 0 150 50 0 0 20 0 1 0 50000 123456789 2500 18446744073709551615',
      '/proc/42/status': 'Name:\tnode\nUid:\t501\t501\t501\t501\nVmRSS:\t   10000 kB\n',
      '/proc/43/stat': '43 (sshd) S 1 43 43 0 -1 4194560 100 0 0 0 1 1 0 0 20 0 1 0 100 123456789 100',
      '/proc/43/status': 'Name:\tsshd\nUid:\t0\t0\t0\t0\nVmRSS:\t   99999 kB\n',
    };
    const host = fakeHost({
      platform: 'linux',
      readFile: async (file) => {
        const text = files[file];
        if (text === undefined) throw new Error(`unexpected file ${file}`);
        return text;
      },
      readdir: async () => ['1', '42', '43', 'self', 'cpuinfo'],
    });
    expect(await createMachineReader(host).snapshot()).toEqual({
      at: '2026-10-17T10:00:00.000Z',
      loadAvg: [0.1, 0.2, 0.3],
      memory: { totalBytes: 16_000_000 * 1024, availableBytes: 8_000_000 * 1024 },
      swap: { totalBytes: 2_000_000 * 1024, usedBytes: 500_000 * 1024 },
      topProcesses: [{ pid: 42, name: 'node', cpuPercent: 0.4, rssBytes: 10_000 * 1024 }],
    });
  });

  it('fails on a platform it has no reader for', async () => {
    await expect(createMachineReader(fakeHost({ platform: 'win32' })).snapshot()).rejects.toThrow();
  });
});
