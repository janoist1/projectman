#!/usr/bin/env node
// Memory profile of the projectman server on a disposable copy of a home (PM-773, PM-772 part A).
// Guide: docs/HYBRID.md "Memory profile". No dependencies; it starts the server as a child process
// on the loopback with a cleared environment, takes heap snapshots at fixed points, optionally
// loads it with the web app's read requests and writes the findings under --out.
//
//   node memory-profile.mjs --home <dir> --out <dir> [--server <path>] [--port 4790]
//     [--duration-min 60] [--heap-limit-mb <n>] [--env NAME=value]... [--login-file <path>]
//     [--rounds 20] [--concurrency 4]
//
// Besides these, for short runs: --start-delay-s (60), --idle-every-min (10), --ready-timeout-s (120)
// and --probe-ms (5000, the interval of memory-probe.mjs).
//
// Exit codes: 0 done; 64 refused (a bad parameter, no `<home>/.memory-profile-copy` marker or a
// used --out: nothing was started); 1 the run failed.

import { spawn, execFile } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROBE_PATH = join(HERE, 'memory-probe.mjs');
export const SUMMARY_PATH = join(HERE, 'heap-summary.mjs');
export const MARKER = '.memory-profile-copy';
export const DEFAULT_SERVER = '/app/apps/server/dist/index.js';
export const EXIT_REFUSED = 64;
const MB = 1024 * 1024;
const SESSION_COOKIE = 'pm_session';

/**
 * The paths the load phase requests, as templates. `:key` is a project key and `:taskKey` a card key;
 * the report names only these templates. A test keeps them equal to `routes` in packages/shared.
 */
export const LOAD_ROUTES = {
  setupStatus: '/api/setup',
  login: '/api/auth/login',
  me: '/api/me',
  projects: '/api/projects',
  board: '/api/projects/:key/board',
  tasks: '/api/projects/:key/tasks',
  inbox: '/api/projects/:key/inbox',
  teamThreads: '/api/projects/:key/messages/threads',
  involvements: '/api/projects/:key/involvements',
  task: '/api/projects/:key/tasks/:taskKey',
};

/** The variables the profile sets itself; `--env` may not replace them. */
const RESERVED_ENV = new Set([
  'PATH',
  'HOME',
  'TMPDIR',
  'PROJECTMAN_HOME',
  'PROJECTMAN_MODE',
  'HOST',
  'PORT',
  'NODE_ENV',
  'PM_MEMORY_PROBE_FILE',
  'PM_MEMORY_PROBE_MS',
]);

export class UsageError extends Error {}

export const USAGE = `usage: node memory-profile.mjs --home <dir> --out <dir> [--server <path>] [--port 4790]
  [--duration-min 60] [--heap-limit-mb <n>] [--env NAME=value]... [--login-file <path>]
  [--rounds 20] [--concurrency 4]
  [--start-delay-s 60] [--idle-every-min 10] [--ready-timeout-s 120] [--probe-ms 5000]`;

const VALUE_OPTIONS = new Set([
  'home',
  'out',
  'server',
  'port',
  'duration-min',
  'heap-limit-mb',
  'env',
  'login-file',
  'rounds',
  'concurrency',
  'start-delay-s',
  'idle-every-min',
  'ready-timeout-s',
  'probe-ms',
]);

function numberOption(name, raw, { min, max, integer }) {
  const value = Number(raw);
  if (
    raw.trim() === '' ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  ) {
    throw new UsageError(`--${name} must be ${integer ? 'an integer' : 'a number'} from ${min} to ${max}`);
  }
  return value;
}

