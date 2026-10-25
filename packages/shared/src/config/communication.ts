import type { HumanAccess } from '../domain/member';
import { memberOf } from './lookup';
import { operatorOf } from './operator-member';
import type { ProjectConfig } from './schema';

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

/**
 * Whether a team message from `from` to `to` is refused for who the sender is (PM-985):
 * - a contact-restricted sender writes only to contacts: one recipient who is none refuses the whole
 *   message (`recipient_not_contact`), the Operator included;
 * - a read-only viewer writes only to the Operator (`insufficient_access`);
 * - anyone else, and the system, has no limit here.
 * Not a membership check: the caller's own authentication and recipient checks stay.
 */
export function teamMessageRecipientRefusal(
  config: Pick<ProjectConfig, 'team'>,
  from: string,
  to: readonly string[],
): TeamMessageRecipientRefusal | null {
  const access = accessOfHandle(config, from);
  const distinct = [...new Set(to)];
  if (isContactRestricted(access)) {
    const contacts = new Set(contactHandles(config));
    const refused = distinct.filter((handle) => !contacts.has(handle));
    return refused.length > 0 ? { code: 'recipient_not_contact', recipients: refused } : null;
  }
  if (access === 'viewer') {
    const operator = operatorOf(config)?.handle;
    const refused = distinct.filter((handle) => handle !== operator);
    return refused.length > 0 ? { code: 'insufficient_access', recipients: refused } : null;
  }
  return null;
}

/**
 * The members a contact-restricted writer may address: the contacts. Everyone else may address every
 * member the caller already offers; `null` means no extra limit.
 */
export function writableContactHandles(
  config: Pick<ProjectConfig, 'team'>,
  access: CommunicationAccess,
): string[] | null {
  return isContactRestricted(access) ? contactHandles(config) : null;
}
