import { boundaryLeads } from '../domain/boundary';
import type { PermissionLevel, PermissionMode } from '../domain/member';
import { memberOf } from './lookup';
import type { ProjectConfig } from './schema';

/** The part of an AI member the level rules read. */
export interface PermissionFields {
  permissionLevel?: PermissionLevel;
  permissionMode?: PermissionMode;
}

/** The level a member without a stored level has, from its historical mode (decision on PM-164). */
export function permissionLevelFromMode(mode: PermissionMode | undefined): PermissionLevel {
  if (mode === 'plan') return 'plan';
  if (mode === 'auto') return 'auto';
  return 'ask_human';
}

/**
 * The member's permission level: the stored one, or the one its historical `permissionMode` maps
 * to. No automatic migration rewrites configurations (decision 26): an old member keeps its mode
 * until an owner sets a level, and no mapping gives a freer mode than the member already had.
 */
export function permissionLevelOf(member: PermissionFields): PermissionLevel {
  return member.permissionLevel ?? permissionLevelFromMode(member.permissionMode);
}

/**
 * The agent CLI's permission mode for a level. `bypassPermissions` is never produced. A read-only
 * placement narrows the result later, in `sessionPermissions`, so placement is not an input here.
 * `ask_ai` asks like `ask_human`; who answers is the runner's business, not the CLI's.
 */
export function cliPermissionMode(level: PermissionLevel): PermissionMode {
  switch (level) {
    case 'auto':
      return 'auto';
    case 'plan':
      return 'plan';
    case 'ask_ai':
    case 'ask_human':
      return 'default';
  }
}

/** The mode a member's sessions start in: the stored level's mode, else its historical mode. */
export function effectivePermissionMode(member: PermissionFields): PermissionMode {
  return member.permissionLevel
    ? cliPermissionMode(member.permissionLevel)
    : (member.permissionMode ?? 'default');
}

/** The member still runs in the historical "everything allowed" mode, which an owner can no longer pick. */
export function isLegacyBypass(member: PermissionFields): boolean {
  return member.permissionLevel === undefined && member.permissionMode === 'bypassPermissions';
}

/** Why "ask, AI decides" cannot be chosen for a member now. */
export type AskAiBlocker = 'delegation_off' | 'no_ai_decider';

/**
 * Whether "ask, AI decides" may be chosen for `handle`: delegation is on (`team.boundary.enabled`)
 * and some other AI member that is at work holds the boundary authorization duty. Null when it may.
 */
export function askAiBlocker(config: ProjectConfig, handle: string): AskAiBlocker | null {
  if (config.team.boundary?.enabled !== true) return 'delegation_off';
  // `boundaryLeads` already leaves out the requester, members on leave and a switched-off AI team.
  const decider = boundaryLeads(config, handle).some((lead) => memberOf(config, lead)?.kind === 'ai');
  return decider ? null : 'no_ai_decider';
}

/** The permission fields of an AI member's roster entry; one place for the server and the web's fake backend. */
export function permissionView(config: ProjectConfig, member: PermissionFields & { handle: string }) {
  const blocker = askAiBlocker(config, member.handle);
  return {
    permissionMode: member.permissionMode,
    permissionLevel: permissionLevelOf(member),
    ...(isLegacyBypass(member) ? { permissionLegacy: true as const } : {}),
    ...(blocker ? { askAiBlocker: blocker } : {}),
  };
}

/** The blocker of choosing `level` for `handle`; only "ask, AI decides" can be blocked. */
export function permissionLevelBlocker(
  config: ProjectConfig,
  handle: string,
  level: PermissionLevel,
): AskAiBlocker | null {
  return level === 'ask_ai' ? askAiBlocker(config, handle) : null;
}
