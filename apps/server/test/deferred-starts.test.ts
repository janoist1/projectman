import { LOCAL_ENGINE_ID } from '@projectman/shared';
import type { ProjectConfig } from '@projectman/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '../src/runner/test-helpers';
import { createDomainHarness, OWNER, OWNER_ACTOR, restartDomainHarness } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush, planUsage, settle } from './helpers/fakes';
import { deferredStartRecords } from './helpers/deferred-starts';
import { conflict } from '../src/kernel';
import { withoutOnboarding } from './helpers/onboarding';

/**
 * The automatic session starts admission refused (a stage hand-over, a message wake-up) are kept
 * in SQLite as well as in memory: a restart loads them back and retries them as usual, and only
 * what was actually deferred comes back. While the project's AI switch is off, the retry timer
 * leaves the starts that wait for it alone.
 */

const aiOff = (config: ProjectConfig) => void (config.team.limits.aiEnabled = false);

/**
 * The owner also owns the code review step and may record code reviews, so the reviewer can be
 * retired without orphaning the step or the gate.
 */
const reviewersBesidesCr = (config: ProjectConfig) => {
  for (const label of config.pipeline.labels)
    if (label.group === 'code-review') label.setBy = { duties: ['code_review'], members: ['owner'] };
  const review = config.pipeline.stages.find((stage) => stage.id === 'code_review')!;
  review.owners = [...(review.owners ?? []), 'owner'];
};

/** The keys of the starts SQLite holds, oldest first. */
const stored = (h: DomainHarness) => deferredStartRecords(h.repos).map((record) => record.key);

/**
 * The sessions started on a card. The Operator may be woken about a long-idle imported card (an
 * `idle` signal, PM-547): that is a general session, not a start of the card's own work.
 */
const taskSessions = (h: DomainHarness) =>
  h.repos.sessions.list('AR').filter((session) => session.workItem.type === 'task');

async function setEnabled(h: DomainHarness, aiEnabled: boolean, projectKey = 'AR') {
  await h.domain.projects.update(projectKey, { actor: OWNER_ACTOR, author: OWNER }, (config) => {
    config.team.limits.aiEnabled = aiEnabled;
    return 'Set AI admission';
  });
}

