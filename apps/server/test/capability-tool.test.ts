import { afterEach, describe, expect, it } from 'vitest';
import { memberOf } from '@projectman/shared';
import type { AiMemberConfig, ProjectConfig } from '@projectman/shared';
import type { ToolContext } from '../src/contracts';
import { createDomainHarness } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { seedProjectManagerRequest } from './helpers/operator-session';

let h: DomainHarness;
let ctx: ToolContext;
afterEach(async () => {
  await h?.cleanup();
});

// The test template's project manager is on leave; the tool surface is its alone.
const pmActive = (config: ProjectConfig) => {
  (memberOf(config, 'pm') as AiMemberConfig).onLeave = false;
};

async function setup() {
  h = await createDomainHarness({ adjust: pmActive });
  const { session } = seedProjectManagerRequest(h, 'AR', { member: 'pm', text: 'What can the project do?' });
  ctx = { projectKey: 'AR', member: 'pm', sessionId: session.id, taskKey: null };
}

describe('get_capability tool (PM-1468)', () => {
  it('lists the items of an area and details one item, without any writes', async () => {
    await setup();
    const before = await h.domain.projects.load('AR');
    const list = await h.domain.teamTools.getCapability(ctx, { area: 'team_tools' });
    expect(list).toContain('- get_capability');
    expect(list).toContain('- get_task');
    const detail = await h.domain.teamTools.getCapability(ctx, {
      area: 'member_settings',
      id: 'permissionMode',
    });
    expect(detail).toContain('Owner-only');
    expect(detail).toContain('Schema:');
    expect((await h.domain.projects.load('AR')).version).toBe(before.version);
  });

  it('answers not_found for an unknown item, naming the area’s known items', async () => {
    await setup();
    await expect(
      h.domain.teamTools.getCapability(ctx, { area: 'roles', id: 'no-such-role' }),
    ).rejects.toMatchObject({ code: 'not_found', message: expect.stringContaining('- developer') });
  });

  it('refuses other members and missing sessions', async () => {
    await setup();
    await expect(
      h.domain.teamTools.getCapability({ ...ctx, member: 'dev-1' }, { area: 'roles' }),
    ).rejects.toThrow('project_manager_only');
    await expect(
      h.domain.teamTools.getCapability({ ...ctx, sessionId: 'missing' }, { area: 'roles' }),
    ).rejects.toThrow('project_manager_only');
  });
});
