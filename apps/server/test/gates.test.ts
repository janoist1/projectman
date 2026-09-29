import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerEvent } from '@projectman/shared';
import { aiActor, DomainError, gatePayload } from '../src/domain';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush, pullRequest } from './helpers/fakes';

const owner = { handle: 'owner', access: 'owner' as const };

async function rejection(promise: Promise<unknown>): Promise<DomainError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DomainError);
  return err as DomainError;
}

describe('stage gates', () => {
  let h: DomainHarness;
  beforeEach(async () => {
    h = await createDomainHarness();
  });
  afterEach(() => h.cleanup());

  async function taskInCodeReview() {
    const task = await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
    const moved = await h.domain.tasks.moveToStage('AR', task.key, 'code_review', OWNER_ACTOR);
    expect(moved.moved).toBe(true);
    return moved.task;
  }

  it('check_passed blocks the move until the check has passed', async () => {
    const task = await taskInCodeReview();
    const err = await rejection(h.domain.tasks.moveToStage('AR', task.key, 'merge', OWNER_ACTOR));
    expect(err.code).toBe('gate_blocked');
    expect(err.details).toMatchObject({
      unmet: [{ stageId: 'merge', condition: { type: 'check_passed', check: 'code_review' } }],
    });

    h.domain.tasks.setCheck('AR', task.key, 'code_review', 'passed', aiActor('cr'));
    const result = await h.domain.tasks.moveToStage('AR', task.key, 'merge', aiActor('cr'));
    expect(result.moved).toBe(false);
    expect(result.pendingApproval).toHaveLength(1);
    expect(result.task.status).toBe('waiting');
    expect(result.task.stageId).toBe('code_review');
  });

  it('evaluates the gates of every stage a forward move passes', async () => {
    const task = await h.domain.tasks.create('AR', { title: 'Skip ahead' }, OWNER_ACTOR);
    const err = await rejection(h.domain.tasks.moveToStage('AR', task.key, 'done', OWNER_ACTOR));
    expect(err.code).toBe('gate_blocked');
    const unmet = (err.details as { unmet: Array<{ stageId: string }> }).unmet.map((u) => u.stageId);
    expect(unmet).toEqual(['merge', 'release']);
    // A new task cannot be created behind a gate either.
    expect(
      (await rejection(h.domain.tasks.create('AR', { title: 'x', stageId: 'merge' }, OWNER_ACTOR))).code,
    ).toBe('gate_blocked');
  });

  it('human_approval: the task moves only after the approver approves', async () => {
    const task = await taskInCodeReview();
    h.domain.tasks.setCheck('AR', task.key, 'code_review', 'passed', aiActor('cr'));
    const events: ServerEvent[] = [];
    h.domain.bus.subscribe((e) => events.push(e));
    const { pendingApproval } = await h.domain.tasks.moveToStage('AR', task.key, 'merge', aiActor('dev-1'));
    const decision = pendingApproval[0]!;
    expect(decision).toMatchObject({
      kind: 'decision',
      assignees: ['owner'],
      source: 'dev-1',
      taskKey: task.key,
    });
    expect(gatePayload(decision)).toMatchObject({
      fromStageId: 'code_review',
      toStageId: 'merge',
      stageId: 'merge',
    });
    expect(events.some((e) => e.type === 'inbox_upserted' && e.item.id === decision.id)).toBe(true);

    // Asking again does not create a second request.
    const again = await h.domain.tasks.moveToStage('AR', task.key, 'merge', aiActor('dev-1'));
    expect(again.pendingApproval.map((i) => i.id)).toEqual([decision.id]);

    await h.domain.inbox.resolve('AR', decision.id, { optionId: 'approve' }, owner);
    const after = h.domain.tasks.get('AR', task.key);
    expect(after.stageId).toBe('merge');
    expect(after.status).toBe('active');
    const moveEvent = h.domain.timeline
      .list('AR', { taskKey: task.key })
      .filter((e) => e.type === 'task_stage_changed')
      .pop()!;
    expect(moveEvent.actor).toEqual({ kind: 'human', handle: 'owner' });
    expect(moveEvent.data).toMatchObject({ from: 'code_review', to: 'merge', approvedBy: ['owner'] });
  });

  it('an AI member or a non-approver can never resolve a gate decision', async () => {
    h.cleanup();
    h = await createDomainHarness({
      adjust: (c) => {
        c.team.members.push({
          kind: 'human',
          handle: 'boss',
          displayName: 'Boss',
          access: 'owner',
          roles: [],
          email: 'b@x',
        });
      },
    });
    const task = await taskInCodeReview();
    h.domain.tasks.setCheck('AR', task.key, 'code_review', 'passed', aiActor('cr'));
    const { pendingApproval } = await h.domain.tasks.moveToStage('AR', task.key, 'merge', aiActor('dev-1'));
    const id = pendingApproval[0]!.id;

    const byAi = await rejection(
      h.domain.inbox.resolve('AR', id, { optionId: 'approve' }, { handle: 'cr', access: 'developer' }),
    );
    expect(byAi.code).toBe('not_an_assignee');
    // Even another owner may not approve a gate they are not an approver of.
    const byOtherOwner = await rejection(
      h.domain.inbox.resolve('AR', id, { optionId: 'approve' }, { handle: 'boss', access: 'owner' }),
    );
    expect(byOtherOwner.code).toBe('not_an_assignee');
    expect(h.domain.tasks.get('AR', task.key).stageId).toBe('code_review');
  });

  it('a rejection keeps the task where it is', async () => {
    const task = await taskInCodeReview();
    h.domain.tasks.setCheck('AR', task.key, 'code_review', 'passed', aiActor('cr'));
    const { pendingApproval } = await h.domain.tasks.moveToStage('AR', task.key, 'merge', aiActor('dev-1'));
    await h.domain.inbox.resolve(
      'AR',
      pendingApproval[0]!.id,
      { optionId: 'reject', note: 'not yet' },
      owner,
    );
    const after = h.domain.tasks.get('AR', task.key);
    expect(after).toMatchObject({ stageId: 'code_review', status: 'active' });
  });

  it('moving the task elsewhere cancels a pending approval request', async () => {
    const task = await taskInCodeReview();
    h.domain.tasks.setCheck('AR', task.key, 'code_review', 'passed', aiActor('cr'));
    const { pendingApproval } = await h.domain.tasks.moveToStage('AR', task.key, 'merge', aiActor('dev-1'));
    await h.domain.tasks.moveToStage('AR', task.key, 'development', OWNER_ACTOR);
    const item = h.domain.inbox.get('AR', pendingApproval[0]!.id);
    expect(item.state).toBe('cancelled');
    expect(h.domain.tasks.get('AR', task.key).status).toBe('active');
    expect(
      (await rejection(h.domain.inbox.resolve('AR', item.id, { optionId: 'approve' }, owner))).code,
    ).toBe('inbox_item_closed');
  });

  it('pr_merged holds only when linked pull requests are merged and none is open', async () => {
    const task = await taskInCodeReview();
    h.domain.tasks.setCheck('AR', task.key, 'code_review', 'passed', aiActor('cr'));
    const request = await h.domain.tasks.moveToStage('AR', task.key, 'merge', aiActor('dev-1'));
    await h.domain.inbox.resolve('AR', request.pendingApproval[0]!.id, { optionId: 'approve' }, owner);

    expect((await rejection(h.domain.tasks.moveToStage('AR', task.key, 'release', OWNER_ACTOR))).code).toBe(
      'gate_blocked',
    );
    h.domain.tasks.addLink(
      'AR',
      task.key,
      { kind: 'pull_request', ref: '7', repo: 'acme/web', state: 'open' },
      aiActor('dev-1'),
    );
    expect((await rejection(h.domain.tasks.moveToStage('AR', task.key, 'release', OWNER_ACTOR))).code).toBe(
      'gate_blocked',
    );
    h.domain.tasks.applyPullRequestUpdate('acme/web', 7, { state: 'merged' });
    const release = await h.domain.tasks.moveToStage('AR', task.key, 'release', OWNER_ACTOR);
    expect(release.pendingApproval).toHaveLength(1); // release also needs the owner's approval
  });

  it('a merged pull request advances the task to a stage gated by pr_merged (via approval)', async () => {
    const task = await taskInCodeReview();
    h.domain.tasks.setCheck('AR', task.key, 'code_review', 'passed', aiActor('cr'));
    const request = await h.domain.tasks.moveToStage('AR', task.key, 'merge', aiActor('dev-1'));
    await h.domain.inbox.resolve('AR', request.pendingApproval[0]!.id, { optionId: 'approve' }, owner);

    h.github.prs.set('acme/web#7', pullRequest());
    await h.domain.teamTools.linkPullRequest(
      { sessionId: 'ses_x', projectKey: 'AR', member: 'dev-1', taskKey: task.key },
      { taskKey: task.key, repo: 'acme/web', number: 7 },
    );
    expect(h.github.isWatched('acme/web', 7)).toBe(true);
    h.github.emit(pullRequest({ state: 'merged' }));
    await flush();

    expect(h.github.isWatched('acme/web', 7)).toBe(false);
    const after = h.domain.tasks.get('AR', task.key);
    expect(after.links[0]).toMatchObject({ kind: 'pull_request', state: 'merged' });
    expect(after.status).toBe('waiting');
    const decisions = h.domain.inbox.list('AR', { kind: 'decision', state: 'open', taskKey: task.key });
    expect(decisions.map((d) => gatePayload(d)?.toStageId)).toEqual(['release']);
  });

  it('backward moves check only the target stage', async () => {
    const task = await taskInCodeReview();
    const back = await h.domain.tasks.moveToStage('AR', task.key, 'backlog', OWNER_ACTOR);
    expect(back.moved).toBe(true);
    expect(back.task.stageId).toBe('backlog');
  });
});
