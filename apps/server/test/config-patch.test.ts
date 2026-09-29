import { hash } from '@node-rs/argon2';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConfigView, HumanAccess, ServerEvent } from '@projectman/shared';
import { cookieOf, createAppHarness, createProject, OWNER_LOGIN, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

describe('configuration PATCH', () => {
  let h: AppHarness;
  let cookie: string;
  beforeEach(async () => {
    h = await createAppHarness();
    cookie = await setupOwner(h.app);
    await createProject(h, cookie);
  });
  afterEach(async () => h.close());

  async function view(): Promise<ConfigView> {
    return (
      await h.app.inject({ method: 'GET', url: '/api/projects/AR/config', headers: { cookie } })
    ).json();
  }
  function patch(payload: object, session = cookie) {
    return h.app.inject({
      method: 'PATCH',
      url: '/api/projects/AR/config',
      headers: { cookie: session },
      payload,
    });
  }
  async function memberLogin(access: HumanAccess) {
    h.app.projectman.repos.users.insert({
      id: 'kata',
      name: 'Kata',
      email: 'kata@example.com',
      passwordHash: await hash('test password'),
      createdAt: new Date().toISOString(),
    });
    await h.app.projectman.domain.projects.update(
      'AR',
      { actor: { kind: 'human', handle: 'owner' }, author: OWNER_LOGIN },
      (draft) => {
        draft.team.members.push({
          kind: 'human',
          handle: 'kata',
          displayName: 'Kata',
          access,
          roles: [],
          email: 'kata@example.com',
        });
        return 'Add Kata';
      },
    );
    return cookieOf(
      await h.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'kata@example.com', password: 'test password' },
      }),
    );
  }

  it('commits one attributed version, preserves fixed fields and broadcasts', async () => {
    const current = await view();
    const events: ServerEvent[] = [];
    h.app.projectman.domain.bus.subscribe((event) => events.push(event));
    const response = await patch({
      baseVersion: current.version,
      message: 'Rename Acme webshop',
      project: { name: 'Acme webshop', language: 'en', timezone: 'Europe/Budapest' },
      limits: { maxConcurrentAi: 2 },
    });
    expect(response.statusCode).toBe(200);
    const next = response.json<ConfigView>();
    expect(next.config.project).toEqual({
      ...current.config.project,
      name: 'Acme webshop',
      language: 'en',
      timezone: 'Europe/Budapest',
    });
    expect(next.config.team.limits).toEqual({ ...current.config.team.limits, maxConcurrentAi: 2 });
    expect(next.history).toHaveLength(current.history.length + 1);
    expect(next.history[0]).toMatchObject({
      author: OWNER_LOGIN.name,
      message: 'Rename Acme webshop',
      version: next.version,
    });
    expect(events).toContainEqual({ type: 'config_changed', projectKey: 'AR', version: next.version });
    expect((await h.app.projectman.configStore.load('AR')).version).toBe(next.version);
  });

  it('preserves stage descriptions in the customization repository', async () => {
    const current = await view();
    const pipeline = structuredClone(current.config.pipeline);
    Object.assign(pipeline.stages[1]!, { name: 'Build Acme', description: 'Implement the webshop.' });
    const response = await patch({ baseVersion: current.version, pipeline });
    expect(response.statusCode).toBe(200);
    expect(response.json<ConfigView>().history[0]?.message).toBe('Update pipeline');
    expect((await h.app.projectman.configStore.load('AR')).config.pipeline.stages[1]).toMatchObject({
      description: 'Implement the webshop.',
    });
    // A later unrelated edit must also retain descriptions.
    const next = response.json<ConfigView>();
    await patch({ baseVersion: next.version, limits: { maxConcurrentAi: 1 } });
    expect((await view()).config.pipeline.stages[1]).toMatchObject({ description: 'Implement the webshop.' });
  });

  it('preserves omitted settings instead of reapplying schema defaults', async () => {
    const current = await view();
    const first = await patch({
      baseVersion: current.version,
      project: { language: 'en', timezone: 'Europe/Budapest' },
      limits: {
        maxConcurrentAi: 5,
        pauseAbovePlanUsagePercent: 60,
        tempWorkers: { enabled: true, max: 4, role: 'qa' },
      },
    });
    const before = first.json<ConfigView>();
    const second = await patch({
      baseVersion: before.version,
      project: { name: 'Acme webshop' },
      limits: { tempWorkers: { max: 2 } },
    });
    expect(second.statusCode).toBe(200);
    const after = second.json<ConfigView>();
    expect(after.config.project).toEqual({ ...before.config.project, name: 'Acme webshop' });
    expect(after.config.team.limits).toEqual({
      ...before.config.team.limits,
      tempWorkers: { ...before.config.team.limits.tempWorkers, max: 2 },
    });
  });

  it('rejects a stale version without writing history', async () => {
    const current = await view();
    const response = await patch({ baseVersion: 'outdated', project: { name: 'Stale edit' } });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('config_conflict');
    expect(await view()).toEqual(current);
  });

  it.each([
    { limits: { maxConcurrentAi: 0 } },
    { project: { key: 'OTHER' } },
    { project: { workspacePath: '/tmp/other' } },
    { project: { name: '' } },
    { pipeline: { stages: [] } },
  ])('rejects schema issues with config_invalid: %j', async (change) => {
    const current = await view();
    const response = await patch({ baseVersion: current.version, ...change });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({
      code: 'config_invalid',
      details: { issues: expect.any(Array) },
    });
    expect(response.json().error.details.issues.length).toBeGreaterThan(0);
    expect(await view()).toEqual(current);
  });

  it('reports invariant issues and writes no commit', async () => {
    const current = await view();
    current.config.pipeline.stages[1]!.owners = ['missing'];
    const response = await patch({ baseVersion: current.version, pipeline: current.config.pipeline });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({
      code: 'config_invalid',
      details: { issues: [{ code: 'unknown_member', path: 'pipeline.stages[1].owners', detail: 'missing' }] },
    });
    expect((await view()).history).toEqual(current.history);
  });

  it('lets admins edit limits but protects approvals on every stage and gate removal', async () => {
    const adminCookie = await memberLogin('admin');
    let current = await view();
    expect(
      (await patch({ baseVersion: current.version, limits: { maxConcurrentAi: 2 } }, adminCookie)).statusCode,
    ).toBe(200);
    current = await view();
    for (const stageId of ['merge', 'release']) {
      for (const operation of ['change', 'remove', 'removeStage']) {
        const pipeline = structuredClone(current.config.pipeline);
        const stage = pipeline.stages.find((stage) => stage.id === stageId)!;
        if (operation === 'change')
          stage.gate!.conditions.forEach((condition) => {
            if (condition.type === 'human_approval') condition.approvers = ['kata'];
          });
        if (operation === 'remove')
          stage.gate!.conditions = stage.gate!.conditions.filter(
            (condition) => condition.type !== 'human_approval',
          );
        if (operation === 'removeStage')
          pipeline.stages = pipeline.stages.filter((stage) => stage.id !== stageId);
        const response = await patch({ baseVersion: current.version, pipeline }, adminCookie);
        expect(response.statusCode).toBe(403);
        expect(response.json().error.code).toBe('owner_only');
      }
    }
    expect(await view()).toEqual(current);
    const legacy = structuredClone(current.config);
    legacy.pipeline.stages.find((stage) => stage.id === 'merge')!.gate = {
      conditions: [{ type: 'human_approval', approvers: ['kata'] }],
    };
    const legacyResponse = await h.app.inject({
      method: 'PUT',
      url: '/api/projects/AR/config',
      headers: { cookie: adminCookie },
      payload: legacy,
    });
    expect(legacyResponse.statusCode).toBe(403);
    expect(legacyResponse.json().error.code).toBe('owner_only');
    // An owner can delegate approval to another human.
    const pipeline = structuredClone(current.config.pipeline);
    pipeline.stages.find((stage) => stage.id === 'release')!.gate!.conditions = [
      { type: 'human_approval', approvers: ['kata'] },
    ];
    expect((await patch({ baseVersion: current.version, pipeline })).statusCode).toBe(200);
  });

  it.each(['developer', 'client', 'viewer'] as const)('denies writes to %s access', async (access) => {
    const session = await memberLogin(access);
    const current = await view();
    const response = await patch({ baseVersion: current.version, limits: { maxConcurrentAi: 2 } }, session);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('insufficient_access');
    expect(await view()).toEqual(current);
  });

  it('serializes simultaneous saves against the same version', async () => {
    const current = await view();
    const responses = await Promise.all([
      patch({ baseVersion: current.version, project: { name: 'Acme one' } }),
      patch({ baseVersion: current.version, project: { name: 'Acme two' } }),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect((await view()).history).toHaveLength(current.history.length + 1);
  });
});
