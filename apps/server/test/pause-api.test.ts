import { afterEach, describe, expect, it } from 'vitest';
import { InstancePauseView, ProjectPauseView, routes } from '@projectman/shared';
import type { HumanAccess } from '@projectman/shared';
import { createAppHarness, createProject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

describe('pause routes', () => {
  let h: AppHarness;
  let cookie: string;
  afterEach(async () => h?.close());

  async function setup() {
    h = await createAppHarness();
    cookie = await setupOwner(h.app);
    await createProject(h, cookie);
  }

  /** The test account's cookie then belongs to a fictional member with that access (the owner stays itself). */
  async function actAs(access: HumanAccess) {
    const handle = `fictional-${access}`;
    await h.app.projectman.domain.projects.update(
      'AR',
      {
        actor: { kind: 'human', handle: 'owner' },
        author: { name: 'Owner', email: 'owner@example.com' },
      },
      (config) => {
        config.team.members.push({
          kind: 'human',
          handle,
          displayName: `Fictional ${access}`,
          email: `${handle}@example.com`,
          access,
          roles: [],
        });
        return `Add fictional ${access}`;
      },
    );
    const user = h.app.projectman.repos.users.findByEmail('owner@example.com')!;
    h.app.projectman.repos.db
      .prepare('UPDATE users SET email = ? WHERE id = ?')
      .run(`${handle}@example.com`, user.id);
  }

  const call = (method: 'GET' | 'POST', url: string, payload?: object) =>
    h.app.inject({ method, url, headers: { cookie }, payload });

  it('pauses and resumes a project and shows it in the board', async () => {
    await setup();
    const empty = await call('GET', routes.projectPause('AR'));
    expect(ProjectPauseView.parse(empty.json())).toEqual({ project: null, instance: null });
    const paused = await call('POST', routes.projectPause('AR'), {
      reason: 'Fictional freeze',
      forceAfterMs: 1000,
    });
    expect(paused.statusCode).toBe(200);
    expect(ProjectPauseView.parse(paused.json()).project).toMatchObject({
      scope: 'project',
      projectKey: 'AR',
      kind: 'manual',
      source: 'app',
      reason: 'Fictional freeze',
      state: 'paused',
    });
    const board = await call('GET', routes.board('AR'));
    expect(board.json().pause.project).toMatchObject({ reason: 'Fictional freeze' });
    const forced = await call('POST', routes.projectPauseForce('AR'));
    expect(forced.statusCode).toBe(200);
    const resumed = await call('POST', routes.projectPauseResume('AR'));
    expect(ProjectPauseView.parse(resumed.json())).toEqual({ project: null, instance: null });
    expect((await call('GET', routes.board('AR'))).json().pause).toEqual({ project: null, instance: null });
  });

  it('refuses an invalid body and a visitor without a login', async () => {
    await setup();
    const invalid = await call('POST', routes.projectPause('AR'), { forceAfterMs: -1 });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { code: 'invalid_request' } });
    const anonymous = await h.app.inject({ method: 'POST', url: routes.projectPause('AR') });
    expect(anonymous.statusCode).toBe(401);
  });

  it.each(['developer', 'viewer'] as const)('lets %s look at the pause but not change it', async (access) => {
    await setup();
    await call('POST', routes.projectPause('AR'));
    await actAs(access);
    expect((await call('GET', routes.projectPause('AR'))).statusCode).toBe(200);
    for (const url of [
      routes.projectPause('AR'),
      routes.projectPauseResume('AR'),
      routes.projectPauseForce('AR'),
    ]) {
      const refused = await call('POST', url);
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({ error: { code: 'insufficient_access' } });
    }
    expect(h.app.projectman.domain.pauses.isPaused('AR')).toBe(true);
  });

  it('lets an admin pause the project', async () => {
    await setup();
    await actAs('admin');
    expect((await call('POST', routes.projectPause('AR'))).statusCode).toBe(200);
    expect((await call('POST', routes.projectPauseResume('AR'))).statusCode).toBe(200);
  });

  it('keeps a client out of the pause and out of the board field', async () => {
    await setup();
    await call('POST', routes.projectPause('AR'));
    await actAs('client');
    expect((await call('GET', routes.projectPause('AR'))).statusCode).toBe(403);
    expect((await call('POST', routes.projectPause('AR'))).statusCode).toBe(403);
    expect((await call('GET', routes.board('AR'))).json()).not.toHaveProperty('pause');
    expect((await call('GET', routes.instancePause())).statusCode).toBe(403);
  });

  it('lets an owner of every project pause the instance, and shows both pauses in the board', async () => {
    await setup();
    const paused = await call('POST', routes.instancePause(), { reason: 'Fictional maintenance' });
    expect(paused.statusCode).toBe(200);
    expect(InstancePauseView.parse(paused.json())).toMatchObject({
      canManage: true,
      pause: { scope: 'instance', projectKey: null, reason: 'Fictional maintenance' },
    });
    const board = await call('GET', routes.board('AR'));
    expect(board.json().pause.instance).toMatchObject({ scope: 'instance' });
    // The project's own pause is independent: resuming the instance leaves it.
    await call('POST', routes.projectPause('AR'));
    const resumed = await call('POST', routes.instancePauseResume());
    expect(InstancePauseView.parse(resumed.json()).pause).toBeNull();
    expect(h.app.projectman.domain.pauses.isPaused('AR')).toBe(true);
    expect((await call('POST', routes.instancePauseForce())).statusCode).toBe(200);
  });

  it('shows the instance pause to an admin who may not change it', async () => {
    await setup();
    await call('POST', routes.instancePause());
    await actAs('admin');
    const view = await call('GET', routes.instancePause());
    expect(InstancePauseView.parse(view.json())).toMatchObject({
      canManage: false,
      pause: { scope: 'instance' },
    });
    for (const url of [routes.instancePause(), routes.instancePauseResume(), routes.instancePauseForce()]) {
      const refused = await call('POST', url);
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({ error: { code: 'insufficient_access' } });
    }
    expect(h.app.projectman.domain.pauses.isPaused('AR')).toBe(true);
  });
});
