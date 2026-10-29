import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OPERATOR_IDLE_MINUTES,
  OPERATOR_MERGE_WAIT_MINUTES,
  OPERATOR_READY_WAITING_MINUTES,
  OPERATOR_SIGNAL_ROUND_FROM,
  OPERATOR_SIGNAL_STEP_GAP_MINUTES,
} from '@projectman/shared';
import type { OperatorSignalKind, OperatorWatch, ProjectConfig, Task } from '@projectman/shared';
import type { ToolContext } from '../src/contracts';
import { createRepositories, LATEST_SCHEMA_VERSION, migrate } from '../src/db';
import type { MergeRecord } from '../src/db';
import { migrations } from '../src/db/migrations';
import { OperatorRequests } from '../src/services/coordination';
import { createDomainHarness, OWNER_ACTOR, waitForSession } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

/** PM-545: the Operator's own steps on a system signal, without an owner's request. */
let h: DomainHarness;
let now: Date;
afterEach(async () => {
  await h?.cleanup();
});

const later = (minutes: number) => {
  now = new Date(now.getTime() + minutes * 60_000);
};
const open = (kind: OperatorSignalKind) =>
  h.repos.operatorSignals.list('AR').filter((s) => s.kind === kind && !s.resolvedAt);

async function setup(
  level: OperatorWatch | undefined,
  opts: { adjust?: (config: ProjectConfig) => void; appVersion?: string } = {},
) {
  now = new Date('2026-10-12T10:00:00Z');
  h = await createDomainHarness({
    now: () => now,
    ...(opts.appVersion ? { appVersion: opts.appVersion } : {}),
    adjust: (config) => {
      const pm = config.team.members.find((m) => m.handle === 'pm')!;
      if (pm.kind === 'ai') pm.onLeave = false;
      if (level) config.team.operatorWatch = level;
      opts.adjust?.(config);
    },
  });
}

async function place(patch: Partial<Pick<Task, 'stageId' | 'status' | 'assignee'>>): Promise<Task> {
  const card = await h.domain.tasks.create('AR', { title: 'Card', repo: 'web' }, OWNER_ACTOR);
  h.repos.tasks.update(card.id, { ...patch, updatedAt: now.toISOString() });
  return h.repos.tasks.get(card.key)!;
}

/** An idle development card whose signal has been raised and delivered to the Operator. */
async function idleCard() {
  const card = await place({ stageId: 'development', status: 'active', assignee: 'dev-1' });
  later(OPERATOR_IDLE_MINUTES);
  await h.domain.operatorSignals.sweep('AR');
  await flush();
  return { card, signal: open('idle')[0]! };
}

function mergeRow(taskKey: string, over: Partial<MergeRecord> = {}): MergeRecord {
  return {
    id: `mrg_${taskKey}`,
    projectKey: 'AR',
    repo: 'web',
    base: 'main',
    commit: `branch-${taskKey}`,
    branch: `pm/${taskKey}`,
    fromStageId: 'code_review',
    toStageId: 'done',
    merger: 'dev-1',
    requestedAt: now.toISOString(),
    landed: 'nowhere',
    state: 'requested',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    taskKey,
    ...over,
  };
}

/** A merge card whose signal has been raised and delivered. */
async function mergeCard(kind: 'merge_waiting' | 'merge_blocked') {
  const card = await place({ stageId: 'code_review', status: 'waiting' });
  h.repos.taskMerges.save(mergeRow(card.key, kind === 'merge_blocked' ? { state: 'failed' } : {}));
  later(OPERATOR_MERGE_WAIT_MINUTES);
  await h.domain.operatorSignals.sweep('AR');
  await flush();
  return { card, signal: open(kind)[0]! };
}

const operator = async (): Promise<ToolContext> => ({
  projectKey: 'AR',
  member: 'pm',
  taskKey: null,
  sessionId: (await waitForSession(h.domain, { member: 'pm' })).id,
});
const roundSteps = () =>
  h.repos.operatorRequests
    .latest('AR', 10)
    .filter((r) => r.source === 'signal')
    .flatMap((r) => h.repos.operatorRequests.steps(r.id));
