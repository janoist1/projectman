import type { ProjectConfig } from '@projectman/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '../src/runner/test-helpers';
import { createDomainHarness, OWNER, OWNER_ACTOR, restartDomainHarness } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush, planUsage, settle } from './helpers/fakes';

/**
 * The automatic session starts admission refused (a stage hand-over, a message wake-up) are kept
 * in SQLite as well as in memory: a restart loads them back and retries them as usual, and only
 * what was actually deferred comes back. While the project's AI switch is off, the retry timer
 * leaves the starts that wait for it alone.
 */

const aiOff = (config: ProjectConfig) => void (config.team.limits.aiEnabled = false);

/** The owner may also record code reviews, so the reviewer can be retired without orphaning the gate. */
const reviewersBesidesCr = (config: ProjectConfig) => {
  for (const label of config.pipeline.labels)
    if (label.group === 'code-review') label.setBy = { duties: ['code_review'], members: ['owner'] };
};

/** The keys of the starts SQLite holds, oldest first. */
const stored = (h: DomainHarness) => h.repos.deferredStarts.list().map((record) => record.key);

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
    const waiting = await waitFor(() => h.domain.tasks.get('AR', task.key).startWaiting);
    expect(waiting).toMatchObject({ reason: 'ai_disabled', member: 'dev-1' });
    expect(stored(h)).toEqual(['message:AR:dev-1:task:AR-1']);

    h = await restartDomainHarness(h);
    expect(h.domain.tasks.get('AR', task.key).startWaiting).toEqual(waiting);
    expect(h.repos.messages.get(message.id)?.deliveredAt).toBeNull();

    await setEnabled(h, true);
    await waitFor(() => h.repos.messages.get(message.id)?.deliveredAt);
    expect(h.runner.started).toHaveLength(1);
    expect(h.runner.messages.map((m) => m.text)).toEqual([
      '[team message from owner about AR-1]\nInspect this fictional task.',
    ]);
    expect(h.domain.tasks.get('AR', task.key).startWaiting).toBeUndefined();
    expect(stored(h)).toEqual([]);
    await h.domain.admission.retryDeferred();
    expect(h.runner.started).toHaveLength(1);
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
    const handOff = vi.spyOn(h.domain.handOver, 'handOff');
    await h.domain.admission.retryDeferred();
    expect(handOff.mock.calls.map(([change]) => change.task.key)).toEqual(['AR-2', 'AR-1']);
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
    await waitFor(() => stored(h).length === 2);
    expect(stored(h)).toEqual(['hand-over:AR:AR-1', 'message:AR:cr:task:AR-1']);

    if (how === 'done') h.repos.tasks.update(task.id, { status: 'done' });
    else await h.domain.members.retire('AR', 'cr', {}, { actor: OWNER_ACTOR, author: OWNER });
    h.runnerModule.planUsage.value = planUsage(10);
    await h.domain.admission.retryDeferred();
    expect(stored(h)).toEqual([]);
    expect(h.runner.started).toHaveLength(0);
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
    expect(h.runner.started).toHaveLength(0);

    h = await restartDomainHarness(h);
    await settle();
    await h.domain.admission.retryDeferred();
    expect(h.runner.started).toHaveLength(0);
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