describe('deferred starts across a restart', () => {
  let h: DomainHarness;
  afterEach(() => h?.cleanup());

  it('keeps a hand-over deferred while AI is off, and starts it once AI is on after a restart', async () => {
    h = await createDomainHarness({ persistent: true, adjust: aiOff });
    const task = await h.domain.tasks.create('AR', { title: 'Fictional review' }, OWNER_ACTOR);
    await h.domain.tasks.moveToStage('AR', task.key, 'code_review', OWNER_ACTOR);
    const waiting = await waitFor(() => h.domain.tasks.get('AR', task.key).startWaiting);
    expect(waiting).toMatchObject({ reason: 'ai_disabled', member: 'cr', since: expect.any(String) });
    expect(stored(h)).toEqual(['hand-over:AR:AR-1']);
    expect(h.repos.deferredStarts.list()).toEqual([]);
    expect(h.repos.memberQueue.listOpen('AR', 'cr')[0]).toMatchObject({
      kind: 'start',
      source: { type: 'start', id: expect.stringMatching(/^hand-over:AR:AR-1#mqi_/) },
      wait: { code: 'ai_disabled' },
    });

    h = await restartDomainHarness(h);
    // The same task shows the same reason since the same time, and nothing has started.
    expect(h.domain.tasks.get('AR', task.key).startWaiting).toEqual(waiting);
    expect(h.domain.tasks.list('AR').find((t) => t.key === task.key)?.startWaiting).toEqual(waiting);
    await settle();
    expect(h.runner.started).toHaveLength(0);
    expect(stored(h)).toEqual(['hand-over:AR:AR-1']);

    await setEnabled(h, true);
    await waitFor(() => h.domain.sessions.findRunning('AR', 'cr', { type: 'task', taskKey: task.key }));
    expect(h.runner.started).toHaveLength(1);
    expect(h.runner.lastStarted()).toMatchObject({
      member: 'cr',
      resume: false,
      initialMessage: 'Brief for AR-1: Fictional review',
    });
    expect(h.domain.tasks.get('AR', task.key).startWaiting).toBeUndefined();
    expect(stored(h)).toEqual([]);
  });

  it('keeps a queued message wake-up through a restart and delivers the message once', async () => {
    h = await createDomainHarness({ persistent: true, adjust: aiOff });
    const task = await h.domain.tasks.create('AR', { title: 'Fictional question' }, OWNER_ACTOR);
    const message = await h.domain.messaging.send('AR', 'owner', {
      to: ['dev-1'],
      text: 'Inspect this fictional task.',
      taskKey: task.key,
    });
    // The message waits in the member's queue with the code of what stops it, not in the deferred starts.
    await waitFor(() => h.repos.memberQueue.listOpen('AR', 'dev-1')[0]?.wait);
    expect(h.repos.memberQueue.listOpen('AR', 'dev-1')[0]?.wait).toMatchObject({ code: 'ai_disabled' });
    expect(stored(h)).toEqual([]);

    h = await restartDomainHarness(h);
    expect(h.repos.memberQueue.listOpen('AR', 'dev-1')).toHaveLength(1);
    expect(h.repos.messages.get(message.id)?.deliveredAt).toBeNull();

    await setEnabled(h, true);
    await waitFor(() => h.repos.messages.get(message.id)?.deliveredAt);
    expect(h.runner.started).toHaveLength(1);
    expect(h.runner.lastStarted().initialMessage).toContain('Inspect this fictional task.');
    expect(h.runner.messages).toEqual([]);
    expect(h.repos.memberQueue.listOpen('AR', 'dev-1')).toEqual([]);
    await h.domain.memberQueueDriver.sweep();
    expect(h.runner.started).toHaveLength(1);
  });

  it('migrates a legacy known-member deferral into the queue on restart and starts it', async () => {
    h = await createDomainHarness({ persistent: true, adjust: aiOff });
    const task = await h.domain.tasks.create(
      'AR',
      {
        title: 'Legacy review',
        stageId: 'code_review',
        importedAt: new Date().toISOString(),
      },
      OWNER_ACTOR,
    );
    h.repos.deferredStarts.save({
      key: `hand-over:AR:${task.key}`,
      projectKey: 'AR',
      taskKey: task.key,
      spec: {
        kind: 'hand_over',
        projectKey: 'AR',
        taskKey: task.key,
        from: 'development',
        to: 'code_review',
        actor: OWNER_ACTOR,
      },
      waiting: { reason: 'ai_disabled', member: 'cr', since: new Date().toISOString() },
    });
    h = await restartDomainHarness(h);
    expect(h.repos.deferredStarts.list()).toEqual([]);
    expect(h.repos.memberQueue.listOpen('AR', 'cr')).toContainEqual(
      expect.objectContaining({ kind: 'start', taskKey: task.key }),
    );
    await setEnabled(h, true);
    await waitFor(() => h.domain.sessions.findRunning('AR', 'cr', { type: 'task', taskKey: task.key }));
    expect(h.domain.memberQueue.view('AR', 'cr').closed).toContainEqual(
      expect.objectContaining({ closeReason: 'started' }),
    );
  });

  it('rekeys a restored queued start without auditing a source closure', async () => {
    h = await createDomainHarness({ persistent: true, adjust: aiOff });
    const task = await h.domain.tasks.create('AR', { title: 'Renamed start key' }, OWNER_ACTOR);
    await h.domain.tasks.moveToStage('AR', task.key, 'code_review', OWNER_ACTOR);
    const item = await waitFor(() => h.repos.memberQueue.listOpen('AR', 'cr')[0]);
    const payload = h.repos.memberQueue.payload(item.id) as { spec: unknown; waiting: unknown };
    h.repos.memberQueue.setPayload(item.id, { ...payload, key: 'legacy-hand-over-key' });
    h = await restartDomainHarness(h);
    expect(h.repos.memberQueue.get(item.id)).toMatchObject({ state: 'cancelled', closeReason: 'stale' });
    expect(stored(h)).toEqual([`hand-over:AR:${task.key}`]);
    expect(
      h.domain.timeline
        .list('AR', { taskKey: task.key })
        .filter((event) => event.type === 'member_queue_item_closed'),
    ).toEqual([]);
  });

  it('audits a queued start cancelled by a non-deferrable refusal', async () => {
    h = await createDomainHarness({ adjust: aiOff });
    const task = await h.domain.tasks.create('AR', { title: 'Refused review' }, OWNER_ACTOR);
    await h.domain.tasks.moveToStage('AR', task.key, 'code_review', OWNER_ACTOR);
    await waitFor(() => h.repos.memberQueue.listOpen('AR', 'cr')[0]);
    vi.spyOn(h.domain.admission, 'start').mockRejectedValue(
      conflict('repo_required', 'No repository selected'),
    );
    await setEnabled(h, true);
    await waitFor(() => h.domain.memberQueue.view('AR', 'cr').closed[0]);
    expect(h.domain.memberQueue.view('AR', 'cr').closed[0]).toMatchObject({
      state: 'cancelled',
      closeReason: 'source_closed',
    });
    expect(
      h.domain.timeline
        .list('AR', { taskKey: task.key })
        .filter((event) => event.type === 'member_queue_item_closed'),
    ).toHaveLength(1);
  });

  it('recovers a start known only to the queue without starting it twice', async () => {
    h = await createDomainHarness();
    const task = await h.domain.tasks.create(
      'AR',
      {
        title: 'Lost retry',
        stageId: 'code_review',
        importedAt: new Date().toISOString(),
      },
      OWNER_ACTOR,
    );
    const key = `hand-over:AR:${task.key}`;
    const id = 'mqi_lost_retry';
    h.repos.memberQueue.insert({
      id,
      projectKey: 'AR',
      member: 'cr',
      kind: 'start',
      source: { type: 'start', id: `${key}#${id}` },
      place: { type: 'task', taskKey: task.key },
      taskKey: task.key,
      wake: true,
      title: task.title,
      from: null,
      queuedAt: new Date().toISOString(),
      payload: {
        key,
        spec: {
          kind: 'hand_over',
          projectKey: 'AR',
          taskKey: task.key,
          from: 'development',
          to: 'code_review',
          actor: OWNER_ACTOR,
        },
        waiting: { reason: 'ai_disabled', member: 'cr', since: new Date().toISOString() },
      },
    });
    await Promise.all([h.domain.memberQueueDriver.sweep(), h.domain.memberQueueDriver.ensure('AR', 'cr')]);
    expect(h.runner.started).toHaveLength(1);
    expect(h.repos.memberQueue.get(id)).toMatchObject({ state: 'done', closeReason: 'started' });
  });

  it('keeps the closed history when another round reuses the same automatic start key', async () => {
    h = await createDomainHarness({ adjust: aiOff });
    const task = await h.domain.tasks.create('AR', { title: 'Review rounds' }, OWNER_ACTOR);
    await h.domain.tasks.moveToStage('AR', task.key, 'code_review', OWNER_ACTOR);
    const first = await waitFor(() => h.repos.memberQueue.listOpen('AR', 'cr')[0]);
    await h.domain.tasks.moveToStage('AR', task.key, 'development', OWNER_ACTOR);
    await h.domain.tasks.moveToStage('AR', task.key, 'code_review', OWNER_ACTOR);
    const second = await waitFor(() =>
      h.repos.memberQueue.listOpen('AR', 'cr').find((item) => item.id !== first.id),
    );
    expect(second.source.id).not.toBe(first.source.id);
    expect(h.repos.memberQueue.get(first.id)).toMatchObject({
      state: 'cancelled',
      closeReason: 'source_closed',
    });
    await setEnabled(h, true);
    await waitFor(() => h.repos.memberQueue.get(second.id)?.state === 'done');
    expect(h.domain.memberQueue.view('AR', 'cr').closed.filter((item) => item.kind === 'start')).toHaveLength(
      2,
    );
  });

  it('holds a queued start while waiting-answer is present and wakes it when the label is removed', async () => {
    h = await createDomainHarness({
      adjust: (config) => {
        aiOff(config);
        config.pipeline.labels.push({
          id: 'waiting-answer',
          name: 'Waiting for an answer',
          blocks: true,
          setBy: 'anyone',
        });
      },
    });
    const task = await h.domain.tasks.create('AR', { title: 'Held review' }, OWNER_ACTOR);
    await h.domain.tasks.moveToStage('AR', task.key, 'code_review', OWNER_ACTOR);
    await waitFor(() => h.repos.memberQueue.listOpen('AR', 'cr')[0]);
    h.domain.tasks.changeLabels('AR', task.key, { add: ['waiting-answer'] }, OWNER_ACTOR);
    await waitFor(() => h.repos.memberQueue.listOpen('AR', 'cr')[0]?.wait?.code === 'hold_waiting_answer');
    const attempt = vi.spyOn(h.domain.admission, 'attempt');
    await setEnabled(h, true);
    await h.domain.admission.retryDeferred();
    await h.domain.memberQueueDriver.sweep();
    expect(attempt.mock.calls.filter(([start]) => start.taskKey === task.key)).toHaveLength(0);
    expect(h.runner.started).toHaveLength(0);
    h.domain.tasks.changeLabels('AR', task.key, { remove: ['waiting-answer'] }, OWNER_ACTOR);
    await waitFor(() => h.domain.sessions.findRunning('AR', 'cr', { type: 'task', taskKey: task.key }));
    expect(h.domain.memberQueue.view('AR', 'cr').closed[0]).toMatchObject({ closeReason: 'started' });
  });

  it('stores the real reason for a fresh start already held for an answer', async () => {
    h = await createDomainHarness({
      adjust: (config) => {
        config.pipeline.labels.push({
          id: 'waiting-answer',
          name: 'Waiting for an answer',
          blocks: true,
          setBy: 'anyone',
        });
      },
    });
    const task = await h.domain.tasks.create(
      'AR',
      {
        title: 'Held before admission',
        stageId: 'code_review',
        importedAt: new Date().toISOString(),
        labels: ['waiting-answer'],
      },
      OWNER_ACTOR,
    );
    await h.domain.handOver.handOff({ task, from: 'development', to: 'code_review', actor: OWNER_ACTOR });
    const item = h.repos.memberQueue.listOpen('AR', 'cr')[0]!;
    expect(item.wait?.code).toBe('hold_waiting_answer');
    expect(h.repos.memberQueue.payload(item.id)).toMatchObject({
      waiting: { reason: 'waiting_answer', member: 'cr' },
    });
    expect(h.domain.tasks.get('AR', task.key).startWaiting).toBeUndefined();
    expect(h.runner.started).toHaveLength(0);
  });

  it('retries what was deferred at startup when AI is on, without waiting for the timer', async () => {
    h = await createDomainHarness({ persistent: true, planUsagePercent: 95 });
    const task = await h.domain.tasks.create('AR', { title: 'Fictional review' }, OWNER_ACTOR);
    await h.domain.tasks.moveToStage('AR', task.key, 'code_review', OWNER_ACTOR);
    await waitFor(() => h.domain.tasks.get('AR', task.key).startWaiting);
    expect(h.domain.tasks.get('AR', task.key).startWaiting).toMatchObject({ reason: 'plan_usage_paused' });
    expect(stored(h)).toEqual(['hand-over:AR:AR-1']);

    // The new server finds plenty of plan left.
    h = await restartDomainHarness(h);
    await waitFor(() => h.runner.started.length === 1);
    expect(h.runner.lastStarted()).toMatchObject({ member: 'cr', resume: false });
    await flush();
    expect(h.domain.tasks.get('AR', task.key).startWaiting).toBeUndefined();
    expect(stored(h)).toEqual([]);
  });

  it('applies admission to a restored start as usual', async () => {
    h = await createDomainHarness({ persistent: true, planUsagePercent: 95 });
    const task = await h.domain.tasks.create('AR', { title: 'Fictional review' }, OWNER_ACTOR);
    await h.domain.tasks.moveToStage('AR', task.key, 'code_review', OWNER_ACTOR);
    const waiting = await waitFor(() => h.domain.tasks.get('AR', task.key).startWaiting);

    // Still short of plan after the restart: the startup retry is refused and the start keeps waiting.
    h = await restartDomainHarness(h, { planUsagePercent: 90 });
    await settle();
    expect(h.runner.started).toHaveLength(0);
    expect(h.domain.tasks.get('AR', task.key).startWaiting).toMatchObject({
      reason: 'plan_usage_paused',
      member: 'cr',
      since: waiting.since,
    });
    expect(stored(h)).toEqual(['hand-over:AR:AR-1']);

    h.runnerModule.planUsage.value = planUsage(10);
    await h.domain.admission.retryDeferred();
    expect(h.runner.started).toHaveLength(1);
    expect(stored(h)).toEqual([]);
  });

  describe('what the plan usage held back (PM-1133)', () => {
    const deferHandOver = async () => {
      h = await createDomainHarness({ persistent: true, planUsagePercent: 95 });
      const task = await h.domain.tasks.create('AR', { title: 'Fictional review' }, OWNER_ACTOR);
      await h.domain.tasks.moveToStage('AR', task.key, 'code_review', OWNER_ACTOR);
      await waitFor(() => h.domain.tasks.get('AR', task.key).startWaiting);
      expect(h.domain.tasks.get('AR', task.key).startWaiting).toMatchObject({ reason: 'plan_usage_paused' });
      return task;
    };

    it('starts a deferred hand-over once the usage falls below the threshold, without another event', async () => {
      await deferHandOver();
      expect(h.runner.started).toHaveLength(0);
      h.runnerModule.planUsage.value = planUsage(10);
      await h.domain.planUsage.get('claude', LOCAL_ENGINE_ID);
      await waitFor(() => h.runner.started.length === 1);
      expect(h.runner.lastStarted()).toMatchObject({ member: 'cr' });
    });

    it('starts a queued message once the usage falls below the threshold, without another event', async () => {
      h = await createDomainHarness({ persistent: true, planUsagePercent: 95 });
      await h.domain.messaging.send('AR', 'owner', { to: ['cr'], text: 'Please check Acme.' });
      const item = await waitFor(() => h.repos.memberQueue.listOpen('AR', 'cr').find((item) => item.wait));
      h.repos.memberQueue.clearWait(item.id);
      expect(h.runner.started).toHaveLength(0);
      h.runnerModule.planUsage.value = planUsage(10);
      await h.domain.planUsage.get('claude', LOCAL_ENGINE_ID);
      await waitFor(() => h.runner.started.length === 1);
      expect(h.runner.lastStarted()).toMatchObject({ member: 'cr' });
    });

    it('starts a deferred hand-over once the pause threshold is raised above the usage', async () => {
      await deferHandOver();
      await h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (config) => {
        config.team.limits.pauseAbovePlanUsagePercent = 100;
        return 'Raise the pause threshold';
      });
      await waitFor(() => h.runner.started.length === 1);
    });

    it('starts a message with no wait code once the pause threshold is raised', async () => {
      h = await createDomainHarness({ persistent: true, planUsagePercent: 95 });
      await h.domain.messaging.send('AR', 'owner', { to: ['cr'], text: 'Please check Acme.' });
      const item = await waitFor(() => h.repos.memberQueue.listOpen('AR', 'cr').find((item) => item.wait));
      h.repos.memberQueue.clearWait(item.id);
      await h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (config) => {
        config.team.limits.pauseAbovePlanUsagePercent = 100;
        return 'Raise the pause threshold';
      });
      await waitFor(() => h.runner.started.length === 1);
    });

    it('starts a queued message with no wait code after a restart without another event', async () => {
      h = await createDomainHarness({ persistent: true, planUsagePercent: 95 });
      await h.domain.messaging.send('AR', 'owner', { to: ['cr'], text: 'Please check Acme.' });
      const item = await waitFor(() => h.repos.memberQueue.listOpen('AR', 'cr').find((item) => item.wait));
      h.repos.memberQueue.clearWait(item.id);
      expect(stored(h)).toEqual([]);
      h = await restartDomainHarness(h, { planUsagePercent: 10 });
      await waitFor(() => h.runner.started.length === 1);
      expect(h.runner.lastStarted()).toMatchObject({ member: 'cr' });
    });

    it('does not start anything while the usage stays above the threshold', async () => {
      await deferHandOver();
      h.runnerModule.planUsage.value = planUsage(92);
      await h.domain.planUsage.get('claude', LOCAL_ENGINE_ID);
      await settle();
      expect(h.runner.started).toHaveLength(0);
    });
  });

  it('retries the restored starts in the order they were deferred in', async () => {
    h = await createDomainHarness({ persistent: true, planUsagePercent: 95 });
    const first = await h.domain.tasks.create('AR', { title: 'First' }, OWNER_ACTOR);
    const second = await h.domain.tasks.create('AR', { title: 'Second' }, OWNER_ACTOR);
    await h.domain.tasks.moveToStage('AR', second.key, 'code_review', OWNER_ACTOR);
    await h.domain.tasks.moveToStage('AR', first.key, 'code_review', OWNER_ACTOR);
    await waitFor(() => stored(h).length === 2);
    expect(stored(h)).toEqual(['hand-over:AR:AR-2', 'hand-over:AR:AR-1']);

    // The retry at startup is refused again (too little plan): the order is kept, and so is it at the next.
    h = await restartDomainHarness(h, { planUsagePercent: 90 });
    await settle();
    expect(stored(h)).toEqual(['hand-over:AR:AR-2', 'hand-over:AR:AR-1']);
    const attempt = vi.spyOn(h.domain.admission, 'attempt');
    await h.domain.admission.retryDeferred();
    expect(attempt.mock.calls.map(([start]) => start.taskKey)).toEqual(['AR-2', 'AR-1']);
  });

  it.each(['moved', 'cancelled'] as const)('forgets a stored start when its task is %s', async (how) => {
    h = await createDomainHarness({ persistent: true, adjust: aiOff });
    const task = await h.domain.tasks.create('AR', { title: 'Fictional review' }, OWNER_ACTOR);
    await h.domain.tasks.moveToStage('AR', task.key, 'code_review', OWNER_ACTOR);
    await waitFor(() => h.domain.tasks.get('AR', task.key).startWaiting);
    expect(stored(h)).toEqual(['hand-over:AR:AR-1']);

    if (how === 'moved') await h.domain.tasks.moveToStage('AR', task.key, 'development', OWNER_ACTOR);
    else await h.domain.tasks.cancel('AR', task.key, { reason: 'Fictional scope change.' }, OWNER_ACTOR);
    await settle();
    expect(stored(h)).toEqual([]);
    expect(h.domain.tasks.get('AR', task.key).startWaiting).toBeUndefined();
    expect(h.domain.memberQueue.view('AR', 'cr').closed).toContainEqual(
      expect.objectContaining({
        kind: 'start',
        state: 'cancelled',
        closeReason: 'source_closed',
      }),
    );
    expect(
      h.domain.timeline
        .list('AR', { taskKey: task.key })
        .filter((event) => event.type === 'member_queue_item_closed'),
    ).toHaveLength(1);

    h = await restartDomainHarness(h);
    await setEnabled(h, true);
    await settle();
    expect(h.domain.tasks.get('AR', task.key).startWaiting).toBeUndefined();
    expect(h.runner.started).toHaveLength(0);
  });

  it.each(['done', 'retired'] as const)('removes the stored starts when the task is %s', async (how) => {
    h = await createDomainHarness({
      persistent: true,
      adjust: reviewersBesidesCr,
      planUsagePercent: 95,
    });
    const task = await h.domain.tasks.create('AR', { title: 'Fictional review' }, OWNER_ACTOR);
    await h.domain.tasks.moveToStage('AR', task.key, 'code_review', OWNER_ACTOR);
    await h.domain.messaging.send('AR', 'owner', { to: ['cr'], text: 'Please review.', taskKey: task.key });
    await waitFor(() => stored(h).length === 1 && h.repos.memberQueue.listOpen('AR', 'cr')[0]?.wait);
    expect(stored(h)).toEqual(['hand-over:AR:AR-1']);

    if (how === 'done') h.repos.tasks.update(task.id, { status: 'done' });
    else await h.domain.members.retire('AR', 'cr', {}, { actor: OWNER_ACTOR, author: OWNER });
    h.runnerModule.planUsage.value = planUsage(10);
    await h.domain.admission.retryDeferred();
    expect(stored(h)).toEqual([]);
    // The owner's message about the finished card goes to the desk and starts it there; a retired member starts nothing.
    await h.domain.memberQueueDriver.sweep();
    await flush();
    expect(h.runner.started.map((spec) => spec.member)).toEqual(how === 'done' ? ['cr'] : []);
  });

  it('does not start work that was never deferred: imported and idle tasks stay as they are after a restart', async () => {
    h = await createDomainHarness({ persistent: true });
    // Imported into a stage an AI member owns, with its original date: it never had a hand-over.
    await h.domain.tasks.create(
      'AR',
      { title: 'Imported review', stageId: 'code_review', importedAt: '2026-01-01T09:00:00.000Z' },
      OWNER_ACTOR,
    );
    // Long idle in the work stage with an assignee, and a queued one nobody touched.
    const idle = await h.domain.tasks.create('AR', { title: 'Idle work' }, OWNER_ACTOR);
    await h.domain.tasks.moveToStage('AR', idle.key, 'development', OWNER_ACTOR);
    h.domain.tasks.assign('AR', idle.key, 'dev-1', OWNER_ACTOR);
    await h.domain.tasks.create('AR', { title: 'Queued' }, OWNER_ACTOR);
    await settle();
    expect(stored(h)).toEqual([]);
    expect(taskSessions(h)).toHaveLength(0);
    // The one start is the Operator's, woken by the imported card's idle signal.
    expect(h.repos.sessions.list('AR').filter((session) => session.workItem.type === 'general')).toHaveLength(
      h.runner.started.length,
    );

    h = await restartDomainHarness(h);
    await settle();
    await h.domain.admission.retryDeferred();
    expect(taskSessions(h)).toHaveLength(0);
    expect(stored(h)).toEqual([]);
    expect(h.domain.tasks.list('AR').filter((t) => t.startWaiting)).toEqual([]);
  });

  it('drops stored starts it cannot read or rebuild, and starts the server anyway', async () => {
    h = await createDomainHarness({ persistent: true, adjust: aiOff });
    const task = await h.domain.tasks.create('AR', { title: 'Fictional review' }, OWNER_ACTOR);
    await h.domain.tasks.moveToStage('AR', task.key, 'code_review', OWNER_ACTOR);
    await waitFor(() => stored(h).length === 1);
    const waiting = { reason: 'ai_disabled', since: '2026-09-30T10:00:00.000Z' };
    const wake = { kind: 'message_wake', projectKey: 'AR', handle: 'cr', workItem: { type: 'general' } };
    const save = (key: string, spec: unknown, reason: unknown = waiting) =>
      h.repos.deferredStarts.save({ key, projectKey: 'AR', taskKey: null, spec, waiting: reason });
    save('from-a-newer-build', { kind: 'something_new', projectKey: 'AR' });
    save('without-stage', wake); // a wake-up always knows its stage (or null)
    save('no-reason', { ...wake, stageId: null }, { since: waiting.since });
    save('gone-task', {
      kind: 'hand_over',
      projectKey: 'AR',
      taskKey: 'AR-99',
      from: 'backlog',
      to: 'code_review',
      actor: { kind: 'system', handle: null },
    });
    h.repos.db
      .prepare(
        `INSERT INTO deferred_starts (key, project_key, task_key, spec, waiting) VALUES ('not-json', 'AR', NULL, '{', 'x')`,
      )
      .run();
    expect(stored(h)).toHaveLength(6);

    h = await restartDomainHarness(h);
    expect(stored(h)).toEqual(['hand-over:AR:AR-1']);
    expect(h.domain.tasks.get('AR', task.key).startWaiting).toMatchObject({ reason: 'ai_disabled' });
  });
});

