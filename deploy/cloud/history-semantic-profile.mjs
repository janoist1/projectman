#!/usr/bin/env node
// Release measurement of the history search's local embedding (PM-910, PM-767 AC7, docs/HYBRID.md
// "History semantic profile"). It runs the BUILT server (dist/index.js + dist/history-semantic-worker.js) twice,
// each time as a fresh process on a disposable home: once with PROJECTMAN_HISTORY_SEMANTIC=off (the baseline),
// once with it on, under the same fixture, load, heap limit and CPU. The embedding's extra memory is the
// difference of the two runs, never the sum of two RSS figures. No dependencies: it reuses the PM-773 tools
// (memory-probe.mjs, memory-profile.mjs).
//
//   node history-semantic-profile.mjs --server <abs bundle path> --model-dir <abs path> --fixture <abs json path>
//     --out <abs empty dir> [--mixed-seconds 600]
//
// --server is the measurement entry beside the server bundle, dist/history-semantic-profile.js: the same
// server as dist/index.js (apps/server/src/start.ts) plus a loopback listener for the search facade, because
// the search is otherwise reachable only through a member's MCP session. dist/history-semantic-worker.js
// must lie beside it. Both runs use that one bundle; only PROJECTMAN_HISTORY_SEMANTIC differs.
//
// It must run inside the Linux ARM64 container whose cgroup v2 is the limit (memory.max <= 2 GiB,
// memory.swap.max = 0), with the prepared model on a local file and no network. It never runs on the live
// instance: it makes its own home under --out and a synthetic test login, and starts no member CLI.
// better-sqlite3 is loaded from the node_modules beside the bundle (the image has them) to seed the
// disposable database; nothing else is installed.
//
// Exit codes: 0 every phase measured and inside the frame; 64 refused (a bad parameter, an unsafe or used --out,
// an invalid fixture: nothing was started); 78 the platform, the cgroup or the model is missing (`unsupported`,
// not a measurement); 1 a measured result outside the frame, or the run failed.

import { spawn } from 'node:child_process';
import {
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { LOAD_ROUTES, buildNodeArgs, buildServerEnv, readProbeLines } from './memory-profile.mjs';

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_REFUSED = 64;
export const EXIT_UNSUPPORTED = 78;

const MIB = 1024 * 1024;

/** The frame of PM-767 (AC7) and of the release condition of PM-910; every figure in bytes or milliseconds. */
export const BUDGET = {
  memoryLimitBytes: 2048 * MIB,
  extraRssBytes: 350 * MIB,
  rssPeakBytes: 1200 * MIB,
  cgroupPeakBytes: 1536 * MIB,
  searchMaxMs: 2000,
  httpP95ExcessRatio: 0.2,
  httpP95ExcessMinMs: 50,
  topTenMinimum: 15,
};

export const MIN_MIXED_SECONDS = 600;
/** The least deadline of a run: below it not even the baseline fits. */
export const MIN_MAX_SECONDS = 300;
export const MIN_BASELINE_SECONDS = 60;

/** The phases a passing report holds, in the order they run. */
export const PHASE_NAMES = ['off', 'cold_load', 'backfill', 'warm', 'mixed', 'restart', 'off_again'];

/** The technical reasons a report may name; nothing else, never free text. */
export const REASON_CODES = [
  'unsupported_platform',
  'cgroup_unavailable',
  'model_unavailable',
  'invalid_fixture',
  'server_failed',
  'missing_phase',
  'memory_budget_exceeded',
  'latency_budget_exceeded',
  'recall_failed',
  'network_attempt',
  'oom_detected',
  'deadline_exceeded',
];

export const SOURCE_TYPES = ['task', 'note', 'question', 'message', 'document'];
/** The documents the runtime indexes (HISTORY_DOC_PATHS in packages/shared); the benchmark never adds to them. */
export const DOCUMENT_PATHS = ['docs/DECISIONS.md', 'docs/LESSONS.md'];

export class UsageError extends Error {
  constructor(message, code = null) {
    super(message);
    this.code = code;
  }
}

export const USAGE = `usage: node history-semantic-profile.mjs --server <abs bundle path> --model-dir <abs path>
  --fixture <abs json path> --out <abs empty dir> [--mixed-seconds <integer> (default ${MIN_MIXED_SECONDS}, least ${MIN_MIXED_SECONDS})]
  [--max-seconds <integer> (the run's own deadline, least ${MIN_MAX_SECONDS}; default none)]`;

const VALUE_OPTIONS = new Set(['server', 'model-dir', 'fixture', 'out', 'mixed-seconds', 'max-seconds']);

/** Parses the command line; throws `UsageError` with the reason. Every path must be absolute. */
export function parseArgs(argv) {
  const raw = new Map();
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
    if (raw.has(name)) throw new UsageError(`--${name} given twice`);
    raw.set(name, value);
  }
  for (const required of ['server', 'model-dir', 'fixture', 'out']) {
    if (!raw.get(required)) throw new UsageError(`--${required} is required`);
    if (!isAbsolute(raw.get(required))) throw new UsageError(`--${required} must be an absolute path`);
  }
  let mixedSeconds = MIN_MIXED_SECONDS;
  if (raw.has('mixed-seconds')) {
    const text = raw.get('mixed-seconds').trim();
    mixedSeconds = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(mixedSeconds) || mixedSeconds < MIN_MIXED_SECONDS) {
      throw new UsageError(`--mixed-seconds must be an integer of at least ${MIN_MIXED_SECONDS}`);
    }
  }
  // 0 = no deadline of the run's own.
  let maxSeconds = 0;
  if (raw.has('max-seconds')) {
    const text = raw.get('max-seconds').trim();
    maxSeconds = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(maxSeconds) || maxSeconds < MIN_MAX_SECONDS) {
      throw new UsageError(`--max-seconds must be an integer of at least ${MIN_MAX_SECONDS}`);
    }
  }
  return {
    help: false,
    server: resolve(raw.get('server')),
    modelDir: resolve(raw.get('model-dir')),
    fixture: resolve(raw.get('fixture')),
    out: resolve(raw.get('out')),
    mixedSeconds,
    maxSeconds,
  };
}

// ---------- the fixture ----------

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '';

/**
 * The fixture is a private input, never part of the shared report:
 * { schemaVersion: 1, origin: string, project: { key },
 *   sources: [{ id, type, title, body }],        // the five source types, long and short texts
 *   questions: [{ question, targetId }],          // reworded questions and the source that answers each
 *   negatives: [{ question }] }                   // questions about nothing the history holds
 * Throws `UsageError` (code `invalid_fixture`) naming the first problem; returns the parsed fixture.
 */
export function validateFixture(value) {
  const fail = (message) => {
    throw new UsageError(`invalid fixture: ${message}`, 'invalid_fixture');
  };
  if (!isRecord(value) || value.schemaVersion !== 1) fail('schemaVersion must be 1');
  if (!isText(value.origin)) fail('origin (where the data comes from and how it was cleared) is required');
  if (!isRecord(value.project) || !/^[A-Z][A-Z0-9]{0,9}$/.test(value.project.key ?? ''))
    fail('project.key must be an upper-case project key');
  if (!Array.isArray(value.sources) || value.sources.length === 0) fail('sources is empty');
  const ids = new Set();
  const types = new Set();
  const documentPaths = new Set();
  for (const source of value.sources) {
    if (!isRecord(source) || !isText(source.id) || !SOURCE_TYPES.includes(source.type))
      fail(`a source needs an id and one of ${SOURCE_TYPES.join(', ')}`);
    if (ids.has(source.id)) fail('source ids must be unique');
    ids.add(source.id);
    types.add(source.type);
    if (typeof source.title !== 'string' || !isText(source.body)) fail('a source needs a title and a body');
    if (source.type === 'document') {
      if (!DOCUMENT_PATHS.includes(source.path))
        fail(`a document path is one of ${DOCUMENT_PATHS.join(', ')}`);
      if (documentPaths.has(source.path)) fail('each supported document appears once');
      documentPaths.add(source.path);
    }
  }
  for (const type of SOURCE_TYPES) if (!types.has(type)) fail(`no source of type ${type}`);
  if (!Array.isArray(value.questions) || value.questions.length < 20)
    fail('at least 20 questions are needed');
  for (const item of value.questions) {
    if (!isRecord(item) || !isText(item.question) || !ids.has(item.targetId))
      fail('a question needs its text and the id of a source');
  }
  if (!Array.isArray(value.negatives) || value.negatives.length === 0) fail('negatives is empty');
  for (const item of value.negatives)
    if (!isRecord(item) || !isText(item.question)) fail('a negative needs a text');
  return value;
}

/** A fixture file read and checked; throws `UsageError`. */
export function readFixture(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new UsageError(`--fixture cannot be read: ${path}`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new UsageError('invalid fixture: not JSON', 'invalid_fixture');
  }
  return validateFixture(value);
}

