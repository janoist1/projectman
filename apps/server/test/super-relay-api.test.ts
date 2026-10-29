import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CreatedIntegratorAccessKey, routes } from '@projectman/shared';
import { createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

describe('super-mode owner answer relay route (PM-762)', () => {
  let app: AppHarness;
  let cookie: string;
  let secret: string;
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
  });
  afterEach(async () => app?.close());

  const bearer = {
    get authorization() {
      return `Bearer ${secret}`;
    },
  };

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
