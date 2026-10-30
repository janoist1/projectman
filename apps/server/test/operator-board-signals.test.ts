import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OperatorSignalKind, ProjectConfig, Task } from '@projectman/shared';
import { createRepositories, LATEST_SCHEMA_VERSION, migrate } from '../src/db';
import type { MergeRecord } from '../src/db';
import { migrations } from '../src/db/migrations';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';
import { openOverdueObligation } from './helpers/overdue-obligation';

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

async function setup(opts: { adjust?: (config: ProjectConfig) => void; appVersion?: string } = {}) {
  now = new Date('2026-10-11T10:00:00Z');
  h = await createDomainHarness({
    now: () => now,
    ...(opts.appVersion ? { appVersion: opts.appVersion } : {}),
    adjust: (config) => {
      const pm = config.team.members.find((m) => m.handle === 'pm')!;
      if (pm.kind === 'ai') pm.onLeave = false;
      opts.adjust?.(config);
    },
  });
}

/** A card put straight into a stage, as it would stand after a move. */
async function place(patch: Partial<Pick<Task, 'stageId' | 'status' | 'assignee'>>): Promise<Task> {
  const card = await h.domain.tasks.create('AR', { title: 'Card', repo: 'web' }, OWNER_ACTOR);
  h.repos.tasks.update(card.id, { ...patch, updatedAt: now.toISOString() });
  return h.repos.tasks.get(card.key)!;
}

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

