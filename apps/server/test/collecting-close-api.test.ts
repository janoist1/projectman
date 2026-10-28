import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from '@projectman/shared';
import { sharedClaudeTmpRoots } from '../src/engine-host';
import { LocalEngineDirectory } from '../src/runtime/sessions/engines';
import { createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

const merger = vi.hoisted(() => ({
  prepare: vi.fn(),
  build: vi.fn(),
  isAncestor: vi.fn(),
  advance: vi.fn(),
  releaseCheck: vi.fn(async () => {}),
  checkoutConflicts: vi.fn(async () => []),
}));
vi.mock('../src/engine-host/branch-merger', async (original) => ({
  ...(await original<typeof import('../src/engine-host/branch-merger')>()),
  createLocalBranchMerger: () => merger,
}));

/** Closing a collecting card without code of its own through the HTTP update never reads the source (PM-797). */
describe.each([
  ['online', false],
  ['offline', true],
])('collecting card close over HTTP, engine %s (PM-797)', (_name, offline) => {
  let h: AppHarness;
  let cookie: string;
  beforeEach(async () => {
    h = await createAppHarness({ app: { claudeTmpRoots: sharedClaudeTmpRoots({ uid: 'test' }) } });
    cookie = await setupOwner(h.app);
    await createProject(h, cookie);
    const { domain } = h.app.projectman;
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
    await inject(h.app, 'POST', routes.tasks('AR'), cookie, { title: 'Collecting card', repo: 'web' });
    await inject(h.app, 'POST', routes.tasks('AR'), cookie, {
      title: 'A part',
      parentKey: 'AR-1',
      stageId: 'done',
      importedAt: '2026-10-14T10:00:00.000Z',
    });
    if (offline) vi.spyOn(LocalEngineDirectory.prototype, 'get').mockReturnValue(null);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await h.close();
  });

  it('closes the card without reading a source commit', async () => {
    const response = await inject(h.app, 'PATCH', routes.task('AR', 'AR-1'), cookie, { stageId: 'done' });
    expect(response.statusCode).toBe(200);
    expect(h.app.projectman.domain.tasks.get('AR', 'AR-1')).toMatchObject({
      status: 'done',
      stageId: 'done',
    });
    expect(merger.prepare).not.toHaveBeenCalled();
    expect(merger.isAncestor).not.toHaveBeenCalled();
  });
});
