#!/usr/bin/env node
// Read-only load probe of a Mac (PM-798): what loads the machine, and does it coincide with the engine link
// dropping. It stops, deletes and changes nothing: it only reads `ps`, `sysctl`, `vm_stat`, Node's `os`, the
// heavy-run queue folder and (inventory) folder sizes. Run it on the machine itself, outside the AI sandbox.
//
//   node scripts/load-probe/load-probe.mjs sample --out <samples.jsonl> [--interval 30] [--duration 7200] [--label <text>]
//   node scripts/load-probe/load-probe.mjs inventory --out <inventory.json> [--roots <dir>,<dir>...] [--no-count]
//   node scripts/load-probe/load-probe.mjs links --out <links.jsonl> --side <engine|cloud> <log file>...
//   node scripts/load-probe/load-probe.mjs summarize --samples <samples.jsonl> [--links <links.jsonl>[,<...>]] [--out <summary.json>]
//
// What leaves the machine (the files are meant to be attached to a card): per process only the executable's file
// name, the script's last two path segments, a category, PID/PPID, CPU, RSS and age. No argument, environment
// variable, token or user name is written; the only environment values read are VITEST_MAX_FORKS and
// VITEST_MAX_THREADS of vitest runs (numbers up to 3 digits). The log filter keeps the link lines' numeric and
// enum fields only.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PROBE_VERSION = 1;

// ---------------------------------------------------------------------------------------------------------------
// Parsing

/** `[dd-][hh:]mm:ss[.cc]` (ps etime / time) in seconds, or null. */
export function parseClock(text) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text.trim());
  if (!match) return null;
  const [, d, h, m, s] = match;
  return Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s);
}

/** One line of `ps -axww -o pid=,ppid=,time=,rss=,etime=,args=`. */
export function parsePsLine(line) {
  const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
  if (!match) return null;
  const cpuSeconds = parseClock(match[3]);
  if (cpuSeconds === null) return null;
  return {
    pid: Number(match[1]),
    ppid: Number(match[2]),
    cpuSeconds,
    rssKb: Number(match[4]),
    etimeSeconds: parseClock(match[5]) ?? 0,
    args: match[6],
  };
}

export function parseVmStat(output) {
  const pageSize = Number(/page size of (\d+) bytes/.exec(output)?.[1] ?? 0);
  if (!pageSize) return null;
  const pages = (label) => {
    const match = new RegExp(`^"?${label}"?:\\s+(\\d+)\\.?\\s*$`, 'm').exec(output);
    return match ? Number(match[1]) * pageSize : null;
  };
  const wired = pages('Pages wired down');
  const compressed = pages('Pages occupied by compressor');
  const anonymous = pages('Anonymous pages');
  const purgeable = pages('Pages purgeable') ?? 0;
  const usedBytes =
    wired === null || compressed === null || anonymous === null
      ? null
      : Math.max(0, wired + compressed + anonymous - purgeable);
  return { usedBytes, freeBytes: pages('Pages free'), compressedBytes: compressed, wiredBytes: wired };
}

const SWAP_UNITS = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

export function parseSwapUsage(output) {
  const amount = (label) => {
    const match = new RegExp(`${label}\\s*=\\s*([\\d.]+)\\s*([KMGT])`, 'i').exec(output);
    return match ? Math.round(Number(match[1]) * SWAP_UNITS[match[2].toUpperCase()]) : null;
  };
  const totalBytes = amount('total');
  const usedBytes = amount('used');
  return totalBytes === null || usedBytes === null ? null : { totalBytes, usedBytes };
}

/** `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warn, 4 critical. */
export function parsePressure(output) {
  const level = Number(output.trim());
  return level === 1 || level === 2 || level === 4 ? level : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Sanitising and classification. Raw arguments are read here and never leave this module's return values.

/** A name that is safe to write out: no `=`, no quotes, no home folder, bounded. */
export function safeName(text, max = 48) {
  const home = os.homedir();
  const cleaned = String(text ?? '')
    .split(home)
    .join('~')
    .replace(/[^A-Za-z0-9._@+()/: ~-]/g, '_')
    .trim();
  return cleaned.slice(0, max);
}

const INTERPRETERS = /^(node|nodejs|bun|deno|python[\d.]*|ruby|perl|bash|sh|zsh|fish)$/i;
const VALUE_FLAGS = new Set([
  '--import',
  '--require',
  '-r',
  '--loader',
  '--experimental-loader',
  '--conditions',
  '-C',
  '--env-file',
  '--input-type',
  '--title',
]);
const CODE_FLAGS = new Set(['-e', '--eval', '-p', '--print', '-c']);

/** The executable path of a `ps` args string: app bundles may contain spaces. */
function executableOf(args) {
  if (args.startsWith('/') && /\.app\//.test(args)) {
    const cut = args.search(/ -/);
    return cut === -1 ? args : args.slice(0, cut);
  }
  const cut = args.search(/\s/);
  return cut === -1 ? args : args.slice(0, cut);
}

/** `{ exe, script }`: the executable's file name and, for an interpreter, the script's last two segments. */
export function describeCommand(args) {
  const exePath = executableOf(args);
  const exe = path.basename(exePath);
  const rest = args.slice(exePath.length).trim();
  const tokens = rest === '' ? [] : rest.split(/\s+/);
  let script = '';
  if (/^(npm|npx|pnpm|yarn)$/i.test(exe) || /^(node|nodejs)$/i.test(exe)) {
    const first = tokens.find((t) => !t.startsWith('-'));
    if (/^(node|nodejs)$/i.test(exe) && first && /(^|\/)(npm|npx)(-cli\.js)?$/.test(first)) {
      const at = tokens.indexOf(first);
      script = npmWords(tokens.slice(at + 1));
      return { exe: 'npm', script };
    }
    if (/^(npm|npx|pnpm|yarn)$/i.test(exe)) return { exe: exe.toLowerCase(), script: npmWords(tokens) };
  }
  if (INTERPRETERS.test(exe)) {
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (CODE_FLAGS.has(token)) {
        script = token;
        break;
      }
      if (VALUE_FLAGS.has(token)) {
        i += 1;
        continue;
      }
      if (token.startsWith('-')) continue;
      script = token.split('/').filter(Boolean).slice(-2).join('/');
      break;
    }
  }
  return { exe: safeName(exe), script: safeName(script) };
}

