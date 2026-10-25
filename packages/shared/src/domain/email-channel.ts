import { z } from 'zod';
import { EmailMailbox } from '../config/schema';
import type { AiMemberConfig, MemberConfig, ProjectConfig } from '../config/schema';
import { HumanAccess, MemberHandle } from './member';
import { TaskKey } from './task';
import { findEmailAddresses, findPaths, findSecrets } from './system-feedback';

export const EMAIL_SUBJECT_MAX = 200;
export const EMAIL_TEXT_MAX = 20000;
export const EMAIL_QUOTE_MAX = 300;
export const EMAIL_REPLY_TOKEN_DAYS = 60;
export const EMAIL_CONTACT_SOURCE_DAYS = 7;
export const EMAIL_SENDS_PER_MEMBER_DAY = 30;
export const EMAIL_SENDS_PER_CONTACT_DAY = 10;
export const EMAIL_INBOUND_TEXT_MAX = 10000;
export const EMAIL_PARKED_ALERTS_PER_DAY = 20;
export const EMAIL_PARKED_TEXT_DAYS = 30;
export const EMAIL_LOG_PAGE = 20;

export const EmailOutboundStatus = z.enum([
  'pending_approval',
  'sending',
  'sent',
  'rejected',
  'cancelled',
  'failed',
  'bounced',
  'complained',
]);
export type EmailOutboundStatus = z.infer<typeof EmailOutboundStatus>;
export const EmailInboundStatus = z.enum(['delivered', 'parked']);
export type EmailInboundStatus = z.infer<typeof EmailInboundStatus>;
export const EmailParkReason = z.enum([
  'unknown_sender',
  'authentication_failed',
  'token_invalid',
  'token_expired',
  'channel_off',
  'unreadable',
  'sender_not_allowed',
]);
export type EmailParkReason = z.infer<typeof EmailParkReason>;
export const EmailContactSource = z.enum(['settings', 'message', 'email', 'complaint']);
export type EmailContactSource = z.infer<typeof EmailContactSource>;
export const EmailContentRefusalReason = z.enum([
  'task_not_visible',
  'secret',
  'path',
  'email_address',
  'label_id',
]);
export type EmailContentRefusalReason = z.infer<typeof EmailContentRefusalReason>;
export const EmailRecipientRefusal = z.enum(['not_member', 'not_human', 'no_address', 'not_wanted']);
export type EmailRecipientRefusal = z.infer<typeof EmailRecipientRefusal>;
export const EmailContactRefusal = z.enum([
  'request_required',
  'requester_not_allowed',
  'source_missing',
  'source_mismatch',
  'source_too_old',
]);
export type EmailContactRefusal = z.infer<typeof EmailContactRefusal>;
export const EmailSendFailure = z.enum(['rejected', 'throttled', 'not_configured', 'unavailable']);
export type EmailSendFailure = z.infer<typeof EmailSendFailure>;

