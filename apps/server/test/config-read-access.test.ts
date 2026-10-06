import { afterEach, describe, expect, it } from 'vitest';
import { ConfigView, routes } from '@projectman/shared';
import type { HumanAccess } from '@projectman/shared';
import { createAppHarness, createProject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

/** The "how we work" page (PM-290) reads the configuration: every internal member may, a client may not. */
describe('reading the project configuration', () => {
  let h: AppHarness;
  let cookie: string;
  afterEach(async () => h?.close());

  /** The test account's cookie then belongs to a fictional member with that access. */
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

  const read = () => h.app.inject({ method: 'GET', url: routes.config('AR'), headers: { cookie } });

  async function setup(access: HumanAccess) {
    h = await createAppHarness();
    cookie = await setupOwner(h.app);
    await createProject(h, cookie);
    if (access !== 'owner') await actAs(access);
  }

  it.each(['owner', 'admin', 'developer', 'viewer'] as const)(
    'gives it to a member with %s access',
    async (access) => {
      await setup(access);
      const response = await read();
      expect(response.statusCode).toBe(200);
      expect(ConfigView.parse(response.json()).config.project.key).toBe('AR');
    },
  );

  it('refuses a client', async () => {
    await setup('client');
    const response = await read();
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'insufficient_access' } });
  });
});