const startIdle = async (card: Task, signal: { id: string }, ctx?: ToolContext) =>
  h.domain.teamTools.startTask(ctx ?? (await operator()), { taskKey: card.key, signalId: signal.id });
/** The started developer finishes a turn and sits idle on the card, so the idle case stands again after a while. */
async function developerIdles(minutes: number) {
  const session = await waitForSession(h.domain, { member: 'dev-1' });
  h.runner.setState(session.id, 'working');
  h.runner.setState(session.id, 'idle');
  await flush();
  later(minutes);
}
const startMerger = async (card: Task, signal: { id: string }, member = 'dev-1') =>
  h.domain.teamTools.startMember(await operator(), {
    member,
    text: 'The merge waits for you.',
    taskKey: card.key,
    signalId: signal.id,
  });

describe('level report', () => {
  it('refuses a step on a signal like any write without an owner request', async () => {
    await setup('report');
    const { card, signal } = await idleCard();
    await expect(startIdle(card, signal)).rejects.toMatchObject({
      code: 'forbidden',
      message: expect.stringContaining('operator_no_request'),
    });
    expect(h.domain.sessions.list('AR', { member: 'dev-1' })).toEqual([]);
    expect(roundSteps()).toEqual([]);
  });

  it('is the default when the project sets no level', async () => {
    await setup(undefined);
    const { card, signal } = await idleCard();
    await expect(startIdle(card, signal)).rejects.toMatchObject({
      message: expect.stringContaining('operator_no_request'),
    });
  });
});