export const EmailContact = z.object({
  handle: MemberHandle,
  displayName: z.string(),
  access: HumanAccess,
  address: z.string().nullable(),
  wants: z.boolean(),
  changedBy: z.string().nullable(),
  changedAt: z.string().nullable(),
  requestedBy: MemberHandle.nullable(),
  source: EmailContactSource.nullable(),
});
export type EmailContact = z.infer<typeof EmailContact>;
export const EmailSenderView = z.object({
  handle: MemberHandle,
  displayName: z.string(),
  sendWithoutApproval: z.boolean(),
  /** The member's mailbox name: the chosen one, or the handle. */
  mailbox: z.string(),
  /** The member's own address; null without a channel on the server, with the channel off, or on a conflict. */
  address: z.string().nullable(),
  /** Another member's mailbox is the same, so neither has an address until one is renamed. */
  addressConflict: z.boolean(),
});
export type EmailSenderView = z.infer<typeof EmailSenderView>;
export const EmailChannelView = z.object({
  configured: z.boolean(),
  enabled: z.boolean(),
  fromAddress: z.string().nullable(),
  /** The domain of the members' addresses; null when the channel is not set up on the server. */
  memberDomain: z.string().nullable(),
  senders: z.array(EmailSenderView),
  contacts: z.array(EmailContact),
});
export type EmailChannelView = z.infer<typeof EmailChannelView>;
export const EmailLogEntry = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('outbound'),
    id: z.string(),
    at: z.string(),
    member: MemberHandle,
    contact: MemberHandle,
    taskKey: TaskKey.nullable(),
    subject: z.string(),
    text: z.string(),
    status: EmailOutboundStatus,
    decidedBy: MemberHandle.nullable(),
    decidedAt: z.string().nullable(),
    note: z.string().nullable(),
  }),
  z.object({
    kind: z.literal('inbound'),
    id: z.string(),
    at: z.string(),
    member: MemberHandle.nullable(),
    contact: MemberHandle.nullable(),
    fromAddress: z.string(),
    taskKey: TaskKey.nullable(),
    subject: z.string(),
    text: z.string(),
    status: EmailInboundStatus,
    parkReason: EmailParkReason.nullable(),
    attachmentNames: z.array(z.string()),
  }),
  z.object({
    kind: z.literal('setting'),
    id: z.string(),
    at: z.string(),
    contact: MemberHandle,
    wants: z.boolean(),
    by: z.string(),
    requestedBy: MemberHandle.nullable(),
    source: EmailContactSource,
    quote: z.string().nullable(),
    sourceRef: z.string().nullable(),
  }),
]);
export type EmailLogEntry = z.infer<typeof EmailLogEntry>;
export const EmailLogResponse = z.object({
  entries: z.array(EmailLogEntry),
  nextCursor: z.string().nullable(),
});
export type EmailLogResponse = z.infer<typeof EmailLogResponse>;
export const SetEmailContactRequest = z.strictObject({ wants: z.boolean() });
export type SetEmailContactRequest = z.infer<typeof SetEmailContactRequest>;

export function emailChannelOn(config: ProjectConfig): boolean {
  return config.project.email?.enabled === true;
}

export function emailSenderOf(
  config: ProjectConfig,
  handle: string,
): { sendWithoutApproval: boolean } | null {
  const member = config.team.members.find((member) => member.handle === handle);
  return member?.kind === 'ai' && member.email?.enabled
    ? { sendWithoutApproval: member.email.sendWithoutApproval ?? false }
    : null;
}

/** The local part of an AI member's own address (PM-989): the chosen mailbox, or the handle. */
export function emailMailboxOf(member: AiMemberConfig): string {
  return member.email?.mailbox ?? member.handle;
}

/** The AI members whose own address is live (channel on, member allowed to send) under this mailbox name. */
export function emailMailboxOwners(
  configs: readonly ProjectConfig[],
  mailbox: string,
): { projectKey: string; handle: string }[] {
  return configs.flatMap((config) =>
    emailChannelOn(config)
      ? config.team.members
          .filter(
            (member): member is AiMemberConfig =>
              member.kind === 'ai' &&
              !!emailSenderOf(config, member.handle) &&
              emailMailboxOf(member) === mailbox,
          )
          .map((member) => ({ projectKey: config.project.key, handle: member.handle }))
      : [],
  );
}

/** Whether another AI member, in any project and switches aside, already has this mailbox name. */
export function emailMailboxTaken(
  configs: readonly ProjectConfig[],
  projectKey: string,
  handle: string,
  mailbox: string,
): boolean {
  return configs.some((config) =>
    config.team.members.some(
      (member) =>
        member.kind === 'ai' &&
        !(config.project.key === projectKey && member.handle === handle) &&
        emailMailboxOf(member) === mailbox,
    ),
  );
}

export function emailMemberAddress(mailbox: string, domain: string): string {
  return `${mailbox}@${domain}`;
}

/** The mailbox of an address at the members' domain, or null (not that domain, or a reply address). */
export function parseEmailMemberAddress(address: string, domain: string): string | null {
  const match = /^([^@]+)@(.+)$/.exec(address);
  if (!match || match[2] !== domain) return null;
  return EmailMailbox.safeParse(match[1]).success ? match[1]! : null;
}

/**
 * An AI member's email settings after a change (PM-956). Omitted fields stay, except that sending
 * without approval never outlives the permission to send: switching sending off clears it, and
 * switching it on starts from "needs approval" unless the same change says otherwise.
 */