/** The size of the corpus as the report states it; chunks come from the measured index, not from the fixture. */
export function corpusOf(fixture, chunks) {
  return {
    sources: fixture.sources.length,
    chunks,
    inputBytes: fixture.sources.reduce(
      (sum, source) => sum + Buffer.byteLength(source.title) + Buffer.byteLength(source.body),
      0,
    ),
    origin: fixture.origin,
  };
}

// ---------- seeding the disposable database ----------

/** The id of a source in the index (`historySourceId` in apps/server/src/db/history.ts; a test keeps them equal). */
export function historySourceId(projectKey, type, entityId) {
  return `hsrc_${createHash('sha256').update(`${projectKey}\u0000${type}\u0000${entityId}`).digest('hex')}`;
}

/** The entity id of a document row: the repository and the path, as JSON (`historyDocumentEntityId`). */
export const documentEntityId = (repo, path) => JSON.stringify([repo, path]);

export const PROFILE_REPO = 'profile';
const HOST_SEQ = 1;

/**
 * Writes the fixture's sources into the live tables of a disposable database through `db` (better-sqlite3), so the
 * server's own indexer builds the full-text index and then the semantic one, exactly as for real data. The four
 * table sources are plain rows of the four source tables; the two supported documents are stored whole. Returns the
 * source ids by fixture id. `firstSeq` lets a later batch (the churn of the mixed phase) add cards after the first.
 */
export function seedSources(db, { projectKey, stageId, sources, idPrefix = 'fx', firstSeq = HOST_SEQ, at }) {
  const base = Date.parse(at ?? '2026-01-01T00:00:00.000Z');
  const stamp = (index) => new Date(base + index * 60_000).toISOString();
  const insertTask = db.prepare(
    `INSERT INTO tasks (id, project_key, key, seq, title, description, stage_id, status, labels, checks, visibility,
       created_by, created_at, stage_entered_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', '[]', '{}', 'internal', 'owner', ?, ?, ?)`,
  );
  const insertNote = db.prepare(
    `INSERT INTO timeline_events (id, project_key, task_key, actor_kind, actor_handle, type, data, created_at)
     VALUES (?, ?, ?, 'human', 'owner', 'task_note', ?, ?)`,
  );
  const insertQuestion = db.prepare(
    `INSERT INTO inbox_items (id, project_key, kind, assignees, source, task_key, title, body, payload, options, state,
       created_at, updated_at)
     VALUES (?, ?, 'question', '["owner"]', 'owner', NULL, ?, ?, ?, '[]', 'resolved', ?, ?)`,
  );
  const insertMessage = db.prepare(
    `INSERT INTO team_messages (id, project_key, from_handle, to_handles, task_key, body, created_at)
     VALUES (?, ?, 'owner', '["owner"]', NULL, ?, ?)`,
  );
  const insertDocument = db.prepare(
    `INSERT INTO history_documents (source_id, project_key, source_type, entity_id, task_key, author, at, title, body,
       repo, path, commit_sha)
     VALUES (?, ?, 'document', ?, NULL, NULL, ?, '', ?, ?, ?, ?)`,
  );
  const placed = new Map();
  let seq = firstSeq;
  const hostKey = `${projectKey}-${HOST_SEQ}`;
  db.transaction(() => {
    if (firstSeq === HOST_SEQ) {
      const when = stamp(0);
      insertTask.run(
        `${idPrefix}-host`,
        projectKey,
        hostKey,
        HOST_SEQ,
        'Profile host card',
        '',
        stageId,
        when,
        when,
        when,
      );
      seq += 1;
    }
    sources.forEach((source, index) => {
      const entityId = `${idPrefix}-${source.id}`;
      const when = stamp(index + 1);
      switch (source.type) {
        case 'task': {
          const key = `${projectKey}-${seq}`;
          insertTask.run(
            entityId,
            projectKey,
            key,
            seq,
            source.title,
            source.body,
            stageId,
            when,
            when,
            when,
          );
          seq += 1;
          placed.set(source.id, { type: 'task', entityId, taskKey: key });
          break;
        }
        case 'note':
          insertNote.run(entityId, projectKey, hostKey, JSON.stringify({ text: source.body }), when);
          placed.set(source.id, { type: 'note', entityId, taskKey: hostKey });
          break;
        case 'question':
          insertQuestion.run(
            entityId,
            projectKey,
            source.title,
            source.body,
            JSON.stringify({ question: source.title }),
            when,
            when,
          );
          placed.set(source.id, { type: 'question', entityId, taskKey: null });
          break;
        case 'message':
          insertMessage.run(entityId, projectKey, source.body, when);
          placed.set(source.id, { type: 'message', entityId, taskKey: null });
          break;
        case 'document': {
          const entity = documentEntityId(PROFILE_REPO, source.path);
          insertDocument.run(
            historySourceId(projectKey, 'document', entity),
            projectKey,
            entity,
            when,
            source.body,
            PROFILE_REPO,
            source.path,
            'a'.repeat(40),
          );
          placed.set(source.id, { type: 'document', entityId: entity, taskKey: null });
          break;
        }
      }
    });
  })();
  return { placed, nextSeq: seq };
}

// ---------- refusing before anything starts ----------

const isInside = (parent, child) => {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
};

function realOrSelf(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Refuses (throws `UsageError`) unless the run may start: the three inputs exist, --out is missing or an empty
 * real folder away from the inputs. Creates --out owner-only. The home and database of the run live under it.
 */
export function prepareRun(options) {
  if (!existsSync(options.server) || !statSync(options.server).isFile())
    throw new UsageError(`--server is not a file: ${options.server}`);
  if (!existsSync(options.modelDir) || !statSync(options.modelDir).isDirectory())
    throw new UsageError(`--model-dir is not a folder: ${options.modelDir}`);
  const fixture = readFixture(options.fixture);
  const out = options.out;
  if (out === dirname(out)) throw new UsageError('--out must not be the root of the file system');
  for (const [name, path] of [
    ['--server', dirname(options.server)],
    ['--model-dir', options.modelDir],
    ['--fixture', options.fixture],
  ]) {
    if (isInside(realOrSelf(out), realOrSelf(path)) || isInside(realOrSelf(path), realOrSelf(out)))
      throw new UsageError(`--out must not contain or lie inside the folder of ${name}`);
  }
  if (existsSync(out)) {
    if (lstatSync(out).isSymbolicLink()) throw new UsageError('--out must not be a symbolic link');
    if (!statSync(out).isDirectory()) throw new UsageError(`--out exists and is not a folder: ${out}`);
    if (readdirSync(out).length > 0) throw new UsageError(`--out is not empty: ${out}`);
  } else {
    mkdirSync(out, { recursive: true, mode: 0o700 });
  }
  return fixture;
}

// ---------- the machine ----------

/** The cgroup directory of this process on cgroup v2 from the text of /proc/self/cgroup; null when it is v1. */
export function cgroupDirectoryOf(procSelfCgroup, root = '/sys/fs/cgroup') {
  const line = procSelfCgroup.split('\n').find((entry) => entry.startsWith('0::'));
  if (!line) return null;
  const path = line.slice(3).trim();
  return path === '/' || path === '' ? root : join(root, path);
}

/** `memory.events`: its counters by name (`oom_kill`, `oom`, `max`, ...). */
export function parseMemoryEvents(text) {
  const counters = {};
  for (const line of text.split('\n')) {
    const [name, value] = line.trim().split(/\s+/);
    if (name && /^\d+$/.test(value ?? '')) counters[name] = Number(value);
  }
  return counters;
}

const numberOrNull = (text) => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : null);

/**
 * Whether the machine can be measured: Linux ARM64 inside a cgroup v2 with memory.max <= 2 GiB and no swap, and
 * the prepared model. `read(path)` returns the file's text or throws; the reasons are the report's codes.
 */
export function checkMachine({ platform, arch, read, exists, modelDir }) {
  const reasons = [];
  if (platform !== 'linux' || arch !== 'arm64') reasons.push('unsupported_platform');
  let cgroup = null;
  if (platform === 'linux') {
    try {
      const directory = cgroupDirectoryOf(read('/proc/self/cgroup'));
      if (directory) {
        const memoryMax = numberOrNull(read(join(directory, 'memory.max')));
        const swapMax = numberOrNull(read(join(directory, 'memory.swap.max')));
        read(join(directory, 'memory.current'));
        read(join(directory, 'memory.events'));
        if (memoryMax !== null && memoryMax <= BUDGET.memoryLimitBytes && swapMax === 0)
          cgroup = { directory, memoryMax };
      }
    } catch {
      // Unreadable: the cgroup is not usable for the measurement.
    }
  }
  if (!cgroup) reasons.push('cgroup_unavailable');
  if (!exists(join(modelDir, 'manifest.json'))) reasons.push('model_unavailable');
  return { reasons, cgroup };
}

/** The sha256 of the model manifest (it pins every model file's hash); null when there is none. */
export function manifestDigest(modelDir) {
  try {
    return createHash('sha256')
      .update(readFileSync(join(modelDir, 'manifest.json')))
      .digest('hex');
  } catch {
    return null;
  }
}

// ---------- numbers ----------

