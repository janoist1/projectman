import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlanUsage, Session } from '@projectman/shared';
import { createDomainHarness, OWNER, OWNER_ACTOR, restartDomainHarness } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { StartSpec } from '../src/domain/admission';
import { waitFor } from '../src/runner/test-helpers';

describe('NanoGPT provider quota recovery', () => {
  let h: DomainHarness;
  let now = new Date('2026-10-06T12:00:00Z');
  const reset = '2026-10-11T12:00:00.000Z';
  afterEach(() => h?.cleanup());
  const usage = (percent: number): PlanUsage => ({
    fiveHourPercent: null,
    fiveHourResetsAt: null,
    weeklyPercent: percent,
    weeklyResetsAt: reset,
    fetchedAt: now.toISOString(),
  });
  async function setup(percent: number | null, persistent = false) {
    now = new Date('2026-10-06T12:00:00Z');
    h = await createDomainHarness({
      now: () => now,
      persistent,
      adjust: (config) => {
        for (const member of config.team.members)
          if (member.kind === 'ai' && ['dev-1', 'dev-2'].includes(member.handle)) member.provider = 'nanogpt';
      },
    });
    h.runnerModule.planUsage.value = percent === null ? null : usage(percent);
    const task = await h.domain.tasks.create('AR', { title: 'Fictional quota recovery' }, OWNER_ACTOR);
    const { session } = await h.domain.taskStarts.start('AR', task.key, {
      assignee: 'dev-1',
      actor: OWNER_ACTOR,
      author: OWNER,
    });
    return { task, session: session! };
  }
  async function fail(session: Session) {
    h.runner.emit({
      type: 'rate_limited',
      sessionId: session.id,
      provider: 'nanogpt',
      message: '429 Too Many Requests',
      at: now.toISOString(),
    });
    h.runner.setState(session.id, 'failed', '429 Too Many Requests');
    await h.runner.stop(session.id);
  }
  const waiting = (key: string) => h.domain.tasks.get('AR', key).startWaiting;
  const alerts = () =>
    h.repos.inbox
      .list('AR', { kind: 'alert' })
      .filter((item) => item.payload.alert === 'provider_rate_limited');

  it('parks the affected task until the weekly reset and then resumes without another message', async () => {
    const { task, session } = await setup(100);
    await fail(session);
    expect(await waitFor(() => waiting(task.key))).toMatchObject({
      reason: 'provider_rate_limited',
      provider: 'nanogpt',
      until: reset,
    });
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]).toMatchObject({
      source: 'dev-1',
      assignees: ['owner'],
      payload: { until: reset, weeklyPercent: 100 },
    });
    const started = h.runner.started.length;
    for (const at of ['2026-10-06T16:00:00Z', '2026-10-10T12:00:00Z', '2026-10-11T11:59:59Z']) {
      now = new Date(at);
      await h.domain.admission.retryDeferred();
      expect(h.runner.started).toHaveLength(started);
    }
    await h.domain.messaging.send('AR', 'owner', {
      to: ['dev-2'],
      taskKey: task.key,
      text: 'Wait for the reset',
    });
    await waitFor(() => h.repos.deferredStarts.list().length >= 2);
    expect(h.runner.started).toHaveLength(started);
    now = new Date(reset);
    await h.domain.admission.retryDeferred();
    const resumed = h.runner.started.find((s, index) => index >= started && s.sessionId === session.id);
    expect(resumed?.initialMessage).toContain('Your previous turn stopped because NanoGPT');
    expect(h.domain.sessions.findRunning('AR', 'dev-1', { type: 'task', taskKey: task.key })).not.toBeNull();
  });

  it('uses a single fifteen-minute hold when initial usage is known and low', async () => {
    const { task, session } = await setup(40);
    await fail(session);
    expect(await waitFor(() => waiting(task.key))).toMatchObject({ until: '2026-10-06T12:15:00.000Z' });
    const started = h.runner.started.length;
    now = new Date('2026-10-06T12:14:59Z');
    await h.domain.admission.retryDeferred();
    expect(h.runner.started).toHaveLength(started);
    now = new Date('2026-10-06T12:15:00Z');
    await h.domain.admission.retryDeferred();
    expect(h.runner.started.length).toBeGreaterThan(started);
  });

  it('probes only usage while unknown and releases immediately once usage is known and low', async () => {
    const { task, session } = await setup(null);
    await fail(session);
    expect(await waitFor(() => waiting(task.key))).toMatchObject({ reason: 'provider_rate_limited' });
    expect(waiting(task.key)?.until).toBeUndefined();
    expect(alerts()[0]).toMatchObject({ payload: { until: null, weeklyPercent: null } });
    const started = h.runner.started.length;
    const calls = h.runnerModule.planUsage.calls;
    now = new Date('2026-10-07T12:00:00Z');
    await h.domain.admission.retryDeferred();
    expect(h.runnerModule.planUsage.calls).toBeGreaterThan(calls);
    expect(h.runner.started).toHaveLength(started);
    h.runnerModule.planUsage.value = usage(40);
    h.domain.planUsage.invalidate();
    await h.domain.admission.retryDeferred();
    expect(h.runner.started.length).toBeGreaterThan(started);
    expect(alerts()).toHaveLength(1);
  });

  it('shares one hold and owner alert across simultaneous failures without extending the reset', async () => {
    const { task, session } = await setup(100);
    const other = await h.domain.sessions.ensureSession('AR', 'dev-2', { type: 'general' });
    await Promise.all([fail(session), fail(other.session)]);
    await waitFor(() => waiting(task.key));
    expect(alerts()).toHaveLength(1);
    expect(waiting(task.key)?.until).toBe(reset);
    h.runner.setState(other.session.id, 'working');
    h.runner.setState(other.session.id, 'idle');
    expect(() => h.domain.sessions.typeInto(other.session, 'Blocked input')).toThrow(
      expect.objectContaining({ code: 'provider_rate_limited' }),
    );
  });

  it('persists the task continuation before the usage request finishes', async () => {
    const { task, session } = await setup(100);
    let complete!: (value: PlanUsage | null) => void;
    const pending = new Promise<PlanUsage | null>((resolve) => {
      complete = resolve;
    });
    vi.spyOn(h.domain.planUsage, 'get').mockReturnValue(pending);
    await fail(session);
    expect(await waitFor(() => waiting(task.key))).toMatchObject({ reason: 'provider_rate_limited' });
    expect(
      h.repos.deferredStarts.list().some((row) => StartSpec.parse(row.spec).kind === 'provider_resume'),
    ).toBe(true);
    complete(usage(100));
    await waitFor(() => waiting(task.key)?.until === reset);
  });

  it('releases an unknown hold when the background usage cache refresh observes a low usage', async () => {
    const { task, session } = await setup(null);
    await fail(session);
    await waitFor(() => waiting(task.key));
    h.runnerModule.planUsage.value = usage(40);
    h.domain.planUsage.invalidate();
    await h.domain.planUsage.get('nanogpt');
    expect(() => h.domain.sessions.assertProviderCooldown('nanogpt')).not.toThrow();
    await h.domain.admission.retryDeferred();
    expect(h.domain.sessions.findRunning('AR', 'dev-1', { type: 'task', taskKey: task.key })).not.toBeNull();
  });

  it.each([40, 100])(
    'restores two continuations without inference before observing usage %i',
    async (percent) => {
      const { task, session } = await setup(100, true);
      const otherTask = await h.domain.tasks.create('AR', { title: 'Another quota recovery' }, OWNER_ACTOR);
      const other = await h.domain.taskStarts.start('AR', otherTask.key, {
        assignee: 'dev-2',
        actor: OWNER_ACTOR,
        author: OWNER,
      });
      await Promise.all([fail(session), fail(other.session!)]);
      await waitFor(() => waiting(task.key));
      await waitFor(() => waiting(otherTask.key));
      expect(
        h.repos.deferredStarts.list().filter((row) => StartSpec.parse(row.spec).kind === 'provider_resume'),
      ).toHaveLength(2);
      h = await restartDomainHarness(h, { now: () => now });
      // The restarted fake source is unknown: persisted continuations must not launch inference.
      await h.domain.admission.retryDeferred();
      expect(h.runner.started).toHaveLength(0);
      expect(alerts()).toHaveLength(1);
      h.runnerModule.planUsage.value = usage(percent);
      h.domain.planUsage.invalidate();
      await h.domain.admission.retryDeferred();
      if (percent >= 99) {
        expect(h.runner.started).toHaveLength(0);
        now = new Date('2026-10-11T11:59:59Z');
        await h.domain.admission.retryDeferred();
        expect(h.runner.started).toHaveLength(0);
        now = new Date(reset);
        await h.domain.admission.retryDeferred();
      }
      await waitFor(() => h.runner.started.length === 2);
      for (const taskKey of [task.key, otherTask.key]) {
        const resumed = h.runner.started.find((spec) => {
          const restoredSession = h.domain.sessions.get('AR', spec.sessionId);
          return restoredSession.workItem.type === 'task' && restoredSession.workItem.taskKey === taskKey;
        });
        expect(resumed?.initialMessage).toContain('Your previous turn stopped because NanoGPT');
      }
      expect(alerts()).toHaveLength(1);
    },
  );

  it('drops a continuation when its task is reassigned', async () => {
    const { task, session } = await setup(100);
    await fail(session);
    await waitFor(() => waiting(task.key));
    h.repos.tasks.update(task.id, { assignee: 'dev-2' });
    const started = h.runner.started.length;
    now = new Date(reset);
    await h.domain.admission.retryDeferred();
    expect(h.runner.started).toHaveLength(started);
    expect(
      h.repos.deferredStarts.list().some((row) => StartSpec.parse(row.spec).kind === 'provider_resume'),
    ).toBe(false);
  });
});
