import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { alertPayloadOf, OPERATOR_SIGNAL_WAKE_INTERVAL_MS } from '@projectman/shared';
import type { ProjectConfig } from '@projectman/shared';
import { createRepositories, LATEST_SCHEMA_VERSION, migrate } from '../src/db';
import { migrations } from '../src/db/migrations';
import { createDomainHarness, OWNER_ACTOR, restartDomainHarness } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

/**
 * PM-702: a refinement turn that ended without its label goes to the PM as a report-only
 * `refinement_stalled` signal; the owners' alert is only the fallback when the PM cannot take it. Card AR-1
 * is refined: `scope-ok` is the step of the analyst `ana`.
 */
let h: DomainHarness;
let now: Date;
afterEach(async () => {
  vi.restoreAllMocks();
  await h?.cleanup();
});

const later = (ms: number) => {
  now = new Date(now.getTime() + ms);
};
const task = () => h.domain.tasks.get('AR', 'AR-1');
const sessionOf = (member: string) =>
  h.domain.sessions.list('AR', { taskKey: 'AR-1' }).find((s) => s.member === member)!;
const turn = () => h.domain.timeline.latest('AR', 'AR-1', 'refinement_turn')!;
const stallAlerts = () =>
  h.domain.inbox.list('AR', { kind: 'alert', taskKey: 'AR-1' }).filter((item) => {
    const payload = alertPayloadOf(item);
    return payload?.alert === 'refinement' && payload.reason === 'stalled';
  });
const signals = () => h.repos.operatorSignals.list('AR').filter((s) => s.kind === 'refinement_stalled');
const endTurn = (member = 'ana') => {
  const id = sessionOf(member).id;
  h.runner.setState(id, 'working');
  h.runner.setState(id, 'idle');
};
const report = () =>
  h.domain.operatorSignals.reportRefinementStall({
    projectKey: 'AR',
    taskKey: 'AR-1',
    label: 'scope-ok',
    member: 'ana',
    turnAt: turn().createdAt,
  });
const caseKey = () => `refinement_stalled:AR-1:scope-ok:ana:${turn().createdAt}`;

async function setup(opts: { pm?: boolean } = {}) {
  now = new Date('2026-10-16T10:00:00Z');
  h = await createDomainHarness({
    now: () => now,
    persistent: true,
    adjust: (config: ProjectConfig) => {
      const pm = config.team.members.find((m) => m.handle === 'pm')!;
      if (pm.kind === 'ai') pm.onLeave = opts.pm === false;
      config.team.limits.maxConcurrentAi = 10;
      for (const stage of config.pipeline.stages) if (stage.kind !== 'release') delete stage.gate;
      config.pipeline.stages = config.pipeline.stages.filter((stage) => stage.kind !== 'release');
      config.team.members.push({
        kind: 'ai',
        handle: 'ana',
        displayName: 'ana',
        role: 'business_analyst',
        sponsor: 'owner',
      } as ProjectConfig['team']['members'][number]);
      config.pipeline.labels.push(
        { id: 'scope-ok', name: 'Scope ok', setBy: { duties: ['task_breakdown'], members: ['owner'] } },
        { id: 'refine', name: 'Refine', setBy: 'anyone' },
      );
      config.pipeline.stages.splice(1, 0, {
        id: 'ready',
        name: 'Ready',
        kind: 'queue' as const,
        owners: ['owner'],
        columnId: 'todo',
        gate: { conditions: [{ type: 'has_label' as const, label: 'scope-ok' }] },
      });
    },
  });
  await h.domain.tasks.create('AR', { title: 'Screen' }, OWNER_ACTOR);
  await h.domain.tasks.changeLabels('AR', 'AR-1', { add: ['refine'] }, OWNER_ACTOR);
  await vi.waitFor(() => expect(h.domain.refinement.turnMember('AR', 'AR-1')).toBe('ana'));
}

