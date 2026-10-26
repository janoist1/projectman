import {
  DUTY_IDS,
  dutyMembers,
  emailChannelOn,
  emailSenderOf,
  isOperator,
  isProjectManager,
  memberOf,
  mergerOf,
} from '@projectman/shared';
import type { MemberHandle, ProjectConfig } from '@projectman/shared';
import type { MemberAudience } from '../../contracts';

/** The same audience for MCP requests and the owner's context preview. */
export function memberAudience(config: ProjectConfig, handle: MemberHandle): MemberAudience {
  const member = memberOf(config, handle);
  const merger = mergerOf(config);
  return {
    operator: isOperator(member),
    projectManager: isProjectManager(member),
    merger: merger.kind === 'member' && merger.handle === handle,
    email: emailChannelOn(config) && emailSenderOf(config, handle) !== null,
    duties: new Set(
      DUTY_IDS.filter((duty) => dutyMembers(config, duty).some((holder) => holder.handle === handle)),
    ),
  };
}
