import { afterEach, describe, expect, it, vi } from 'vitest';
import { cardStageOwners, hasCardRole, waitWorkers } from '@projectman/shared';
import type { ComplexityPoints, ProjectConfig } from '@projectman/shared';
import { aiActor } from '../src/kernel';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

/*
 * PM-1378 A: a step stage with a small-card rule decides on entry whom a card goes to. `dev-2` is the
 * small owner of code review here, `cr` the main owner; the card's developer is `dev-1`.
 */

const head = {
  commit: 'c1',
  branch: 'task/AR-1',
  dirty: false,
  changes: 0,
  path: '/fake/worktree',
  committedAt: null,
};

describe('the owners a small card has in a review step (smallCards)', () => {
  let h: DomainHarness;
  afterEach(() => h?.cleanup());

  async function setup(points: ComplexityPoints | null = 2, rule = true, humanMover = false) {
    h = await createDomainHarness({
      adjust: (config: ProjectConfig) => {
        if (humanMover) config.team.cardMover = { kind: 'human', handle: 'owner' };
        if (!rule) return;
        const review = config.pipeline.stages.find((s) => s.id === 'code_review')!;
        review.smallCards = { maxPoints: 3, owners: ['dev-2'], centralPaths: ['src/core/**'] };
      },
    });
    await h.domain.tasks.create(
      'AR',
      { title: 'Login page', ...(points ? { complexity: { points, reason: 'Fictional.' } } : {}) },
      OWNER_ACTOR,
    );
    await h.domain.taskStarts.start('AR', 'AR-1', { assignee: 'dev-1', actor: OWNER_ACTOR, author: OWNER });
    h.worktrees.heads.set(h.worktrees.existing.get('AR/AR-1/web')!.path, head);
  }
  const files = (paths: readonly string[], truncated = false) =>
    vi.spyOn(h.domain.sessions, 'changedFiles').mockResolvedValue({ paths, truncated });
  const toReview = () => h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', aiActor('dev-1'));
  const card = () => h.domain.tasks.get('AR', 'AR-1');
  const stageChange = () =>
    h.domain.timeline
      .list('AR', { taskKey: 'AR-1' })
      .filter((e) => e.type === 'task_stage_changed')
      .at(-1)!.data;

  it('hands a small card with no central file to the small owner, which every reading of the owners shares', async () => {
    await setup();
    files(['src/web/login.ts']);
    await toReview();

    expect(card().stageOwnerPick).toMatchObject({ stageId: 'code_review', small: true });
    expect(stageChange()).toMatchObject({
      ownerPick: { small: true, reason: { code: 'small', points: 2 }, owners: ['dev-2'] },
    });
    const config = await h.domain.projects.config('AR');
    // The hand-over starts the small owner and not the main one.
    await vi.waitFor(() => expect(h.runner.started.some((s) => s.member === 'dev-2')).toBe(true));
    expect(h.runner.started.some((s) => s.member === 'cr')).toBe(false);
    // The card role, the owners and the wait display read the same pick.
    const stage = config.pipeline.stages.find((s) => s.id === 'code_review')!;
    expect(cardStageOwners(config, stage, card())).toEqual(['dev-2']);
    expect(hasCardRole(config, card(), 'dev-2', false)).toBe(true);
    const roster = ['dev-2', 'cr'].map((handle) => ({
      handle,
      kind: 'ai' as const,
      currentTaskKeys: ['AR-1'],
      taskWork: [{ taskKey: 'AR-1', since: '2026-01-01T00:00:00.000Z' }],
    }));
    expect(waitWorkers(card(), config, roster).map((w) => w.handle)).toEqual(['dev-2', 'cr']);
  });

  it('leaves the card to the main owner when a central file changed, and names the file', async () => {
    await setup();
    files(['src/core/tasks/moves.ts']);
    await toReview();

    expect(card().stageOwnerPick).toMatchObject({
      small: false,
      reason: { code: 'central_files', count: 1 },
    });
    expect(stageChange()).toMatchObject({ ownerPick: { small: false, owners: ['cr'] } });
    await vi.waitFor(() => expect(h.runner.started.some((s) => s.member === 'cr')).toBe(true));
  });

  it('is not stopped by a read that fails: the card goes to the main owner as unreadable', async () => {
    await setup();
    vi.spyOn(h.domain.sessions, 'changedFiles').mockRejectedValue(new Error('engine away'));
    await toReview();

    expect(card().stageId).toBe('code_review');
    expect(card().stageOwnerPick).toMatchObject({ small: false, reason: { code: 'unreadable' } });
  });

  it('reads no files for a card without points', async () => {
    await setup(null);
    const read = files([]);
    await toReview();

    expect(read).not.toHaveBeenCalled();
    expect(card().stageOwnerPick).toMatchObject({ small: false, reason: { code: 'no_points' } });
  });

  it('forgets the pick when the card leaves the stage', async () => {
    await setup();
    files(['src/web/login.ts']);
    await toReview();
    expect(card().stageOwnerPick).toBeTruthy();

    await h.domain.tasks.moveToStage('AR', 'AR-1', 'development', aiActor('cr'));
    expect(card().stageOwnerPick ?? null).toBeNull();
  });

  it.each([
    ['a small card', ['src/web/login.ts'], undefined],
    ['a card with a central file', ['src/core/moves.ts'], { type: 'task', taskKey: 'AR-2' }],
  ] as const)(
    'routes a message about %s to the card itself for its owner, else to the session on a family card',
    async (_name, paths, route) => {
      await setup();
      files(paths);
      await toReview();
      // The hand-over session on the card is over; the small owner works on a sub-card.
      for (const spec of h.runner.started.filter((s) => s.member === 'dev-2'))
        h.runner.emit({ type: 'exit', sessionId: spec.sessionId, exitCode: 0, signal: null });
      await flush();
      await h.domain.tasks.create('AR', { title: 'Cart', parentKey: 'AR-1' }, OWNER_ACTOR);
      const { session } = await h.domain.sessions.ensureSession('AR', 'dev-2', {
        type: 'task',
        taskKey: 'AR-2',
      });
      h.runner.setState(session.id, 'working');
      await flush();

      const sent = await h.domain.messaging.sendReporting(
        'AR',
        'owner',
        { to: ['dev-2'], text: 'Look at the login page.', taskKey: 'AR-1' },
        {},
      );
      expect(sent.message.receipts![0]!.route).toEqual(route);
    },
  );

  it('takes the pick of a hand-on request the owner approves, from the files read at the approval', async () => {
    await setup(2, true, true);
    files(['src/web/login.ts']);
    await toReview();
    expect(card().stageId).toBe('development');
    const [item] = h.domain.inbox.list('AR', { kind: 'hand_on', taskKey: 'AR-1' });

    await h.domain.inbox.resolve('AR', item!.id, { optionId: 'move' }, { handle: 'owner', access: 'owner' });
    expect(card().stageOwnerPick).toMatchObject({ stageId: 'code_review', small: true });
    expect(stageChange()).toMatchObject({ ownerPick: { small: true, owners: ['dev-2'] } });
  });

  it('records no pick for a stage without the rule', async () => {
    await setup(2, false);
    const read = files([]);
    await toReview();

    expect(read).not.toHaveBeenCalled();
    expect(card().stageOwnerPick ?? null).toBeNull();
    expect(stageChange()).not.toHaveProperty('ownerPick');
  });
});
