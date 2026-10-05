import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProvidersView } from '@projectman/shared';
import type { AgentProvider } from '@projectman/shared';
import { addHumanAndLogin, createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

describe('provider API', () => {
  let h: AppHarness;
  beforeEach(async () => {
    h = await createAppHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('requires login and returns every runner status to a viewer', async () => {
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
    const viewer = await addHumanAndLogin(h.app, { handle: 'viewer', name: 'Acme viewer', access: 'viewer' });
    const response = await h.app.inject({
      method: 'GET',
      url: '/api/providers',
      headers: { cookie: viewer },
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
      { provider: 'gemini', loggedIn: false, method: 'none', checkedAt: '2026-01-01T00:00:00.000Z' },
      { provider: 'nanogpt', loggedIn: false, method: 'none', checkedAt: '2026-01-01T00:00:00.000Z' },
    ]);
    expect(providerStatus.mock.calls.map(([provider]) => provider)).toEqual([
      'claude',
      'codex',
      'gemini',
      'nanogpt',
    ]);
  });

  it('reports unknown when a runner has no login checks', async () => {
    const cookie = await setupOwner(h.app);
    const response = await h.app.inject({ method: 'GET', url: '/api/providers', headers: { cookie } });
    expect(ProvidersView.parse(response.json()).providers).toEqual([
      expect.objectContaining({ provider: 'claude', loggedIn: null }),
      expect.objectContaining({ provider: 'codex', loggedIn: null }),
      expect.objectContaining({ provider: 'gemini', loggedIn: null }),
      expect.objectContaining({ provider: 'nanogpt', loggedIn: null }),
    ]);
  });

  it('clears Claude effort with a null PATCH and persists the default', async () => {
    const cookie = await setupOwner(h.app);
    await createProject(h, cookie);
    const patch = (payload: object) =>
      h.app.inject({ method: 'PATCH', url: '/api/projects/AR/members/dev-1', headers: { cookie }, payload });
    expect((await patch({ effort: 'max' })).json()).toMatchObject({ effort: 'max' });
    const cleared = await patch({ effort: null });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).not.toHaveProperty('effort');
    const config = await h.app.projectman.domain.projects.config('AR');
    expect(config.team.members.find((member) => member.handle === 'dev-1')).not.toHaveProperty('effort');
  });

  it('validates and persists hire and update provider settings', async () => {
    const cookie = await setupOwner(h.app);
    await createProject(h, cookie);
    const call = (method: 'POST' | 'PATCH', url: string, payload: object) =>
      inject(h.app, method, url, cookie, payload);
    expect(
      (await call('PATCH', '/api/projects/AR/members/dev-1', { effort: 'unsupported' })).statusCode,
    ).toBe(400);
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
