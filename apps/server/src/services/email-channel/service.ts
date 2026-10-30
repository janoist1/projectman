import {
  EMAIL_QUOTE_MAX,
  EMAIL_REPLY_TOKEN_DAYS,
  EMAIL_SENDS_PER_CONTACT_DAY,
  EMAIL_SENDS_PER_MEMBER_DAY,
  EMAIL_SUBJECT_MAX,
  EMAIL_TEXT_MAX,
  SYSTEM_SENDER,
  emailApprovalOf,
  emailChannelOn,
  emailContactChangeRefusal,
  emailContentRefusals,
  emailMailboxState,
  emailOwnAddress,
  emailRecipientRefusal,
  emailReplyAddress,
  emailReplySubject,
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
import type { MessageAttachmentOperations } from '../../contracts';
import type { Messaging } from '../../core/messages';
import type { ProjectService } from '../../core/projects';
import type { TaskService } from '../../core/tasks';
import { DomainError, invalid } from '../../kernel';
import type { EmailChannelEnv } from './config';
import { projectConfigs } from './mailboxes';
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
  messageAttachments: MessageAttachmentOperations;
  projects: ProjectService;
  tasks: TaskService;
  redactionContext: () => Promise<RedactionContext>;
  sender?: EmailSender;
  env?: EmailChannelEnv;
  replyKey?: Buffer;
  now: () => Date;
}): EmailChannelService {
  const { ctx, repo, inbox, messaging, messageAttachments, projects, tasks, sender, env, replyKey, now } =
    deps;
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
    senderHandle: string,
    input: { subject: string; text: string; taskKey: string | null },
  ) {
    const recipient = config.team.members.find((member) => member.handle === recipientHandle);
    const recipientAccess = recipient?.kind === 'human' ? recipient.access : 'client';
    const redaction = await deps.redactionContext();
    const { env } = configuredParts();
    const sender = config.team.members.find((member) => member.handle === senderHandle);
    const own =
      sender?.kind === 'ai'
        ? emailOwnAddress(await projectConfigs(projects), projectKey, sender, env.replyDomain)
        : null;
    return emailContentRefusals(input, {
      projectKey,
      recipientAccess,
      canSee: (taskKey) => !!tasks.find(projectKey, taskKey),
      labelIds: config.pipeline.labels.map((label) => label.id),
      allowedAddresses: [
        ...(recipient?.kind === 'human' && recipient.email ? [recipient.email] : []),
        env.from,
        ...(own ? [own] : []),
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
    const member = config.team.members.find((candidate) => candidate.handle === record.member);
    const recipient = config.team.members.find((candidate) => candidate.handle === record.contact);
    if (!member || recipient?.kind !== 'human' || !recipient.email)
      throw refused('email_recipient_refused', 'the recipient is no longer valid');
    const { sender, env, replyKey } = configuredParts();
    const own =
      member.kind === 'ai'
        ? emailOwnAddress(await projectConfigs(projects), projectKey, member, env.replyDomain)
        : null;
    const parent = record.inReplyTo ? repo.messages.get(record.inReplyTo) : null;
    const received = parent?.direction === 'inbound' ? parent : null;
    const headers: OutboundMail['headers'] = [];
    if (received?.mimeMessageId) {
      const ids = [...(received.mimeReferences?.split(' ') ?? []), received.mimeMessageId];
      while (ids.join(' ').length > 900 && ids.length > 1) ids.splice(1, 1);
      headers.push(
        { name: 'In-Reply-To', value: received.mimeMessageId },
        { name: 'References', value: ids.join(' ') },
      );
    }
    const rendered = renderEmail({
      ...(received
        ? {
            quote: {
              header: getLocale(config.project.language).email.quoteHeader({
                date: new Intl.DateTimeFormat(config.project.language, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                  timeZone: config.project.timezone,
                }).format(new Date(received.createdAt)),
                name: recipient.displayName,
              }),
              text: received.text,
            },
          }
        : {}),
      text: record.text,
      ...(repo.messages.sentBefore(projectKey, member.handle, recipient.handle)
        ? {}
        : {
            notice: getLocale(config.project.language).email.firstNotice({
              member: member.displayName,
              project: config.project.name,
            }),
          }),
    });
    const shared = { from: env.from, fromName: `${member.displayName} · ${config.project.name}` };
    const sentFrom = own ? { from: own, fromName: member.displayName } : shared;
    let token: string | null = null;
    const tokenFields = (fallback: boolean) => {
      if (fallback) token ??= replyToken();
      return {
        replyTokenHash: fallback ? replyTokenHash(replyKey, token!) : null,
        replyExpiresAt: fallback
          ? new Date(now().getTime() + EMAIL_REPLY_TOKEN_DAYS * DAY_MS).toISOString()
          : null,
      };
    };
    const at = now().toISOString();
    repo.messages.update(record.id, {
      status: 'sending',
      fromAddress: sentFrom.from,
      ...tokenFields(!own),
      updatedAt: at,
    });
    changed(projectKey);
    const mail = (from: { from: string; fromName: string }): OutboundMail => ({
      to: recipient.email!,
      ...from,
      ...(from === shared ? { replyTo: emailReplyAddress(projectKey, token!, env.replyDomain) } : {}),
      ...(headers.length ? { headers } : {}),
      subject: record.subject,
      text: rendered.text,
      html: rendered.html,
    });
    try {
      let result: { providerId: string };
      try {
        result = await sender.send(mail(sentFrom));
      } catch (error) {
        if (!(error instanceof EmailSendError && error.fromRefused && sentFrom !== shared)) throw error;
        ctx.logger.warn(
          { projectKey, member: record.member, from: sentFrom.from },
          'the provider refused the member address; sent from the shared address instead: run `npm run cloud -- ses receive-configure`',
        );
        repo.messages.update(record.id, {
          fromAddress: shared.from,
          ...tokenFields(true),
          updatedAt: now().toISOString(),
        });
        result = await sender.send(mail(shared));
      }
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

  /** Tells the sender how its e-mail ended. A failure is logged and never changes that outcome (PM-957). */
  async function notify(
    projectKey: string,
    member: string,
    taskKey: string | null,
    text: string,
  ): Promise<void> {
    try {
      await messaging.send(projectKey, SYSTEM_SENDER, { to: [member], taskKey, text }, { kind: 'info' });
    } catch (err) {
      ctx.logger.warn({ err, projectKey, member }, 'telling the sender about its e-mail failed');
    }
  }

  function publishInbox(item: InboxItem | null): void {
    if (!item) return;
    ctx.bus.publish({
      type: 'inbox_upserted',
      projectKey: item.projectKey,
      item,
    });
  }

  /** The approval's row while it still waits; anything else (decided meanwhile, another project) is a 409. */
  function waitingRecord(item: InboxItem): EmailMessageRecord {
    const payload = emailApprovalOf(item);
    const record = payload?.emailId ? repo.messages.get(payload.emailId) : null;
    if (!record || record.projectKey !== item.projectKey || record.status !== 'pending_approval')
      throw refused('email_unknown', 'the e-mail approval is no longer waiting', 409);
    return record;
  }

  /**
   * Settles the approval in one unit of work: the row leaves `pending_approval` and the inbox item closes
   * together, or neither does. Run it only after every await of the decision, so a parallel decision cannot
   * slip in between the check and the write: the loser finds the row or the item already settled (409).
   */
  function settle(
    item: InboxItem,
    by: Resolver,
    optionId: string,
    note: string | null,
    outcome: {
      status: 'rejected' | 'cancelled' | 'sending';
      /** What the e-mail row keeps; an approval leaves it as it is. */
      recordNote?: string | null;
      rule?: 'email_not_allowed';
    },
  ): EmailMessageRecord {
    const [settled, closed] = ctx.unitOfWork(() => {
      const record = waitingRecord(item);
      const at = now().toISOString();
      if (
        !repo.messages.transition(record.id, 'pending_approval', {
          status: outcome.status,
          note: outcome.recordNote,
          decidedBy: by.handle,
          decidedAt: at,
          updatedAt: at,
        })
      )
        throw refused('email_unknown', 'the e-mail approval is no longer waiting', 409);
      const closedItem = ctx.repos.inbox.close(
        item.id,
        'resolved',
        {
          optionId,
          by: by.handle,
          at,
          note: outcome.status === 'cancelled' ? (outcome.recordNote ?? null) : note,
          ...(by.via ? { via: by.via } : {}),
          ...(by.superActor ? { actor: by.superActor } : {}),
          ...(outcome.rule ? { rule: outcome.rule } : {}),
        },
        at,
      );
      if (!closedItem) throw refused('email_unknown', 'the e-mail approval is no longer waiting', 409);
      return [repo.messages.get(record.id)!, closedItem] as const;
    });
    publishInbox(closed);
    changed(item.projectKey);
    return settled;
  }

  const inbound = createEmailInbound({
    ctx,
    repo,
    inbox,
    messaging,
    messageAttachments,
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
    const record = waitingRecord(item);
    if (optionId === 'reject') {
      settle(item, by, optionId, note, { status: 'rejected', recordNote: note });
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
    const content = await contentRefusals(item.projectKey, config, contact, record.member!, record);
    // The same order as `send`: channel, sender, recipient, content (the daily limit is not checked again).
    const refusal = !emailChannelOn(config)
      ? { reason: 'email_channel_off' }
      : !senderAllowed
        ? { reason: 'email_sender_not_enabled' }
        : recipientRefusal
          ? { reason: recipientRefusal }
          : content[0];
    // No await from here to the end of the settling: a parallel decision on the same item gets a 409.
    if (refusal) {
      const refusalNote = noteOf(refusal);
      settle(item, by, optionId, note, {
        status: 'cancelled',
        recordNote: refusalNote,
        rule: 'email_not_allowed',
      });
      await notify(
        item.projectKey,
        record.member!,
        record.taskKey,
        `Your e-mail was cancelled: ${refusalNote}.`,
      );
      return;
    }
    // `sending` keeps the row out of `pending_approval` until `deliver` has the mail, so a decision that
    // arrives meanwhile cannot send it again or reject it.
    const sending = settle(item, by, optionId, note, { status: 'sending' });
    try {
      await deliver(item.projectKey, config, sending);
    } catch {
      // `deliver` marks a failed send itself; a mail that never reached it must not stay `sending`.
      if (repo.messages.transition(record.id, 'sending', { status: 'failed', note: 'unavailable' }))
        changed(item.projectKey);
      await notify(item.projectKey, record.member!, record.taskKey, 'Your e-mail could not be sent.');
      return;
    }
    await notify(item.projectKey, record.member!, record.taskKey, 'Your e-mail was sent.');
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
      const configs = await projectConfigs(projects);
      const domain = env && configured() ? env.replyDomain : null;
      return {
        configured: configured(),
        enabled: emailChannelOn(config),
        fromAddress: env?.from ?? null,
        memberDomain: domain,
        senders: config.team.members
          .filter(
            (member): member is AiMemberConfig => member.kind === 'ai' && member.email?.enabled === true,
          )
          .map((member) => ({
            handle: member.handle,
            displayName: member.displayName,
            sendWithoutApproval: member.email?.sendWithoutApproval ?? false,
            ...emailMailboxState(configs, projectKey, member, domain),
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
      try {
        return repo.log(projectKey, before);
      } catch (err) {
        // A cursor the repository cannot read (a `RangeError`) is the caller's mistake; any other failure stays one.
        if (!(err instanceof RangeError)) throw err;
        throw invalid('invalid_request', 'the log cursor is not valid', { cause: String(err) });
      }
    },

    async send(projectKey, caller, input) {
      const { env } = configuredParts();
      const parent = input.replyTo ? repo.messages.get(input.replyTo) : null;
      if (
        input.replyTo &&
        (!parent ||
          parent.projectKey !== projectKey ||
          parent.direction !== 'inbound' ||
          parent.status !== 'delivered' ||
          parent.member !== caller ||
          parent.contact !== input.to)
      )
        throw refused('email_unknown', 'unknown received e-mail', 404);
      const subject = input.subject ?? (parent ? emailReplySubject(parent.subject) : null);
      const taskKey = input.taskKey ?? parent?.taskKey ?? null;
      if (!subject?.trim() || subject.length > EMAIL_SUBJECT_MAX)
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
      const refusals = await contentRefusals(projectKey, config, input.to, caller, {
        subject,
        text: input.text,
        taskKey,
      });
      if (refusals[0])
        throw refused('email_content_refused', 'the e-mail content is not allowed', 403, refusals[0]);
      if (sender.sendWithoutApproval) {
        const record = repo.messages.insert({
          projectKey,
          direction: 'outbound',
          member: caller,
          contact: input.to,
          taskKey,
          subject,
          text: input.text,
          status: 'sending',
          parkReason: null,
          note: null,
          fromAddress: env.from,
          attachmentNames: [],
          replyTokenHash: null,
          replyExpiresAt: null,
          inReplyTo: parent?.id ?? null,
          providerId: null,
          inboxItemId: null,
          messageId: null,
          mimeMessageId: null,
          mimeReferences: null,
          decidedBy: null,
          decidedAt: null,
          createdAt: at.toISOString(),
          updatedAt: at.toISOString(),
        });
        changed(projectKey);
        try {
          await deliver(projectKey, config, record);
        } catch (error) {
          await notify(projectKey, caller, taskKey, 'Your e-mail could not be sent.');
          throw error;
        }
        await notify(projectKey, caller, taskKey, 'Your e-mail was sent.');
        return { emailId: record.id, status: 'sent' };
      }
      const recipientMember = recipient!;
      const item = ctx.unitOfWork(() => {
        const record = repo.messages.insert({
          projectKey,
          direction: 'outbound',
          member: caller,
          contact: input.to,
          taskKey,
          subject,
          text: input.text,
          status: 'pending_approval',
          parkReason: null,
          note: null,
          fromAddress: env.from,
          attachmentNames: [],
          replyTokenHash: null,
          replyExpiresAt: null,
          inReplyTo: parent?.id ?? null,
          providerId: null,
          inboxItemId: null,
          messageId: null,
          mimeMessageId: null,
          mimeReferences: null,
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
          taskKey,
          title: `E-mail approval: ${subject}`,
          body: input.text,
          payload: {
            email: {
              emailId: record.id,
              member: caller,
              contact: input.to,
              contactName: recipientMember.displayName,
              taskKey,
              subject,
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
        | { kind: 'email'; from: string; at: string }
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
        // A parked mail is stored with the From it claimed (authentication_failed, token_invalid, ...): it proves nothing.
        if (
          !message ||
          message.projectKey !== projectKey ||
          message.direction !== 'inbound' ||
          message.status !== 'delivered'
        )
          throw refused('email_unknown', 'unknown source e-mail', 404);
        const address = target?.kind === 'human' ? target.email : null;
        source = {
          kind: 'email',
          from:
            address && message.fromAddress?.toLowerCase() === address.toLowerCase()
              ? input.handle
              : (message.fromAddress ?? ''),
          at: message.createdAt,
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
          source: input.sourceMessageId ? 'message' : input.sourceEmailId ? 'email' : 'member',
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
        );
      }
    },
  };
}
