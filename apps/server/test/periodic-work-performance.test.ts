import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { LOCAL_ENGINE_ID, MessageKind, TaskDeveloperLevel } from '@projectman/shared';
import type { ProjectConfig, Task, TeamMessage } from '@projectman/shared';
import { describe, expect, it } from 'vitest';
import { migrate, migrations } from '../src/db';
import { createDomainHarness, OWNER } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';

// PM-733: keep this generator and protocol unchanged across all three optimization slices.
// Full measurements are opt-in, in the heavy queue, never part of the normal merge suite:
// npm run heavy -- env PROJECTMAN_PERIODIC_BENCHMARK=1 npm run test -w @projectman/server -- test/periodic-work-performance.test.ts
const ORIGINAL_SOURCE = 'cc534b5589aa215dd1c6dcc1ad6363383c09ed61';
const NOW = '2026-10-17T08:00:00.000Z';
const OLD = '2026-09-01T08:00:00.000Z';
const PROJECTS = ['AR', 'BR'];
const EXTRA_HANDLES = Array.from({ length: 7 }, (_, i) => `worker-${i}`);
const HANDLES = ['dev-1', 'dev-2', 'cr', 'pm', 'operator', ...EXTRA_HANDLES];
const RUN_BENCHMARK = process.env.PROJECTMAN_PERIODIC_BENCHMARK === '1';

