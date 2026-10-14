import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OPERATOR_IDLE_MINUTES,
  OPERATOR_MERGE_WAIT_MINUTES,
  OPERATOR_READY_WAITING_MINUTES,
  OPERATOR_UNRELEASED_HOURS,
} from '@projectman/shared';
import type { OperatorSignalKind, ProjectConfig, Task } from '@projectman/shared';
import { createRepositories, LATEST_SCHEMA_VERSION, migrate } from '../src/db';
import { waitFor } from '../src/runner/test-helpers';
import type { MergeRecord } from '../src/db';
import { migrations } from '../src/db/migrations';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

/** PM-547: the board kinds of the Operator's system signals, raised and closed by the sweep. */
let h: DomainHarness;
let now: Date;
afterEach(async () => {
  await h?.cleanup();
});

const sha = (n: number) => n.toString(16).padStart(40, '0');
const later = (minutes: number) => {
  now = new Date(now.getTime() + minutes * 60_000);
};
const sweep = async () => {
  await h.domain.operatorSignals.sweep('AR');
  await flush();
};
const open = (kind: OperatorSignalKind) =>
  h.repos.operatorSignals.list('AR').filter((s) => s.kind === kind && !s.resolvedAt);
const config = () => h.domain.projects.cachedConfig('AR')!;
const onLeave = (handle: string) => {
  const member = config().team.members.find((m) => m.handle === handle);
  if (member?.kind === 'ai') member.onLeave = true;
};

async function setup(
  opts: { adjust?: (config: ProjectConfig) => void; target?: boolean; appVersion?: string } = {},
) {
  now = new Date('2026-10-11T10:00:00Z');
  h = await createDomainHarness({
    now: () => now,
    ...(opts.target ? { releaseTarget: { projectKey: 'AR', repo: 'web' } } : {}),
    ...(opts.appVersion ? { appVersion: opts.appVersion } : {}),
    ...(opts.adjust ? { adjust: opts.adjust } : {}),
  });
}

/** A card put straight into a stage, as it would stand after a move. */
async function place(patch: Partial<Pick<Task, 'stageId' | 'status' | 'assignee'>>): Promise<Task> {
  const card = await h.domain.tasks.create('AR', { title: 'Card', repo: 'web' }, OWNER_ACTOR);
  h.repos.tasks.update(card.id, { ...patch, updatedAt: now.toISOString() });
  return h.repos.tasks.get(card.key)!;
}
const develop = () => place({ stageId: 'development', status: 'active', assignee: 'dev-1' });

