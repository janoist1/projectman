import type { Actor } from '../domain/event';
import type { AgentProvider, HumanAccess } from '../domain/member';
import type { TaskKey, Visibility } from '../domain/task';
import type { AiMemberConfig, ProjectConfig } from './schema';
import { canonical } from './canonical';
import { boundaryDelegationChanged, permissionsChanged } from './owner-only';
import { memberDuties, roleBundle } from './duties';
import { operatorFixedChange } from './operator';
import { operatorOf } from './operator-member';

/**
 * What stays the owner's in super mode (owner decision of 2026-10-20, PM-862 K3): deleting a member, key,
 * project or repository; their own login and the security settings; the paid cost. Everything else the
 * Operator may do with the super key, in its own name.
 */
export type OwnerReservedEffect = 'deletion' | 'security' | 'cost';
export type SuperRoutineMutation =
  | 'task_write'
  | 'task_create'
  | 'task_start'
  | 'inbox_resolve'
  | 'task_labels'
  | 'task_move'
  | 'message_send'
  | 'invite_create'
  | 'guest_update'
  | 'engine_create'
  | 'engine_default'
  | 'merge_start'
  | 'merge_order'
  | 'project_pause'
  | 'project_resume'
  | 'session_stop'
  | 'session_restart'
  | 'release_prepare'
  | 'release_propose'
  | 'member_update';
/** The protected administration adapter's commands (PM-763); none is owner-reserved any more. */
export const SUPER_ADMINISTRATION_COMMANDS = [
  'restart',
  'full_test',
  'image_build',
  'deploy',
  'process_cleanup',
] as const;
export type SuperAdministrationCommand = (typeof SUPER_ADMINISTRATION_COMMANDS)[number];
export type SuperMutationCommand =
  | { kind: 'config_change'; next: ProjectConfig }
  | { kind: 'task_visibility'; taskKey: TaskKey | null; before: Visibility | null; after: Visibility }
  | {
      kind: 'remove';
      resource:
        | 'member'
        | 'repo'
        | 'role'
        | 'label'
        | 'stage'
        | 'column'
        | 'feedback_surface'
        | 'invitation'
        | 'guest'
        | 'engine'
        | 'attachment'
        | 'message_attachment'
        | 'task'
        | 'project'
        | 'credential';
      id: string;
    }
  | { kind: 'access_change'; handle: string; before: HumanAccess | null; after: HumanAccess }
  /** An AI member's permission mode, approver or outbound network setting. */
  | { kind: 'permission_change'; handle: string }
  | { kind: 'focus_change'; before: TaskKey[]; after: TaskKey[] }
  | { kind: 'runtime_start'; providers: AgentProvider[] }
  | { kind: 'administration'; command: SuperAdministrationCommand }
  | { kind: 'routine'; operation: SuperRoutineMutation };

const routines = new Set<SuperRoutineMutation>([
  'task_write',
  'task_create',
  'task_start',
  'inbox_resolve',
  'task_labels',
  'task_move',
  'message_send',
  'invite_create',
  'guest_update',
  'engine_create',
  'engine_default',
  'merge_start',
  'merge_order',
  'project_pause',
  'project_resume',
  'session_stop',
  'session_restart',
  'release_prepare',
  'release_propose',
  'member_update',
]);

const DELETION_RESOURCES = new Set<string>(['member', 'repo', 'project', 'credential']);

/**
 * The owner's own login and security settings changed: a human's access level, login e-mail or a human turned
 * into another kind of member, a new owner, the Operator waiver, the AI members' permission settings and the
 * boundary delegation (the owner kept the last two on 2026-10-20, PM-862 inventory row 33).
 */
function securityChanged(previous: ProjectConfig, next: ProjectConfig): boolean {
  if (operatorSelfChanged(previous, next)) return true;
  if ((previous.team.operatorApprovalWaiver ?? false) !== (next.team.operatorApprovalWaiver ?? false))
    return true;
  if (permissionsChanged(previous, next) || boundaryDelegationChanged(previous, next)) return true;
  // A human who is no longer a human under the same handle loses the login and the access level.
  if (
    previous.team.members.some(
      (before) =>
        before.kind === 'human' &&
        next.team.members.some((member) => member.handle === before.handle && member.kind !== 'human'),
    )
  )
    return true;
  const login = (email: string | undefined) => (email ?? '').trim().toLowerCase();
  return next.team.members.some((member) => {
    if (member.kind !== 'human') return false;
    const before = previous.team.members.find((m) => m.handle === member.handle);
    if (before?.kind !== 'human') return member.access === 'owner';
    // The e-mail is the member's login binding: rebinding it changes who can sign in as them.
    return before.access !== member.access || login(before.email) !== login(member.email);
  });
}