export const percentile = (sortedValues, p) =>
  sortedValues.length === 0
    ? null
    : sortedValues[Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(p * sortedValues.length) - 1))];

const round1 = (value) => Math.round(value * 10) / 10;

/** p50, p95 and max of a list of milliseconds; all null for an empty list. */
export function latencySummary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (p) => (sorted.length === 0 ? null : round1(percentile(sorted, p)));
  return {
    p50: pick(0.5),
    p95: pick(0.95),
    max: sorted.length === 0 ? null : round1(sorted[sorted.length - 1]),
  };
}

// ---------- the verdict ----------

const PHASE_NUMBERS = [
  'durationMs',
  'rssPeakBytes',
  'cgroupPeakBytes',
  'swapPeakBytes',
  'oomKills',
  'semanticUsed',
];
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/** The embedding's extra RSS: the highest RSS peak of the semantic run minus the baseline's; null if either is missing. */
export function extraRssOf(phases) {
  const off = phases.find((phase) => phase.name === 'off');
  const on = phases.filter((phase) =>
    ['cold_load', 'backfill', 'warm', 'mixed', 'restart'].includes(phase.name),
  );
  if (!off || on.length === 0 || !isNumber(off.rssPeakBytes) || on.some((p) => !isNumber(p.rssPeakBytes)))
    return null;
  return Math.max(...on.map((phase) => phase.rssPeakBytes)) - off.rssPeakBytes;
}

/**
 * The outcome of a measured report and the reasons for it. A missing mandatory phase or an unmeasurable
 * mandatory number is never a pass. `recall` is { topTen, total, negativesClean } of the warm questions.
 */
export function evaluate({
  phases,
  extraRssBytes,
  recall,
  memoryLimitBytes,
  swapLimitBytes,
  networkAttempts,
  restartInterrupted,
  serverFailed,
  deadlineExceeded = false,
}) {
  const reasons = new Set();
  if (serverFailed) reasons.add('server_failed');
  if (deadlineExceeded) reasons.add('deadline_exceeded');
  for (const name of PHASE_NAMES) {
    const phase = phases.find((entry) => entry.name === name);
    if (!phase || PHASE_NUMBERS.some((key) => !isNumber(phase[key]))) reasons.add('missing_phase');
  }
  const measured = phases.filter((phase) => PHASE_NUMBERS.every((key) => isNumber(phase[key])));
  if (extraRssBytes === null || !isNumber(extraRssBytes)) reasons.add('missing_phase');
  else if (extraRssBytes > BUDGET.extraRssBytes) reasons.add('memory_budget_exceeded');
  if (measured.some((phase) => phase.rssPeakBytes > BUDGET.rssPeakBytes))
    reasons.add('memory_budget_exceeded');
  if (measured.some((phase) => phase.cgroupPeakBytes > BUDGET.cgroupPeakBytes))
    reasons.add('memory_budget_exceeded');
  if (!(memoryLimitBytes <= BUDGET.memoryLimitBytes) || swapLimitBytes !== 0)
    reasons.add('memory_budget_exceeded');
  if (measured.some((phase) => phase.swapPeakBytes > 0)) reasons.add('memory_budget_exceeded');
  if (measured.some((phase) => phase.oomKills > 0)) reasons.add('oom_detected');

  const byName = (name) => phases.find((phase) => phase.name === name);
  const warm = byName('warm');
  if (!warm || !isNumber(warm.searchMaxMs)) reasons.add('missing_phase');
  else if (warm.searchMaxMs > BUDGET.searchMaxMs) reasons.add('latency_budget_exceeded');
  const mixed = byName('mixed');
  const off = byName('off');
  if (!mixed || !off || !isNumber(mixed.httpP95Ms) || !isNumber(off.httpP95Ms)) reasons.add('missing_phase');
  else {
    const allowed = Math.max(off.httpP95Ms * BUDGET.httpP95ExcessRatio, BUDGET.httpP95ExcessMinMs);
    if (mixed.httpP95Ms - off.httpP95Ms > allowed) reasons.add('latency_budget_exceeded');
  }
  // The 2 s frame is for the warm questions; the searches of the mixed phase are only reported, and the mixed
  // phase is judged by the control HTTP excess above.
  if (!mixed || !isNumber(mixed.searchMaxMs)) reasons.add('missing_phase');
  // The restart must follow an interrupted indexing: a kill that came after the indexing was done proves nothing.
  if (restartInterrupted !== true) reasons.add('missing_phase');
  // The fast fallback to the words is no semantic success: every warm question must have been answered by meaning.
  if (warm && isNumber(warm.semanticUsed) && warm.semanticUsed < 1) reasons.add('recall_failed');
  // 15 of 20, in proportion when the fixture holds more questions.
  const recallTotal = recall?.total;
  if (
    !recall ||
    !isNumber(recallTotal) ||
    recallTotal < 20 ||
    !isNumber(recall.topTen) ||
    recall.topTen * 20 < BUDGET.topTenMinimum * recallTotal ||
    recall.negativesClean !== true
  )
    reasons.add('recall_failed');
  if (networkAttempts > 0) reasons.add('network_attempt');
  const ordered = REASON_CODES.filter((code) => reasons.has(code));
  return { outcome: ordered.length === 0 ? 'pass' : 'fail', reasonCodes: ordered };
}

// ---------- the report ----------

const PHASE_KEYS = [
  'name',
  'durationMs',
  'rssPeakBytes',
  'cgroupPeakBytes',
  'swapPeakBytes',
  'oomKills',
  'semanticUsed',
  'searchP50Ms',
  'searchP95Ms',
  'searchMaxMs',
  'httpP95Ms',
  'eventLoopP95Ms',
];

const REPORT_KEYS = [
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
  'failure',
];

/** A phase with exactly the shared keys; what was not measured is null. */
export function phaseRecord(values) {
  const phase = {};
  for (const key of PHASE_KEYS) phase[key] = values[key] ?? null;
  return phase;
}

/** The failure with exactly its documented keys, whatever the caller passed; what was not read is null. */
export function failureRecord(values) {
  const cgroup = values.cgroup ?? null;
  const index = values.index ?? null;
  return {
    step: values.step ?? null,
    error: values.error ?? null,
    serverExit: values.serverExit ?? null,
    deadlineExceeded: values.deadlineExceeded === true,
    elapsedSeconds: values.elapsedSeconds ?? null,
    semanticOff: (values.semanticOff ?? []).map((entry) => ({
      cause: entry.cause ?? null,
      code: entry.code ?? null,
      detail: entry.detail ?? null,
    })),
    cgroup: cgroup && {
      memoryCurrentBytes: cgroup.memoryCurrentBytes ?? null,
      swapCurrentBytes: cgroup.swapCurrentBytes ?? null,
      oomKillsTotal: cgroup.oomKillsTotal ?? null,
    },
    index: index && {
      chunks: index.chunks ?? null,
      textDirty: index.textDirty ?? null,
      semanticDirty: index.semanticDirty ?? null,
      semanticComplete: index.semanticComplete ?? null,
    },
    openPhase: values.openPhase ? phaseRecord(values.openPhase) : null,
  };
}

/**
 * The shared report, in the exact shape of the card and nothing more: numbers, versions and technical
 * categories. Raw history text, questions, hits, titles, passwords, cookies and tokens never get in.
 */
export function buildReport(input) {
  const report = {
    schemaVersion: 1,
    sourceVersion: input.sourceVersion,
    imageDigest: input.imageDigest,
    platform: input.platform,
    arch: input.arch,
    nodeVersion: input.nodeVersion,
    modelIndexKey: input.modelIndexKey,
    memoryLimitBytes: input.memoryLimitBytes,
    swapLimitBytes: input.swapLimitBytes,
    corpus: input.corpus,
    phases: input.phases.map(phaseRecord),
    extraRssBytes: input.extraRssBytes,
    outcome: input.outcome,
    reasonCodes: input.reasonCodes,
  };
  // Only a failed run carries the facts of its failure (`collectFailure`), and only in that fixed shape.
  if (input.failure) report.failure = failureRecord(input.failure);
  for (const key of Object.keys(report)) if (!REPORT_KEYS.includes(key)) delete report[key];
  return report;
}

const cell = (value) => (value === null || value === undefined ? '-' : String(value));
const mib = (bytes) => (bytes === null || bytes === undefined ? null : round1(bytes / MIB));
const table = (head, rows) =>
  [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ].join('\n');