describe('refinement_stalled signal', () => {
  it('goes to the PM as a pending-then-delivered signal and raises no owner alert', async () => {
    await setup();
    endTurn();
    await vi.waitFor(() => expect(signals()).toHaveLength(1));
    await vi.waitFor(() => expect(signals()[0]!.deliveredAt).not.toBeNull());
    expect(signals()[0]).toMatchObject({
      caseKey: caseKey(),
      taskKey: 'AR-1',
      subject: 'scope-ok',
      deliveredTo: 'pm',
      resolvedAt: null,
    });
    expect(stallAlerts()).toEqual([]);
    expect(h.runner.started.at(-1)?.initialMessage).toContain('refinement_stalled');
    expect(h.runner.started.at(-1)?.initialMessage).toContain('"openQuestionIds":[]');

    // The same turn ending again is the same case: no second signal, no alert.
    endTurn();
    await flush();
    expect(signals()).toHaveLength(1);
    expect(stallAlerts()).toEqual([]);
  });

  it('falls back to the owners alert, once, when the PM is on leave', async () => {
    await setup({ pm: false });
    endTurn();
    await vi.waitFor(() => expect(stallAlerts()).toHaveLength(1));
    expect(stallAlerts()[0]).toMatchObject({ assignees: ['owner'], state: 'open' });
    expect(signals()).toEqual([]);
    endTurn();
    await flush();
    expect(stallAlerts()).toHaveLength(1);
  });

  it('is unavailable, and stores nothing, while AI work is off', async () => {
    await setup();
    h.domain.projects.cachedConfig('AR')!.team.limits.aiEnabled = false;
    expect(await report()).toBe('unavailable');
    h.domain.projects.cachedConfig('AR')!.team.limits.aiEnabled = true;
    expect(signals()).toEqual([]);
  });

  it('falls back once when storing or delivering fails, and keeps the stored signal for a retry', async () => {
    await setup();
    vi.spyOn(h.domain.operatorSignals, 'deliver').mockRejectedValue(new Error('boom'));
    endTurn();
    await vi.waitFor(() => expect(stallAlerts()).toHaveLength(1));
    expect(signals()).toMatchObject([{ caseKey: caseKey(), state: 'pending', deliveredAt: null }]);
    endTurn();
    await flush();
    expect(stallAlerts()).toHaveLength(1);
    expect(signals()).toHaveLength(1);

    vi.restoreAllMocks();
    await h.domain.operatorSignals.sweep('AR');
    await flush();
    expect(signals()[0]!.deliveredAt).not.toBeNull();
  });

  it('is queued, not a failure, while the wake-up interval holds it back', async () => {
    await setup();
    // An earlier delivery on the general line holds the next wake-up back.
    const other = h.domain.operatorSignals.raise({ projectKey: 'AR', kind: 'outage', caseKey: 'outage:x' });
    await h.domain.operatorSignals.deliver('AR');
    await flush();
    expect(h.repos.operatorSignals.get(other.id)!.deliveredAt).not.toBeNull();

    endTurn();
    await vi.waitFor(() => expect(signals()).toHaveLength(1));
    await flush();
    expect(signals()).toMatchObject([{ caseKey: caseKey(), state: 'pending', deliveredAt: null }]);
    expect(stallAlerts()).toEqual([]);

    later(OPERATOR_SIGNAL_WAKE_INTERVAL_MS);
    await h.domain.operatorSignals.sweep('AR');
    await flush();
    expect(signals()[0]!.deliveredAt).not.toBeNull();
    expect(stallAlerts()).toEqual([]);
  });

  it('keeps one pending signal over a restart and does not raise a second', async () => {
    await setup();
    const other = h.domain.operatorSignals.raise({ projectKey: 'AR', kind: 'outage', caseKey: 'outage:x' });
    await h.domain.operatorSignals.deliver('AR');
    await flush();
    expect(h.repos.operatorSignals.get(other.id)!.deliveredAt).not.toBeNull();
    endTurn();
    await vi.waitFor(() => expect(signals()).toHaveLength(1));
    const first = signals()[0]!;
    expect(first).toMatchObject({ state: 'pending', deliveredAt: null });

    h = await restartDomainHarness(h, { now: () => now, persistent: true });
    await h.domain.operatorSignals.sweep('AR');
    await flush();
    expect(signals().map((s) => s.id)).toEqual([first.id]);
    expect(signals()[0]!.deliveredAt).toBeNull();
    expect(stallAlerts()).toEqual([]);

    later(OPERATOR_SIGNAL_WAKE_INTERVAL_MS);
    await h.domain.operatorSignals.sweep('AR');
    await flush();
    expect(signals().map((s) => s.id)).toEqual([first.id]);
    expect(signals()[0]!.deliveredAt).not.toBeNull();
    expect(stallAlerts()).toEqual([]);
  });
});