describe('idle card signal', () => {
  it('rises at thirty minutes for the assignee and closes when a session starts', async () => {
    await setup();
    const card = await develop();
    later(OPERATOR_IDLE_MINUTES - 1);
    await sweep();
    expect(open('idle')).toEqual([]);
    later(1);
    await sweep();
    expect(open('idle')).toMatchObject([
      { caseKey: `idle:${card.key}:development`, taskKey: card.key, subject: 'dev-1' },
    ]);
    await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'task', taskKey: card.key });
    await sweep();
    expect(open('idle')).toEqual([]);
  });

  it('counts from the latest session activity', async () => {
    await setup();
    const card = await develop();
    later(20);
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', {
      type: 'task',
      taskKey: card.key,
    });
    h.runner.setState(session.id, 'working');
    h.runner.setState(session.id, 'idle');
    later(OPERATOR_IDLE_MINUTES - 1);
    await sweep();
    expect(open('idle')).toEqual([]);
  });

  it('rises for the owner of a step that holds the card (queued)', async () => {
    await setup();
    const card = await place({ stageId: 'code_review', status: 'waiting' });
    later(OPERATOR_IDLE_MINUTES);
    await sweep();
    expect(open('idle')).toMatchObject([{ caseKey: `idle:${card.key}:code_review`, subject: 'cr' }]);
  });

  it('rises for the step owner whose idle session holds the card', async () => {
    await setup();
    const card = await place({ stageId: 'code_review', status: 'waiting' });
    const { session } = await h.domain.sessions.ensureSession('AR', 'cr', {
      type: 'task',
      taskKey: card.key,
    });
    h.runner.setState(session.id, 'idle');
    later(OPERATOR_IDLE_MINUTES - 1);
    await sweep();
    expect(open('idle')).toEqual([]);
    later(1);
    await sweep();
    expect(open('idle')).toMatchObject([{ caseKey: `idle:${card.key}:code_review`, subject: 'cr' }]);
  });

  it('does not rise when the card waits for an answer, a start, a person or nobody', async () => {
    await setup();
    const asked = await develop();
    h.domain.inbox.create({
      projectKey: 'AR',
      kind: 'alert',
      assignees: ['owner'],
      source: 'dev-1',
      taskKey: asked.key,
      title: 'Many tokens',
      payload: {
        alert: 'session_tokens',
        countedTokens: 2,
        limitTokens: 1,
        workItem: { type: 'task', taskKey: asked.key },
        sessionStartedAt: now.toISOString(),
      },
      options: [{ id: 'seen', label: 'seen', style: 'primary' }],
    });
    // A start the AI limit holds back is the board's wait, not idleness.
    const starting = await h.domain.tasks.create('AR', { title: 'Starting', repo: 'web' }, OWNER_ACTOR);
    config().team.limits.maxConcurrentAi = 0;
    await h.domain.tasks.moveToStage('AR', starting.key, 'development', OWNER_ACTOR);
    await waitFor(() => h.domain.tasks.get('AR', starting.key).startWaiting);
    config().team.limits.maxConcurrentAi = 3;
    await place({ stageId: 'development', status: 'active', assignee: 'owner' });
    await place({ stageId: 'code_review', status: 'waiting' }).then((card) => {
      // A step nobody owns.
      config().pipeline.stages.find((s) => s.id === 'merge')!.owners = [];
      h.repos.tasks.update(card.id, { stageId: 'merge' });
    });
    later(OPERATOR_IDLE_MINUTES * 2);
    await sweep();
    expect(open('idle')).toEqual([]);
  });

  it('does not rise for a member on leave', async () => {
    await setup();
    await develop();
    onLeave('dev-1');
    later(OPERATOR_IDLE_MINUTES);
    await sweep();
    expect(open('idle')).toEqual([]);
  });

  it.each(['paused', 'ai off'])(
    'does not rise while the team is %s, and a raised one closes',
    async (how) => {
      await setup();
      await develop();
      later(OPERATOR_IDLE_MINUTES);
      await sweep();
      expect(open('idle')).toHaveLength(1);
      if (how === 'paused')
        await h.domain.pauses.pause(
          { scope: 'project', projectKey: 'AR' },
          { source: 'system', userId: null },
        );
      else config().team.limits.aiEnabled = false;
      await sweep();
      expect(open('idle')).toEqual([]);
    },
  );
});

function merge(over: Partial<MergeRecord> & Pick<MergeRecord, 'taskKey' | 'state'>): MergeRecord {
  return {
    id: `mrg_${over.taskKey}`,
    projectKey: 'AR',
    repo: 'web',
    base: 'main',
    commit: `branch-${over.taskKey}`,
    branch: `pm/${over.taskKey}`,
    fromStageId: 'code_review',
    toStageId: 'done',
    merger: 'dev-1',
    requestedAt: now.toISOString(),
    landed: 'nowhere',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...over,
  };
}

