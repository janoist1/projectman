import { afterEach, describe, expect, it } from 'vitest';
import { InstancePauseView, ProjectPauseView, routes } from '@projectman/shared';
import type { HumanAccess } from '@projectman/shared';
import {
  addHumanAndLogin,
  createAppHarness,
  createForeignProject,
  createProject,
  setupOwner,
} from './helpers/app-harness';
import type { AppHarness, AppHarnessOptions } from './helpers/app-harness';

describe('pause routes', () => {
  let h: AppHarness;
  let cookie: string;
  afterEach(async () => h?.close());

  async function setup(app?: AppHarnessOptions['app']) {
    h = await createAppHarness(app ? { app } : undefined);
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

  it('lets a client look at the pause like any member, but not change it', async () => {
    await setup();
    await call('POST', routes.projectPause('AR'));
    await actAs('client');
    expect((await call('GET', routes.projectPause('AR'))).statusCode).toBe(200);
    expect((await call('POST', routes.projectPause('AR'))).statusCode).toBe(403);
    expect((await call('GET', routes.board('AR'))).json()).toHaveProperty('pause');
    expect((await call('GET', routes.instancePause())).statusCode).toBe(200);
  });

  it('lets the host owner pause the instance, and shows both pauses in the board', async () => {
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

  it('pauses the instance for the stop of the server, and not when the shutdown pause is set to 0', async () => {
    await setup({ shutdownPauseMs: 1000 });
    await h.app.projectman.pauseForShutdown();
    expect(h.app.projectman.repos.pauses.open()).toMatchObject([{ scope: 'instance', kind: 'shutdown' }]);
    await h.close();

    await setup({ shutdownPauseMs: 0 });
    await h.app.projectman.pauseForShutdown();
    expect(h.app.projectman.repos.pauses.open()).toEqual([]);
    expect(h.app.projectman.domain.pauses.isPaused('AR')).toBe(false);
  });

  const instanceUrls = [routes.instancePause(), routes.instancePauseResume(), routes.instancePauseForce()];

  /** A second account (not an e-mail swap: the first account stays the host owner) with this access in AR. */
  const secondAccount = (access: HumanAccess) =>
    addHumanAndLogin(h.app, { handle: `fictional-${access}`, access });
  const callAs = (as: string, method: 'GET' | 'POST', url: string) =>
    h.app.inject({ method, url, headers: { cookie: as } });

  it.each(['admin', 'owner'] as const)(
    'shows the instance pause to a %s who is not the host owner and may not change it',
    async (access) => {
      await setup();
      await call('POST', routes.instancePause());
      const other = await secondAccount(access);
      const view = await callAs(other, 'GET', routes.instancePause());
      expect(InstancePauseView.parse(view.json())).toMatchObject({
        canManage: false,
        pause: { scope: 'instance' },
      });
      for (const url of instanceUrls) {
        const refused = await callAs(other, 'POST', url);
        expect(refused.statusCode).toBe(403);
        expect(refused.json()).toMatchObject({ error: { code: 'insufficient_access' } });
      }
      expect(h.app.projectman.domain.pauses.isPaused('AR')).toBe(true);
    },
  );

  it('lets the host owner pause the instance, reaching the project of another owner too', async () => {
    await setup();
    await createForeignProject(h, cookie, 'AA');
    expect(h.app.projectman.domain.pauses.isPaused('AA')).toBe(false);
    const paused = await call('POST', routes.instancePause());
    expect(paused.statusCode).toBe(200);
    expect(InstancePauseView.parse(paused.json()).canManage).toBe(true);
    expect(h.app.projectman.domain.pauses.isPaused('AA')).toBe(true);
    expect((await call('POST', routes.instancePauseResume())).statusCode).toBe(200);
    expect((await call('POST', routes.instancePauseForce())).statusCode).toBe(200);
  });

  it('keeps the instance with the host owner who has no project, and refuses a stranger without one', async () => {
    await setup();
    await h.app.projectman.domain.projects.update(
      'AR',
      { actor: { kind: 'human', handle: 'owner' }, author: { name: 'Owner', email: 'owner@example.com' } },
      (config) => {
        for (const member of config.team.members)
          if (member.kind === 'human' && member.email === 'owner@example.com')
            member.email = 'stranger@example.test';
        return 'Hand the project to another owner';
      },
    );
    expect(InstancePauseView.parse((await call('GET', routes.instancePause())).json()).canManage).toBe(true);
    expect((await call('POST', routes.instancePause())).statusCode).toBe(200);
    const outsider = await addHumanAndLogin(h.app, { handle: 'fictional-outsider', projectKey: null });
    const refused = await callAs(outsider, 'GET', routes.instancePause());
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: { code: 'insufficient_access' } });
  });
});
