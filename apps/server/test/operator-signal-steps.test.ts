import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { OPERATOR_SIGNAL_ROUND_FROM, OPERATOR_SIGNAL_STEP_GAP_MINUTES } from '@projectman/shared';
import type { ObligationKind, OperatorWatch, ProjectConfig, Task } from '@projectman/shared';

import type { ToolContext } from '../src/contracts';
import { createRepositories, LATEST_SCHEMA_VERSION, migrate } from '../src/db';
import type { MergeRecord } from '../src/db';
import { migrations } from '../src/db/migrations';
import { OperatorRequests } from '../src/services/coordination';
import { createDomainHarness, OWNER_ACTOR, waitForSession } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';
import { openOverdueObligation } from './helpers/overdue-obligation';

/** PM-545: the Operator's own steps on a system signal, without an owner's request. */
let h: DomainHarness;
let now: Date;
afterEach(async () => {
  await h?.cleanup();
});

const later = (minutes: number) => {
  now = new Date(now.getTime() + minutes * 60_000);
};

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

/**
 * A card with an open step of `responsible` that the PM has been told about (PM-1152): the obligation row stands
 * at its second rung, and its `obligation_overdue` signal has been raised and delivered to the Operator.
 */
async function overdueCard(
  opts: {
    patch?: Partial<Pick<Task, 'stageId' | 'status' | 'assignee'>>;
    kind?: ObligationKind;
    responsible?: string;
  } = {},
) {
  const card = await place(opts.patch ?? { stageId: 'development', status: 'active', assignee: 'dev-1' });
  const { id, signalId } = openOverdueObligation(h, card, { at: now, ...opts });
  await h.domain.operatorSignals.deliver('AR');
  await flush();
  return { card, id, signal: h.repos.operatorSignals.get(signalId)! };
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

/** A card with a blocked merge, whose signal has been raised and delivered. */
async function blockedMergeCard() {
  const card = await place({ stageId: 'code_review', status: 'waiting' });
  h.repos.taskMerges.save(mergeRow(card.key, { state: 'failed' }));
  await h.domain.operatorSignals.sweep('AR');
  await flush();
  const signal = h.repos.operatorSignals.list('AR').find((s) => s.kind === 'merge_blocked' && !s.resolvedAt)!;
  return { card, signal };
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
const startAssignee = async (card: Task, signal: { id: string }, ctx?: ToolContext) =>
  h.domain.teamTools.startTask(ctx ?? (await operator()), { taskKey: card.key, signalId: signal.id });
const startMerger = async (card: Task, signal: { id: string }, member = 'dev-1') =>
  h.domain.teamTools.startMember(await operator(), {
    member,
    text: 'The step waits for you.',
    taskKey: card.key,
    signalId: signal.id,
  });

describe('level report', () => {
  it('refuses a step on a signal like any write without an owner request', async () => {
    await setup('report');
    const { card, signal } = await overdueCard();
    await expect(startAssignee(card, signal)).rejects.toMatchObject({
      code: 'forbidden',
      message: expect.stringContaining('operator_no_request'),
    });
    expect(h.domain.sessions.list('AR', { member: 'dev-1' })).toEqual([]);
    expect(roundSteps()).toEqual([]);
  });

  it('is the default when the project sets no level', async () => {
    await setup(undefined);
    const { card, signal } = await overdueCard();
    await expect(startAssignee(card, signal)).rejects.toMatchObject({
      message: expect.stringContaining('operator_no_request'),
    });
  });
});

describe('level unblock', () => {
  it('starts the overdue work’s assignee, logs the step with the signal and schedules the follow-up', async () => {
    await setup('unblock');
    const { card, signal } = await overdueCard();
    await startAssignee(card, signal);
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
    const { card, signal } = await overdueCard();
    await startAssignee(card, signal);
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
    const { card, signal } = await overdueCard();
    const other = await place({ stageId: 'development', status: 'active', assignee: 'dev-1' });
    for (const call of [
      () => startAssignee(other, signal),
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
    const { card, signal } = await overdueCard();
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
    await overdueCard();
    await expect(
      h.domain.teamTools.operate(await operator(), {
        title: 'Settings',
        operation: { op: 'member_update', handle: 'dev-1', changes: { capacity: 2 } },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('allows one step: the second is refused with the budget, even after the gap', async () => {
    await setup('unblock');
    const { card, signal } = await overdueCard();
    await startAssignee(card, signal);
    later(OPERATOR_SIGNAL_STEP_GAP_MINUTES);
    await expect(startAssignee(card, signal)).rejects.toMatchObject({
      code: 'forbidden',
      message: expect.stringContaining('operator_signal_budget'),
    });
    expect(roundSteps()).toHaveLength(1);
  });

  it.each(['fulfilled', 'cancelled'] as const)(
    'reports the signal closed once its obligation is %s',
    async (state) => {
      await setup('unblock');
      const { card, id, signal } = await overdueCard();
      h.repos.obligations.close(id, state, now.toISOString());
      await expect(startAssignee(card, signal)).rejects.toThrow('operator_signal_closed');
      expect(roundSteps()).toEqual([]);
    },
  );

  it('reports the signal closed once the obligation is handed over to the integrator', async () => {
    await setup('unblock');
    const { card, id, signal } = await overdueCard();
    h.repos.obligations.update(id, { handedOverAt: now.toISOString() }, now.toISOString());
    h.repos.obligations.close(id, 'cancelled', now.toISOString());
    await expect(startAssignee(card, signal)).rejects.toThrow('operator_signal_closed');
  });

  it('starts the responsible of a non-work step through start_member on its card', async () => {
    await setup('unblock');
    const { card, signal } = await overdueCard({
      patch: { stageId: 'code_review', status: 'waiting' },
      kind: 'merge',
      responsible: 'dev-1',
    });
    h.repos.taskMerges.save(mergeRow(card.key));
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
    const { card, signal } = await blockedMergeCard();
    await expect(startMerger(card, signal, 'dev-2')).rejects.toThrow('operator_no_request');
    await startMerger(card, signal);
    expect(roundSteps()).toHaveLength(1);
  });

  it('lets one of two simultaneous calls on a signal through, the other waits for the step in progress', async () => {
    await setup('unblock');
    const { card, signal } = await overdueCard();
    const results = await Promise.allSettled([startAssignee(card, signal), startAssignee(card, signal)]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ message: expect.stringContaining('operator_signal_budget') });
    expect(h.domain.sessions.list('AR', { member: 'dev-1' })).toHaveLength(1);
    expect(roundSteps()).toHaveLength(1);
  });

  it('starts the owner of a review step with start_member on the card, not with start_task', async () => {
    await setup('unblock');
    const { card, signal } = await overdueCard({
      patch: { stageId: 'code_review', status: 'waiting' },
      kind: 'review_step',
      responsible: 'cr',
    });
    await expect(startAssignee(card, signal)).rejects.toThrow('operator_no_request');
    const result = await startMerger(card, signal, 'cr');
    expect(result.recipient.handle).toBe('cr');
    expect(roundSteps()).toMatchObject([
      { action: 'task_start', taskKey: card.key, member: 'cr', status: 'done', signalId: signal.id },
    ]);
  });

  it('does not cover the board kinds that only drive covers', async () => {
    await setup('unblock');
    const { card } = await overdueCard();
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
    const { card, signal } = await overdueCard();
    const again = async () => {
      later(OPERATOR_SIGNAL_STEP_GAP_MINUTES);
      return startAssignee(card, signal);
    };
    await startAssignee(card, signal);
    await again();
    await again();
    expect(roundSteps()).toHaveLength(3);
    await expect(again()).rejects.toMatchObject({
      message: expect.stringContaining('operator_signal_budget'),
    });
    expect(roundSteps()).toHaveLength(3);
  });

  it('takes the next step only after the gap', async () => {
    await setup('drive');
    const { card, signal } = await overdueCard();
    await startAssignee(card, signal);
    later(OPERATOR_SIGNAL_STEP_GAP_MINUTES - 1);
    await expect(startAssignee(card, signal)).rejects.toThrow('operator_signal_budget');
    later(1);
    await expect(startAssignee(card, signal)).resolves.toBeDefined();
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
    const { card, signal } = await overdueCard();
    await startAssignee(card, signal);
    later(OPERATOR_SIGNAL_STEP_GAP_MINUTES);
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
    const { card, id, signal } = await overdueCard();
    await startAssignee(card, signal);
    later(OPERATOR_SIGNAL_STEP_GAP_MINUTES);
    h.repos.obligations.close(id, 'fulfilled', now.toISOString());
    const delivered = h.repos.operatorSignals.get(signal.id)!.deliveredAt;
    await h.domain.operatorSignals.deliver('AR');
    expect(h.repos.operatorSignals.get(signal.id)).toMatchObject({ deliveredAt: delivered });
  });
});