/** The Operator cannot rewrite its own member or role using its delegated authority. */
function operatorSelfChanged(previous: ProjectConfig, next: ProjectConfig): boolean {
  if (operatorFixedChange(previous, next)) return true;
  const operator = operatorOf(previous);
  return (
    !!operator &&
    (canonical(operator) !== canonical(next.team.members.find((m) => m.handle === operator.handle)) ||
      canonical(roleBundle(previous, operator.role)) !== canonical(roleBundle(next, operator.role)))
  );
}

/** Shared by command planning and the final configuration commit, including direct super writes. */
export function superConfigMutations(previous: ProjectConfig, next: ProjectConfig): SuperMutationCommand[] {
  const mutations: SuperMutationCommand[] = [{ kind: 'config_change', next }];
  const permissions = new Set<string>();
  for (const before of previous.team.members) {
    const after = next.team.members.find((m) => m.handle === before.handle);
    if (
      after &&
      memberDuties(previous, before).includes('boundary_authorization') !==
        memberDuties(next, after).includes('boundary_authorization')
    )
      permissions.add(before.handle);
  }
  if (operatorSelfChanged(previous, next)) {
    const operator = operatorOf(previous) ?? operatorOf(next);
    if (operator) permissions.add(operator.handle);
  }
  for (const handle of permissions) mutations.push({ kind: 'permission_change', handle });
  return mutations;
}

/** Server-generated authorization projection, never an executable command or a client exemption. */
export function ownerReservedEffect(
  previous: ProjectConfig | null,
  command: SuperMutationCommand,
): OwnerReservedEffect | null {
  switch (command.kind) {
    case 'remove':
      return DELETION_RESOURCES.has(command.resource) ? 'deletion' : null;
    case 'access_change':
    case 'permission_change':
      return 'security';
    case 'task_visibility':
    case 'focus_change':
      return null;
    case 'runtime_start':
      if (command.providers.some((provider) => !['claude', 'codex', 'gemini', 'nanogpt'].includes(provider)))
        throw new Error('unknown runtime provider');
      return command.providers.includes('nanogpt') ? 'cost' : null;
    case 'routine':
      if (!routines.has(command.operation)) throw new Error('unknown super mutation');
      return null;
    case 'administration':
      if (!SUPER_ADMINISTRATION_COMMANDS.includes(command.command)) throw new Error('unknown super mutation');
      return null;
    case 'config_change': {
      if (!previous) throw new Error('a configuration mutation needs its previous snapshot');
      const next = command.next;
      const removed = <T>(before: T[], after: T[], id: (value: T) => string) => {
        const kept = new Set(after.map(id));
        return before.some((value) => !kept.has(id(value)));
      };
      if (
        removed(previous.team.members, next.team.members, (m) => m.handle) ||
        removed(previous.project.repos, next.project.repos, (r) => r.name)
      )
        return 'deletion';
      if (securityChanged(previous, next)) return 'security';
      const paid = next.team.members.filter(
        (m): m is AiMemberConfig => m.kind === 'ai' && m.provider === 'nanogpt',
      );
      const cap = (config: ProjectConfig) => config.team.limits.maxConcurrentAi ?? Infinity;
      if (
        paid.length &&
        ((!previous.team.limits.aiEnabled && next.team.limits.aiEnabled) || cap(next) > cap(previous))
      )
        return 'cost';
      if (
        paid.some((member) => {
          const before = previous.team.members.find((m) => m.handle === member.handle);
          return (
            !before ||
            before.kind !== 'ai' ||
            before.provider !== 'nanogpt' ||
            before.model !== member.model ||
            before.capacity !== member.capacity ||
            canonical(before.schedule) !== canonical(member.schedule) ||
            (before.onLeave === true && member.onLeave !== true)
          );
        })
      )
        return 'cost';
      // Labels, stages, columns, roles, feedback surfaces, gates, paths and the repo settings are the Operator's.
      return null;
    }
    default:
      throw new Error('unknown super mutation');
  }
}

export interface SuperMutationInput {
  projectKey: string | null;
  actor: Actor;
  previous: ProjectConfig | null;
  command: SuperMutationCommand;
}
