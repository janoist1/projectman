import { afterEach, expect, it } from 'vitest';
import { ProjectChecklistView, routes } from '@projectman/shared';
import { canSeeProjectEvent } from '../src/core/projects';
import { addHumanAndLogin, createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

let h: AppHarness;
afterEach(async () => {
  await h?.close();
});

it('limits checklist reads and writes to their allowed access levels', async () => {
  h = await createAppHarness();
  const owner = await setupOwner(h.app);
  await createProject(h, owner);
  for (const access of ['owner', 'admin', 'developer', 'client', 'viewer'] as const) {
    const cookie = access === 'owner' ? owner : await addHumanAndLogin(h.app, { handle: access, access });
    const res = await inject(h.app, 'GET', routes.projectChecklist('AR'), cookie);
    expect(res.statusCode).toBe(access === 'owner' || access === 'admin' ? 200 : 403);
    if (res.statusCode === 200)
      expect(ProjectChecklistView.parse(res.json()).canEdit).toBe(access === 'owner');
    expect(
      canSeeProjectEvent({ handle: access, access }, { type: 'project_checklist_changed', projectKey: 'AR' }),
    ).toBe(access === 'owner' || access === 'admin');
    const write = await inject(h.app, 'POST', routes.projectChecklistItemState('AR', 'goal'), cookie, {
      state: 'not_needed',
      reason: 'Already agreed',
    });
    expect(write.statusCode).toBe(access === 'owner' ? 200 : 403);
  }
});

it('requires a reason and records owner reopening without changing an already open item', async () => {
  h = await createAppHarness();
  const owner = await setupOwner(h.app);
  await createProject(h, owner);
  const url = routes.projectChecklistItemState('AR', 'code');
  expect((await inject(h.app, 'POST', url, owner, { state: 'not_needed' })).statusCode).toBe(400);
  const reopened: unknown[] = [];
  h.app.projectman.domain.ctx.events.on('checklist_item_reopened', (event) => {
    reopened.push(event);
  });
  const res = await inject(h.app, 'POST', url, owner, { state: 'open' });
  expect(res.statusCode).toBe(200);
  expect(
    ProjectChecklistView.parse(res.json()).checklist?.items.find((item) => item.id === 'code'),
  ).toMatchObject({ state: 'open', reopened: 'owner', updatedBy: 'owner' });
  await inject(h.app, 'POST', url, owner, { state: 'open' });
  expect(reopened).toHaveLength(1);
});

it('returns null for an existing project without a checklist and reports missing resources on writes', async () => {
  h = await createAppHarness();
  const owner = await setupOwner(h.app);
  await createProject(h, owner);
  const missingItem = await inject(h.app, 'POST', routes.projectChecklistItemState('AR', 'unknown'), owner, {
    state: 'open',
  });
  expect(missingItem.statusCode).toBe(404);
  expect(missingItem.json().error.code).toBe('checklist_item_not_found');
  h.app.projectman.domain.ctx.repos.db.prepare('DELETE FROM project_checklist_items').run();
  h.app.projectman.domain.ctx.repos.db.prepare('DELETE FROM project_checklists').run();
  const read = await inject(h.app, 'GET', routes.projectChecklist('AR'), owner);
  expect(read.json()).toEqual({ checklist: null, canEdit: true });
  const write = await inject(h.app, 'POST', routes.projectChecklistItemState('AR', 'code'), owner, {
    state: 'open',
  });
  expect(write.statusCode).toBe(404);
  expect(write.json().error.code).toBe('checklist_missing');
});
