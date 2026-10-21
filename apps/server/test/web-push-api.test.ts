import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PUSH_SETTINGS, PushDeviceView, PushOverview, routes } from '@projectman/shared';
import { addHumanAndLogin, createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { FakePushTransport } from './helpers/fake-push';

describe('personal push API', () => {
  let h: AppHarness;
  let cookie: string;
  let fake: FakePushTransport;
  const body = (id = 'one') => ({
    endpoint: `https://fcm.googleapis.com/${id}`,
    keys: { p256dh: 'a'.repeat(87), auth: 'b'.repeat(22) },
    installed: true,
  });
  const subscribe = (id = 'one') =>
    h.app.inject({
      method: 'POST',
      url: routes.pushDevices(),
      headers: {
        cookie,
        origin: 'http://localhost',
        'user-agent': 'Mozilla/5.0 (Macintosh) Chrome/141.0 Safari/537.36',
      },
      payload: body(id),
    });
  beforeEach(async () => {
    fake = new FakePushTransport();
    h = await createAppHarness({
      app: { webPushTransport: fake, webPush: { subject: 'https://project.example' } },
    });
    cookie = await setupOwner(h.app);
  });
  afterEach(async () => h?.close());

  it('returns defaults without delivery credentials or the private VAPID key', async () => {
    await subscribe();
    const response = await inject(h.app, 'GET', routes.push(), cookie);
    expect(response.statusCode).toBe(200);
    expect(PushOverview.parse(response.json())).toMatchObject({
      available: true,
      publicKey: expect.any(String),
      settings: DEFAULT_PUSH_SETTINGS,
      devices: [expect.objectContaining({ browser: 'Chrome', os: 'macOS', installed: true })],
    });
    const key = JSON.parse(readFileSync(join(h.home, 'secrets/web-push.json'), 'utf8'));
    expect(response.body).not.toContain(key.privateKey);
    expect(response.body).not.toContain(body().endpoint);
    expect(response.body).not.toContain(body().keys.auth);
  });
  it('creates, updates, tests and deletes a device', async () => {
    const response = await subscribe();
    expect(response.statusCode).toBe(201);
    const device = PushDeviceView.parse(response.json());
    const updated = await subscribe();
    expect(updated.statusCode).toBe(200);
    expect(updated.json().id).toBe(device.id);
    const paused = await inject(h.app, 'PATCH', routes.pushDevice(device.id), cookie, { enabled: false });
    expect(paused.statusCode).toBe(200);
    expect(paused.json().enabled).toBe(false);
    const test = await inject(h.app, 'POST', routes.pushDeviceTest(device.id), cookie);
    expect(test.statusCode).toBe(200);
    expect(test.json().lastResult).toBe('ok');
    expect(fake.calls).toHaveLength(1);
    expect((await inject(h.app, 'POST', routes.pushDeviceTest(device.id), cookie)).statusCode).toBe(429);
    expect((await inject(h.app, 'DELETE', routes.pushDevice(device.id), cookie)).statusCode).toBe(204);
    expect((await inject(h.app, 'GET', routes.push(), cookie)).json().devices).toEqual([]);
  });
  it('saves settings and rejects invalid quiet hours', async () => {
    const settings = {
      ...DEFAULT_PUSH_SETTINGS,
      quietHours: { enabled: true, start: '20:00', end: '08:00', timeZone: 'Europe/Budapest' },
    };
    expect((await inject(h.app, 'PUT', routes.pushSettings(), cookie, settings)).json()).toEqual(settings);
    expect((await inject(h.app, 'GET', routes.push(), cookie)).json().settings).toEqual(settings);
    const invalid = await inject(h.app, 'PUT', routes.pushSettings(), cookie, {
      ...settings,
      quietHours: { ...settings.quietHours, end: '20:00' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('web_push_quiet_hours_invalid');
  });
  it('unsubscribes only its own endpoint idempotently', async () => {
    await subscribe();
    for (let i = 0; i < 2; i++)
      expect(
        (await inject(h.app, 'POST', routes.pushUnsubscribe(), cookie, { endpoint: body().endpoint }))
          .statusCode,
      ).toBe(204);
    expect((await inject(h.app, 'GET', routes.push(), cookie)).json().devices).toEqual([]);
  });
  it('refuses endpoints outside the provider allowlist', async () => {
    const result = await inject(h.app, 'POST', routes.pushDevices(), cookie, {
      ...body(),
      endpoint: 'https://127.0.0.1/private',
    });
    expect(result.statusCode).toBe(400);
    expect(result.json().error.code).toBe('web_push_endpoint_invalid');
    expect(fake.calls).toHaveLength(0);
  });
  it('refuses the twenty-first device', async () => {
    for (let i = 0; i < 20; i++) expect((await subscribe(String(i))).statusCode).toBe(201);
    const result = await subscribe('21');
    expect(result.statusCode).toBe(409);
    expect(result.json().error.code).toBe('web_push_device_limit');
  });
  it('hides foreign devices from every device operation', async () => {
    await createProject(h, cookie);
    const device = (await subscribe()).json();
    const other = await addHumanAndLogin(h.app, { handle: 'other', access: 'developer' });
    for (const method of ['PATCH', 'DELETE', 'POST'] as const) {
      const result = await inject(
        h.app,
        method,
        method === 'POST' ? routes.pushDeviceTest(device.id) : routes.pushDevice(device.id),
        other,
        method === 'PATCH' ? { enabled: false } : undefined,
      );
      expect(result.statusCode).toBe(404);
    }
    await inject(h.app, 'POST', routes.pushUnsubscribe(), other, { endpoint: body().endpoint });
    expect((await inject(h.app, 'GET', routes.push(), cookie)).json().devices).toHaveLength(1);
  });
  it.each(['legacy', 'read', 'super'] as const)(
    'refuses a %s integrator key on every endpoint',
    async (mode) => {
      const key = await inject(
        h.app,
        'POST',
        mode === 'legacy' ? routes.integratorKey() : routes.integratorKeys(),
        cookie,
        mode === 'legacy' ? {} : { mode },
      );
      expect(key.statusCode).toBe(201);
      for (const [method, url] of [
        ['GET', routes.push()],
        ['PUT', routes.pushSettings()],
        ['POST', routes.pushDevices()],
        ['PATCH', routes.pushDevice('unknown')],
        ['DELETE', routes.pushDevice('unknown')],
        ['POST', routes.pushUnsubscribe()],
        ['POST', routes.pushDeviceTest('unknown')],
      ] as const) {
        const response = await h.app.inject({
          method,
          url,
          headers: { authorization: `Bearer ${key.json().secret}` },
          ...(method === 'GET' || method === 'DELETE' ? {} : { payload: {} }),
        });
        expect(response.statusCode, response.body).toBe(403);
        expect(response.json().error.code).toBe('web_push_integrator_refused');
      }
    },
  );
  it('requires login', async () => expect((await inject(h.app, 'GET', routes.push())).statusCode).toBe(401));
  it('dispatches an inbox bus event through the injected transport', async () => {
    await createProject(h, cookie);
    expect((await subscribe()).statusCode).toBe(201);
    const item = {
      id: 'bus-item',
      projectKey: 'AR',
      kind: 'question' as const,
      assignees: ['owner'],
      source: 'dev-1',
      sessionId: null,
      taskKey: 'AR-1',
      title: 'Private',
      body: null,
      payload: {},
      options: [],
      state: 'open' as const,
      resolution: null,
      createdAt: new Date().toISOString(),
    };
    h.app.projectman.domain.bus.publish({ type: 'inbox_upserted', projectKey: 'AR', item });
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    expect(JSON.parse(fake.calls[0]!.payload)).toMatchObject({ kind: 'item', itemId: item.id });
  });
  it('reports unavailable and refuses registration when disabled', async () => {
    h.app = await h.relaunch({ webPush: { enabled: false } });
    expect((await inject(h.app, 'GET', routes.push(), cookie)).json()).toMatchObject({
      available: false,
      publicKey: null,
    });
    const result = await subscribe();
    expect(result.statusCode).toBe(503);
    expect(result.json().error.code).toBe('web_push_unavailable');
  });
});