describe('the retry timer', () => {
  let h: DomainHarness;
  beforeEach(() => {
    // Only the retry interval is faked: the domain's other work keeps its real clocks.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });
  afterEach(async () => {
    await h?.cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const RETRY_MS = 30_000;
  const logged = (info: { mock: { calls: unknown[][] } }, message: string) =>
    info.mock.calls.filter(([, text]) => text === message).map(([fields]) => fields);

  /** One tick of the timer, and the retry it starts run to its end. */
  async function tick() {
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    await flush(20);
    await settle();
  }

  it('neither retries nor logs a start that waits for the AI switch, while a capacity refusal is retried', async () => {
    h = await createDomainHarness();
    await h.domain.projects.create(
      { key: 'BR', name: 'Fictional second project', workspacePath: h.workspace, templateId: 'test' },
      OWNER,
    );
    // AR: the switch is off, so its hand-over waits for it.
    await setEnabled(h, false, 'AR');
    const off = await h.domain.tasks.create('AR', { title: 'Waits for the switch' }, OWNER_ACTOR);
    await h.domain.tasks.moveToStage('AR', off.key, 'code_review', OWNER_ACTOR);
    // BR: the switch is on, but the reviewer is at capacity.
    const busy = await h.domain.tasks.create('BR', { title: 'Keeps the reviewer busy' }, OWNER_ACTOR);
    h.domain.tasks.assign('BR', busy.key, 'cr', OWNER_ACTOR);
    const full = await h.domain.tasks.create('BR', { title: 'Waits for capacity' }, OWNER_ACTOR);
    await h.domain.tasks.moveToStage('BR', full.key, 'code_review', OWNER_ACTOR);
    await waitFor(
      () => h.domain.tasks.get('AR', off.key).startWaiting && h.domain.tasks.get('BR', full.key).startWaiting,
    );
    expect(h.domain.tasks.get('AR', off.key).startWaiting).toMatchObject({ reason: 'ai_disabled' });
    expect(h.domain.tasks.get('BR', full.key).startWaiting).toMatchObject({ reason: 'member_at_capacity' });

    const handOff = vi.spyOn(h.domain.handOver, 'handOff');
    const info = vi.spyOn(h.log.logger, 'info');
    await tick();
    await tick();
    // Two ticks: the capacity refusal was retried (and logged) each time, the other start not at all.
    expect(handOff.mock.calls.map(([change]) => change.task.key)).toEqual(['BR-2', 'BR-2']);
    expect(logged(info, 'stage hand-over deferred')).toEqual([
      expect.objectContaining({ taskKey: 'BR-2', reason: 'member_at_capacity' }),
      expect.objectContaining({ taskKey: 'BR-2', reason: 'member_at_capacity' }),
    ]);
    expect(h.domain.tasks.get('AR', off.key).startWaiting).toMatchObject({ reason: 'ai_disabled' });
    expect(stored(h)).toEqual(['hand-over:AR:AR-1', 'hand-over:BR:BR-2']);
    expect(h.runner.started).toHaveLength(0);

    // Turning the switch on retries it at once, without a tick.
    await setEnabled(h, true, 'AR');
    await waitFor(() => h.domain.sessions.findRunning('AR', 'cr', { type: 'task', taskKey: off.key }));
    expect(h.domain.tasks.get('AR', off.key).startWaiting).toBeUndefined();
    expect(handOff.mock.calls.filter(([change]) => change.task.key === 'AR-1')).toHaveLength(1);
  });

  it('retries a start once when the switch went off after it was deferred, then leaves it alone', async () => {
    h = await createDomainHarness();
    const busy = await h.domain.tasks.create('AR', { title: 'Keeps the reviewer busy' }, OWNER_ACTOR);
    h.domain.tasks.assign('AR', busy.key, 'cr', OWNER_ACTOR);
    const full = await h.domain.tasks.create('AR', { title: 'Waits for capacity' }, OWNER_ACTOR);
    await h.domain.tasks.moveToStage('AR', full.key, 'code_review', OWNER_ACTOR);
    await waitFor(() => h.domain.tasks.get('AR', full.key).startWaiting);
    expect(h.domain.tasks.get('AR', full.key).startWaiting).toMatchObject({ reason: 'member_at_capacity' });

    await setEnabled(h, false);
    const handOff = vi.spyOn(h.domain.handOver, 'handOff');
    const info = vi.spyOn(h.log.logger, 'info');
    await tick();
    expect(handOff).toHaveBeenCalledTimes(1);
    expect(logged(info, 'stage hand-over deferred')).toHaveLength(1);
    expect(h.domain.tasks.get('AR', full.key).startWaiting).toMatchObject({ reason: 'ai_disabled' });

    await tick();
    await tick();
    expect(handOff).toHaveBeenCalledTimes(1);
    expect(logged(info, 'stage hand-over deferred')).toHaveLength(1);
    expect(h.domain.tasks.get('AR', full.key).startWaiting).toMatchObject({ reason: 'ai_disabled' });
  });

  it('leaves a message wake-up that waits for the switch alone, too', async () => {
    h = await createDomainHarness();
    await setEnabled(h, false);
    const task = await h.domain.tasks.create('AR', { title: 'Fictional question' }, OWNER_ACTOR);
    await h.domain.messaging.send('AR', 'owner', { to: ['cr'], text: 'Please look.', taskKey: task.key });
    await waitFor(() => h.domain.tasks.get('AR', task.key).startWaiting);
    const wake = vi.spyOn(h.domain.messageStarts, 'wake');
    const info = vi.spyOn(h.log.logger, 'info');
    await tick();
    await tick();
    expect(wake).not.toHaveBeenCalled();
    expect(logged(info, 'team message start deferred')).toEqual([]);
    await setEnabled(h, true);
    await waitFor(() => h.runner.started.length === 1);
  });
});