function random(seed = 733) {
  let state = seed;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function* messages(history: number, active: boolean): Generator<TeamMessage> {
  const next = random();
  const activeNext = random();
  for (let i = 0; i < history + (active ? 20 : 0); i++) {
    const pending = i >= history;
    const n = pending ? i - history : i;
    const projectKey = PROJECTS[n % 2]!;
    const handle = HANDLES[Math.floor((pending ? activeNext() : next()) * HANDLES.length)]!;
    yield {
      id: `msg_perf_${pending ? 'pending' : 'old'}_${n}`,
      projectKey,
      from: 'owner',
      to: [handle, 'owner'],
      taskKey: null,
      body: `Fictional message ${n}: ${'synthetic context '.repeat(8)}`,
      kind: n % 2 ? 'info' : 'action',
      createdAt: pending ? NOW : OLD,
      deliveredAt: pending ? null : OLD,
      version: { stageId: 'development', commit: null, reviewCommit: null },
      receipts: [
        { handle, kind: 'ai', deliveredAt: pending ? null : OLD, readAt: null },
        { handle: 'owner', kind: 'human', deliveredAt: pending ? NOW : OLD, readAt: null },
      ],
    };
  }
}

function* tasks(history: number, active: boolean): Generator<Task> {
  for (const projectKey of PROJECTS) {
    for (let i = 1; i <= history / 2 + (active ? 10 : 0); i++) {
      const open = i > history / 2;
      // Each old family has a parent and four children. Active keys stay fixed at every scale.
      const seq = open ? 1_000_000 + i - history / 2 : i;
      const key = `${projectKey}-${seq}`;
      yield {
        id: `task_perf_${key}`,
        key,
        projectKey,
        title: `Fictional card ${seq}`,
        description: 'Synthetic periodic work fixture',
        stageId: open ? 'backlog' : 'done',
        status: open ? 'active' : 'done',
        assignee: null,
        repo: 'web',
        priority: null,
        labels: [],
        links: [{ kind: 'branch', ref: `fixture/${seq}`, repo: 'web' }],
        parentKey: !open && (i - 1) % 5 ? `${projectKey}-${i - ((i - 1) % 5)}` : null,
        visibility: 'internal',
        createdBy: 'owner',
        createdAt: open ? NOW : OLD,
        updatedAt: open ? NOW : OLD,
        closedAt: open ? null : OLD,
      };
    }
  }
}

function configure(config: ProjectConfig) {
  // Preserve the template's fixed Operator and other required roles: twelve AI members per project.
  const defaults = config.team.members.find((m) => m.kind === 'ai')!;
  config.team.members.push(
    ...EXTRA_HANDLES.map((handle, i) => ({
      ...defaults,
      kind: 'ai' as const,
      handle,
      displayName: `Synthetic worker ${i}`,
      sponsor: 'owner',
      role: 'developer',
    })),
  );
  config.pipeline.stages.find((s) => s.id === 'development')!.owners = ['dev-1', 'dev-2', ...EXTRA_HANDLES];
}

async function fixture(historyMessages: number, historyTasks: number, active: boolean) {
  const startupStart = performance.now();
  const h = await createDomainHarness({ adjust: configure, now: () => new Date(NOW) });
  try {
    await h.domain.projects.create(
      { key: 'BR', name: 'Synthetic second project', workspacePath: h.workspace, templateId: 'test' },
      OWNER,
    );
    await h.domain.projects.update(
      'BR',
      { actor: { kind: 'human', handle: 'owner' }, author: OWNER },
      (c) => {
        configure(c);
        return 'Configure synthetic team';
      },
    );
    const startupMs = performance.now() - startupStart;
    const seedStart = performance.now();
    h.repos.transaction(() => {
      for (const message of messages(historyMessages, active)) h.repos.messages.insert(message);
      for (const task of tasks(historyTasks, active)) {
        h.repos.tasks.insert(task);
        h.repos.timeline.insert({
          id: `evt_perf_${task.key}`,
          projectKey: task.projectKey,
          taskKey: task.key,
          sessionId: null,
          actor: { kind: 'human', handle: 'owner' },
          type: 'task_stage_changed',
          data: { from: 'development', to: task.stageId },
          createdAt: task.createdAt,
        });
      }
    });
    return Object.assign(h, { fixtureTimings: { startupMs, seedMs: performance.now() - seedStart } });
  } catch (error) {
    await h.cleanup();
    throw error;
  }
}

type Counts = {
  sql: number;
  messageRows: number;
  taskRows: number;
  linkRows: number;
  timelineRows: number;
  decodedMessages: number;
  decodedTasks: number;
};
const emptyCounts = (): Counts => ({
  sql: 0,
  messageRows: 0,
  taskRows: 0,
  linkRows: 0,
  timelineRows: 0,
  decodedMessages: 0,
  decodedTasks: 0,
});

function instrument() {
  let counts: Counts | null = null;
  const probe = new Database(':memory:');
  const prototype = Object.getPrototypeOf(probe.prepare('SELECT 1')) as Database.Statement;
  probe.close();
  const descriptors = new Map<string, PropertyDescriptor>();
  // Wrap the shared native prototype once. Per-statement closures can retain native statements
  // through the addon's lifetime management and distort a long, query-heavy measurement.
  for (const method of ['all', 'get', 'run'] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, method)!;
    descriptors.set(method, descriptor);
    const call = prototype[method];
    Object.defineProperty(prototype, method, {
      ...descriptor,
      value: function (this: Database.Statement, ...args: unknown[]) {
        const result: unknown = Reflect.apply(call, this, args);
        if (!counts) return result;
        counts.sql++;
        const rows = method === 'all' ? (result as unknown[]) : method === 'get' && result ? [result] : [];
        for (const row of rows) {
          if (!row || typeof row !== 'object') continue;
          if ('from_handle' in row && 'body' in row) counts.messageRows++;
          if ('stage_id' in row && 'description' in row) counts.taskRows++;
          if ('task_id' in row && 'ref' in row) counts.linkRows++;
          if ('actor_kind' in row && 'type' in row) counts.timelineRows++;
        }
        return result;
      },
    });
  }
  const messageParse = MessageKind.safeParse;
  MessageKind.safeParse = (...args) => {
    if (counts) counts.decodedMessages++;
    return messageParse.apply(MessageKind, args);
  };
  const taskParse = TaskDeveloperLevel.safeParse;
  TaskDeveloperLevel.safeParse = (...args) => {
    if (counts) counts.decodedTasks++;
    return taskParse.apply(TaskDeveloperLevel, args);
  };
  return {
    start() {
      counts = emptyCounts();
    },
    stop() {
      const result = counts!;
      counts = null;
      return result;
    },
    restore() {
      for (const [method, descriptor] of descriptors) Object.defineProperty(prototype, method, descriptor);
      MessageKind.safeParse = messageParse;
      TaskDeveloperLevel.safeParse = taskParse;
    },
  };
}

