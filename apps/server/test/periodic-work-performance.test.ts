import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { LOCAL_ENGINE_ID, MessageKind, TaskComplexity } from '@projectman/shared';
import type { ProjectConfig, Task, TeamMessage, TimelineEvent } from '@projectman/shared';
import { describe, expect, it, vi } from 'vitest';
import { migrate, migrations } from '../src/db';
import { MemberQueueWorker } from '../src/runtime/member-queue';
import { createDomainHarness, OWNER } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { settle } from './helpers/fakes';
import { StructuralPatterns } from '../src/services/operator/structural-patterns';
import { conflict } from '../src/kernel';
import * as kernel from '../src/kernel';
import { TIMELINE_SQL } from '../src/db/timeline';

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
const PENDING_ONLY = process.env.PROJECTMAN_PERIODIC_PENDING_ONLY === '1';
const RUN_STARTUP = process.env.PROJECTMAN_PERIODIC_STARTUP === '1';
// PM-770: a comma-separated subset of the paths (`thirty,sixty`), a separately named report like the pending one.
const ONLY_PATHS = process.env.PROJECTMAN_PERIODIC_PATHS?.split(',').filter(Boolean);
const RUN_STRUCTURAL = process.env.PROJECTMAN_PERIODIC_STRUCTURAL === '1';
const STRUCTURAL_BASELINE = '550d38a914265e3177c5c100484b7fea1130cbb2';

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
        createdBy: 'owner',
        createdAt: open ? NOW : OLD,
        updatedAt: open ? NOW : OLD,
        closedAt: open ? null : OLD,
      };
    }
  }
}

/**
 * PM-771: the same current 7-day evidence at every scale (the Operator signals and the structural
 * report read it): one family per project whose three subtasks close inside the window, with a few
 * more structural events. It does not change with the history, so any growth of the walk shows up.
 */
function currentEvidence(): { tasks: Task[]; events: TimelineEvent[] } {
  const hour = 60 * 60_000;
  const at = (hoursAgo: number) => new Date(Date.parse(NOW) - hoursAgo * hour).toISOString();
  const found = { tasks: [] as Task[], events: [] as TimelineEvent[] };
  for (const projectKey of PROJECTS) {
    const parentKey = `${projectKey}-2000000`;
    for (let n = 0; n <= 3; n++) {
      const key = `${projectKey}-${2_000_000 + n}`;
      found.tasks.push({
        id: `task_perf_${key}`,
        key,
        projectKey,
        title: `Fictional current card ${n}`,
        description: 'Synthetic current-window fixture',
        stageId: 'done',
        status: 'done',
        assignee: null,
        repo: 'web',
        priority: null,
        labels: [],
        links: [],
        parentKey: n ? parentKey : null,
        createdBy: 'owner',
        createdAt: at(72),
        updatedAt: at(n),
        closedAt: at(n),
      });
      const event = (
        suffix: string,
        type: TimelineEvent['type'],
        data: Record<string, unknown>,
        hoursAgo: number,
      ) =>
        found.events.push({
          id: `evt_perf_current_${key}_${suffix}`,
          projectKey,
          taskKey: key,
          sessionId: null,
          actor: { kind: 'human', handle: 'owner' },
          type,
          data,
          createdAt: at(hoursAgo),
        });
      // The children close one by one; the parent closes last.
      event('done', 'task_stage_changed', { from: 'development', to: 'done' }, n ? 4 - n : 0.5);
      event('labels', 'task_labels_changed', { added: ['perf'], removed: [] }, 40 + n);
      event('updated', 'task_updated', { fields: ['title'] }, 30 + n);
    }
  }
  return found;
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

async function fixture(historyMessages: number, historyTasks: number, active: boolean, persistent = false) {
  const startupStart = performance.now();
  const h = await createDomainHarness({
    adjust: configure,
    now: () => new Date(NOW),
    ...(persistent ? { persistent } : {}),
  });
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
      const current = currentEvidence();
      for (const task of current.tasks) h.repos.tasks.insert(task);
      for (const event of current.events) h.repos.timeline.insert(event);
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
  reports: number;
  windows: number;
  patterns: number;
  parents: number;
  requestReads: number;
};
const emptyCounts = (): Counts => ({
  sql: 0,
  messageRows: 0,
  taskRows: 0,
  linkRows: 0,
  timelineRows: 0,
  decodedMessages: 0,
  decodedTasks: 0,
  reports: 0,
  windows: 0,
  patterns: 0,
  parents: 0,
  requestReads: 0,
});

function instrument() {
  let counts: Counts | null = null;
  const probe = new Database(':memory:');
  const prototype = Object.getPrototypeOf(probe.prepare('SELECT 1')) as Database.Statement;
  probe.close();
  const descriptors = new Map<string, PropertyDescriptor>();
  const structuralDescriptors = new Map<string, PropertyDescriptor>();
  // These methods exist on both the baseline and optimized detector. Count actual computation,
  // rather than treating a cached evaluation.report() call as another window reconstruction.
  for (const [method, counter] of [
    ['report', 'reports'],
    ['patterns', 'patterns'],
    ['parentMilestones', 'parents'],
  ] as const) {
    const target = StructuralPatterns.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(target, method)!;
    structuralDescriptors.set(method, descriptor);
    Object.defineProperty(target, method, {
      ...descriptor,
      value: function (this: StructuralPatterns, ...args: unknown[]) {
        if (counts) counts[counter]++;
        return Reflect.apply(descriptor.value as (...args: unknown[]) => unknown, this, args);
      },
    });
  }
  // Wrap the shared native prototype once, with a constant number of wrappers. Retain neither
  // statement instances nor per-call history during a long, query-heavy measurement.
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
        if (this.source === TIMELINE_SQL.structuralEvidence) counts.windows++;
        if (args.includes('task_merge_requested') && args.at(-1) === 1000) counts.requestReads++;
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
  const taskParse = TaskComplexity.safeParse;
  TaskComplexity.safeParse = (...args) => {
    if (counts) counts.decodedTasks++;
    return taskParse.apply(TaskComplexity, args);
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
      for (const [method, descriptor] of structuralDescriptors)
        Object.defineProperty(StructuralPatterns.prototype, method, descriptor);
      MessageKind.safeParse = messageParse;
      TaskComplexity.safeParse = taskParse;
    },
  };
}