/** `ci`, `install`, `run test`: only whitelisted words of an npm command line. */
function npmWords(tokens) {
  const words = tokens.filter((t) => !t.startsWith('-'));
  const word = (text) => (text && /^[a-z][a-z0-9:_-]{0,30}$/.test(text) ? text : '');
  const sub = word(words[0]);
  if (sub === 'run' || sub === 'exec') return `${sub} ${word(words[1])}`.trim();
  return sub;
}

/**
 * The category of a process by its own command, or null when it takes its parent's. `categories` of PM-798:
 * ai-session, ai-mcp, ai-hook, vitest, typecheck, build, npm-install, projectman, fs-index, desktop, browser,
 * docker, git, editor, probe, other.
 */
export function classifyOwn(args) {
  const a = args.toLowerCase();
  const { exe, script } = describeCommand(args);
  const exeLower = exe.toLowerCase();
  const type = /--type=([\w-]+)/.exec(a)?.[1];
  if (/^(fseventsd|mds|mds_stores|mdworker|mdworker_shared|mdbulkimport|corespotlightd)$/.test(exeLower)) {
    return { cat: 'fs-index', sub: exeLower };
  }
  if (exeLower === 'windowserver') return { cat: 'desktop', sub: 'windowserver' };
  if (
    a.includes('ms-playwright') ||
    a.includes('/.projectman/browsers/') ||
    (a.includes('playwright') && /chrom|headless_shell|firefox|webkit/.test(exeLower))
  ) {
    return { cat: 'browser', sub: 'playwright' };
  }
  if (a.includes('/claude.app/')) return { cat: 'desktop', sub: `claude-desktop-${type ?? 'main'}` };
  if (a.includes('google chrome')) return { cat: 'browser', sub: `chrome-${type ?? 'main'}` };
  if (/\/(safari|firefox|arc|brave browser|microsoft edge)[^/]*\.app\//.test(a)) {
    return { cat: 'browser', sub: 'other-browser' };
  }
  if (
    /com\.docker|docker desktop|\/docker\.app\/|virtualization\.virtualmachine|vpnkit/.test(a) ||
    /^(docker|dockerd|docker-.*|com\.docker\..*)$/.test(exeLower)
  ) {
    return { cat: 'docker', sub: exeLower };
  }
  if (exeLower === 'git' || exeLower.startsWith('git-')) return { cat: 'git', sub: 'git' };
  if (/\(vitest( \d+)?\)/.test(a)) return { cat: 'vitest', sub: 'worker' };
  // `vitest run` is started as `node <repo>/node_modules/.bin/vitest run` (the shebang script), not only as vitest.mjs.
  if (
    exeLower === 'vitest' ||
    /\/vitest\/|\/vitest(\.m?js)?(\s|$)|vitest\.m?js|\/vite-node\/|tinypool/.test(a)
  ) {
    return { cat: 'vitest', sub: /tinypool|\/workers\/|processchild|--child/.test(a) ? 'worker' : 'runner' };
  }
  // An editor's language server lives long and mostly idles: it is no type check run.
  if (
    exeLower === 'tsserver' ||
    /(^|\/)tsserver(\.js)?$/.test(script) ||
    /typescript\/lib\/tsserver/.test(a)
  ) {
    return { cat: 'editor', sub: 'tsserver' };
  }
  if (
    /^(tsc|tsgo|vue-tsc)$/.test(exeLower) ||
    /(^|\/)(tsc|tsgo)(\.js)?$/.test(script) ||
    /\/typescript\/(lib|bin)\/tsc|@typescript\/native-preview/.test(a)
  ) {
    return { cat: 'typecheck', sub: 'tsc' };
  }
  // The long-lived esbuild service of tsx, vite and vitest is no build run: it takes its parent's category.
  if (/esbuild/.test(a) && /--service\b/.test(a)) return null;
  if (
    /^(esbuild|rollup|tsup|webpack)$/.test(exeLower) ||
    /(vite\/bin\/vite\.js|\/\.bin\/vite)\s+build\b/.test(a) ||
    /\/esbuild(\s|$)/.test(a)
  ) {
    return { cat: 'build', sub: 'vite-esbuild' };
  }
  if (exeLower === 'npm' || /^(npx|pnpm|yarn)$/.test(exeLower)) {
    return /^(ci|install|i|add|rebuild)\b/.test(script) ? { cat: 'npm-install', sub: 'npm-install' } : null;
  }
  const provider = aiProvider(a, exeLower);
  if (provider) return { cat: 'ai-session', sub: provider };
  if (/\bmcp\b|mcp-server|modelcontextprotocol|playwright-mcp|-mcp\b/.test(a)) {
    return { cat: 'ai-mcp', sub: safeName(script || exe, 32) };
  }
  if (/hook/.test(script.toLowerCase())) return { cat: 'ai-hook', sub: safeName(script, 32) };
  if (/scripts\/engine\/|apps\/server\/(dist|src)\/index|\/projectman\/(dist|bin)\//.test(a)) {
    return { cat: 'projectman', sub: a.includes('engine') ? 'engine' : 'server' };
  }
  return null;
}