function paths(h: DomainHarness) {
  const pending = async () => {
    let count = 0;
    for (const project of PROJECTS)
      for (const handle of HANDLES) count += h.repos.messages.pending(project, handle).length;
    // This is the engine settings/outage count path, separately from message hydration.
    const engineCount = h.domain.messaging.waitingForEngine(LOCAL_ENGINE_ID);
    return { count, engineCount };
  };
  const thirty = async () => {
    await h.domain.admission.retryDeferred();
    await h.domain.reviewWatch.check();
    await h.domain.fullTests.syncAll();
    await h.domain.outages.check();
  };
  const sixty = async () => {
    await h.domain.loopWatch.sweep();
    await h.domain.operatorSignals.sweep();
  };
  return {
    pending,
    thirty,
    sixty,
    combined: async () => {
      await thirty();
      await sixty();
      await pending();
    },
  };
}

function quantile(values: number[], fraction: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}

async function measure(run: () => Promise<unknown>, meter: ReturnType<typeof instrument>) {
  for (let warmup = 0; warmup < 2; warmup++) await run();
  const samples = [];
  for (let repeat = 0; repeat < 5; repeat++) {
    const wall: number[] = [];
    const cpu: number[] = [];
    const rounds: Counts[] = [];
    for (let round = 0; round < 10; round++) {
      meter.start();
      const started = performance.now();
      const before = process.cpuUsage();
      await run();
      const used = process.cpuUsage(before);
      wall.push(performance.now() - started);
      cpu.push((used.user + used.system) / 1000);
      rounds.push(meter.stop());
    }
    samples.push({
      wallMedianMs: quantile(wall, 0.5),
      wallP95Ms: quantile(wall, 0.95),
      cpuMedianMs: quantile(cpu, 0.5),
      cpuTotalMs: cpu.reduce((a, b) => a + b, 0),
      wall,
      cpu,
      rounds,
      memory: process.memoryUsage(),
    });
    console.log(
      'PM733 repeat',
      JSON.stringify({ repeat, wallMedianMs: quantile(wall, 0.5), memory: process.memoryUsage() }),
    );
  }
  return samples;
}

