import {
  DUTY_IDS,
  cardMerger,
  dutyMembers,
  emailChannelOn,
  emailSenderOf,
  hasMachineAccess,
  isProjectManager,
  memberOf,
} from '@projectman/shared';
import type { MemberHandle, ProjectConfig } from '@projectman/shared';
import type { MemberAudience } from '../../contracts';

/** The same audience for MCP requests and the owner's context preview. */
export function memberAudience(config: ProjectConfig, handle: MemberHandle): MemberAudience {
  const member = memberOf(config, handle);
  return {
    projectManager: isProjectManager(member),
    // The list is session-wide: include anyone who can merge a card under this policy.
    merger: cardMerger(config, { assignee: handle }, handle) === handle,
    email: emailChannelOn(config) && emailSenderOf(config, handle) !== null,
    machineAccess: hasMachineAccess(config, handle),
    duties: new Set(
      DUTY_IDS.filter((duty) => dutyMembers(config, duty).some((holder) => holder.handle === handle)),
    ),
  };
}
