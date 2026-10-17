import { waitForSession } from './helpers/domain-harness';
import { afterEach, expect, it } from 'vitest';
import { OperatorKnowledgeDocument, routes } from '@projectman/shared';
import type { HumanAccess, OperatorKnowledgeChange } from '@projectman/shared';
import { addHumanAndLogin, createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { canSeeProjectEvent } from '../src/core/projects';

let h: AppHarness;
afterEach(async () => {
  await h?.close();
});

it.each(['agreement', 'principle'] as const)(
  'keeps pending and resolved %s proposals private in inbox lists and live events',
  async (kind) => {
    h = await createAppHarness();
    const owner = await setupOwner(h.app);
    await createProject(h, owner);
    const readers: { handle: string; access: HumanAccess; cookie: string }[] = [
      { handle: 'owner', access: 'owner', cookie: owner },
    ];
    for (const [handle, access] of [
      ['ada', 'admin'],
      ['dana', 'developer'],
      ['cleo', 'client'],
      ['vera', 'viewer'],
    ] as const)
      readers.push({ handle, access, cookie: await addHumanAndLogin(h.app, { handle, access }) });
    const key = await inject(h.app, 'POST', routes.integratorKey(), owner, undefined);
    const domain = h.app.projectman.domain;
    await domain.messaging.sendReporting(
      'AR',
      'owner',
      { to: ['operator'], text: 'Propose shared knowledge' },
      { awaitWake: true },
    );
    const session = await waitForSession(domain, { member: 'operator' });
    const change: OperatorKnowledgeChange =
      kind === 'agreement'
        ? {
            kind: 'agreement_replace',
            agreement: {
              summary: 'PRIVATE_SUMMARY',
              involvement: 'important',
              extraCritical: ['PRIVATE_CRITICAL'],
            },
          }
        : {
            kind: 'principle_put',
            principle: {
              id: null,
              example: 'PRIVATE_EXAMPLE',
              principle: 'PRIVATE_PRINCIPLE',
              effect: 'PRIVATE_EFFECT',
            },
          };
    const proposal = await domain.teamTools.proposeOperatorKnowledge(
      { projectKey: 'AR', member: 'operator', sessionId: session.id, taskKey: null },
      {
        expected_revision: 0,
        title: 'PRIVATE_PROPOSAL_TITLE',
        change,
        operations: [],
      },
    );
    domain.inbox.create({
      projectKey: 'AR',
      kind: 'alert',
      source: 'system',
      assignees: ['owner'],
      title: 'Ordinary internal item',
      payload: {},
      options: [],
    });
    for (const state of ['open', 'resolved'] as const) {
      if (state === 'resolved')
        await domain.inbox.resolve(
          'AR',
          proposal.inbox_item_id,
          { optionId: 'approve' },
          { handle: 'owner', access: 'owner' },
        );
      const item = domain.inbox.get('AR', proposal.inbox_item_id);
      for (const reader of readers) {
        const allowed = ['owner', 'admin'].includes(reader.access);
        for (const suffix of ['', '?state=all']) {
          const response = await inject(
            h.app,
            'GET',
            `${routes.inbox('AR')}${suffix}`,
            reader.cookie,
            undefined,
          );
          expect(response.statusCode).toBe(200);
          expect(response.body.includes('PRIVATE_')).toBe(allowed && (state === 'open' || suffix !== ''));
          if (reader.access !== 'client') expect(response.body).toContain('Ordinary internal item');
        }
        expect(canSeeProjectEvent(reader, { type: 'inbox_upserted', projectKey: 'AR', item })).toBe(allowed);
        if (!allowed) {
          const attempt = await inject(h.app, 'POST', routes.resolveInbox('AR', item.id), reader.cookie, {
            optionId: 'approve',
          });
          expect(attempt.statusCode).toBe(404);
          expect(attempt.body).not.toContain('PRIVATE_');
        }
      }
      const integrator = await h.app.inject({
        method: 'GET',
        url: `${routes.inbox('AR')}?state=all`,
        headers: { authorization: `Bearer ${key.json().secret}` },
      });
      expect(integrator.statusCode).toBe(200);
      expect(integrator.body).not.toContain('PRIVATE_');
      expect(integrator.body).toContain('Ordinary internal item');
      const integratorBoard = await h.app.inject({
        method: 'GET',
        url: routes.board('AR'),
        headers: { authorization: `Bearer ${key.json().secret}` },
      });
      expect(integratorBoard.json().openInboxCount).toBe(1);
      const ownerBoard = await inject(h.app, 'GET', routes.board('AR'), owner, undefined);
      expect(ownerBoard.json().openInboxCount).toBe(state === 'open' ? 2 : 1);
      const attempt = await h.app.inject({
        method: 'POST',
        url: routes.resolveInbox('AR', item.id),
        headers: { authorization: `Bearer ${key.json().secret}` },
        payload: { optionId: 'approve' },
      });
      expect(attempt.statusCode).toBe(404);
      expect(
        canSeeProjectEvent(
          { handle: 'owner', access: 'owner', via: 'integrator' },
          { type: 'inbox_upserted', projectKey: 'AR', item },
        ),
      ).toBe(false);
    }
  },
);

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