function migrationMeasurement(history: number) {
  const migration = migrations.find((m) => m.name === 'pending message recipients');
  if (!migration) return null; // The original-source baseline has no pending derivation yet.
  const db = new Database(':memory:');
  try {
    for (const m of migrations.filter((m) => m.version < migration.version)) db.exec(m.sql);
    db.pragma(`user_version = ${migration.version - 1}`);
    for (const key of PROJECTS)
      db.prepare('INSERT INTO projects VALUES (?, ?, NULL, ?, ?, ?)').run(key, key, 'fixture', OLD, OLD);
    const insert = db.prepare(`INSERT INTO team_messages
      (id, project_key, from_handle, to_handles, task_key, body, created_at, delivered_at, receipts, kind, version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    db.transaction(() => {
      for (const m of messages(history, true))
        insert.run(
          m.id,
          m.projectKey,
          m.from,
          JSON.stringify(m.to),
          m.taskKey,
          m.body,
          m.createdAt,
          m.deliveredAt,
          JSON.stringify(m.receipts),
          m.kind,
          JSON.stringify(m.version),
        );
    })();
    const size = () =>
      Number(db.pragma('page_count', { simple: true })) * Number(db.pragma('page_size', { simple: true }));
    const beforeBytes = size();
    const cpu = process.cpuUsage();
    const started = performance.now();
    migrate(db);
    const wallMs = performance.now() - started;
    const used = process.cpuUsage(cpu);
    expect(db.prepare('SELECT COUNT(*) AS n FROM team_message_pending').get()).toEqual({ n: 20 });
    return { wallMs, cpuMs: (used.user + used.system) / 1000, beforeBytes, afterBytes: size() };
  } finally {
    db.close();
  }
}

describe('periodic work performance protocol (PM-733)', () => {
  it('keeps the active set identical as unrelated history grows', async () => {
    for (const history of [20, 200]) {
      const h = await fixture(history, history, true);
      try {
        expect(await paths(h).pending()).toEqual({ count: 20, engineCount: 20 });
        for (const project of PROJECTS)
          expect(h.repos.tasks.list(project).filter((t) => t.status === 'active')).toHaveLength(10);
      } finally {
        await h.cleanup();
      }
    }
  });

  it.skipIf(!RUN_BENCHMARK)(
    'records the original and intermediate periodic CPU measurements',
    async () => {
      expect(process.env.PROJECTMAN_HEAVY_LOCK_HELD).toBe('1');
      const meter = instrument();
      try {
        const environment = {
          originalSource: ORIGINAL_SOURCE,
          source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
          // A baseline can be reproduced with the original production tree and the current harness.
          // Verify the whole server source tree against the original commit, rather than trusting an override.
          productionMatchesOriginal:
            execFileSync('git', ['diff', ORIGINAL_SOURCE, '--', 'apps/server/src'], { encoding: 'utf8' })
              .length === 0,
          harnessSha256: createHash('sha256')
            .update(readFileSync(new URL(import.meta.url)))
            .digest('hex'),
          seed: 733,
          platform: os.platform(),
          release: os.release(),
          arch: os.arch(),
          node: process.version,
          cpu: os.cpus()[0]?.model,
          load: os.loadavg(),
          warmup: 2,
          repeats: 5,
          rounds: 10,
        };
        console.log('PM733 environment', JSON.stringify(environment));
        const results: unknown[] = [];
        const reportPath = join(
          process.env.PROJECTMAN_SESSION_DIR ?? os.tmpdir(),
          `periodic-work-${environment.source.slice(0, 12)}.json`,
        );
        for (const active of [true, false]) {
          for (const [historyMessages, historyTasks] of [
            [10_000, 2_000],
            [100_000, 20_000],
          ]) {
            const h = await fixture(historyMessages!, historyTasks!, active);
            try {
              console.log(
                'PM733 fixture',
                JSON.stringify({
                  active,
                  historyMessages,
                  historyTasks,
                  ...h.fixtureTimings,
                }),
              );
              for (const [path, run] of Object.entries(paths(h))) {
                const samples = await measure(run, meter);
                results.push({ active, historyMessages, historyTasks, path, samples, ...h.fixtureTimings });
                writeFileSync(reportPath, JSON.stringify({ environment, results, complete: false }, null, 2));
                console.log(
                  'PM733 samples',
                  JSON.stringify({
                    active,
                    historyMessages,
                    historyTasks,
                    path,
                    samples: samples.map(({ wall, cpu, rounds, ...sample }) => ({
                      ...sample,
                      counts: rounds[0],
                    })),
                  }),
                );
              }
            } finally {
              await h.cleanup();
            }
          }
        }
        const migrationResults = [10_000, 100_000].map((history) => ({
          history,
          result: migrationMeasurement(history),
        }));
        console.log('PM733 migration', JSON.stringify(migrationResults));
        writeFileSync(
          reportPath,
          JSON.stringify({ environment, results, migrationResults, complete: true }, null, 2),
        );
        console.log('PM733 report', reportPath);
      } finally {
        meter.restore();
      }
    },
    3_600_000,
  );
});
