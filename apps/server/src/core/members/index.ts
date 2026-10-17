export { MemberService, createMemberService, MemberProfiles } from './members';
export { InvitationService } from './invitations';
export { PresenceService } from './presence';
export { createEmailLoginDirectory } from './client-standing';
export {
  requireMemberAccess,
  requireHuman,
  requireAiMember,
  findHumanByEmail,
  projectAccessFor,
  bindSuperPrincipal,
} from './access';
export type { ProjectAccess, AccessRefusal } from './access';
export { defaultMemberHandle, defaultMemberName } from './naming';
export type { InvitationUser, InvitationAccounts, MemberProfileSessions, MemberCapacity } from './ports';