/** The human-readable table of the same report; extras (heap limit, CPU, manifest digest) are numbers and versions only. */
export function renderMarkdown(report, extras = {}) {
  const lines = [
    '# History semantic profile',
    '',
    `- outcome: **${report.outcome}**${report.reasonCodes.length ? ` (${report.reasonCodes.join(', ')})` : ''}`,
    `- source version: ${cell(report.sourceVersion)}; image digest: ${cell(report.imageDigest)}`,
    `- ${report.platform}/${report.arch}, node ${report.nodeVersion}; model index key: ${cell(report.modelIndexKey)}`,
    `- memory limit ${mib(report.memoryLimitBytes)} MiB, swap limit ${mib(report.swapLimitBytes)} MiB`,
    `- corpus: ${report.corpus.sources} sources, ${report.corpus.chunks} chunks, ${mib(report.corpus.inputBytes)} MiB of text; origin: ${report.corpus.origin}`,
    ...(extras.versions ? [`- versions: ${extras.versions}`] : []),
    ...(extras.cpuLimit ? [`- cpu limit: ${extras.cpuLimit}`] : []),
    ...(extras.manifestSha256 ? [`- model manifest sha256: ${extras.manifestSha256}`] : []),
    `- embedding extra RSS (semantic run minus baseline run): ${report.extraRssBytes === null ? '-' : `${mib(report.extraRssBytes)} MiB`} (frame: at most ${mib(BUDGET.extraRssBytes)} MiB)`,
    '',
    '## Phases',
    '',
    table(
      [
        'phase',
        'duration s',
        'rss peak MiB',
        'cgroup peak MiB',
        'swap peak MiB',
        'oom kills',
        'semantic used',
        'search p50 ms',
        'search p95 ms',
        'search max ms',
        'http p95 ms',
        'event loop p95 ms',
      ],
      report.phases.map((phase) => [
        phase.name,
        round1(phase.durationMs / 1000),
        mib(phase.rssPeakBytes),
        mib(phase.cgroupPeakBytes),
        mib(phase.swapPeakBytes),
        phase.oomKills,
        phase.semanticUsed,
        phase.searchP50Ms,
        phase.searchP95Ms,
        phase.searchMaxMs,
        phase.httpP95Ms,
        phase.eventLoopP95Ms,
      ]),
    ),
    '',
    `Frame: RSS peak at most ${mib(BUDGET.rssPeakBytes)} MiB, cgroup peak at most ${mib(BUDGET.cgroupPeakBytes)} MiB, no OOM kill, no swap, every warm question within ${BUDGET.searchMaxMs} ms, control HTTP p95 excess within max(${BUDGET.httpP95ExcessRatio * 100}%, ${BUDGET.httpP95ExcessMinMs} ms), at least ${BUDGET.topTenMinimum} of 20 questions with the source in the first 10 and the negative controls unchanged.`,
    'rss peak is the whole server process (the worker thread is part of it); the cgroup peak includes every process of the container, this tool too. semantic used is the share of searches answered by meaning (1 = all).',
  ];
  if (report.failure) {
    const failure = report.failure;
    const open = failure.openPhase;
    lines.push(
      '',
      '## Failure',
      '',
      `- stopped in the \`${cell(failure.step)}\` server after ${cell(failure.elapsedSeconds)} s: ${cell(failure.error)}`,
      `- server ended: ${cell(failure.serverExit)}; run deadline exceeded: ${failure.deadlineExceeded}`,
      `- container (cumulative): memory ${cell(mib(failure.cgroup?.memoryCurrentBytes))} MiB, swap ${cell(mib(failure.cgroup?.swapCurrentBytes))} MiB, oom kills ${cell(failure.cgroup?.oomKillsTotal)}`,
      `- index: ${cell(failure.index?.chunks)} chunks, text dirty ${cell(failure.index?.textDirty)}, semantic dirty ${cell(failure.index?.semanticDirty)}, complete ${cell(failure.index?.semanticComplete)}`,
      ...(open
        ? [
            `- phase in progress: rss peak ${cell(mib(open.rssPeakBytes))} MiB, cgroup peak ${cell(mib(open.cgroupPeakBytes))} MiB, swap peak ${cell(mib(open.swapPeakBytes))} MiB, oom kills ${cell(open.oomKills)}, ${cell(round1(open.durationMs / 1000))} s`,
          ]
        : []),
      ...failure.semanticOff.map(
        (entry) =>
          `- semantic search turned off: cause ${cell(entry.cause)}, code ${cell(entry.code)}, message "${entry.detail ?? ''}"`,
      ),
    );
  }
  if (extras.recall) {
    lines.push(
      '',
      `Recall of the warm questions: ${extras.recall.topTen}/${extras.recall.total} with the source in the first 10; negative controls unchanged: ${extras.recall.negativesClean}.`,
    );
  }
  return `${lines.join('\n')}\n`;
}

// ---------- the host: /proc and cgroup v2 ----------

/** `VmRSS`, `VmHWM` and `VmSwap` of /proc/<pid>/status in bytes; null for a field that is missing. */
export function parseProcessStatus(text) {
  const bytes = (name) => {
    const match = new RegExp(`^${name}:\\s+(\\d+)\\s*kB`, 'm').exec(text);
    return match ? Number(match[1]) * 1024 : null;
  };
  return { rssBytes: bytes('VmRSS'), hwmBytes: bytes('VmHWM'), swapBytes: bytes('VmSwap') };
}

const TCP_ESTABLISHED = '01';
const TCP_SYN_SENT = '02';

/** Whether an address of /proc/net/tcp (8 hex digits) or tcp6 (32) is this machine's own or unspecified. */
function isLocalAddress(hex) {
  const upper = hex.toUpperCase();
  if (/^0+$/.test(upper)) return true;
  if (upper.length === 8) return upper.slice(6, 8) === '7F';
  if (upper.length === 32) {
    return (
      upper === '00000000000000000000000001000000' ||
      (upper.startsWith('0000000000000000FFFF0000') && upper.slice(30, 32) === '7F')
    );
  }
  return false;
}

/**
 * The number of TCP connections, established or being opened, to a peer that is not this machine, from the text of
 * /proc/net/tcp and /proc/net/tcp6 (one string each). The model is local and the container has no network: a
 * measured run that sees one has tried to leave it.
 */
export function countExternalPeers(...texts) {
  let count = 0;
  for (const text of texts) {
    for (const line of text.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 4) continue;
      const state = fields[3];
      if ((state === TCP_ESTABLISHED || state === TCP_SYN_SENT) && !isLocalAddress(fields[2].split(':')[0]))
        count += 1;
    }
  }
  return count;
}

const readText = (path) => readFileSync(path, 'utf8');

function tryNumber(path) {
  try {
    return numberOrNull(readText(path));
  } catch {
    return null;
  }
}

/**
 * The real Linux host of a measured run, over the cgroup `checkMachine` found. Peaks are per phase where the kernel
 * lets them be reset (`clear_refs` 5 for the process's VmHWM; a written `memory.peak` on kernel 6.12+); where it does
 * not, a phase's peak is the highest of the samples taken every few hundred milliseconds, and the report says so.
 */
export function linuxHost(cgroup) {
  const file = (name) => join(cgroup.directory, name);
  let peakFd = null;
  try {
    peakFd = openSync(file('memory.peak'), 'r+');
  } catch {
    peakFd = null;
  }
  const peakBuffer = Buffer.alloc(64);
  return {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    read: readText,
    exists: existsSync,
    processStatus: (pid) => parseProcessStatus(readText(`/proc/${pid}/status`)),
    resetProcessPeak(pid) {
      try {
        writeFileSync(`/proc/${pid}/clear_refs`, '5');
        return true;
      } catch {
        return false;
      }
    },
    externalPeers() {
      const texts = [];
      for (const path of ['/proc/net/tcp', '/proc/net/tcp6']) {
        try {
          texts.push(readText(path));
        } catch {
          // No IPv6 table in this namespace.
        }
      }
      return countExternalPeers(...texts);
    },
    cgroup: {
      directory: cgroup.directory,
      memoryMax: cgroup.memoryMax,
      stat() {
        return {
          current: tryNumber(file('memory.current')),
          swapCurrent: tryNumber(file('memory.swap.current')),
          oomKill: parseMemoryEvents(readText(file('memory.events'))).oom_kill ?? 0,
        };
      },
      resetPeak() {
        if (peakFd === null) return false;
        try {
          writeSync(peakFd, '0');
          return true;
        } catch {
          return false;
        }
      },
      readPeak() {
        if (peakFd === null) return null;
        try {
          const length = readSync(peakFd, peakBuffer, 0, peakBuffer.length, 0);
          return numberOrNull(peakBuffer.toString('utf8', 0, length));
        } catch {
          return null;
        }
      },
      cpuMax() {
        try {
          return readText(file('cpu.max')).trim();
        } catch {
          return null;
        }
      },
    },
  };
}

// ---------- a measured window ----------

const SAMPLE_MS = 250;
const PROBE_MS = 2000;

/**
 * Opens a window on a running server: forgets the peaks, then samples its memory, the cgroup and the network until
 * `close(name)` returns the phase's record. `searchMs` and `httpMs` are filled by whoever drives load in the window.
 */
