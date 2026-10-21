import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { HistoryViewer } from '@projectman/shared';
import Database from 'better-sqlite3';
import { build } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { historyDocumentEntityId, historySourceId } from '../src/db';
import { createProfileControl } from '../src/history-semantic-profile-control';
import { historyHarness, OWNER_ACTOR } from './helpers/history';

/**
 * The release measurement of the history search's local embedding (PM-910): `deploy/cloud/history-semantic-profile.mjs`.
 * Nothing here measures memory: the Linux ARM64 / cgroup run is the card's own release check. These tests keep the
 * command line, the refusals, the unsupported outcome, the verdict, the report's shape and the seeding of the
 * disposable database (against the real indexer) true.
 */

const root = fileURLToPath(new URL('../../../', import.meta.url));
const toolPath = join(root, 'deploy/cloud/history-semantic-profile.mjs');

/* eslint-disable @typescript-eslint/no-explicit-any -- the tool is plain ESM without types */
const load = (): Promise<any> => import(pathToFileURL(toolPath).href);

let temp: string;
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'pm-semantic-profile-'));
});
afterEach(() => {
  rmSync(temp, { recursive: true, force: true });
});

const TYPES = ['task', 'note', 'question', 'message'] as const;

function fixture(overrides: Record<string, unknown> = {}) {
  const sources: Record<string, unknown>[] = [];
  TYPES.forEach((type) =>
    sources.push({ id: `${type}-1`, type, title: `A ${type}`, body: `The ${type} text` }),
  );
  sources.push({
    id: 'decisions',
    type: 'document',
    path: 'docs/DECISIONS.md',
    title: '',
    body: '1. **A decision**\nWhy.',
  });
  return {
    schemaVersion: 1,
    origin: 'synthetic test fixture',
    project: { key: 'AR' },
    sources,
    questions: Array.from({ length: 20 }, (_, i) => ({ question: `Question ${i}?`, targetId: 'task-1' })),
    negatives: [{ question: 'How long does bread rise?' }],
    ...overrides,
  };
}

function inputs() {
  const server = join(temp, 'bundle', 'index.js');
  const model = join(temp, 'model');
  const fixturePath = join(temp, 'fixture.json');
  mkdirSync(join(temp, 'bundle'));
  mkdirSync(model);
  writeFileSync(server, '');
  writeFileSync(join(model, 'manifest.json'), '{}');
  writeFileSync(fixturePath, JSON.stringify(fixture()));
  return { server, model, fixturePath, out: join(temp, 'out') };
}

const args = (i: ReturnType<typeof inputs>, extra: string[] = []) => [
  '--server',
  i.server,
  '--model-dir',
  i.model,
  '--fixture',
  i.fixturePath,
  '--out',
  i.out,
  ...extra,
];

describe('command line', () => {
  it('has the documented defaults and resolves the paths', async () => {
    const { parseArgs } = await load();
    const i = inputs();
    expect(parseArgs(args(i))).toMatchObject({ server: i.server, out: i.out, mixedSeconds: 600 });
  });

  it.each([
    ['a missing option', ['--server', '/a']],
    ['a relative path', ['--server', 'a', '--model-dir', '/b', '--fixture', '/c', '--out', '/d']],
    ['an unknown option', ['--nope', '1']],
    ['a mixed time below the least', ['--mixed-seconds', '599']],
    ['a mixed time that is no integer', ['--mixed-seconds', '600.5']],
  ])('refuses %s', async (_name, extra) => {
    const { parseArgs, UsageError } = await load();
    const full = ['--server', '/a', '--model-dir', '/b', '--fixture', '/c', '--out', '/d'];
    const argv = extra[0] === '--server' ? extra : [...full, ...extra];
    expect(() => parseArgs(argv)).toThrow(UsageError);
  });
});

