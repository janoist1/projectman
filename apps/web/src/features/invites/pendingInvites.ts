import type { InvitationView } from '@projectman/shared';

/** An invitation that can still be accepted: not accepted, not revoked and not expired. */
export const isPendingInvite = (invite: InvitationView): boolean =>
  !invite.acceptedAt && !invite.revokedAt && Date.parse(invite.expiresAt) > Date.now();
