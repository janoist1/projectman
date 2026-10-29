import type { Actor } from '../domain/event';
import { DEFAULT_AGENT_PROVIDER } from '../domain/member';
import type { AgentProvider, HumanAccess } from '../domain/member';
import type { SuperCommand } from '../api/super-handoff';
import type { AiMemberConfig, ProjectConfig } from './schema';
import { canonical } from './canonical';
import { ownerHandles } from './lookup';
import { boundaryDelegationChanged, ownerOnlyChanges, permissionsChanged } from './owner-only';
import { dutyMembers, memberDuties, roleBundle } from './duties';
import { labelHolders } from './labels';
import { coordinationMemberOf } from './project-manager';

/** App project managers may execute only these command kinds; new kinds are refused by default. */
export const PROJECT_MANAGER_SUPER_COMMANDS = [
  'task_create',
  'task_update',
  'task_labels',
  'task_start',
  'task_cancel',
  'member_update',
  'merge_order',
  'operate',
] as const;

export function projectManagerCommandRefusal(command: {
  kind: string;
}): 'command_not_for_project_manager' | null {
  return (PROJECT_MANAGER_SUPER_COMMANDS as readonly string[]).includes(command.kind)
    ? null
    : 'command_not_for_project_manager';
}

/**
 * Who stands behind an app session's open request (PM-1010): an owner's own message or answer, or anyone else
 * (a queue item, another member's message). Decided by the server from the open request, never by the caller.
 */
export function appRequestOrigin(
  config: Pick<ProjectConfig, 'team'>,
  request: { source: string; fromHandle: string } | null,
): 'owner' | 'member' {
  return request &&
    (request.source === 'message' || request.source === 'answer') &&
    ownerHandles(config).includes(request.fromHandle)
    ? 'owner'
    : 'member';
}

/** Commands an app session runs only on an owner's own request (PM-935, PM-1010): approvals, merges and invitations. */
export const OWNER_REQUEST_SUPER_COMMANDS = [
  'workspace_release',
  'inbox_resolve',
  'merge',
  'merge_order',
  'invite_create',
] as const satisfies readonly SuperCommand['kind'][];

export function memberRequestCommandRefusal(command: { kind: string }): 'operator_owner_only' | null {
  return (OWNER_REQUEST_SUPER_COMMANDS as readonly string[]).includes(command.kind)
    ? 'operator_owner_only'
    : null;
}

/** Who may set each label that is not open to anyone, and who gives the release approval: derived from roles, duties and members. */
function approvalHolders(config: ProjectConfig): string {
  return canonical({
    labels: config.pipeline.labels
      .filter((label) => label.setBy !== 'anyone')
      .map((label) => [label.id, labelHolders(config, label).sort()])
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
    release: dutyMembers(config, 'release_approval')
      .map((member) => member.handle)
      .sort(),
  });
}

/**
 * Whether a configuration change reaches who approves: the pipeline (labels, their holders, gates), the
 * release four-eyes rule, the merger, or who actually holds an approval label or the release approval. The
 * holders follow from a member's role, the role overrides and the custom roles, so those are covered here:
 * `superConfigMutations` marks only the boundary delegation and the coordinator's and Operator's own role.
 */
export function approvalStructureChanged(previous: ProjectConfig, next: ProjectConfig): boolean {
  return (
    canonical(previous.pipeline) !== canonical(next.pipeline) ||
    (previous.team.releaseFourEyes ?? false) !== (next.team.releaseFourEyes ?? false) ||
    canonical(previous.team.merger ?? null) !== canonical(next.team.merger ?? null) ||
    approvalHolders(previous) !== approvalHolders(next)
  );
}

/**
 * What stays the owner's in super mode (owner decision of 2026-10-20, PM-862 K3): deleting a member, key,
 * project or repository; their own login and the security settings; the paid cost. Everything else the
 * Operator may do with the super key, in its own name.
 */