describe('refusing before anything starts', () => {
  it('exits 64 for an out folder that is not empty and writes nothing', () => {
    const i = inputs();
    mkdirSync(i.out);
    writeFileSync(join(i.out, 'old.txt'), 'x');
    const result = spawnSync(process.execPath, [toolPath, ...args(i)], { encoding: 'utf8' });
    expect(result.status).toBe(64);
    expect(existsSync(join(i.out, 'report.json'))).toBe(false);
  });

  it.each([
    ['inside the bundle folder', (i: ReturnType<typeof inputs>) => join(i.server, '..', 'out')],
    [
      'a symbolic link',
      (i: ReturnType<typeof inputs>) => {
        const link = join(temp, 'link');
        mkdirSync(join(temp, 'real'));
        symlinkSync(join(temp, 'real'), link);
        return link;
      },
    ],
    ['the root', () => '/'],
  ])('refuses an out folder that is %s', async (_name, pick) => {
    const { prepareRun, UsageError } = await load();
    const i = inputs();
    expect(() =>
      prepareRun({ server: i.server, modelDir: i.model, fixture: i.fixturePath, out: pick(i) }),
    ).toThrow(UsageError);
  });

  it('refuses a fixture that cannot carry the measurement', async () => {
    const { validateFixture, UsageError } = await load();
    const fewQuestions = fixture({ questions: fixture().questions.slice(0, 19) });
    const noDocument = fixture({ sources: fixture().sources.filter((s) => s.type !== 'document') });
    const badTarget = fixture({ questions: [{ question: 'x?', targetId: 'nope' }] });
    for (const bad of [fewQuestions, noDocument, badTarget]) {
      expect(() => validateFixture(bad)).toThrow(UsageError);
    }
    expect(validateFixture(fixture())).toMatchObject({ schemaVersion: 1 });
  });
});

describe('the machine', () => {
  const cgroupFiles = (max: string, swap: string) => ({
    '/proc/self/cgroup': '0::/pm\n',
    '/sys/fs/cgroup/pm/memory.max': max,
    '/sys/fs/cgroup/pm/memory.swap.max': swap,
    '/sys/fs/cgroup/pm/memory.current': '1000',
    '/sys/fs/cgroup/pm/memory.events': 'oom_kill 0\n',
  });
  const check = async (platform: string, arch: string, files: Record<string, string>, model = true) => {
    const { checkMachine } = await load();
    return checkMachine({
      platform,
      arch,
      read: (path: string) => {
        if (path in files) return files[path];
        throw new Error('missing');
      },
      exists: () => model,
      modelDir: '/model',
    });
  };

  it('accepts Linux ARM64 in a 2 GiB cgroup v2 without swap', async () => {
    expect((await check('linux', 'arm64', cgroupFiles('2147483648', '0'))).reasons).toEqual([]);
  });

  it.each([
    [
      'another platform',
      ['darwin', 'arm64', cgroupFiles('2147483648', '0')],
      ['unsupported_platform', 'cgroup_unavailable'],
    ],
    ['an x64 machine', ['linux', 'x64', cgroupFiles('2147483648', '0')], ['unsupported_platform']],
    ['no memory limit', ['linux', 'arm64', cgroupFiles('max', '0')], ['cgroup_unavailable']],
    ['a limit above 2 GiB', ['linux', 'arm64', cgroupFiles('4294967296', '0')], ['cgroup_unavailable']],
    ['swap', ['linux', 'arm64', cgroupFiles('2147483648', 'max')], ['cgroup_unavailable']],
    ['no cgroup', ['linux', 'arm64', {}], ['cgroup_unavailable']],
  ])('reports %s as unsupported', async (_name, [platform, arch, files], reasons) => {
    expect(
      (await check(platform as string, arch as string, files as Record<string, string>)).reasons,
    ).toEqual(reasons);
  });

  it('reports a missing model', async () => {
    expect((await check('linux', 'arm64', cgroupFiles('2147483648', '0'), false)).reasons).toEqual([
      'model_unavailable',
    ]);
  });

  it('exits 78 with an unsupported report, not a measurement, where it cannot run', () => {
    if (process.platform === 'linux' && process.arch === 'arm64') return;
    const i = inputs();
    const result = spawnSync(process.execPath, [toolPath, ...args(i)], { encoding: 'utf8' });
    expect(result.status).toBe(78);
    const report = JSON.parse(readFileSync(join(i.out, 'report.json'), 'utf8'));
    expect(report).toMatchObject({ outcome: 'unsupported', phases: [], extraRssBytes: null });
    expect(report.reasonCodes).toContain('unsupported_platform');
  });
});