// The sweep's round itself; its timer is kernel/sweeps.ts's, tested there (PM-613).
describe('the retry timer', () => {
  let h: DomainHarness;
  afterEach(async () => {
    await h?.cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const logged = (info: { mock: { calls: unknown[][] } }, message: string) =>
    info.mock.calls.filter(([, text]) => text === message).map(([fields]) => fields);

  /** One retry round, run to its end. */
  async function tick() {
    await h.domain.admission.retryDeferred();
    await flush(20);
    await settle();
  }

  it('retries queued refusals without repeating their logs', async () => {
    h = await createDomainHarness();
    await withoutOnboarding(h.domain, () =>
      h.domain.projects.create(
        { key: 'BR', name: 'Fictional second project', workspacePath: h.workspace, templateId: 'test' },
        OWNER,
      ),
    );
    // AR: the switch is off, so its hand-over waits for it.
    await setEnabled(h, false, 'AR');
    const off = await h.domain.tasks.create('AR', { title: 'Waits for the switch' }, OWNER_ACTOR);
    await h.domain.tasks.moveToStage('AR', off.key, 'code_review', OWNER_ACTOR);
    // BR: the switch is on, but the reviewer is at capacity.
    const busy = await h.domain.tasks.create('BR', { title: 'Keeps the reviewer busy' }, OWNER_ACTOR);
    await h.domain.sessions.ensureSession('BR', 'cr', { type: 'task', taskKey: busy.key });
    const full = await h.domain.tasks.create('BR', { title: 'Waits for capacity' }, OWNER_ACTOR);
    await h.domain.tasks.moveToStage('BR', full.key, 'code_review', OWNER_ACTOR);
    await waitFor(
      () => h.domain.tasks.get('AR', off.key).startWaiting && h.domain.tasks.get('BR', full.key).startWaiting,
    );
    expect(h.domain.tasks.get('AR', off.key).startWaiting).toMatchObject({ reason: 'ai_disabled' });
    expect(h.domain.tasks.get('BR', full.key).startWaiting).toMatchObject({ reason: 'member_at_capacity' });

    const attempt = vi.spyOn(h.domain.admission, 'attempt');
    const info = vi.spyOn(h.log.logger, 'info');
    await tick();
    await tick();
    expect(attempt.mock.calls.filter(([start]) => start.projectKey === 'AR')).toHaveLength(0);
    expect(
      attempt.mock.calls.some(([start]) => start.projectKey === 'BR' && start.taskKey === full.key),
    ).toBe(true);
    expect(logged(info, 'stage hand-over deferred')).toEqual([]);
    expect(h.domain.tasks.get('AR', off.key).startWaiting).toMatchObject({ reason: 'ai_disabled' });
    expect(stored(h)).toEqual(['hand-over:AR:AR-1', 'hand-over:BR:BR-2']);
    // Only the reviewer's session on the busy task runs.
    expect(h.runner.started).toHaveLength(1);

    // Turning the switch on retries it at once, without a tick.
    await setEnabled(h, true, 'AR');
    await waitFor(() => h.domain.sessions.findRunning('AR', 'cr', { type: 'task', taskKey: off.key }));
    expect(h.domain.tasks.get('AR', off.key).startWaiting).toBeUndefined();
  });

  it('updates the queued wait when the switch turns off and logs the new refusal once', async () => {
    h = await createDomainHarness();
    const busy = await h.domain.tasks.create('AR', { title: 'Keeps the reviewer busy' }, OWNER_ACTOR);
    await h.domain.sessions.ensureSession('AR', 'cr', { type: 'task', taskKey: busy.key });
    const full = await h.domain.tasks.create('AR', { title: 'Waits for capacity' }, OWNER_ACTOR);
    await h.domain.tasks.moveToStage('AR', full.key, 'code_review', OWNER_ACTOR);
    await waitFor(() => h.domain.tasks.get('AR', full.key).startWaiting);
    expect(h.domain.tasks.get('AR', full.key).startWaiting).toMatchObject({ reason: 'member_at_capacity' });

    const info = vi.spyOn(h.log.logger, 'info');
    await setEnabled(h, false);
    await tick();
    expect(logged(info, 'stage hand-over deferred')).toHaveLength(1);
    expect(h.domain.tasks.get('AR', full.key).startWaiting).toMatchObject({ reason: 'ai_disabled' });

    await tick();
    await tick();
    expect(logged(info, 'stage hand-over deferred')).toHaveLength(1);
    expect(h.domain.tasks.get('AR', full.key).startWaiting).toMatchObject({ reason: 'ai_disabled' });
  });

  it('leaves a message wake-up that waits for the switch alone, too', async () => {
    h = await createDomainHarness();
    await setEnabled(h, false);
    const task = await h.domain.tasks.create('AR', { title: 'Fictional question' }, OWNER_ACTOR);
    await h.domain.messaging.send('AR', 'owner', { to: ['cr'], text: 'Please look.', taskKey: task.key });
    await waitFor(() => h.repos.memberQueue.listOpen('AR', 'cr')[0]?.wait);
    await tick();
    await tick();
    expect(h.runner.started).toHaveLength(0);
    await setEnabled(h, true);
    await waitFor(() => h.runner.started.length === 1);
  });
});

describe('message wake-ups at startup and the member capacity (PM-242)', () => {
  let h: DomainHarness;
  afterEach(() => h?.cleanup());

  /** `dev-1` takes one session at a time and AI work is off, so that what is sent waits. */
  const oneAtATimeAiOff = (config: ProjectConfig) => {
    aiOff(config);
    for (const member of config.team.members)
      if (member.kind === 'ai' && member.handle === 'dev-1') member.capacity = 1;
  };

  it('starts one session for two waiting messages to a member of capacity 1, the second after the first ends', async () => {
    h = await createDomainHarness({ persistent: true, adjust: oneAtATimeAiOff });
    const first = await h.domain.tasks.create('AR', { title: 'First question' }, OWNER_ACTOR);
    const second = await h.domain.tasks.create('AR', { title: 'Second question' }, OWNER_ACTOR);
    for (const task of [first, second])
      await h.domain.messaging.send('AR', 'owner', {
        to: ['dev-1'],
        text: 'Please look.',
        taskKey: task.key,
      });
    await waitFor(() => h.repos.memberQueue.listOpen('AR', 'dev-1').length === 2);

    h = await restartDomainHarness(h);
    // The CLI of a started session can take input (it is idle) before its first input is typed.
    h.runner.idleOnStart = true;
    await setEnabled(h, true);
    await waitFor(() => h.runner.started.length >= 1);
    await settle();
    expect(h.runner.started).toHaveLength(1);
    const running = h.domain.sessions.findRunning('AR', 'dev-1', { type: 'task', taskKey: first.key });
    expect(running).not.toBeNull();
    await h.domain.memberQueueDriver.sweep();
    expect(h.repos.memberQueue.listOpen('AR', 'dev-1').map((item) => item.wait?.code)).toEqual([
      'member_at_capacity',
    ]);

    // The first session ends: the second message wakes its recipient now.
    await h.domain.sessions.stop('AR', running!.id);
    await waitFor(() => h.runner.started.length === 2);
    expect(h.runner.lastStarted().initialMessage).toContain('Second question');
    expect(h.repos.memberQueue.listOpen('AR', 'dev-1')).toEqual([]);
  });

  it('stops counting a session that answered and idles on a card the member does not work on', async () => {
    h = await createDomainHarness({ persistent: true, adjust: oneAtATimeAiOff });
    const first = await h.domain.tasks.create('AR', { title: 'First question' }, OWNER_ACTOR);
    const second = await h.domain.tasks.create('AR', { title: 'Second question' }, OWNER_ACTOR);
    for (const task of [first, second])
      await h.domain.messaging.send('AR', 'owner', {
        to: ['dev-1'],
        text: 'Please look.',
        taskKey: task.key,
      });
    await waitFor(() => h.repos.memberQueue.listOpen('AR', 'dev-1').length === 2);

    h = await restartDomainHarness(h);
    h.runner.idleOnStart = true;
    await setEnabled(h, true);
    await waitFor(() => h.runner.started.length >= 1);
    await settle();
    expect(h.runner.started).toHaveLength(1);

    // Its turn runs and ends: it idles on a card the member has no work on, which frees the place.
    const sessionId = h.runner.started[0]!.sessionId;
    h.runner.setState(sessionId, 'working');
    h.runner.setState(sessionId, 'idle');
    await h.domain.memberQueueDriver.sweep();
    await waitFor(() => h.runner.started.length === 2);
  });
});
