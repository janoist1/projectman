import { afterEach, expect, it } from 'vitest';
import { routes, ScheduleRun, SchedulesView } from '@projectman/shared';
import { createAppHarness, createProject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

let h: AppHarness;
afterEach(async () => h?.close());
it('lists schedules and supports owner run-now with a recorded 409 refusal', async () => {
  h = await createAppHarness({ now: () => new Date('2026-09-30T08:29:30Z') });
  const cookie = await setupOwner(h.app);
  await createProject(h, cookie);
  const headers = { cookie };
  const patch = await h.app.inject({
    method: 'PATCH',
    url: routes.member('AR', 'dev-1'),
    headers,
    payload: { schedule: { cron: '30 10 * * *', prompt: 'Report fictional maintenance opportunities.' } },
  });
  expect(patch.statusCode).toBe(200);
  const listed = await h.app.inject({ url: routes.schedules('AR'), headers });
  expect(SchedulesView.parse(listed.json()).members[0]).toMatchObject({
    member: 'dev-1',
    cron: '30 10 * * *',
  });
  const run = await h.app.inject({ method: 'POST', url: routes.runSchedule('AR', 'dev-1'), headers });
  expect(run.statusCode).toBe(201);
  expect(ScheduleRun.parse(run.json()).status).toBe('started');
  const refused = await h.app.inject({ method: 'POST', url: routes.runSchedule('AR', 'dev-1'), headers });
  expect(refused.statusCode).toBe(409);
  expect(refused.json()).toMatchObject({
    error: { code: 'previous_run_live', details: { reason: 'previous_run_live' } },
  });
  expect((await h.app.inject({ url: routes.schedules('AR'), headers })).json().runs).toHaveLength(2);
  const denied = await h.app.inject({ method: 'POST', url: routes.runSchedule('AR', 'dev-1') });
  expect(denied.statusCode).toBe(401);
});
it('enforces admin access before running', async () => {
  h = await createAppHarness();
  const cookie = await setupOwner(h.app);
  await createProject(h, cookie);
  await h.app.projectman.domain.projects.update(
    'AR',
    {
      actor: { kind: 'human', handle: 'owner' },
      author: { name: 'Owner', email: 'owner@example.com' },
    },
    (config) => {
      config.team.members.push({
        kind: 'human',
        handle: 'viewer',
        displayName: 'Fictional Viewer',
        email: 'viewer@example.com',
        access: 'viewer',
        roles: [],
      });
      return 'Add fictional viewer';
    },
  );
  const viewer = h.app.projectman.repos.users.findByEmail('owner@example.com')!;
  // Point the test account's existing cookie at the fictional viewer membership.
  h.app.projectman.repos.db
    .prepare('UPDATE users SET email = ? WHERE id = ?')
    .run('viewer@example.com', viewer.id);
  const refused = await h.app.inject({
    method: 'POST',
    url: routes.runSchedule('AR', 'dev-1'),
    headers: { cookie },
  });
  expect(refused.statusCode).toBe(403);
  expect(h.runner.started).toHaveLength(0);
});
