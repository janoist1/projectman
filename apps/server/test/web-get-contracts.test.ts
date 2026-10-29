import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BoardView,
  ConfigView,
  InboxView,
  Me,
  MemberProfile,
  MemberView,
  ProjectManagerCorner,
  ProjectSummary,
  RolesView,
  SchedulesView,
  Task,
  TaskDetail,
  TeamMessagesView,
  TeamThreadsView,
  routes,
} from '@projectman/shared';
import { createAppHarness, createProject, inject, setupOwner, type AppHarness } from './helpers/app-harness';
import { OWNER_ACTOR } from './helpers/domain-harness';
import { flush } from './helpers/fakes';
import { instrumentSql } from './helpers/sql-meter';

describe('web GET contracts and SQL budgets', () => {
  let h: AppHarness;
  let cookie: string;
  beforeAll(async () => {
    h = await createAppHarness();
    cookie = await setupOwner(h.app);
    await createProject(h, cookie);
    const { domain } = h.app.projectman;
    for (let n = 0; n < 20; n++) {
      await domain.tasks.create('AR', { title: `Visible card ${n}` }, OWNER_ACTOR);
      domain.inbox.create({
        projectKey: 'AR',
        kind: 'question',
        source: 'dev-1',
        assignees: ['owner'],
        title: `Question ${n}`,
        payload: { question: 'Choose a direction' },
        options: [{ id: 'yes', label: 'Yes', style: 'primary' }],
      });
    }
    await flush();
  });
  afterAll(async () => {
    await h?.close();
  });

  // The same shared response schemas the web client passes to apiRequest.
  it.each([
    [routes.me(), Me, 15],
    [routes.projects(), ProjectSummary.array(), 10],
    [routes.board('AR'), BoardView, 250],
    [routes.tasks('AR'), Task.array(), 230],
    [routes.task('AR', 'AR-1'), TaskDetail, 45],
    [routes.inbox('AR'), InboxView, 85],
    [routes.projectManager('AR'), ProjectManagerCorner, 20],
    [routes.members('AR'), MemberView.array(), 20],
    [routes.memberProfile('AR', 'dev-1'), MemberProfile, 250],
    [routes.roles('AR'), RolesView, 10],
    [routes.config('AR'), ConfigView, 15],
    [routes.schedules('AR'), SchedulesView, 12],
    [routes.teamMessages('AR'), TeamMessagesView, 12],
    [routes.teamThreads('AR'), TeamThreadsView, 10],
  ] as const)('%s matches its web contract within its SQL budget', async (url, schema, budget) => {
    const meter = instrumentSql(undefined, true);
    try {
      meter.start();
      const response = await inject(h.app, 'GET', url, cookie);
      const count = meter.stop();
      expect(response.statusCode, response.body).toBe(200);
      expect(schema.safeParse(response.json())).toMatchObject({ success: true });
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThanOrEqual(budget);
    } finally {
      meter.restore();
    }
  });

  it('keeps list_tasks within its SQL budget with multiple cards', async () => {
    const { domain } = h.app.projectman;
    const { session } = await domain.sessions.ensureSession('AR', 'dev-1', { type: 'task', taskKey: 'AR-1' });
    await flush();
    const meter = instrumentSql(undefined, true);
    try {
      meter.start();
      const tasks = await domain.teamTools.listTasks(
        { projectKey: 'AR', member: 'dev-1', sessionId: session.id, taskKey: 'AR-1' },
        {},
      );
      const count = meter.stop();
      expect(tasks).toHaveLength(20);
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThanOrEqual(235);
    } finally {
      meter.restore();
    }
  });
});
