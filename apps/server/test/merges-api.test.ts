import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { routes } from '@projectman/shared';
import { sharedClaudeTmpRoots } from '../src/engine-host';
import { addHumanAndLogin, createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

describe('merge retry and configuration API', () => {
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
  it('returns 409 without a blocked merge and refuses read-only members', async () => {
    const response = await inject(h.app, 'POST', routes.retryMerge('AR', 'AR-1'), cookie);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'merge_not_blocked' } });
    const viewer = await addHumanAndLogin(h.app, { handle: 'reader', access: 'viewer' });
    expect((await inject(h.app, 'POST', routes.retryMerge('AR', 'AR-1'), viewer)).statusCode).toBe(403);
  });
  it('requeues a blocked merge under the same id and returns the task', async () => {
    const { domain, repos } = h.app.projectman;
    await domain.merges.stop();
    const at = new Date().toISOString();
    repos.taskMerges.save({
      id: 'merge-1',
      projectKey: 'AR',
      taskKey: 'AR-1',
      repo: 'web',
      base: 'main',
      commit: 'approved',
      branch: 'task/AR-1',
      fromStageId: 'backlog',
      toStageId: 'done',
      requestedBy: 'owner',
      state: 'blocked',
      step: 'merging',
      landed: 'nowhere',
      block: { reason: 'engine_unavailable', message: 'offline', at },
      createdAt: at,
      updatedAt: at,
    });
    const response = await inject(h.app, 'POST', routes.retryMerge('AR', 'AR-1'), cookie);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      task: { key: 'AR-1', merge: { id: 'merge-1', state: 'queued' } },
    });
  });
  it('allows the owner to set and clear merge policy, rejects unknown repos and admin edits', async () => {
    const patch = async (repo: string, mergeOnDone: boolean | null, as = cookie) => {
      const loaded = await h.app.projectman.domain.projects.load('AR');
      return inject(h.app, 'PATCH', routes.patchConfig('AR'), as, {
        baseVersion: loaded.version,
        repoMerge: [{ repo, mergeOnDone }],
      });
    };
    const unknown = await patch('missing', true);
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({
      error: { code: 'config_invalid', details: { issues: [{ code: 'unknown_repo' }] } },
    });
    const admin = await addHumanAndLogin(h.app, { handle: 'admin', access: 'admin' });
    expect((await patch('web', true, admin)).statusCode).toBe(403);
    expect((await patch('web', true)).statusCode).toBe(200);
    expect((await h.app.projectman.domain.projects.config('AR')).project.repos[0]!.mergeOnDone).toBe(true);
    expect((await patch('web', null)).statusCode).toBe(200);
    expect((await h.app.projectman.domain.projects.config('AR')).project.repos[0]).not.toHaveProperty(
      'mergeOnDone',
    );
  });
});
