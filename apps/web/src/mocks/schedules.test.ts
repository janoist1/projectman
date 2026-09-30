import { describe, expect, it } from 'vitest';
import { ScheduleRun, SchedulesView } from '@projectman/shared';
import { MockBackend } from './backend';

function scheduledBackend() {
  const backend = new MockBackend();
  backend.sessions = [];
  backend.tasks = [];
  backend.planUsage.fiveHourPercent = 0;
  backend.planUsage.weeklyPercent = 0;
  const member = backend.config.team.members.find((m) => m.kind === 'ai')!;
  if (member.kind !== 'ai') throw new Error('Expected fictional AI member');
  member.schedule = { cron: '0 9 * * *', prompt: 'Inspect fictional maintenance opportunities.' };
  return { backend, handle: member.handle };
}
const base = '/api/projects/AC';
describe('mock schedules', () => {
  it('lists schedules, starts fresh workspace sessions, records refusals and completes runs', () => {
    const { backend, handle } = scheduledBackend();
    const view = SchedulesView.parse(backend.handle('GET', `${base}/schedules`, undefined).body);
    expect(view.members[0]).toMatchObject({ member: handle, cron: '0 9 * * *', nextRun: expect.any(String) });
    const started = backend.handle('POST', `${base}/members/${handle}/schedule/run`, undefined);
    expect(started.status).toBe(201);
    const run = ScheduleRun.parse(started.body);
    expect(backend.sessions[0]).toMatchObject({
      cwd: backend.config.project.workspacePath,
      branch: null,
      workItem: { type: 'schedule', runId: run.id },
    });
    expect(backend.handle('POST', `${base}/members/${handle}/schedule/run`, undefined)).toMatchObject({
      status: 409,
      body: { error: { code: 'previous_run_live' } },
    });
    backend.handle('POST', `${base}/sessions/${run.sessionId}/stop`, undefined);
    expect(backend.scheduleRuns[0]?.status).toBe('done');
    const second = ScheduleRun.parse(
      backend.handle('POST', `${base}/members/${handle}/schedule/run`, undefined).body,
    );
    expect(second.sessionId).not.toBe(run.sessionId);
    backend.updateSession(second.sessionId!, { state: 'failed' });
    expect(backend.scheduleRuns.at(-1)?.status).toBe('failed');
  });
  it.each([
    'member_at_capacity',
    'ai_limit_reached',
    'plan_usage_paused',
    'ai_disabled',
    'provider_not_logged_in',
  ])('records %s', (reason) => {
    const { backend, handle } = scheduledBackend();
    const member = backend.config.team.members.find((m) => m.handle === handle)!;
    if (member.kind !== 'ai') throw new Error('Expected AI member');
    if (reason === 'member_at_capacity') member.capacity = 0;
    if (reason === 'ai_limit_reached') backend.config.team.limits.maxConcurrentAi = 0;
    if (reason === 'plan_usage_paused') backend.planUsage.weeklyPercent = 99;
    if (reason === 'ai_disabled') backend.config.team.limits.aiEnabled = false;
    if (reason === 'provider_not_logged_in') backend.providerLoggedIn[member.provider ?? 'claude'] = false;
    expect(backend.handle('POST', `${base}/members/${handle}/schedule/run`, undefined)).toMatchObject({
      status: 409,
      body: { error: { code: reason } },
    });
    expect(backend.scheduleRuns.at(-1)).toMatchObject({ status: 'skipped', reason });
  });
  it('uses the scheduled member provider for plan usage', () => {
    const { backend, handle } = scheduledBackend();
    const member = backend.config.team.members.find((m) => m.handle === handle)!;
    if (member.kind !== 'ai') throw new Error('Expected AI member');
    member.provider = 'codex';
    backend.planUsage.weeklyPercent = 99;
    backend.providerPlanUsage.codex = { ...backend.planUsage, weeklyPercent: 80 };
    const first = backend.handle('POST', `${base}/members/${handle}/schedule/run`, undefined);
    expect(first.status).toBe(201);
    backend.handle('POST', `${base}/sessions/${ScheduleRun.parse(first.body).sessionId}/stop`, undefined);
    backend.providerPlanUsage.codex.weeklyPercent = 81;
    expect(backend.handle('POST', `${base}/members/${handle}/schedule/run`, undefined)).toMatchObject({
      status: 409,
      body: { error: { code: 'plan_usage_paused' } },
    });
  });
  it('requires owner or admin access', () => {
    const { backend, handle } = scheduledBackend();
    backend.viewerHandle = backend.members.find((m) => m.kind === 'human' && m.role === 'client')!.handle;
    expect(backend.handle('POST', `${base}/members/${handle}/schedule/run`, undefined).status).toBe(403);
    expect(backend.handle('GET', `${base}/schedules`, undefined).status).toBe(200);
  });
});
