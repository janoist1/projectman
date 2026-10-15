import { afterEach, expect, it } from 'vitest';
import { OperatorKnowledgeDocument, routes } from '@projectman/shared';
import { addHumanAndLogin, createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

let h: AppHarness;
afterEach(async () => {
  await h?.close();
});

it('exposes shared knowledge only to owner/admin own logins and has no REST write route', async () => {
  h = await createAppHarness();
  const owner = await setupOwner(h.app);
  await createProject(h, owner);
  const cookies = new Map([['owner', owner]]);
  for (const [handle, access] of [
    ['ada', 'admin'],
    ['dana', 'developer'],
    ['cleo', 'client'],
    ['vera', 'viewer'],
  ] as const)
    cookies.set(handle, await addHumanAndLogin(h.app, { handle, access }));
  for (const [handle, cookie] of cookies) {
    const response = await inject(h.app, 'GET', routes.operatorKnowledge('AR'), cookie, undefined);
    expect(response.statusCode).toBe(['owner', 'ada'].includes(handle) ? 200 : 403);
    if (response.statusCode === 200)
      expect(OperatorKnowledgeDocument.parse(response.json()).revision).toBe(0);
    else expect(response.json().error.code).toBe('operator_owner_only');
  }
  const key = await inject(h.app, 'POST', routes.integratorKey(), owner, undefined);
  const response = await h.app.inject({
    method: 'GET',
    url: routes.operatorKnowledge('AR'),
    headers: { authorization: `Bearer ${key.json().secret}` },
  });
  expect(response.statusCode).toBe(403);
  expect(response.json().error.code).toBe('operator_owner_only');
  expect((await inject(h.app, 'PUT', routes.operatorKnowledge('AR'), owner, {})).statusCode).toBe(404);
});