describe('merge signals', () => {
  it('merge_waiting rises after thirty minutes of requested, and closes when the merge starts', async () => {
    await setup();
    const card = await place({ stageId: 'code_review', status: 'waiting' });
    h.repos.taskMerges.save(merge({ taskKey: card.key, state: 'requested' }));
    later(OPERATOR_MERGE_WAIT_MINUTES - 1);
    await sweep();
    expect(open('merge_waiting')).toEqual([]);
    later(1);
    await sweep();
    expect(open('merge_waiting')).toMatchObject([
      { caseKey: `merge_waiting:${card.key}`, taskKey: card.key, subject: 'dev-1' },
    ]);
    h.repos.taskMerges.save(
      merge({ taskKey: card.key, state: 'running', startedBy: 'dev-1', startedAt: now.toISOString() }),
    );
    await sweep();
    expect(open('merge_waiting')).toEqual([]);
  });

  it('merge_waiting does not rise when the merger is a person, or the merge has started', async () => {
    await setup();
    const a = await place({ stageId: 'code_review', status: 'waiting' });
    const b = await place({ stageId: 'code_review', status: 'waiting' });
    h.repos.taskMerges.save(merge({ taskKey: a.key, state: 'requested', merger: 'owner' }));
    h.repos.taskMerges.save(
      merge({ taskKey: b.key, state: 'queued', startedBy: 'dev-1', startedAt: now.toISOString() }),
    );
    later(OPERATOR_MERGE_WAIT_MINUTES * 2);
    await sweep();
    expect(open('merge_waiting')).toEqual([]);
  });

  it('merge_blocked rises at once for failed and blocked, not for fixing, and closes when the request moves on', async () => {
    await setup();
    const failed = await place({ stageId: 'code_review', status: 'waiting' });
    const blocked = await place({ stageId: 'code_review', status: 'waiting' });
    const fixing = await place({ stageId: 'code_review', status: 'waiting' });
    const human = await place({ stageId: 'code_review', status: 'waiting' });
    h.repos.taskMerges.save(
      merge({
        taskKey: failed.key,
        state: 'failed',
        failure: { reason: 'conflict', at: now.toISOString(), base: sha(1) },
      }),
    );
    h.repos.taskMerges.save(
      merge({
        taskKey: blocked.key,
        state: 'blocked',
        block: { reason: 'push_rejected', message: 'rejected', at: now.toISOString() },
      }),
    );
    h.repos.taskMerges.save(
      merge({
        taskKey: fixing.key,
        state: 'fixing',
        fix: { by: 'dev-1', base: sha(1), branch: 'fix', startedAt: now.toISOString() },
      }),
    );
    h.repos.taskMerges.save(
      merge({
        taskKey: human.key,
        state: 'failed',
        merger: 'owner',
        failure: { reason: 'check_failed', at: now.toISOString(), base: sha(1) },
      }),
    );
    await sweep();
    expect(open('merge_blocked').map((s) => [s.caseKey, s.subject])).toEqual([
      [`merge_blocked:${failed.key}`, 'conflict'],
      [`merge_blocked:${blocked.key}`, 'push_rejected'],
    ]);
    h.repos.taskMerges.save(merge({ taskKey: failed.key, state: 'fixing' }));
    h.repos.taskMerges.save(merge({ taskKey: blocked.key, state: 'merged', finishedAt: now.toISOString() }));
    await sweep();
    expect(open('merge_blocked')).toEqual([]);
  });
});

function merged(index: number, finishedAt: string) {
  const key = `AR-${index}`;
  h.repos.taskMerges.save(
    merge({
      id: `mrg_${index}`,
      taskKey: key,
      state: 'merged',
      startedBy: 'dev-1',
      startedAt: finishedAt,
      mergeCommit: sha(index),
      finishedAt,
    }),
  );
}

