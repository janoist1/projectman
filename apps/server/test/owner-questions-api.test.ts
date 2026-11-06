import { afterEach, expect, it } from 'vitest';
import { OwnerQuestionsReport, routes } from '@projectman/shared';
import { addHumanAndLogin, createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

let h: AppHarness;
afterEach(async () => {
  await h?.close();
});

it('measures the weeks for the owner own login, a combined question once; never a key or a non-owner', async () => {
  h = await createAppHarness();
  const cookie = await setupOwner(h.app);
  await createProject(h, cookie);
  const { domain, repos } = h.app.projectman;
  const ask = (payload: Record<string, unknown> = {}) =>
    domain.inbox.create({
      projectKey: 'AR',
      kind: 'question',
      source: 'dev-1',
      assignees: ['owner'],
      title: 'Which approach?',
      payload: { question: 'Which approach?', ...payload },
      options: [{ id: 'answer', label: 'answer', style: 'primary' }],
    });
  const grouped = [ask(), ask()];
  repos.inbox.createGroup({
    projectKey: 'AR',
    primaryItemId: grouped[0]!.id,
    itemIds: grouped.map((item) => item.id),
    question: 'Which shared approach?',
    note: 'Same decision',
    by: 'pm',
    at: grouped[0]!.createdAt,
  });
  const at = new Date().toISOString();
  ask({
    recipient: 'integrator',
    integratorOpenedAt: at,
    screening: {
      until: at,
      at,
      outcome: 'todo',
      todo: { what: 'Run it', where: 'Engine', expected: 'Output', recipient: 'integrator' },
    },
  });

  const url = `${routes.operatorOwnerQuestions('AR')}?weeks=2`;
  const response = await inject(h.app, 'GET', url, cookie);
  expect(response.statusCode, response.body).toBe(200);
  const report = OwnerQuestionsReport.parse(response.json());
  expect(report.weeks).toHaveLength(2);
  expect(report.weeks[0]).toMatchObject({ total: 1, integratorTodos: 1, open: 1, byTopic: { unknown: 1 } });
  expect((await inject(h.app, 'GET', `${url}7`, cookie)).statusCode).toBe(400);

  const admin = await addHumanAndLogin(h.app, { handle: 'ada', access: 'admin' });
  expect((await inject(h.app, 'GET', url, admin)).statusCode).toBe(403);
  const key = await inject(h.app, 'POST', routes.integratorKeys(), cookie, { mode: 'super' });
  const via = await h.app.inject({
    method: 'GET',
    url,
    headers: { authorization: `Bearer ${key.json().secret}` },
  });
  expect(via.statusCode).toBe(403);
});
