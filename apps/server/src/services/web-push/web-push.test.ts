import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PUSH_SETTINGS, PushPayload } from '@projectman/shared';
import type { InboxItem, PushSettings } from '@projectman/shared';
import { getLocale } from '@projectman/templates';
import { createRepositories } from '../../db';
import { PresenceService } from '../../core/members';
import { openMigratedMemoryDatabase } from '../../../test/helpers/database-seed';
import { FakePushTransport } from '../../../test/helpers/fake-push';
import { capturingLogger } from '../../../test/helpers/fakes';
import { testTemplate } from '../../../test/helpers/test-template';
import { createWebPushService } from './index';
import type { PushSendOutcome } from '../../contracts';
import { loadOrCreateVapidKey } from './secret';
import { pushOutcomeOf } from './transport';

describe('web push service', () => {
  let home: string;
  let repos: ReturnType<typeof createRepositories>;
  let transport: FakePushTransport;
  let presence: PresenceService;
  let time: Date;
  let service: ReturnType<typeof createWebPushService>;
  const logger = capturingLogger();
  const user = {
    id: 'user',
    email: 'owner@example.com',
    name: 'Owner',
    passwordHash: null,
    createdAt: '2026-10-01T00:00:00Z',
    language: 'hu' as const,
  };
  const config = testTemplate.build({
    key: 'AR',
    name: 'Test',
    workspacePath: '/unused',
    language: 'en',
    owner: { handle: 'owner', email: user.email, displayName: 'Owner' },
  });
  const input = (suffix = 'one') => ({
    endpoint: `https://fcm.googleapis.com/${suffix}`,
    keys: { p256dh: 'a'.repeat(87), auth: 'b'.repeat(22) },
    installed: false,
  });
  const item = (id = 'one'): InboxItem => ({
    id,
    projectKey: 'AR',
    kind: 'question',
    assignees: ['owner'],
    source: 'dev-1',
    sessionId: null,
    taskKey: 'AR-1',
    title: 'Private title',
    body: 'Private body',
    payload: { question: 'Private question' },
    options: [],
    state: 'open',
    resolution: null,
    createdAt: time.toISOString(),
  });
  function build(extra: Partial<Parameters<typeof createWebPushService>[0]> = {}) {
    return createWebPushService({
      home,
      repos,
      transport,
      presence,
      logger: logger.logger,
      now: () => time,
      config: async () => config,
      ...extra,
    });
  }
  function subscribe(suffix = 'one') {
    return service.subscribe(user.id, input(suffix), 'Chrome/141.0 (Macintosh)', 'https://project.example')
      .device;
  }
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'pm-push-'));
    repos = createRepositories(openMigratedMemoryDatabase());
    repos.users.insert(user);
    repos.projects.insert({
      key: 'AR',
      name: 'Test',
      templateId: null,
      configVersion: 'v1',
      createdAt: user.createdAt,
      updatedAt: user.createdAt,
    });
    transport = new FakePushTransport();
    presence = new PresenceService();
    time = new Date('2026-10-20T10:00:00Z');
    service = build();
  });
  afterEach(() => {
    repos.db.close();
    rmSync(home, { recursive: true, force: true });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sends once for repeated upserts and includes only the card key in the body', async () => {
    subscribe();
    await Promise.all([service.onItem(item()), service.onItem(item())]);
    expect(transport.calls).toHaveLength(1);
    const payload = PushPayload.parse(JSON.parse(transport.calls[0]!.payload));
    expect(payload).toMatchObject({
      kind: 'item',
      body: 'AR-1',
      tag: 'inbox-one',
      url: '/p/AR/inbox?via=push#inbox-item-one',
    });
    expect(transport.calls[0]!.payload).not.toContain('Private');
    expect(transport.calls[0]).toMatchObject({ ttlSeconds: 86400, urgency: 'high', timeoutMs: 10000 });
  });
  it.each(['category', 'paused', 'deleted', 'viewing', 'newer-device'] as const)(
    'suppresses delivery for %s',
    async (reason) => {
      const d = subscribe();
      const opened = item();
      if (reason === 'category')
        service.settings(user.id, {
          ...DEFAULT_PUSH_SETTINGS,
          categories: { ...DEFAULT_PUSH_SETTINGS.categories, question: false },
        });
      if (reason === 'paused') service.updateDevice(user.id, d.id, false);
      if (reason === 'deleted') service.removeDevice(user.id, d.id);
      if (reason === 'viewing') presence.setVisible('connection', user.email, true);
      if (reason === 'newer-device') opened.createdAt = '2026-10-19T00:00:00Z';
      await service.onItem(opened);
      expect(transport.calls).toHaveLength(0);
      expect(repos.db.prepare('SELECT COUNT(*) AS n FROM web_push_items').get()).toEqual({
        n: reason === 'paused' || reason === 'deleted' ? 0 : 1,
      });
    },
  );
  it('does not record items for users without active devices', async () => {
    await service.onItem(item());
    subscribe();
    await service.onItem(item());
    expect(transport.calls).toHaveLength(1);
  });
  describe('a request to the host (PM-1064)', () => {
    const request = { requestId: 'hreq_1', projectKey: 'BR', title: 'Need a right' };

    it('sends the title and a link to the host’s own first project, with nothing else of the request', async () => {
      subscribe();
      await service.notifyHost({ userId: user.id }, request);
      expect(transport.calls).toHaveLength(1);
      expect(PushPayload.parse(JSON.parse(transport.calls[0]!.payload))).toMatchObject({
        kind: 'item',
        body: 'Need a right',
        tag: 'host-request-hreq_1',
        url: '/p/AR/settings/owners',
      });
      expect(transport.calls[0]!.payload).not.toContain('BR');
    });

    it.each(['category', 'viewing', 'quiet'] as const)('is not sent while %s', async (reason) => {
      subscribe();
      if (reason === 'category')
        service.settings(user.id, {
          ...DEFAULT_PUSH_SETTINGS,
          categories: { ...DEFAULT_PUSH_SETTINGS.categories, host_request: false },
        });
      if (reason === 'viewing') presence.setVisible('connection', user.email, true);
      if (reason === 'quiet') {
        time = new Date('2026-10-20T23:00:00Z');
        service.settings(user.id, {
          ...DEFAULT_PUSH_SETTINGS,
          quietHours: { ...DEFAULT_PUSH_SETTINGS.quietHours, enabled: true },
        });
      }
      await service.notifyHost({ userId: user.id }, request);
      expect(transport.calls).toHaveLength(0);
    });

    it('reads the category as on in settings saved before it existed', () => {
      repos.db
        .prepare(
          'INSERT INTO web_push_settings (user_id, categories, quiet_enabled, quiet_start, quiet_end, time_zone, updated_at) VALUES (?, ?, 0, ?, ?, ?, ?)',
        )
        .run(
          user.id,
          JSON.stringify({
            question: false,
            decision: true,
            approval: true,
            permission: true,
            release: true,
          }),
          '22:00',
          '07:00',
          'UTC',
          time.toISOString(),
        );
      expect(service.overview(user.id).settings.categories).toMatchObject({
        question: false,
        host_request: true,
      });
    });
  });
  it('delivers an item to each enabled device', async () => {
    subscribe('desktop');
    subscribe('phone');
    await service.onItem(item());
    expect(transport.calls.map((call) => call.endpoint).sort()).toEqual([
      input('desktop').endpoint,
      input('phone').endpoint,
    ]);
  });
  it('words each recipient’s push in that account’s own language (PM-1177)', async () => {
    const colleague = { ...user, id: 'colleague', email: 'colleague@example.com', language: 'en' as const };
    repos.users.insert(colleague);
    const both = structuredClone(config);
    both.team.members.push({
      kind: 'human',
      handle: 'colleague',
      displayName: 'Colleague',
      access: 'owner',
      roles: [],
      email: colleague.email,
    });
    service = build({ config: async () => both });
    subscribe('hungarian');
    service.subscribe(colleague.id, input('english'), 'Chrome/141.0 (Macintosh)', 'https://project.example');
    await service.onItem({ ...item(), assignees: ['owner', 'colleague'] });
    const titleAt = (endpoint: string) =>
      PushPayload.parse(JSON.parse(transport.calls.find((call) => call.endpoint === endpoint)!.payload))
        .title;
    expect(transport.calls).toHaveLength(2);
    expect(titleAt(input('hungarian').endpoint)).toBe(getLocale('hu').webPush.title.question);
    expect(titleAt(input('english').endpoint)).toBe(getLocale('en').webPush.title.question);
  });
  it('rechecks recipient access before sending', async () => {
    subscribe();
    const changed = structuredClone(config);
    changed.team.members = changed.team.members.filter((m) => m.kind !== 'human');
    service = build({ config: async () => changed });
    await service.onItem(item());
    expect(transport.calls).toHaveLength(0);
  });
  it('delays quiet items and sends one digest excluding closed items', async () => {
    subscribe();
    time = new Date('2026-10-20T23:00:00Z');
    service.settings(user.id, {
      ...DEFAULT_PUSH_SETTINGS,
      quietHours: { ...DEFAULT_PUSH_SETTINGS.quietHours, enabled: true },
    });
    for (const id of ['open', 'closed']) {
      const entry = item(id);
      repos.inbox.insert(entry);
      await service.onItem(entry);
    }
    expect(transport.calls).toHaveLength(0);
    repos.db.prepare("UPDATE inbox_items SET state = 'resolved' WHERE id = 'closed'").run();
    time = new Date('2026-10-21T07:00:00Z');
    await Promise.all([service.sweep(), service.sweep()]);
    expect(transport.calls).toHaveLength(1);
    expect(JSON.parse(transport.calls[0]!.payload)).toMatchObject({
      kind: 'digest',
      title: expect.stringContaining('1'),
      tag: 'digest',
      url: '/p/AR/inbox',
    });
    expect(repos.webPush.quiet(user.id)).toHaveLength(0);
    expect(repos.webPush.due(time.toISOString())).toHaveLength(0);
    await service.sweep();
    expect(transport.calls).toHaveLength(1);
  });
  it('reschedules a pending digest when quiet hours change and flushes it when disabled', async () => {
    subscribe();
    time = new Date('2026-10-20T23:00:00Z');
    const settings: PushSettings = {
      ...DEFAULT_PUSH_SETTINGS,
      quietHours: { ...DEFAULT_PUSH_SETTINGS.quietHours, enabled: true },
    };
    service.settings(user.id, settings);
    repos.inbox.insert(item());
    await service.onItem(item());
    service.settings(user.id, { ...settings, quietHours: { ...settings.quietHours, end: '09:00' } });
    expect(repos.webPush.due('2026-10-21T07:00:00Z')).toHaveLength(0);
    service.settings(user.id, DEFAULT_PUSH_SETTINGS);
    await service.sweep();
    expect(transport.calls).toHaveLength(1);
  });
  it('omits a digest when its category was disabled meanwhile', async () => {
    subscribe();
    time = new Date('2026-10-20T23:00:00Z');
    service.settings(user.id, {
      ...DEFAULT_PUSH_SETTINGS,
      quietHours: { ...DEFAULT_PUSH_SETTINGS.quietHours, enabled: true },
    });
    repos.inbox.insert(item());
    await service.onItem(item());
    service.settings(user.id, {
      ...DEFAULT_PUSH_SETTINGS,
      categories: { ...DEFAULT_PUSH_SETTINGS.categories, question: false },
    });
    await service.sweep();
    expect(transport.calls).toHaveLength(0);
    expect(repos.webPush.quiet(user.id)).toHaveLength(0);
  });
  it('defers a due digest while still inside quiet hours after the autumn DST transition', async () => {
    subscribe();
    time = new Date('2026-10-24T21:00:00Z');
    service.settings(user.id, {
      ...DEFAULT_PUSH_SETTINGS,
      quietHours: { ...DEFAULT_PUSH_SETTINGS.quietHours, enabled: true, timeZone: 'Europe/Budapest' },
    });
    repos.inbox.insert(item());
    await service.onItem(item());
    time = new Date('2026-10-25T05:00:00Z');
    expect(repos.webPush.due(time.toISOString())).toHaveLength(1);
    await service.sweep();
    expect(transport.calls).toHaveLength(0);
    expect(repos.webPush.due(time.toISOString())).toHaveLength(0);
    time = new Date('2026-10-25T06:00:00Z');
    await service.sweep();
    expect(transport.calls).toHaveLength(1);
  });
  it('marks expired devices and erases their delivery credentials', async () => {
    const d = subscribe();
    transport.outcome = { result: 'expired' };
    await service.onItem(item());
    expect(repos.webPush.device(user.id, d.id)).toMatchObject({
      state: 'expired',
      endpoint: null,
      p256dh: null,
      auth: null,
      last_result: 'expired',
      last_failure: null,
    });
    await expect(service.test(user.id, d.id)).rejects.toMatchObject({ code: 'web_push_endpoint_invalid' });
  });
  it('records expiration after another concurrent delivery completes', async () => {
    const d = subscribe();
    const complete: Array<(outcome: PushSendOutcome) => void> = [];
    service = build({ transport: { send: () => new Promise((resolve) => complete.push(resolve)) } });
    const first = service.onItem(item('first'));
    const second = service.onItem(item('second'));
    await vi.waitFor(() => expect(complete).toHaveLength(2));
    time = new Date(time.getTime() + 1000);
    complete[0]!({ result: 'ok' });
    await first;
    time = new Date(time.getTime() + 1000);
    complete[1]!({ result: 'expired' });
    await second;
    expect(repos.webPush.device(user.id, d.id)).toMatchObject({
      state: 'expired',
      endpoint: null,
      p256dh: null,
      auth: null,
      last_result: 'expired',
      last_sent_at: time.toISOString(),
    });
  });
  it('ignores an old delivery result after subscription keys change', async () => {
    const d = subscribe();
    let complete!: (outcome: PushSendOutcome) => void;
    service = build({
      transport: {
        send: () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      },
    });
    const sending = service.onItem(item());
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
    time = new Date(time.getTime() + 1000);
    const next = { ...input(), keys: { p256dh: 'c'.repeat(87), auth: 'd'.repeat(22) } };
    service.subscribe(user.id, next, '', 'https://project.example');
    complete({ result: 'expired' });
    await sending;
    expect(repos.webPush.device(user.id, d.id)).toMatchObject({
      state: 'active',
      endpoint: next.endpoint,
      p256dh: next.keys.p256dh,
      auth: next.keys.auth,
      last_result: null,
    });
  });
  it('schedules a quiet item without rewriting saved user settings', async () => {
    subscribe();
    const savedAt = time.toISOString();
    service.settings(user.id, {
      ...DEFAULT_PUSH_SETTINGS,
      quietHours: { ...DEFAULT_PUSH_SETTINGS.quietHours, enabled: true },
    });
    time = new Date('2026-10-20T23:00:00Z');
    await service.onItem(item());
    expect(
      repos.db
        .prepare('SELECT updated_at, digest_due_at FROM web_push_settings WHERE user_id = ?')
        .get(user.id),
    ).toEqual({ updated_at: savedAt, digest_due_at: '2026-10-21T07:00:00.000Z' });
  });
  it('expires devices from a lost VAPID key without sending', async () => {
    const d = subscribe();
    unlinkSync(join(home, 'secrets/web-push.json'));
    service = build();
    await service.onItem(item());
    expect(transport.calls).toHaveLength(0);
    expect(repos.webPush.device(user.id, d.id)).toMatchObject({
      state: 'expired',
      endpoint: null,
      p256dh: null,
      auth: null,
    });
  });
  it('tests a paused device despite quiet hours and visible tabs, with a five-second limit', async () => {
    const d = subscribe();
    service.updateDevice(user.id, d.id, false);
    presence.setVisible('tab', user.email, true);
    time = new Date('2026-10-20T23:00:00Z');
    service.settings(user.id, {
      ...DEFAULT_PUSH_SETTINGS,
      quietHours: { ...DEFAULT_PUSH_SETTINGS.quietHours, enabled: true },
    });
    expect(await service.test(user.id, d.id)).toMatchObject({ lastResult: 'ok' });
    await expect(service.test(user.id, d.id)).rejects.toMatchObject({ code: 'web_push_test_too_soon' });
    time = new Date(time.getTime() + 5000);
    await service.test(user.id, d.id);
    expect(transport.calls).toHaveLength(2);
  });
  it('bounds an unresponsive transport and stores a safe failure', async () => {
    vi.useFakeTimers();
    const d = subscribe();
    service = build({ transport: { send: () => new Promise(() => {}) } });
    const result = service.test(user.id, d.id);
    await vi.advanceTimersByTimeAsync(10000);
    expect(await result).toMatchObject({ lastResult: 'failed', lastFailure: 'timeout' });
  });
  it('contains transport exceptions without leaking their message', async () => {
    const d = subscribe();
    const log = vi.spyOn(logger.logger, 'info');
    service = build({
      transport: {
        send: async () => {
          throw new Error('Private transport secret');
        },
      },
    });
    expect(await service.test(user.id, d.id)).toMatchObject({ lastFailure: 'network' });
    expect(JSON.stringify(logger)).not.toContain('Private transport secret');
    expect(log.mock.calls).toEqual([[{ deviceId: d.id, result: 'failed' }, 'web push delivery']]);
  });
  it('refuses another user’s endpoint and leaves their device alone', () => {
    const d = subscribe();
    repos.users.insert({ ...user, id: 'other', email: 'other@example.com' });
    expect(() => service.subscribe('other', input(), '', 'https://project.example')).toThrow(
      expect.objectContaining({ code: 'web_push_endpoint_taken', status: 409 }),
    );
    expect(service.overview(user.id).devices).toMatchObject([{ id: d.id }]);
    expect(service.overview('other').devices).toHaveLength(0);
  });
  it('updates an existing endpoint even at the device limit', () => {
    for (let i = 0; i < 20; i++) subscribe(String(i));
    expect(() => subscribe('21')).toThrow(expect.objectContaining({ code: 'web_push_device_limit' }));
    expect(service.subscribe(user.id, input('0'), '', 'https://project.example').created).toBe(false);
  });
  it('persists one protected key and keeps secrets out of the overview', () => {
    subscribe();
    const path = join(home, 'secrets/web-push.json');
    const key = loadOrCreateVapidKey(home);
    expect(loadOrCreateVapidKey(home)).toEqual(key);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, 'secrets')).mode & 0o777).toBe(0o700);
    const view = JSON.stringify(service.overview(user.id));
    expect(view).not.toContain(key.privateKey);
    expect(view).not.toContain(input().endpoint);
    expect(view).not.toContain(input().keys.auth);
  });
  it('sanitizes a corrupt key file error', () => {
    writeFileSync(join(home, 'secrets/web-push.json'), '{"privateKey":"Private secret"}');
    expect(() => loadOrCreateVapidKey(home)).toThrow('Invalid web push key file');
    try {
      loadOrCreateVapidKey(home);
    } catch (error) {
      expect(String(error)).not.toContain('Private secret');
    }
  });
  it.each([{ enabled: false }, { standby: true }])(
    'does not create keys or send when unavailable: %j',
    async (extra) => {
      const keyPath = join(home, 'secrets/web-push.json');
      unlinkSync(keyPath);
      service = build(extra);
      expect(service.overview(user.id)).toMatchObject({ available: false, publicKey: null });
      await service.onItem(item());
      await service.sweep();
      expect(transport.calls).toHaveLength(0);
      expect(() => readFileSync(keyPath)).toThrow();
    },
  );
  it('prunes delivery records older than thirty days', async () => {
    repos.webPush.claim({
      user_id: user.id,
      inbox_item_id: 'old',
      project_key: 'AR',
      outcome: 'sent',
      skip_reason: null,
      created_at: '2026-01-01T00:00:00Z',
    });
    await service.sweep();
    expect(repos.db.prepare('SELECT COUNT(*) AS n FROM web_push_items').get()).toEqual({ n: 0 });
  });
});