function paths(h: DomainHarness) {
  const pending = async () => {
    let count = 0;
    for (const project of PROJECTS)
      for (const handle of HANDLES) count += h.repos.messages.pending(project, handle).length;
    // This is the engine settings/outage count path, separately from message hydration.
    const engineCount = h.domain.messageRouter.waitingForEngine(LOCAL_ENGINE_ID);
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
    const cpuUser: number[] = [];
    const cpuSystem: number[] = [];
    const rounds: Counts[] = [];
    for (let round = 0; round < 10; round++) {
      meter.start();
      const started = performance.now();
      const before = process.cpuUsage();
      await run();
      const used = process.cpuUsage(before);
      wall.push(performance.now() - started);
      cpu.push((used.user + used.system) / 1000);
      cpuUser.push(used.user / 1000);
      cpuSystem.push(used.system / 1000);
      rounds.push(meter.stop());
    }
    samples.push({
      wallMedianMs: quantile(wall, 0.5),
      wallP95Ms: quantile(wall, 0.95),
      cpuMedianMs: quantile(cpu, 0.5),
      cpuTotalMs: cpu.reduce((a, b) => a + b, 0),
      wall,
      cpu,
      cpuUser,
      cpuSystem,
      rounds,
      memory: process.memoryUsage(),
      load: os.loadavg(),
    });
    console.log(
      'PM733 repeat',
      JSON.stringify({ repeat, wallMedianMs: quantile(wall, 0.5), memory: process.memoryUsage() }),
    );
  }
  return samples;
}

/**
 * The startup of a server restarted over the same database file (PM-770): the new domain's start
 * and the background recovery it fires (AutoAdvance sweep, merge reconciliation, deferred starts),
 * from the moment the previous domain is stopped. One warmup restart is not counted.
 */
async function startupSample(
  historyMessages: number,
  historyTasks: number,
  active: boolean,
  meter: ReturnType<typeof instrument>,
  rounds: number,
) {
  let current: DomainHarness = await fixture(historyMessages, historyTasks, active, true);
  const wall: number[] = [];
  const cpu: number[] = [];
  const counts: Counts[] = [];
  try {
    for (let round = -1; round < rounds; round++) {
      await current.domain.stop();
      current.repos.db.close();
      meter.start();
      const started = performance.now();
      const before = process.cpuUsage();
      current = await createDomainHarness({ now: () => new Date(NOW), directory: current.dir });
      await settle();
      const used = process.cpuUsage(before);
      const elapsed = performance.now() - started;
      const measured = meter.stop();
      if (round < 0) continue;
      wall.push(elapsed);
      cpu.push((used.user + used.system) / 1000);
      counts.push(measured);
    }
    return { wall, cpu, rounds: counts, memory: process.memoryUsage() };
  } finally {
    await current.cleanup();
  }
}

