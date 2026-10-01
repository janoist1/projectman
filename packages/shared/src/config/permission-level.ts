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

/** The part of a session the permission rules read: an owner's settings for that session only (PM-170). */
export interface SessionPermissionFields {
  permissionModeOverride?: PermissionMode;
  approverOverride?: Approver;
}

/** Where a setting that applies to a session comes from: its member, or the session's own. */
export type PermissionSource = 'member' | 'session';

export interface EffectiveSessionPermissions {
  /** The CLI mode the session runs in (absent only for a member without one, which reads as `default`). */
  permissionMode: PermissionMode | undefined;
  approver: Approver;
  source: { mode: PermissionSource; approver: PermissionSource };
}

/**
 * The permission settings that apply to a session (PM-170): the session's own, set by an owner,
 * else its member's. One rule for the server (every start and resume, the permission inbox) and
 * the web (the session header). A session of a member that is gone has only its own settings.
 */
export function effectiveSessionPermissions(
  member: PermissionFields | null | undefined,
  session: SessionPermissionFields,
): EffectiveSessionPermissions {
  return {
    permissionMode: session.permissionModeOverride ?? member?.permissionMode,
    approver: session.approverOverride ?? approverOf(member ?? {}),
    source: {
      mode: session.permissionModeOverride ? 'session' : 'member',
      approver: session.approverOverride ? 'session' : 'member',
    },
  };
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
