import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PUSH_SETTINGS } from '@projectman/shared';
import type { InboxItem } from '@projectman/shared';
import { createRepositories } from '../../db';
import { PresenceService } from '../../core/members';
import { openMigratedMemoryDatabase } from '../../../test/helpers/database-seed';
import { FakeNtfyTransport } from '../../../test/helpers/fake-ntfy';
import { FakePushTransport } from '../../../test/helpers/fake-push';
import { capturingLogger } from '../../../test/helpers/fakes';
import { testTemplate } from '../../../test/helpers/test-template';
import { createWebPushService } from '../web-push';
import { createNtfyService } from './index';
import { isPrivateAddress, ntfyOutcomeOf } from './transport';

describe('ntfy channel', () => {
  let home: string;
  let repos: ReturnType<typeof createRepositories>;
  let transport: FakeNtfyTransport;
  let time: Date;
  let service: ReturnType<typeof createNtfyService>;
  const logger = capturingLogger();
  const user = {
    id: 'user',
    email: 'owner@example.com',
    name: 'Owner',
    passwordHash: null,
    createdAt: '2026-10-01T00:00:00Z',
  };
  const config = testTemplate.build({
    key: 'AR',
    name: 'Test',
    workspacePath: '/unused',
    language: 'en',
    owner: { handle: 'owner', email: user.email, displayName: 'Owner' },
  });
  const item: InboxItem = {
    id: 'one',
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
    createdAt: '2026-10-20T10:00:00Z',
  };
  const save = (extra: { server?: string; enabled?: boolean } = {}) =>
    service.save(user.id, { server: 'https://ntfy.sh', enabled: true, ...extra }, 'https://pm.example');
  function webPush(phone = service.phone()) {
    return createWebPushService({
      home,
      repos,
      transport: new FakePushTransport(),
      phone,
      presence: new PresenceService(),
      logger: logger.logger,
      now: () => time,
      config: async () => config,
    });
  }
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'pm-ntfy-'));
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
    transport = new FakeNtfyTransport();
    time = new Date('2026-10-20T10:00:00Z');
    service = createNtfyService({ repos, transport, logger: logger.logger, now: () => time });
  });
  afterEach(() => {
    repos.db.close();
    rmSync(home, { recursive: true, force: true });
  });

  it('makes up a long secret topic and keeps it when the server changes', () => {
    const created = save();
    expect(created.topic).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    expect(created).toMatchObject({ server: 'https://ntfy.sh', enabled: true, hasLink: true });
    expect(save({ server: 'https://ntfy.example.org/' }).topic).toBe(created.topic);
    expect(service.renewTopic(user.id).topic).not.toBe(created.topic);
  });
  it.each([
    'http://ntfy.sh',
    'https://127.0.0.1',
    'https://ntfy.sh:8443',
    'https://nas.local',
    'https://u:p@ntfy.sh',
  ])('refuses the server address %s', (server) => {
    expect(() => save({ server })).toThrow(expect.objectContaining({ code: 'ntfy_server_invalid' }));
  });
  it('is unavailable on a standby copy', () => {
    const standby = createNtfyService({ repos, transport, standby: true, logger: logger.logger });
    expect(() => standby.save(user.id, { server: 'https://ntfy.sh', enabled: true })).toThrow(
      expect.objectContaining({ code: 'ntfy_unavailable' }),
    );
  });
  it('sends a test message and stores a safe failure without the topic', async () => {
    const { topic } = save();
    await service.test(user.id);
    expect(logger.errors).toHaveLength(0);
    expect(transport.calls[0]).toMatchObject({
      server: 'https://ntfy.sh',
      topic,
      click: 'https://pm.example/',
    });
    transport.outcome = { result: 'failed', failure: 'rate_limited' };
    time = new Date(time.getTime() + 6000);
    const failed = await service.test(user.id);
    expect(failed).toMatchObject({ lastResult: 'failed', lastFailure: 'rate_limited' });
    expect(logger.errors).toHaveLength(0);
  });
  it('limits tests to one per five seconds', async () => {
    save();
    await service.test(user.id);
    await expect(service.test(user.id)).rejects.toMatchObject({ code: 'web_push_test_too_soon' });
  });
  it('leaves out the link when the instance address is unknown', async () => {
    service.save(user.id, { server: 'https://ntfy.sh', enabled: true });
    await service.test(user.id);
    expect(transport.calls[0]).not.toHaveProperty('click');
  });

  describe('as the second channel of the web push decisions', () => {
    it('sends one generic message to a user without a browser device', async () => {
      save();
      const push = webPush();
      await Promise.all([push.onItem(item), push.onItem(item)]);
      expect(transport.calls).toHaveLength(1);
      const text = JSON.stringify(transport.calls[0]);
      for (const secret of ['Private', 'AR-1', 'AR/inbox']) expect(text).not.toContain(secret);
    });
    it('sends nothing while the channel is switched off or in quiet hours', async () => {
      save({ enabled: false });
      await webPush().onItem(item);
      save();
      const push = webPush();
      push.settings(user.id, {
        ...DEFAULT_PUSH_SETTINGS,
        quietHours: { ...DEFAULT_PUSH_SETTINGS.quietHours, enabled: true, start: '09:00', end: '11:00' },
      });
      await push.onItem({ ...item, id: 'two' });
      expect(transport.calls).toHaveLength(0);
    });
    it('sends the quiet items as one digest', async () => {
      save();
      const push = webPush();
      push.settings(user.id, {
        ...DEFAULT_PUSH_SETTINGS,
        quietHours: { ...DEFAULT_PUSH_SETTINGS.quietHours, enabled: true, start: '09:00', end: '11:00' },
      });
      repos.inbox.insert(item);
      await push.onItem(item);
      time = new Date('2026-10-20T11:01:00Z');
      await push.sweep();
      expect(transport.calls).toHaveLength(1);
      expect(transport.calls[0]!.priority).toBe('default');
    });
  });
});

describe('ntfy transport helpers', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.1',
    '192.168.1.1',
    '169.254.1.1',
    '100.64.0.1',
    '::1',
    'fd00::1',
    'fe80::1',
    '::ffff:10.0.0.1',
  ])('treats %s as a private address', (address) => expect(isPrivateAddress(address)).toBe(true));
  it.each(['8.8.8.8', '172.32.0.1', '2606:4700::1111'])('lets the public address %s through', (address) =>
    expect(isPrivateAddress(address)).toBe(false),
  );
  it.each([
    [200, undefined, { result: 'ok' }],
    [429, undefined, { result: 'failed', failure: 'rate_limited' }],
    [403, undefined, { result: 'failed', failure: 'rejected' }],
    [503, undefined, { result: 'failed', failure: 'service_error' }],
    [undefined, 'ETIMEDOUT', { result: 'failed', failure: 'timeout' }],
    [undefined, 'EACCES', { result: 'failed', failure: 'rejected' }],
    [undefined, 'ECONNRESET', { result: 'failed', failure: 'network' }],
  ] as const)('maps status %s and code %s', (status, code, outcome) =>
    expect(ntfyOutcomeOf(status, code)).toEqual(outcome),
  );
});