/** Parses the command line into options; throws `UsageError` with the reason. */
export function parseArgs(argv) {
  const raw = new Map();
  const envPairs = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new UsageError(`unexpected argument: ${token}`);
    const eq = token.indexOf('=');
    const name = eq < 0 ? token.slice(2) : token.slice(2, eq);
    if (name === 'help') return { help: true };
    if (!VALUE_OPTIONS.has(name)) throw new UsageError(`unknown option: --${name}`);
    let value;
    if (eq >= 0) {
      value = token.slice(eq + 1);
    } else {
      value = argv[i + 1];
      if (value === undefined) throw new UsageError(`--${name} needs a value`);
      i += 1;
    }
    if (name === 'env') envPairs.push(value);
    else if (raw.has(name)) throw new UsageError(`--${name} given twice`);
    else raw.set(name, value);
  }
  for (const required of ['home', 'out']) {
    if (!raw.get(required)) throw new UsageError(`--${required} is required`);
  }
  const env = [];
  const seen = new Set();
  for (const pair of envPairs) {
    const eq = pair.indexOf('=');
    const name = eq < 0 ? pair : pair.slice(0, eq);
    if (eq < 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new UsageError('--env needs NAME=value');
    if (RESERVED_ENV.has(name)) throw new UsageError(`--env ${name} is set by the profile itself`);
    if (seen.has(name)) throw new UsageError(`--env ${name} given twice`);
    seen.add(name);
    env.push([name, pair.slice(eq + 1)]);
  }
  const get = (name, fallback) => (raw.has(name) ? raw.get(name) : fallback);
  const loginFile = raw.get('login-file');
  return {
    help: false,
    home: resolve(raw.get('home')),
    out: resolve(raw.get('out')),
    server: resolve(get('server', DEFAULT_SERVER)),
    port: numberOption('port', get('port', '4790'), { min: 1, max: 65535, integer: true }),
    durationMin: numberOption('duration-min', get('duration-min', '60'), {
      min: 0.01,
      max: 24 * 60,
      integer: false,
    }),
    heapLimitMb: raw.has('heap-limit-mb')
      ? numberOption('heap-limit-mb', raw.get('heap-limit-mb'), { min: 16, max: 1_000_000, integer: true })
      : null,
    env,
    loginFile: loginFile ? resolve(loginFile) : null,
    rounds: numberOption('rounds', get('rounds', '20'), { min: 1, max: 100_000, integer: true }),
    concurrency: numberOption('concurrency', get('concurrency', '4'), { min: 1, max: 64, integer: true }),
    startDelayS: numberOption('start-delay-s', get('start-delay-s', '60'), {
      min: 0,
      max: 3600,
      integer: false,
    }),
    idleEveryMin: numberOption('idle-every-min', get('idle-every-min', '10'), {
      min: 0.01,
      max: 24 * 60,
      integer: false,
    }),
    readyTimeoutS: numberOption('ready-timeout-s', get('ready-timeout-s', '120'), {
      min: 1,
      max: 3600,
      integer: false,
    }),
    probeMs: numberOption('probe-ms', get('probe-ms', '5000'), { min: 10, max: 3_600_000, integer: true }),
  };
}

/**
 * Refuses (throws `UsageError`) unless the run may start: the home is a disposable copy, the server
 * file exists, the login file is well formed and --out is missing or an empty folder. Creates --out
 * (owner-only: it will hold heap snapshots of real data). Returns the login, or null.
 */
export function prepareRun(options) {
  if (!isDirectory(options.home)) throw new UsageError(`--home is not a folder: ${options.home}`);
  if (!existsSync(join(options.home, MARKER))) {
    throw new UsageError(
      `${options.home} has no ${MARKER} marker: the profile runs only on a disposable copy of a home ` +
        `(create the marker in the copy, never in a live home)`,
    );
  }
  if (!existsSync(options.server)) throw new UsageError(`--server not found: ${options.server}`);
  let login = null;
  if (options.loginFile) {
    try {
      login = JSON.parse(readFileSync(options.loginFile, 'utf8'));
    } catch {
      throw new UsageError('--login-file cannot be read as JSON');
    }
    if (
      !login ||
      typeof login.email !== 'string' ||
      typeof login.password !== 'string' ||
      !login.email ||
      !login.password
    ) {
      throw new UsageError('--login-file must be JSON { "email": string, "password": string }');
    }
  }
  if (existsSync(options.out)) {
    if (!isDirectory(options.out)) throw new UsageError(`--out exists and is not a folder: ${options.out}`);
    if (readdirSync(options.out).length > 0) throw new UsageError(`--out is not empty: ${options.out}`);
  } else {
    mkdirSync(options.out, { recursive: true, mode: 0o700 });
  }
  return login === null ? null : { email: login.email, password: login.password };
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The server's environment: only what it needs and what the profile sets, nothing inherited. */
export function buildServerEnv(options, parentEnv = process.env) {
  const env = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR']) {
    if (parentEnv[name] !== undefined) env[name] = parentEnv[name];
  }
  Object.assign(env, {
    PROJECTMAN_HOME: options.home,
    PROJECTMAN_MODE: 'cloud',
    HOST: '127.0.0.1',
    PORT: String(options.port),
    NODE_ENV: 'production',
    PM_MEMORY_PROBE_FILE: join(options.out, 'probe.jsonl'),
    PM_MEMORY_PROBE_MS: String(options.probeMs),
  });
  for (const [name, value] of options.env) env[name] = value;
  return env;
}