type StructuralHold = 'budget' | 'admission' | 'engine';

/** PM-783 adds cases without changing the PM-769/771 generator or its original scenarios. */
async function structuralFixture(
  historyMessages: number,
  historyTasks: number,
  groups: number,
  hold: StructuralHold,
) {
  // Long cases must invoke only the explicitly measured rounds. The real 30/60-second tickers
  // otherwise overlap the experiment; production timer intervals remain unchanged.
  const sweeps = vi.spyOn(kernel, 'startSweeps').mockReturnValue({ stop: async () => {} });
  // The seeded history waits in the member queues; the member queue's driver would start the sessions it asks for.
  const driver = vi.spyOn(MemberQueueWorker.prototype, 'ensure').mockResolvedValue();
  let h: Awaited<ReturnType<typeof fixture>>;
  try {
    h = await fixture(historyMessages, historyTasks, true);
    expect(sweeps).toHaveBeenCalledTimes(1);
  } catch (error) {
    driver.mockRestore();
    throw error;
  } finally {
    sweeps.mockRestore();
  }
  let clock = new Date(NOW);
  const now = vi.spyOn(h.domain.ctx, 'now').mockImplementation(() => clock);
  const attempt = vi.spyOn(h.domain.admission, 'attempt').mockResolvedValue({ kind: 'done' });
  const seedStart = performance.now();
  try {
    for (const projectKey of PROJECTS)
      await h.domain.projects.update(
        projectKey,
        { actor: { kind: 'human', handle: 'owner' }, author: OWNER },
        (config) => {
          const pm = config.team.members.find((member) => member.handle === 'pm')!;
          if (pm.kind === 'ai') pm.onLeave = false;
          return 'Enable synthetic coordinator';
        },
      );
    const base = currentEvidence().tasks[0]!;
    for (const projectKey of PROJECTS)
      for (const kind of ['structural_pattern', 'milestone_closed'] as const)
        h.repos.operatorSignals.arm(projectKey, kind, OLD);
    h.repos.transaction(() => {
      for (const projectKey of PROJECTS)
        for (let n = 0; n < groups; n++) {
          // Half the subjects are raised together in each of two distinct original windows.
          const at = new Date(Date.parse(NOW) - (n < Math.ceil(groups / 2) ? 60 : 20) * 60_000).toISOString();
          const parentKey = `${projectKey}-${3_000_000 + n * 3}`;
          for (let child = 0; child < 3; child++) {
            const key = `${projectKey}-${3_000_000 + n * 3 + child}`;
            h.repos.tasks.insert({
              ...base,
              projectKey,
              id: `task_structural_${key}`,
              key,
              parentKey: child ? parentKey : null,
              links: [{ kind: 'branch', ref: `fixture/${key}`, repo: 'web' }],
              createdAt: OLD,
              updatedAt: at,
              closedAt: at,
            });
            if (!child) continue;
            const insert = (
              suffix: string,
              type: TimelineEvent['type'],
              data: Record<string, unknown>,
              createdAt = at,
            ) =>
              h.repos.timeline.insert({
                id: `evt_structural_perf_${key}_${suffix}`,
                projectKey,
                taskKey: key,
                sessionId: null,
                actor: { kind: 'system', handle: null },
                type,
                data,
                createdAt,
              });
            insert('request', 'task_merge_requested', { mergeId: key, repo: 'web' }, OLD);
            insert('test', 'task_full_test', {
              outcome: 'failed',
              repo: 'web',
              failedFiles: [`src/test-${n}.test.ts`],
            });
            for (let retry = 0; retry < 2; retry++)
              insert(`conflict-${retry}`, 'task_merge_failed', {
                mergeId: key,
                reason: 'conflict',
                files: [`src/conflict-${n}.ts`],
              });
            insert('closed', 'task_stage_changed', { from: 'development', to: 'done' });
          }
        }
    });
    for (const minutes of [30, 15]) {
      clock = new Date(Date.parse(NOW) - minutes * 60_000);
      await h.domain.operatorSignals.sweep();
    }
    clock = new Date(NOW);
    attempt.mockRestore();
    const structural = () =>
      PROJECTS.flatMap((key) => h.repos.operatorSignals.list(key)).filter(
        (s) => s.kind === 'milestone_closed' || s.kind === 'structural_pattern',
      );
    const signals = structural();
    const evidenceHash = createHash('sha256')
      .update(
        JSON.stringify(
          signals.map((s) => [
            s.kind,
            s.taskKey,
            s.subject,
            s.raisedAt,
            h.domain.operatorSignals.structuralFacts(s),
          ]),
        ),
      )
      .digest('hex');
    // The member queue's signal items: the lane asks `holdsBack` before a delivery and `noticeText` builds its input.
    const starts = PROJECTS.map((projectKey) => {
      const ids = signals.filter((signal) => signal.projectKey === projectKey).map((signal) => signal.id);
      return {
        // One evaluation, as the lane's hold asks it once for the batch.
        stillValid: () => h.domain.operatorSignals.holdsBack(projectKey, ids[0]!),
        run: async () => h.domain.operatorSignals.noticeText(projectKey, ids),
      };
    });
    const markerIds: string[] = [];
    if (hold === 'budget')
      for (const projectKey of PROJECTS) {
        const marker = signals.find((signal) => signal.projectKey === projectKey)!;
        markerIds.push(marker.id);
        h.repos.operatorSignals.delivered([marker.id], NOW, 'pm');
      }
    // Deliberately refuse at the engine-start boundary, after facts have been constructed, without
    // starting a runner. Actual admission keeps and retries the production deferred-start object.
    const start = vi
      .spyOn(h.domain.admission, 'start')
      .mockRejectedValue(conflict('engine_offline', 'synthetic engine is offline'));
    const held =
      hold === 'admission'
        ? vi.spyOn(h.domain.admission, 'attempt').mockImplementation(async (entry) => {
            entry.stillValid(null);
            return { kind: 'deferred', waiting: { reason: 'ai_limit_reached', since: clock.toISOString() } };
          })
        : undefined;
    let tick = 0;
    const runs = paths(h);
    const advance = (run: () => Promise<unknown>) => async () => {
      clock = new Date(Date.parse(NOW) + tick++ * 60_000);
      await run();
    };
    const selected = {
      sixty: advance(runs.sixty),
      combined: advance(runs.combined),
      stillValid: advance(async () => {
        for (const entry of starts) entry.stillValid();
      }),
      factsPayload: advance(async () => {
        for (const entry of starts)
          try {
            await entry.run();
          } catch (error) {
            if (!(error instanceof Error) || !error.message.includes('synthetic engine is offline'))
              throw error;
          }
      }),
    };
    return {
      h,
      selected,
      evidenceHash,
      signalCount: signals.length,
      fixtureTimings: { ...h.fixtureTimings, structuralSeedMs: performance.now() - seedStart },
      beforePath(path: string) {
        tick = 0;
        // The payload path measures a possible delivery, independently of the preceding budget case.
        if (path === 'factsPayload')
          for (const id of markerIds)
            h.repos.operatorSignals.save({
              ...h.repos.operatorSignals.get(id)!,
              deliveredAt: null,
              deliveredTo: null,
            });
      },
      async cleanup() {
        held?.mockRestore();
        start.mockRestore();
        now.mockRestore();
        driver.mockRestore();
        await h.cleanup();
      },
    };
  } catch (error) {
    attempt.mockRestore();
    now.mockRestore();
    driver.mockRestore();
    await h.cleanup();
    throw error;
  }
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
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'team_message_pending'").get(),
    ).toEqual({ n: 0 });
    return { wallMs, cpuMs: (used.user + used.system) / 1000, beforeBytes, afterBytes: size() };
  } finally {
    db.close();
  }
}

