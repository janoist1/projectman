import type { HumanAccess } from '../domain/member';
import { memberOf } from './lookup';
import { projectManagerOf } from './project-manager';
import type { ProjectConfig, ViewerRecipients } from './schema';

/** A member's access level as the rules below see it: `ai` for an AI member, absent for a non-member. */
export type CommunicationAccess = HumanAccess | 'ai' | undefined;

/**
 * Whether a member may write team messages only to the project's contacts (PM-985): the member who
 * can read and comment but is not part of the team's work. Today that is the `client` access.
 */
export function isContactRestricted(access: CommunicationAccess): boolean {
  return access === 'client';
}

/** Whether a member may add a comment to a card they see: everyone but the read-only viewer. */
export function canCommentOnTask(access: CommunicationAccess): boolean {
  return access !== undefined && access !== 'viewer';
}

/** The project's contacts: current members only, once each, in the configured order. */
export function contactHandles(config: Pick<ProjectConfig, 'team'>): string[] {
  const current = new Set(config.team.members.map((member) => member.handle));
  return [...new Set(config.team.contacts ?? [])].filter((handle) => current.has(handle));
}

/** Whether the member with this handle is one of the project's contacts. */
export function isContact(config: Pick<ProjectConfig, 'team'>, handle: string | null | undefined): boolean {
  return !!handle && contactHandles(config).includes(handle);
}

/** The access level of the configured member with this handle (`undefined`: no such member). */
export function accessOfHandle(
  config: Pick<ProjectConfig, 'team'>,
  handle: string | null | undefined,
): CommunicationAccess {
  const member = memberOf(config, handle);
  if (!member) return undefined;
  return member.kind === 'ai' ? 'ai' : member.access;
}

/** Whether the configured member with this handle may write only to the contacts. */
export function isContactRestrictedMember(
  config: Pick<ProjectConfig, 'team'>,
  handle: string | null | undefined,
): boolean {
  return isContactRestricted(accessOfHandle(config, handle));
}

export type TeamMessageRecipientRefusal = {
  code: 'recipient_not_contact' | 'insufficient_access';
  /** The distinct recipients the sender may not write to. */
  recipients: string[];
};

/** A read-only viewer writes only to the project manager unless the project says otherwise (PM-1102). */
export const DEFAULT_VIEWER_RECIPIENTS: ViewerRecipients = 'project_manager';

/** Whom a read-only viewer may write to in this project. */
export function viewerRecipientsOf(config: Pick<ProjectConfig, 'team'>): ViewerRecipients {
  return config.team.viewerRecipients ?? DEFAULT_VIEWER_RECIPIENTS;
}

/**
 * Whether a member of this access has a recipient limit at all (client, viewer). Config-free, so the web
 * can ask it before the configuration has loaded.
 */
export function hasRecipientLimit(access: CommunicationAccess): boolean {
  return isContactRestricted(access) || access === 'viewer';
}

/** The members a limited access may write to and the refusal code for any other (`null`: no limit). */
function recipientLimit(
  config: Pick<ProjectConfig, 'team'>,
  access: CommunicationAccess,
): { handles: string[]; code: TeamMessageRecipientRefusal['code'] } | null {
  if (isContactRestricted(access) || (access === 'viewer' && viewerRecipientsOf(config) === 'contacts'))
    return { handles: contactHandles(config), code: 'recipient_not_contact' };
  if (access === 'viewer') {
    const manager = projectManagerOf(config);
    return { handles: manager ? [manager.handle] : [], code: 'insufficient_access' };
  }
  return null;
}

/**
 * Whom this access may write to (PM-985, PM-1102): a client the contacts; a viewer the project manager or,
 * by the project's setting, the contacts. `null`: no limit beyond the members the caller already offers.
 */
export function writableRecipientHandles(
  config: Pick<ProjectConfig, 'team'>,
  access: CommunicationAccess,
): string[] | null {
  return recipientLimit(config, access)?.handles ?? null;
}

/** The refusal of a team message to `to` for the sender's access alone; `null` when every recipient is allowed. */
export function recipientRefusalForAccess(
  config: Pick<ProjectConfig, 'team'>,
  access: CommunicationAccess,
  to: readonly string[],
): TeamMessageRecipientRefusal | null {
  const limit = recipientLimit(config, access);
  if (!limit) return null;
  const refused = [...new Set(to)].filter((handle) => !limit.handles.includes(handle));
  return refused.length > 0 ? { code: limit.code, recipients: refused } : null;
}

/**
 * Whether a team message from `from` to `to` is refused for who the sender is (PM-985, PM-1102): a client
 * writes only to the contacts (`recipient_not_contact`); a read-only viewer only to the project manager
 * (`insufficient_access`) or, when the project says so, the contacts (`recipient_not_contact`); anyone
 * else, and the system, has no limit here.
 * Not a membership check: the caller's own authentication and recipient checks stay.
 */
export function teamMessageRecipientRefusal(
  config: Pick<ProjectConfig, 'team'>,
  from: string,
  to: readonly string[],
): TeamMessageRecipientRefusal | null {
  return recipientRefusalForAccess(config, accessOfHandle(config, from), to);
}