export function applyMemberEmailChange(
  current: { enabled: boolean; sendWithoutApproval?: boolean; mailbox?: string } | undefined,
  change: { enabled?: boolean; sendWithoutApproval?: boolean; mailbox?: string },
): { enabled: boolean; sendWithoutApproval?: boolean; mailbox?: string } {
  const wasEnabled = current?.enabled === true;
  const enabled = change.enabled ?? wasEnabled;
  const rest = { ...current, ...change, enabled };
  if (!enabled) return { ...rest, sendWithoutApproval: false };
  if (!wasEnabled) return { ...rest, sendWithoutApproval: change.sendWithoutApproval ?? false };
  return rest;
}

export function emailRecipientRefusal(
  member: MemberConfig | undefined,
  wants: boolean,
): EmailRecipientRefusal | null {
  if (!member) return 'not_member';
  if (member.kind !== 'human') return 'not_human';
  if (!member.email) return 'no_address';
  return wants ? null : 'not_wanted';
}

export interface EmailContentContext {
  projectKey: string;
  canSee: (taskKey: string) => boolean;
  recipientAccess: HumanAccess;
  labelIds: readonly string[];
  allowedAddresses: readonly string[];
  secrets: readonly string[];
  paths: readonly string[];
}
export interface EmailContentRefusal {
  reason: EmailContentRefusalReason;
  match?: string;
}
const escapePattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const whole = (pattern: string) => new RegExp(`(?<![\\p{L}\\p{N}_-])${pattern}(?![\\p{L}\\p{N}_-])`, 'gu');

export function emailContentRefusals(
  input: { subject: string; text: string; taskKey: string | null },
  ctx: EmailContentContext,
): EmailContentRefusal[] {
  const text = `${input.subject}\n${input.text}`;
  const tasks = new Set(text.match(new RegExp(`${escapePattern(ctx.projectKey)}-\\d+`, 'g')) ?? []);
  if (input.taskKey) tasks.add(input.taskKey);
  const refusals: EmailContentRefusal[] = [...tasks]
    .filter((key) => !ctx.canSee(key))
    .map((match) => ({ reason: 'task_not_visible', match }));
  if (findSecrets(text, ctx.secrets)) refusals.push({ reason: 'secret' });
  if (findPaths(text, ctx.paths)) refusals.push({ reason: 'path' });
  const allowed = new Set(ctx.allowedAddresses.map((address) => address.toLowerCase()));
  for (const match of findEmailAddresses(text))
    if (!allowed.has(match.toLowerCase())) refusals.push({ reason: 'email_address', match });
  if (ctx.recipientAccess === 'client')
    for (const match of new Set(ctx.labelIds))
      if (match && whole(escapePattern(match)).test(text)) refusals.push({ reason: 'label_id', match });
  return refusals;
}

export interface EmailContactChangeInput {
  wants: boolean;
  target: string;
  requestedBy: string | null;
  caller: string;
  ownersAndAdmins: readonly string[];
  source:
    | { kind: 'message'; from: string; to: readonly string[]; at: string }
    | { kind: 'email'; from: string }
    | null;
  now: string;
}
export function emailContactChangeRefusal(input: EmailContactChangeInput): EmailContactRefusal | null {
  const { wants, target, requestedBy, caller, ownersAndAdmins, source, now } = input;
  if (!requestedBy) return 'request_required';
  if (wants && requestedBy !== target && !ownersAndAdmins.includes(requestedBy))
    return 'requester_not_allowed';
  if (!source) return wants ? 'source_missing' : null;
  if (source.kind === 'email')
    return source.from === target && target === requestedBy ? null : 'source_mismatch';
  if (source.from !== requestedBy || !source.to.includes(caller)) return 'source_mismatch';
  const age = Date.parse(now) - Date.parse(source.at);
  if (!Number.isFinite(age) || age < 0 || age > EMAIL_CONTACT_SOURCE_DAYS * 86400000) return 'source_too_old';
  return null;
}

export function emailReplyAddress(projectKey: string, token: string, domain: string): string {
  return `r-${projectKey.toLowerCase()}-${token}@${domain}`;
}
export function parseEmailReplyAddress(
  address: string,
  domain: string,
): { projectKey: string; token: string } | null {
  const match = new RegExp(`^r-([a-z][a-z0-9]{0,9})-([a-z2-7]{26})@${escapePattern(domain)}$`).exec(address);
  return match && match[0] === address ? { projectKey: match[1]!.toUpperCase(), token: match[2]! } : null;
}
