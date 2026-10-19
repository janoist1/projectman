import { describe, expect, it } from 'vitest';
import {
  classifyOwn,
  classifyTree,
  collectSample,
  defaultTestWorkers,
  describeCommand,
  filterLogLine,
  filterLogText,
  findRuns,
  parseClock,
  parsePsLine,
  parseSwapUsage,
  parseVmStat,
  pickVitestEnv,
  readHeavyQueueSync,
  safeName,
  summarizeLinks,
  summarizeWindow,
} from '../../../scripts/load-probe/load-probe.mjs';

const SECRET = 'sk-ant-SECRET-TOKEN-123';

describe('load probe: parsing', () => {
  it('parses ps clocks and lines', () => {
    expect(parseClock('01:02.50')).toBeCloseTo(62.5);
    expect(parseClock('1:02:03')).toBe(3723);
    expect(parseClock('2-00:00:10')).toBe(172810);
    expect(parseClock('x')).toBeNull();
    expect(parsePsLine('  123   1  0:05.00  2048  10:00 /bin/zsh -l')).toMatchObject({
      pid: 123,
      ppid: 1,
      cpuSeconds: 5,
      rssKb: 2048,
      etimeSeconds: 600,
      args: '/bin/zsh -l',
    });
    expect(parsePsLine('garbage')).toBeNull();
  });

  it('parses vm_stat, swap and the vitest limits out of an environment line', () => {
    const vm = [
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
      'Pages free:                               1000.',
      'Pages wired down:                         2000.',
      'Pages purgeable:                           100.',
      'Anonymous pages:                          3000.',
      'Pages occupied by compressor:             4000.',
    ].join('\n');
    expect(parseVmStat(vm)).toMatchObject({
      usedBytes: (2000 + 4000 + 3000 - 100) * 16384,
      freeBytes: 1000 * 16384,
    });
    expect(parseSwapUsage('total = 14336.00M  used = 13619.20M  free = 716.80M  (encrypted)')).toEqual({
      totalBytes: 14336 * 1024 ** 2,
      usedBytes: Math.round(13619.2 * 1024 ** 2),
    });
    expect(
      pickVitestEnv(`node vitest run FOO=${SECRET} VITEST_MAX_FORKS=2 VITEST_MAX_THREADS=2 X=1`),
    ).toEqual({
      VITEST_MAX_FORKS: 2,
      VITEST_MAX_THREADS: 2,
    });
    expect(pickVitestEnv('XVITEST_MAX_FORKS=2')).toEqual({});
  });
});

describe('load probe: no argument, token or personal name leaves', () => {
  it('keeps only the executable and the script tail', () => {
    const cmd = `node --import tsx /Users/someone/work/projectman/scripts/engine/cli.ts start --token ${SECRET}`;
    const described = describeCommand(cmd);
    expect(described).toEqual({ exe: 'node', script: 'engine/cli.ts' });
    expect(JSON.stringify(described)).not.toContain(SECRET);
    expect(describeCommand(`node -e "process.env.X='${SECRET}'"`)).toEqual({ exe: 'node', script: '-e' });
    expect(describeCommand(`bash -c "curl -H 'Authorization: ${SECRET}'"`)).toEqual({
      exe: 'bash',
      script: '-c',
    });
    expect(describeCommand(`/usr/bin/curl https://x.example/?token=${SECRET}`)).toEqual({
      exe: 'curl',
      script: '',
    });
    expect(describeCommand(`npm run test -w @projectman/server --token=${SECRET}`)).toEqual({
      exe: 'npm',
      script: 'run test',
    });
    expect(
      describeCommand('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --type=renderer --x=1'),
    ).toEqual({
      exe: 'Google Chrome',
      script: '',
    });
  });

  it('safeName drops anything that could hold a value', () => {
    expect(safeName('a=b "c" $(d)')).toBe('a_b _c_ _(d)');
    expect(safeName('x'.repeat(100), 10)).toHaveLength(10);
  });

  it('a whole sample holds none of the arguments or environment values', async () => {
    const ps = [
      ` 10 1 0:10.00 1000 100:00 /Users/someone/.local/share/claude/versions/2.1.9/claude --resume ${SECRET}`,
      ` 11 10 0:01.00 900 10:00 node /opt/x/mcp-server/index.js --api-key ${SECRET}`,
      ` 12 10 0:20.00 500000 10:00 node /repo/node_modules/vitest/vitest.mjs run --maxWorkers=3 ${SECRET}`,
      ` 13 12 0:30.00 150000 10:00 node (vitest 1)`,
      ` 14 12 0:30.00 150000 10:00 node (vitest 2)`,
    ].join('\n');
    const state: Record<string, unknown> = {};
    const exec = async (file: string, args: string[]) => {
      if (file === 'ps' && args[0] === 'eww')
        return ` 12 node vitest.mjs VITEST_MAX_FORKS=2 TOKEN=${SECRET}\n`;
      if (file === 'ps') return ps;
      if (file === 'sysctl' && args.includes('vm.swapusage'))
        return 'total = 1024.00M  used = 512.00M  free = 512.00M';
      if (file === 'sysctl') return '2';
      return 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 10.\n';
    };
    const sample = await collectSample(state, {
      exec,
      now: () => 1_000_000,
      cpus: () => [{ times: { user: 100, nice: 0, sys: 50, idle: 850 } }],
      readQueue: () => ({ holder: null, waiting: [] }),
    });
    const text = JSON.stringify(sample);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('someone');
    expect(text).not.toContain('--resume');
    expect(sample.pressure).toBe(2);
    expect(sample.sessions).toEqual({ claude: 1 });
    expect(sample.runs).toEqual([
      expect.objectContaining({
        kind: 'vitest',
        pid: 12,
        workers: 2,
        maxWorkersArg: 3,
        inQueue: false,
        env: { VITEST_MAX_FORKS: 2 },
      }),
    ]);
    expect(sample.aggr['ai-mcp|index.js']).toBeUndefined();
    expect(Object.keys(sample.aggr)).toEqual(
      expect.arrayContaining(['ai-session|claude', 'vitest|runner', 'vitest|worker']),
    );
  });
});