describe('merge_blocked signal', () => {
  it('rises at once for failed and blocked, not for fixing, and closes when the request moves on', async () => {
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

  it('raises no signal for a stuck card on its own: the obligation ladder carries it', async () => {
    await setup();
    const card = await place({ stageId: 'code_review', status: 'waiting' });
    h.repos.taskMerges.save(merge({ taskKey: card.key, state: 'requested' }));
    await place({ stageId: 'development', status: 'active', assignee: 'dev-1' });
    later(24 * 60);
    await sweep();
    for (const kind of ['idle', 'merge_waiting', 'ready_waiting', 'refinement_stalled'] as const)
      expect(h.repos.operatorSignals.list('AR').filter((s) => s.kind === kind)).toEqual([]);
  });
});

describe('obligation_overdue signal: the dismissal', () => {
  /** An open obligation row the PM was told about, and the delivered signal that carries it. */
  async function told() {
    await setup();
    const card = await place({ stageId: 'development', status: 'active', assignee: 'dev-1' });
    const at = now.toISOString();
    const { id, signalId } = openOverdueObligation(h, card, { at: now });
    const delivered = h.repos.operatorSignals.get(signalId)!;
    delivered.deliveredAt = at;
    delivered.deliveredTo = 'pm';
    h.repos.operatorSignals.save(delivered);
    return { card, id, signal: delivered };
  }

  it('closes a delivered signal of a case that still holds, with the note', async () => {
    const { signal } = await told();
    expect(h.domain.operatorSignals.dismissByOperator('AR', signal.id, 'pm', 'Parked.')).toMatchObject({
      state: 'dismissed',
    });
    expect(h.repos.operatorSignals.get(signal.id)).toMatchObject({
      decidedBy: 'pm',
      decisionNote: 'Parked.',
    });
  });

  it('refuses unknown and foreign signals before checking their kind', async () => {
    await setup();
    expect(() => h.domain.operatorSignals.dismissByOperator('AR', 'unknown', 'pm', 'Note')).toThrow(
      'unknown signal',
    );
    const other = h.domain.operatorSignals.raise({ projectKey: 'OTHER', kind: 'idle', caseKey: 'idle:x' });
    expect(() => h.domain.operatorSignals.dismissByOperator('AR', other.id, 'pm', 'Note')).toThrow(
      'unknown signal',
    );
    const retired = h.domain.operatorSignals.raise({ projectKey: 'AR', kind: 'idle', caseKey: 'idle:x' });
    expect(() => h.domain.operatorSignals.dismissByOperator('AR', retired.id, 'pm', 'Note')).toThrow(
      'may not dismiss this signal kind',
    );
  });

  it.each(['undelivered', 'presented', 'resolved', 'dismissed', 'accepted', 'case ended'])(
    'refuses a %s signal',
    async (how) => {
      const { id, signal } = await told();
      if (how === 'undelivered') signal.deliveredAt = null;
      if (how === 'presented') signal.messageId = 'msg_1';
      if (how === 'resolved') signal.resolvedAt = now.toISOString();
      if (how === 'dismissed' || how === 'accepted') signal.state = how;
      if (how === 'case ended') h.repos.obligations.close(id, 'fulfilled', now.toISOString());
      h.repos.operatorSignals.save(signal);
      expect(() => h.domain.operatorSignals.dismissByOperator('AR', signal.id, 'pm', 'Note')).toThrow(
        'the signal is no longer open',
      );
    },
  );
});

describe('the reads of a sweep (PM-1120)', () => {
  it('reads the waits once and never the whole session history', async () => {
    await setup();
    await place({ stageId: 'development', status: 'active', assignee: 'dev-1' });
    await sweep();
    // The delivery wakes the coordinator, which reads sessions of its own: not part of the sweep's reads.
    vi.spyOn(h.domain.operatorSignals, 'deliver').mockResolvedValue();
    const waits = vi.spyOn(h.domain.taskWaits, 'of');
    const all = vi.spyOn(h.repos.sessions, 'list');
    await sweep();
    expect(waits).toHaveBeenCalledTimes(1);
    // Only a card's own sessions are listed (the answer-stall check), never the project's whole history.
    expect(all.mock.calls.filter(([, filters]) => !filters)).toEqual([]);
  });

  it('runs at most two sweep bodies for three events in one tick', async () => {
    await setup();
    await place({ stageId: 'development', status: 'active', assignee: 'dev-1' });
    const waits = vi.spyOn(h.domain.taskWaits, 'of');
    await Promise.all([1, 2, 3].map(() => h.domain.operatorSignals.sweep('AR')));
    await flush();
    expect(waits.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(waits.mock.calls.length).toBeLessThanOrEqual(2);
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
      for (const kind of ['merge_blocked', 'unreleased', 'obligation_overdue'] as const)
        db.prepare(
          `INSERT INTO operator_signals (id, project_key, kind, case_key, state, raised_at) VALUES (?, 'AR', ?, ?, 'pending', '2026-01-02T00:00:00.000Z')`,
        ).run(`ops_${kind}`, kind, `${kind}:x`);
      expect(repos.operatorSignals.list('AR')).toHaveLength(4);
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
            `INSERT INTO operator_signals (id, project_key, kind, case_key, state, raised_at) VALUES ('ops_dup', 'AR', 'merge_blocked', 'merge_blocked:x', 'pending', '2026-01-02T00:00:00.000Z')`,
          )
          .run(),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('closes the open rows of the retired kinds, keeps the closed ones, and cancels the old stall alerts (PM-1152)', () => {
    const db = new Database(':memory:');
    try {
      const before = migrations.filter((item) => item.version < LATEST_SCHEMA_VERSION);
      for (const migration of before) db.exec(migration.sql);
      db.pragma(`user_version = ${Math.max(...before.map((item) => item.version))}`);
      db.exec(
        `INSERT INTO projects (key, name, config_version, created_at, updated_at) VALUES ('AR', 'Example', 'v1', '2026-01-01', '2026-01-01');`,
      );
      const insert = db.prepare(
        `INSERT INTO operator_signals (id, project_key, kind, case_key, state, raised_at, resolved_at) VALUES (?, 'AR', ?, ?, ?, '2026-01-01T00:00:00.000Z', ?)`,
      );
      insert.run('ops_idle', 'idle', 'idle:AR-1:development', 'pending', null);
      insert.run('ops_ready', 'ready_waiting', 'ready_waiting:AR-2', 'open', null);
      insert.run('ops_old', 'merge_waiting', 'merge_waiting:AR-3', 'resolved', '2026-01-02T00:00:00.000Z');
      insert.run('ops_blocked', 'merge_blocked', 'merge_blocked:AR-4', 'pending', null);
      const alert = db.prepare(
        `INSERT INTO inbox_items (id, project_key, kind, assignees, source, title, payload, options, state, created_at, updated_at)
         VALUES (?, 'AR', 'alert', '["owner"]', 'system', 'Alert', ?, '[]', ?, '2026-01-01', '2026-01-01')`,
      );
      alert.run('inb_work', JSON.stringify({ alert: 'work_stalled' }), 'open');
      alert.run('inb_refine', JSON.stringify({ alert: 'refinement', reason: 'stalled' }), 'open');
      alert.run('inb_other', JSON.stringify({ alert: 'refinement', reason: 'failed' }), 'open');
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      const state = (id: string) =>
        (db.prepare('SELECT state FROM inbox_items WHERE id = ?').get(id) as { state: string }).state;
      expect([state('inb_work'), state('inb_refine'), state('inb_other')]).toEqual([
        'cancelled',
        'cancelled',
        'open',
      ]);
      const repos = createRepositories(db);
      const byId = (id: string) => repos.operatorSignals.get(id)!;
      expect(byId('ops_idle').resolvedAt).not.toBeNull();
      expect(byId('ops_ready').resolvedAt).not.toBeNull();
      expect(byId('ops_old')).toMatchObject({
        kind: 'merge_waiting',
        resolvedAt: '2026-01-02T00:00:00.000Z',
      });
      expect(byId('ops_blocked').resolvedAt).toBeNull();
    } finally {
      db.close();
    }
  });
});
