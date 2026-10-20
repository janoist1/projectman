import type { Actor } from '../domain/event';
import type { AgentProvider, HumanAccess } from '../domain/member';
import type { TaskKey, Visibility } from '../domain/task';
import type { AiMemberConfig, ProjectConfig } from './schema';
import { canonical } from './canonical';

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
export const SUPER_ADMINISTRATION_COMMANDS = ['restart', 'full_test', 'image_build', 'deploy'] as const;
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

/** Server-generated authorization projection, never an executable command or a client exemption. */
export function ownerReservedEffect(
  previous: ProjectConfig | null,
  command: SuperMutationCommand,
): OwnerReservedEffect | null {
  switch (command.kind) {
    case 'remove':
      return DELETION_RESOURCES.has(command.resource) ? 'deletion' : null;
    case 'access_change':
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
      if (
        (previous.team.operatorApprovalWaiver ?? false) !== (next.team.operatorApprovalWaiver ?? false) ||
        next.team.members.some((member) => {
          if (member.kind !== 'human') return false;
          const before = previous.team.members.find((m) => m.handle === member.handle);
          if (before?.kind !== 'human') return member.access === 'owner';
          // The email is the member's login binding: rebinding it changes who can sign in as them.
          return before.access !== member.access || (before.email ?? null) !== (member.email ?? null);
        })
      )
        return 'security';
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
