import type { ProjectConfig } from '@projectman/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDomainHarness, type DomainHarness } from '../../../test/helpers/domain-harness';
import type { ToolContext } from '../../contracts';
import type { ProjectService } from '../../core/projects';
import type { EmailChannelService } from '../../services/email-channel';
import type { ToolCaller } from '../caller';
import { EMAIL_CHANNEL_TOOL_GROUP } from './tools';
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
    {
      name: 'not configured',
      configured: false,
      projectOn: true,
      senderOn: true,
      code: 'email_not_configured',
    },
    {
      name: 'the project channel is off',
      configured: true,
      projectOn: false,
      senderOn: true,
      code: 'email_channel_off',
    },
    {
      name: 'the sender is disabled',
      configured: true,
      projectOn: true,
      senderOn: false,
      code: 'email_sender_not_enabled',
    },
  ])('refuses every tool when $name', async ({ configured, projectOn, senderOn, code }) => {
    const channel = tools(senderConfig(base, projectOn, senderOn), configured);
    const calls = [
      channel.sendEmail(ctx, {
        to: 'owner',
        subject: 'Summary',
        text: 'Ready.',
        taskKey: null,
        replyTo: null,
      }),
      channel.setEmailContact(ctx, { handle: 'owner', wants: true, requestedBy: 'owner' }),
      channel.listEmailContacts(ctx),
    ];
    for (const call of calls)
      await expect(call).rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining(code) });
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

it('requires a subject or reply_to in the send_email schema', () => {
  const tool = EMAIL_CHANNEL_TOOL_GROUP.tools.find((tool) => tool.name === 'send_email')!;
  const args = { to: 'owner', text: 'Answer' };
  const result = tool.inputSchema.safeParse(args);
  expect(result.success).toBe(false);
  if (!result.success)
    expect(result.error.issues).toEqual([expect.objectContaining({ path: ['subject'], code: 'custom' })]);
  expect(tool.inputSchema.safeParse({ ...args, reply_to: 'eml_parent' }).success).toBe(true);
});