describe('the verdict', () => {
  const MIB = 1024 * 1024;
  const phase = (name: string, extra: Record<string, unknown> = {}) => ({
    name,
    durationMs: 1000,
    rssPeakBytes: 600 * MIB,
    cgroupPeakBytes: 900 * MIB,
    swapPeakBytes: 0,
    oomKills: 0,
    semanticUsed: 1,
    searchP50Ms: 40,
    searchP95Ms: 80,
    searchMaxMs: 120,
    httpP95Ms: 100,
    eventLoopP95Ms: 12,
    ...extra,
  });
  const good = (over: Record<string, unknown> = {}) => ({
    phases: ['off', 'cold_load', 'backfill', 'warm', 'mixed', 'restart', 'off_again'].map((n) =>
      phase(n, n === 'off' ? { rssPeakBytes: 400 * MIB } : {}),
    ),
    extraRssBytes: 200 * MIB,
    recall: { topTen: 17, total: 20, negativesClean: true },
    memoryLimitBytes: 2048 * MIB,
    swapLimitBytes: 0,
    networkAttempts: 0,
    restartInterrupted: true,
    serverFailed: false,
    ...over,
  });

  it('passes a run inside the frame', async () => {
    const { evaluate } = await load();
    expect(evaluate(good())).toEqual({ outcome: 'pass', reasonCodes: [] });
  });

  it('never passes with a mandatory phase or number missing', async () => {
    const { evaluate } = await load();
    const noRestart = good();
    noRestart.phases = noRestart.phases.filter((p) => p.name !== 'restart');
    expect(evaluate(noRestart).reasonCodes).toContain('missing_phase');
    expect(evaluate(good({ extraRssBytes: null })).reasonCodes).toContain('missing_phase');
    const noRss = good();
    noRss.phases[3] = phase('warm', { rssPeakBytes: null });
    expect(evaluate(noRss).outcome).toBe('fail');
  });

  it.each([
    ['the extra RSS', { extraRssBytes: 351 * MIB }, 'memory_budget_exceeded'],
    ['the process RSS', { phases: 'rss' }, 'memory_budget_exceeded'],
    ['the cgroup peak', { phases: 'cgroup' }, 'memory_budget_exceeded'],
    ['swap', { phases: 'swap' }, 'memory_budget_exceeded'],
    ['an OOM kill', { phases: 'oom' }, 'oom_detected'],
    ['a slow warm question', { phases: 'slow' }, 'latency_budget_exceeded'],
    ['the control HTTP p95', { phases: 'http' }, 'latency_budget_exceeded'],
    ['a fallback instead of a semantic answer', { phases: 'fallback' }, 'recall_failed'],
    ['the recall', { recall: { topTen: 14, total: 20, negativesClean: true } }, 'recall_failed'],
    [
      'a changed negative control',
      { recall: { topTen: 18, total: 20, negativesClean: false } },
      'recall_failed',
    ],
    [
      'the recall in proportion',
      { recall: { topTen: 18, total: 25, negativesClean: true } },
      'recall_failed',
    ],
    ['a restart after finished indexing', { restartInterrupted: false }, 'missing_phase'],
    ['a restart with no word on the indexing', { restartInterrupted: null }, 'missing_phase'],
    ['a network attempt', { networkAttempts: 1 }, 'network_attempt'],
    ['a server failure', { serverFailed: true }, 'server_failed'],
  ])('fails on %s', async (_name, over, code) => {
    const { evaluate } = await load();
    const input = good();
    const change: Record<string, Record<string, Record<string, unknown>>> = {
      rss: { mixed: { rssPeakBytes: 1201 * MIB } },
      cgroup: { mixed: { cgroupPeakBytes: 1537 * MIB } },
      swap: { mixed: { swapPeakBytes: 1 } },
      oom: { restart: { oomKills: 1 } },
      slow: { warm: { searchMaxMs: 2001 } },
      http: { mixed: { httpP95Ms: 151 } },
      fallback: { warm: { semanticUsed: 0.95 } },
    };
    const { phases, ...rest } = over as { phases?: string };
    Object.assign(input, rest);
    if (phases) {
      for (const [name, values] of Object.entries(change[phases]!)) {
        const index = input.phases.findIndex((p) => p.name === name);
        input.phases[index] = { ...input.phases[index]!, ...values };
      }
    }
    expect(evaluate(input).reasonCodes).toContain(code);
  });

  it('judges the mixed phase by the control HTTP excess, not by its slowest search', async () => {
    const { evaluate } = await load();
    const input = good();
    input.phases[4] = phase('mixed', { searchMaxMs: 5000 });
    expect(evaluate(input)).toEqual({ outcome: 'pass', reasonCodes: [] });
  });

  it('allows the control HTTP p95 a larger excess of 20% or 50 ms', async () => {
    const { evaluate } = await load();
    const input = good();
    input.phases[0] = phase('off', { rssPeakBytes: 400 * MIB, httpP95Ms: 400 });
    input.phases[4] = phase('mixed', { httpP95Ms: 479 });
    expect(evaluate(input).outcome).toBe('pass');
  });
});