describe('refinement_stalled source guard', () => {
  it('reports nothing while the member works again, and closes the signal when they do', async () => {
    await setup();
    h.runner.setState(sessionOf('ana').id, 'working');
    expect(await report()).toBe('delivered');
    expect(signals()).toEqual([]);

    h.runner.setState(sessionOf('ana').id, 'idle');
    expect(await report()).toBe('delivered');
    await vi.waitFor(() => expect(signals()[0]?.deliveredAt).toBeTruthy());

    // The member resumed: the sweep closes the stalled signal.
    h.runner.setState(sessionOf('ana').id, 'working');
    await h.domain.operatorSignals.sweep('AR');
    expect(signals()[0]!.resolvedAt).not.toBeNull();
  });

  it('does not tell the owners when the member resumed while the report was on its way', async () => {
    await setup();
    h.domain.refinement.useStallNotices({
      report: async () => {
        h.runner.setState(sessionOf('ana').id, 'working');
        return 'unavailable';
      },
    });
    endTurn();
    await flush();
    await flush();
    expect(stallAlerts()).toEqual([]);
    expect(signals()).toEqual([]);
  });

  it('reports nothing for an open question of the member', async () => {
    await setup();
    await h.domain.teamTools.askHuman(
      { sessionId: sessionOf('ana').id, projectKey: 'AR', member: 'ana', taskKey: 'AR-1' },
      { question: 'Which font?', options: ['Yes', 'No'] },
    );
    endTurn();
    await flush();
    await flush();
    expect(signals()).toEqual([]);
    expect(stallAlerts()).toEqual([]);
  });

  it('reports nothing for a changed turn or a late receipt, and closes the signal when the label is on', async () => {
    await setup();
    expect(
      await h.domain.operatorSignals.reportRefinementStall({
        projectKey: 'AR',
        taskKey: 'AR-1',
        label: 'scope-ok',
        member: 'ana',
        turnAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toBe('delivered');
    expect(
      await h.domain.operatorSignals.reportRefinementStall({
        projectKey: 'AR',
        taskKey: 'AR-1',
        label: 'scope-ok',
        member: 'someone-else',
        turnAt: turn().createdAt,
      }),
    ).toBe('delivered');
    expect(signals()).toEqual([]);

    endTurn();
    await vi.waitFor(() => expect(signals()).toHaveLength(1));
    await h.domain.tasks.changeLabels('AR', 'AR-1', { add: ['scope-ok'] }, OWNER_ACTOR);
    await h.domain.operatorSignals.sweep('AR');
    expect(signals()[0]!.resolvedAt).not.toBeNull();
  });
});

describe('refinement_stalled dismissal and authority', () => {
  const deliver = async () => {
    endTurn();
    await vi.waitFor(() => expect(signals()[0]?.deliveredAt).toBeTruthy());
    return signals()[0]!;
  };

  it('lets the PM dismiss a delivered, unpresented signal; a presented one stays with the owners', async () => {
    await setup();
    const signal = await deliver();
    expect(h.domain.operatorSignals.dismissByOperator('AR', signal.id, 'pm', 'Intermediate.')).toMatchObject({
      state: 'dismissed',
    });
    // A dismissed signal still holds the case: the same turn raises no second one.
    expect(await report()).toBe('delivered');
    expect(signals()).toHaveLength(1);
  });

  it('refuses a dismissal once the signal was presented', async () => {
    await setup();
    const signal = await deliver();
    h.domain.operatorSignals.present('AR', signal.id, 'msg_1', false);
    expect(() => h.domain.operatorSignals.dismissByOperator('AR', signal.id, 'pm', 'Intermediate.')).toThrow(
      'no longer open',
    );
  });

  it('refuses a dismissal after the case is gone', async () => {
    await setup();
    const signal = await deliver();
    await h.domain.tasks.changeLabels('AR', 'AR-1', { add: ['scope-ok'] }, OWNER_ACTOR);
    expect(() => h.domain.operatorSignals.dismissByOperator('AR', signal.id, 'pm', 'Done.')).toThrow(
      'no longer open',
    );
  });
});

describe('operator_signals migration to refinement_stalled', () => {
  it('keeps the rows and the open-case index, and accepts the new kind', () => {
    const db = new Database(':memory:');
    try {
      const before = migrations.filter((item) => item.version < 71);
      for (const migration of before) db.exec(migration.sql);
      db.pragma(`user_version = ${Math.max(...before.map((item) => item.version))}`);
      db.exec(`INSERT INTO projects VALUES ('AR', 'Example', NULL, 'v1', '2026-01-01', '2026-01-01');
        INSERT INTO operator_signals (id, project_key, kind, case_key, state, raised_at, delivered_at, delivered_to)
          VALUES ('ops_1', 'AR', 'answer_stalled', 'answer_stalled:x', 'open', '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z', 'pm');`);
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      const repos = createRepositories(db);
      expect(repos.operatorSignals.get('ops_1')).toMatchObject({
        kind: 'answer_stalled',
        deliveredTo: 'pm',
      });
      db.prepare(
        `INSERT INTO operator_signals (id, project_key, kind, case_key, state, raised_at) VALUES ('ops_2', 'AR', 'refinement_stalled', 'refinement_stalled:AR-1:a:b:c', 'pending', '2026-01-02T00:00:00.000Z')`,
      ).run();
      expect(() =>
        db
          .prepare(
            `INSERT INTO operator_signals (id, project_key, kind, case_key, state, raised_at) VALUES ('ops_3', 'AR', 'refinement_stalled', 'refinement_stalled:AR-1:a:b:c', 'pending', '2026-01-02T00:00:00.000Z')`,
          )
          .run(),
      ).toThrow();
    } finally {
      db.close();
    }
  });
});
