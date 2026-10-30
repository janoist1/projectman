import { memberOf } from './lookup';
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
 * The member who put a todo in the machine queue (decision 66): for a screened question the screening
 * member, otherwise the item's source. The system as a screening member does not count (the todo the
 * system opens itself keeps its asker).
 */
export function machineTodoIssuerOf(source: string, screenedBy?: string): string {
  return screenedBy && screenedBy !== SYSTEM_ISSUER ? screenedBy : source;
}

/**
 * Whether `issuer` may put a machine todo in the owners' queue: the system (an obligation handover,
 * PM-806) or a member with machine access.
 * The system issuer counts only while no member has that handle: `system` is a valid handle, and a member
 * with it must not borrow the system's standing.
 */
export function machineTodoIssuerAllowed(config: Pick<ProjectConfig, 'team'>, issuer: string): boolean {
  const member = memberOf(config, issuer);
  if (member === undefined) return issuer === SYSTEM_ISSUER;
  return machineAccessOf(member);
}
