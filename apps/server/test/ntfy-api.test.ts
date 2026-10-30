import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NtfyChannelView, NtfyOverview, routes } from '@projectman/shared';
import { createAppHarness, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { FakeNtfyTransport } from './helpers/fake-ntfy';

describe('personal ntfy API', () => {
  let h: AppHarness;
  let cookie: string;
  let fake: FakeNtfyTransport;
  beforeEach(async () => {
    fake = new FakeNtfyTransport();
    h = await createAppHarness({ app: { ntfyTransport: fake } });
    cookie = await setupOwner(h.app);
  });
  afterEach(async () => h?.close());

  it('creates, tests, renews and deletes the channel', async () => {
    const empty = await inject(h.app, 'GET', routes.pushNtfy(), cookie);
    expect(NtfyOverview.parse(empty.json())).toMatchObject({ available: true, channel: null });
    const created = await h.app.inject({
      method: 'PUT',
      url: routes.pushNtfy(),
      headers: { cookie, origin: 'http://localhost' },
      payload: {},
    });
    const channel = NtfyChannelView.parse(created.json());
    expect(channel).toMatchObject({ server: 'https://ntfy.sh', enabled: true, hasLink: true });
    const tested = await inject(h.app, 'POST', routes.pushNtfyTest(), cookie);
    expect(NtfyChannelView.parse(tested.json()).lastResult).toBe('ok');
    expect(fake.calls[0]).toMatchObject({ topic: channel.topic, click: 'http://localhost/' });
    const renewed = await inject(h.app, 'POST', routes.pushNtfyTopic(), cookie);
    expect(renewed.json().topic).not.toBe(channel.topic);
    expect((await inject(h.app, 'DELETE', routes.pushNtfy(), cookie)).statusCode).toBe(204);
    expect(
      NtfyOverview.parse((await inject(h.app, 'GET', routes.pushNtfy(), cookie)).json()).channel,
    ).toBeNull();
  });
  it('refuses an internal server address', async () => {
    const response = await inject(h.app, 'PUT', routes.pushNtfy(), cookie, { server: 'https://127.0.0.1' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('ntfy_server_invalid');
  });
  it('requires a login', async () => {
    expect((await inject(h.app, 'GET', routes.pushNtfy())).statusCode).toBe(401);
  });
});
