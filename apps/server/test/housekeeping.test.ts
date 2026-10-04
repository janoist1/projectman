import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { InboxItem } from '@projectman/shared';
import { alertPayloadOf } from '@projectman/shared';
import { freeBytesOf } from '../src/domain';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';

/** Housekeeping (PM-243): the worktrees of closed cards, and the free disk space. */

const GB = 1024 ** 3;
const DAY_MS = 24 * 60 * 60 * 1000;

describe('worktrees of closed cards', () => {
  let h: DomainHarness;
  let now: Date;
  let free: number | null;
  afterEach(() => h.cleanup());

  async function setup() {
    now = new Date('2026-10-01T12:00:00.000Z');
    free = 50 * GB;
    h = await createDomainHarness({ now: () => now, freeDiskBytes: async () => free });
  }

  /** A card with a worktree (its developer's session ran) that is closed `closedAgoMs` ago. */
  async function closedCard(title: string, how: 'cancelled' | 'done', closedAgoMs: number) {
    const key = (await h.domain.tasks.create('AR', { title, repo: 'web' }, OWNER_ACTOR)).key;
    await h.domain.taskStarts.start('AR', key, { assignee: 'dev-1', actor: OWNER_ACTOR, author: OWNER });
    const info = (await h.worktrees.find({
      project: await h.domain.projects.config('AR'),
      repoName: 'web',
      taskKey: key,
    }))!;
    if (how === 'cancelled') await h.domain.tasks.cancel('AR', key, { reason: 'Fictional' }, OWNER_ACTOR);
    else {
      await h.domain.sessions.stopTask('AR', key, { kind: 'card_done', taskKey: key });
      h.repos.tasks.update(h.domain.tasks.get('AR', key).id, { status: 'done' });
    }
    h.repos.tasks.update(h.domain.tasks.get('AR', key).id, {
      closedAt: new Date(now.getTime() - closedAgoMs).toISOString(),
    });
    return { key, path: info.path };
  }

  const alerts = (): InboxItem[] => h.domain.inbox.list('AR', { kind: 'alert' });

  it('removes the clean worktree of a card closed for three days, whether done or cancelled', async () => {
    await setup();
    const cancelled = await closedCard('Fictional login', 'cancelled', 4 * DAY_MS);
    const done = await closedCard('Fictional checkout', 'done', 3 * DAY_MS);

    const report = await h.domain.worktreeSweep.run();

    expect(report).toMatchObject({ removed: [cancelled.key, done.key], kept: [] });
    expect(h.worktrees.removed).toEqual([cancelled.path, done.path]);
    expect(alerts()).toEqual([]);
  });

  it('leaves the worktree of a card that was closed more recently, and of an open one', async () => {
    await setup();
    await closedCard('Fictional login', 'cancelled', 2 * DAY_MS);
    await h.domain.tasks.create('AR', { title: 'Fictional open card', repo: 'web' }, OWNER_ACTOR);
    await h.domain.taskStarts.start('AR', 'AR-2', {
      assignee: 'dev-1',
      actor: OWNER_ACTOR,
      author: OWNER,
    });

    const report = await h.domain.worktreeSweep.run();

    expect(report.removed).toEqual([]);
    expect(h.worktrees.removed).toEqual([]);
  });

  it('leaves the worktree of a closed card whose session is still running', async () => {
    await setup();
    const card = await closedCard('Fictional login', 'cancelled', 5 * DAY_MS);
    h.runner.isRunning = () => true;

    const report = await h.domain.worktreeSweep.run();

    expect(report).toMatchObject({ removed: [], kept: [] });
    expect(h.worktrees.removed).toEqual([]);

    h.runner.isRunning = () => false;
    await h.domain.worktreeSweep.run();
    expect(h.worktrees.removed).toEqual([card.path]);
  });

  it('removes it once the card has been closed long enough', async () => {
    await setup();
    const card = await closedCard('Fictional login', 'cancelled', 2 * DAY_MS);
    await h.domain.worktreeSweep.run();
    expect(h.worktrees.removed).toEqual([]);

    now = new Date(now.getTime() + 2 * DAY_MS);
    await h.domain.worktreeSweep.run();

    expect(h.worktrees.removed).toEqual([card.path]);
  });

  it('never removes a worktree with uncommitted changes, and tells the owners once', async () => {
    await setup();
    const card = await closedCard('Fictional login', 'cancelled', 5 * DAY_MS);
    h.worktrees.statuses.set(card.path, { dirty: true, unpushedCommits: 0 });

    const first = await h.domain.worktreeSweep.run();
    const second = await h.domain.worktreeSweep.run();

    expect(first).toMatchObject({ removed: [], kept: [card.key] });
    expect(second).toMatchObject({ removed: [], kept: [card.key] });
    expect(h.worktrees.removed).toEqual([]);
    const told = alerts();
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ kind: 'alert', taskKey: card.key, state: 'open', assignees: ['owner'] });
    expect(alertPayloadOf(told[0]!)).toMatchObject({
      alert: 'worktree_kept',
      taskKey: card.key,
      path: card.path,
    });
  });

  it('removes a kept worktree after it was cleaned up, without another alert', async () => {
    await setup();
    const card = await closedCard('Fictional login', 'cancelled', 5 * DAY_MS);
    h.worktrees.statuses.set(card.path, { dirty: true, unpushedCommits: 0 });
    await h.domain.worktreeSweep.run();

    h.worktrees.statuses.set(card.path, { dirty: false, unpushedCommits: 0 });
    await h.domain.worktreeSweep.run();

    expect(h.worktrees.removed).toEqual([card.path]);
    expect(alerts()).toHaveLength(1);
  });

  it('keeps the branch: a worktree with commits that are not merged anywhere is still removed', async () => {
    await setup();
    const card = await closedCard('Fictional login', 'cancelled', 5 * DAY_MS);
    h.worktrees.statuses.set(card.path, { dirty: false, unpushedCommits: 3 });

    await h.domain.worktreeSweep.run();

    expect(h.worktrees.removed).toEqual([card.path]);
  });

  it('reports how much space it freed', async () => {
    await setup();
    const card = await closedCard('Fictional login', 'cancelled', 5 * DAY_MS);
    const remove = h.worktrees.remove.bind(h.worktrees);
    h.worktrees.remove = async (args) => {
      await remove(args);
      free = free! + 2 * GB;
    };

    const report = await h.domain.worktreeSweep.run();

    expect(report).toEqual({ removed: [card.key], kept: [], freedBytes: 2 * GB });
  });

  it('survives a worktree that cannot be removed and carries on with the next card', async () => {
    await setup();
    const first = await closedCard('Fictional login', 'cancelled', 5 * DAY_MS);
    const second = await closedCard('Fictional checkout', 'cancelled', 5 * DAY_MS);
    const remove = h.worktrees.remove.bind(h.worktrees);
    h.worktrees.remove = async (args) => {
      if (args.path === first.path) throw new Error('fictional failure');
      await remove(args);
    };

    const report = await h.domain.worktreeSweep.run();

    expect(report.removed).toEqual([second.key]);
    expect(h.log.warnings).toHaveLength(1);
    h.log.warnings.length = 0;
  });
});