describe('unreleased signal', () => {
  const MERGES = [
    [1, '2026-10-01T00:00:00.000Z'],
    [2, '2026-10-02T00:00:00.000Z'],
    [3, '2026-10-03T00:00:00.000Z'],
  ] as const;

  it('rises for work merged after the running version for a day, and closes on a new live release', async () => {
    await setup({ target: true, appVersion: sha(1) });
    for (const [index, at] of MERGES) merged(index, at);
    expect(h.domain.releases.unreleased('AR')).toEqual({
      base: sha(1),
      count: 2,
      oldestAt: '2026-10-02T00:00:00.000Z',
      taskKeys: ['AR-2', 'AR-3'],
    });
    await sweep();
    expect(open('unreleased')).toMatchObject([
      { caseKey: `unreleased:${sha(1)}`, taskKey: null, subject: '2' },
    ]);
    h.repos.releases.insert(
      {
        id: 'rel_1',
        projectKey: 'AR',
        repo: 'web',
        taskKey: 'AR-3',
        state: 'live',
        commit: sha(3),
        baseCommit: sha(1),
        tasks: ['AR-2', 'AR-3'],
        summary: 'Summary',
        proposedBy: 'dev-1',
        proposedAt: now.toISOString(),
        decidedBy: null,
        decidedAt: null,
        deployStartedAt: null,
        previousCommit: null,
        liveAt: now.toISOString(),
        tag: null,
        url: null,
        publishedAt: null,
        failure: null,
        publishError: null,
      },
      now.toISOString(),
    );
    await sweep();
    expect(open('unreleased')).toEqual([]);
  });

  it('waits for the day', async () => {
    await setup({ target: true, appVersion: sha(1) });
    merged(1, '2026-10-01T00:00:00.000Z');
    merged(2, new Date(now.getTime() - (OPERATOR_UNRELEASED_HOURS * 60 - 1) * 60_000).toISOString());
    await sweep();
    expect(open('unreleased')).toEqual([]);
    later(1);
    await sweep();
    expect(open('unreleased')).toHaveLength(1);
  });

  it.each([
    ['no release target', { target: false, appVersion: sha(1) }],
    ['an unknown base', { target: true, appVersion: 'dev' }],
    ['a base that never landed', { target: true, appVersion: sha(9) }],
  ])('does not rise with %s', async (_name, opts) => {
    await setup(opts);
    for (const [index, at] of MERGES) merged(index, at);
    await sweep();
    expect(h.domain.releases.unreleased('AR')).toBeNull();
    expect(open('unreleased')).toEqual([]);
  });

  it('does not rise while a release is open', async () => {
    await setup({ target: true, appVersion: sha(1) });
    for (const [index, at] of MERGES) merged(index, at);
    h.repos.releases.insert(
      {
        id: 'rel_1',
        projectKey: 'AR',
        repo: 'web',
        taskKey: 'AR-3',
        state: 'proposed',
        commit: sha(3),
        baseCommit: sha(1),
        tasks: ['AR-2', 'AR-3'],
        summary: 'Summary',
        proposedBy: 'dev-1',
        proposedAt: now.toISOString(),
        decidedBy: null,
        decidedAt: null,
        deployStartedAt: null,
        previousCommit: null,
        liveAt: null,
        tag: null,
        url: null,
        publishedAt: null,
        failure: null,
        publishError: null,
      },
      now.toISOString(),
    );
    await sweep();
    expect(open('unreleased')).toEqual([]);
  });
});

