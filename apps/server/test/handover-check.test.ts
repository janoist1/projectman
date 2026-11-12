import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import type { HandoverCheckRead, HandoverCheckRecord } from '@projectman/shared';
import { aiActor } from '../src/kernel';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';

/*
 * PM-1380: with a hand-over check set for the repository, the move into review and a new review round need its
 * green result on the commit handed over, or the developer's recorded reason. Without the setting nothing is read.
 */

const COMMAND = 'npm run handover-check';
const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);

const head = (commit: string, dirty = false) => ({
  commit,
  branch: 'task/AR-1',
  dirty,
  changes: dirty ? 2 : 0,
  path: '/fake/worktree',
  committedAt: null,
});

const green = (commit: string): HandoverCheckRecord => ({
  version: 1,
  commit,
  clean: true,
  outcome: 'passed',
  exitCode: 0,
  startedAt: '2026-11-12T10:00:00.000Z',
  finishedAt: '2026-11-12T10:01:00.000Z',
});

describe('the hand-over check gate', () => {
  let h: DomainHarness;
  let read: MockInstance;

  async function setup(opts: { withCheck?: boolean; record?: HandoverCheckRead } = {}) {
    h = await createDomainHarness({
      adjust: (config) => {
        if (opts.withCheck !== false) config.project.repos[0]!.handoverCheck = { command: COMMAND };
      },
    });
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
    await h.domain.taskStarts.start('AR', 'AR-1', { assignee: 'dev-1', actor: OWNER_ACTOR, author: OWNER });
    const worktree = h.worktrees.existing.get('AR/AR-1/web')!.path;
    h.worktrees.heads.set(worktree, head(COMMIT_A));
    read = vi.spyOn(h.domain.sessions, 'handoverCheck').mockResolvedValue(opts.record ?? null);
    return worktree;
  }
  const toReview = () => h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', aiActor('dev-1'));
  const exceptions = () =>
    h.domain.timeline.list('AR', { taskKey: 'AR-1' }).filter((e) => e.type === 'handover_check_exception');

  afterEach(async () => {
    await h.cleanup();
  });

  it('refuses the move into review without a result, naming the cause, the command and the way out', async () => {
    await setup();
    await expect(toReview()).rejects.toMatchObject({
      code: 'handover_check_missing',
      message: expect.stringContaining(COMMAND),
      details: expect.objectContaining({ command: COMMAND, commit: COMMIT_A, miss: 'no_record' }),
    });
    await expect(toReview()).rejects.toMatchObject({
      message: expect.stringContaining('handover_check_exception'),
    });
    expect(h.domain.tasks.get('AR', 'AR-1').stageId).not.toBe('code_review');
  });

  it('refuses a result of another commit and says which commit it was', async () => {
    await setup({ record: green(COMMIT_B) });
    await expect(toReview()).rejects.toMatchObject({
      code: 'handover_check_missing',
      details: expect.objectContaining({ miss: 'other_commit', recordCommit: COMMIT_B }),
    });
  });

  it('lets the move through with a green result on the commit', async () => {
    await setup({ record: green(COMMIT_A) });
    await toReview();
    expect(h.domain.tasks.get('AR', 'AR-1').stageId).toBe('code_review');
  });

  it('asks for a result of an old engine as engine_outdated', async () => {
    await setup({ record: 'unsupported' });
    await expect(toReview()).rejects.toMatchObject({
      details: expect.objectContaining({ miss: 'engine_outdated' }),
    });
  });

  it('reads nothing and changes nothing without the setting', async () => {
    await setup({ withCheck: false });
    await toReview();
    expect(read).not.toHaveBeenCalled();
    expect(h.domain.tasks.get('AR', 'AR-1').stageId).toBe('code_review');
  });

  it('lets the move through with a reason given in the same call, and records the reason', async () => {
    await setup();
    await h.domain.tasks.update(
      'AR',
      'AR-1',
      { stageId: 'code_review', handoverCheckException: 'the sandbox refused the check (exit 78)' },
      aiActor('dev-1'),
    );
    expect(h.domain.tasks.get('AR', 'AR-1').stageId).toBe('code_review');
    expect(exceptions()).toHaveLength(1);
    expect(exceptions()[0]!.data).toMatchObject({
      commit: COMMIT_A,
      reason: 'the sandbox refused the check (exit 78)',
    });
  });

  it('records a reason on its own and accepts it at the next hand-over of that commit', async () => {
    await setup();
    await h.domain.tasks.update(
      'AR',
      'AR-1',
      { handoverCheckException: 'no pseudo-terminal' },
      aiActor('dev-1'),
    );
    expect(exceptions()).toHaveLength(1);
    await toReview();
    expect(h.domain.tasks.get('AR', 'AR-1').stageId).toBe('code_review');
  });

  it('does not accept the reason of an earlier commit for a new one', async () => {
    const worktree = await setup();
    await h.domain.tasks.update(
      'AR',
      'AR-1',
      { handoverCheckException: 'no pseudo-terminal' },
      aiActor('dev-1'),
    );
    h.worktrees.heads.set(worktree, head(COMMIT_B));
    await expect(toReview()).rejects.toMatchObject({ code: 'handover_check_missing' });
  });

  it('refuses a reason on its own over uncommitted work and without a setting', async () => {
    const worktree = await setup();
    h.worktrees.heads.set(worktree, head(COMMIT_A, true));
    await expect(
      h.domain.tasks.update('AR', 'AR-1', { handoverCheckException: 'no pseudo-terminal' }, aiActor('dev-1')),
    ).rejects.toMatchObject({ code: 'handover_uncommitted' });
    await h.cleanup();
    await setup({ withCheck: false });
    await expect(
      h.domain.tasks.update('AR', 'AR-1', { handoverCheckException: 'no pseudo-terminal' }, aiActor('dev-1')),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  describe('a new review round', () => {
    async function inReview() {
      await setup({ record: green(COMMIT_A) });
      await toReview();
      const worktree = h.worktrees.existing.get('AR/AR-1/web')!.path;
      h.worktrees.heads.set(worktree, head(COMMIT_B));
    }

    it('is refused for a new commit without a green result, and not for one with a reason', async () => {
      await inReview();
      await expect(h.domain.tasks.repinReview('AR', 'AR-1', 'dev-1')).rejects.toMatchObject({
        code: 'handover_check_missing',
        details: expect.objectContaining({ commit: COMMIT_B, miss: 'other_commit' }),
      });
      await h.domain.tasks.update(
        'AR',
        'AR-1',
        { handoverCheckException: 'no pseudo-terminal' },
        aiActor('dev-1'),
      );
      await h.domain.tasks.repinReview('AR', 'AR-1', 'dev-1');
      expect(h.domain.tasks.get('AR', 'AR-1').reviewPin?.commit).toBe(COMMIT_B);
    });

    it('is refused by send_message too, so no round starts', async () => {
      await inReview();
      const round = vi.spyOn(h.domain.sessions, 'requestReviewRound');
      await expect(
        h.domain.messaging.send('AR', 'dev-1', {
          to: ['cr'],
          text: 'Fixed, please look again.',
          taskKey: 'AR-1',
        }),
      ).rejects.toMatchObject({ code: 'handover_check_missing' });
      expect(round).not.toHaveBeenCalled();
    });
  });
});
