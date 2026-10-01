import { afterEach, describe, expect, it } from 'vitest';
import type { AgentProvider, ProjectConfig } from '@projectman/shared';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush, planUsage } from './helpers/fakes';
import { ScheduleService } from '../src/domain/schedules';
import type { ScheduleTimer } from '../src/domain/schedules';

const prompt = 'Inspect the fictional project and report maintenance opportunities.';
function scheduled(config: ProjectConfig) {
  config.project.timezone = 'Europe/Budapest';
  const member = config.team.members.find((m) => m.handle === 'dev-1')!;
  if (member.kind === 'ai') member.schedule = { cron: '30 10 * * *', prompt };
}
class FakeTimer implements ScheduleTimer {
  callback: (() => void) | undefined;
  delay = 0;
  set(callback: () => void, delay: number) {
    this.callback = callback;
    this.delay = delay;
    return callback;
  }
  clear() {
    this.callback = undefined;
  }
  fire() {
    this.callback?.();
  }
}

describe('member schedules', () => {
  let h: DomainHarness;
  let at: Date;
  const now = () => at;
  afterEach(() => h?.cleanup());
  async function setup(adjust = scheduled) {
    at = new Date('2026-09-30T08:29:30Z');
    const timer = new FakeTimer();
    h = await createDomainHarness({ adjust, now, scheduleTimer: timer });
    return timer;
  }
  it('fires at the local minute, includes context and prompt, uses the workspace, and completes on exit', async () => {
    const timer = await setup();
    expect(timer.delay).toBe(30_000);
    await h.domain.schedules.check();
    expect(h.runner.started).toHaveLength(0);
    at = new Date('2026-09-30T08:30:00Z');
    timer.fire();
    await flush();
    const spec = h.runner.lastStarted();
    expect(spec).toMatchObject({ cwd: h.workspace, resume: false, initialMessage: prompt });
    expect(spec.appendSystemPrompt).toContain('dev-1');
    expect(h.contextBuilder.inputs.at(-1)).toMatchObject({ task: null, workItem: { type: 'schedule' } });
    expect(h.worktrees.calls).toHaveLength(0);
    const run = h.repos.schedules.list('AR')[0]!;
    expect(run).toMatchObject({
      status: 'started',
      sessionId: spec.sessionId,
      scheduledFor: '2026-09-30T08:30:00.000Z',
    });
    await Promise.all([h.domain.schedules.check(), h.domain.schedules.check()]);
    expect(h.repos.schedules.list('AR')).toHaveLength(1);
    h.runner.emit({ type: 'exit', sessionId: spec.sessionId, exitCode: 0, signal: null });
    expect(h.repos.schedules.get(run.id)?.status).toBe('done');
    expect(h.domain.timeline.list('AR').some((e) => e.type === 'schedule_started')).toBe(true);
  });
  it('does not backfill missed minutes and starts a fresh session at the next occurrence', async () => {
    const timer = await setup();
    at = new Date('2026-09-30T08:31:00Z');
    timer.fire();
    await flush();
    expect(h.runner.started).toHaveLength(0);
    at = new Date('2026-10-01T08:30:00Z');
    await h.domain.schedules.check();
    const first = h.runner.lastStarted();
    h.runner.emit({ type: 'exit', sessionId: first.sessionId, exitCode: 0, signal: null });
    at = new Date('2026-10-02T08:30:00Z');
    await h.domain.schedules.check();
    expect(h.runner.lastStarted().sessionId).not.toBe(first.sessionId);
    expect(h.runner.lastStarted().resume).toBe(false);
  });
  it('treats both Budapest fold minutes as distinct occurrences', async () => {
    await setup((config) => {
      scheduled(config);
      const member = config.team.members[1]!;
      if (member.kind === 'ai') member.schedule!.cron = '30 2 * * *';
    });
    at = new Date('2026-10-25T00:30:00Z');
    await h.domain.schedules.check();
    const first = h.runner.lastStarted();
    h.runner.emit({ type: 'exit', sessionId: first.sessionId, exitCode: 0, signal: null });
    at = new Date('2026-10-25T01:30:00Z');
    await h.domain.schedules.check();
    expect(h.runner.started).toHaveLength(2);
    expect(h.repos.schedules.list('AR').map((run) => run.scheduledFor)).toEqual([
      '2026-10-25T01:30:00.000Z',
      '2026-10-25T00:30:00.000Z',
    ]);
  });
  it('reconciles interrupted runs after restart without replaying a persisted minute', async () => {
    await setup();
    at = new Date('2026-09-30T08:30:00Z');
    await h.domain.schedules.check();
    const run = h.repos.schedules.list('AR')[0]!;
    await h.domain.schedules.stop();
    h.runner.emit({ type: 'exit', sessionId: run.sessionId!, exitCode: 0, signal: null });
    const service = new ScheduleService({
      ctx: h.domain.ctx,
      projects: h.domain.projects,
      admission: h.domain.admission,
      timeline: h.domain.timeline,
      timer: new FakeTimer(),
    });
    service.start();
    try {
      await service.check();
      expect(h.repos.schedules.get(run.id)).toMatchObject({ status: 'failed', reason: 'server_restarted' });
      expect(h.repos.schedules.list('AR')).toHaveLength(1);
      expect(h.runner.started).toHaveLength(1);
    } finally {
      await service.stop();
    }
  });
  it('refuses a manual run while the service is stopping, as a temporary condition', async () => {
    await setup();
    await h.domain.schedules.stop();
    await expect(h.domain.schedules.runNow('AR', 'dev-1')).rejects.toMatchObject({
      code: 'server_stopping',
      status: 503,
    });
    expect(h.runner.started).toHaveLength(0);
  });
  it('records the previous-live-run reason without starting twice', async () => {
    await setup();
    const [first, second] = await Promise.all([
      h.domain.schedules.runNow('AR', 'dev-1'),
      h.domain.schedules.runNow('AR', 'dev-1'),
    ]);
    expect(first.status).toBe('started');
    expect(second).toMatchObject({ status: 'skipped', reason: 'previous_run_live', sessionId: null });
    expect(h.runner.started).toHaveLength(1);
    expect(h.domain.timeline.list('AR').find((e) => e.type === 'schedule_skipped')?.data.reason).toBe(
      'previous_run_live',
    );
  });
  it('skips at member capacity, including running task sessions and live general sessions', async () => {
    await setup();
    const task = await h.domain.tasks.create('AR', { title: 'Fictional maintenance' }, OWNER_ACTOR);
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', {
      type: 'task',
      taskKey: task.key,
    });
    expect(await h.domain.schedules.runNow('AR', 'dev-1')).toMatchObject({
      status: 'skipped',
      reason: 'member_at_capacity',
    });
    await h.domain.sessions.stop('AR', session.id);
    await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'general' });
    expect(await h.domain.schedules.runNow('AR', 'dev-1')).toMatchObject({ reason: 'member_at_capacity' });
  });
  it('skips at the concurrent AI limit', async () => {
    await setup((config) => {
      scheduled(config);
      config.team.limits.maxConcurrentAi = 1;
    });
    await h.domain.sessions.ensureSession('AR', 'dev-2', { type: 'general' });
    expect(await h.domain.schedules.runNow('AR', 'dev-1')).toMatchObject({
      status: 'skipped',
      reason: 'ai_limit_reached',
    });
  });
  it('checks usage on the scheduled member provider and allows the exact threshold', async () => {
    await setup((config) => {
      scheduled(config);
      const member = config.team.members[1]!;
      if (member.kind === 'ai') member.provider = 'codex';
    });
    h.domain.runnerModule.planUsageFor = () => ({ get: async () => planUsage(81) });
    h.runnerModule.planUsage.value = planUsage(0);
    expect(await h.domain.schedules.runNow('AR', 'dev-1')).toMatchObject({ reason: 'plan_usage_paused' });
    h.domain.runnerModule.planUsageFor = () => ({ get: async () => planUsage(80) });
    expect(await h.domain.schedules.runNow('AR', 'dev-1')).toMatchObject({ status: 'started' });
  });
  it('records a provider login refusal and spawn failures', async () => {
    await setup();
    Object.assign(h.runner, {
      providerStatus: async (provider: AgentProvider) => ({
        provider,
        loggedIn: false,
        method: 'none',
        checkedAt: at.toISOString(),
      }),
    });
    expect(await h.domain.schedules.runNow('AR', 'dev-1')).toMatchObject({
      status: 'skipped',
      reason: 'provider_not_logged_in',
    });
    expect(h.runner.started).toHaveLength(0);
    Object.assign(h.runner, { providerStatus: undefined });
    h.runner.failNextStart = new Error('Fictional spawn failure');
    expect(await h.domain.schedules.runNow('AR', 'dev-1')).toMatchObject({
      status: 'failed',
      reason: 'session_start_failed',
      sessionId: expect.any(String),
    });
    expect(await h.domain.schedules.runNow('AR', 'dev-1')).toMatchObject({ status: 'started' });
  });
  it('marks an unsuccessful exit failed and lists the next local occurrence and last 20 runs', async () => {
    await setup();
    const run = await h.domain.schedules.runNow('AR', 'dev-1');
    h.runner.emit({ type: 'exit', sessionId: run.sessionId!, exitCode: 1, signal: null });
    expect(h.repos.schedules.get(run.id)?.status).toBe('failed');
    await h.domain.schedules.runNow('AR', 'dev-1');
    for (let i = 0; i < 22; i++) await h.domain.schedules.runNow('AR', 'dev-1');
    const view = await h.domain.schedules.view('AR');
    expect(view).toMatchObject({
      timezone: 'Europe/Budapest',
      members: [{ member: 'dev-1', nextRun: '2026-09-30T08:30:00.000Z' }],
    });
    expect(view.runs).toHaveLength(20);
  });
});