describe('the report', () => {
  it('holds exactly the shared keys per report and phase, and no other text', async () => {
    const { buildReport, renderMarkdown } = await load();
    const report = buildReport({
      sourceVersion: 'v1',
      imageDigest: 'sha256:abc',
      platform: 'linux',
      arch: 'arm64',
      nodeVersion: 'v24',
      modelIndexKey: 'key',
      memoryLimitBytes: 1,
      swapLimitBytes: 0,
      corpus: { sources: 1, chunks: 2, inputBytes: 3, origin: 'synthetic' },
      phases: [{ name: 'off', durationMs: 1, question: 'secret question', cookie: 'pm_session=x' }],
      extraRssBytes: null,
      outcome: 'fail',
      reasonCodes: ['missing_phase'],
      password: 'hunter2',
    });
    expect(Object.keys(report)).toEqual([
      'schemaVersion',
      'sourceVersion',
      'imageDigest',
      'platform',
      'arch',
      'nodeVersion',
      'modelIndexKey',
      'memoryLimitBytes',
      'swapLimitBytes',
      'corpus',
      'phases',
      'extraRssBytes',
      'outcome',
      'reasonCodes',
    ]);
    expect(Object.keys(report.phases[0])).toHaveLength(12);
    const text = JSON.stringify(report) + renderMarkdown(report);
    for (const secret of ['secret question', 'pm_session', 'hunter2']) expect(text).not.toContain(secret);
  });

  it('takes the embedding extra RSS from the two runs, not from their sum', async () => {
    const { extraRssOf } = await load();
    const phases = [
      { name: 'off', rssPeakBytes: 400 },
      { name: 'cold_load', rssPeakBytes: 500 },
      { name: 'mixed', rssPeakBytes: 700 },
      { name: 'off_again', rssPeakBytes: 410 },
    ];
    expect(extraRssOf(phases)).toBe(300);
    expect(extraRssOf(phases.slice(0, 1))).toBeNull();
  });
});

