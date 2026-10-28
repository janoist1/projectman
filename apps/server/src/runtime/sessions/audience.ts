import {
  DUTY_IDS,
  cardMerger,
  dutyMembers,
  emailChannelOn,
  emailSenderOf,
  hasMachineAccess,
  hostRequestRefusal,
  isProjectManager,
  memberOf,
} from '@projectman/shared';
import type { MemberHandle, ProjectConfig } from '@projectman/shared';
import type { MemberAudience } from '../../contracts';

/** The same audience for MCP requests and the owner's context preview. */
export function memberAudience(
  config: ProjectConfig,
  handle: MemberHandle,
  instance: { hostOwnerEmail: string | null } = { hostOwnerEmail: null },
): MemberAudience {
  const member = memberOf(config, handle);
  return {
    projectManager: isProjectManager(member),
    // The list is session-wide: include anyone who can merge a card under this policy.
    merger: cardMerger(config, { assignee: handle }, handle) === handle,
    email: emailChannelOn(config) && emailSenderOf(config, handle) !== null,
    machineAccess: hasMachineAccess(config, handle),
    hostRequests: hostRequestRefusal(config, handle, instance.hostOwnerEmail) === null,
    duties: new Set(
      DUTY_IDS.filter((duty) => dutyMembers(config, duty).some((holder) => holder.handle === handle)),
    ),
  };
}
