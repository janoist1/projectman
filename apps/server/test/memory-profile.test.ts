import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeHeapSnapshot } from 'node:v8';
import { routes } from '@projectman/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The cloud memory tools (PM-773, docs/HYBRID.md "Memory profile"): `deploy/cloud/memory-probe.mjs`,
 * `memory-profile.mjs` and `heap-summary.mjs`. Nothing here starts the real server: the profile runs
 * against a small fake server that speaks the few routes the load asks for.
 */

const root = fileURLToPath(new URL('../../../', import.meta.url));
const cloudDir = join(root, 'deploy/cloud');
const profilePath = join(cloudDir, 'memory-profile.mjs');
const summaryPath = join(cloudDir, 'heap-summary.mjs');

/* eslint-disable @typescript-eslint/no-explicit-any -- the tools are plain ESM without types */
const load = (name: string): Promise<any> => import(pathToFileURL(join(cloudDir, name)).href);

let temp: string;
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'pm-memory-profile-'));
});
afterEach(() => {
  rmSync(temp, { recursive: true, force: true });
});

function runNode(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: temp, TMPDIR: temp, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
}

function copyHome(withMarker = true): string {
  const home = join(temp, 'home');
  mkdirSync(home, { recursive: true });
  if (withMarker) writeFileSync(join(home, '.memory-profile-copy'), '');
  return home;
}

describe('image and guide', () => {
  it('the Dockerfile copies the three tools, and the guide and the inventory name them', () => {
    const dockerfile = readFileSync(join(cloudDir, 'Dockerfile'), 'utf8');
    const guide = readFileSync(join(root, 'docs/HYBRID.md'), 'utf8');
    const architecture = readFileSync(join(root, 'docs/ARCHITECTURE.md'), 'utf8');
    for (const name of ['memory-probe.mjs', 'memory-profile.mjs', 'heap-summary.mjs']) {
      expect(dockerfile).toContain(`deploy/cloud/${name}`);
      expect(guide).toContain(name);
      expect(architecture).toContain(name);
    }
    expect(guide).toContain('## Memory profile');
    expect(guide).toContain('--network none');
    expect(guide).toContain('.memory-profile-copy');
  });
});