describe('ready_waiting signal', () => {
  /** A queue between the backlog and the development stage, so a card can stand ready in it. */
  const withReadyQueue = (config: ProjectConfig) => {
    config.pipeline.stages.splice(1, 0, {
      id: 'ready',
      name: 'Ready',
      kind: 'queue',
      owners: ['owner'],
      columnId: 'todo',
    });
  };

  it('is raised at once but wakes the Operator only after thirty minutes', async () => {
    await setup({ adjust: withReadyQueue });
    const card = await place({ stageId: 'ready', status: 'active' });
    await sweep();
    expect(open('ready_waiting')).toMatchObject([
      { caseKey: `ready_waiting:${card.key}`, taskKey: null, subject: card.key },
    ]);
    later(OPERATOR_READY_WAITING_MINUTES - 1);
    await sweep();
    expect(h.runner.started).toEqual([]);
    expect(open('ready_waiting')[0]!.deliveredAt).toBeNull();
    later(1);
    await sweep();
    expect(h.runner.started).toHaveLength(1);
    expect(open('ready_waiting')[0]!.deliveredAt).not.toBeNull();
  });

  const deliverReady = async () => {
    await sweep();
    later(OPERATOR_READY_WAITING_MINUTES);
    await sweep();
    return open('ready_waiting')[0]!;
  };

  it('sorts the full card set numerically in the key and subject', async () => {
    await setup({ adjust: withReadyQueue });
    for (let index = 1; index <= 10; index++)
      await place({ stageId: index === 2 || index === 10 ? 'ready' : 'backlog', status: 'active' });
    await sweep();
    expect(open('ready_waiting')).toMatchObject([
      { caseKey: 'ready_waiting:AR-2,AR-10', subject: 'AR-2,AR-10' },
    ]);
  });

  it('acknowledges dismissal across capacity changes and starting an acknowledged card', async () => {
    await setup({ adjust: withReadyQueue });
    const card = await place({ stageId: 'ready', status: 'active' });
    const signal = await deliverReady();
    expect(h.domain.operatorSignals.dismissByOperator('AR', signal.id, 'operator', 'Parked.')).toMatchObject({
      state: 'dismissed',
    });
    expect(h.repos.operatorSignals.get(signal.id)).toMatchObject({
      decidedBy: 'operator',
      decisionNote: 'Parked.',
    });
    await sweep();
    expect(open('ready_waiting')).toEqual([]);
    config().team.limits.maxConcurrentAi = 0;
    await sweep();
    config().team.limits.maxConcurrentAi = 3;
    await sweep();
    expect(open('ready_waiting')).toEqual([]);
    h.repos.tasks.update(card.id, { stageId: 'development', assignee: 'dev-1' });
    await sweep();
    expect(open('ready_waiting')).toEqual([]);
    expect(h.repos.operatorSignals.list('AR').filter((s) => s.kind === 'ready_waiting')).toHaveLength(1);
  });

  it('raises a new signal for the full set when another card becomes ready', async () => {
    await setup({ adjust: withReadyQueue });
    const first = await place({ stageId: 'ready', status: 'active' });
    const signal = await deliverReady();
    h.domain.operatorSignals.dismissByOperator('AR', signal.id, 'operator', 'Parked.');
    later(1);
    const second = await place({ stageId: 'ready', status: 'active' });
    await sweep();
    expect(open('ready_waiting')).toMatchObject([
      { caseKey: `ready_waiting:${first.key},${second.key}`, subject: `${first.key},${second.key}` },
    ]);
    expect(h.repos.operatorSignals.get(signal.id)).toMatchObject({
      state: 'dismissed',
      resolvedAt: now.toISOString(),
    });
  });

  it.each([true, false])(
    'raises again for a card that re-enters after dismissal (intermediate sweep: %s)',
    async (intermediateSweep) => {
      await setup({ adjust: withReadyQueue });
      const card = await place({ stageId: 'ready', status: 'active' });
      const signal = await deliverReady();
      h.domain.operatorSignals.dismissByOperator('AR', signal.id, 'operator', 'Parked.');
      h.repos.tasks.update(card.id, { stageId: 'backlog' });
      if (intermediateSweep) await sweep();
      later(1);
      h.repos.tasks.update(card.id, { stageId: 'ready', stageEnteredAt: now.toISOString() });
      await sweep();
      expect(open('ready_waiting')).toMatchObject([{ caseKey: `ready_waiting:${card.key}` }]);
      expect(open('ready_waiting')[0]!.id).not.toBe(signal.id);
    },
  );

  it('acknowledges the owner dismissal too', async () => {
    await setup({ adjust: withReadyQueue });
    await place({ stageId: 'ready', status: 'active' });
    const signal = await deliverReady();
    h.domain.operatorSignals.present('AR', signal.id, 'msg_1', false);
    h.domain.operatorSignals.decision('AR', signal.id, 'owner', false);
    await sweep();
    expect(open('ready_waiting')).toEqual([]);
    config().team.limits.maxConcurrentAi = 0;
    await sweep();
    config().team.limits.maxConcurrentAi = 3;
    await sweep();
    expect(open('ready_waiting')).toEqual([]);
  });

  it('resolves the old constant case key on the first sweep', async () => {
    await setup({ adjust: withReadyQueue });
    await place({ stageId: 'ready', status: 'active' });
    const old = h.domain.operatorSignals.raise({
      projectKey: 'AR',
      kind: 'ready_waiting',
      caseKey: 'ready_waiting',
      subject: 'dev-1,dev-2',
    });
    await sweep();
    expect(h.repos.operatorSignals.get(old.id)).toMatchObject({
      state: 'resolved',
      resolvedAt: now.toISOString(),
    });
    expect(open('ready_waiting')).toHaveLength(1);
  });

  it.each(['assignee', 'prerequisite', 'holding label', 'refinement', 'collector', 'gate'])(
    'does not signal a card blocked by %s',
    async (how) => {
      await setup({ adjust: withReadyQueue });
      const card = await place({ stageId: 'ready', status: 'active' });
      if (how === 'assignee') h.repos.tasks.update(card.id, { assignee: 'dev-1' });
      if (how === 'prerequisite') {
        const prerequisite = await place({ stageId: 'backlog', status: 'active' });
        h.repos.tasks.upsertLink(card.id, { kind: 'prerequisite', ref: prerequisite.key }, now.toISOString());
      }
      if (how === 'holding label' || how === 'refinement') {
        const label = how === 'refinement' ? 'refine' : 'hold';
        config().pipeline.labels.push({
          id: label,
          name: label,
          setBy: 'anyone',
          blocks: how === 'holding label',
        });
        h.repos.tasks.update(card.id, { labels: [label] });
      }
      if (how === 'collector') {
        const child = await place({ stageId: 'backlog', status: 'active' });
        h.repos.tasks.update(child.id, { parentKey: card.key });
      }
      if (how === 'gate')
        config().pipeline.stages.find((s) => s.id === 'development')!.gate = {
          conditions: [{ type: 'has_label', label: 'missing' }],
        };
      await sweep();
      expect(open('ready_waiting')).toEqual([]);
    },
  );

  it('refuses unknown and foreign signals before checking their kind', async () => {
    await setup();
    expect(() => h.domain.operatorSignals.dismissByOperator('AR', 'unknown', 'operator', 'Note')).toThrow(
      'unknown signal',
    );
    const other = h.domain.operatorSignals.raise({ projectKey: 'OTHER', kind: 'idle', caseKey: 'idle:x' });
    expect(() => h.domain.operatorSignals.dismissByOperator('AR', other.id, 'operator', 'Note')).toThrow(
      'unknown signal',
    );
    const idle = h.domain.operatorSignals.raise({ projectKey: 'AR', kind: 'idle', caseKey: 'idle:x' });
    expect(() => h.domain.operatorSignals.dismissByOperator('AR', idle.id, 'operator', 'Note')).toThrow(
      'may not dismiss this signal kind',
    );
  });

  it.each(['undelivered', 'presented', 'resolved', 'dismissed', 'accepted', 'case ended'])(
    'refuses a %s signal',
    async (how) => {
      await setup({ adjust: withReadyQueue });
      const card = await place({ stageId: 'ready', status: 'active' });
      await sweep();
      const signal = open('ready_waiting')[0]!;
      if (how !== 'undelivered') signal.deliveredAt = now.toISOString();
      if (how === 'presented') signal.messageId = 'msg_1';
      if (how === 'resolved') signal.resolvedAt = now.toISOString();
      if (how === 'dismissed' || how === 'accepted') signal.state = how;
      if (how === 'case ended') h.repos.tasks.update(card.id, { stageId: 'backlog' });
      h.repos.operatorSignals.save(signal);
      expect(() => h.domain.operatorSignals.dismissByOperator('AR', signal.id, 'operator', 'Note')).toThrow(
        'the signal is no longer open',
      );
    },
  );

  it('closes silently when the case ends before it is delivered', async () => {
    await setup({ adjust: withReadyQueue });
    const card = await place({ stageId: 'ready', status: 'active' });
    await sweep();
    h.repos.tasks.update(card.id, { stageId: 'backlog' });
    later(OPERATOR_READY_WAITING_MINUTES);
    await sweep();
    expect(open('ready_waiting')).toEqual([]);
    expect(h.runner.started).toEqual([]);
  });

  it('does not rise without a startable card, a free developer or room for another AI session', async () => {
    await setup({ adjust: withReadyQueue });
    await sweep();
    expect(open('ready_waiting')).toEqual([]);
    // The first stage's cards do not count: only a card in a later queue before a work stage.
    await place({ stageId: 'backlog', status: 'active' });
    await sweep();
    expect(open('ready_waiting')).toEqual([]);
    await place({ stageId: 'ready', status: 'active' });
    config().team.limits.maxConcurrentAi = 0;
    await sweep();
    expect(open('ready_waiting')).toEqual([]);
    config().team.limits.maxConcurrentAi = 3;
    for (const handle of ['dev-1', 'dev-2']) onLeave(handle);
    await sweep();
    expect(open('ready_waiting')).toEqual([]);
  });

  it('does not count a developer at capacity', async () => {
    await setup({ adjust: withReadyQueue });
    await place({ stageId: 'ready', status: 'active' });
    for (const handle of ['dev-1', 'dev-2']) {
      const busy = await place({ stageId: 'development', status: 'active', assignee: handle });
      await h.domain.sessions.ensureSession('AR', handle, { type: 'task', taskKey: busy.key });
    }
    await sweep();
    expect(open('ready_waiting')).toEqual([]);
  });
});

