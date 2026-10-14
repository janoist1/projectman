export { MemberService, createMemberService, MemberProfiles } from '../../domain/members';
export { InvitationService } from '../../domain/invitations';
export { PresenceService } from '../../domain/presence';
export {
  requireMemberAccess,
  requireHuman,
  requireAiMember,
  findHumanByEmail,
  projectAccessFor,
} from '../../domain/access';
export type { ProjectAccess, AccessRefusal } from '../../domain/access';
export { defaultMemberHandle, defaultMemberName } from '../../domain/naming';
export type { InvitationUser, InvitationAccounts, MemberProfileSessions, MemberCapacity } from './ports';