describe('memory-profile command line', () => {
  it('has the documented defaults', async () => {
    const { parseArgs, DEFAULT_SERVER } = await load('memory-profile.mjs');
    const options = parseArgs(['--home', '/data', '--out', '/out']);
    expect(options).toMatchObject({
      home: '/data',
      out: '/out',
      server: DEFAULT_SERVER,
      port: 4790,
      durationMin: 60,
      heapLimitMb: null,
      env: [],
      loginFile: null,
      rounds: 20,
      concurrency: 4,
    });
    expect(DEFAULT_SERVER).toBe('/app/apps/server/dist/index.js');
  });

  it('reads every option, in both spellings, and repeats --env', async () => {
    const { parseArgs } = await load('memory-profile.mjs');
    const options = parseArgs([
      '--home=/data',
      '--out',
      '/out',
      '--server',
      '/srv/index.js',
      '--port',
      '4800',
      '--duration-min=30',
      '--heap-limit-mb',
      '450',
      '--env',
      'MALLOC_ARENA_MAX=2',
      '--env',
      'TOKEN=a=b',
      '--login-file',
      '/in/login.json',
      '--rounds',
      '5',
      '--concurrency',
      '2',
    ]);
    expect(options).toMatchObject({
      server: '/srv/index.js',
      port: 4800,
      durationMin: 30,
      heapLimitMb: 450,
      env: [
        ['MALLOC_ARENA_MAX', '2'],
        ['TOKEN', 'a=b'],
      ],
      loginFile: '/in/login.json',
      rounds: 5,
      concurrency: 2,
    });
  });

  it.each([
    [[], '--home is required'],
    [['--home', '/d'], '--out is required'],
    [['--home', '/d', '--out', '/o', '--port', '0'], '--port'],
    [['--home', '/d', '--out', '/o', '--port', '70000'], '--port'],
    [['--home', '/d', '--out', '/o', '--port', 'abc'], '--port'],
    [['--home', '/d', '--out', '/o', '--duration-min', '0'], '--duration-min'],
    [['--home', '/d', '--out', '/o', '--heap-limit-mb', '1.5'], '--heap-limit-mb'],
    [['--home', '/d', '--out', '/o', '--rounds', '0'], '--rounds'],
    [['--home', '/d', '--out', '/o', '--concurrency', '-1'], '--concurrency'],
    [['--home', '/d', '--out', '/o', '--env', 'NOEQUALS'], '--env'],
    [['--home', '/d', '--out', '/o', '--env', 'BAD-NAME=1'], '--env'],
    [['--home', '/d', '--out', '/o', '--env', 'PROJECTMAN_HOME=/live'], 'set by the profile'],
    [['--home', '/d', '--out', '/o', '--env', 'PORT=1'], 'set by the profile'],
    [['--home', '/d', '--out', '/o', '--env', 'A=1', '--env', 'A=2'], 'given twice'],
    [['--home', '/d', '--out', '/o', '--port'], 'needs a value'],
    [['--home', '/d', '--out', '/o', '--bogus', '1'], 'unknown option'],
    [['--home', '/d', '--out', '/o', 'stray'], 'unexpected argument'],
    [['--home', '/d', '--home', '/e', '--out', '/o'], 'given twice'],
  ])('refuses %j', async (argv, message) => {
    const { parseArgs, UsageError } = await load('memory-profile.mjs');
    let error: unknown;
    try {
      parseArgs(argv);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toContain(message);
  });
});

describe('memory-profile refusals (exit 64, nothing started)', () => {
  it('refuses a home without the marker, and creates nothing', () => {
    const home = copyHome(false);
    const out = join(temp, 'out');
    const result = runNode([profilePath, '--home', home, '--out', out]);
    expect(result.status).toBe(64);
    expect(result.stderr).toContain('.memory-profile-copy');
    expect(existsSync(out)).toBe(false);
  });

  it('refuses a missing home', () => {
    const result = runNode([profilePath, '--home', join(temp, 'nothing'), '--out', join(temp, 'out')]);
    expect(result.status).toBe(64);
  });

  it('refuses an --out that is not empty, and leaves it as it was', () => {
    const home = copyHome();
    const out = join(temp, 'out');
    mkdirSync(out);
    writeFileSync(join(out, 'earlier.txt'), 'keep');
    const result = runNode([profilePath, '--home', home, '--out', out, '--server', process.execPath]);
    expect(result.status).toBe(64);
    expect(result.stderr).toContain('not empty');
    expect(readdirSync(out)).toEqual(['earlier.txt']);
  });

  it('refuses an --out that is a file', () => {
    const home = copyHome();
    const out = join(temp, 'out');
    writeFileSync(out, 'file');
    const result = runNode([profilePath, '--home', home, '--out', out, '--server', process.execPath]);
    expect(result.status).toBe(64);
  });

  it('refuses a bad parameter and a server that is not there', () => {
    const home = copyHome();
    expect(runNode([profilePath, '--home', home, '--out', join(temp, 'o1'), '--port', 'x']).status).toBe(64);
    const missing = runNode([
      profilePath,
      '--home',
      home,
      '--out',
      join(temp, 'o2'),
      '--server',
      join(temp, 'no.js'),
    ]);
    expect(missing.status).toBe(64);
    expect(missing.stderr).toContain('--server not found');
  });

  it('refuses a malformed login file without echoing it', () => {
    const home = copyHome();
    const loginFile = join(temp, 'login.json');
    writeFileSync(loginFile, JSON.stringify({ email: 'someone@example.test' }));
    const result = runNode([
      profilePath,
      '--home',
      home,
      '--out',
      join(temp, 'out'),
      '--server',
      process.execPath,
      '--login-file',
      loginFile,
    ]);
    expect(result.status).toBe(64);
    expect(result.stderr).not.toContain('someone@example.test');
  });

  it('prints the usage for --help', () => {
    const result = runNode([profilePath, '--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--home <dir> --out <dir>');
  });
});

describe('what the profile hands to the server', () => {
  it('starts it with a clean environment and the documented node flags', async () => {
    const { parseArgs, buildServerEnv, buildNodeArgs, nodeFlags, PROBE_PATH } =
      await load('memory-profile.mjs');
    const options = parseArgs([
      '--home',
      '/copy',
      '--out',
      '/out',
      '--server',
      '/srv/index.js',
      '--port',
      '4791',
      '--heap-limit-mb',
      '450',
      '--env',
      'MALLOC_ARENA_MAX=2',
    ]);
    const env = buildServerEnv(options, {
      PATH: '/bin',
      HOME: '/home/x',
      TMPDIR: '/tmpdir',
      ANTHROPIC_API_KEY: 'sk-secret',
      PROJECTMAN_HOME: '/live',
      PROJECTMAN_CLOUD_TOKEN: 'secret',
      LITESTREAM_ACCESS_KEY_ID: 'secret',
    });
    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/home/x',
      TMPDIR: '/tmpdir',
      PROJECTMAN_HOME: '/copy',
      PROJECTMAN_MODE: 'cloud',
      HOST: '127.0.0.1',
      PORT: '4791',
      NODE_ENV: 'production',
      PM_MEMORY_PROBE_FILE: '/out/probe.jsonl',
      PM_MEMORY_PROBE_MS: '5000',
      MALLOC_ARENA_MAX: '2',
    });
    expect(nodeFlags(options)).toEqual(['--heapsnapshot-signal=SIGUSR2', '--max-old-space-size=450']);
    expect(buildNodeArgs(options)).toEqual([
      '--import',
      PROBE_PATH,
      '--heapsnapshot-signal=SIGUSR2',
      '--max-old-space-size=450',
      '--diagnostic-dir=/out',
      '/srv/index.js',
    ]);
    expect(nodeFlags(parseArgs(['--home', '/c', '--out', '/o']))).toEqual(['--heapsnapshot-signal=SIGUSR2']);
  });

  it('asks the routes the web app uses', async () => {
    const { LOAD_ROUTES } = await load('memory-profile.mjs');
    expect(LOAD_ROUTES).toEqual({
      setupStatus: routes.setupStatus(),
      login: routes.login(),
      me: routes.me(),
      projects: routes.projects(),
      board: routes.board(':key'),
      tasks: routes.tasks(':key'),
      inbox: routes.inbox(':key'),
      teamThreads: routes.teamThreads(':key'),
      involvements: routes.involvements(':key'),
      task: routes.task(':key', ':taskKey'),
    });
  });

  it('summarises request records per route template', async () => {
    const { summarizeEndpoints, percentile } = await load('memory-profile.mjs');
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
    const records = [
      { route: '/api/b', ms: 10, bytes: 100, ok: true },
      { route: '/api/b', ms: 30, bytes: 300, ok: true },
      { route: '/api/b', ms: 20, bytes: 0, ok: false },
      { route: '/api/a', ms: 5, bytes: 7, ok: true },
    ];
    expect(summarizeEndpoints(records)).toEqual([
      { route: '/api/a', count: 1, p50Ms: 5, p95Ms: 5, maxMs: 5, medianBytes: 7, errors: 0 },
      { route: '/api/b', count: 3, p50Ms: 20, p95Ms: 30, maxMs: 30, medianBytes: 100, errors: 1 },
    ]);
  });
});

