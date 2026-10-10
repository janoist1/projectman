import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { routes } from '@projectman/shared';
import { sharedClaudeTmpRoots } from '../src/engine-host';
import { addHumanAndLogin, createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

describe('member merge API', () => {
  let h: AppHarness;
  let cookie: string;
  beforeEach(async () => {
    h = await createAppHarness({ app: { claudeTmpRoots: sharedClaudeTmpRoots({ uid: 'test' }) } });
    cookie = await setupOwner(h.app);
    await createProject(h, cookie);
    await inject(h.app, 'POST', routes.tasks('AR'), cookie, { title: 'A card' });
  });
  afterEach(async () => {
    await h.close();
  });
  it('refuses a caller who is not the merger and refuses read-only members', async () => {
    const response = await inject(h.app, 'POST', routes.taskMerge('AR', 'AR-1'), cookie);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'merge_not_merger' } });
    const viewer = await addHumanAndLogin(h.app, { handle: 'reader', access: 'viewer' });
    expect((await inject(h.app, 'POST', routes.taskMerge('AR', 'AR-1'), viewer)).statusCode).toBe(403);
  });
  it('returns 409 when the named merger is not ready', async () => {
    const loaded = await h.app.projectman.domain.projects.load('AR');
    await h.app.projectman.domain.projects.patch(
      'AR',
      { baseVersion: loaded.version, merger: { kind: 'member', handle: 'owner' } },
      { actor: { kind: 'human', handle: 'owner' }, author: { name: 'Owner', email: 'owner@test.invalid' } },
    );
    const response = await inject(h.app, 'POST', routes.taskMerge('AR', 'AR-1'), cookie);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'merge_not_ready' } });
  });
  it('allows configuration editors to set and clear merge policy and rejects unknown repos', async () => {
    const patch = async (repo: string, requireMerge: boolean | null, as = cookie) => {
      const loaded = await h.app.projectman.domain.projects.load('AR');
      return inject(h.app, 'PATCH', routes.patchConfig('AR'), as, {
        baseVersion: loaded.version,
        repoMerge: [{ repo, requireMerge }],
      });
    };
    const unknown = await patch('missing', true);
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({
      error: { code: 'unknown_repo' },
    });
    const admin = await addHumanAndLogin(h.app, { handle: 'admin', access: 'admin' });
    expect((await patch('web', true, admin)).statusCode).toBe(200);
    expect((await patch('web', true)).statusCode).toBe(200);
    expect((await h.app.projectman.domain.projects.config('AR')).project.repos[0]!.requireMerge).toBe(true);
    expect((await patch('web', null)).statusCode).toBe(200);
    expect((await h.app.projectman.domain.projects.config('AR')).project.repos[0]).not.toHaveProperty(
      'requireMerge',
    );
  });
});