describe('load probe: categories', () => {
  const cat = (args: string) => classifyOwn(args)?.cat ?? null;

  it('puts the M2 categories where the report needs them', () => {
    expect(cat('/usr/libexec/fseventsd')).toBe('fs-index');
    expect(
      cat(
        '/System/Library/Frameworks/CoreServices.framework/Frameworks/Metadata.framework/Versions/A/Support/mds_stores',
      ),
    ).toBe('fs-index');
    expect(cat('/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer -daemon')).toBe(
      'desktop',
    );
    expect(
      cat(
        '/Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer) --type=renderer',
      ),
    ).toBe('desktop');
    expect(cat('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')).toBe('browser');
    expect(
      cat(
        '/Users/x/.projectman/browsers/chromium-1/chrome-mac/Chromium.app/Contents/MacOS/Chromium --headless',
      ),
    ).toBe('browser');
    expect(cat('/Applications/Docker.app/Contents/MacOS/com.docker.virtualization --kernel x')).toBe(
      'docker',
    );
    expect(cat('/usr/bin/git status')).toBe('git');
    expect(cat('node /repo/node_modules/vitest/vitest.mjs run')).toBe('vitest');
    expect(cat('node /repo/node_modules/typescript/lib/tsc.js --noEmit')).toBe('typecheck');
    expect(cat('node /repo/node_modules/vite/bin/vite.js build')).toBe('build');
    expect(cat('npm ci')).toBe('npm-install');
    expect(cat('npm run test -w x')).toBeNull();
    expect(cat('node --import tsx /repo/scripts/engine/cli.ts start')).toBe('projectman');
    expect(cat('node /opt/x/mcp-server/index.js')).toBe('ai-mcp');
    expect(cat('node /x/.claude/hooks/hook-forwarder.js')).toBe('ai-hook');
    expect(classifyOwn('/opt/homebrew/bin/codex exec')).toEqual({ cat: 'ai-session', sub: 'codex' });
    expect(classifyOwn('node /x/node_modules/@google/gemini-cli/bin/gemini.js')).toEqual({
      cat: 'ai-session',
      sub: 'gemini',
    });
    expect(cat('/usr/bin/vim notes.txt')).toBeNull();
  });

  it('keeps vitest separate from vite, and a vitest worker as a worker', () => {
    expect(classifyOwn('node (vitest 3)')).toEqual({ cat: 'vitest', sub: 'worker' });
    expect(classifyOwn('node /r/node_modules/vitest/vitest.mjs run')).toEqual({
      cat: 'vitest',
      sub: 'runner',
    });
    expect(classifyOwn('node /r/node_modules/tinypool/dist/entry/process.js')).toEqual({
      cat: 'vitest',
      sub: 'worker',
    });
  });

  it('recognises the real vitest and vite command lines of this repository', () => {
    const runner = 'node /r/node_modules/.bin/vitest run --configLoader runner';
    expect(classifyOwn(runner)).toEqual({ cat: 'vitest', sub: 'runner' });
    expect(classifyOwn('node /r/node_modules/.bin/vite build')).toEqual({
      cat: 'build',
      sub: 'vite-esbuild',
    });
    expect(classifyOwn('node /r/node_modules/.bin/vite')).toBeNull();
    expect(classifyOwn('sh -c vitest run')).toBeNull();
    expect(
      classifyOwn('/r/node_modules/@esbuild/darwin-arm64/bin/esbuild --service=0.25.0 --ping'),
    ).toBeNull();
    expect(classifyOwn('/r/node_modules/@esbuild/darwin-arm64/bin/esbuild src/a.ts --bundle')).toEqual({
      cat: 'build',
      sub: 'vite-esbuild',
    });
    expect(
      classifyOwn('node /r/node_modules/typescript/lib/tsserver.js --useInferredProjectPerProjectRoot'),
    ).toEqual({
      cat: 'editor',
      sub: 'tsserver',
    });
  });

  it('counts one vitest run with its workers, and ignores idle services as heavy runs', () => {
    const procs = [
      { pid: 1, ppid: 0, args: '/sbin/launchd' },
      { pid: 100, ppid: 1, args: 'node scripts/heavy/cli.ts npm run merge-test' },
      { pid: 101, ppid: 100, args: 'npm run test -w apps/server' },
      { pid: 102, ppid: 101, args: 'sh -c vitest run --configLoader runner' },
      { pid: 103, ppid: 102, args: 'node /r/node_modules/.bin/vitest run --configLoader runner' },
      {
        pid: 104,
        ppid: 103,
        args: '/r/node_modules/@esbuild/darwin-arm64/bin/esbuild --service=0.25.0 --ping',
      },
      { pid: 111, ppid: 103, args: 'node (vitest 1)' },
      { pid: 112, ppid: 103, args: 'node (vitest 2)' },
      { pid: 113, ppid: 103, args: 'node (vitest 3)' },
      { pid: 114, ppid: 103, args: 'node (vitest 4)' },
      { pid: 200, ppid: 1, args: 'node --import tsx /r/scripts/engine/cli.ts start' },
      {
        pid: 201,
        ppid: 200,
        args: '/r/node_modules/@esbuild/darwin-arm64/bin/esbuild --service=0.25.0 --ping',
      },
      { pid: 300, ppid: 1, args: 'node /ide/typescript/lib/tsserver.js' },
    ];
    const classes = classifyTree(procs, { holderPid: 100 });
    const runs = findRuns(
      procs.map((p) => ({ ...p, cpuSeconds: 0, rssKb: 100, etimeSeconds: 5 })),
      classes,
      () => 10,
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ kind: 'vitest', pid: 103, workers: 4, inQueue: true });
    expect(classes.get(104)).toMatchObject({ cat: 'vitest' });
    expect(classes.get(201)).toMatchObject({ cat: 'projectman' });
    expect(classes.get(300)).toMatchObject({ cat: 'editor' });
  });

  it('gives an unknown child the category of its session and tells queue state', () => {
    const procs = [
      { pid: 1, ppid: 0, args: '/sbin/launchd' },
      { pid: 100, ppid: 1, args: 'node scripts/heavy/cli.ts npm test' },
      { pid: 101, ppid: 100, args: 'npm run test --workspaces' },
      { pid: 102, ppid: 101, args: 'node /r/node_modules/vitest/vitest.mjs run' },
      { pid: 103, ppid: 102, args: 'node (vitest 1)' },
      { pid: 104, ppid: 103, args: 'node some-fixture.js' },
      { pid: 200, ppid: 1, args: '/x/claude --foo' },
      { pid: 201, ppid: 200, args: '/bin/zsh -c something' },
      { pid: 202, ppid: 201, args: 'node /r/node_modules/vitest/vitest.mjs related a.ts' },
      { pid: 203, ppid: 202, args: 'node (vitest 1)' },
      { pid: 204, ppid: 202, args: 'node (vitest 2)' },
    ];
    const classes = classifyTree(procs, { holderPid: 100 });
    expect(classes.get(201)).toMatchObject({
      cat: 'ai-session',
      sub: 'claude',
      session: 200,
      provider: 'claude',
      inQueue: false,
    });
    expect(classes.get(104)).toMatchObject({ cat: 'vitest', own: false });
    expect(classes.get(102)?.inQueue).toBe(true);
    const runs = findRuns(
      procs.map((p) => ({ ...p, cpuSeconds: 0, rssKb: 100, etimeSeconds: 5 })),
      classes,
      () => 50,
    );
    const inside = runs.find((r) => r.pid === 102)!;
    const outside = runs.find((r) => r.pid === 202)!;
    expect(inside).toMatchObject({ workers: 1, inQueue: true, provider: null });
    expect(outside).toMatchObject({ workers: 2, inQueue: false, provider: 'claude', session: 200 });
  });
});