it.each([
  [{ statusCode: 201 }, { result: 'ok' }],
  [{ statusCode: 404 }, { result: 'expired' }],
  [{ statusCode: 410 }, { result: 'expired' }],
  [{ statusCode: 429 }, { result: 'failed', failure: 'rate_limited' }],
  [{ statusCode: 413 }, { result: 'failed', failure: 'payload_too_large' }],
  [{ statusCode: 400 }, { result: 'failed', failure: 'rejected' }],
  [{ statusCode: 401 }, { result: 'failed', failure: 'rejected' }],
  [{ statusCode: 403 }, { result: 'failed', failure: 'rejected' }],
  [{ statusCode: 503 }, { result: 'failed', failure: 'service_error' }],
  [{ statusCode: 302 }, { result: 'failed', failure: 'network' }],
  [{ code: 'ETIMEDOUT' }, { result: 'failed', failure: 'timeout' }],
  [{ message: 'Socket timeout' }, { result: 'failed', failure: 'timeout' }],
  [new Error('untrusted private text'), { result: 'failed', failure: 'network' }],
])('maps a provider outcome %j without exposing details', (error, expected) =>
  expect(pushOutcomeOf(error)).toEqual(expected),
);

it('keeps visibility for another tab when one disconnects', () => {
  const presence = new PresenceService();
  presence.setVisible('one', 'OWNER@example.com', true);
  presence.setVisible('two', 'owner@example.com', true);
  presence.setVisible('one', 'owner@example.com', false);
  expect(presence.isViewing('owner@example.com')).toBe(true);
  presence.setVisible('two', 'owner@example.com', false);
  expect(presence.isViewing('owner@example.com')).toBe(false);
});
