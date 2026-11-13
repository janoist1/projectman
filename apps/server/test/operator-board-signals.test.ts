import { afterEach, describe, expect, it, vi } from 'vitest';
import { RepoConfig } from '@projectman/shared';
import type { ProjectManagerSignalKind, ProjectConfig, Task } from '@projectman/shared';

import type { MergeRecord } from '../src/db';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';
import { openOverdueObligation } from './helpers/overdue-obligation';
import { mergeCards, publishRelease, sha } from './helpers/unreleased-work';

/** PM-547: the board kinds of the project manager's system signals, raised and closed by the sweep. */
let h: DomainHarness;
let now: Date;
afterEach(async () => {
  await h?.cleanup();
});

const later = (minutes: number) => {
  now = new Date(now.getTime() + minutes * 60_000);
};
const sweep = async () => {
  await h.domain.projectManagerSignals.sweep('AR');
  await flush();
};
const open = (kind: ProjectManagerSignalKind) =>
  h.repos.projectManagerSignals.list('AR').filter((s) => s.kind === kind && !s.resolvedAt);

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
    expect(h.repos.projectManagerSignals.list('AR')).toEqual([]);
  });

  it('resolves the open row of the retired unreleased kind an older build left, and keeps the closed one', async () => {
    await setup();
    const row = (id: string, kind: ProjectManagerSignalKind, state: 'pending' | 'open' | 'resolved') => ({
      id,
      projectKey: 'AR',
      caseKey: `${kind}:AR-1`,
      kind,
      state,
      actionable: false,
      taskKey: 'AR-1',
      subject: null,
      inboxItemId: null,
      messageId: null,
      raisedAt: '2026-10-10T10:00:00.000Z',
      decidedBy: null,
      decidedAt: null,
      resolvedAt: state === 'resolved' ? '2026-10-10T11:00:00.000Z' : null,
      deliveredAt: null,
      followUpAt: null,
      decisionNote: null,
      deliveredTo: null,
    });
    h.repos.projectManagerSignals.insert(row('ops_unreleased', 'unreleased', 'open'));
    h.repos.projectManagerSignals.insert({
      ...row('ops_old', 'unreleased', 'resolved'),
      caseKey: 'unreleased:AR-2',
    });
    await sweep();
    const byId = (id: string) => h.repos.projectManagerSignals.get(id)!;
    expect(byId('ops_unreleased').state).toBe('resolved');
    expect(byId('ops_unreleased').resolvedAt).not.toBeNull();
    expect(byId('ops_old')).toMatchObject({ state: 'resolved', resolvedAt: '2026-10-10T11:00:00.000Z' });
  });
});

describe('obligation_overdue signal: the dismissal', () => {
  /** An open obligation row the PM was told about, and the delivered signal that carries it. */
  async function told() {
    await setup();
    const card = await place({ stageId: 'development', status: 'active', assignee: 'dev-1' });
    const at = now.toISOString();
    const { id, signalId } = openOverdueObligation(h, card, { at: now });
    const delivered = h.repos.projectManagerSignals.get(signalId)!;
    delivered.deliveredAt = at;
    delivered.deliveredTo = 'pm';
    h.repos.projectManagerSignals.save(delivered);
    return { card, id, signal: delivered };
  }

  it('closes a delivered signal of a case that still holds, with the note', async () => {
    const { signal } = await told();
    expect(
      h.domain.projectManagerSignals.dismissByProjectManager('AR', signal.id, 'pm', 'Parked.'),
    ).toMatchObject({
      state: 'dismissed',
    });
    expect(h.repos.projectManagerSignals.get(signal.id)).toMatchObject({
      decidedBy: 'pm',
      decisionNote: 'Parked.',
    });
  });

  it('refuses unknown and foreign signals before checking their kind', async () => {
    await setup();
    expect(() =>
      h.domain.projectManagerSignals.dismissByProjectManager('AR', 'unknown', 'pm', 'Note'),
    ).toThrow('unknown signal');
    const other = h.domain.projectManagerSignals.raise({
      projectKey: 'OTHER',
      kind: 'outage',
      caseKey: 'outage:x',
    });
    expect(() =>
      h.domain.projectManagerSignals.dismissByProjectManager('AR', other.id, 'pm', 'Note'),
    ).toThrow('unknown signal');
    const retired = h.domain.projectManagerSignals.raise({
      projectKey: 'AR',
      kind: 'outage',
      caseKey: 'outage:x',
    });
    expect(() =>
      h.domain.projectManagerSignals.dismissByProjectManager('AR', retired.id, 'pm', 'Note'),
    ).toThrow('may not dismiss this signal kind');
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
      h.repos.projectManagerSignals.save(signal);
      expect(() =>
        h.domain.projectManagerSignals.dismissByProjectManager('AR', signal.id, 'pm', 'Note'),
      ).toThrow('the signal is no longer open');
    },
  );
});

