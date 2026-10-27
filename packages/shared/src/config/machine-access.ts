import { memberOf } from './lookup';
import { isOperator } from './operator-member';
import { isProjectManager } from './project-manager';
import type { MemberConfig, ProjectConfig } from './schema';

/** The issuer of todos the system opens itself, such as an obligation handover (PM-806). */
const SYSTEM_ISSUER = 'system';

/**
 * Whether an AI member may put machine work (an installation, a setting) in the owners' queue (decision 66).
 * The member's own setting wins; absent, a project manager has it (what it could do before the setting
 * existed) and nobody else. A temp worker and a person never have it: a person connects their own Claude.
 */
export function machineAccessOf(member: MemberConfig): boolean {
  if (member.kind !== 'ai' || member.temp) return false;
  return member.machineAccess ?? isProjectManager(member);
}

/** Whether the member with this handle has machine access (`machineAccessOf`). */
export function hasMachineAccess(config: Pick<ProjectConfig, 'team'>, handle: string): boolean {
  const member = memberOf(config, handle);
  return member !== undefined && machineAccessOf(member);
}

/**
 * Whether `issuer` may put a machine todo in the owners' queue: the system (an obligation handover,
 * PM-806), the Operator member (until its handovers go, PM-1003, PM-1076) or a member with machine access.
 * The system issuer counts only while no member has that handle: `system` is a valid handle, and a member
 * with it must not borrow the system's standing.
 */
export function machineTodoIssuerAllowed(config: Pick<ProjectConfig, 'team'>, issuer: string): boolean {
  const member = memberOf(config, issuer);
  if (member === undefined) return issuer === SYSTEM_ISSUER;
  return isOperator(member) || machineAccessOf(member);
}