function aiProvider(a, exeLower) {
  if (a.includes('/claude.app/')) return null;
  if (exeLower === 'claude' || /@anthropic-ai\/claude-code|claude-code\/|\/claude\/versions\//.test(a))
    return 'claude';
  if (exeLower === 'codex' || exeLower.startsWith('codex-') || a.includes('@openai/codex')) return 'codex';
  if (exeLower === 'gemini' || a.includes('@google/gemini-cli')) return 'gemini';
  if (exeLower === 'agy' || a.includes('antigravity')) return 'agy';
  if (a.includes('nanogpt')) return 'nanogpt';
  return null;
}

/**
 * Classifies a process list: each process gets its own category or its parent's (an unknown child of an AI
 * session counts to the session), `session` (the nearest AI session root) and `inQueue` (the heavy-run holder is
 * an ancestor). `procs` have `pid`, `ppid`, `args`; `probePids` are the sampler itself and its children.
 */
export function classifyTree(procs, { holderPid = null, probePid = null } = {}) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const result = new Map();
  const resolve = (pid, depth = 0) => {
    const known = result.get(pid);
    if (known) return known;
    const proc = byPid.get(pid);
    if (!proc || depth > 64)
      return { cat: 'other', sub: '', session: null, provider: null, inQueue: false, own: false };
    const own = pid === probePid ? { cat: 'probe', sub: 'load-probe' } : classifyOwn(proc.args);
    const parent = proc.ppid !== pid && byPid.has(proc.ppid) ? resolve(proc.ppid, depth + 1) : null;
    const base = own ?? (parent ? { cat: parent.cat, sub: parent.sub } : { cat: 'other', sub: '' });
    const isSession = own?.cat === 'ai-session';
    const entry = {
      cat: base.cat,
      sub: base.sub,
      session: isSession ? pid : (parent?.session ?? null),
      provider: isSession ? own.sub : (parent?.provider ?? null),
      inQueue: pid === holderPid || (parent?.inQueue ?? false),
      own: own !== null,
    };
    result.set(pid, entry);
    return entry;
  };
  for (const proc of procs) resolve(proc.pid);
  return result;
}

const RUN_CATEGORIES = new Set(['vitest', 'typecheck', 'build']);

/** The heavy runs (vitest, tsc, build) of a classified tree: their root process, workers, load and queue state. */
export function findRuns(procs, classes, cpuOf) {
  const children = new Map();
  for (const p of procs) {
    const list = children.get(p.ppid) ?? [];
    list.push(p.pid);
    children.set(p.ppid, list);
  }
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const runs = [];
  for (const p of procs) {
    const c = classes.get(p.pid);
    if (!RUN_CATEGORIES.has(c.cat)) continue;
    const parentClass = classes.get(p.ppid);
    if (parentClass && parentClass.cat === c.cat) continue;
    const members = [];
    const stack = [p.pid];
    while (stack.length) {
      const pid = stack.pop();
      if (classes.get(pid)?.cat !== c.cat) continue;
      members.push(pid);
      stack.push(...(children.get(pid) ?? []));
    }
    // Only processes that look like workers by themselves; a test's own child process is not a worker.
    const workers =
      c.cat === 'vitest'
        ? members.filter((pid) => classes.get(pid).own && classes.get(pid).sub === 'worker').length
        : null;
    const args = p.args;
    const argWorkers = /--max-?workers[= ](\d{1,3})\b/i.exec(args)?.[1];
    runs.push({
      kind: c.cat,
      pid: p.pid,
      startedAgoS: p.etimeSeconds ?? null,
      processes: members.length,
      workers,
      cpuPct: round(members.reduce((sum, pid) => sum + (cpuOf(pid) ?? 0), 0)),
      rssKb: members.reduce((sum, pid) => sum + (byPid.get(pid)?.rssKb ?? 0), 0),
      inQueue: c.inQueue,
      session: c.session,
      provider: c.provider,
      maxWorkersArg: argWorkers === undefined ? null : Number(argWorkers),
    });
  }
  return runs;
}

/** Only `VITEST_MAX_FORKS` / `VITEST_MAX_THREADS` values out of a `ps eww` line. */
export function pickVitestEnv(line) {
  const out = {};
  for (const name of ['VITEST_MAX_FORKS', 'VITEST_MAX_THREADS']) {
    const match = new RegExp(`(?:^|\\s)${name}=(\\d{1,3})(?=\\s|$)`).exec(line);
    if (match) out[name] = Number(match[1]);
  }
  return out;
}

function round(value, digits = 1) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

// ---------------------------------------------------------------------------------------------------------------
// Sampling

const REAL_EXEC = (file, args, options = {}) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 64 * 1024 * 1024, timeout: 20_000, ...options }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });

const PS_ARGS = ['-axww', '-o', 'pid=,ppid=,time=,rss=,etime=,args='];

/** Reads `<tmp>/projectman-<uid>/heavy` as `readHeavyQueue` does, without changing anything. */
export function readHeavyQueueSync(dir, fsApi = fs, alive = defaultAlive) {
  const entryOf = (file) => {
    try {
      const raw = JSON.parse(fsApi.readFileSync(file, 'utf8'));
      if (!raw || typeof raw.pid !== 'number') return null;
      return {
        pid: raw.pid,
        label: safeName(raw.label, 60),
        sessionId: typeof raw.sessionId === 'string' ? safeName(raw.sessionId, 40) : null,
        queuedAt: typeof raw.queuedAt === 'string' ? raw.queuedAt : null,
        since: typeof raw.since === 'string' ? raw.since : null,
      };
    } catch {
      return null;
    }
  };
  const holder = entryOf(path.join(dir, 'holder', 'owner.json'));
  let waiting = [];
  try {
    waiting = fsApi
      .readdirSync(path.join(dir, 'queue'))
      .filter((n) => n.endsWith('.json'))
      .sort()
      .map((n) => entryOf(path.join(dir, 'queue', n)))
      .filter((e) => e && alive(e.pid));
  } catch {
    /* no queue folder: nobody waits */
  }
  return { holder: holder && alive(holder.pid) ? holder : null, waiting };
}

function defaultAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export function defaultQueueDir() {
  let tmp = '/tmp';
  try {
    tmp = fs.realpathSync('/tmp');
  } catch {
    /* keep /tmp */
  }
  return path.join(tmp, `projectman-${process.getuid?.() ?? 'user'}`, 'heavy');
}

/**
 * One sample. `state.prevCpu` (pid → cpu seconds, with `lastMs`) is kept between calls: the per-process CPU is the
 * CPU-time difference over the interval (100 = one core), because `ps`'s own %CPU is a lifetime average on macOS.
 * Processes that start and end between two samples are not seen; their CPU shows up as the gap to the machine total.
 */
export async function collectSample(state, deps = {}) {
  const exec = deps.exec ?? REAL_EXEC;
  const now = deps.now ?? Date.now;
  const cpus = (deps.cpus ?? os.cpus)();
  const errors = [];
  const attempt = async (name, fn) => {
    try {
      return await fn();
    } catch (error) {
      errors.push(`${name}: ${safeName(error?.code ?? error?.message ?? 'failed', 40)}`);
      return null;
    }
  };
  const tMs = now();
  const [psOut, vmOut, swapOut, pressureOut] = await Promise.all([
    attempt('ps', () => exec('ps', PS_ARGS)),
    attempt('vm_stat', () => exec('vm_stat', [])),
    attempt('swap', () => exec('sysctl', ['-n', 'vm.swapusage'])),
    attempt('pressure', () => exec('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'])),
  ]);

  const times = cpus.reduce(
    (sum, c) => ({
      user: sum.user + c.times.user + c.times.nice,
      sys: sum.sys + c.times.sys,
      idle: sum.idle + c.times.idle,
    }),
    { user: 0, sys: 0, idle: 0 },
  );
  let cpu = null;
  if (state.prevTimes) {
    const du = times.user - state.prevTimes.user;
    const ds = times.sys - state.prevTimes.sys;
    const di = times.idle - state.prevTimes.idle;
    const total = du + ds + di;
    if (total > 0)
      cpu = {
        user: round((du / total) * 100),
        sys: round((ds / total) * 100),
        idle: round((di / total) * 100),
      };
  }
  state.prevTimes = times;

  const queue = (deps.readQueue ?? (() => readHeavyQueueSync(state.queueDir ?? defaultQueueDir())))();
  const parsed = (psOut ?? '').split('\n').map(parsePsLine).filter(Boolean);
  const procs = parsed.filter((p) => !/^ps -axww /.test(p.args));
  const classes = classifyTree(procs, { holderPid: queue.holder?.pid ?? null, probePid: process.pid });

  const elapsedS = state.lastMs ? (tMs - state.lastMs) / 1000 : null;
  const cpuByPid = new Map();
  const nextCpu = new Map();
  for (const p of procs) {
    nextCpu.set(p.pid, { seconds: p.cpuSeconds, etime: p.etimeSeconds });
    const before = state.prevCpu?.get(p.pid);
    if (elapsedS && before && p.etimeSeconds >= before.etime && p.cpuSeconds >= before.seconds) {
      cpuByPid.set(p.pid, ((p.cpuSeconds - before.seconds) / elapsedS) * 100);
    }
  }
  state.prevCpu = nextCpu;
  state.lastMs = tMs;
  const cpuOf = (pid) => cpuByPid.get(pid) ?? null;

  const aggr = {};
  for (const p of procs) {
    const c = classes.get(p.pid);
    const key = c.sub ? `${c.cat}|${c.sub}` : c.cat;
    const row = (aggr[key] ??= { n: 0, cpuPct: 0, rssKb: 0 });
    row.n += 1;
    row.cpuPct += cpuOf(p.pid) ?? 0;
    row.rssKb += p.rssKb;
  }
  for (const row of Object.values(aggr)) row.cpuPct = round(row.cpuPct);

  const listed = procs
    .filter((p) => {
      const c = classes.get(p.pid);
      return (
        (cpuOf(p.pid) ?? 0) >= 2 ||
        p.rssKb >= 100 * 1024 ||
        RUN_CATEGORIES.has(c.cat) ||
        (c.own && c.cat === 'ai-session')
      );
    })
    .map((p) => {
      const c = classes.get(p.pid);
      const { exe, script } = describeCommand(p.args);
      return {
        pid: p.pid,
        ppid: p.ppid,
        cpuPct: cpuOf(p.pid) === null ? null : round(cpuOf(p.pid)),
        rssKb: p.rssKb,
        ageS: Math.round(p.etimeSeconds),
        exe,
        script,
        cat: c.cat,
        sub: c.sub,
        session: c.session,
        inQueue: c.inQueue,
      };
    })
    .sort((x, y) => (y.cpuPct ?? 0) - (x.cpuPct ?? 0))
    .slice(0, 80);

  const runs = findRuns(procs, classes, cpuOf);
  const envOf = deps.envOf ?? (async (pids) => vitestEnv(exec, pids));
  const runnerPids = runs.filter((r) => r.kind === 'vitest').map((r) => r.pid);
  const envs = runnerPids.length ? ((await attempt('env', () => envOf(runnerPids))) ?? {}) : {};
  for (const run of runs) {
    run.env = run.kind === 'vitest' ? (envs[run.pid] ?? {}) : null;
  }

  const sessions = {};
  for (const [pid, c] of classes) {
    if (c.own && c.cat === 'ai-session' && c.session === pid)
      sessions[c.provider] = (sessions[c.provider] ?? 0) + 1;
  }

  const vm = vmOut ? parseVmStat(vmOut) : null;
  return {
    type: 'sample',
    t: new Date(tMs).toISOString(),
    tMs,
    elapsedS: elapsedS === null ? null : round(elapsedS),
    load: os.loadavg().map((v) => round(v, 2)),
    cpu,
    mem: { totalBytes: os.totalmem(), ...(vm ?? {}) },
    swap: swapOut ? parseSwapUsage(swapOut) : null,
    pressure: pressureOut ? parsePressure(pressureOut) : null,
    heavy: queue,
    sessions,
    processCount: procs.length,
    aggr,
    runs,
    procs: listed,
    errors,
  };
}