export function openWindow({ host, handle, probeFile, databaseFacts }) {
  const pid = handle.pid;
  const processReset = host.resetProcessPeak(pid);
  const cgroupReset = host.cgroup.resetPeak();
  const startedAt = performance.now();
  const startedAtMs = Date.now();
  const begin = host.cgroup.stat();
  const markedAt = databaseFacts.mark();
  const peaks = { rss: 0, cgroup: 0, swap: 0, external: 0 };
  const sample = () => {
    try {
      const status = host.processStatus(pid);
      peaks.rss = Math.max(peaks.rss, status.rssBytes ?? 0);
      peaks.swap = Math.max(peaks.swap, status.swapBytes ?? 0);
    } catch {
      // The process has gone away; the caller's guard reports it.
    }
    try {
      const stat = host.cgroup.stat();
      peaks.cgroup = Math.max(peaks.cgroup, stat.current ?? 0);
      peaks.swap = Math.max(peaks.swap, stat.swapCurrent ?? 0);
      peaks.external = Math.max(peaks.external, host.externalPeers());
    } catch {
      // Unreadable for a moment.
    }
  };
  sample();
  const timer = setInterval(sample, SAMPLE_MS);
  // A window left open by a failed run must not keep the process alive: the report is written after it.
  timer.unref();
  const window = {
    stop: () => clearInterval(timer),
    searchMs: [],
    httpMs: [],
    failures: 0,
    externalPeers: 0,
    peakSources: { process: processReset, cgroup: cgroupReset },
    closed: false,
    close(name) {
      window.closed = true;
      clearInterval(timer);
      sample();
      let hwm = 0;
      if (processReset) {
        try {
          hwm = host.processStatus(pid).hwmBytes ?? 0;
        } catch {
          hwm = 0;
        }
      }
      const end = host.cgroup.stat();
      const cgroupPeak = Math.max(peaks.cgroup, cgroupReset ? (host.cgroup.readPeak() ?? 0) : 0);
      const rssPeak = Math.max(peaks.rss, hwm);
      window.externalPeers = peaks.external;
      const statuses = databaseFacts.statusesSince(markedAt);
      const searches = [...statuses.values()].reduce((sum, count) => sum + count, 0);
      const loop = readProbeLines(probeFile)
        .filter((line) => Date.parse(line.t) >= startedAtMs && typeof line.eventLoopP95Ms === 'number')
        .map((line) => line.eventLoopP95Ms);
      const search = latencySummary(window.searchMs);
      return phaseRecord({
        name,
        durationMs: Math.round(performance.now() - startedAt),
        rssPeakBytes: rssPeak > 0 ? rssPeak : null,
        cgroupPeakBytes: cgroupPeak > 0 ? cgroupPeak : null,
        swapPeakBytes: peaks.swap,
        oomKills: Number.isFinite(end.oomKill - begin.oomKill) ? end.oomKill - begin.oomKill : null,
        semanticUsed: searches === 0 ? 0 : Math.round(((statuses.get('used') ?? 0) / searches) * 1000) / 1000,
        searchP50Ms: search.p50,
        searchP95Ms: search.p95,
        searchMaxMs: search.max,
        httpP95Ms: latencySummary(window.httpMs).p95,
        eventLoopP95Ms: loop.length === 0 ? null : Math.max(...loop),
      });
    },
  };
  return window;
}

// ---------- the server process ----------

export class MeasurementError extends Error {}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

/** Spawns the server bundle; `done` settles when it ends, whatever the cause. */
export function startServer({ nodeArgs, env, logFile }) {
  const logFd = openSync(logFile, 'a', 0o600);
  const child = spawn(process.execPath, nodeArgs, { env, stdio: ['ignore', logFd, logFd] });
  closeSync(logFd);
  const handle = { child, pid: child.pid, exited: false, exit: 'running', logFile };
  handle.done = new Promise((settle) => {
    child.once('exit', (code, signal) => {
      handle.exited = true;
      handle.exit = signal ? `signal ${signal}` : `code ${code}`;
      settle();
    });
    child.once('error', (error) => {
      handle.exited = true;
      handle.exit = `could not start: ${error.code ?? 'error'}`;
      settle();
    });
  });
  return handle;
}

export async function stopServer(handle, signal = 'SIGTERM') {
  if (handle.exited) return;
  handle.child.kill(signal);
  const killer = setTimeout(() => handle.child.kill('SIGKILL'), 60_000);
  await handle.done;
  clearTimeout(killer);
}

// ---------- HTTP ----------

async function request(base, { method = 'GET', path, cookie, headers = {}, body, timeoutMs = 30_000 }) {
  const started = performance.now();
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return {
    status: response.status,
    json,
    ms: performance.now() - started,
    setCookies: response.headers.getSetCookie?.() ?? [],
  };
}

const SESSION_COOKIE = 'pm_session';

export function sessionCookieOf(setCookies) {
  for (const entry of setCookies) {
    const match = new RegExp(`^${SESSION_COOKIE}=([^;]+)`).exec(entry);
    if (match) return `${SESSION_COOKIE}=${match[1]}`;
  }
  return null;
}

const expectStatus = (response, ok, what) => {
  if (!ok.includes(response.status)) {
    // The server's error code is a fixed word (`project_exists`), never history text.
    const code = response.json?.error?.code;
    throw new MeasurementError(
      `${what} answered ${response.status}${typeof code === 'string' && /^[a-z_]{1,64}$/.test(code) ? ` (${code})` : ''}`,
    );
  }
  return response;
};

/** The factory template of the synthetic project (the template list route is gone). */
const PROFILE_TEMPLATE_ID = 'starter';

/**
 * The synthetic login: the first run's setup makes the owner, a project from the `starter` template
 * and its workspace folder; later runs log in again. The e-mail is not a real address and the password lives only in
 * this process. Returns the session cookie, the owner's handle in the project and the first stage.
 */
async function establish(state, srv, { create }) {
  const base = srv.base;
  const { credentials, projectKey } = state;
  let cookie;
  if (create) {
    const setup = expectStatus(
      await request(base, {
        method: 'POST',
        path: LOAD_ROUTES.setupStatus,
        body: { name: 'Profile', ...credentials },
      }),
      [201],
      'the setup',
    );
    cookie = sessionCookieOf(setup.setCookies);
  } else {
    const login = expectStatus(
      await request(base, { method: 'POST', path: LOAD_ROUTES.login, body: credentials }),
      [200],
      'the login',
    );
    cookie = sessionCookieOf(login.setCookies);
  }
  if (!cookie) throw new MeasurementError('the login gave no session');
  if (create) {
    expectStatus(
      await request(base, {
        method: 'POST',
        path: LOAD_ROUTES.projects,
        cookie,
        body: {
          key: projectKey,
          name: 'History semantic profile',
          workspacePath: state.workspace,
          templateId: PROFILE_TEMPLATE_ID,
        },
      }),
      [201],
      'the project creation',
    );
  }
  const me = expectStatus(
    await request(base, { path: LOAD_ROUTES.me, cookie }),
    [200],
    'the profile of the login',
  ).json;
  const handle = me?.handles?.[projectKey];
  if (typeof handle !== 'string') throw new MeasurementError('the login is no member of the project');
  const board = expectStatus(
    await request(base, { path: LOAD_ROUTES.board.replace(':key', projectKey), cookie }),
    [200],
    'the board',
  ).json;
  const stageId = board?.stages?.[0]?.id;
  if (typeof stageId !== 'string') throw new MeasurementError('the project has no stage');
  srv.cookie = cookie;
  state.handle = handle;
  state.stageId = stageId;
}

/** One search through the measurement entry's loopback listener; no text is kept, only the source ids. */
async function profileSearch(state, srv, query) {
  try {
    const response = await request(srv.controlBase, {
      method: 'POST',
      path: '/search',
      headers: { 'x-profile-secret': srv.secret },
      body: { projectKey: state.projectKey, handle: state.handle, query },
    });
    const hits = Array.isArray(response.json?.hits) ? response.json.hits : [];
    return { ms: response.ms, ok: response.status === 200 && Array.isArray(response.json?.hits), hits };
  } catch {
    return { ms: 30_000, ok: false, hits: [] };
  }
}

// ---------- the disposable database ----------

function withDatabase(state, home, body) {
  const Database = state.require('better-sqlite3');
  const db = new Database(join(home, 'db.sqlite'));
  try {
    db.pragma('busy_timeout = 5000');
    return body(db);
  } finally {
    db.close();
  }
}

const count = (db, sql, ...params) => db.prepare(sql).get(...params).n;

/** What the measurement reads of the index; a window uses `mark` and `statusesSince` for the share of semantic searches. */
function databaseFactsOf(state, home) {
  return {
    mark: () =>
      withDatabase(state, home, (db) =>
        count(db, 'SELECT COALESCE(MAX(rowid), 0) AS n FROM history_searches'),
      ),
    statusesSince: (mark) =>
      withDatabase(state, home, (db) => {
        const counts = new Map();
        for (const row of db
          .prepare(
            'SELECT semantic_status AS status, COUNT(*) AS n FROM history_searches WHERE rowid > ? GROUP BY 1',
          )
          .all(mark)) {
          counts.set(row.status, row.n);
        }
        return counts;
      }),
    index: (expectedIds = []) =>
      withDatabase(state, home, (db) => {
        const stateRow = db
          .prepare('SELECT index_key AS indexKey, complete FROM history_semantic_state WHERE project_key = ?')
          .get(state.projectKey);
        const present = db.prepare('SELECT 1 AS n FROM history_documents WHERE source_id = ?');
        return {
          textDirty: count(db, 'SELECT COUNT(*) AS n FROM history_dirty'),
          semanticDirty: count(db, 'SELECT COUNT(*) AS n FROM history_semantic_dirty'),
          semanticComplete: stateRow?.complete === 1,
          indexKey: stateRow?.indexKey ?? null,
          chunks: count(db, 'SELECT COUNT(*) AS n FROM history_semantic_chunks'),
          allPresent: expectedIds.every((id) => present.get(id) !== undefined),
        };
      }),
  };
}