/** The node flags that are not paths; they go into the report as they are. */
export function nodeFlags(options) {
  return [
    '--heapsnapshot-signal=SIGUSR2',
    ...(options.heapLimitMb === null ? [] : [`--max-old-space-size=${options.heapLimitMb}`]),
  ];
}

/** The whole argument list of the server process; snapshots land in --out (`--diagnostic-dir`). */
export function buildNodeArgs(options) {
  return ['--import', PROBE_PATH, ...nodeFlags(options), `--diagnostic-dir=${options.out}`, options.server];
}

// ---------- measuring ----------

const round1 = (value) => Math.round(value * 10) / 10;
const toMb = (bytes) => round1(bytes / MB);

function execFileText(file, args) {
  return new Promise((resolvePromise, reject) => {
    execFile(file, args, { encoding: 'utf8', timeout: 10_000 }, (error, stdout) =>
      error ? reject(error) : resolvePromise(stdout),
    );
  });
}

/** Resident memory of a process in MB: Linux has VmRSS, VmHWM (peak) and VmSwap; macOS only the RSS. */
export async function sampleProcess(pid, fallbackProbeFile = null) {
  const status = `/proc/${pid}/status`;
  if (existsSync(status)) {
    const text = readFileSync(status, 'utf8');
    const kb = (name) => {
      const match = new RegExp(`^${name}:\\s+(\\d+)\\s*kB`, 'm').exec(text);
      return match ? Number(match[1]) : null;
    };
    const mb = (value) => (value === null ? null : round1(value / 1024));
    return { rssMb: mb(kb('VmRSS')) ?? 0, hwmMb: mb(kb('VmHWM')), swapMb: mb(kb('VmSwap')) };
  }
  try {
    const out = await execFileText('ps', ['-o', 'rss=', '-p', String(pid)]);
    return { rssMb: round1(Number(out.trim()) / 1024), hwmMb: null, swapMb: null };
  } catch (error) {
    // `ps` may be refused (a sandbox): the process's own figure, from the last probe line, is the same RSS.
    const line = fallbackProbeFile ? readProbeLines(fallbackProbeFile).at(-1) : undefined;
    if (!line) throw error;
    return { rssMb: toMb(line.rss), hwmMb: null, swapMb: null };
  }
}

/** Linux: forget the peak so the next phase's VmHWM is its own (best effort; needs the same user). */
function resetPeak(pid) {
  try {
    writeFileSync(`/proc/${pid}/clear_refs`, '5');
  } catch {
    // Not Linux, or not allowed: the peak then stays cumulative, which the report says.
  }
}

export function readProbeLines(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const lines = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      lines.push(JSON.parse(line));
    } catch {
      // A line still being written.
    }
  }
  return lines;
}

export function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return 0;
  return sortedValues[Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(p * sortedValues.length) - 1))];
}

/** Per route template: count, p50, p95 and max of the time, the median size and the number of failures. */
export function summarizeEndpoints(records) {
  const byRoute = new Map();
  for (const record of records) {
    const list = byRoute.get(record.route) ?? [];
    list.push(record);
    byRoute.set(record.route, list);
  }
  return [...byRoute.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([route, list]) => {
      const times = list.map((r) => r.ms).sort((a, b) => a - b);
      const sizes = list.map((r) => r.bytes).sort((a, b) => a - b);
      return {
        route,
        count: list.length,
        p50Ms: round1(percentile(times, 0.5)),
        p95Ms: round1(percentile(times, 0.95)),
        maxMs: round1(times[times.length - 1]),
        medianBytes: percentile(sizes, 0.5),
        errors: list.filter((r) => !r.ok).length,
      };
    });
}

// ---------- the load ----------

