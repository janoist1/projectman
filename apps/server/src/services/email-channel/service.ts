import {
  EMAIL_QUOTE_MAX,
  EMAIL_REPLY_TOKEN_DAYS,
  EMAIL_SENDS_PER_CONTACT_DAY,
  EMAIL_SENDS_PER_MEMBER_DAY,
  EMAIL_SUBJECT_MAX,
  EMAIL_TEXT_MAX,
  SYSTEM_SENDER,
  canSeeTask,
  emailApprovalOf,
  emailChannelOn,
  emailContactChangeRefusal,
  emailContentRefusals,
  emailRecipientRefusal,
  emailReplyAddress,
  emailSenderOf,
  ownerHandles,
} from '@projectman/shared';
import type {
  EmailChannelView,
  EmailContact,
  EmailContactRefusal,
  ErrorCode,
  AiMemberConfig,
  InboxItem,
  ProjectConfig,
  RedactionContext,
} from '@projectman/shared';
import type { EmailMessageRecord } from '../../db';
import { getLocale } from '@projectman/templates';
import { DECISION_OPTIONS, type InboxService, type Resolver } from '../../core/inbox';
import type { DomainContext } from '../../core/base';
import type { Messaging } from '../../core/messages';
import type { ProjectService } from '../../core/projects';
import type { TaskService } from '../../core/tasks';
import { DomainError } from '../../kernel';
import type { EmailChannelEnv } from './config';
import { renderEmail } from './render';
import { createEmailInbound } from './inbound';
import { replyToken, replyTokenHash } from './reply-token';
import type { EmailChannelService } from './types';
import { EmailSendError } from './ses-sender';
import type { EmailSender, OutboundMail } from './ses-sender';

const DAY_MS = 24 * 60 * 60 * 1000;

function refused(code: ErrorCode, message: string, status = 403, details?: unknown): DomainError {
  return new DomainError(code, message, { status, details });
}

function noteOf(refusal: { reason: string; match?: string }): string {
  return refusal.match ? `${refusal.reason}: ${refusal.match}` : refusal.reason;
}