export type OwnerReservedEffect = 'deletion' | 'security' | 'cost';
/** Machine capabilities shown with the owner's grant (PM-891). */
export const OPERATOR_MACHINE_OPERATIONS = [
  'deploy',
  'restart',
  'full_test',
  'image_build',
  'status',
  'machine',
  'logs',
  'process_cleanup',
  'owner_command',
] as const;
export type OperatorMachineOperation = (typeof OPERATOR_MACHINE_OPERATIONS)[number];
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
  | 'engine_rename'
  | 'merge_start'
  | 'merge_order'
  | 'project_pause'
  | 'project_resume'
  | 'session_stop'
  | 'session_restart'
  | 'workspace_release'
  | 'release_prepare'
  | 'release_propose'
  | 'member_update';
/** The protected administration commands that need no per-operation owner approval. */
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
  | { kind: 'runtime_start'; providers: AgentProvider[] }
  | { kind: 'administration'; command: SuperAdministrationCommand }
  | { kind: 'owner_command' }
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
  'engine_rename',
  'merge_start',
  'merge_order',
  'project_pause',
  'project_resume',
  'session_stop',
  'session_restart',
  'workspace_release',
  'release_prepare',
  'release_propose',
  'member_update',
]);

const DELETION_RESOURCES = new Set<string>(['member', 'repo', 'project', 'credential']);

/**
 * Whether a provider's sessions cost money beyond the subscriptions: NanoGPT bills per call (decision 34).
 * A record over every provider, so a new provider does not classify until someone states its cost.
 */
const PAID_PROVIDERS: Readonly<Record<AgentProvider, boolean>> = {
  claude: false,
  codex: false,
  gemini: false,
  nanogpt: true,
};

/** A provider this classification knows (an unknown one is refused, never guessed free). */
export function isKnownProvider(provider: string): provider is AgentProvider {
  return Object.hasOwn(PAID_PROVIDERS, provider);
}

/** Starting this provider's sessions is a cost the owner reserved (`PAID_PROVIDERS`). */
export function isPaidProvider(provider: AgentProvider): boolean {
  return PAID_PROVIDERS[provider];
}

/**
 * The owner's own login and security settings changed: a human's access level, login e-mail or a human turned
 * into another kind of member, a new owner, the Operator waiver, the AI members' permission settings and the
 * boundary delegation (the owner kept the last two on 2026-10-20, PM-862 inventory row 33).
 */
function securityChanged(previous: ProjectConfig, next: ProjectConfig): boolean {
  if (superMemberChanges(previous, next).length) return true;
  if ((previous.team.operatorApprovalWaiver ?? false) !== (next.team.operatorApprovalWaiver ?? false))
    return true;
  if (permissionsChanged(previous, next) || boundaryDelegationChanged(previous, next)) return true;
  if (ownerOnlyChanges(previous, next).includes('machine_access')) return true;
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

/** The delegated super member (the selected coordinator) may not rewrite its own member or role without the owner's yes. */
function superMemberChanges(previous: ProjectConfig, next: ProjectConfig): string[] {
  const changed = new Set<string>();
  const before = coordinationMemberOf(previous);
  const after = coordinationMemberOf(next);
  if (before?.handle !== after?.handle) {
    if (before) changed.add(before.handle);
    if (after) changed.add(after.handle);
  }
  if (
    before &&
    (canonical(before) !== canonical(next.team.members.find((m) => m.handle === before.handle)) ||
      canonical(roleBundle(previous, before.role)) !== canonical(roleBundle(next, before.role)))
  )
    changed.add(before.handle);
  return [...changed];
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
  for (const handle of superMemberChanges(previous, next)) permissions.add(handle);
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
    case 'owner_command':
      return 'security';
    case 'runtime_start':
      if (!command.providers.every(isKnownProvider)) throw new Error('unknown runtime provider');
      return command.providers.some(isPaidProvider) ? 'cost' : null;
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
        (m): m is AiMemberConfig => m.kind === 'ai' && isPaidProvider(m.provider ?? DEFAULT_AGENT_PROVIDER),
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
            (before.provider ?? DEFAULT_AGENT_PROVIDER) !== (member.provider ?? DEFAULT_AGENT_PROVIDER) ||
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