describe('reading the host', () => {
  it('reads the process memory in bytes and leaves a missing field null', async () => {
    const { parseProcessStatus } = await load();
    expect(parseProcessStatus('Name:\tnode\nVmHWM:\t  2048 kB\nVmRSS:\t  1024 kB\n')).toEqual({
      rssBytes: 1024 * 1024,
      hwmBytes: 2048 * 1024,
      swapBytes: null,
    });
  });

  it('counts only the open connections to a peer that is not this machine', async () => {
    const { countExternalPeers } = await load();
    const header = '  sl  local_address rem_address   st\n';
    const row = (remote: string, state: string) =>
      `   0: 0100007F:1F90 ${remote} ${state} 00000000:00000000\n`;
    const tcp = [
      header,
      row('0100007F:D431', '01'), // 127.0.0.1, established
      row('0100A8C0:0050', '01'), // 192.168.0.1, established
      row('0100A8C0:0050', '02'), // 192.168.0.1, being opened
      row('0100A8C0:0050', '0A'), // a listener's row, not a connection
    ].join('');
    const tcp6 = [
      header,
      row('00000000000000000000000001000000:D431', '01'), // ::1
      row('0000000000000000FFFF00000100007F:D431', '01'), // ::ffff:127.0.0.1
      row('B80D0120000000000000000001000000:01BB', '01'), // 2001:db8::1
    ].join('');
    expect(countExternalPeers(tcp, tcp6)).toBe(3);
  });

  it('takes the session cookie out of the Set-Cookie headers and nothing else', async () => {
    const { sessionCookieOf } = await load();
    expect(sessionCookieOf(['theme=dark; Path=/', 'pm_session=abc123; HttpOnly; Path=/'])).toBe(
      'pm_session=abc123',
    );
    expect(sessionCookieOf(['theme=dark'])).toBeNull();
  });
});

