import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { routes } from '@projectman/shared';
import { createAppHarness, createProject, inject, setupOwner, addHumanAndLogin } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { OWNER_ACTOR } from './helpers/domain-harness';

describe('card priority API', () => {
  let h: AppHarness;
  let cookie: string;
  beforeEach(async () => {
    h = await createAppHarness();
    cookie = await setupOwner(h.app);
    await createProject(h, cookie);
    await h.app.projectman.domain.tasks.create('AR', { title: 'Checkout' }, OWNER_ACTOR);
  });
  afterEach(async () => h.close());
  it('sets and clears through PATCH, validating the level before any field changes', async () => {
    const patch = (body: object) => inject(h.app, 'PATCH', routes.task('AR', 'AR-1'), cookie, body);
    const set = await patch({ priority: 'high' });
    expect(set.statusCode).toBe(200);
    expect(set.json().priority).toBe('high');
    for (const priority of ['medium', 2]) {
      const invalid = await patch({ priority, title: 'Changed' });
      expect([invalid.statusCode, invalid.json().error.code]).toEqual([400, 'invalid_request']);
    }
    expect(h.app.projectman.domain.tasks.get('AR', 'AR-1').title).toBe('Checkout');
    expect((await patch({ priority: null })).json().priority).toBeNull();
  });
  it('allows human developers and refuses viewers', async () => {
    const developer = await addHumanAndLogin(h.app, { handle: 'dev-human', access: 'developer' });
    const viewer = await addHumanAndLogin(h.app, { handle: 'viewer-human', access: 'viewer' });
    const set = await inject(h.app, 'PATCH', routes.task('AR', 'AR-1'), developer, { priority: 'normal' });
    expect(set.statusCode).toBe(200);
    const refused = await inject(h.app, 'PATCH', routes.task('AR', 'AR-1'), viewer, { priority: 'low' });
    expect(refused.statusCode).toBe(403);
    expect(h.app.projectman.domain.tasks.get('AR', 'AR-1').priority).toBe('normal');
  });
});
