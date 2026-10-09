import { afterEach, describe, expect, it } from 'vitest';
import { projectManagersOf } from '@projectman/shared';
import { createDomainHarness, OWNER, OWNER_ACTOR, type DomainHarness } from './helpers/domain-harness';

let h: DomainHarness;
afterEach(() => h?.cleanup());
const by = { actor: OWNER_ACTOR, author: OWNER };

async function handles(): Promise<string[]> {
  return (await h.domain.projects.config('AR')).team.members.map((m) => m.handle);
}

describe('the required project manager (PM-429)', () => {
  it('is in every project the test template builds, on leave', async () => {
    h = await createDomainHarness();
    const config = await h.domain.projects.config('AR');
    expect(projectManagersOf(config).map((m) => [m.handle, m.onLeave])).toEqual([['pm', true]]);
  });

  it('refuses to retire the only AI project manager and changes nothing', async () => {
    h = await createDomainHarness();
    const before = await handles();
    await expect(h.domain.members.retire('AR', 'pm', {}, by)).rejects.toMatchObject({
      code: 'project_manager_required',
      status: 409,
    });
    expect(await handles()).toEqual(before);
  });

  it('retires one of two project managers', async () => {
    h = await createDomainHarness({
      adjust: (c) => {
        c.team.members.push({
          kind: 'ai',
          handle: 'pm-2',
          displayName: 'Project manager 2',
          role: 'project_manager',
          model: 'opus',
          permissionMode: 'default',
          capacity: 1,
          instructions: '',
          sponsor: 'owner',
          temp: false,
        });
      },
    });
    await h.domain.members.retire('AR', 'pm', {}, by);
    expect(projectManagersOf(await h.domain.projects.config('AR')).map((m) => m.handle)).toEqual(['pm-2']);
    await expect(h.domain.members.retire('AR', 'pm-2', {}, by)).rejects.toMatchObject({
      code: 'project_manager_required',
    });
  });

  it('refuses a configuration without an AI project manager with no_ai_project_manager', async () => {
    h = await createDomainHarness();
    const before = await handles();
    await expect(
      h.domain.projects.update('AR', by, (c) => {
        const pm = c.team.members.find((m) => m.handle === 'pm')!;
        if (pm.kind === 'ai') pm.role = 'developer';
        return 'Drop the project manager role';
      }),
    ).rejects.toMatchObject({
      code: 'invalid_config',
      status: 422,
      details: { issues: [expect.objectContaining({ code: 'no_ai_project_manager' })] },
    });
    expect(await handles()).toEqual(before);
    expect(projectManagersOf(await h.domain.projects.config('AR'))).toHaveLength(1);
  });
});
