import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import PostalMime from 'postal-mime';
import {
  ALERT_SEEN_OPTION,
  EMAIL_INBOUND_TEXT_MAX,
  EMAIL_PARKED_ALERTS_PER_DAY,
  EMAIL_SUBJECT_MAX,
  MAX_MESSAGE_ATTACHMENTS,
  SYSTEM_SENDER,
  emailChannelOn,
  emailMailboxOwners,
  emailRecipientRefusal,
  emailSenderOf,
  isOpenTask,
  parseEmailMemberAddress,
  parseEmailReplyAddress,
  teamMessageRecipientRefusal,
} from '@projectman/shared';
import type { EmailParkedAlert, EmailParkReason, InboxItem, ProjectConfig } from '@projectman/shared';
import type { MessageAttachmentOperations } from '../../contracts';
import type { EmailMessageRecord } from '../../db';
import type { DomainContext } from '../../core/base';
import type { InboxService } from '../../core/inbox';
import type { Messaging } from '../../core/messages';
import type { ProjectService } from '../../core/projects';
import type { TaskService } from '../../core/tasks';
import { humanActor } from '../../kernel';
import type { EmailChannelEnv } from './config';
import { projectConfigs } from './mailboxes';
import { cleanReplyText, htmlToText } from './reply-text';
import { replyTokenHash } from './reply-token';
import type { DeliveryEvent, EmailInbound, InboundMail } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;
const EXCERPT_MAX = 1000;
const ATTACHMENT_NAMES_MAX = 20;
const ATTACHMENT_NAME_MAX = 200;
const ADDRESS_MAX = 320;

type Parsed = {
  fromAddress: string;
  subject: string;
  text: string;
  attachmentNames: string[];
  /** The files to store (at most one message's worth); the names above stay the record of every attachment. */
  files: { fileName: string; content: Buffer }[];
};

/** Who a mail is between, as the log records it. */
type Link = {
  member: string | null;
  contact: string | null;
  taskKey: string | null;
  inReplyTo: string | null;
};

