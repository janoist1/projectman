import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CreatedIntegratorAccessKey,
  IntegratorAccessKeysResponse,
  IntegratorKeyAuditPage,
  routes,
} from '@projectman/shared';
import type { CreateIntegratorAccessKeyRequest } from '@projectman/shared';
import { integratorChannel } from '../src/auth';
import { addHumanAndLogin, createAppHarness, createProject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

describe('explicit integrator access key API', () => {
  let h: AppHarness;
  let cookie: string;
  let now: Date;
  beforeEach(async () => {
    now = new Date('2026-10-17T10:00:00.000Z');
    h = await createAppHarness({ now: () => now });
    cookie = await setupOwner(h.app);
  });
  afterEach(async () => h.close());
  const create = async (
    mode: 'super' | 'read' = 'super',
    expiresInDays?: CreateIntegratorAccessKeyRequest['expiresInDays'],
  ) => {
    const response = await h.app.inject({
      method: 'POST',
      url: routes.integratorKeys(),
      headers: { cookie },
      payload: { mode, ...(expiresInDays === undefined ? {} : { expiresInDays }) },
    });
    expect(response.statusCode, response.body).toBe(201);
    return CreatedIntegratorAccessKey.parse(response.json());
  };

  it.each(['super', 'read'] as const)(
    'isolates %s bearer keys from human cookies before the public switch',
    async (mode) => {
      await h.close();
      h = await createAppHarness({ now: () => now, real: { mcp: true } });
      cookie = await setupOwner(h.app);
      await createProject(h, cookie);
      const { secret } = await create(mode);
      const app = await h.relaunch({ integratorHostname: 'machine.example.com' });
      const authorization = `Bearer ${secret}`;
      const request = (host: string, url = '/api/projects', extra = {}) =>
        app.inject({ url, headers: { host, 'x-forwarded-proto': 'https', ...extra } });
      const board = await request('board.example.com', '/api/projects', {
        authorization,
        cookie,
        'x-forwarded-host': 'machine.example.com',
        'cf-access-client-id': 'forged',
        'x-projectman-client': 'cli',
      });
      expect(board.statusCode).toBe(403);
      expect(board.json().error.code).toBe('integrator_host_required');
      expect(board.headers['cache-control']).toBe('no-store');
      expect(
        (await request('MACHINE.EXAMPLE.COM.:443', '/api/projects', { authorization, cookie })).statusCode,
      ).toBe(200);
      expect((await request('machine.example.com', '/api/projects', { cookie })).statusCode).toBe(401);
      expect((await request('board.example.com', '/api/projects', { cookie })).statusCode).toBe(200);
      expect(
        (await request('machine.example.com', '/api/auth/integrator-keys', { authorization })).statusCode,
      ).toBe(403);
      expect(
        (await request('machine.example.com', '/api/%61uth/integrator-keys', { authorization })).statusCode,
      ).toBe(403);
      for (const url of [
        '/',
        '/ws',
        '/engine/link',
        '/feedback/widget.js',
        '/hooks/x',
        '/mcp/token',
        '/%61pi/projects',
        '/%6dcp',
        '/api/../ws',
      ])
        expect((await request('machine.example.com', url, { authorization, cookie })).statusCode, url).toBe(
          404,
        );
      for (const host of ['board.example.com', 'other.example.com'])
        expect((await request(host, '/mcp', { authorization, cookie })).statusCode).toBe(404);
      expect((await request('machine.example.com', '/mcp', { cookie })).statusCode).toBe(401);
      expect((await request('machine.example.com', '/mcp', { authorization })).statusCode).toBe(405);
      expect(
        (await request('board.example.com', routes.operatorSuperAudit('AR'), { cookie })).statusCode,
      ).toBe(200);
      const mcp = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          host: 'machine.example.com',
          'x-forwarded-proto': 'https',
          authorization,
          cookie,
          accept: 'application/json, text/event-stream',
        },
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      });
      expect(mcp.statusCode, mcp.body).toBe(200);
    },
  );

  it('creates expiring keys, lists newest first, and preserves the singular legacy API', async () => {
    const legacy = await h.app.inject({
      method: 'POST',
      url: routes.integratorKey(),
      headers: { cookie },
      payload: {},
    });
    const first = await create();
    expect(first.key).toMatchObject({
      mode: 'super',
      lastUsedChannel: null,
      expiresAt: '2026-10-24T10:00:00.000Z',
    });
    const read = await create('read', 1);
    const newest = await create('super', 30);
    const response = await h.app.inject({ url: routes.integratorKeys(), headers: { cookie } });
    const keys = IntegratorAccessKeysResponse.parse(response.json()).keys;
    expect(keys.map((key) => key.id)).toEqual([newest.key.id, read.key.id, first.key.id, keys[3]!.id]);
    expect(keys.map((key) => key.state)).toEqual(['active', 'active', 'revoked', 'active']);
    expect((await h.app.inject({ url: routes.integratorKey(), headers: { cookie } })).json()).toEqual({
      key: legacy.json().key,
    });
    const audit = await h.app.inject({ url: routes.integratorKeyAudit(), headers: { cookie } });
    expect(IntegratorKeyAuditPage.parse(audit.json()).entries).toHaveLength(5);
    for (const result of [response, audit]) {
      for (const secret of [first.secret, read.secret, newest.secret, legacy.json().secret]) {
        expect(result.body).not.toContain(secret);
      }
      expect(result.body).not.toMatch(/token_hash|password|owner_user_id|secret/);
    }
    for (const key of response.json().keys) {
      expect(Object.keys(key).sort()).toEqual(
        [
          'id',
          'mode',
          'prefix',
          'state',
          'createdAt',
          'expiresAt',
          'lastUsedAt',
          'lastUsedChannel',
          'revokedAt',
        ].sort(),
      );
    }
  });

  it.each([
    { days: 365, expiresAt: '2027-10-17T10:00:00.000Z' },
    { days: null, expiresAt: null },
  ] as const)('issues and persists keys with a $days-day lifetime', async ({ days, expiresAt }) => {
    const created = await create('super', days);
    expect(created.key).toMatchObject({ state: 'active', expiresAt });
    h.app = await h.relaunch({});
    const response = await h.app.inject({ url: routes.integratorKeys(), headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(IntegratorAccessKeysResponse.parse(response.json()).keys).toEqual([created.key]);
    const authenticated = await h.app.inject({
      url: '/api/projects',
      headers: { authorization: `Bearer ${created.secret}` },
    });
    expect(authenticated.statusCode).toBe(200);
  });

  it('revokes by id idempotently, returns 404 for unknown or foreign keys, and persists audit over restart', async () => {
    const created = await create();
    const revoke = (id: string) =>
      h.app.inject({ method: 'DELETE', url: routes.integratorAccessKey(id), headers: { cookie } });
    const first = await revoke(created.key.id);
    expect(first.statusCode).toBe(200);
    expect(first.json().key.state).toBe('revoked');
    now = new Date(now.getTime() + 1000);
    expect((await revoke(created.key.id)).json()).toEqual(first.json());
    expect((await revoke('unknown')).json().error.code).toBe('not_found');
    const auth = h.app.projectman.auth;
    const other = auth.preparePasswordlessUser({ name: 'Other', email: 'other@example.com' });
    h.app.projectman.repos.users.insert(other);
    const foreign = auth.createIntegratorAccessKey(other.id, { mode: 'read', expiresInDays: 1 });
    const refused = await revoke(foreign.key.id);
    expect(refused.statusCode).toBe(404);
    expect(refused.json().error.code).toBe('not_found');
    h.app = await h.relaunch({});
    const audit = await h.app.inject({ url: routes.integratorKeyAudit(), headers: { cookie } });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().entries.map((entry: { action: string }) => entry.action)).toEqual([
      'revoked',
      'created',
    ]);
    const rejected = await h.app.inject({
      url: routes.me(),
      headers: { authorization: `Bearer ${created.secret}`, cookie },
    });
    expect(rejected.statusCode).toBe(401);
  });

  it.each([
    {},
    { mode: 'legacy' },
    { mode: 'unknown' },
    { mode: 'read', expiresInDays: 'never' },
    { mode: 'super', expiresInDays: 90 },
    { mode: 'super', expiresInDays: 0 },
  ])('rejects invalid issuance parameters: %j', async (payload) => {
    const response = await h.app.inject({
      method: 'POST',
      url: routes.integratorKeys(),
      headers: { cookie },
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(h.app.projectman.repos.db.prepare('SELECT * FROM integrator_keys').all()).toEqual([]);
  });

  it('limits every key-management endpoint to the host owner login', async () => {
    await createProject(h, cookie);
    const other = await addHumanAndLogin(h.app, { handle: 'colleague', access: 'owner' });
    const created = await create();
    const endpoints = [
      { method: 'GET', url: routes.integratorKeys() },
      { method: 'POST', url: routes.integratorKeys(), payload: { mode: 'read' } },
      { method: 'DELETE', url: routes.integratorAccessKey(created.key.id) },
      { method: 'GET', url: routes.integratorKeyAudit() },
    ] as const;
    for (const endpoint of endpoints) {
      expect((await h.app.inject({ ...endpoint, headers: { cookie: other } })).statusCode).toBe(403);
      expect((await h.app.inject(endpoint)).statusCode).toBe(401);
    }
    for (const mode of ['legacy', 'super', 'read'] as const) {
      const secret =
        mode === 'legacy'
          ? (
              await h.app.inject({
                method: 'POST',
                url: routes.integratorKey(),
                headers: { cookie },
                payload: {},
              })
            ).json().secret
          : (await create(mode)).secret;
      for (const endpoint of [
        ...endpoints,
        { method: 'GET', url: routes.integratorKey() },
        { method: 'POST', url: routes.integratorKey(), payload: {} },
        { method: 'DELETE', url: routes.integratorKey() },
      ] as const) {
        const response = await h.app.inject({
          ...endpoint,
          headers: { cookie, authorization: `Bearer ${secret}` },
        });
        expect(response.statusCode, `${mode}: ${endpoint.url}`).toBe(403);
        expect(response.json().error.code).toBe('integrator_not_allowed');
      }
    }
  });

  it.each(['super', 'read'] as const)(
    'keeps own-login endpoints closed to %s credentials, regardless of cookie or CLI header',
    async (mode) => {
      const created = await create(mode);
      for (const method of ['GET', 'POST'] as const) {
        const response = await h.app.inject({
          method,
          url: method === 'GET' ? routes.me() : routes.logout(),
          headers: { cookie, authorization: `Bearer ${created.secret}`, 'x-projectman-client': 'cli' },
        });
        expect(response.statusCode).toBe(403);
        expect(response.json().error.code).toBe('integrator_not_allowed');
      }
      for (const bad of ['Bearer', 'Bearer malformed', 'Bearer pmi_unknown']) {
        const response = await h.app.inject({ url: routes.me(), headers: { cookie, authorization: bad } });
        expect(response.statusCode).toBe(401);
        expect(response.json().error.code).toBe('integrator_key_invalid');
      }
      now = new Date(now.getTime() + 7 * 86_400_000);
      expect(
        (
          await h.app.inject({
            url: routes.me(),
            headers: { cookie, authorization: `Bearer ${created.secret}` },
          })
        ).statusCode,
      ).toBe(401);
    },
  );

  it('requires HTTPS or a verified local connection before recording use', async () => {
    const created = await create();
    const userId = h.app.projectman.repos.users.list()[0]!.id;
    for (const headers of [{ host: 'remote.example' }, { host: 'localhost', 'x-forwarded-proto': 'https' }]) {
      const response = await h.app.inject({
        url: routes.me(),
        remoteAddress: '100.64.0.1',
        headers: { ...headers, cookie, authorization: `Bearer ${created.secret}` },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('integrator_https_required');
    }
    expect(h.app.projectman.auth.integratorAccessKeys(userId)[0]!.lastUsedAt).toBeNull();
    const https = await h.app.inject({
      url: routes.me(),
      remoteAddress: '127.0.0.1',
      headers: {
        host: 'remote.example',
        'x-forwarded-proto': 'https',
        authorization: `Bearer ${created.secret}`,
      },
    });
    expect(https.statusCode).toBe(403);
    expect(https.json().error.code).toBe('integrator_not_allowed');
    expect(h.app.projectman.auth.integratorAccessKeys(userId)[0]!.lastUsedChannel).toBe('rest');
  });

  it('classifies actual API and external MCP authentication without trusting the CLI header for access', async () => {
    const created = await create();
    const userId = h.app.projectman.repos.users.list()[0]!.id;
    for (const [url, header, channel] of [
      [routes.me(), 'cli', 'cli'],
      [routes.me(), 'CLI', 'rest'],
      [routes.me(), 'unknown', 'rest'],
      ['/mcp', 'cli', 'mcp'],
      ['/mcp?probe=1', 'cli', 'mcp'],
    ] as const) {
      now = new Date(now.getTime() + 1);
      const response = await h.app.inject({
        url,
        headers: { authorization: `Bearer ${created.secret}`, 'x-projectman-client': header },
      });
      // The auth hook no longer refuses `/mcp` by mode (PM-760); the harness's fake MCP module serves no route.
      expect(response.statusCode, url).toBe(url.startsWith('/mcp') ? 404 : 403);
      expect(h.app.projectman.auth.integratorAccessKeys(userId)[0]!.lastUsedChannel).toBe(channel);
    }
  });

  it('validates audit cursors and limits and pages through equal timestamps', async () => {
    await create();
    await create();
    const get = (query: string) =>
      h.app.inject({ url: `${routes.integratorKeyAudit()}${query}`, headers: { cookie } });
    const first = (await get('?limit=1')).json();
    expect(first.entries.map((entry: { seq: number }) => entry.seq)).toEqual([3]);
    expect(first.nextBefore).toBe(3);
    expect((await get('?before=3&limit=2')).json()).toMatchObject({
      entries: [{ seq: 2 }, { seq: 1 }],
      nextBefore: null,
    });
    for (const query of [
      '?limit=0',
      '?limit=101',
      '?limit=x',
      '?limit=1.5',
      '?before=0',
      '?before=x',
      '?before=1.5',
      '?before=9007199254740992',
    ]) {
      expect((await get(query)).statusCode, query).toBe(400);
    }
  });
});

describe('integrator usage channel classification', () => {
  it.each([
    ['/mcp', 'cli', 'mcp'],
    ['/mcp?cursor=1', 'cli', 'mcp'],
    ['/mcp/session-token', 'cli', 'rest'],
    ['/mcp/events', 'cli', 'rest'],
    ['/api/projects/AR/events', 'cli', 'cli'],
    ['/api/me', 'CLI', 'rest'],
    ['/api/me', ['cli', 'cli'], 'rest'],
    ['/api/me', undefined, 'rest'],
  ])('classifies %s with header %j as %s', (url, header, expected) => {
    expect(integratorChannel({ url, headers: { 'x-projectman-client': header } })).toBe(expected);
  });
});
