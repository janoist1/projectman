import { hash } from '@node-rs/argon2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProvidersView } from '@projectman/shared';
import type { AgentProvider } from '@projectman/shared';
import { cookieOf, createAppHarness, createProject, OWNER_LOGIN, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

describe('provider API', () => {
  let h: AppHarness;
  beforeEach(async () => {
    h = await createAppHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('requires login and returns both runner statuses to a viewer', async () => {
    const providerStatus = vi.fn(async (provider: AgentProvider) => ({
      provider,
      loggedIn: provider === 'claude',
      method: provider === 'claude' ? 'claude.ai' : 'none',
      checkedAt: '2026-01-01T00:00:00.000Z',
      ...(provider === 'codex' ? { detail: 'Not logged in' } : {}),
    }));
    Object.assign(h.runner, { providerStatus });
    expect((await h.app.inject({ method: 'GET', url: '/api/providers' })).statusCode).toBe(401);
    expect(providerStatus).not.toHaveBeenCalled();
    const owner = await setupOwner(h.app);
    await createProject(h, owner);
    const { repos, domain } = h.app.projectman;
    repos.users.insert({
      id: 'usr_viewer',
      name: 'Acme viewer',
      email: 'viewer@example.com',
      passwordHash: await hash('viewer password'),
      createdAt: new Date().toISOString(),
    });
    await domain.projects.update(
      'AR',
      { actor: { kind: 'human', handle: 'owner' }, author: OWNER_LOGIN },
      (draft) => {
        draft.team.members.push({
          kind: 'human',
          handle: 'viewer',
          displayName: 'Acme viewer',
          email: 'viewer@example.com',
          access: 'viewer',
          roles: [],
        });
        return 'Add fictional viewer';
      },
    );
    const login = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'viewer@example.com', password: 'viewer password' },
    });
    const response = await h.app.inject({
      method: 'GET',
      url: '/api/providers',
      headers: { cookie: cookieOf(login) },
    });
    expect(response.statusCode).toBe(200);
    expect(ProvidersView.parse(response.json()).providers).toEqual([
      { provider: 'claude', loggedIn: true, method: 'claude.ai', checkedAt: '2026-01-01T00:00:00.000Z' },
      {
        provider: 'codex',
        loggedIn: false,
        method: 'none',
        checkedAt: '2026-01-01T00:00:00.000Z',
        detail: 'Not logged in',
      },
    ]);
    expect(providerStatus.mock.calls.map(([provider]) => provider)).toEqual(['claude', 'codex']);
  });

  it('reports unknown when a runner has no login checks', async () => {
    const cookie = await setupOwner(h.app);
    const response = await h.app.inject({ method: 'GET', url: '/api/providers', headers: { cookie } });
    expect(ProvidersView.parse(response.json()).providers).toEqual([
      expect.objectContaining({ provider: 'claude', loggedIn: null }),
      expect.objectContaining({ provider: 'codex', loggedIn: null }),
    ]);
  });

  it('validates and persists hire and update provider settings', async () => {
    const cookie = await setupOwner(h.app);
    await createProject(h, cookie);
    const call = (method: 'POST' | 'PATCH', url: string, payload: object) =>
      h.app.inject({ method, url, headers: { cookie }, payload });
    expect((await call('PATCH', '/api/projects/AR/members/dev-1', { effort: 'max' })).statusCode).toBe(400);
    expect((await call('PATCH', '/api/projects/AR/members/dev-1', { provider: 'other' })).statusCode).toBe(
      400,
    );
    const hired = await call('POST', '/api/projects/AR/members', {
      role: 'qa',
      handle: 'acme-codex',
      provider: 'codex',
      effort: 'low',
    });
    expect(hired.statusCode).toBe(201);
    const updated = await call('PATCH', '/api/projects/AR/members/dev-1', {
      provider: 'codex',
      effort: 'high',
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' });
    const config = await h.app.projectman.domain.projects.config('AR');
    expect(config.team.members.find((member) => member.handle === 'acme-codex')).toMatchObject({
      provider: 'codex',
      model: 'gpt-6.1-sol',
      effort: 'low',
    });
  });
});