describe('load probe: heavy queue', () => {
  it('reads the holder and the live waiters, label only', () => {
    const files: Record<string, string> = {
      '/q/holder/owner.json': JSON.stringify({
        pid: 5,
        label: 'merge-test',
        cwd: '/Users/someone/x',
        ticket: 't',
        queuedAt: 'a',
        since: 'b',
      }),
      '/q/queue/2.json': JSON.stringify({ pid: 7, label: 'typecheck', sessionId: 'ses_1', cwd: '/secret' }),
      '/q/queue/1.json': JSON.stringify({ pid: 6, label: 'dead' }),
    };
    const fsApi = {
      readFileSync: (file: string) => {
        if (!(file in files)) throw new Error('ENOENT');
        return files[file];
      },
      readdirSync: () => ['2.json', '1.json'],
    };
    const queue = readHeavyQueueSync('/q', fsApi, (pid) => pid !== 6);
    expect(queue.holder).toMatchObject({ pid: 5, label: 'merge-test' });
    expect(queue.waiting.map((w) => w.pid)).toEqual([7]);
    expect(JSON.stringify(queue)).not.toContain('someone');
    expect(JSON.stringify(queue)).not.toContain('secret');
  });
});

describe('load probe: link log filter', () => {
  const line = (o: object) => JSON.stringify(o);

  it('keeps the link lines and only their numeric and enum fields', () => {
    const event = filterLogLine(
      line({
        level: 30,
        time: 1_760_000_000_000,
        msg: 'engine link: disconnected',
        code: 4400,
        cause: 'heartbeat',
        sinceHeardMs: 91000,
        connectedForMs: 5000,
        token: SECRET,
        url: `http://x/?t=${SECRET}`,
      }),
      'cloud',
    );
    expect(event).toMatchObject({ side: 'cloud', code: 4400, cause: 'heartbeat', sinceHeardMs: 91000 });
    expect(JSON.stringify(event)).not.toContain(SECRET);
    expect(filterLogLine(line({ time: 1, level: 30, msg: 'something else' }), 'engine')).toBeNull();
    expect(filterLogLine('not json', 'engine')).toBeNull();
    expect(
      filterLogLine(line({ time: 1, level: 40, msg: 'x', reason: 'link_silent' }), 'engine')?.reason,
    ).toBe('link_silent');
  });

  it('counts the drops by code and cause', () => {
    const events = filterLogText(
      [
        line({ time: 1_760_000_000_000, level: 30, msg: 'engine link: connected', attempts: 1 }),
        line({
          time: 1_760_000_100_000,
          level: 30,
          msg: 'engine link: disconnected',
          code: 4400,
          cause: 'heartbeat',
        }),
        line({ time: 1_760_000_200_000, level: 30, msg: 'engine link: disconnected', code: 1006 }),
        line({
          time: 1_760_000_300_000,
          level: 30,
          msg: 'engine link: connected',
          attempts: 2,
          downForMs: 1000,
        }),
      ].join('\n'),
      'engine',
    );
    expect(summarizeLinks(events)).toMatchObject({
      connected: 2,
      disconnected: 2,
      heartbeat: 1,
      byCode: { '4400': 1, '1006': 1 },
    });
  });
});

