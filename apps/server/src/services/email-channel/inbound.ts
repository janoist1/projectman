import { randomUUID } from 'node:crypto';
import PostalMime from 'postal-mime';
import {
  ALERT_SEEN_OPTION,
  EMAIL_INBOUND_TEXT_MAX,
  EMAIL_PARKED_ALERTS_PER_DAY,
  EMAIL_SUBJECT_MAX,
  SYSTEM_SENDER,
  emailChannelOn,
  emailSenderOf,
  isOpenTask,
  parseEmailReplyAddress,
} from '@projectman/shared';
import type { EmailParkedAlert, EmailParkReason, InboxItem, ProjectConfig } from '@projectman/shared';
import type { EmailMessageRecord } from '../../db';
import type { DomainContext } from '../../core/base';
import type { InboxService } from '../../core/inbox';
import type { Messaging } from '../../core/messages';
import type { ProjectService } from '../../core/projects';
import type { TaskService } from '../../core/tasks';
import type { EmailChannelEnv } from './config';
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
};

function limited(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/** Only the bodies and names are read: the content of an attachment is dropped, never stored or run. */
async function parse(raw: Uint8Array): Promise<Parsed | null> {
  try {
    const email = await PostalMime.parse(raw);
    const fromAddress = email.from?.address?.trim().toLowerCase();
    if (!fromAddress) return null;
    const body = email.text?.trim() ? email.text : htmlToText(email.html ?? '');
    return {
      fromAddress: limited(fromAddress, ADDRESS_MAX),
      subject: limited((email.subject ?? '').trim(), EMAIL_SUBJECT_MAX),
      text: cleanReplyText(body),
      attachmentNames: email.attachments
        .slice(0, ATTACHMENT_NAMES_MAX)
        .map((attachment) => limited(attachment.filename ?? 'attachment', ATTACHMENT_NAME_MAX)),
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
  projects: ProjectService;
  tasks: TaskService;
  env?: EmailChannelEnv;
  replyKey?: Buffer;
  now: () => Date;
  changed: (projectKey: string) => void;
  notify: (projectKey: string, member: string, taskKey: string | null, text: string) => Promise<void>;
  publishInbox: (item: InboxItem | null) => void;
}): EmailInbound {
  const { ctx, repo, inbox, messaging, projects, tasks, env, replyKey, now, changed, notify } = deps;
  const { logger } = ctx;

  function park(
    projectKey: string,
    config: ProjectConfig,
    mail: InboundMail,
    reason: EmailParkReason,
    parsed: Parsed | null,
    outbound: EmailMessageRecord | null,
  ): 'parked' | 'duplicate' {
    const at = now().toISOString();
    const text = limited(parsed?.text ?? '', EMAIL_INBOUND_TEXT_MAX);
    let record: EmailMessageRecord;
    try {
      record = repo.messages.insert({
        projectKey,
        direction: 'inbound',
        member: outbound?.member ?? null,
        contact: outbound?.contact ?? null,
        taskKey: outbound?.taskKey ?? null,
        subject: parsed?.subject ?? '',
        text,
        status: 'parked',
        parkReason: reason,
        note: null,
        fromAddress: parsed?.fromAddress ?? '',
        attachmentNames: parsed?.attachmentNames ?? [],
        replyTokenHash: null,
        replyExpiresAt: null,
        inReplyTo: outbound?.id ?? null,
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
    if (repo.countAlertedSince(projectKey, since) >= EMAIL_PARKED_ALERTS_PER_DAY || assignees.length === 0) {
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

  async function receive(mail: InboundMail): Promise<'delivered' | 'parked' | 'duplicate' | 'dropped'> {
    if (repo.messages.byProviderId(mail.providerId)) return 'duplicate';
    const dropped = (why: string) => {
      logger.warn({ providerId: mail.providerId }, `a received mail was dropped: ${why}`);
      return 'dropped' as const;
    };
    if (!env || !replyKey) return dropped('the e-mail channel is not configured');
    let address: { projectKey: string; token: string } | null = null;
    for (const recipient of mail.recipients) {
      address = parseEmailReplyAddress(recipient.trim().toLowerCase(), env.replyDomain);
      if (address) break;
    }
    if (!address) return dropped('no reply address');
    const config = await projects.config(address.projectKey).catch(() => null);
    if (!config) return dropped('unknown project');
    const projectKey = address.projectKey;

    const parsed = await parse(mail.raw);
    if (!parsed) return park(projectKey, config, mail, 'unreadable', null, null);
    const outbound = repo.messages.byTokenHash(replyTokenHash(replyKey, address.token));
    const known = outbound?.direction === 'outbound' && outbound.projectKey === projectKey ? outbound : null;
    const fail = (reason: EmailParkReason) => park(projectKey, config, mail, reason, parsed, known);
    if (!known) return fail('token_invalid');
    if (known.replyExpiresAt && known.replyExpiresAt < now().toISOString()) return fail('token_expired');
    const { dmarc, spam, virus } = mail.verdicts;
    if (dmarc !== 'pass' || spam === 'fail' || virus === 'fail') return fail('authentication_failed');
    const contact = config.team.members.find((member) => member.handle === known.contact);
    if (contact?.kind !== 'human' || !contact.email || contact.email.toLowerCase() !== parsed.fromAddress)
      return fail('unknown_sender');
    if (!emailChannelOn(config) || !emailSenderOf(config, known.member ?? '')) return fail('channel_off');

    // The row comes first: its unique provider id claims the mail, so a second delivery of it (the queue
    // delivers at least once) stops here and the member gets the message once.
    const emailId = `eml_${randomUUID()}`;
    const at = now().toISOString();
    try {
      repo.messages.insert({
        id: emailId,
        projectKey,
        direction: 'inbound',
        member: known.member,
        contact: contact.handle,
        taskKey: known.taskKey,
        subject: parsed.subject,
        text: parsed.text,
        status: 'delivered',
        parkReason: null,
        note: null,
        fromAddress: parsed.fromAddress,
        attachmentNames: parsed.attachmentNames,
        replyTokenHash: null,
        replyExpiresAt: null,
        inReplyTo: known.id,
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
    const task = known.taskKey ? tasks.find(projectKey, known.taskKey) : null;
    let message: Awaited<ReturnType<Messaging['send']>>;
    try {
      message = await messaging.send(
        projectKey,
        contact.handle,
        {
          to: [known.member!],
          taskKey: task && isOpenTask(task) ? task.key : null,
          text: parsed.text,
        },
        { kind: 'action', email: { emailId, subject: parsed.subject } },
      );
    } catch (error) {
      // Nothing was sent: free the provider id, so the redelivery of the mail can try again.
      repo.messages.remove(emailId);
      throw error;
    }
    repo.messages.update(emailId, { messageId: message.id, updatedAt: now().toISOString() });
    changed(projectKey);
    return 'delivered';
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