describe('release_due todo (PM-1333)', () => {
  const hours = (n: number) => new Date(now.getTime() - n * 3_600_000).toISOString();
  const withGithub = (config: ProjectConfig) => {
    config.project.repos[0]!.github = 'acme/web';
  };
  const todos = (state: 'open' | 'cancelled' = 'open') =>
    h.repos.inbox
      .list('AR', { kind: 'question', state })
      .filter(
        (item) => (item.payload.systemAlert as { alert?: string } | undefined)?.alert === 'release_due',
      );
  const markers = () => todos().map((item) => (item.payload.systemAlert as { key: string }).key);

  it('opens one integrator todo once the oldest unreleased merge is a day old, and closes it when the release moves the base', async () => {
    await setup({ adjust: withGithub });
    await mergeCards(h, 'web', [
      { commit: sha(1), at: hours(100) },
      { commit: sha(2), at: hours(24) },
      { commit: sha(3), at: hours(2) },
    ]);
    publishRelease(h, 'web', sha(1), hours(100));
    await sweep();
    expect(todos().map((item) => [item.source, item.payload.systemAlert])).toEqual([
      ['system', { alert: 'release_due', key: `web@${sha(1)}` }],
    ]);
    // No signal for the PM and nobody to start: the todo is the whole alert.
    expect(open('unreleased')).toEqual([]);
    await sweep();
    expect(todos()).toHaveLength(1);
    publishRelease(h, 'web', sha(3), hours(1));
    await sweep();
    expect(todos()).toEqual([]);
    expect(todos('cancelled')).toHaveLength(1);
  });

  it('stays closed while the oldest unreleased merge is younger than a day', async () => {
    await setup({ adjust: withGithub });
    await mergeCards(h, 'web', [
      { commit: sha(1), at: hours(100) },
      { commit: sha(2), at: hours(23) },
    ]);
    publishRelease(h, 'web', sha(1), hours(100));
    await sweep();
    expect(todos()).toEqual([]);
    later(60);
    await sweep();
    expect(todos()).toHaveLength(1);
  });

  it('does not open a closed todo again within a day, and does after it', async () => {
    await setup({ adjust: withGithub });
    await mergeCards(h, 'web', [
      { commit: sha(1), at: hours(100) },
      { commit: sha(2), at: hours(30) },
    ]);
    publishRelease(h, 'web', sha(1), hours(100));
    await sweep();
    h.domain.inbox.cancel(todos()[0]!.id);
    later(23 * 60);
    await sweep();
    expect(todos()).toEqual([]);
    later(2 * 60);
    await sweep();
    expect(markers()).toEqual([`web@${sha(1)}`]);
  });

  it('keeps a todo open past a day without opening a second one', async () => {
    await setup({ adjust: withGithub });
    await mergeCards(h, 'web', [
      { commit: sha(1), at: hours(100) },
      { commit: sha(2), at: hours(30) },
    ]);
    publishRelease(h, 'web', sha(1), hours(100));
    await sweep();
    later(30 * 60);
    await sweep();
    expect(todos()).toHaveLength(1);
  });

  it('keeps a separate todo for each repository', async () => {
    await setup({
      adjust: (config) => {
        withGithub(config);
        config.project.repos.push(RepoConfig.parse({ name: 'notes', path: 'notes', github: 'acme/notes' }));
      },
    });
    for (const repo of ['web', 'notes']) {
      await mergeCards(h, repo, [
        { commit: sha(1), at: hours(100) },
        { commit: sha(2), at: hours(30) },
      ]);
      publishRelease(h, repo, sha(1), hours(100));
    }
    await sweep();
    expect(markers().sort()).toEqual([`notes@${sha(1)}`, `web@${sha(1)}`]);
    publishRelease(h, 'web', sha(2), hours(1));
    await sweep();
    expect(markers()).toEqual([`notes@${sha(1)}`]);
  });
});

describe('the reads of a sweep (PM-1120)', () => {
  it('reads the waits once and never the whole session history', async () => {
    await setup();
    await place({ stageId: 'development', status: 'active', assignee: 'dev-1' });
    await sweep();
    // The delivery wakes the coordinator, which reads sessions of its own: not part of the sweep's reads.
    vi.spyOn(h.domain.projectManagerSignals, 'deliver').mockResolvedValue();
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
    await Promise.all([1, 2, 3].map(() => h.domain.projectManagerSignals.sweep('AR')));
    await flush();
    expect(waits.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(waits.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