describe('memory-probe', () => {
  it('appends one JSON line of the documented shape per interval and stays out of stdout', () => {
    const file = join(temp, 'probe.jsonl');
    const script = join(temp, 'wait.mjs');
    writeFileSync(script, 'setTimeout(() => {}, 700);');
    const result = runNode(['--import', join(cloudDir, 'memory-probe.mjs'), script], {
      PM_MEMORY_PROBE_FILE: file,
      PM_MEMORY_PROBE_MS: '100',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    const lines = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) {
      expect(Object.keys(line).sort()).toEqual(
        [
          'arrayBuffers',
          'cpuSystemMs',
          'cpuUserMs',
          'external',
          'heapSizeLimit',
          'heapTotal',
          'heapUsed',
          'rss',
          't',
          'uptimeS',
        ].sort(),
      );
      expect(new Date(line.t).toISOString()).toBe(line.t);
      expect(line.rss).toBeGreaterThan(line.heapUsed);
      expect(line.heapSizeLimit).toBeGreaterThan(0);
    }
    expect(lines.at(-1).uptimeS).toBeGreaterThan(lines[0].uptimeS);
  });

  it('does nothing without a file, and its timer does not keep the process alive', () => {
    const script = join(temp, 'quick.mjs');
    writeFileSync(script, 'console.log("done");');
    const started = Date.now();
    const result = runNode(['--import', join(cloudDir, 'memory-probe.mjs'), script], {
      PM_MEMORY_PROBE_MS: '10000',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('done\n');
    expect(Date.now() - started).toBeLessThan(5000);
    const file = join(temp, 'p.jsonl');
    expect(
      runNode(['--import', join(cloudDir, 'memory-probe.mjs'), script], {
        PM_MEMORY_PROBE_FILE: file,
        PM_MEMORY_PROBE_MS: '60000',
      }).status,
    ).toBe(0);
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1);
  });
});

describe('heap-summary', () => {
  const layout = {
    snapshot: {
      meta: {
        node_fields: ['type', 'name', 'id', 'self_size', 'edge_count', 'trace_node_id', 'detachedness'],
        node_types: [
          [
            'hidden',
            'array',
            'string',
            'object',
            'code',
            'closure',
            'regexp',
            'number',
            'native',
            'synthetic',
          ],
          'string',
          'number',
          'number',
          'number',
          'number',
          'number',
        ],
        edge_fields: ['type', 'name_or_index', 'to_node'],
      },
      node_count: 5,
      edge_count: 2,
    },
  };
  // type, name (index into strings), id, self_size, edge_count, trace_node_id, detachedness
  const nodes = [
    3, 1, 1, 100, 0, 0, 0, 3, 2, 3, 300, 1, 0, 0, 3, 2, 5, 200, 1, 0, 0, 2, 3, 7, 50, 0, 0, 0, 5, 4, 9, 10, 0,
    0, 0,
  ];
  const strings = ['', 'Object', 'Widget', 'hunter2-secret-password', 'handler "quoted" \\ name'];
  const text = `{"snapshot":${JSON.stringify(layout.snapshot)},\n"nodes":[${nodes.join(',')}],\n"edges":[0,1,2,3,4,5],\n"trace_function_infos":[],\n"trace_tree":[],\n"samples":[],\n"locations":[],\n"strings":${JSON.stringify(strings)}}`;

  it('counts the live bytes and groups by type and constructor name, whatever the chunking', async () => {
    const { createSnapshotSummarizer } = await load('heap-summary.mjs');
    for (const size of [1, 7, 1000]) {
      const summarizer = createSnapshotSummarizer();
      for (let i = 0; i < text.length; i += size) summarizer.feed(text.slice(i, i + size));
      expect(summarizer.finish()).toEqual({
        liveBytes: 660,
        nodeCount: 5,
        byType: [
          { type: 'object', name: 'Widget', count: 2, selfBytes: 500 },
          { type: 'object', name: 'Object', count: 1, selfBytes: 100 },
          { type: 'string', name: '(value hidden)', count: 1, selfBytes: 50 },
          { type: 'closure', name: 'handler "quoted" \\ name', count: 1, selfBytes: 10 },
        ],
      });
    }
  });

  it('prints JSON on stdout and never string content', () => {
    const file = join(temp, 'tiny.heapsnapshot');
    writeFileSync(file, text);
    const result = runNode([summaryPath, file]);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('hunter2');
    expect(JSON.parse(result.stdout)).toMatchObject({ liveBytes: 660, nodeCount: 5 });
  });

  it('refuses a missing argument and a file that is not a snapshot', () => {
    expect(runNode([summaryPath]).status).toBe(64);
    const file = join(temp, 'bad.heapsnapshot');
    writeFileSync(file, '{"nodes":[1,2,3]}');
    const result = runNode([summaryPath, file]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('heap-summary:');
    writeFileSync(file, text.slice(0, 100));
    expect(runNode([summaryPath, file]).status).toBe(1);
  });

  it('summarises a real snapshot: top 40 groups, no string content', () => {
    const secret = `SNAPSHOT-ONLY-SECRET-${'x'.repeat(40)}`;
    class RetainedWidget {
      readonly label = secret + Math.random();
    }
    const retained = Array.from({ length: 150_000 }, () => new RetainedWidget());
    const file = join(temp, 'real.heapsnapshot');
    writeHeapSnapshot(file);
    const result = runNode([summaryPath, file]);
    expect(retained.length).toBe(150_000);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('SNAPSHOT-ONLY-SECRET');
    const summary = JSON.parse(result.stdout);
    expect(summary.liveBytes).toBeGreaterThan(1_000_000);
    expect(summary.nodeCount).toBeGreaterThan(10_000);
    expect(summary.byType.length).toBeLessThanOrEqual(40);
    expect(summary.byType.length).toBeGreaterThan(10);
    const sizes = summary.byType.map((row: { selfBytes: number }) => row.selfBytes);
    expect([...sizes].sort((a, b) => b - a)).toEqual(sizes);
    expect(summary.byType.some((row: { name: string }) => row.name === 'RetainedWidget')).toBe(true);
    for (const row of summary.byType) {
      expect(Object.keys(row).sort()).toEqual(['count', 'name', 'selfBytes', 'type']);
    }
  });
});

const FAKE_SERVER = `
import http from 'node:http';
import { writeFileSync } from 'node:fs';

const tasks = Array.from({ length: 12 }, (_, i) => ({
  key: 'SEC-' + (i + 1),
  title: 'secret title ' + i,
  description: 'x'.repeat(100 + i * 10),
}));
globalThis.retained = tasks;
const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    const path = req.url.split('?')[0];
    if (req.method === 'GET' && path === '/api/setup') return send(res, 200, { needsSetup: false });
    if (req.method === 'POST' && path === '/api/auth/login') {
      const body = JSON.parse(raw);
      if (body.email !== 'owner@example.test' || body.password !== 'correct horse battery') return send(res, 401, {});
      res.setHeader('set-cookie', 'pm_session=SECRETCOOKIE; Path=/; HttpOnly');
      return send(res, 200, {});
    }
    if (!String(req.headers.cookie).includes('pm_session=SECRETCOOKIE')) return send(res, 401, {});
    if (path === '/api/me') return send(res, 200, { email: 'owner@example.test' });
    if (path === '/api/projects') return send(res, 200, [{ key: 'SEC', name: 'Secret project' }]);
    if (path === '/api/projects/SEC/tasks') return send(res, 200, tasks);
    const card = /^\\/api\\/projects\\/SEC\\/tasks\\/(SEC-\\d+)$/.exec(path);
    if (card) return send(res, 200, tasks.find((t) => t.key === card[1]) ?? {});
    if (['board', 'inbox', 'messages/threads', 'involvements'].some((p) => path === '/api/projects/SEC/' + p)) return send(res, 200, {});
    send(res, 404, {});
  });
});
server.listen(Number(process.env.PORT), process.env.HOST, () => {
  if (process.env.FAKE_DUMP) {
    writeFileSync(process.env.FAKE_DUMP, JSON.stringify({ env: Object.keys(process.env).sort(), execArgv: process.execArgv }));
  }
});
`;

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

describe('memory-profile against a fake server', () => {
  it('writes the report, snapshots and probe lines, with no key, title, address or cookie in the report', async () => {
    const home = copyHome();
    const out = join(temp, 'out');
    const serverFile = join(temp, 'fake-server.mjs');
    const dump = join(temp, 'dump.json');
    const loginFile = join(temp, 'login.json');
    writeFileSync(serverFile, FAKE_SERVER);
    writeFileSync(
      loginFile,
      JSON.stringify({ email: 'owner@example.test', password: 'correct horse battery' }),
    );
    const port = await freePort();

    const result = runNode(
      [
        profilePath,
        '--home',
        home,
        '--out',
        out,
        '--server',
        serverFile,
        '--port',
        String(port),
        '--duration-min',
        '0.1',
        '--start-delay-s',
        '0.5',
        '--idle-every-min',
        '0.04',
        '--probe-ms',
        '100',
        '--heap-limit-mb',
        '256',
        '--env',
        'MALLOC_ARENA_MAX=2',
        '--env',
        `FAKE_DUMP=${dump}`,
        '--login-file',
        loginFile,
        '--rounds',
        '3',
        '--concurrency',
        '2',
      ],
      { ANTHROPIC_API_KEY: 'sk-parent-secret', PROJECTMAN_VERSION: 'abc123' },
    );
    expect(result.status, result.stderr).toBe(0);

    // The server got a clean environment and the documented flags.
    const seen = JSON.parse(readFileSync(dump, 'utf8')) as { env: string[]; execArgv: string[] };
    // macOS adds `__CF_USER_TEXT_ENCODING` to every process by itself.
    expect(seen.env.filter((name) => !name.startsWith('__'))).toEqual(
      [
        'FAKE_DUMP',
        'HOME',
        'HOST',
        'MALLOC_ARENA_MAX',
        'NODE_ENV',
        'PATH',
        'PM_MEMORY_PROBE_FILE',
        'PM_MEMORY_PROBE_MS',
        'PORT',
        'PROJECTMAN_HOME',
        'PROJECTMAN_MODE',
        'TMPDIR',
      ].sort(),
    );
    expect(seen.execArgv).toContain('--heapsnapshot-signal=SIGUSR2');
    expect(seen.execArgv).toContain('--max-old-space-size=256');
    expect(seen.execArgv).toContain('--import');

    // The files.
    const files = readdirSync(out).sort();
    for (const name of [
      'probe.jsonl',
      'report.json',
      'report.md',
      'server.log',
      'start.heapsnapshot',
      'load-end.heapsnapshot',
      'end.heapsnapshot',
    ]) {
      expect(files).toContain(name);
    }
    expect(files.filter((name) => name.endsWith('.heapsnapshot')).sort()).toEqual([
      'end.heapsnapshot',
      'load-end.heapsnapshot',
      'start.heapsnapshot',
    ]);

    // The report.
    const reportText = readFileSync(join(out, 'report.json'), 'utf8');
    const report = JSON.parse(reportText);
    expect(Object.keys(report).sort()).toEqual(
      [
        'arch',
        'endpoints',
        'env',
        'heapSizeLimitMb',
        'node',
        'nodeArgs',
        'phases',
        'platform',
        'sourceVersion',
        'startupMs',
      ].sort(),
    );
    expect(report.sourceVersion).toBe('abc123');
    expect(report.node).toBe(process.version);
    expect(report.platform).toBe(process.platform);
    expect(report.arch).toBe(process.arch);
    expect(report.heapSizeLimitMb).toBeGreaterThan(0);
    expect(report.heapSizeLimitMb).toBeLessThan(1000);
    expect(report.nodeArgs).toEqual(['--heapsnapshot-signal=SIGUSR2', '--max-old-space-size=256']);
    expect(report.env).toContain('MALLOC_ARENA_MAX');
    expect(report.startupMs).toBeGreaterThan(0);

    const names = report.phases.map((p: { name: string }) => p.name);
    expect(names.slice(0, 2)).toEqual(['ready', 'start']);
    expect(names).toContain('load');
    expect(names).toContain('load-end');
    expect(names.at(-1)).toBe('end');
    expect(names.indexOf('load-end')).toBeLessThan(names.indexOf('end'));
    for (const phase of report.phases) {
      expect(Object.keys(phase).sort()).toEqual([
        'at',
        'cpuMs',
        'heapUsedMb',
        'hwmMb',
        'liveHeapMb',
        'name',
        'rssMb',
        'swapMb',
      ]);
      expect(phase.rssMb).toBeGreaterThan(0);
      expect(phase.heapUsedMb).toBeGreaterThan(0);
    }
    const byName = (name: string) => report.phases.find((p: { name: string }) => p.name === name);
    for (const name of ['start', 'load-end', 'end']) expect(byName(name).liveHeapMb).toBeGreaterThan(0);
    expect(byName('ready').liveHeapMb).toBeNull();
    if (process.platform !== 'linux') {
      expect(byName('start').hwmMb).toBeNull();
      expect(byName('start').swapMb).toBeNull();
    }

    const endpoint = (route: string) => report.endpoints.find((e: { route: string }) => e.route === route);
    expect(endpoint('/api/auth/login')).toMatchObject({ count: 1, errors: 0 });
    for (const route of [
      '/api/me',
      '/api/projects',
      '/api/projects/:key/board',
      '/api/projects/:key/tasks',
      '/api/projects/:key/inbox',
      '/api/projects/:key/messages/threads',
      '/api/projects/:key/involvements',
    ]) {
      expect(endpoint(route), route).toMatchObject({ count: 3, errors: 0 });
    }
    expect(endpoint('/api/projects/:key/tasks/:taskKey')).toMatchObject({ count: 30, errors: 0 });
    expect(endpoint('/api/projects/:key/tasks').medianBytes).toBeGreaterThan(500);
    for (const e of report.endpoints) {
      expect(Object.keys(e).sort()).toEqual([
        'count',
        'errors',
        'maxMs',
        'medianBytes',
        'p50Ms',
        'p95Ms',
        'route',
      ]);
      expect(e.p95Ms).toBeGreaterThanOrEqual(e.p50Ms);
      expect(e.maxMs).toBeGreaterThanOrEqual(e.p95Ms);
    }

    // The probe.
    const probe = readFileSync(join(out, 'probe.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(probe.length).toBeGreaterThan(5);

    // Nothing of the data in the report, the way it travels to the card, or the cookie.
    const markdown = readFileSync(join(out, 'report.md'), 'utf8');
    const summaries = ['start', 'load-end', 'end'].map((name) =>
      readFileSync(join(out, `${name}.summary.json`), 'utf8'),
    );
    for (const text of [reportText, markdown, ...summaries]) {
      for (const secret of [
        'SEC-',
        'SEC/',
        'Secret project',
        'secret title',
        'owner@example.test',
        'correct horse',
        'SECRETCOOKIE',
        'pm_session',
        'sk-parent-secret',
        home,
      ]) {
        expect(text, secret).not.toContain(secret);
      }
    }
    expect(markdown).toContain('/api/projects/:key/board');
    expect(markdown).toContain('live heap');
    const log = readFileSync(join(out, 'server.log'), 'utf8');
    expect(log).not.toContain('sk-parent-secret');
  }, 120_000);

  it('stops with exit 1 and still writes a report when the server dies at once', async () => {
    const home = copyHome();
    const out = join(temp, 'out');
    const serverFile = join(temp, 'dies.mjs');
    writeFileSync(serverFile, 'process.exit(3);');
    const result = runNode([
      profilePath,
      '--home',
      home,
      '--out',
      out,
      '--server',
      serverFile,
      '--port',
      String(await freePort()),
      '--probe-ms',
      '100',
      '--ready-timeout-s',
      '10',
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('exited early');
    expect(readFileSync(join(out, 'report.md'), 'utf8')).toContain('INCOMPLETE');
    expect(JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')).phases).toEqual([]);
  }, 60_000);
});
