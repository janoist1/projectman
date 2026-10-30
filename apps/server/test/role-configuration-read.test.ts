import { afterEach, describe, expect, it } from 'vitest';
import { memberOf, roleBundle, RoleConfigurationRead } from '@projectman/shared';
import type { AiMemberConfig, ProjectConfig } from '@projectman/shared';
import type { ToolContext } from '../src/contracts';
import { createDomainHarness } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { seedOperatorRequest } from './helpers/operator-session';

let h: DomainHarness;
let ctx: ToolContext;
afterEach(async () => {
  await h?.cleanup();
});

function withOverrides(config: ProjectConfig) {
  // The test template's project manager is on leave; the tool surface is its alone (decision 66).
  (memberOf(config, 'pm') as AiMemberConfig).onLeave = false;
  config.team.roleOverrides = {
    developer: {
      ...roleBundle(config, 'developer'),
      instructions: 'Existing rule.\nKeep this too.\n' + 'Preserve the full instruction.\n'.repeat(30),
      summary: 'Developer summary',
      notTheirJob: 'Do not deploy.',
      whenToAsk: 'Ask about scope.',
    },
    lead_developer: { ...roleBundle(config, 'lead_developer'), instructions: 'Review changes.' },
    business_analyst: { ...roleBundle(config, 'business_analyst'), instructions: 'Clarify requirements.' },
    architect: { ...roleBundle(config, 'architect'), instructions: 'Plan module boundaries.' },
  };
}

async function setup() {
  h = await createDomainHarness({ adjust: withOverrides });
  const { session } = seedOperatorRequest(h, 'AR', { member: 'pm', text: 'Show the developer role.' });
  ctx = { projectKey: 'AR', member: 'pm', sessionId: session.id, taskKey: null };
}

describe('role configuration read tool (PM-746)', () => {
  it('reads complete stored and default bundles during an open owner request without any writes', async () => {
    await setup();
    const request = h.repos.operatorRequests.latest('AR', 1)[0]!;
    const before = await h.domain.projects.load('AR');
    const history = await h.domain.projects.history('AR');
    for (const role of ['developer', 'qa'] as const) {
      const read = RoleConfigurationRead.parse(await h.domain.teamTools.getRoleConfiguration(ctx, { role }));
      expect(read).toEqual({
        version: before.version,
        role,
        override: before.config.team.roleOverrides?.[role] ?? null,
        effective: roleBundle(before.config, role),
      });
    }
    expect((await h.domain.projects.load('AR')).version).toBe(before.version);
    expect(await h.domain.projects.history('AR')).toEqual(history);
    expect(h.repos.operatorRequests.latest('AR', 10)).toEqual([request]);
    expect(h.repos.operatorRequests.steps(request.id)).toEqual([]);
    expect(h.repos.inbox.listOpen('approval')).toEqual([]);
  });

  it('refuses other members and missing or mismatched sessions', async () => {
    await setup();
    await expect(
      h.domain.teamTools.getRoleConfiguration({ ...ctx, member: 'dev-1' }, { role: 'developer' }),
    ).rejects.toThrow('project_manager_only');
    await expect(
      h.domain.teamTools.getRoleConfiguration({ ...ctx, sessionId: 'missing' }, { role: 'developer' }),
    ).rejects.toThrow('project_manager_only');
  });
});