async function vitestEnv(exec, pids) {
  const out = await exec('ps', ['eww', '-o', 'pid=,command=', '-p', pids.join(',')]);
  const byPid = {};
  for (const line of out.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match) byPid[Number(match[1])] = pickVitestEnv(match[2]);
  }
  return byPid;
}

export function headerRecord({ interval, duration, label }) {
  return {
    type: 'header',
    version: PROBE_VERSION,
    startedAt: new Date().toISOString(),
    interval,
    duration,
    label: safeName(label ?? '', 60),
    host: {
      platform: process.platform,
      release: os.release(),
      cpus: os.availableParallelism(),
      memoryBytes: os.totalmem(),
      node: process.version,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Inventory (once per window)

function countFiles(dir) {
  return new Promise((resolve) => {
    const child = spawn('find', ['-x', dir, '-type', 'f'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let count = 0;
    child.stdout.on('data', (chunk) => {
      for (const byte of chunk) if (byte === 10) count += 1;
    });
    child.on('error', () => resolve(null));
    child.on('close', () => resolve(count));
  });
}

async function sizeKb(dir, exec) {
  try {
    return Number((await exec('du', ['-sk', '-x', dir], { timeout: 600_000 })).split(/\s/)[0]);
  } catch {
    return null;
  }
}

async function findCheckouts(root, exec) {
  try {
    const out = await exec(
      'find',
      [
        root,
        '-maxdepth',
        '5',
        '(',
        '-name',
        'node_modules',
        '-prune',
        ')',
        '-o',
        '(',
        '-name',
        '.git',
        '-print',
        ')',
      ],
      { timeout: 300_000 },
    );
    return out
      .split('\n')
      .filter(Boolean)
      .map((p) => path.dirname(p));
  } catch {
    return [];
  }
}

/** Sizes and counts of the checkout folders, Docker and Spotlight state. Read-only. */
export async function collectInventory({ roots, count = true, exec = REAL_EXEC } = {}) {
  const home = os.homedir();
  const defaults = [
    path.join(home, '.projectman', 'workspaces'),
    path.join(home, '.projectman', 'member-caches'),
  ];
  try {
    for (const name of fs.readdirSync(home))
      if (name.startsWith('projectman-')) defaults.push(path.join(home, name));
  } catch {
    /* no home listing */
  }
  const list = [...new Set([...defaults, ...(roots ?? [])])].filter((dir) => fs.existsSync(dir));
  const shown = (dir) => safeName(dir.startsWith(home) ? `~${dir.slice(home.length)}` : dir, 120);
  const rootRows = [];
  for (const root of list) {
    const checkouts = await findCheckouts(root, exec);
    const rows = [];
    for (const dir of checkouts) {
      rows.push({
        path: shown(dir),
        sizeKb: await sizeKb(dir, exec),
        files: count ? await countFiles(dir) : null,
        nodeModules: fs.existsSync(path.join(dir, 'node_modules')),
      });
    }
    let indexed = null;
    try {
      indexed = Number(
        (
          await exec('mdfind', ['-onlyin', root, '-count', 'kMDItemFSName == "package.json"'], {
            timeout: 60_000,
          })
        ).trim(),
      );
    } catch {
      /* Spotlight unavailable */
    }
    let volume = null;
    try {
      volume = safeName((await exec('mdutil', ['-s', root], { timeout: 30_000 })).replace(/\s+/g, ' '), 200);
    } catch {
      /* mdutil refused */
    }
    rootRows.push({
      root: shown(root),
      sizeKb: await sizeKb(root, exec),
      files: count ? await countFiles(root) : null,
      checkouts: rows.length,
      neverIndex: fs.existsSync(path.join(root, '.metadata_never_index')),
      spotlightPackageJsonHits: indexed,
      spotlightVolume: volume,
      items: rows,
    });
  }
  let docker = null;
  try {
    const running = (await exec('docker', ['ps', '-q'], { timeout: 10_000 }))
      .split('\n')
      .filter(Boolean).length;
    docker = { reachable: true, runningContainers: running };
  } catch (error) {
    docker = { reachable: false, reason: safeName(error?.code ?? 'failed', 40) };
  }
  return { type: 'inventory', at: new Date().toISOString(), version: PROBE_VERSION, roots: rootRows, docker };
}

// ---------------------------------------------------------------------------------------------------------------
// Log filter: the engine-link lines of a pino log, numeric and enum fields only

const LINK_FIELDS = [
  'code',
  'cause',
  'sinceHeardMs',
  'connectedForMs',
  'downForMs',
  'attempts',
  'pendingEvents',
  'engineId',
];

/** One log line → a link event, or null when it is not about the engine link. */
export function filterLogLine(line, side) {
  let raw;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!raw || typeof raw.msg !== 'string') return null;
  const text = `${raw.msg} ${typeof raw.reason === 'string' ? raw.reason : ''} ${typeof raw.error === 'string' ? raw.error : ''}`;
  if (!/^engine link/.test(raw.msg) && !/link_silent|engine_unavailable|engine_offline/.test(text))
    return null;
  const time = typeof raw.time === 'number' ? raw.time : Date.parse(raw.time);
  if (!Number.isFinite(time)) return null;
  const event = {
    ts: new Date(time).toISOString(),
    tMs: time,
    side,
    level: raw.level ?? null,
    msg: safeName(raw.msg, 80),
  };
  for (const name of LINK_FIELDS) {
    const v = raw[name];
    if (typeof v === 'number') event[name] = v;
    else if (typeof v === 'string' && name !== 'engineId') event[name] = safeName(v, 32);
  }
  if (/link_silent/.test(text)) event.reason = 'link_silent';
  return event;
}

export function filterLogText(text, side) {
  return text
    .split('\n')
    .map((line) => filterLogLine(line, side))
    .filter(Boolean);
}

/** Counts of an event list: connected/disconnected, by code and cause, by hour. */
export function summarizeLinks(events) {
  const disconnects = events.filter((e) => e.msg === 'engine link: disconnected');
  const by = (key) => {
    const counts = {};
    for (const e of disconnects)
      counts[String(e[key] ?? 'unknown')] = (counts[String(e[key] ?? 'unknown')] ?? 0) + 1;
    return counts;
  };
  const byHour = {};
  for (const e of disconnects) byHour[e.ts.slice(0, 13)] = (byHour[e.ts.slice(0, 13)] ?? 0) + 1;
  return {
    events: events.length,
    connected: events.filter((e) => e.msg === 'engine link: connected').length,
    disconnected: disconnects.length,
    heartbeat: disconnects.filter((e) => e.code === 4400 || e.cause === 'heartbeat').length,
    linkSilent: events.filter((e) => e.reason === 'link_silent').length,
    byCode: by('code'),
    byCause: by('cause'),
    byHour,
    first: events[0]?.ts ?? null,
    last: events.at(-1)?.ts ?? null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Summary of one window

export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const stat = (values, digits = 2) => ({
  mean: values.length ? round(mean(values), digits) : null,
  p95: values.length ? round(percentile(values, 0.95), digits) : null,
  max: values.length ? round(Math.max(...values), digits) : null,
});

/** `defaultTestWorkers` of packages/shared/src/config/test-workers.ts. */
export function defaultTestWorkers({ cpus, memoryBytes }) {
  return Math.max(1, Math.min(4, Math.floor(cpus / 2), Math.floor(memoryBytes / 2 ** 32)));
}

/**
 * Summarises a window: machine load, the ranking by category (CPU cores and RSS, mean and p95; the share of the
 * 1-minute load is an estimate: category CPU / all accounted CPU × mean load), the vitest runs against
 * `defaultTestWorkers`, the heavy runs outside the queue, the sessions, the heavy-run holders, the sampling gaps
 * and, per link drop, the 5 minutes before it.
 */
export function summarizeWindow(records, linkEvents = []) {
  const header = records.find((r) => r.type === 'header') ?? null;
  const samples = records.filter((r) => r.type === 'sample').sort((a, b) => a.tMs - b.tMs);
  const cores = header?.host?.cpus ?? null;
  const memoryBytes = header?.host?.memoryBytes ?? null;
  const interval = header?.interval ?? 30;
  const gaps = [];
  for (let i = 1; i < samples.length; i += 1) {
    const gapS = (samples[i].tMs - samples[i - 1].tMs) / 1000;
    if (gapS > interval * 3) gaps.push({ from: samples[i - 1].t, to: samples[i].t, gapS: round(gapS, 0) });
  }
  const withCpu = samples.filter((s) => s.cpu);
  const busyCores = (s) => (s.cpu ? ((s.cpu.user + s.cpu.sys) / 100) * (cores ?? 1) : null);

  const keys = new Set();
  for (const s of samples) for (const key of Object.keys(s.aggr ?? {})) keys.add(key);
  const rows = [];
  const catKey = (key) => key.split('|')[0];
  const series = (pick) => {
    const out = {};
    for (const key of keys) out[key] = samples.map((s) => pick(s.aggr?.[key]));
    return out;
  };
  const cpuSeries = series((r) => (r ? r.cpuPct / 100 : 0));
  const rssSeries = series((r) => (r ? r.rssKb / 1024 : 0));
  const catCpu = {};
  const catRss = {};
  for (const key of keys) {
    const cat = catKey(key);
    catCpu[cat] ??= samples.map(() => 0);
    catRss[cat] ??= samples.map(() => 0);
    samples.forEach((_, i) => {
      catCpu[cat][i] += cpuSeries[key][i];
      catRss[cat][i] += rssSeries[key][i];
    });
  }
  const meanLoad1 = mean(samples.map((s) => s.load[0])) ?? 0;
  const accounted = Object.values(catCpu).reduce((sum, list) => sum + (mean(list) ?? 0), 0);
  for (const [cat, list] of Object.entries(catCpu)) {
    rows.push({
      category: cat,
      cpuCores: stat(list),
      rssMb: stat(catRss[cat], 0),
      loadShareEstimate: accounted > 0 ? round(((mean(list) ?? 0) / accounted) * meanLoad1) : null,
    });
  }
  rows.sort((a, b) => (b.cpuCores.mean ?? 0) - (a.cpuCores.mean ?? 0));
  const subRows = [...keys]
    .map((key) => ({ key, cpuCores: stat(cpuSeries[key]), rssMb: stat(rssSeries[key], 0) }))
    .sort((a, b) => (b.cpuCores.mean ?? 0) - (a.cpuCores.mean ?? 0))
    .slice(0, 40);
  const busy = withCpu.map(busyCores);
  const accountedPerSample = samples.map((s) =>
    Object.values(s.aggr ?? {}).reduce((sum, r) => sum + r.cpuPct / 100, 0),
  );

  // vitest runs: one per runner pid, the largest worker count seen
  const runMap = new Map();
  const heavyOutside = [];
  const heavyInside = [];
  for (const s of samples) {
    let outside = 0;
    let inside = 0;
    let outsideCpu = 0;
    for (const r of s.runs ?? []) {
      if (r.inQueue) inside += 1;
      else {
        outside += 1;
        outsideCpu += r.cpuPct / 100;
      }
      if (r.kind !== 'vitest') continue;
      const id = `${r.pid}`;
      const run = runMap.get(id) ?? {
        pid: r.pid,
        firstSeen: s.t,
        lastSeen: s.t,
        maxWorkers: 0,
        samples: 0,
        inQueue: r.inQueue,
        provider: r.provider,
        env: r.env ?? {},
        maxWorkersArg: r.maxWorkersArg,
        cpuCores: [],
        loads: [],
      };
      run.lastSeen = s.t;
      run.samples += 1;
      run.maxWorkers = Math.max(run.maxWorkers, r.workers ?? 0);
      run.inQueue = run.inQueue && r.inQueue;
      run.cpuCores.push(r.cpuPct / 100);
      run.loads.push(s.load[0]);
      runMap.set(id, run);
    }
    heavyOutside.push({ t: s.t, n: outside, cpuCores: outsideCpu });
    heavyInside.push(inside);
  }
  const expected = cores && memoryBytes ? defaultTestWorkers({ cpus: cores, memoryBytes }) : null;
  const vitestRuns = [...runMap.values()].map((run) => {
    const source = [];
    if (!run.inQueue) source.push('queue-outside');
    for (const [name, value] of Object.entries(run.env)) source.push(`${name}=${value}`);
    if (run.maxWorkersArg !== null) source.push(`--maxWorkers=${run.maxWorkersArg}`);
    return {
      pid: run.pid,
      firstSeen: run.firstSeen,
      lastSeen: run.lastSeen,
      seenSamples: run.samples,
      maxWorkersObserved: run.maxWorkers,
      defaultTestWorkers: expected,
      differs: expected !== null && run.maxWorkers !== expected,
      inQueue: run.inQueue,
      provider: run.provider,
      overrides: source,
      cpuCoresMean: round(mean(run.cpuCores) ?? 0),
      load1Mean: round(mean(run.loads) ?? 0),
    };
  });

  // heavy-run holders (merge-test, full test, shots, typecheck) by ticket pid and label
  const holds = new Map();
  for (const s of samples) {
    const h = s.heavy?.holder;
    if (!h) continue;
    const id = `${h.pid}|${h.label}`;
    const hold = holds.get(id) ?? {
      label: h.label,
      pid: h.pid,
      from: s.t,
      to: s.t,
      loads: [],
      waitingMax: 0,
    };
    hold.to = s.t;
    hold.loads.push(s.load[0]);
    hold.waitingMax = Math.max(hold.waitingMax, s.heavy.waiting?.length ?? 0);
    holds.set(id, hold);
  }
  const heavyHolds = [...holds.values()].map((h) => ({
    label: h.label,
    pid: h.pid,
    from: h.from,
    to: h.to,
    seenForS: round((Date.parse(h.to) - Date.parse(h.from)) / 1000 + interval, 0),
    load1Mean: round(mean(h.loads) ?? 0),
    waitingMax: h.waitingMax,
  }));

  // the link drops and the 5 minutes before each
  const drops = linkEvents.filter((e) => e.msg === 'engine link: disconnected' || e.reason === 'link_silent');
  const dropRows = drops.map((e) => {
    const before = samples.filter((s) => s.tMs >= e.tMs - 5 * 60_000 && s.tMs <= e.tMs);
    const catMeans = {};
    for (const s of before) {
      for (const [key, r] of Object.entries(s.aggr ?? {})) {
        const cat = catKey(key);
        catMeans[cat] = (catMeans[cat] ?? 0) + r.cpuPct / 100 / before.length;
      }
    }
    const top3 = Object.entries(catMeans)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([category, cpuCores]) => ({ category, cpuCores: round(cpuCores) }));
    const load1Max = before.length ? Math.max(...before.map((s) => s.load[0])) : null;
    const pressureMax = before.length ? Math.max(...before.map((s) => s.pressure ?? 0)) : null;
    const inGap = gaps.some((g) => Date.parse(g.from) <= e.tMs && e.tMs <= Date.parse(g.to));
    return {
      ts: e.ts,
      side: e.side,
      msg: e.msg,
      code: e.code ?? null,
      cause: e.cause ?? null,
      sinceHeardMs: e.sinceHeardMs ?? null,
      connectedForMs: e.connectedForMs ?? null,
      samplesBefore: before.length,
      load1Mean: before.length ? round(mean(before.map((s) => s.load[0])) ?? 0) : null,
      load1Max,
      cpuBusyMean: before.filter((s) => s.cpu).length
        ? round(mean(before.filter((s) => s.cpu).map((s) => s.cpu.user + s.cpu.sys)) ?? 0)
        : null,
      swapUsedGbMax: before.some((s) => s.swap)
        ? round(Math.max(...before.map((s) => (s.swap?.usedBytes ?? 0) / 1024 ** 3)))
        : null,
      pressureMax,
      highLoad: load1Max !== null && cores !== null ? load1Max > cores || (pressureMax ?? 0) >= 2 : null,
      top3,
      duringSamplingGap: inGap,
    };
  });

  const sessionSeries = {};
  const providers = new Set(samples.flatMap((s) => Object.keys(s.sessions ?? {})));
  for (const p of providers) sessionSeries[p] = stat(samples.map((s) => s.sessions?.[p] ?? 0));
  const sessionTotal = stat(samples.map((s) => Object.values(s.sessions ?? {}).reduce((a, b) => a + b, 0)));

  return {
    window: {
      label: header?.label ?? null,
      from: samples[0]?.t ?? null,
      to: samples.at(-1)?.t ?? null,
      intervalS: interval,
      samples: samples.length,
      cores,
      memoryGb: memoryBytes ? round(memoryBytes / 1024 ** 3) : null,
      defaultTestWorkers: expected,
      samplingGaps: gaps,
      sampleErrors: [...new Set(samples.flatMap((s) => s.errors ?? []))],
    },
    machine: {
      load1: stat(samples.map((s) => s.load[0])),
      load5: stat(samples.map((s) => s.load[1])),
      load15: stat(samples.map((s) => s.load[2])),
      samplesLoad1AboveCores: cores ? samples.filter((s) => s.load[0] > cores).length : null,
      cpuBusyCores: stat(busy),
      swapUsedGb: stat(samples.filter((s) => s.swap).map((s) => s.swap.usedBytes / 1024 ** 3)),
      memUsedGb: stat(
        samples.filter((s) => s.mem?.usedBytes != null).map((s) => s.mem.usedBytes / 1024 ** 3),
      ),
      pressure: {
        warnOrWorseSamples: samples.filter((s) => (s.pressure ?? 0) >= 2).length,
        criticalSamples: samples.filter((s) => s.pressure === 4).length,
      },
      accountedCpuCores: stat(accountedPerSample.filter((_, i) => samples[i].cpu)),
      unaccountedCpuCoresMean: busy.length
        ? round((mean(busy) ?? 0) - (mean(accountedPerSample.filter((_, i) => samples[i].cpu)) ?? 0))
        : null,
    },
    ranking: rows,
    rankingDetail: subRows,
    sessions: { total: sessionTotal, byProvider: sessionSeries },
    vitestRuns,
    heavyRunsOutsideQueue: {
      samplesWithAny: heavyOutside.filter((h) => h.n > 0).length,
      samplesWithTwoOrMore: heavyOutside.filter((h) => h.n >= 2).length,
      concurrent: stat(heavyOutside.map((h) => h.n)),
      cpuCores: stat(heavyOutside.map((h) => h.cpuCores)),
      insideQueueConcurrentMax: heavyInside.length ? Math.max(...heavyInside) : 0,
    },
    heavyHolds,
    linkDrops: dropRows,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Command line

function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq !== -1) flags[token.slice(2, eq)] = token.slice(eq + 1);
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags[token.slice(2)] = argv[++i];
      else flags[token.slice(2)] = true;
    } else rest.push(token);
  }
  return { flags, rest };
}

function readJsonl(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function main(argv) {
  const [command, ...tail] = argv;
  const { flags, rest } = parseArgs(tail);
  if (command === 'sample') {
    const out = flags.out;
    if (typeof out !== 'string') throw new Error('sample needs --out <file.jsonl>');
    const interval = Number(flags.interval ?? 30);
    const duration = Number(flags.duration ?? 7200);
    fs.appendFileSync(out, `${JSON.stringify(headerRecord({ interval, duration, label: flags.label }))}\n`);
    const state = {};
    const end = Date.now() + duration * 1000;
    let stop = false;
    process.on('SIGINT', () => {
      stop = true;
    });
    process.on('SIGTERM', () => {
      stop = true;
    });
    let count = 0;
    while (!stop && Date.now() < end) {
      const began = Date.now();
      fs.appendFileSync(out, `${JSON.stringify(await collectSample(state))}\n`);
      count += 1;
      const wait = interval * 1000 - (Date.now() - began);
      for (let slept = 0; !stop && slept < wait; slept += 500)
        await new Promise((r) => setTimeout(r, Math.min(500, wait - slept)));
    }
    process.stderr.write(`load-probe: ${count} samples in ${out}\n`);
    return;
  }
  if (command === 'inventory') {
    const out = flags.out;
    if (typeof out !== 'string') throw new Error('inventory needs --out <file.json>');
    const inventory = await collectInventory({
      roots: typeof flags.roots === 'string' ? flags.roots.split(',').filter(Boolean) : [],
      count: flags['no-count'] !== true,
    });
    fs.writeFileSync(out, `${JSON.stringify(inventory, null, 2)}\n`);
    return;
  }
  if (command === 'links') {
    const out = flags.out;
    const side = typeof flags.side === 'string' ? flags.side : 'engine';
    if (typeof out !== 'string' || rest.length === 0)
      throw new Error('links needs --out <file.jsonl> [--side engine|cloud] <log>...');
    const events = rest
      .flatMap((file) => filterLogText(fs.readFileSync(file, 'utf8'), side))
      .sort((a, b) => a.tMs - b.tMs);
    fs.writeFileSync(out, events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));
    process.stdout.write(`${JSON.stringify(summarizeLinks(events), null, 2)}\n`);
    return;
  }
  if (command === 'summarize') {
    if (typeof flags.samples !== 'string') throw new Error('summarize needs --samples <file.jsonl>');
    const links = typeof flags.links === 'string' ? flags.links.split(',').flatMap((f) => readJsonl(f)) : [];
    const summary = summarizeWindow(readJsonl(flags.samples), links);
    const text = `${JSON.stringify(summary, null, 2)}\n`;
    if (typeof flags.out === 'string') fs.writeFileSync(flags.out, text);
    else process.stdout.write(text);
    return;
  }
  throw new Error('usage: load-probe.mjs sample|inventory|links|summarize (see the header of the file)');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`load-probe: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
