import type { ProjectConfig } from '@projectman/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDomainHarness, type DomainHarness } from '../../../test/helpers/domain-harness';
import type { ToolContext } from '../../contracts';
import type { ProjectService } from '../../core/projects';
import type { EmailChannelService } from '../../services/email-channel';
import type { ToolCaller } from '../caller';
import { EmailChannelTools } from './handler';

const ctx: ToolContext = {
  sessionId: 'ses_dev',
  projectKey: 'AR',
  member: 'dev-1',
  taskKey: null,
};

function senderConfig(base: ProjectConfig, projectOn: boolean, senderOn: boolean): ProjectConfig {
  const config = structuredClone(base);
  config.project.email = { enabled: projectOn };
  const developer = config.team.members.find((member) => member.handle === ctx.member);
  if (developer?.kind !== 'ai') throw new Error('the test project has no AI developer');
  if (senderOn) developer.email = { enabled: true };
  else delete developer.email;
  return config;
}

function tools(config: ProjectConfig, configured: boolean): EmailChannelTools {
  const email = {
    configured: () => configured,
    send: async () => {
      throw new Error('the refusal test must not send');
    },
    setContactByMember: () => {
      throw new Error('the refusal test must not change a contact');
    },
    contactsForMember: (projectKey: string) => {
      if (projectKey !== ctx.projectKey) throw new Error('unknown project');
      return [
        { handle: 'owner', displayName: 'Owner', wants: false, hasAddress: true },
        { handle: 'client', displayName: 'Client', wants: false, hasAddress: false },
      ];
    },
  } as unknown as EmailChannelService;
  const calls = { caller: async () => config } as unknown as ToolCaller;
  const projects = {} as Pick<ProjectService, 'config'>;
  return new EmailChannelTools({ calls, projects, email });
}

describe('EmailChannelTools', () => {
  let harness: DomainHarness;
  let base: ProjectConfig;

  beforeEach(async () => {
    harness = await createDomainHarness();
    base = await harness.domain.projects.config(ctx.projectKey);
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it.each([
    { name: 'not configured', configured: false, projectOn: true, senderOn: true },
    { name: 'the project channel is off', configured: true, projectOn: false, senderOn: true },
    { name: 'the sender is disabled', configured: true, projectOn: true, senderOn: false },
  ])('refuses send_email when $name', async ({ configured, projectOn, senderOn }) => {
    const config = senderConfig(base, projectOn, senderOn);
    await expect(
      tools(config, configured).sendEmail(ctx, {
        to: 'owner',
        subject: 'Summary',
        text: 'Ready.',
        taskKey: null,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('lists contacts without their e-mail addresses', async () => {
    const config = senderConfig(base, true, true);
    const result = await tools(config, true).listEmailContacts(ctx);
    expect(result).toEqual([
      { handle: 'owner', displayName: 'Owner', wants: false, hasAddress: true },
      { handle: 'client', displayName: 'Client', wants: false, hasAddress: false },
    ]);
    expect(Object.keys(result[0]!).sort()).toEqual(['displayName', 'handle', 'hasAddress', 'wants']);
  });
});
