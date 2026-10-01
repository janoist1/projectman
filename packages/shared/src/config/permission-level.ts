import { boundaryLeads } from '../domain/boundary';
import type { Approver, PermissionMode } from '../domain/member';
import { memberOf } from './lookup';
import type { ProjectConfig } from './schema';

/** The part of an AI member the permission rules read. */
export interface PermissionFields {
  permissionMode?: PermissionMode;
  approver?: Approver;
}

/** Who answers when the CLI asks: the stored approver, else a person (the behaviour from before the setting). */
export function approverOf(member: Pick<PermissionFields, 'approver'>): Approver {
  return member.approver ?? 'human';
}

/** The member still runs in the historical "everything allowed" mode, which an owner can no longer pick. */
export function isLegacyBypass(member: Pick<PermissionFields, 'permissionMode'>): boolean {
  return member.permissionMode === 'bypassPermissions';
}

/** Why an AI approver cannot be chosen for a member now. */
export type AiApproverBlocker = 'delegation_off' | 'no_ai_decider';

/**
 * Whether the approver "AI" may be chosen for `handle`: delegation is on (`team.boundary.enabled`)
 * and some other AI member that is at work holds the boundary authorization duty. Null when it may.
 */
export function aiApproverBlocker(config: ProjectConfig, handle: string): AiApproverBlocker | null {
  if (config.team.boundary?.enabled !== true) return 'delegation_off';
  // `boundaryLeads` already leaves out the requester, members on leave and a switched-off AI team.
  const decider = boundaryLeads(config, handle).some((lead) => memberOf(config, lead)?.kind === 'ai');
  return decider ? null : 'no_ai_decider';
}

/** The blocker of choosing `approver` for `handle`; only the AI approver can be blocked. */
export function approverBlocker(
  config: ProjectConfig,
  handle: string,
  approver: Approver,
): AiApproverBlocker | null {
  return approver === 'ai' ? aiApproverBlocker(config, handle) : null;
}

/**
 * The permission fields of an AI member's roster entry; one place for the server and the web's fake
 * backend. `aiApproverBlocker` is present only while the AI approver cannot be chosen for the member.
 */
export function permissionView(config: ProjectConfig, member: PermissionFields & { handle: string }) {
  const blocker = aiApproverBlocker(config, member.handle);
  return {
    permissionMode: member.permissionMode,
    approver: approverOf(member),
    ...(isLegacyBypass(member) ? { permissionLegacy: true as const } : {}),
    ...(blocker ? { aiApproverBlocker: blocker } : {}),
  };
}
