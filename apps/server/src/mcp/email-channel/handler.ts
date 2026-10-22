import { emailChannelOn, emailSenderOf } from '@projectman/shared';
import type { ToolContext } from '../../contracts';
import type { EmailChannelService } from '../../services/email-channel';
import type { ProjectService } from '../../core/projects';
import type { ToolCaller } from '../caller';
import { toToolError } from '../caller';
import { DomainError } from '../../kernel';

export class EmailChannelTools {
  private readonly calls: ToolCaller;
  private readonly projects: Pick<ProjectService, 'config'>;
  private readonly email: EmailChannelService;

  constructor(deps: {
    calls: ToolCaller;
    projects: Pick<ProjectService, 'config'>;
    email: EmailChannelService;
  }) {
    this.calls = deps.calls;
    this.projects = deps.projects;
    this.email = deps.email;
  }

  private async allowed(ctx: ToolContext, tool: string): Promise<void> {
    const config = await this.calls.caller(ctx, tool);
    if (!this.email.configured())
      throw new DomainError('email_not_configured', 'the e-mail channel is not configured', {
        status: 403,
      });
    if (!emailChannelOn(config))
      throw new DomainError('email_channel_off', 'the e-mail channel is off', { status: 403 });
    if (!emailSenderOf(config, ctx.member))
      throw new DomainError('email_sender_not_enabled', 'this AI member cannot send e-mail', {
        status: 403,
      });
  }

  async sendEmail(
    ctx: ToolContext,
    args: { to: string; subject: string; text: string; taskKey: string | null },
  ) {
    try {
      await this.allowed(ctx, 'send_email');
      return await this.email.send(ctx.projectKey, ctx.member, {
        to: args.to,
        subject: args.subject,
        text: args.text,
        taskKey: args.taskKey ?? ctx.taskKey,
      });
    } catch (err) {
      throw toToolError(err);
    }
  }

  async setEmailContact(
    ctx: ToolContext,
    args: {
      handle: string;
      wants: boolean;
      requestedBy: string;
      sourceMessageId?: string;
      sourceEmailId?: string;
      quote?: string;
    },
  ) {
    try {
      await this.allowed(ctx, 'set_email_contact');
      return this.email.setContactByMember(ctx.projectKey, ctx.member, {
        handle: args.handle,
        wants: args.wants,
        requestedBy: args.requestedBy,
        ...(args.sourceMessageId ? { sourceMessageId: args.sourceMessageId } : {}),
        ...(args.sourceEmailId ? { sourceEmailId: args.sourceEmailId } : {}),
        ...(args.quote ? { quote: args.quote } : {}),
      });
    } catch (err) {
      throw toToolError(err);
    }
  }

  async listEmailContacts(ctx: ToolContext) {
    try {
      await this.allowed(ctx, 'list_email_contacts');
      return this.email.contactsForMember(ctx.projectKey);
    } catch (err) {
      throw toToolError(err);
    }
  }
}