export function createEmailChannelService(deps: {
  ctx: DomainContext;
  repo: DomainContext['repos']['emailChannel'];
  inbox: InboxService;
  messaging: Messaging;
  projects: ProjectService;
  tasks: TaskService;
  redactionContext: () => Promise<RedactionContext>;
  sender?: EmailSender;
  env?: EmailChannelEnv;
  replyKey?: Buffer;
  now: () => Date;
}): EmailChannelService {
  const { ctx, repo, inbox, messaging, projects, tasks, sender, env, replyKey, now } = deps;
  const configured = () => Boolean(sender && env && replyKey);
  const configuredParts = () => {
    if (!sender || !env || !replyKey)
      throw refused('email_not_configured', 'the e-mail channel is not configured');
    return { sender, env, replyKey };
  };

  const changed = (projectKey: string) => ctx.bus.publish({ type: 'email_changed', projectKey });

  async function contentRefusals(
    projectKey: string,
    config: ProjectConfig,
    recipientHandle: string,
    input: { subject: string; text: string; taskKey: string | null },
  ) {
    const recipient = config.team.members.find((member) => member.handle === recipientHandle);
    const recipientAccess = recipient?.kind === 'human' ? recipient.access : 'client';
    const redaction = await deps.redactionContext();
    const { env } = configuredParts();
    return emailContentRefusals(input, {
      projectKey,
      recipientAccess,
      canSee: (taskKey) => {
        const task = tasks.find(projectKey, taskKey);
        return !!task && canSeeTask({ access: recipientAccess }, task);
      },
      labelIds: config.pipeline.labels.map((label) => label.id),
      allowedAddresses: [
        ...(recipient?.kind === 'human' && recipient.email ? [recipient.email] : []),
        env.from,
      ],
      secrets: redaction.secrets,
      paths: redaction.paths,
    });
  }

  async function deliver(
    projectKey: string,
    config: ProjectConfig,
    record: EmailMessageRecord,
  ): Promise<void> {
    const token = replyToken();
    const member = config.team.members.find((candidate) => candidate.handle === record.member);
    const recipient = config.team.members.find((candidate) => candidate.handle === record.contact);
    if (!member || recipient?.kind !== 'human' || !recipient.email)
      throw refused('email_recipient_refused', 'the recipient is no longer valid');
    const rendered = renderEmail({
      text: record.text,
      footer: getLocale(config.project.language).email.footer({
        member: member.displayName,
        project: config.project.name,
      }),
    });
    const at = now().toISOString();
    const { sender, env, replyKey } = configuredParts();
    repo.messages.update(record.id, {
      status: 'sending',
      replyTokenHash: replyTokenHash(replyKey, token),
      replyExpiresAt: new Date(now().getTime() + EMAIL_REPLY_TOKEN_DAYS * DAY_MS).toISOString(),
      updatedAt: at,
    });
    changed(projectKey);
    try {
      const result = await sender.send({
        to: recipient.email,
        fromName: `${member.displayName} · ${config.project.name}`,
        replyTo: emailReplyAddress(projectKey, token, env.replyDomain),
        subject: record.subject,
        text: rendered.text,
        html: rendered.html,
      } satisfies OutboundMail);
      repo.messages.update(record.id, {
        status: 'sent',
        providerId: result.providerId,
        updatedAt: now().toISOString(),
      });
      changed(projectKey);
    } catch (error) {
      const reason = error instanceof EmailSendError ? error.reason : 'unavailable';
      repo.messages.update(record.id, {
        status: 'failed',
        note: reason,
        updatedAt: now().toISOString(),
      });
      changed(projectKey);
      throw refused('email_send_failed', 'the e-mail could not be sent', 502, { reason });
    }
  }

  async function notify(
    projectKey: string,
    member: string,
    taskKey: string | null,
    text: string,
  ): Promise<void> {
    await messaging.send(projectKey, SYSTEM_SENDER, { to: [member], taskKey, text }, { kind: 'info' });
  }

  function publishInbox(item: InboxItem | null): void {
    if (!item) return;
    ctx.bus.publish({
      type: 'inbox_upserted',
      projectKey: item.projectKey,
      item,
    });
  }

  function closeItem(
    item: InboxItem,
    optionId: string,
    by: Resolver,
    note: string | null,
    rule?: 'email_not_allowed',
  ): void {
    const at = now().toISOString();
    const closed = ctx.repos.inbox.close(
      item.id,
      'resolved',
      {
        optionId,
        by: by.handle,
        at,
        note,
        ...(by.via ? { via: by.via } : {}),
        ...(by.superActor ? { actor: by.superActor } : {}),
        ...(rule ? { rule } : {}),
      },
      at,
    );
    publishInbox(closed);
  }

  const inbound = createEmailInbound({
    ctx,
    repo,
    inbox,
    messaging,
    projects,
    tasks,
    env,
    replyKey,
    now,
    changed,
    notify,
    publishInbox,
  });
  let pruning: ReturnType<typeof setInterval> | undefined;
  const prune = () => {
    try {
      const count = repo.prune(now().toISOString());
      if (count > 0) ctx.logger.info({ count }, 'old parked e-mails were cleared');
    } catch (err) {
      ctx.logger.warn({ err }, 'clearing old parked e-mails failed');
    }
  };

  async function decide(item: InboxItem, by: Resolver, optionId: string, note: string | null): Promise<void> {
    const payload = emailApprovalOf(item);
    const record = payload?.emailId ? repo.messages.get(payload.emailId) : null;
    if (!record || record.projectKey !== item.projectKey || record.status !== 'pending_approval')
      throw refused('email_unknown', 'the e-mail approval is no longer waiting', 409);
    if (optionId === 'reject') {
      const at = now().toISOString();
      repo.messages.update(record.id, {
        status: 'rejected',
        note,
        decidedBy: by.handle,
        decidedAt: at,
        updatedAt: at,
      });
      closeItem(item, optionId, by, note);
      changed(item.projectKey);
      await notify(
        item.projectKey,
        record.member!,
        record.taskKey,
        `Your e-mail was rejected${note ? `: ${note}` : '.'}`,
      );
      return;
    }
    if (optionId !== 'approve') throw refused('invalid_request', 'unknown option', 400);
    const config = await projects.config(item.projectKey);
    const recipient = config.team.members.find((member) => member.handle === record.contact);
    const contact = record.contact!;
    const wants = repo.contacts.get(item.projectKey, contact)?.wants ?? false;
    const recipientRefusal = emailRecipientRefusal(recipient, wants);
    const senderAllowed = emailSenderOf(config, record.member!);
    const content = await contentRefusals(item.projectKey, config, contact, record);
    // The same order as `send`: channel, sender, recipient, content (the daily limit is not checked again).
    const refusal = !emailChannelOn(config)
      ? { reason: 'email_channel_off' }
      : !senderAllowed
        ? { reason: 'email_sender_not_enabled' }
        : recipientRefusal
          ? { reason: recipientRefusal }
          : content[0];
    if (refusal) {
      const at = now().toISOString();
      const refusalNote = noteOf(refusal);
      repo.messages.update(record.id, {
        status: 'cancelled',
        note: refusalNote,
        decidedBy: by.handle,
        decidedAt: at,
        updatedAt: at,
      });
      closeItem(item, optionId, by, refusalNote, 'email_not_allowed');
      changed(item.projectKey);
      await notify(
        item.projectKey,
        record.member!,
        record.taskKey,
        `Your e-mail was cancelled: ${refusalNote}.`,
      );
      return;
    }
    const at = now().toISOString();
    repo.messages.update(record.id, {
      decidedBy: by.handle,
      decidedAt: at,
      updatedAt: at,
    });
    closeItem(item, optionId, by, note);
    try {
      await deliver(item.projectKey, config, repo.messages.get(record.id)!);
      await notify(item.projectKey, record.member!, record.taskKey, 'Your e-mail was sent.');
    } catch {
      await notify(item.projectKey, record.member!, record.taskKey, 'Your e-mail could not be sent.');
    }
  }

  return {
    inbound,

    start() {
      if (pruning) return;
      prune();
      pruning = setInterval(prune, DAY_MS);
      pruning.unref();
    },

    stop() {
      if (pruning) clearInterval(pruning);
      pruning = undefined;
    },

    configured,

    async view(projectKey) {
      const config = await projects.config(projectKey);
      const records = new Map(repo.contacts.list(projectKey).map((row) => [row.handle, row]));
      return {
        configured: configured(),
        enabled: emailChannelOn(config),
        fromAddress: env?.from ?? null,
        senders: config.team.members
          .filter(
            (member): member is AiMemberConfig => member.kind === 'ai' && member.email?.enabled === true,
          )
          .map((member) => ({
            handle: member.handle,
            displayName: member.displayName,
            sendWithoutApproval: member.email?.sendWithoutApproval ?? false,
          })),
        contacts: config.team.members
          .filter((member) => member.kind === 'human')
          .map((member): EmailContact => {
            const record = records.get(member.handle);
            return {
              handle: member.handle,
              displayName: member.displayName,
              access: member.access,
              address: member.email ?? null,
              wants: record?.wants ?? false,
              changedBy: record?.changedBy ?? null,
              changedAt: record?.changedAt ?? null,
              requestedBy: record?.requestedBy ?? null,
              source: record?.source ?? null,
            };
          }),
      } satisfies EmailChannelView;
    },

    setContact(projectKey, handle, wants, by) {
      const config = projects.cachedConfig(projectKey);
      const member = config?.team.members.find((candidate) => candidate.handle === handle);
      if (!member || member.kind !== 'human') throw refused('email_unknown', 'unknown human contact', 404);
      return ctx.unitOfWork(() => {
        const event = repo.contacts.set({
          projectKey,
          handle,
          wants,
          by: by.handle,
          at: now().toISOString(),
          requestedBy: by.handle,
          source: 'settings',
          sourceRef: null,
          quote: null,
        });
        changed(projectKey);
        return {
          handle,
          displayName: member.displayName,
          access: member.access,
          address: member.email ?? null,
          wants: event.wants,
          changedBy: event.by,
          changedAt: event.at,
          requestedBy: event.requestedBy,
          source: event.source,
        };
      });
    },

    log(projectKey, before) {
      return repo.log(projectKey, before);
    },

    async send(projectKey, caller, input) {
      const { env } = configuredParts();
      if (!input.subject.trim() || input.subject.length > EMAIL_SUBJECT_MAX)
        throw refused('invalid_request', 'the subject is invalid', 400);
      if (!input.text.trim() || input.text.length > EMAIL_TEXT_MAX)
        throw refused('invalid_request', 'the text is invalid', 400);
      const config = await projects.config(projectKey);
      if (!emailChannelOn(config)) throw refused('email_channel_off', 'the e-mail channel is off');
      const sender = emailSenderOf(config, caller);
      if (!sender) throw refused('email_sender_not_enabled', 'this AI member cannot send e-mail');
      const recipient = config.team.members.find((member) => member.handle === input.to);
      const wants = repo.contacts.get(projectKey, input.to)?.wants ?? false;
      const recipientRefusal = emailRecipientRefusal(recipient, wants);
      if (recipientRefusal)
        throw refused('email_recipient_refused', 'the recipient does not accept this e-mail', 403, {
          reason: recipientRefusal,
        });
      const at = now();
      const since = new Date(at.getTime() - DAY_MS).toISOString();
      const statuses = ['sent', 'sending', 'pending_approval'] as const;
      if (
        repo.countOutboundSince(projectKey, { member: caller }, since, statuses) >=
          EMAIL_SENDS_PER_MEMBER_DAY ||
        repo.countOutboundSince(projectKey, { contact: input.to }, since, statuses) >=
          EMAIL_SENDS_PER_CONTACT_DAY
      )
        throw refused('email_rate_limited', 'the daily e-mail limit is reached', 429);
      const refusals = await contentRefusals(projectKey, config, input.to, {
        subject: input.subject,
        text: input.text,
        taskKey: input.taskKey,
      });
      if (refusals[0])
        throw refused('email_content_refused', 'the e-mail content is not allowed', 403, refusals[0]);
      if (sender.sendWithoutApproval) {
        const record = repo.messages.insert({
          projectKey,
          direction: 'outbound',
          member: caller,
          contact: input.to,
          taskKey: input.taskKey,
          subject: input.subject,
          text: input.text,
          status: 'sending',
          parkReason: null,
          note: null,
          fromAddress: env.from,
          attachmentNames: [],
          replyTokenHash: null,
          replyExpiresAt: null,
          inReplyTo: null,
          providerId: null,
          inboxItemId: null,
          messageId: null,
          decidedBy: null,
          decidedAt: null,
          createdAt: at.toISOString(),
          updatedAt: at.toISOString(),
        });
        changed(projectKey);
        try {
          await deliver(projectKey, config, record);
          await notify(projectKey, caller, input.taskKey, 'Your e-mail was sent.');
        } catch (error) {
          await notify(projectKey, caller, input.taskKey, 'Your e-mail could not be sent.').catch(
            () => undefined,
          );
          throw error;
        }
        return { emailId: record.id, status: 'sent' };
      }
      const recipientMember = recipient!;
      const item = ctx.unitOfWork(() => {
        const record = repo.messages.insert({
          projectKey,
          direction: 'outbound',
          member: caller,
          contact: input.to,
          taskKey: input.taskKey,
          subject: input.subject,
          text: input.text,
          status: 'pending_approval',
          parkReason: null,
          note: null,
          fromAddress: env.from,
          attachmentNames: [],
          replyTokenHash: null,
          replyExpiresAt: null,
          inReplyTo: null,
          providerId: null,
          inboxItemId: null,
          messageId: null,
          decidedBy: null,
          decidedAt: null,
          createdAt: at.toISOString(),
          updatedAt: at.toISOString(),
        });
        const created = inbox.create({
          projectKey,
          kind: 'approval',
          assignees: ownerHandles(config),
          source: caller,
          taskKey: input.taskKey,
          title: `E-mail approval: ${input.subject}`,
          body: input.text,
          payload: {
            email: {
              emailId: record.id,
              member: caller,
              contact: input.to,
              contactName: recipientMember.displayName,
              taskKey: input.taskKey,
              subject: input.subject,
              text: input.text,
            },
          },
          options: DECISION_OPTIONS,
        });
        repo.messages.update(record.id, {
          inboxItemId: created.id,
          updatedAt: now().toISOString(),
        });
        changed(projectKey);
        return created;
      });
      return { emailId: emailApprovalOf(item)!.emailId, status: 'pending_approval' };
    },

    setContactByMember(projectKey, caller, input) {
      const config = projects.cachedConfig(projectKey);
      if (!config) throw refused('not_found', 'project not found', 404);
      const target = config.team.members.find((member) => member.handle === input.handle);
      if (input.quote && input.quote.length > EMAIL_QUOTE_MAX)
        throw refused('invalid_request', 'the quote is too long', 400);
      let source:
        | { kind: 'message'; from: string; to: readonly string[]; at: string }
        | { kind: 'email'; from: string }
        | null = null;
      const sourceRef = input.sourceMessageId ?? input.sourceEmailId;
      if (input.sourceMessageId && input.sourceEmailId)
        throw refused('invalid_request', 'give one source only', 400);
      if (input.sourceMessageId) {
        const message = ctx.repos.messages.get(input.sourceMessageId);
        if (!message || message.projectKey !== projectKey)
          throw refused('email_unknown', 'unknown source message', 404);
        source = { kind: 'message', from: message.from, to: message.to, at: message.createdAt };
      } else if (input.sourceEmailId) {
        const message = repo.messages.get(input.sourceEmailId);
        if (!message || message.projectKey !== projectKey || message.direction !== 'inbound')
          throw refused('email_unknown', 'unknown source e-mail', 404);
        const address = target?.kind === 'human' ? target.email : null;
        source = {
          kind: 'email',
          from:
            address && message.fromAddress?.toLowerCase() === address.toLowerCase()
              ? input.handle
              : (message.fromAddress ?? ''),
        };
      }
      const changeRefusal: EmailContactRefusal | null = emailContactChangeRefusal({
        wants: input.wants,
        target: input.handle,
        requestedBy: input.requestedBy,
        caller,
        ownersAndAdmins: config.team.members
          .filter((member) => member.kind === 'human' && ['owner', 'admin'].includes(member.access))
          .map((member) => member.handle),
        source,
        now: now().toISOString(),
      });
      if (changeRefusal)
        throw refused('email_contact_refused', 'the e-mail contact change is not allowed', 403, {
          reason: changeRefusal,
        });
      if (!target || target.kind !== 'human') throw refused('email_unknown', 'unknown human contact', 404);
      ctx.unitOfWork(() => {
        repo.contacts.set({
          projectKey,
          handle: input.handle,
          wants: input.wants,
          by: caller,
          at: now().toISOString(),
          requestedBy: input.requestedBy,
          source: input.sourceMessageId ? 'message' : 'email',
          sourceRef: sourceRef ?? null,
          quote: input.quote ?? null,
        });
        changed(projectKey);
      });
      return { handle: input.handle, wants: input.wants };
    },

    contactsForMember(projectKey) {
      const config = projects.cachedConfig(projectKey);
      if (!config) return [];
      const records = new Map(repo.contacts.list(projectKey).map((row) => [row.handle, row]));
      return config.team.members
        .filter((member) => member.kind === 'human')
        .map((member) => ({
          handle: member.handle,
          displayName: member.displayName,
          wants: records.get(member.handle)?.wants ?? false,
          hasAddress: Boolean(member.email),
        }));
    },

    decideApproval: decide,

    onConfigChanged(projectKey) {
      const config = projects.cachedConfig(projectKey);
      if (!config) return;
      const projectOff = !emailChannelOn(config);
      for (const record of repo.listOutbound(projectKey, 'pending_approval')) {
        if (!projectOff && emailSenderOf(config, record.member!)) continue;
        const at = now().toISOString();
        ctx.unitOfWork(() => {
          repo.messages.update(record.id, {
            status: 'cancelled',
            note: projectOff ? 'email_channel_off' : 'email_sender_not_enabled',
            updatedAt: at,
          });
          if (record.inboxItemId) {
            const closed = ctx.repos.inbox.close(
              record.inboxItemId,
              'cancelled',
              {
                optionId: 'cancel',
                by: 'system',
                at,
                note: 'The e-mail channel is no longer allowed.',
                rule: 'email_not_allowed',
              },
              at,
            );
            publishInbox(closed);
          }
          changed(projectKey);
        });
        void notify(
          projectKey,
          record.member!,
          record.taskKey,
          'Your pending e-mail was cancelled because e-mail is no longer allowed.',
        ).catch(() => undefined);
      }
    },
  };
}