describe('load probe: window summary', () => {
  it('ranks categories, counts runs outside the queue and joins a drop with the 5 minutes before it', () => {
    const header = {
      type: 'header',
      interval: 30,
      label: 'w',
      host: { cpus: 8, memoryBytes: 16 * 1024 ** 3 },
    };
    const base = Date.parse('2026-10-19T12:00:00Z');
    const sample = (i: number, overrides: Record<string, unknown> = {}) => ({
      type: 'sample',
      t: new Date(base + i * 30_000).toISOString(),
      tMs: base + i * 30_000,
      load: [10, 8, 6],
      cpu: { user: 50, sys: 25, idle: 25 },
      swap: { totalBytes: 10 * 1024 ** 3, usedBytes: 5 * 1024 ** 3 },
      pressure: 1,
      heavy: { holder: null, waiting: [] },
      sessions: { claude: 2 },
      aggr: {
        'ai-session|claude': { n: 3, cpuPct: 100, rssKb: 1024 * 400 },
        'fs-index|fseventsd': { n: 1, cpuPct: 300, rssKb: 1024 * 800 },
      },
      runs: [
        {
          kind: 'vitest',
          pid: 9,
          workers: 4,
          cpuPct: 200,
          rssKb: 1,
          inQueue: false,
          provider: 'claude',
          env: {},
          maxWorkersArg: null,
        },
        {
          kind: 'typecheck',
          pid: 10,
          workers: null,
          cpuPct: 100,
          rssKb: 1,
          inQueue: false,
          provider: 'claude',
        },
      ],
      errors: [],
      ...overrides,
    });
    const samples = Array.from({ length: 12 }, (_, i) => sample(i));
    const drop = {
      ts: new Date(base + 11 * 30_000).toISOString(),
      tMs: base + 11 * 30_000,
      side: 'engine',
      level: 30,
      msg: 'engine link: disconnected',
      code: 4400,
      cause: 'heartbeat',
    };
    const summary = summarizeWindow([header, ...samples], [drop]);
    expect(summary.window).toMatchObject({ samples: 12, cores: 8, defaultTestWorkers: 4, intervalS: 30 });
    expect(summary.ranking[0]).toMatchObject({ category: 'fs-index' });
    expect(summary.ranking[0].cpuCores.mean).toBe(3);
    expect(summary.machine.samplesLoad1AboveCores).toBe(12);
    expect(summary.machine.unaccountedCpuCoresMean).toBe(2);
    expect(summary.vitestRuns).toEqual([
      expect.objectContaining({
        pid: 9,
        maxWorkersObserved: 4,
        differs: false,
        overrides: ['queue-outside'],
      }),
    ]);
    expect(summary.heavyRunsOutsideQueue).toMatchObject({ samplesWithTwoOrMore: 12 });
    expect(summary.sessions.total.mean).toBe(2);
    expect(summary.linkDrops[0]).toMatchObject({
      code: 4400,
      load1Max: 10,
      highLoad: true,
      samplesBefore: 11,
    });
    expect(summary.linkDrops[0].top3[0]).toMatchObject({ category: 'fs-index' });
  });

  it('marks a sampling gap and a drop inside it', () => {
    const header = { type: 'header', interval: 30, host: { cpus: 4, memoryBytes: 8 * 1024 ** 3 } };
    const base = Date.parse('2026-10-19T12:00:00Z');
    const mk = (ms: number) => ({
      type: 'sample',
      t: new Date(ms).toISOString(),
      tMs: ms,
      load: [1, 1, 1],
      cpu: null,
      pressure: 1,
      aggr: {},
      runs: [],
      sessions: {},
    });
    const summary = summarizeWindow(
      [header, mk(base), mk(base + 30_000), mk(base + 30 * 60_000)],
      [
        {
          ts: new Date(base + 10 * 60_000).toISOString(),
          tMs: base + 10 * 60_000,
          side: 'engine',
          level: 30,
          msg: 'engine link: disconnected',
          code: 1006,
        },
      ],
    );
    expect(summary.window.samplingGaps).toHaveLength(1);
    expect(summary.linkDrops[0].duringSamplingGap).toBe(true);
  });

  it('defaultTestWorkers matches the repository rule', () => {
    expect(defaultTestWorkers({ cpus: 10, memoryBytes: 32 * 1024 ** 3 })).toBe(4);
    expect(defaultTestWorkers({ cpus: 4, memoryBytes: 32 * 1024 ** 3 })).toBe(2);
    expect(defaultTestWorkers({ cpus: 10, memoryBytes: 8 * 1024 ** 3 })).toBe(2);
    expect(defaultTestWorkers({ cpus: 1, memoryBytes: 1024 ** 3 })).toBe(1);
  });
});
