import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CreatedIntegratorAccessKey,
  ExecuteSuperHandoffResponse,
  ListSuperHandoffsResponse,
  routes,
} from '@projectman/shared';
import type { SuperCommand } from '@projectman/shared';
import { addHumanAndLogin, createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

const PAUSE: SuperCommand = { kind: 'operate', operation: { op: 'project_pause' } };

describe('super-mode handoff routes (PM-762)', () => {
  let app: AppHarness;
  let cookie: string;
  let secret: string;
  let ran: number;
  beforeEach(async () => {
    app = await createAppHarness();
    cookie = await setupOwner(app.app);
    await createProject(app, cookie);
    const created = await app.app.inject({
      method: 'POST',
      url: routes.integratorKeys(),
      headers: { cookie },
      payload: { mode: 'super' },
    });
    secret = CreatedIntegratorAccessKey.parse(created.json()).secret;
    ran = 0;
    app.app.projectman.domain.superHandoffs.registerExecutor('operate', async () => {
      ran += 1;
    });
  });
  afterEach(async () => app?.close());

  const bearer = {
    get authorization() {
      return `Bearer ${secret}`;
    },
  };
  const handoff = () =>
    app.app.projectman.domain.superHandoffs.request(
      'AR',
      { kind: 'ai', handle: 'operator' },
      { reason: 'A fictional reason', command: PAUSE, requestId: randomUUID() },
    );

  it('lists for the owner`s login and the token, filters by state, and refuses others', async () => {
    const made = await handoff();
    const url = routes.superHandoffs('AR');
    const owner = await inject(app.app, 'GET', url, cookie);
    expect(owner.statusCode).toBe(200);
    expect(ListSuperHandoffsResponse.parse(owner.json()).handoffs.map((x) => x.id)).toEqual([made.id]);
    const viaToken = await app.app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(viaToken.statusCode).toBe(200);
    expect(
      ListSuperHandoffsResponse.parse((await inject(app.app, 'GET', `${url}?state=succeeded`, cookie)).json())
        .handoffs,
    ).toEqual([]);
    expect((await inject(app.app, 'GET', `${url}?limit=1000`, cookie)).statusCode).toBe(400);
    expect((await inject(app.app, 'GET', `${url}?other=1`, cookie)).statusCode).toBe(400);
    const admin = await addHumanAndLogin(app.app, { handle: 'ada', access: 'admin' });
    expect((await inject(app.app, 'GET', url, admin)).statusCode).toBe(403);
    expect((await app.app.inject({ method: 'GET', url })).statusCode).toBe(401);
  });

  it('executes with the token only: 202 and the operation, the same request again is the same operation', async () => {
    const made = await handoff();
    const url = routes.executeSuperHandoff('AR', made.id);
    const requestId = randomUUID();
    const run = () => app.app.inject({ method: 'POST', url, headers: bearer, payload: { requestId } });
    const first = await run();
    expect(first.statusCode, first.body).toBe(202);
    const operation = ExecuteSuperHandoffResponse.parse(first.json()).operation;
    expect(operation).toMatchObject({ state: 'succeeded', handoffId: made.id, requestId });
    const again = await run();
    expect(again.statusCode).toBe(202);
    expect(ExecuteSuperHandoffResponse.parse(again.json()).operation.id).toBe(operation.id);
    expect(ran).toBe(1);
    const closed = await app.app.inject({
      method: 'POST',
      url,
      headers: bearer,
      payload: { requestId: randomUUID() },
    });
    expect(closed.statusCode).toBe(409);
    expect(closed.json().error.code).toBe('super_handoff_closed');
  });

  it('refuses the owner`s plain login, a bad body and an unknown handoff', async () => {
    const made = await handoff();
    const url = routes.executeSuperHandoff('AR', made.id);
    const plain = await inject(app.app, 'POST', url, cookie, { requestId: randomUUID() });
    expect(plain.statusCode).toBe(403);
    expect(plain.json().error.code).toBe('integrator_not_allowed');
    const bad = await app.app.inject({
      method: 'POST',
      url,
      headers: bearer,
      payload: { requestId: 'nope' },
    });
    expect(bad.statusCode).toBe(400);
    const stray = await app.app.inject({
      method: 'POST',
      url,
      headers: bearer,
      payload: { requestId: randomUUID(), extra: 1 },
    });
    expect(stray.statusCode).toBe(400);
    const unknown = await app.app.inject({
      method: 'POST',
      url: routes.executeSuperHandoff('AR', 'sho_missing'),
      headers: bearer,
      payload: { requestId: randomUUID() },
    });
    expect(unknown.statusCode).toBe(404);
    expect(ran).toBe(0);
  });

  it('answers 503 while no executor is wired for the kind of the command', async () => {
    const made = await app.app.projectman.domain.superHandoffs.request(
      'AR',
      { kind: 'ai', handle: 'operator' },
      {
        reason: 'A fictional reason',
        command: { kind: 'member_update', handle: 'dev-1', request: { displayName: 'Fictional name' } },
        requestId: randomUUID(),
      },
    );
    const response = await app.app.inject({
      method: 'POST',
      url: routes.executeSuperHandoff('AR', made.id),
      headers: bearer,
      payload: { requestId: randomUUID() },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('super_executor_unavailable');
  });

  describe('relaying an owner answer', () => {
    const ask = (payload: Record<string, unknown>) =>
      app.app.projectman.domain.inbox.create({
        projectKey: 'AR',
        kind: 'question',
        assignees: ['owner'],
        source: 'dev-1',
        sessionId: null,
        title: 'Fictional question',
        payload: { question: 'Which fictional port?', ...payload },
        options: [{ id: 'answer', label: 'answer', style: 'primary' }],
      });

    it('answers an information question with the token and refuses everything else', async () => {
      const info = ask({ responsePurpose: 'information' });
      const decision = ask({ responsePurpose: 'owner_decision' });
      const unstated = ask({});
      const url = (id: string) => routes.relayOwnerAnswer('AR', id);
      // Without the token (the owner's plain login) there is nothing to relay.
      expect((await inject(app.app, 'POST', url(info.id), cookie, { answer: 'Port 4700.' })).statusCode).toBe(
        403,
      );
      for (const refused of [decision, unstated]) {
        const response = await app.app.inject({
          method: 'POST',
          url: url(refused.id),
          headers: bearer,
          payload: { answer: 'Whatever.' },
        });
        expect(response.statusCode).toBe(403);
        expect(response.json().error.code).toBe('super_relay_refused');
      }
      const empty = await app.app.inject({
        method: 'POST',
        url: url(info.id),
        headers: bearer,
        payload: { answer: '  ' },
      });
      expect(empty.statusCode).toBe(400);
      const ok = await app.app.inject({
        method: 'POST',
        url: url(info.id),
        headers: bearer,
        payload: { answer: 'Port 4700.' },
      });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json().item.resolution).toMatchObject({ ownerAnswerRelayed: true, note: 'Port 4700.' });
      expect(app.app.projectman.domain.inbox.get('AR', decision.id).state).toBe('open');
    });
  });
});