describe('the measurement search listener', () => {
  const SECRET = 'a-one-time-secret-for-tests';
  let server: ReturnType<typeof createProfileControl>;
  let calls: { projectKey: string; viewer: HistoryViewer; query: string }[];
  let failing: boolean;

  beforeEach(async () => {
    calls = [];
    failing = false;
    server = createProfileControl({
      secret: SECRET,
      facade: {
        search: async (projectKey, viewer, input) => {
          calls.push({ projectKey, viewer, query: input.query });
          if (failing) throw new Error('history text that must not leave');
          return {
            matches: [
              { sourceId: 'hsrc_1', matchType: 'both', title: 'a private title', snippet: 'private text' },
            ],
            hasMore: false,
          } as never;
        },
      },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const post = (
    body: unknown,
    headers: Record<string, string> = { 'x-profile-secret': SECRET },
    path = '/search',
  ) =>
    fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const good = { projectKey: 'AR', handle: 'owner', query: 'a question' };

  it('answers the source ids and how each matched, as the owner, with no text', async () => {
    const response = await post(good);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      hits: [{ sourceId: 'hsrc_1', matchType: 'both' }],
      hasMore: false,
    });
    expect(calls).toEqual([
      { projectKey: 'AR', viewer: { handle: 'owner', access: 'owner' }, query: 'a question' },
    ]);
  });

  it.each([
    ['a missing secret', {}, 401],
    ['a wrong secret', { 'x-profile-secret': 'a-different-secret-entirely' }, 401],
  ])('refuses %s before it reads anything', async (_name, headers, status) => {
    expect((await post(good, headers)).status).toBe(status);
    expect(calls).toEqual([]);
  });

  it('refuses another path, a large body and a body of the wrong shape', async () => {
    expect((await post(good, undefined, '/other')).status).toBe(404);
    expect((await post({ ...good, query: 'x'.repeat(9000) })).status).toBe(413);
    expect((await post('not json')).status).toBe(400);
    expect((await post({ projectKey: 'AR', handle: 'owner' })).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('answers a failed search with a bare error code, not its message', async () => {
    failing = true;
    const response = await post(good);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('{"error":"search_failed"}');
  });

  it('is not made with a short secret', () => {
    expect(() =>
      createProfileControl({ secret: 'short', facade: { search: async () => ({}) as never } }),
    ).toThrow();
  });
});

/** The server bundle as `scripts/build.mjs` makes it: the third-party dependencies stay external. */
const dependencies = Object.keys(
  JSON.parse(readFileSync(join(root, 'apps/server/package.json'), 'utf8')).dependencies ?? {},
).filter((name) => !name.startsWith('@projectman/'));
const bundle = (entry: string, outfile: string, write: boolean) =>
  build({
    entryPoints: [join(root, 'apps/server', entry)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: dependencies,
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
    write,
    metafile: true,
    logLevel: 'silent',
  });

describe('the server bundles', () => {
  it('keeps the measurement listener out of the server entry and puts it in the measurement entry', async () => {
    const [server, profile] = await Promise.all([
      bundle('src/index.ts', 'index.js', false),
      bundle('src/history-semantic-profile.ts', 'profile.js', false),
    ]);
    const inputs = (result: typeof server) => Object.keys(result.metafile.inputs);
    expect(inputs(server).some((path) => path.includes('history-semantic-profile'))).toBe(false);
    expect(inputs(profile).some((path) => path.endsWith('history-semantic-profile-control.ts'))).toBe(true);
    expect(inputs(profile).some((path) => path.endsWith('src/start.ts'))).toBe(true);
  }, 60_000);
});

describe('a run against a real server bundle', () => {
  // The Linux ARM64 / cgroup / model measurement is the release check; this keeps the orchestration true on any host:
  // a fake host reads fixed numbers, the model is missing, so the semantic server never becomes ready and the run
  // must stop with `server_failed` after it measured the baseline over a real server, a real login and real searches.
  it('measures the baseline, reports the semantic server that did not come up and keeps the history text out', async () => {
    // The bundle goes to the temp folder (the checkout can be read-only); the symlink lets it resolve its external
    // dependencies, as the built `dist` does in the checkout.
    const bundleDir = join(temp, 'smoke-bundle');
    mkdirSync(bundleDir);
    symlinkSync(join(root, 'node_modules'), join(bundleDir, 'node_modules'));
    const server = join(bundleDir, 'history-semantic-profile.js');
    await bundle('src/history-semantic-profile.ts', server, true);
    const i = { ...inputs(), server };
    // The words of the questions are in the sources, so the text search of the baseline finds something.
    writeFileSync(
      i.fixturePath,
      JSON.stringify(
        fixture({
          questions: Array.from({ length: 20 }, () => ({ question: 'The task text', targetId: 'task-1' })),
        }),
      ),
    );
    const { parseArgs, prepareRun, runProfile } = await load();
    const options = parseArgs(args(i));
    options.mixedSeconds = 1;
    const parsedFixture = prepareRun(options);
    const logs: string[] = [];
    const cgroup = {
      directory: join(temp, 'cgroup'),
      memoryMax: 2 * 1024 ** 3,
      stat: () => ({ current: 100 * 1024 ** 2, swapCurrent: 0, oomKill: 0 }),
      resetPeak: () => false,
      readPeak: () => null,
      cpuMax: () => null,
    };
    const host = {
      platform: 'linux',
      arch: 'arm64',
      nodeVersion: process.version,
      processStatus: () => ({ rssBytes: 200 * 1024 ** 2, hwmBytes: null, swapBytes: 0 }),
      resetProcessPeak: () => false,
      externalPeers: () => 0,
      cgroup,
    };
    const { report } = await runProfile({
      options,
      fixture: parsedFixture,
      host,
      log: (line: string) => logs.push(line),
      timing: { baselineSeconds: 3, readyMs: 20_000 },
    });
    const why = logs.join('\n');
    expect(report.outcome).toBe('fail');
    expect(report.reasonCodes).toContain('server_failed');
    expect(
      report.phases.map((phase: { name: string }) => phase.name),
      why,
    ).toEqual(['off']);
    expect(logs.some((line) => line.includes('semantic'))).toBe(true);

    const db = new Database(join(i.out, 'home-off', 'db.sqlite'), { readonly: true });
    try {
      const searches = db
        .prepare("SELECT COUNT(*) AS n FROM history_searches WHERE outcome = 'ok' AND result_count > 0")
        .get() as { n: number };
      expect(searches.n).toBeGreaterThan(0);
    } finally {
      db.close();
    }
    const text = JSON.stringify(report);
    for (const source of fixture().sources) expect(text).not.toContain(String(source.body));
  }, 180_000);
});

describe('seeding the disposable database', () => {
  it('writes sources the real indexer takes in, one document per source, with the real ids', async () => {
    const { seedSources } = await load();
    const h = await historyHarness();
    try {
      const db = h.repos.db;
      const stageId = (
        (await h.domain.tasks.create('AR', { title: 'First', description: '' }, OWNER_ACTOR)) as {
          stageId: string;
        }
      ).stageId;
      const owner: HistoryViewer = { handle: 'owner', access: 'owner' };
      const { placed } = seedSources(db, {
        projectKey: 'AR',
        stageId,
        sources: fixture().sources,
        firstSeq: 2,
      });
      h.domain.history.flush();
      const rows = db
        .prepare(
          "SELECT source_type AS type, source_id AS id FROM history_documents WHERE source_id LIKE 'hsrc_%'",
        )
        .all() as { type: string; id: string }[];
      for (const [fixtureId, source] of placed as Map<string, { type: string; entityId: string }>) {
        const id = historySourceId('AR', source.type as never, source.entityId);
        expect(
          rows.some((row) => row.id === id),
          `${fixtureId} is indexed`,
        ).toBe(true);
      }
      expect(new Set(rows.map((row) => row.type))).toEqual(
        new Set(['task', 'note', 'question', 'message', 'document']),
      );
      const document = (placed as Map<string, { entityId: string }>).get('decisions')!;
      expect(document.entityId).toBe(historyDocumentEntityId('profile', 'docs/DECISIONS.md'));
      const found = await h.domain.history.search('AR', owner, { query: 'decision' });
      expect(found.matches.length).toBeGreaterThan(0);
      const pending = db.prepare('SELECT COUNT(*) AS n FROM history_semantic_dirty').get() as { n: number };
      expect(pending.n).toBeGreaterThanOrEqual(placed.size);
    } finally {
      await h.cleanup();
    }
  });
});

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

describe('the synthetic fixture of the release run (PM-913)', () => {
  const generatorPath = join(root, 'deploy/cloud/history-semantic-fixture.mjs');
  const docsDir = join(root, 'docs');
  const loadGenerator = (): Promise<any> => import(pathToFileURL(generatorPath).href);

  it('is a valid fixture of the live size, with the 20 decisions as targets', async () => {
    const generator = await loadGenerator();
    const built = generator.buildFixture({ docsDir });
    const { validateFixture } = await load();
    expect(validateFixture(built)).toBe(built);
    const count = (type: string) => built.sources.filter((s: { type: string }) => s.type === type).length;
    expect(built.sources).toHaveLength(17_955);
    expect([count('task'), count('message'), count('note'), count('question'), count('document')]).toEqual([
      1000, 9200, 7000, 753, 2,
    ]);
    const characters = built.sources.reduce(
      (sum: number, s: { title: string; body: string }) => sum + s.title.length + s.body.length,
      0,
    );
    expect(characters / built.sources.length).toBeGreaterThan(900);
    expect(characters / built.sources.length).toBeLessThan(1100);
    expect(built.questions).toHaveLength(20);
    const ids = new Set(built.sources.map((s: { id: string }) => s.id));
    for (const item of built.questions) expect(ids.has(item.targetId)).toBe(true);
  });

  it('gives the same file for the same seed and another for another seed', async () => {
    const generator = await loadGenerator();
    const counts = { tasks: 5, messages: 5, notes: 25, questions: 5 };
    const build = (seed: number) => JSON.stringify(generator.buildFixture({ docsDir, seed, counts }));
    expect(build(1)).toBe(build(1));
    expect(build(1)).not.toBe(build(2));
  });

  it('checks the image: ELF machine of a native file and the model manifest', async () => {
    const check = await import(
      pathToFileURL(join(root, 'deploy/cloud/history-semantic-image-check.mjs')).href
    );
    const elf = (machine: number) => {
      const head = Buffer.alloc(64);
      head.set([0x7f, 0x45, 0x4c, 0x46, 2, 1], 0);
      head.writeUInt16LE(machine, 18);
      return head;
    };
    expect(check.elfMachineOf(elf(183))).toBe(183);
    expect(check.elfMachineOf(Buffer.from('not an elf at all, just text'))).toBeNull();
    const arm = join(temp, 'arm.node');
    const intel = join(temp, 'intel.node');
    writeFileSync(arm, elf(183));
    writeFileSync(intel, elf(62));
    expect(check.checkElf([arm], 'arm64').problems).toEqual([]);
    expect(check.checkElf([arm, intel], 'arm64').problems).toHaveLength(1);

    expect(check.checkModel(temp).problems).toEqual(['model_manifest_missing']);
    const model = join(temp, 'model');
    mkdirSync(join(model, 'org', 'name'), { recursive: true });
    writeFileSync(join(model, 'org', 'name', 'weights.bin'), 'weights');
    const manifest = {
      modelId: 'org/name',
      revision: 'a'.repeat(40),
      files: [{ path: 'weights.bin', sha256: sha256('weights'), bytes: 7 }],
    };
    writeFileSync(join(model, 'manifest.json'), JSON.stringify(manifest));
    expect(check.checkModel(model)).toMatchObject({ problems: [], files: 1 });
    manifest.files[0]!.sha256 = sha256('other');
    writeFileSync(join(model, 'manifest.json'), JSON.stringify(manifest));
    expect(check.checkModel(model).problems).toEqual(['model_file_hash:weights.bin']);
  });

  it('finds the better-sqlite3 native file in both layouts, only this CPU in the prebuilds', async () => {
    const check = await import(
      pathToFileURL(join(root, 'deploy/cloud/history-semantic-image-check.mjs')).href
    );
    const prebuilt = join(temp, 'sqlite-prebuilt');
    mkdirSync(join(prebuilt, 'prebuilds'), { recursive: true });
    for (const name of ['linux-arm64', 'linux-x64', 'linuxmusl-arm64', 'darwin-arm64'])
      writeFileSync(join(prebuilt, 'prebuilds', `${name}.node`), 'x');
    expect(check.betterSqliteFiles(prebuilt, 'arm64')).toEqual([
      join(prebuilt, 'prebuilds', 'linux-arm64.node'),
    ]);
    expect(check.betterSqliteFiles(prebuilt, 'x64')).toEqual([join(prebuilt, 'prebuilds', 'linux-x64.node')]);

    const compiled = join(temp, 'sqlite-compiled');
    mkdirSync(join(compiled, 'build', 'Release', 'obj.target'), { recursive: true });
    writeFileSync(join(compiled, 'build', 'Release', 'better_sqlite3.node'), 'x');
    expect(check.betterSqliteFiles(compiled, 'arm64')).toEqual([
      join(compiled, 'build', 'Release', 'better_sqlite3.node'),
    ]);

    expect(check.betterSqliteFiles(join(temp, 'sqlite-none'), 'arm64')).toEqual([]);
  });

  it('refuses a missing option on the command line', async () => {
    const generator = await loadGenerator();
    expect(() => generator.parseArgs(['--docs', docsDir])).toThrow(/required/);
    expect(generator.parseArgs(['--docs', docsDir, '--out', join(temp, 'f.json')])).toMatchObject({
      seed: 913,
      scale: 1,
    });
    expect(() => generator.parseArgs(['--docs', docsDir, '--out', 'f.json', '--scale', '0'])).toThrow(
      /scale/,
    );
    expect(generator.scaleCounts({ tasks: 1000, messages: 9200 }, 2)).toEqual({
      tasks: 2000,
      messages: 18400,
    });
  });
});