function seedFixture(state, home, sources, idPrefix) {
  return withDatabase(state, home, (db) => {
    const firstSeq = count(
      db,
      'SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM tasks WHERE project_key = ?',
      state.projectKey,
    );
    return seedSources(db, {
      projectKey: state.projectKey,
      stageId: state.stageId,
      sources,
      idPrefix,
      firstSeq,
      at: new Date().toISOString(),
    });
  });
}

/** `size` new cards, notes, questions and messages: the fixture's own text again with a mark, so each is new to the index. */
function churnSources(state, size) {
  const pool = state.fixture.sources.filter((source) => source.type !== 'document');
  const batch = (state.churnBatches += 1);
  const sources = [];
  for (let i = 0; i < size; i += 1) {
    const source = pool[(state.churnCursor + i) % pool.length];
    sources.push({ ...source, id: `c${i}`, body: `${source.body}\n\nchurn ${batch}.${i}` });
  }
  state.churnCursor += size;
  return { sources, idPrefix: `ch${batch}` };
}

// ---------- driving load ----------

const CONTROL_WORKERS = 3;
const CONTROL_PAUSE_MS = 250;
const SEARCH_PERIOD_MS = 2000;
const CHURN_PERIOD_MS = 10_000;
const CHURN_BATCH = 3;
const BURST_SIZE = 150;
const WARM_PASSES = 3;

/** The waits and the baseline's length; a test shortens them, a real run keeps these. */
export const DEFAULT_TIMING = {
  baselineSeconds: MIN_BASELINE_SECONDS,
  readyMs: 300_000,
  backfillMs: 3_600_000,
};

export const PROGRESS_MS = 30_000;

/**
 * Polls `check` until it is truthy. A `MeasurementError` thrown by `check` ends the wait (a known, final cause);
 * any other error is a poll that failed and is tried again. `progress(what, seconds)` is called about every
 * `PROGRESS_MS`.
 */
async function waitUntil(srv, what, check, { timeoutMs, pollMs = 500, progress = null }) {
  const startedAt = performance.now();
  const deadline = startedAt + timeoutMs;
  let progressAt = startedAt;
  for (;;) {
    if (srv.handle.exited)
      throw new MeasurementError(`the server ended while waiting for ${what} (${srv.handle.exit})`);
    let value = false;
    try {
      value = await check();
    } catch (error) {
      if (error instanceof MeasurementError) throw error;
      value = false;
    }
    if (value) return value;
    const now = performance.now();
    if (now > deadline) throw new MeasurementError(`timed out waiting for ${what}`);
    if (progress && now - progressAt >= PROGRESS_MS) {
      progressAt = now;
      try {
        progress(what, Math.round((now - startedAt) / 1000));
      } catch {
        // A progress line is never worth a failed measurement.
      }
    }
    await sleep(pollMs);
  }
}

