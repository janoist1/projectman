import { routes, ScheduleRun } from '@projectman/shared';
import { afterEach, expect, it, vi } from 'vitest';
import { waitFor } from '../src/runner/test-helpers';
import { createAppHarness, OWNER_LOGIN, setupOwner } from './helpers/app-harness';
import type { CliAppHarness } from './helpers/app-harness';

let h: CliAppHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

it(
  'runs a clock-matched schedule in a fake CLI and supports run-now and exit completion',
  { timeout: 30_000 },
  async () => {
    let at = new Date('2026-09-30T08:29:30Z');
    h = await createAppHarness({
      runner: 'fake-cli',
      now: () => at,
      scheduleTimer: { set: () => null, clear: () => {} },
      // The real context pack types the schedule's prompt as the first message.
      real: { context: true },
    });
    const { app, worktrees, workspace } = h;
    const cookie = await setupOwner(app);
    const headers = { cookie };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: routes.projects(),
          headers,
          payload: { key: 'AR', name: 'Fictional workshop', workspacePath: workspace, templateId: 'test' },
        })
      ).statusCode,
    ).toBe(201);
    const prompt = 'Inspect the fictional workspace and report maintenance opportunities.';
    await app.projectman.domain.projects.update(
      'AR',
      { actor: { kind: 'human', handle: 'owner' }, author: OWNER_LOGIN },
      (config) => {
        config.project.timezone = 'Europe/Budapest';
        return 'Set fictional project timezone';
      },
    );
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: routes.member('AR', 'dev-1'),
          headers,
          payload: { schedule: { cron: '30 10 * * *', prompt } },
        })
      ).statusCode,
    ).toBe(200);
    const { domain } = app.projectman;
    await domain.schedules.check();
    expect(worktrees.calls).toHaveLength(0);
    expect(domain.sessions.list('AR')).toHaveLength(0);
    at = new Date('2026-09-30T08:30:00Z');
    await domain.schedules.check();
    const run = (await domain.schedules.view('AR')).runs[0]!;
    const sessionId = run.sessionId!;
    await waitFor(() => domain.sessions.get('AR', sessionId).transcriptPath, {
      what: 'fake scheduled transcript',
    });
    await vi.waitFor(
      async () => {
        const detail = await domain.sessions.detail('AR', sessionId);
        expect(detail.chat.some((item) => item.kind === 'user_text' && item.text === prompt)).toBe(true);
      },
      { timeout: 10_000 },
    );
    expect(domain.sessions.get('AR', sessionId)).toMatchObject({
      cwd: workspace,
      branch: null,
      workItem: { type: 'schedule', runId: run.id },
    });
    expect(worktrees.calls).toHaveLength(0);
    await domain.schedules.check();
    expect((await domain.schedules.view('AR')).runs).toHaveLength(1);
    expect(
      (await app.inject({ method: 'POST', url: routes.runSchedule('AR', 'dev-1'), headers })).statusCode,
    ).toBe(409);
    expect(
      (await app.inject({ method: 'POST', url: routes.stopSession('AR', sessionId), headers })).statusCode,
    ).toBe(200);
    expect(domain.ctx.repos.schedules.get(run.id)?.status).toBe('done');
    const nowRun = await app.inject({ method: 'POST', url: routes.runSchedule('AR', 'dev-1'), headers });
    expect(nowRun.statusCode).toBe(201);
    expect(ScheduleRun.parse(nowRun.json()).sessionId).not.toBe(sessionId);
  },
);