function limited(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * The bodies, the names and the content of the attachments are read. The content goes only to the
 * message-attachment storage, which sniffs its type, previews only a proven image and never runs it.
 */
async function parse(raw: Uint8Array): Promise<Parsed | null> {
  try {
    const email = await PostalMime.parse(raw);
    const fromAddress = email.from?.address?.trim().toLowerCase();
    if (!fromAddress) return null;
    const body = email.text?.trim() ? email.text : htmlToText(email.html ?? '');
    const name = (filename: string | null) => limited(filename ?? 'attachment', ATTACHMENT_NAME_MAX);
    return {
      fromAddress: limited(fromAddress, ADDRESS_MAX),
      subject: limited((email.subject ?? '').trim(), EMAIL_SUBJECT_MAX),
      text: cleanReplyText(body),
      attachmentNames: email.attachments.slice(0, ATTACHMENT_NAMES_MAX).map((a) => name(a.filename)),
      files: email.attachments.slice(0, MAX_MESSAGE_ATTACHMENTS).map((a) => ({
        fileName: name(a.filename),
        content: Buffer.from(typeof a.content === 'string' ? a.content : new Uint8Array(a.content)),
      })),
    };
  } catch {
    return null;
  }
}

export function createEmailInbound(deps: {
  ctx: DomainContext;
  repo: DomainContext['repos']['emailChannel'];
  inbox: InboxService;
  messaging: Messaging;
  messageAttachments: MessageAttachmentOperations;
  projects: ProjectService;
  tasks: TaskService;
  env?: EmailChannelEnv;
  replyKey?: Buffer;
  now: () => Date;
  changed: (projectKey: string) => void;
  notify: (projectKey: string, member: string, taskKey: string | null, text: string) => Promise<void>;
  publishInbox: (item: InboxItem | null) => void;
}): EmailInbound {
  const {
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
  } = deps;
  const { logger } = ctx;

  const linkOf = (outbound: EmailMessageRecord | null): Link | null =>
    outbound
      ? {
          member: outbound.member,
          contact: outbound.contact,
          taskKey: outbound.taskKey,
          inReplyTo: outbound.id,
        }
      : null;

  /** `alert: false`: the mail is kept in the log but raises no item (a guessable address gets mail from anyone). */
  function park(
    projectKey: string,
    config: ProjectConfig,
    mail: InboundMail,
    reason: EmailParkReason,
    parsed: Parsed | null,
    link: Link | null,
    alert = true,
  ): 'parked' | 'duplicate' {
    const at = now().toISOString();
    const text = limited(parsed?.text ?? '', EMAIL_INBOUND_TEXT_MAX);
    let record: EmailMessageRecord;
    try {
      record = repo.messages.insert({
        projectKey,
        direction: 'inbound',
        member: link?.member ?? null,
        contact: link?.contact ?? null,
        taskKey: link?.taskKey ?? null,
        subject: parsed?.subject ?? '',
        text,
        status: 'parked',
        parkReason: reason,
        note: null,
        fromAddress: parsed?.fromAddress ?? '',
        attachmentNames: parsed?.attachmentNames ?? [],
        replyTokenHash: null,
        replyExpiresAt: null,
        inReplyTo: link?.inReplyTo ?? null,
        providerId: mail.providerId,
        inboxItemId: null,
        messageId: null,
        decidedBy: null,
        decidedAt: null,
        createdAt: at,
        updatedAt: at,
      });
    } catch (error) {
      if (isUniqueViolation(error)) return 'duplicate';
      throw error;
    }
    const since = new Date(now().getTime() - DAY_MS).toISOString();
    const assignees = config.team.members
      .filter((member) => member.kind === 'human' && ['owner', 'admin'].includes(member.access))
      .map((member) => member.handle);
    if (
      !alert ||
      repo.countAlertedSince(projectKey, since) >= EMAIL_PARKED_ALERTS_PER_DAY ||
      assignees.length === 0
    ) {
      logger.warn({ projectKey, providerId: mail.providerId, reason }, 'a mail was parked without an alert');
    } else {
      const payload: EmailParkedAlert = {
        alert: 'email_parked',
        emailId: record.id,
        reason,
        fromAddress: record.fromAddress ?? '',
        subject: record.subject,
        excerpt: limited(text, EXCERPT_MAX),
        attachmentNames: record.attachmentNames,
      };
      const item = inbox.create({
        projectKey,
        kind: 'alert',
        assignees,
        source: 'system',
        taskKey: null,
        title: `A received e-mail was parked: ${reason}`,
        payload,
        options: [ALERT_SEEN_OPTION],
      });
      repo.messages.update(record.id, { inboxItemId: item.id, updatedAt: now().toISOString() });
      deps.publishInbox(item);
    }
    changed(projectKey);
    return 'parked';
  }

  type Received = 'delivered' | 'parked' | 'duplicate' | 'dropped';

  const drop = (mail: InboundMail, why: string): 'dropped' => {
    logger.warn({ providerId: mail.providerId }, `a received mail was dropped: ${why}`);
    return 'dropped';
  };

  /**
   * Records the mail and hands it to the member as a message with the mail's files. The row comes first:
   * its unique provider id claims the mail, so a second delivery of it (the queue delivers at least once)
   * stops here and the member gets the message once.
   */
  async function deliverMail(input: {
    projectKey: string;
    config: ProjectConfig;
    mail: InboundMail;
    parsed: Parsed;
    member: string;
    contact: string;
    taskKey: string | null;
    inReplyTo: string | null;
    direct: boolean;
  }): Promise<Received> {
    const { projectKey, config, mail, parsed, member, contact, taskKey, inReplyTo, direct } = input;
    const emailId = `eml_${randomUUID()}`;
    const at = now().toISOString();
    try {
      repo.messages.insert({
        id: emailId,
        projectKey,
        direction: 'inbound',
        member,
        contact,
        taskKey,
        subject: parsed.subject,
        text: parsed.text,
        status: 'delivered',
        parkReason: null,
        note: null,
        fromAddress: parsed.fromAddress,
        attachmentNames: parsed.attachmentNames,
        replyTokenHash: null,
        replyExpiresAt: null,
        inReplyTo,
        providerId: mail.providerId,
        inboxItemId: null,
        messageId: null,
        decidedBy: null,
        decidedAt: null,
        createdAt: at,
        updatedAt: at,
      });
    } catch (error) {
      if (isUniqueViolation(error)) return 'duplicate';
      throw error;
    }
    try {
      // A file that cannot be stored is left out (its name stays in the log); the text still arrives.
      const attachmentIds: string[] = [];
      for (const file of parsed.files) {
        try {
          const stored = await messageAttachments.upload({
            projectKey,
            actor: humanActor(contact),
            fileName: file.fileName,
            content: Readable.from([file.content]),
          });
          attachmentIds.push(stored.id);
        } catch (err) {
          logger.warn(
            { err, providerId: mail.providerId },
            'an attachment of a received mail was not stored',
          );
        }
      }
      if (!parsed.text.trim() && attachmentIds.length === 0) {
        repo.messages.remove(emailId);
        return park(projectKey, config, mail, 'unreadable', parsed, { member, contact, taskKey, inReplyTo });
      }
      const task = taskKey ? tasks.find(projectKey, taskKey) : null;
      const message = await messaging.send(
        projectKey,
        contact,
        {
          to: [member],
          taskKey: task && isOpenTask(task) ? task.key : null,
          text: parsed.text,
          attachmentIds,
        },
        { kind: 'action', email: { emailId, subject: parsed.subject, ...(direct ? { direct: true } : {}) } },
      );
      repo.messages.update(emailId, { messageId: message.id, updatedAt: now().toISOString() });
    } catch (error) {
      // Nothing was sent: free the provider id, so the redelivery of the mail can try again. The files
      // that were stored but not bound to a message are swept by the attachment service.
      repo.messages.remove(emailId);
      throw error;
    }
    changed(projectKey);
    return 'delivered';
  }

  /** A mail to a reply address of an outgoing mail: the answer of the person the member wrote to. */
  async function receiveReply(
    mail: InboundMail,
    address: { projectKey: string; token: string },
    key: Buffer,
  ): Promise<Received> {
    const config = await projects.config(address.projectKey).catch(() => null);
    if (!config) return drop(mail, 'unknown project');
    const projectKey = address.projectKey;

    const parsed = await parse(mail.raw);
    if (!parsed) return park(projectKey, config, mail, 'unreadable', null, null);
    const outbound = repo.messages.byTokenHash(replyTokenHash(key, address.token));
    const known = outbound?.direction === 'outbound' && outbound.projectKey === projectKey ? outbound : null;
    const fail = (reason: EmailParkReason) => park(projectKey, config, mail, reason, parsed, linkOf(known));
    if (!known) return fail('token_invalid');
    if (known.replyExpiresAt && known.replyExpiresAt < now().toISOString()) return fail('token_expired');
    const { dmarc, spam, virus } = mail.verdicts;
    if (dmarc !== 'pass' || spam === 'fail' || virus === 'fail') return fail('authentication_failed');
    const contact = config.team.members.find((member) => member.handle === known.contact);
    if (contact?.kind !== 'human' || !contact.email || contact.email.toLowerCase() !== parsed.fromAddress)
      return fail('unknown_sender');
    if (!emailChannelOn(config) || !emailSenderOf(config, known.member ?? '')) return fail('channel_off');
    return deliverMail({
      projectKey,
      config,
      mail,
      parsed,
      member: known.member!,
      contact: contact.handle,
      taskKey: known.taskKey,
      inReplyTo: known.id,
      direct: false,
    });
  }

  /** A mail to a member's own address (PM-989): from a contributing person of the member's project only. */
  async function receiveDirect(mail: InboundMail, mailbox: string): Promise<Received> {
    const configs = await projectConfigs(projects);
    const owners = emailMailboxOwners(configs, mailbox);
    if (owners.length === 0) return drop(mail, 'no member has this mailbox');
    if (owners.length > 1) {
      logger.warn({ providerId: mail.providerId, mailbox }, 'a received mail was dropped: ambiguous mailbox');
      return 'dropped';
    }
    const { projectKey, handle } = owners[0]!;
    const config = configs.find((candidate) => candidate.project.key === projectKey)!;

    const link: Link = { member: handle, contact: null, taskKey: null, inReplyTo: null };
    const parsed = await parse(mail.raw);
    if (!parsed) return park(projectKey, config, mail, 'unreadable', null, link);
    // Anyone can guess the address: a stranger's mail is kept in the log, and it raises no alert.
    const sender = config.team.members.find(
      (member) => member.kind === 'human' && member.email?.toLowerCase() === parsed.fromAddress,
    );
    if (sender?.kind !== 'human')
      return park(projectKey, config, mail, 'unknown_sender', parsed, link, false);
    const known: Link = { ...link, contact: sender.handle };
    const { dmarc, spam, virus } = mail.verdicts;
    if (dmarc !== 'pass' || spam === 'fail' || virus === 'fail')
      return park(projectKey, config, mail, 'authentication_failed', parsed, known);
    // The same rules as a message written in the app: the sender's consent to e-mail, and a client writes
    // only to the contacts (`opts.email` exempts a reply from the second, a mail to an address is not one).
    const wants = repo.contacts.get(projectKey, sender.handle)?.wants ?? false;
    if (
      emailRecipientRefusal(sender, wants) !== null ||
      teamMessageRecipientRefusal(config, sender.handle, [handle]) !== null
    )
      return park(projectKey, config, mail, 'sender_not_allowed', parsed, known);
    return deliverMail({
      projectKey,
      config,
      mail,
      parsed,
      member: handle,
      contact: sender.handle,
      taskKey: null,
      inReplyTo: null,
      direct: true,
    });
  }

  async function receive(mail: InboundMail): Promise<Received> {
    if (repo.messages.byProviderId(mail.providerId)) return 'duplicate';
    if (!env || !replyKey) return drop(mail, 'the e-mail channel is not configured');
    const recipients = mail.recipients.map((recipient) => recipient.trim().toLowerCase());
    // A reply address comes first: it belongs to one outgoing mail and wins over a member's address.
    for (const recipient of recipients) {
      const address = parseEmailReplyAddress(recipient, env.replyDomain);
      if (address) return receiveReply(mail, address, replyKey);
    }
    for (const recipient of recipients) {
      const mailbox = parseEmailMemberAddress(recipient, env.replyDomain);
      if (mailbox) return receiveDirect(mail, mailbox);
    }
    return drop(mail, 'no reply or member address');
  }

  async function deliveryEvent(event: DeliveryEvent): Promise<void> {
    const record = repo.messages.byProviderId(event.providerId);
    if (!record || record.direction !== 'outbound') {
      logger.debug({ providerId: event.providerId, kind: event.kind }, 'a delivery event of an unknown mail');
      return;
    }
    const { projectKey } = record;
    const at = now().toISOString();
    if (event.kind === 'delivery') return;
    // The notification service repeats events: an outcome already recorded is not handled again.
    if (record.status === 'bounced' || record.status === 'complained') {
      logger.debug({ providerId: event.providerId, kind: event.kind }, 'a repeated delivery event');
      return;
    }
    if (event.kind === 'bounce' && !event.permanent) {
      logger.info({ projectKey, emailId: record.id }, 'a mail bounced for now');
      return;
    }
    const config = await projects.config(projectKey).catch(() => null);
    const name =
      config?.team.members.find((member) => member.handle === record.contact)?.displayName ??
      record.contact ??
      '';
    if (event.kind === 'bounce') {
      repo.messages.update(record.id, { status: 'bounced', note: 'bounce', updatedAt: at });
      logger.warn({ projectKey, emailId: record.id }, 'a mail bounced');
    } else {
      ctx.unitOfWork(() => {
        repo.messages.update(record.id, { status: 'complained', updatedAt: at });
        if (record.contact)
          repo.contacts.set({
            projectKey,
            handle: record.contact,
            wants: false,
            by: 'system',
            at,
            requestedBy: null,
            source: 'complaint',
            sourceRef: record.id,
            quote: null,
          });
      });
      logger.warn({ projectKey, emailId: record.id }, 'a recipient complained about a mail');
    }
    changed(projectKey);
    if (record.member)
      await notify(
        projectKey,
        record.member,
        record.taskKey,
        event.kind === 'bounce'
          ? `Your e-mail to ${name} bounced and was not delivered.`
          : `${name} complained about your e-mail. They will receive no more e-mail from the team.`,
      ).catch((err: unknown) => {
        logger.warn({ err, projectKey }, 'could not tell the sender about a delivery event');
      });
  }

  return { receive, deliveryEvent };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/.test(error.message);
}