/** Free text of an error, cut to the characters of a technical message; paths and codes pass, nothing else. */
export function safeDetail(value, limit = 200) {
  return String(value ?? '')
    .replace(/[^A-Za-z0-9 _.,:;()/'=-]/g, '?')
    .slice(0, limit);
}

/**
 * What the server's log (JSON lines) says of the semantic search: the index key of its "ready" line and the
 * warnings that turned it off, oldest first, each as { cause, code, detail } (technical codes and a short message).
 */
export function readSemanticLog(text) {
  let indexKey = null;
  const off = [];
  for (const line of text.split('\n')) {
    const ready = line.includes('the semantic history search is ready');
    if (!ready && !line.includes('the semantic history search is off for now')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry)) continue;
    if (ready) {
      if (typeof entry.indexKey === 'string') indexKey = entry.indexKey;
      continue;
    }
    const err = isRecord(entry.err) ? entry.err : {};
    const code = err.code ?? entry.code;
    off.push({
      cause: /^[a-z_:]{1,40}$/.test(entry.cause ?? '') ? entry.cause : null,
      code: /^[A-Z][A-Z0-9_]{1,60}$/.test(code ?? '') ? code : null,
      detail: safeDetail(entry.message ?? err.message),
    });
  }
  return { indexKey, off };
}

const describeOff = (entry) =>
  [entry.cause, entry.code, entry.detail ? `"${entry.detail}"` : null].filter(Boolean).join(' ');

/** Throws when the server's log says the semantic search turned itself off: nothing will bring it back by waiting. */
function guardSemantic(srv) {
  const { off } = readSemanticLog(readText(srv.handle.logFile));
  if (off.length > 0)
    throw new MeasurementError(`the semantic search turned itself off (${describeOff(off[0])})`);
}

/** The line a long wait prints about every 30 s: the server's memory and, when `facts` is given, the index progress. */
function progressOf(state, srv, facts = null) {
  return (what, seconds) => {
    let rss = null;
    try {
      rss = state.host.processStatus(srv.handle.pid).rssBytes;
    } catch {
      // The process has gone away; the wait's own guard reports it.
    }
    const stat = state.host.cgroup.stat();
    let index = '';
    if (facts) {
      const found = facts.index();
      index = `; chunks ${found.chunks}, text dirty ${found.textDirty}, semantic dirty ${found.semanticDirty}`;
    }
    state.log(
      `${srv.label}: waiting for ${what}, ${seconds} s; rss ${cell(mib(rss))} MiB, cgroup ${cell(mib(stat.current))} MiB, oom kills ${stat.oomKill}${index}`,
    );
  };
}

/** The server is ready when it answers HTTP, its measurement listener answers and, for the semantic run, the worker is ready. */
async function waitReady(state, srv, { semantic }) {
  const progress = progressOf(state, srv, semantic ? databaseFactsOf(state, srv.home) : null);
  await waitUntil(
    srv,
    'the HTTP port',
    async () => (await request(srv.base, { path: LOAD_ROUTES.setupStatus })).status === 200,
    { timeoutMs: state.timing.readyMs, progress },
  );
  await waitUntil(
    srv,
    'the search listener',
    async () =>
      (await request(srv.controlBase, { method: 'POST', path: '/search', body: {} })).status === 401,
    { timeoutMs: state.timing.readyMs, progress },
  );
  if (!semantic) return null;
  return waitUntil(
    srv,
    'the semantic search to be ready',
    () => {
      const seen = readSemanticLog(readText(srv.handle.logFile));
      if (seen.indexKey !== null) return seen.indexKey;
      if (seen.off.length > 0)
        throw new MeasurementError(`the semantic search turned itself off (${describeOff(seen.off[0])})`);
      return false;
    },
    { timeoutMs: state.timing.readyMs, progress },
  );
}

/** The control requests of one loop: the web app's reads, one after the other with a short pause. */
function controlPaths(projectKey) {
  return ['me', 'projects', 'board', 'tasks', 'inbox', 'teamThreads', 'involvements'].map((name) =>
    LOAD_ROUTES[name].replace(':key', projectKey),
  );
}

/**
 * Drives `durationMs` of the mixed load on one server: web reads in parallel loops, one search every two seconds
 * and a trickle of new cards for the indexers. The same load runs in the baseline, the mixed and the off-again phases.
 */
async function driveLoad(state, srv, win, durationMs) {
  const end = performance.now() + durationMs;
  const live = () => performance.now() < end && !srv.handle.exited;
  const paths = controlPaths(state.projectKey);
  const queries = [
    ...state.fixture.questions.map((q) => q.question),
    ...state.fixture.negatives.map((n) => n.question),
  ];
  const loops = [];
  for (let worker = 0; worker < CONTROL_WORKERS; worker += 1) {
    loops.push(
      (async () => {
        let next = worker;
        while (live()) {
          try {
            const response = await request(srv.base, {
              path: paths[next % paths.length],
              cookie: srv.cookie,
            });
            win.httpMs.push(response.ms);
            if (response.status >= 500) win.failures += 1;
          } catch {
            win.httpMs.push(30_000);
            win.failures += 1;
          }
          next += 1;
          await sleep(CONTROL_PAUSE_MS);
        }
      })(),
    );
  }
  loops.push(
    (async () => {
      let next = 0;
      while (live()) {
        const result = await profileSearch(state, srv, queries[next % queries.length]);
        next += 1;
        win.searchMs.push(result.ms);
        if (!result.ok) win.failures += 1;
        await sleep(SEARCH_PERIOD_MS);
      }
    })(),
  );
  loops.push(
    (async () => {
      while (live()) {
        await sleep(CHURN_PERIOD_MS);
        if (!live()) break;
        const { sources, idPrefix } = churnSources(state, CHURN_BATCH);
        seedFixture(state, srv.home, sources, idPrefix);
      }
    })(),
  );
  await Promise.all(loops);
  if (srv.handle.exited) throw new MeasurementError(`the server ended during the load (${srv.handle.exit})`);
}

/** The reworded questions and the negative controls, one after the other; returns the recall of this pass. */
async function questionPass(state, srv, win) {
  let topTen = 0;
  for (const item of state.fixture.questions) {
    const result = await profileSearch(state, srv, item.question);
    win.searchMs.push(result.ms);
    if (!result.ok) win.failures += 1;
    if (result.hits.slice(0, 10).some((hit) => state.fixtureIdOf.get(hit.sourceId) === item.targetId))
      topTen += 1;
  }
  let negativesClean = true;
  for (const item of state.fixture.negatives) {
    const result = await profileSearch(state, srv, item.question);
    win.searchMs.push(result.ms);
    if (!result.ok) win.failures += 1;
    // A control must stay as the words alone left it: nothing may get on its list by meaning alone.
    if (result.hits.some((hit) => hit.matchType === 'semantic')) negativesClean = false;
  }
  return { topTen, total: state.fixture.questions.length, negativesClean };
}

// ---------- the run ----------

const DEFAULT_HEAP_LIMIT_MB = 256;

function heapLimitOf(env) {
  const value = Number(env.PROJECTMAN_HEAP_LIMIT_MB);
  return Number.isInteger(value) && value >= 128 && value <= 4096 ? value : DEFAULT_HEAP_LIMIT_MB;
}

async function launch(state, { label, semantic, home, mode = 'cloud' }) {
  if (state.deadlineExceeded)
    throw new MeasurementError('the run deadline passed before this server started');
  const port = await freePort();
  const controlPort = await freePort();
  const runOut = join(state.options.out, label);
  mkdirSync(runOut, { recursive: true, mode: 0o700 });
  const probeFile = join(runOut, 'probe.jsonl');
  const secret = randomBytes(24).toString('base64url');
  const flags = {
    server: state.options.server,
    home,
    port,
    out: runOut,
    probeMs: PROBE_MS,
    heapLimitMb: state.heapLimitMb,
    env: new Map([
      ['HOME', join(state.options.out, 'user-home')],
      ['TMPDIR', join(state.options.out, 'tmp')],
      ['PROJECTMAN_MODE', mode],
      ['PM_MEMORY_PROBE_FILE', probeFile],
      ['PROJECTMAN_HISTORY_SEMANTIC', semantic ? 'on' : 'off'],
      ['PROJECTMAN_HISTORY_MODEL_DIR', state.options.modelDir],
      ['PROJECTMAN_HISTORY_PROFILE_PORT', String(controlPort)],
      ['PROJECTMAN_HISTORY_PROFILE_SECRET', secret],
      ['HF_HUB_OFFLINE', '1'],
      ['TRANSFORMERS_OFFLINE', '1'],
    ]),
  };
  const handle = startServer({
    nodeArgs: buildNodeArgs(flags),
    env: buildServerEnv(flags, state.parentEnv),
    logFile: join(runOut, 'server.log'),
  });
  const srv = {
    label,
    semantic,
    home,
    secret,
    probeFile,
    handle,
    cookie: null,
    base: `http://127.0.0.1:${port}`,
    controlBase: `http://127.0.0.1:${controlPort}`,
  };
  state.current = srv;
  return srv;
}

/**
 * The technical facts of a failed run, read while the failed server is still in hand: where it stopped, how the
 * server ended (`running`, `code N`, `signal S`), why the semantic search was off, the container's cumulative OOM
 * kills and memory, the index progress and what the open phase had measured. Numbers and technical codes; the only
 * text is the run's own error line and the server's short messages, cut to technical characters (`safeDetail`).
 */
export function collectFailure(state, srv, error) {
  const attempt = (read) => {
    try {
      return read();
    } catch {
      return null;
    }
  };
  const stat = attempt(() => state.host.cgroup.stat());
  const open = state.windows.filter((win) => !win.closed).at(-1);
  return {
    step: srv?.label ?? null,
    error: safeDetail(error instanceof Error ? error.message : error, 300),
    serverExit: srv?.handle.exit ?? null,
    deadlineExceeded: state.deadlineExceeded,
    elapsedSeconds: Math.round((performance.now() - state.startedAt) / 1000),
    semanticOff: srv?.semantic
      ? (attempt(() => readSemanticLog(readText(srv.handle.logFile)).off.slice(0, 3)) ?? [])
      : [],
    cgroup: stat
      ? {
          memoryCurrentBytes: stat.current,
          swapCurrentBytes: stat.swapCurrent,
          oomKillsTotal: stat.oomKill,
        }
      : null,
    index: srv
      ? attempt(() => {
          const { chunks, textDirty, semanticDirty, semanticComplete } = databaseFactsOf(
            state,
            srv.home,
          ).index();
          return { chunks, textDirty, semanticDirty, semanticComplete };
        })
      : null,
    openPhase: open ? attempt(() => open.close('failed')) : null,
  };
}

/** Starts a server, runs `body(srv)` and always stops it (unless the body ended it). */
async function withServer(state, spec, body) {
  const srv = await launch(state, spec);
  try {
    return await body(srv);
  } catch (error) {
    // The facts of a failure are read before the server is stopped; the first failure is the one that counts.
    state.failure ??= collectFailure(state, srv, error);
    throw error;
  } finally {
    await stopServer(srv.handle);
    state.current = null;
  }
}

function openWindowOn(state, srv) {
  const win = openWindow({
    host: state.host,
    handle: srv.handle,
    probeFile: srv.probeFile,
    databaseFacts: databaseFactsOf(state, srv.home),
  });
  state.windows.push(win);
  return win;
}

/** Closes a window and keeps the phase at once, so a later failure still reports what was measured. */
function closePhase(state, win, name) {
  const phase = win.close(name);
  state.phases.push(phase);
  state.networkPeers = Math.max(state.networkPeers, win.externalPeers);
  if (win.failures > 0) state.failed = true;
  state.peakSources = win.peakSources;
  state.log(
    `phase ${name}: ${Math.round(phase.durationMs / 1000)} s, rss peak ${Math.round((phase.rssPeakBytes ?? 0) / MIB)} MiB`,
  );
  return phase;
}

/**
 * Stage 0 (no phase): a server without the embedding makes the owner and the project, seeds the fixture and indexes
 * its words. It runs in the single-machine mode: a cloud server makes a project only through a connected engine, and
 * this stage measures nothing; every measured run is a cloud server over the home it leaves.
 */
async function prepareHome(state) {
  await withServer(
    state,
    { label: 'prepare', semantic: false, home: state.homeOn, mode: 'single' },
    async (srv) => {
      await waitReady(state, srv, { semantic: false });
      await establish(state, srv, { create: true });
      const seeded = seedFixture(state, state.homeOn, state.fixture.sources, 'fx');
      state.fixtureIdOf = new Map();
      const expected = [];
      for (const [fixtureId, placed] of seeded.placed) {
        const sourceId = historySourceId(state.projectKey, placed.type, placed.entityId);
        state.fixtureIdOf.set(sourceId, fixtureId);
        expected.push(sourceId);
      }
      const facts = databaseFactsOf(state, state.homeOn);
      await waitUntil(
        srv,
        'the text index of the fixture',
        () => {
          const index = facts.index(expected);
          return index.allPresent && index.textDirty === 0;
        },
        { timeoutMs: state.timing.backfillMs, progress: progressOf(state, srv, facts) },
      );
    },
  );
  // Both runs start from the same indexed database, so the baseline and the embedding differ in nothing else.
  cpSync(state.homeOn, state.homeOff, { recursive: true });
}

async function measureOff(state, label, name, home, seconds) {
  return withServer(state, { label, semantic: false, home }, async (srv) => {
    const win = openWindowOn(state, srv);
    await waitReady(state, srv, { semantic: false });
    await establish(state, srv, { create: false });
    await driveLoad(state, srv, win, seconds * 1000);
    return closePhase(state, win, name);
  });
}

async function measureSemantic(state) {
  await withServer(state, { label: 'on', semantic: true, home: state.homeOn }, async (srv) => {
    const cold = openWindowOn(state, srv);
    state.modelIndexKey = await waitReady(state, srv, { semantic: true });
    await establish(state, srv, { create: false });
    closePhase(state, cold, 'cold_load');

    const facts = databaseFactsOf(state, srv.home);
    // A semantic search that turned itself off does not come back while nobody searches: stop waiting for it.
    const complete = () => {
      guardSemantic(srv);
      const index = facts.index();
      return index.semanticComplete && index.semanticDirty === 0 && index.textDirty === 0;
    };
    const backfill = openWindowOn(state, srv);
    await waitUntil(srv, 'the semantic backfill', complete, {
      timeoutMs: state.timing.backfillMs,
      progress: progressOf(state, srv, facts),
    });
    closePhase(state, backfill, 'backfill');
    state.chunks = facts.index().chunks;

    const warm = openWindowOn(state, srv);
    for (let pass = 0; pass < WARM_PASSES; pass += 1) {
      const result = await questionPass(state, srv, warm);
      if (pass === 0) state.recall = result;
    }
    closePhase(state, warm, 'warm');

    const mixed = openWindowOn(state, srv);
    await driveLoad(state, srv, mixed, state.options.mixedSeconds * 1000);
    closePhase(state, mixed, 'mixed');

    // Interrupt the indexing: a burst of new text, and the process is killed while the embedding is still at it.
    const before = facts.index().chunks;
    const burst = churnSources(state, BURST_SIZE);
    seedFixture(state, srv.home, burst.sources, burst.idPrefix);
    state.restartInterrupted = false;
    const started = performance.now();
    while (!srv.handle.exited && performance.now() - started < 300_000) {
      const index = facts.index();
      if (index.textDirty === 0 && index.semanticDirty > 0 && index.chunks > before) {
        state.restartInterrupted = true;
        break;
      }
      if (index.textDirty === 0 && index.semanticDirty === 0) break;
      await sleep(100);
    }
    await stopServer(srv.handle, 'SIGKILL');
  });

  await withServer(state, { label: 'restart', semantic: true, home: state.homeOn }, async (srv) => {
    const win = openWindowOn(state, srv);
    await waitReady(state, srv, { semantic: true });
    await establish(state, srv, { create: false });
    const facts = databaseFactsOf(state, srv.home);
    await waitUntil(
      srv,
      'the semantic index after the restart',
      () => {
        guardSemantic(srv);
        const index = facts.index();
        return index.semanticComplete && index.semanticDirty === 0 && index.textDirty === 0;
      },
      { timeoutMs: state.timing.backfillMs, progress: progressOf(state, srv, facts) },
    );
    await questionPass(state, srv, win);
    closePhase(state, win, 'restart');
  });
}

/**
 * Runs the whole measurement and returns the report. `host` is the machine (`linuxHost` for a real run, a fake in
 * the tests); `fixture` is validated; `options.out` is prepared. Nothing here throws for a failed run: the verdict
 * carries `server_failed` and the phases that were measured.
 */
export async function runProfile({
  options,
  fixture,
  host,
  log = () => {},
  parentEnv = process.env,
  timing = {},
}) {
  const out = options.out;
  const startedAt = performance.now();
  const state = {
    startedAt,
    phases: [],
    windows: [],
    recall: null,
    failure: null,
    deadlineExceeded: false,
    options,
    fixture,
    host,
    log,
    parentEnv,
    timing: { ...DEFAULT_TIMING, ...timing },
    projectKey: fixture.project.key,
    credentials: { email: 'profile@example.invalid', password: randomBytes(18).toString('base64url') },
    workspace: join(out, 'workspace'),
    homeOn: join(out, 'home'),
    homeOff: join(out, 'home-off'),
    heapLimitMb: heapLimitOf(parentEnv),
    require: createRequire(options.server),
    churnBatches: 0,
    churnCursor: 0,
    networkPeers: 0,
    failed: false,
    modelIndexKey: null,
    chunks: 0,
    restartInterrupted: null,
    peakSources: null,
    current: null,
    fixtureIdOf: new Map(),
  };
  for (const folder of [state.workspace, state.homeOn, join(out, 'user-home'), join(out, 'tmp')])
    mkdirSync(folder, { recursive: true, mode: 0o700 });
  const onSignal = () => {
    if (state.current) state.current.handle.child.kill('SIGTERM');
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  // The run's own deadline: it ends the server in hand, the run falls through to its report, and the container
  // is never cut off from outside with nothing written.
  const deadline =
    options.maxSeconds > 0
      ? setTimeout(() => {
          state.deadlineExceeded = true;
          state.current?.handle.child.kill('SIGKILL');
        }, options.maxSeconds * 1000)
      : null;
  deadline?.unref();

  let serverFailed = false;
  try {
    await prepareHome(state);
    await measureOff(state, 'off', 'off', state.homeOff, state.timing.baselineSeconds);
    await measureSemantic(state);
    await measureOff(state, 'off-again', 'off_again', state.homeOn, state.timing.baselineSeconds);
  } catch (error) {
    serverFailed = true;
    state.failure ??= collectFailure(state, null, error);
    log(`the run stopped: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (deadline) clearTimeout(deadline);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    for (const win of state.windows) win.stop();
    if (state.current) await stopServer(state.current.handle);
  }

  const { recall } = state;
  const ordered = PHASE_NAMES.map((name) => state.phases.find((phase) => phase.name === name)).filter(
    Boolean,
  );
  const extraRssBytes = extraRssOf(ordered);
  const memoryLimitBytes = host.cgroup.memoryMax;
  const verdict = evaluate({
    phases: ordered,
    extraRssBytes,
    recall,
    memoryLimitBytes,
    swapLimitBytes: 0,
    networkAttempts: state.networkPeers,
    restartInterrupted: state.restartInterrupted,
    serverFailed: serverFailed || state.failed,
    deadlineExceeded: state.deadlineExceeded,
  });
  const report = buildReport({
    sourceVersion: /^[0-9A-Za-z._-]{1,64}$/.test(parentEnv.PROJECTMAN_VERSION ?? '')
      ? parentEnv.PROJECTMAN_VERSION
      : null,
    imageDigest: /^sha256:[0-9a-f]{64}$/.test(parentEnv.PROJECTMAN_IMAGE_DIGEST ?? '')
      ? parentEnv.PROJECTMAN_IMAGE_DIGEST
      : null,
    platform: host.platform,
    arch: host.arch,
    nodeVersion: host.nodeVersion,
    modelIndexKey: state.modelIndexKey,
    memoryLimitBytes,
    swapLimitBytes: 0,
    corpus: corpusOf(fixture, state.chunks),
    phases: ordered,
    extraRssBytes,
    outcome: verdict.outcome,
    reasonCodes: verdict.reasonCodes,
    failure: state.failure ?? undefined,
  });
  const extras = {
    versions: `heap limit ${state.heapLimitMb} MiB; probe ${PROBE_MS} ms; peaks per phase: process ${state.peakSources?.process ? 'reset' : 'sampled'}, cgroup ${state.peakSources?.cgroup ? 'reset' : 'sampled'}; interrupted indexing before the restart: ${state.restartInterrupted}`,
    cpuLimit: host.cgroup.cpuMax?.() ?? null,
    manifestSha256: manifestDigest(options.modelDir),
    recall: recall ?? undefined,
  };
  return { report, extras };
}

// ---------- the command ----------

function writeReports(out, report, extras) {
  writeFileSync(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(join(out, 'report.md'), renderMarkdown(report, extras), { mode: 0o600 });
}

/**
 * The command. `deps` is for the tests: `machine` replaces the platform check's inputs, `makeHost` the real host.
 * Returns the exit code.
 */
export async function main(argv, deps = {}) {
  let options;
  let fixture;
  try {
    options = parseArgs(argv);
    if (options.help) {
      process.stdout.write(`${USAGE}\n`);
      return EXIT_OK;
    }
    fixture = prepareRun(options);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`history-semantic-profile: ${error.message}\n${USAGE}\n`);
      return EXIT_REFUSED;
    }
    throw error;
  }
  const machine = deps.machine ?? {
    platform: process.platform,
    arch: process.arch,
    read: readText,
    exists: existsSync,
  };
  const found = checkMachine({ ...machine, modelDir: options.modelDir });
  if (found.reasons.length > 0) {
    const report = buildReport({
      sourceVersion: null,
      imageDigest: null,
      platform: machine.platform,
      arch: machine.arch,
      nodeVersion: process.version,
      modelIndexKey: null,
      memoryLimitBytes: found.cgroup?.memoryMax ?? null,
      swapLimitBytes: 0,
      corpus: corpusOf(fixture, 0),
      phases: [],
      extraRssBytes: null,
      outcome: 'unsupported',
      reasonCodes: REASON_CODES.filter((code) => found.reasons.includes(code)),
    });
    writeReports(options.out, report, {});
    process.stderr.write(
      `history-semantic-profile: unsupported here (${report.reasonCodes.join(', ')}); nothing was measured\n`,
    );
    return EXIT_UNSUPPORTED;
  }
  const host = (deps.makeHost ?? linuxHost)(found.cgroup);
  const { report, extras } = await runProfile({
    options,
    fixture,
    host,
    log: (line) => process.stderr.write(`${line}\n`),
  });
  writeReports(options.out, report, extras);
  process.stderr.write(
    `history-semantic-profile: ${report.outcome}${report.reasonCodes.length ? ` (${report.reasonCodes.join(', ')})` : ''}\n`,
  );
  return report.outcome === 'pass' ? EXIT_OK : EXIT_FAILED;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // The report is written (synchronously) before main returns; nothing a failed run left open may keep the
  // container waiting for a report that is already on disk.
  process.exit(await main(process.argv.slice(2)));
}