describe('operator_signals migration', () => {
  it('keeps the old rows and accepts the new kinds', () => {
    const db = new Database(':memory:');
    try {
      const before = migrations.filter((item) => item.version < 56);
      for (const migration of before) db.exec(migration.sql);
      db.pragma(`user_version = ${Math.max(...before.map((item) => item.version))}`);
      db.exec(`INSERT INTO projects VALUES ('AR', 'Example', NULL, 'v1', '2026-01-01', '2026-01-01');
        INSERT INTO operator_signals (id, project_key, kind, case_key, state, raised_at)
          VALUES ('ops_1', 'AR', 'silent', 'silent:ses_1', 'open', '2026-01-01T00:00:00.000Z');`);
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      const repos = createRepositories(db);
      expect(repos.operatorSignals.get('ops_1')).toMatchObject({ kind: 'silent', caseKey: 'silent:ses_1' });
      for (const kind of ['idle', 'merge_waiting', 'merge_blocked', 'unreleased', 'ready_waiting'] as const)
        db.prepare(
          `INSERT INTO operator_signals (id, project_key, kind, case_key, state, raised_at) VALUES (?, 'AR', ?, ?, 'pending', '2026-01-02T00:00:00.000Z')`,
        ).run(`ops_${kind}`, kind, `${kind}:x`);
      expect(repos.operatorSignals.list('AR')).toHaveLength(6);
      expect(() =>
        db
          .prepare(
            `INSERT INTO operator_signals (id, project_key, kind, case_key, state, raised_at) VALUES ('ops_bad', 'AR', 'bogus', 'x', 'pending', '2026-01-02T00:00:00.000Z')`,
          )
          .run(),
      ).toThrow();
      // The open-case index survives the rebuild.
      expect(() =>
        db
          .prepare(
            `INSERT INTO operator_signals (id, project_key, kind, case_key, state, raised_at) VALUES ('ops_dup', 'AR', 'idle', 'idle:x', 'pending', '2026-01-02T00:00:00.000Z')`,
          )
          .run(),
      ).toThrow();
    } finally {
      db.close();
    }
  });
});