describe('free disk space', () => {
  let h: DomainHarness;
  let free: number | null;
  afterEach(() => h.cleanup());

  const alerts = (): InboxItem[] => h.domain.inbox.list('AR', { kind: 'alert' });
  const setLimit = (gb: number) =>
    h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (config) => {
      config.team.limits.minFreeDiskGb = gb;
      return 'Set the free disk limit';
    });
  const startCard = () =>
    h.domain.taskStarts.start('AR', 'AR-1', { assignee: 'dev-1', actor: OWNER_ACTOR, author: OWNER });

  async function setup(bytes: number | null) {
    free = bytes;
    h = await createDomainHarness({ freeDiskBytes: async () => free });
    await h.domain.tasks.create('AR', { title: 'Fictional login', repo: 'web' }, OWNER_ACTOR);
  }

  it('defaults to a limit of 10 GB', async () => {
    await setup(50 * GB);
    expect((await h.domain.projects.config('AR')).team.limits.minFreeDiskGb).toBe(10);
  });

  it('starts sessions while there is room and warns nobody', async () => {
    await setup(50 * GB);
    await h.domain.disk.check();
    await startCard();
    expect(h.runner.started).toHaveLength(1);
    expect(alerts()).toEqual([]);
  });

  it('warns the owners once below the limit, and no new session starts', async () => {
    await setup(4 * GB);

    await h.domain.disk.check();
    await h.domain.disk.check();

    const [item, ...more] = alerts();
    expect(more).toEqual([]);
    expect(item).toMatchObject({ kind: 'alert', state: 'open', assignees: ['owner'], source: 'system' });
    expect(alertPayloadOf(item!)).toEqual({
      alert: 'disk_low',
      freeBytes: 4 * GB,
      thresholdBytes: 10 * GB,
    });
    await expect(startCard()).rejects.toMatchObject({ code: 'disk_low', status: 409 });
    expect(h.runner.started).toEqual([]);
    expect(alerts()).toHaveLength(1);
  });

  it('is told by the refusal itself when the periodic check has not run yet', async () => {
    await setup(4 * GB);
    await expect(startCard()).rejects.toMatchObject({ code: 'disk_low' });
    expect(alerts()).toHaveLength(1);
  });

  it('does not warn again after the owner has seen it, until the space came back and fell again', async () => {
    await setup(4 * GB);
    await h.domain.disk.check();
    await h.domain.inbox.resolve(
      'AR',
      alerts()[0]!.id,
      { optionId: 'seen' },
      { handle: 'owner', access: 'owner' },
    );

    await h.domain.disk.check();
    expect(alerts()).toHaveLength(1);

    free = 40 * GB;
    await h.domain.disk.check();
    free = 3 * GB;
    await h.domain.disk.check();
    expect(alerts()).toHaveLength(2);
  });

  it('withdraws the warning and starts sessions again once there is room', async () => {
    await setup(4 * GB);
    await h.domain.disk.check();
    expect(alerts()[0]).toMatchObject({ state: 'open' });

    free = 12 * GB;
    await h.domain.disk.check();
    await startCard();

    expect(alerts()[0]).toMatchObject({ state: 'cancelled' });
    expect(h.runner.started).toHaveLength(1);
  });

  it('takes the limit from the settings, and 0 turns it off', async () => {
    await setup(4 * GB);
    await setLimit(3);
    await startCard();
    expect(h.runner.started).toHaveLength(1);
    expect(alerts()).toEqual([]);

    await setLimit(5);
    await h.domain.disk.check();
    expect(alerts()).toHaveLength(1);

    await setLimit(0);
    await expect(h.domain.disk.assertRoom(await h.domain.projects.config('AR'))).resolves.toBeUndefined();
  });

  it('lets a running session finish its step', async () => {
    await setup(50 * GB);
    await startCard();
    const [started] = h.runner.started;
    free = 1 * GB;
    await h.domain.disk.check();
    expect(h.runner.isRunning(started!.sessionId)).toBe(true);
  });

  it('refuses nothing when the space cannot be measured', async () => {
    await setup(null);
    await h.domain.disk.check();
    await startCard();
    expect(h.runner.started).toHaveLength(1);
    expect(alerts()).toEqual([]);
  });

  it('measures the free bytes of a real directory', async () => {
    expect(await freeBytesOf(tmpdir())).toBeGreaterThan(0);
  });
});