describe('structural signal performance protocol (PM-783)', () => {
  it.each(['budget', 'admission', 'engine'] as const)(
    'exercises all measured paths while signals wait for %s',
    async (hold) => {
      const fixture = await structuralFixture(20, 20, 2, hold);
      try {
        for (const [path, run] of Object.entries(fixture.selected)) {
          fixture.beforePath(path);
          await run();
          await run();
        }
        expect(fixture.h.runner.started).toHaveLength(0);
        expect(
          PROJECTS.flatMap((key) => fixture.h.repos.operatorSignals.list(key)).filter(
            (s) => s.kind === 'structural_pattern' && !s.resolvedAt,
          ),
        ).toHaveLength(8);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it('keeps structural reads independent of unrelated history and signal count per original window', async () => {
    const measurements = [];
    for (const [history, groups] of [
      [20, 2],
      [200, 2],
      [20, 20],
    ]) {
      const fixture = await structuralFixture(history!, history!, groups!, 'budget');
      const meter = instrument();
      try {
        meter.start();
        await fixture.selected.stillValid();
        const counts = meter.stop();
        measurements.push({ counts, hash: fixture.evidenceHash, signalCount: fixture.signalCount });
      } finally {
        meter.restore();
        await fixture.cleanup();
      }
    }
    expect(measurements[1]).toEqual(measurements[0]);
    expect(measurements[2]!.signalCount).toBeGreaterThan(measurements[0]!.signalCount * 5);
    if ('evaluate' in StructuralPatterns.prototype) {
      expect(measurements.map(({ counts }) => counts.windows)).toEqual([6, 6, 6]); // Two projects, current + two original windows.
      expect(measurements.map(({ counts }) => counts.parents)).toEqual([2, 2, 2]);
      expect(measurements.map(({ counts }) => counts.patterns)).toEqual([6, 6, 6]);
      expect(measurements[2]!.counts.requestReads).toBe(80); // One per affected card across all windows.
    }
  });

  // npm run heavy -- env PROJECTMAN_PERIODIC_STRUCTURAL=1 npm run test -w @projectman/server -- test/periodic-work-performance.test.ts
  it.skipIf(!RUN_STRUCTURAL)(
    'records identical structural workloads on the exact PM-783 baseline and final production sources',
    async () => {
      expect(process.env.PROJECTMAN_HEAVY_LOCK_HELD).toBe('1');
      const productionDiff = execFileSync(
        'git',
        ['diff', STRUCTURAL_BASELINE, '--', ':(top)apps/server/src'],
        { encoding: 'utf8' },
      );
      const environment = {
        baselineSource: STRUCTURAL_BASELINE,
        source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        productionMatchesBaseline: productionDiff.length === 0,
        productionDiffSha256: createHash('sha256').update(productionDiff).digest('hex'),
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
        boundary:
          'After startup and synthetic seed; automatic sweep tickers are disabled only in this fixture, and each invocation explicitly runs one simulated 60-second round. stillValid uses retained production starts; payload runs fresh config/facts through the engine-start refusal. Budget markers are cleared outside payload measurement. Original windows are exact, never rounded.',
      };
      const results: unknown[] = [];
      const reportPath = join(
        process.env.PROJECTMAN_SESSION_DIR ?? os.tmpdir(),
        `periodic-work-structural-${environment.productionMatchesBaseline ? 'baseline' : 'optimized'}-${environment.source.slice(0, 12)}.json`,
      );
      console.log('PM783 environment', JSON.stringify(environment));
      const meter = instrument();
      try {
        for (const hold of ['budget', 'admission', 'engine'] as const)
          for (const groups of [2, 20])
            for (const [historyMessages, historyTasks] of [
              [10_000, 2_000],
              [100_000, 20_000],
            ]) {
              const fixture = await structuralFixture(historyMessages!, historyTasks!, groups, hold);
              try {
                for (const [path, run] of Object.entries(fixture.selected)) {
                  fixture.beforePath(path);
                  const samples = await measure(run, meter);
                  results.push({
                    hold,
                    groups,
                    historyMessages,
                    historyTasks,
                    path,
                    evidenceHash: fixture.evidenceHash,
                    signalCount: fixture.signalCount,
                    ...fixture.fixtureTimings,
                    samples,
                  });
                  writeFileSync(
                    reportPath,
                    JSON.stringify({ environment, results, complete: false }, null, 2),
                  );
                  console.log(
                    'PM783 samples',
                    JSON.stringify({
                      hold,
                      groups,
                      historyMessages,
                      historyTasks,
                      path,
                      wallMedianMs: samples.map((sample) => sample.wallMedianMs),
                      counts: samples[0]!.rounds[0],
                    }),
                  );
                }
              } finally {
                await fixture.cleanup();
              }
            }
        writeFileSync(reportPath, JSON.stringify({ environment, results, complete: true }, null, 2));
        console.log('PM783 report', reportPath);
      } finally {
        meter.restore();
      }
    },
    3_600_000,
  );
});

describe('periodic work performance protocol (PM-733)', () => {
  it('keeps the active set identical as unrelated history grows', async () => {
    for (const history of [20, 200]) {
      const h = await fixture(history, history, true);
      try {
        expect(await paths(h).pending()).toEqual({ count: 17, engineCount: 17 });
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
            execFileSync('git', ['diff', ORIGINAL_SOURCE, '--', ':(top)apps/server/src'], {
              encoding: 'utf8',
            }).length === 0,
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
          mode: PENDING_ONLY ? 'pending' : ONLY_PATHS ? `paths-${ONLY_PATHS.join('-')}` : 'full',
        };
        console.log('PM733 environment', JSON.stringify(environment));
        const results: unknown[] = [];
        const reportPath = join(
          process.env.PROJECTMAN_SESSION_DIR ?? os.tmpdir(),
          `periodic-work-${environment.productionMatchesOriginal ? 'original' : 'optimized'}-${environment.mode}-${environment.source.slice(0, 12)}.json`,
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
              const runs = paths(h);
              const selected = Object.entries(PENDING_ONLY ? { pending: runs.pending } : runs).filter(
                ([path]) => !ONLY_PATHS || ONLY_PATHS.includes(path),
              );
              for (const [path, run] of selected) {
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

  it('samples the startup recovery of a restarted server at a small scale', async () => {
    const meter = instrument();
    try {
      const sample = await startupSample(20, 20, true, meter, 1);
      expect(sample.rounds).toHaveLength(1);
      expect(sample.rounds[0]!.sql).toBeGreaterThan(0);
    } finally {
      meter.restore();
    }
  });

  // PM-770: the startup recovery (AutoAdvance sweep, merge reconciliation, deferred starts) of a server
  // restarted over the same database file, measured apart from the periodic paths. Opt-in, heavy queue:
  // npm run heavy -- env PROJECTMAN_PERIODIC_STARTUP=1 npm run test -w @projectman/server -- test/periodic-work-performance.test.ts
  it.skipIf(!RUN_STARTUP)(
    'records the startup recovery CPU measurements',
    async () => {
      expect(process.env.PROJECTMAN_HEAVY_LOCK_HELD).toBe('1');
      const meter = instrument();
      try {
        const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
        const productionMatchesOriginal =
          execFileSync('git', ['diff', ORIGINAL_SOURCE, '--', ':(top)apps/server/src'], {
            encoding: 'utf8',
          }).length === 0;
        const environment = {
          originalSource: ORIGINAL_SOURCE,
          source,
          productionMatchesOriginal,
          harnessSha256: createHash('sha256')
            .update(readFileSync(new URL(import.meta.url)))
            .digest('hex'),
          seed: 733,
          platform: os.platform(),
          arch: os.arch(),
          node: process.version,
          cpu: os.cpus()[0]?.model,
          load: os.loadavg(),
          mode: 'startup',
        };
        const results: unknown[] = [];
        const reportPath = join(
          process.env.PROJECTMAN_SESSION_DIR ?? os.tmpdir(),
          `periodic-work-${productionMatchesOriginal ? 'original' : 'optimized'}-startup-${source.slice(0, 12)}.json`,
        );
        for (const active of [true, false])
          for (const [historyMessages, historyTasks] of [
            [10_000, 2_000],
            [100_000, 20_000],
          ]) {
            const sample = await startupSample(historyMessages!, historyTasks!, active, meter, 10);
            results.push({ active, historyMessages, historyTasks, ...sample });
            console.log(
              'PM770 startup',
              JSON.stringify({
                active,
                historyMessages,
                historyTasks,
                wallMedianMs: quantile(sample.wall, 0.5),
                cpuMedianMs: quantile(sample.cpu, 0.5),
                counts: sample.rounds[0],
              }),
            );
            writeFileSync(reportPath, JSON.stringify({ environment, results, complete: false }, null, 2));
          }
        writeFileSync(reportPath, JSON.stringify({ environment, results, complete: true }, null, 2));
        console.log('PM770 report', reportPath);
      } finally {
        meter.restore();
      }
    },
    3_600_000,
  );
});