async function runPool(thunks, concurrency) {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, thunks.length) }, async () => {
    while (next < thunks.length) {
      const thunk = thunks[next];
      next += 1;
      await thunk();
    }
  });
  await Promise.all(workers);
}

/** The cookie lives here only: it is never written, logged or reported. */
async function login(base, credentials, records) {
  const started = performance.now();
  let response;
  let bytes = 0;
  try {
    response = await fetch(`${base}${LOAD_ROUTES.login}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(credentials),
      signal: AbortSignal.timeout(60_000),
    });
    bytes = (await response.arrayBuffer()).byteLength;
  } catch {
    records.push({ route: LOAD_ROUTES.login, ms: performance.now() - started, bytes: 0, ok: false });
    throw new Error('login failed: no answer');
  }
  records.push({ route: LOAD_ROUTES.login, ms: performance.now() - started, bytes, ok: response.ok });
  if (!response.ok) throw new Error(`login failed: status ${response.status}`);
  const cookies = response.headers.getSetCookie
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie') ?? ''];
  const entry = cookies.find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`));
  if (!entry) throw new Error('login failed: no session cookie');
  return entry.split(';')[0];
}

/** One GET; the record keeps the route template, the time, the size and whether it succeeded. */
async function timedGet(base, cookie, route, path, records, parse) {
  const started = performance.now();
  let ok = false;
  let bytes = 0;
  let json = null;
  try {
    const response = await fetch(`${base}${path}`, {
      headers: { cookie },
      signal: AbortSignal.timeout(120_000),
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    bytes = buffer.byteLength;
    ok = response.ok;
    if (ok && parse) {
      try {
        json = JSON.parse(buffer.toString('utf8'));
      } catch {
        ok = false;
      }
    }
  } catch {
    ok = false;
  }
  records.push({ route, ms: performance.now() - started, bytes, ok });
  return json;
}

/** `rounds` rounds of the app's reads; every project, the 10 cards with the longest description in full. */
export async function runLoad({ base, credentials, rounds, concurrency, records, stopped }) {
  const cookie = await login(base, credentials, records);
  let projectCount = 0;
  for (let round = 0; round < rounds && !stopped(); round += 1) {
    let projects = [];
    const detailKeys = new Map();
    const first = [
      () => timedGet(base, cookie, LOAD_ROUTES.me, LOAD_ROUTES.me, records, false),
      async () => {
        const body = await timedGet(base, cookie, LOAD_ROUTES.projects, LOAD_ROUTES.projects, records, true);
        if (Array.isArray(body)) projects = body.map((p) => p?.key).filter((key) => typeof key === 'string');
      },
    ];
    await runPool(first, concurrency);
    projectCount = projects.length;
    const reads = [];
    for (const key of projects) {
      const fill = (template) => template.replace(':key', key);
      for (const name of ['board', 'inbox', 'teamThreads', 'involvements']) {
        reads.push(() => timedGet(base, cookie, LOAD_ROUTES[name], fill(LOAD_ROUTES[name]), records, false));
      }
      reads.push(async () => {
        const tasks = await timedGet(base, cookie, LOAD_ROUTES.tasks, fill(LOAD_ROUTES.tasks), records, true);
        if (Array.isArray(tasks)) {
          const longest = tasks
            .filter((t) => typeof t?.key === 'string')
            .sort((a, b) => String(b.description ?? '').length - String(a.description ?? '').length)
            .slice(0, 10)
            .map((t) => t.key);
          detailKeys.set(key, longest);
        }
      });
    }
    await runPool(reads, concurrency);
    const details = [];
    for (const [key, taskKeys] of detailKeys) {
      for (const taskKey of taskKeys) {
        details.push(() =>
          timedGet(
            base,
            cookie,
            LOAD_ROUTES.task,
            LOAD_ROUTES.task.replace(':key', key).replace(':taskKey', taskKey),
            records,
            false,
          ),
        );
      }
    }
    await runPool(details, concurrency);
  }
  return { projectCount };
}

// ---------- the report ----------

export function buildReport({
  options,
  phases,
  endpoints,
  startupMs,
  heapSizeLimitMb,
  sourceVersion,
  serverEnv,
}) {
  return {
    sourceVersion: sourceVersion ?? null,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    heapSizeLimitMb,
    nodeArgs: nodeFlags(options),
    env: Object.keys(serverEnv).sort(),
    startupMs,
    phases,
    endpoints,
  };
}

const cell = (value) => (value === null || value === undefined ? '-' : String(value));
const table = (head, rows) =>
  [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ].join('\n');

/** The card-safe text: numbers, route templates, types and constructor names; no snapshot content. */
export function renderMarkdown(report, extras) {
  const lines = [
    '# Memory profile',
    '',
    `- source version: ${report.sourceVersion ?? 'unknown'}`,
    `- node ${report.node} on ${report.platform}/${report.arch}; heap size limit ${report.heapSizeLimitMb} MB`,
    `- node flags: ${report.nodeArgs.join(' ') || '(none)'}`,
    `- environment names: ${report.env.join(', ')}`,
    `- startup to ready: ${report.startupMs} ms`,
    `- run: ${extras.durationMin} min, ${extras.loginUsed ? `load ${extras.rounds} rounds x concurrency ${extras.concurrency}, ${extras.projectCount} project(s), ${extras.loadSeconds} s` : 'no load (no --login-file)'}`,
    `- server exit: ${extras.serverExit}`,
    ...(extras.error ? [`- **INCOMPLETE:** ${extras.error}`] : []),
    '',
    '## Phases',
    '',
    table(
      ['phase', 'at', 'rss MB', 'hwm MB', 'swap MB', 'heapUsed MB', 'live heap MB', 'garbage MB', 'cpu ms'],
      report.phases.map((p) => [
        p.name,
        p.at,
        p.rssMb,
        p.hwmMb,
        p.swapMb,
        p.heapUsedMb,
        p.liveHeapMb,
        p.liveHeapMb === null ? null : round1(p.rssMb - p.liveHeapMb),
        p.cpuMs,
      ]),
    ),
    '',
    'rss, hwm and swap are read just before each snapshot; hwm is reset after a snapshot on Linux, so it is the peak ' +
      'of the phase (it stays cumulative where the reset is not allowed). heapUsed and cpu come from the probe line ' +
      'taken right after. `load` is the sample with the highest rss during the load. garbage = rss - live heap. ' +
      'Caution: a snapshot allocates a lot and the process may keep that memory, so the rss of the phases after the ' +
      'first snapshot can include it; `ready` and `start` are clean readings.',
    `Peak during the load (probe lines): heapUsed ${cell(extras.loadPeakHeapUsedMb)} MB, heapTotal ${cell(extras.loadPeakHeapTotalMb)} MB, rss ${cell(extras.loadPeakRssMb)} MB.`,
    '',
    '## Endpoints',
    '',
    report.endpoints.length === 0
      ? 'No load ran.'
      : table(
          ['route', 'count', 'p50 ms', 'p95 ms', 'max ms', 'median bytes', 'errors'],
          report.endpoints.map((e) => [e.route, e.count, e.p50Ms, e.p95Ms, e.maxMs, e.medianBytes, e.errors]),
        ),
  ];
  for (const summary of extras.summaries) {
    lines.push(
      '',
      `## Live heap at ${summary.phase}: ${toMb(summary.liveBytes)} MB, ${summary.nodeCount} nodes`,
      '',
    );
    lines.push(
      table(
        ['type', 'name', 'count', 'self MB'],
        summary.byType
          .slice(0, 15)
          .map((row) => [
            row.type,
            `\`${row.name.replaceAll('`', "'")}\``,
            row.count,
            round1(row.selfBytes / MB),
          ]),
      ),
    );
  }
  return `${lines.join('\n')}\n`;
}

// ---------- the run ----------

function snapshotFiles(out) {
  return readdirSync(out).filter((name) => name.endsWith('.heapsnapshot'));
}

/** V8 closes the snapshot with `}`; the tail tells a finished file from one still being written. */
function endsWithBrace(path) {
  const size = statSync(path).size;
  const length = Math.min(size, 64);
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf8').trimEnd().endsWith('}');
  } finally {
    closeSync(fd);
  }
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function run(options, credentials, log = (line) => process.stderr.write(`${line}\n`)) {
  const out = options.out;
  const serverEnv = buildServerEnv(options);
  const probeFile = serverEnv.PM_MEMORY_PROBE_FILE;
  const logFd = openSync(join(out, 'server.log'), 'a', 0o600);
  const phases = [];
  const records = [];
  const summaries = [];
  const extras = {
    durationMin: options.durationMin,
    loginUsed: credentials !== null,
    rounds: options.rounds,
    concurrency: options.concurrency,
    projectCount: 0,
    loadSeconds: 0,
    loadPeakHeapUsedMb: null,
    loadPeakHeapTotalMb: null,
    loadPeakRssMb: null,
    serverExit: 'not started',
    error: null,
    summaries,
  };
  let startupMs = 0;
  const child = spawn(process.execPath, buildNodeArgs(options), {
    env: serverEnv,
    stdio: ['ignore', logFd, logFd],
  });
  closeSync(logFd);
  const spawnedAt = Date.now();
  let exited = false;
  const exitPromise = new Promise((resolvePromise) => {
    child.once('exit', (code, signal) => {
      exited = true;
      extras.serverExit = signal ? `signal ${signal}` : `code ${code}`;
      resolvePromise();
    });
    child.once('error', (error) => {
      exited = true;
      extras.serverExit = `could not start: ${error.code ?? 'error'}`;
      resolvePromise();
    });
  });
  const pid = child.pid;
  const base = `http://127.0.0.1:${options.port}`;
  const guard = () => {
    if (exited) throw new Error(`the server exited early (${extras.serverExit}); see server.log`);
  };
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const check = () => {
    guard();
    if (interrupted) throw new Error('interrupted');
  };
  const pause = async (ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      check();
      await sleep(Math.min(500, Math.max(1, end - Date.now())));
    }
    check();
  };

  /** A sample with a fresh probe line: waits for the probe to write after the call. */
  const record = async (name) => {
    const after = Date.now();
    const rss = await sampleProcess(pid, probeFile);
    const deadline = Date.now() + options.probeMs * 2 + 2000;
    let line = null;
    while (Date.now() < deadline) {
      check();
      const lines = readProbeLines(probeFile);
      const last = lines[lines.length - 1];
      if (last && Date.parse(last.t) >= after) {
        line = last;
        break;
      }
      await sleep(Math.min(250, options.probeMs));
    }
    if (!line) line = readProbeLines(probeFile).at(-1) ?? null;
    const phase = {
      name,
      at: new Date().toISOString(),
      rssMb: rss.rssMb,
      hwmMb: rss.hwmMb,
      swapMb: rss.swapMb,
      heapUsedMb: line ? toMb(line.heapUsed) : 0,
      liveHeapMb: null,
      cpuMs: line ? Math.round(line.cpuUserMs + line.cpuSystemMs) : 0,
    };
    phases.push(phase);
    log(`phase ${name}: rss ${phase.rssMb} MB`);
    return phase;
  };

  const snapshot = async (phase) => {
    const before = new Set(snapshotFiles(out));
    child.kill('SIGUSR2');
    const deadline = Date.now() + 15 * 60_000;
    let candidate = null;
    let lastSize = -1;
    while (Date.now() < deadline) {
      check();
      await sleep(500);
      candidate ??= snapshotFiles(out).find((name) => !before.has(name)) ?? null;
      if (!candidate) continue;
      const size = statSync(join(out, candidate)).size;
      if (size > 0 && size === lastSize && endsWithBrace(join(out, candidate))) break;
      lastSize = size;
    }
    if (!candidate) throw new Error(`no heap snapshot appeared for ${phase.name}`);
    const target = join(out, `${phase.name}.heapsnapshot`);
    renameSync(join(out, candidate), target);
    resetPeak(pid);
    try {
      const text = await execFileText(process.execPath, [SUMMARY_PATH, target]);
      const summary = JSON.parse(text);
      phase.liveHeapMb = toMb(summary.liveBytes);
      summaries.push({ phase: phase.name, ...summary });
      writeFileSync(join(out, `${phase.name}.summary.json`), `${JSON.stringify(summary, null, 2)}\n`, {
        mode: 0o600,
      });
    } catch (error) {
      log(`heap summary failed for ${phase.name}: ${formatError(error)}`);
    }
  };

  let incomplete = null;
  try {
    // ready
    const readyDeadline = spawnedAt + options.readyTimeoutS * 1000;
    for (;;) {
      check();
      if (Date.now() > readyDeadline)
        throw new Error(`the server was not ready in ${options.readyTimeoutS} s`);
      try {
        const response = await fetch(`${base}${LOAD_ROUTES.setupStatus}`, {
          signal: AbortSignal.timeout(2000),
        });
        await response.arrayBuffer();
        if (response.status === 200) break;
      } catch {
        // Not listening yet.
      }
      await sleep(250);
    }
    const readyAt = Date.now();
    startupMs = readyAt - spawnedAt;
    await record('ready');

    // start
    await pause(options.startDelayS * 1000);
    await snapshot(await record('start'));

    // load
    if (credentials) {
      const loadStarted = Date.now();
      let peak = null;
      let loading = true;
      const sampler = (async () => {
        while (loading && !exited) {
          try {
            const sample = await sampleProcess(pid, probeFile);
            if (!peak || sample.rssMb > peak.rssMb) peak = { ...sample, at: new Date().toISOString() };
          } catch {
            // The process went away; the guard reports it.
          }
          await sleep(1000);
        }
      })();
      try {
        const loaded = await runLoad({
          base,
          credentials,
          rounds: options.rounds,
          concurrency: options.concurrency,
          records,
          stopped: () => exited || interrupted,
        });
        extras.projectCount = loaded.projectCount;
      } finally {
        loading = false;
        await sampler;
      }
      check();
      extras.loadSeconds = round1((Date.now() - loadStarted) / 1000);
      const lines = readProbeLines(probeFile).filter((line) => Date.parse(line.t) >= loadStarted);
      if (lines.length > 0) {
        extras.loadPeakHeapUsedMb = toMb(Math.max(...lines.map((l) => l.heapUsed)));
        extras.loadPeakHeapTotalMb = toMb(Math.max(...lines.map((l) => l.heapTotal)));
        extras.loadPeakRssMb = toMb(Math.max(...lines.map((l) => l.rss)));
      }
      if (peak) {
        const line = readProbeLines(probeFile).at(-1);
        phases.push({
          name: 'load',
          at: peak.at,
          rssMb: peak.rssMb,
          hwmMb: peak.hwmMb,
          swapMb: peak.swapMb,
          heapUsedMb: line ? toMb(line.heapUsed) : 0,
          liveHeapMb: null,
          cpuMs: line ? Math.round(line.cpuUserMs + line.cpuSystemMs) : 0,
        });
      }
      await snapshot(await record('load-end'));
    }

    // idle
    const deadline = readyAt + options.durationMin * 60_000;
    const everyMs = options.idleEveryMin * 60_000;
    for (let k = 1; readyAt + k * everyMs < deadline - 1000; k += 1) {
      const at = readyAt + k * everyMs;
      if (at <= Date.now()) continue; // the load took longer than this slot
      await pause(at - Date.now());
      await record(`idle-${Number((k * options.idleEveryMin).toFixed(2))}`);
    }
    if (deadline > Date.now()) await pause(deadline - Date.now());

    // end
    await snapshot(await record('end'));
  } catch (error) {
    incomplete = formatError(error);
    extras.error = incomplete;
    log(`the run stopped: ${incomplete}`);
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    if (!exited) {
      child.kill('SIGTERM');
      const killer = setTimeout(() => child.kill('SIGKILL'), 60_000);
      await exitPromise;
      clearTimeout(killer);
    }
  }

  const lines = readProbeLines(probeFile);
  const heapSizeLimit = lines.at(-1)?.heapSizeLimit;
  const report = buildReport({
    options,
    phases,
    endpoints: summarizeEndpoints(records),
    startupMs,
    heapSizeLimitMb: heapSizeLimit ? Math.round(heapSizeLimit / MB) : (options.heapLimitMb ?? 0),
    sourceVersion: process.env.PROJECTMAN_VERSION || null,
    serverEnv,
  });
  writeFileSync(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(join(out, 'report.md'), renderMarkdown(report, extras), { mode: 0o600 });
  return { report, incomplete };
}

export async function main(argv) {
  let options;
  let credentials;
  try {
    options = parseArgs(argv);
    if (options.help) {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    credentials = prepareRun(options);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`memory-profile: ${error.message}\n${USAGE}\n`);
      return EXIT_REFUSED;
    }
    throw error;
  }
  const { incomplete } = await run(options, credentials);
  return incomplete ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
