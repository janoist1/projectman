import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TeamToolError } from '../src/contracts';
import type { ToolContext } from '../src/contracts';
import { aiActor } from '../src/domain';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { rejection } from './helpers/errors';
import { flush } from './helpers/fakes';

const toolError = (promise: Promise<unknown>) => rejection(promise, TeamToolError);

/** One change of a task, from the REST PATCH and from the update_task team tool alike. */
describe('task updates', () => {
  let h: DomainHarness;
  beforeEach(async () => {
    h = await createDomainHarness({
      adjust: (config) => {
        config.pipeline.labels.push({
          id: 'needs-info',
          name: 'Needs information',
          notifyAssignee: true,
          setBy: 'anyone',
        });
      },
    });
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
  });
  afterEach(() => h.cleanup());

  const reviewer: ToolContext = { projectKey: 'AR', member: 'cr', sessionId: 'ses_cr', taskKey: 'AR-1' };
  const task = () => h.domain.tasks.get('AR', 'AR-1');
  const events = () => h.domain.timeline.list('AR', { taskKey: 'AR-1' }).map((e) => e.type);

  it('update_task changes nothing when one of its labels is refused', async () => {
    const before = events();
    const err = await toolError(
      h.domain.teamTools.updateTask(reviewer, {
        taskKey: 'AR-1',
        title: 'Renamed by the reviewer',
        addLabels: ['merge-ok'],
        note: 'Approving it myself',
      }),
    );
    expect(err.code).toBe('forbidden');
    expect(task().title).toBe('Login page');
    expect(task().labels).toEqual([]);
    expect(events()).toEqual(before);
  });

  it('update_task changes nothing when the stage move is gate blocked', async () => {
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', OWNER_ACTOR);
    const before = events();
    const err = await toolError(
      h.domain.teamTools.updateTask(reviewer, {
        taskKey: 'AR-1',
        title: 'Renamed by the reviewer',
        note: 'Moving on',
        stageId: 'merge',
      }),
    );
    expect(err.code).toBe('gate_blocked');
    expect(err.message).toContain('the label "code-review-ok" is missing');
    expect(task()).toMatchObject({ title: 'Login page', stageId: 'code_review' });
    expect(events()).toEqual(before);
  });

  it('a PATCH changes labels before the stage move, like update_task', async () => {
    await h.domain.tasks.changeLabels('AR', 'AR-1', { add: ['waiting'] }, OWNER_ACTOR);
    // The blocking label comes off in the same change that moves the task on.
    const moved = await h.domain.tasks.update(
      'AR',
      'AR-1',
      { labels: [], stageId: 'development' },
      OWNER_ACTOR,
    );
    expect(moved).toMatchObject({ stageId: 'development', labels: [] });
    expect(events().slice(-2)).toEqual(['task_labels_changed', 'task_stage_changed']);
  });

  it('a PATCH label change notifies the assignee when the label asks for it', async () => {
    h.domain.tasks.assign('AR', 'AR-1', 'dev-1', OWNER_ACTOR);
    await h.domain.tasks.update('AR', 'AR-1', { labels: ['needs-info'] }, OWNER_ACTOR);
    await flush();
    expect(h.domain.messages.list('AR', { member: 'dev-1' })).toMatchObject([
      { from: 'owner', to: ['dev-1'], taskKey: 'AR-1', body: 'Needs information' },
    ]);
  });

  it('a PATCH that needs an approval requests it with the rest applied', async () => {
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', OWNER_ACTOR);
    await h.domain.tasks.changeLabels('AR', 'AR-1', { add: ['code-review-ok'] }, aiActor('cr'));
    const err = await rejection(
      h.domain.tasks.update('AR', 'AR-1', { title: 'Login page, reviewed', stageId: 'merge' }, OWNER_ACTOR),
    );
    expect(err.code).toBe('approval_requested');
    expect(task()).toMatchObject({
      title: 'Login page, reviewed',
      stageId: 'code_review',
      status: 'waiting',
    });
  });

  it('keeps a change made while an update waited for the configuration', async () => {
    const update = h.domain.tasks.update('AR', 'AR-1', { title: 'Renamed', labels: ['tag'] }, OWNER_ACTOR);
    // Runs while the update awaits the project configuration.
    h.domain.tasks.assign('AR', 'AR-1', 'dev-2', OWNER_ACTOR);
    await update;
    expect(task()).toMatchObject({ title: 'Renamed', labels: ['tag'], assignee: 'dev-2' });
  });
});
