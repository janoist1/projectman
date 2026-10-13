import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from '@projectman/shared';
import { sharedClaudeTmpRoots } from '../src/engine-host';
import { addHumanAndLogin, createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

const merger = vi.hoisted(() => ({
  prepare: vi.fn(),
  build: vi.fn(),
  isAncestor: vi.fn(),
  advance: vi.fn(),
  releaseCheck: vi.fn(async () => {}),
  checkoutConflicts: vi.fn(async () => []),
}));
vi.mock('../src/engine-host', async (original) => ({
  ...(await original<typeof import('../src/engine-host')>()),
  createLocalBranchMerger: () => merger,
}));

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
  it.each(['', '   ', 'x'.repeat(2001), 42])(
    'validates the resolution before starting: %s',
    async (resolution) => {
      const response = await inject(h.app, 'POST', routes.taskMerge('AR', 'AR-1'), cookie, { resolution });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'invalid_request' } });
    },
  );
  it('lets the human merger create a fix checkout and submit its committed resolution', async () => {
    const { domain, repos } = h.app.projectman;
    const loaded = await domain.projects.load('AR');
    await domain.projects.patch(
      'AR',
      {
        baseVersion: loaded.version,
        merger: { kind: 'member', handle: 'owner' },
        repoMerge: [{ repo: 'web', requireMerge: true }],
      },
      { actor: { kind: 'human', handle: 'owner' }, author: { name: 'Owner', email: 'owner@test.invalid' } },
    );
    vi.spyOn(domain.autoAdvance, 'check').mockResolvedValue(undefined);
    await domain.taskStarts.start('AR', 'AR-1', {
      assignee: 'dev-1',
      actor: { kind: 'human', handle: 'owner' },
      author: { name: 'Owner', email: 'owner@test.invalid' },
    });
    const tree = h.worktrees.existing.get('AR/AR-1/web')!;
    h.worktrees.heads.set(tree.path, {
      path: tree.path,
      branch: tree.branch,
      commit: 'approved',
      dirty: false,
      changes: 0,
      committedAt: null,
    });
    repos.taskHandovers.save({
      projectKey: 'AR',
      taskKey: 'AR-1',
      commit: 'approved',
      branch: tree.branch,
      stageId: 'code_review',
      at: new Date().toISOString(),
    });
    repos.tasks.update(domain.tasks.get('AR', 'AR-1').id, {
      stageId: 'merge',
      labels: ['code-review-ok', 'merge-ok', 'release-ok', 'pr-merged'],
    });
    merger.prepare.mockResolvedValue({
      local: 'base',
      remote: null,
      relation: 'same',
      contains: { local: false, remote: null },
      checkout: null,
    });
    merger.build
      .mockResolvedValueOnce({ ok: false, conflict: ['a.ts'] })
      .mockResolvedValue({ ok: true, mergeCommit: 'merged', changed: ['a.ts'] });
    merger.isAncestor.mockResolvedValue(true);
    merger.advance.mockResolvedValue({ ok: true });
    const started = await inject(h.app, 'POST', routes.taskMerge('AR', 'AR-1'), cookie);
    expect(started.statusCode, started.body).toBe(200);
    await vi.waitFor(() => expect(domain.tasks.get('AR', 'AR-1').merge?.state).toBe('failed'));
    const other = await addHumanAndLogin(h.app, { handle: 'other' });
    const refused = await inject(h.app, 'POST', routes.taskMerge('AR', 'AR-1'), other, { fixConflict: true });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      error: { code: 'merge_fix_not_allowed', details: { reason: 'not_merger' } },
    });
    const fixing = await inject(h.app, 'POST', routes.taskMerge('AR', 'AR-1'), cookie, { fixConflict: true });
    expect(fixing.statusCode).toBe(200);
    const fixTree = [...h.worktrees.fixes.values()][0]!;
    expect(fixing.json().task.merge).toMatchObject({
      state: 'fixing',
      fix: { by: 'owner', path: fixTree.path },
    });
    h.worktrees.heads.get(fixTree.path)!.dirty = true;
    const dirty = await inject(h.app, 'POST', routes.taskMerge('AR', 'AR-1'), cookie, {
      resolution: 'Fix imports',
    });
    expect(dirty.statusCode).toBe(409);
    expect(dirty.json()).toMatchObject({
      error: { code: 'merge_fix_invalid', details: { reason: 'uncommitted' } },
    });
    h.worktrees.heads.get(fixTree.path)!.dirty = false;
    h.worktrees.heads.get(fixTree.path)!.commit = 'resolved';
    const queued = await inject(h.app, 'POST', routes.taskMerge('AR', 'AR-1'), cookie, {
      resolution: '  Fix imports  ',
    });
    expect(queued.statusCode).toBe(200);
    expect(queued.json().task.merge.state).toBe('queued');
    await vi.waitFor(() =>
      expect(domain.tasks.get('AR', 'AR-1').merged?.resolution).toEqual({
        note: 'Fix imports',
        commit: 'resolved',
      }),
    );
    expect(
      domain.timeline.list('AR', { taskKey: 'AR-1' }).find((event) => event.type === 'task_merged')?.data,
    ).toMatchObject({ resolution: { note: 'Fix imports', commit: 'resolved' } });
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