describe('level unblock', () => {
  it('starts the idle card’s assignee, logs the step with the signal and schedules the follow-up', async () => {
    await setup('unblock');
    const { card, signal } = await idleCard();
    await startIdle(card, signal);
    expect(h.domain.sessions.list('AR', { member: 'dev-1' })).toHaveLength(1);
    expect(roundSteps()).toMatchObject([
      { action: 'task_start', taskKey: card.key, status: 'done', signalId: signal.id },
    ]);
    const round = h.repos.operatorRequests.latest('AR', 10).find((r) => r.source === 'signal')!;
    expect(round).toMatchObject({ fromHandle: OPERATOR_SIGNAL_ROUND_FROM, quote: '' });
    expect(h.repos.operatorSignals.get(signal.id)!.followUpAt).toBe(
      new Date(now.getTime() + OPERATOR_SIGNAL_STEP_GAP_MINUTES * 60_000).toISOString(),
    );
  });

  it('keeps the signal round out of every owner request lookup', async () => {
    await setup('unblock');
    const { card, signal } = await idleCard();
    await startIdle(card, signal);
    const { sessionId } = await operator();
    expect(new OperatorRequests({ ctx: h.domain.ctx }).openFor(sessionId)).toBeNull();
    // The round authorizes nothing by itself: a write without a signal is still refused.
    await expect(
      h.domain.teamTools.startMember(await operator(), { member: 'dev-2', text: 'Work' }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('operator_no_request'),
    });
  });

  it('refuses another card, another member, another tool and a signal kind that level does not cover', async () => {
    await setup('unblock');
    const { card, signal } = await idleCard();
    const other = await place({ stageId: 'development', status: 'active', assignee: 'dev-1' });
    for (const call of [
      () => startIdle(other, signal),
      () => startMerger(card, signal, 'dev-1'),
      async () =>
        h.domain.teamTools.startMember(await operator(), {
          member: 'dev-1',
          text: 'Work',
          signalId: signal.id,
        }),
      async () =>
        h.domain.teamTools.startTask(await operator(), { taskKey: card.key, signalId: 'ops_unknown' }),
    ])
      await expect(call()).rejects.toThrow(/operator_no_request|invalid_request/);
    expect(h.domain.sessions.list('AR', { member: 'dev-1' })).toEqual([]);
    expect(roundSteps()).toEqual([]);
  });

  it('refuses the start_task options next to a signal', async () => {
    await setup('unblock');
    const { card, signal } = await idleCard();
    await expect(
      h.domain.teamTools.startTask(await operator(), {
        taskKey: card.key,
        assignee: 'dev-2',
        signalId: signal.id,
      }),
    ).rejects.toThrow('invalid_request');
    await expect(
      h.domain.teamTools.startTask(await operator(), {
        taskKey: card.key,
        despitePrerequisites: true,
        signalId: signal.id,
      }),
    ).rejects.toThrow('invalid_request');
  });

  it('stays closed to the tools that are never the Operator’s, signal or not', async () => {
    await setup('unblock');
    const { card } = await idleCard();
    await expect(
      h.domain.teamTools.operate(await operator(), {
        title: 'Settings',
        operation: { op: 'member_update', handle: 'dev-1', changes: { capacity: 2 } },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('allows one step: the second is refused with the budget, after the case holds again', async () => {
    await setup('unblock');
    const { card, signal } = await idleCard();
    await startIdle(card, signal);
    await developerIdles(OPERATOR_IDLE_MINUTES + OPERATOR_SIGNAL_STEP_GAP_MINUTES);
    await expect(startIdle(card, signal)).rejects.toMatchObject({
      code: 'forbidden',
      message: expect.stringContaining('operator_signal_budget'),
    });
    expect(roundSteps()).toHaveLength(1);
  });

  it('reports the signal closed once its case has ended', async () => {
    await setup('unblock');
    const { card, signal } = await idleCard();
    await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'task', taskKey: card.key });
    await expect(startIdle(card, signal)).rejects.toThrow('operator_signal_closed');
    expect(roundSteps()).toEqual([]);
  });

  it('starts the merger of a waiting merge through start_member on its card', async () => {
    await setup('unblock');
    const { card, signal } = await mergeCard('merge_waiting');
    const result = await startMerger(card, signal);
    expect(result.recipient.handle).toBe('dev-1');
    expect(h.repos.messages.get(result.messageId)).toMatchObject({
      from: 'pm',
      to: ['dev-1'],
      taskKey: card.key,
    });
    expect(roundSteps()).toMatchObject([
      { action: 'task_start', taskKey: card.key, member: 'dev-1', status: 'done', signalId: signal.id },
    ]);
  });

  it('serves a blocked merge as well, and only its merger', async () => {
    await setup('unblock');
    const { card, signal } = await mergeCard('merge_blocked');
    await expect(startMerger(card, signal, 'dev-2')).rejects.toThrow('operator_no_request');
    await startMerger(card, signal);
    expect(roundSteps()).toHaveLength(1);
  });

  it('lets one of two simultaneous calls on a signal through, the other waits for the step in progress', async () => {
    await setup('unblock');
    const { card, signal } = await idleCard();
    const results = await Promise.allSettled([startIdle(card, signal), startIdle(card, signal)]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ message: expect.stringContaining('operator_signal_budget') });
    expect(h.domain.sessions.list('AR', { member: 'dev-1' })).toHaveLength(1);
    expect(roundSteps()).toHaveLength(1);
  });

  it('starts the owner of a step that holds the card with start_member on the card', async () => {
    await setup('unblock');
    const card = await place({ stageId: 'code_review', status: 'waiting' });
    later(OPERATOR_IDLE_MINUTES);
    await h.domain.operatorSignals.sweep('AR');
    await flush();
    const signal = open('idle')[0]!;
    await expect(startIdle(card, signal)).rejects.toThrow('operator_no_request');
    const result = await startMerger(card, signal, 'cr');
    expect(result.recipient.handle).toBe('cr');
    expect(roundSteps()).toMatchObject([
      { action: 'task_start', taskKey: card.key, member: 'cr', status: 'done', signalId: signal.id },
    ]);
  });

  it('does not cover the board kinds that only drive covers', async () => {
    await setup('unblock');
    const { card } = await idleCard();
    const signal = h.domain.operatorSignals.raise({
      projectKey: 'AR',
      kind: 'unreleased',
      caseKey: 'unreleased:main',
      taskKey: null,
      subject: '2',
    });
    await expect(startMerger(card, signal)).rejects.toThrow(/operator_no_request|operator_signal_closed/);
  });
});

describe('level drive', () => {
  it('allows three steps on one signal, at least half an hour apart', async () => {
    await setup('drive');
    const { card, signal } = await idleCard();
    const again = async () => {
      await developerIdles(OPERATOR_IDLE_MINUTES + OPERATOR_SIGNAL_STEP_GAP_MINUTES);
      return startIdle(card, signal);
    };
    await startIdle(card, signal);
    await again();
    await again();
    expect(roundSteps()).toHaveLength(3);
    await expect(again()).rejects.toMatchObject({
      message: expect.stringContaining('operator_signal_budget'),
    });
    expect(roundSteps()).toHaveLength(3);
  });

  it('takes the next step only once the idle case stands again', async () => {
    await setup('drive');
    const { card, signal } = await idleCard();
    await startIdle(card, signal);
    // The idle time and the step gap are both half an hour, so the shared rule's `too_soon` has its own unit test.
    await developerIdles(OPERATOR_IDLE_MINUTES - 1);
    await expect(startIdle(card, signal)).rejects.toThrow('operator_signal_closed');
    later(1);
    await expect(startIdle(card, signal)).resolves.toBeDefined();
  });

  it('starts the project manager for cards that stand ready, and nobody else', async () => {
    await setup('drive', {
      adjust: (config) => {
        config.pipeline.stages.splice(1, 0, {
          id: 'ready',
          name: 'Ready',
          kind: 'queue',
          owners: ['owner'],
          columnId: 'todo',
        });
        const pm = config.team.members.find((m) => m.handle === 'pm')!;
        config.team.members.push({ ...pm, handle: 'pm-2', displayName: 'Second PM' });
      },
    });
    await place({ stageId: 'ready', status: 'active' });
    await h.domain.operatorSignals.sweep('AR');
    later(OPERATOR_READY_WAITING_MINUTES);
    await h.domain.operatorSignals.sweep('AR');
    await flush();
    const signal = open('ready_waiting')[0]!;
    await expect(
      h.domain.teamTools.startMember(await operator(), {
        member: 'dev-1',
        text: 'Take it.',
        signalId: signal.id,
      }),
    ).rejects.toThrow('operator_no_request');
    const result = await h.domain.teamTools.startMember(await operator(), {
      member: 'pm-2',
      text: 'Cards stand ready.',
      signalId: signal.id,
    });
    expect(result.recipient.handle).toBe('pm-2');
    expect(roundSteps()).toMatchObject([
      { action: 'task_start', taskKey: null, member: 'pm-2', status: 'done', signalId: signal.id },
    ]);
  });
});

describe('start_member on a card', () => {
  it('needs a role on the card for the member it starts, also on an owner request', async () => {
    await setup('report');
    const card = await place({ stageId: 'development', status: 'active', assignee: 'dev-1' });
    await h.domain.messaging.sendReporting(
      'AR',
      'owner',
      { to: ['pm'], text: 'Wake dev-2.' },
      { awaitWake: true },
    );
    await flush();
    const ask = async (member: string) =>
      h.domain.teamTools.startMember(await operator(), { member, text: 'Look.', taskKey: card.key });
    await expect(ask('dev-2')).rejects.toMatchObject({
      code: 'invalid',
      message: expect.stringContaining('not_card_role'),
    });
    expect(h.domain.sessions.list('AR', { member: 'dev-2' })).toEqual([]);
    await expect(ask('dev-1')).resolves.toMatchObject({ recipient: { handle: 'dev-1' } });
  });
});

describe('migration 57', () => {
  it('keeps the old requests and steps, allows the signal source and leaves no dangling reference', () => {
    const db = new Database(':memory:');
    try {
      const before = migrations.filter((item) => item.version < 57);
      for (const migration of before) db.exec(migration.sql);
      db.pragma(`user_version = ${Math.max(...before.map((item) => item.version))}`);
      db.exec(`INSERT INTO projects VALUES ('AR', 'Example', NULL, 'v1', '2026-01-01', '2026-01-01');
        INSERT INTO operator_requests (id, project_key, session_id, source, from_handle, quote, opened_at)
          VALUES ('opr_1', 'AR', 'ses_1', 'message', 'owner', 'Do it', '2026-01-01T00:00:00.000Z');
        INSERT INTO operator_steps (id, request_id, at, action, status)
          VALUES ('ops_1', 'opr_1', '2026-01-01T00:01:00.000Z', 'task_start', 'done');
        INSERT INTO operator_signals (id, project_key, kind, case_key, state, raised_at)
          VALUES ('sig_1', 'AR', 'idle', 'idle:AR-1:development', 'open', '2026-01-01T00:00:00.000Z');`);
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      const repos = createRepositories(db);
      expect(repos.operatorRequests.steps('opr_1')).toMatchObject([
        { id: 'ops_1', action: 'task_start', status: 'done', signalId: null },
      ]);
      expect(repos.operatorSignals.get('sig_1')).toMatchObject({
        caseKey: 'idle:AR-1:development',
        followUpAt: null,
      });
      db.prepare(
        `INSERT INTO operator_requests (id, project_key, session_id, source, from_handle, quote, opened_at)
          VALUES ('opr_2', 'AR', 'ses_1', 'signal', '@signals', '', '2026-01-02T00:00:00.000Z')`,
      ).run();
      db.prepare(
        `INSERT INTO operator_steps (id, request_id, at, action, status, signal_id)
          VALUES ('ops_2', 'opr_2', '2026-01-02T00:01:00.000Z', 'task_start', 'done', 'sig_1')`,
      ).run();
      expect(repos.operatorRequests.stepsOfSignal('sig_1')).toMatchObject([
        { id: 'ops_2', signalId: 'sig_1' },
      ]);
      expect(() =>
        db
          .prepare(
            `INSERT INTO operator_requests (id, project_key, session_id, source, from_handle, quote, opened_at)
              VALUES ('opr_3', 'AR', 'ses_1', 'bogus', 'x', '', '2026-01-02T00:00:00.000Z')`,
          )
          .run(),
      ).toThrow();
    } finally {
      db.close();
    }
  });
});

describe('follow-up', () => {
  it('shows the signal to the Operator again when the case still stands after the gap', async () => {
    await setup('unblock');
    const { card, signal } = await idleCard();
    await startIdle(card, signal);
    await developerIdles(OPERATOR_IDLE_MINUTES + OPERATOR_SIGNAL_STEP_GAP_MINUTES);
    const operatorSession = (await operator()).sessionId;
    h.runner.setState(operatorSession, 'working');
    h.runner.setState(operatorSession, 'idle');
    await flush();
    expect(h.repos.operatorSignals.get(signal.id)).toMatchObject({ state: 'open' });
    await h.domain.operatorSignals.deliver('AR');
    await flush();
    expect(h.repos.operatorSignals.get(signal.id)).toMatchObject({
      state: 'pending',
      messageId: null,
      actionable: false,
      followUpAt: null,
      deliveredAt: now.toISOString(),
    });
  });

  it('does not show a signal again whose case has ended', async () => {
    await setup('unblock');
    const { card, signal } = await idleCard();
    await startIdle(card, signal);
    later(OPERATOR_SIGNAL_STEP_GAP_MINUTES);
    // The started session was active just now, so the idle case does not hold.
    await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'task', taskKey: card.key });
    const delivered = h.repos.operatorSignals.get(signal.id)!.deliveredAt;
    await h.domain.operatorSignals.deliver('AR');
    expect(h.repos.operatorSignals.get(signal.id)).toMatchObject({ deliveredAt: delivered });
  });
});
