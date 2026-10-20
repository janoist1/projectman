import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CreatedIntegratorAccessKey,
  OperatorGrantAuditPage,
  OperatorGrantResponse,
  routes,
} from '@projectman/shared';
import type { ServerEvent } from '@projectman/shared';
import { addHumanAndLogin, createAppHarness, createProject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

describe('the Operator’s grant for machine operations API (PM-881)', () => {
  let h: AppHarness;
  let cookie: string;
  let now: Date;
  let events: ServerEvent[];
  beforeEach(async () => {
    // Early in the day: accounts the test adds later carry the real clock and must come after the owner.
    now = new Date('2026-10-20T00:00:00.000Z');
    h = await createAppHarness({ now: () => now });
    cookie = await setupOwner(h.app);
    events = [];
    h.app.projectman.domain.bus.subscribe((event) => events.push(event));
  });
  afterEach(async () => h.close());

  const call = (method: 'GET' | 'POST' | 'DELETE', headers: Record<string, string>, payload?: unknown) =>
    h.app.inject({ method, url: routes.operatorGrant(), headers, ...(payload ? { payload } : {}) });
  const state = (response: { json(): unknown }) => OperatorGrantResponse.parse(response.json()).grant;
  const keyHeaders = async (mode: 'super' | 'read') => {
    const created = await h.app.inject({
      method: 'POST',
      url: routes.integratorKeys(),
      headers: { cookie },
      payload: { mode },
    });
    expect(created.statusCode, created.body).toBe(201);
    return { authorization: `Bearer ${CreatedIntegratorAccessKey.parse(created.json()).secret}` };
  };

  it('starts without a grant', async () => {
    expect(state(await call('GET', { cookie }))).toMatchObject({
      active: false,
      grantId: null,
      expiresAt: null,
      canManage: true,
    });
  });

  it.each([
    ['until_revoked', null],
    ['12h', '2026-10-20T12:00:00.000Z'],
    ['7d', '2026-10-27T00:00:00.000Z'],
  ] as const)('lets the host owner grant it for %s', async (duration, expiresAt) => {
    const response = await call('POST', { cookie }, { duration });
    expect(response.statusCode).toBe(201);
    expect(state(response)).toMatchObject({
      active: true,
      grantedAt: now.toISOString(),
      grantedBy: 'Owner',
      expiresAt,
      lastUsedAt: null,
    });
    expect(events).toContainEqual({ type: 'operator_grant_changed' });
  });

  it('extends by replacing the active grant, revokes it, and shows all four kinds in the audit', async () => {
    now = new Date('2026-10-20T10:00:00.000Z');
    const first = state(await call('POST', { cookie }, { duration: '12h' }));
    now = new Date('2026-10-20T11:00:00.000Z');
    const second = state(await call('POST', { cookie }, { duration: '7d' }));
    expect(second.grantId).not.toBe(first.grantId);
    now = new Date('2026-10-20T12:00:00.000Z');
    const revoked = await call('DELETE', { cookie });
    expect(state(revoked)).toMatchObject({ active: false, grantId: null });
    expect((await call('DELETE', { cookie })).statusCode).toBe(404);
    now = new Date('2026-10-20T13:00:00.000Z');
    const third = state(await call('POST', { cookie }, { duration: '12h' }));
    now = new Date('2026-10-21T02:00:00.000Z');
    expect(state(await call('GET', { cookie })).active).toBe(false);

    const audit = await h.app.inject({ url: routes.operatorGrantAudit(), headers: { cookie } });
    const entry = (grant: typeof first, action: string, at: string) => ({
      grantId: grant.grantId,
      action,
      at,
      expiresAt: grant.expiresAt,
      by: 'Owner',
    });
    expect(OperatorGrantAuditPage.parse(audit.json()).entries).toEqual([
      entry(third, 'expired', '2026-10-21T01:00:00.000Z'),
      entry(third, 'granted', '2026-10-20T13:00:00.000Z'),
      entry(second, 'revoked', '2026-10-20T12:00:00.000Z'),
      entry(second, 'granted', '2026-10-20T11:00:00.000Z'),
      entry(first, 'replaced', '2026-10-20T11:00:00.000Z'),
      entry(first, 'granted', '2026-10-20T10:00:00.000Z'),
    ]);
  });

  it('refuses a key, a colleague and an anonymous caller to change it, but lets any login or key read it', async () => {
    await createProject(h, cookie);
    const superKey = await keyHeaders('super');
    const readKey = await keyHeaders('read');
    const checkRefusedButReadable = async (headers: Record<string, string>) => {
      for (const method of ['POST', 'DELETE'] as const) {
        const response = await call(method, headers);
        expect(response.statusCode).toBe(403);
        expect(response.json().error.code).toBe('operator_grant_owner_only');
      }
      const audit = await h.app.inject({ url: routes.operatorGrantAudit(), headers });
      expect(audit.json().error.code).toBe('operator_grant_owner_only');
      expect(state(await call('GET', headers))).toMatchObject({ active: false, canManage: false });
    };
    // The keys first: a colleague account created later would be the first user in this test's fake clock.
    for (const headers of [superKey, readKey, { ...superKey, cookie }])
      await checkRefusedButReadable(headers);
    await checkRefusedButReadable({ cookie: await addHumanAndLogin(h.app, { handle: 'colleague' }) });
    expect((await call('POST', {})).statusCode).toBe(401);
  });
});
