import type { AdministrationCommand } from '../api/administration';
import type { SuperCommand } from '../api/super-handoff';
import type { AgentProvider, HumanAccess } from '../domain/member';
import { operatorOf } from './operator-member';
import { coordinationMemberOf } from './project-manager';
import { applyConfigPatch, prepareOperatorConfigPatch } from './edit';
import type { ProjectConfig } from './schema';
import { ownerReservedEffect, superConfigMutations } from './super-mutation';
import type { OwnerReservedEffect, SuperMutationCommand } from './super-mutation';

/**
 * The server-side classification of a handoff command (PM-762): which owner-reserved effect it would have
 * (deletion, security, cost), by projecting it onto the closed `SuperMutationCommand` list
 * that PM-759 already classifies. The categories are not configurable, and what cannot be classified is
 * refused, never run (fail closed).
 */

export class SuperCommandUnclassifiable extends Error {
  constructor(reason: string) {
    super(`The super command cannot be classified: ${reason}`);
    this.name = 'SuperCommandUnclassifiable';
  }
}

export interface SuperCommandContext {
  /** The project's current configuration and its version (the one the handoff expects). */
  config: ProjectConfig;
  configVersion: string;
  /** The configuration a stored version holds; null when the version is unknown. */
  configAt?: (version: string) => ProjectConfig | null;
}

const PROVIDERS: readonly AgentProvider[] = ['claude', 'codex', 'gemini', 'nanogpt'];

function runtime(provider: AgentProvider | undefined): SuperMutationCommand {
  const effective = provider ?? 'claude';
  if (!PROVIDERS.includes(effective)) throw new SuperCommandUnclassifiable('unknown runtime provider');
  return { kind: 'runtime_start', providers: [effective] };
}

const PERMISSION_KEYS = ['permissionMode', 'approver', 'outboundNetwork', 'machineAccess'] as const;

function memberUpdate(
  context: SuperCommandContext,
  handle: string,
  changes: { provider?: AgentProvider; onLeave?: boolean } & Record<string, unknown>,
): SuperMutationCommand[] {
  const member = context.config.team.members.find((candidate) => candidate.handle === handle);
  if (!member) throw new SuperCommandUnclassifiable('unknown member');
  const before = member.kind === 'human' ? member.access : null;
  const mutations: SuperMutationCommand[] = [];
  if ('access' in changes && changes.access !== undefined && changes.access !== before)
    mutations.push({ kind: 'access_change', handle, before, after: changes.access as HumanAccess });
  const next = structuredClone(context.config);
  const changed = next.team.members.find((m) => m.handle === handle)!;
  if (changed.kind === 'human' && Array.isArray(changes.roles)) changed.roles = changes.roles as string[];
  if (changed.kind === 'ai' && typeof changes.role === 'string') changed.role = changes.role;
  if (changed.kind === 'ai' && typeof changes.onLeave === 'boolean') changed.onLeave = changes.onLeave;
  if (
    PERMISSION_KEYS.some((key) => changes[key] !== undefined) ||
    superConfigMutations(context.config, next).some((mutation) => mutation.kind === 'permission_change') ||
    ((operatorOf(context.config)?.handle === handle ||
      coordinationMemberOf(context.config)?.handle === handle) &&
      Object.values(changes).some((value) => value !== undefined))
  )
    mutations.push({ kind: 'permission_change', handle });
  const effective = changes.provider ?? (member.kind === 'ai' ? member.provider : undefined);
  const keys = Object.keys(changes).filter((key) => changes[key] !== undefined);
  // Only sending a paid member on leave costs nothing; every other change to it may.
  const onlyLeave = keys.length === 1 && changes.onLeave === true;
  if (effective === 'nanogpt' && !onlyLeave) mutations.push(runtime('nanogpt'));
  return mutations.length ? mutations : [{ kind: 'routine', operation: 'member_update' }];
}

/** Exhaustive on purpose: a new administration command does not classify until someone decides its effect. */
function administrationMutation(request: AdministrationCommand): SuperMutationCommand {
  switch (request.kind) {
    case 'owner_command':
      return { kind: 'owner_command' };
    case 'restart':
    case 'full_test':
    case 'image_build':
    case 'deploy':
    case 'process_cleanup':
      return { kind: 'administration', command: request.kind };
    default: {
      const unknown: never = request;
      throw new SuperCommandUnclassifiable(
        `unknown administration command ${String((unknown as { kind?: unknown }).kind)}`,
      );
    }
  }
}

/** The mutations a handoff command would make; every one must classify, or the whole command is refused. */
export function superCommandMutations(
  command: SuperCommand,
  context: SuperCommandContext,
): SuperMutationCommand[] {
  switch (command.kind) {
    case 'operate': {
      const operation = command.operation;
      switch (operation.op) {
        case 'config_patch':
          return superConfigMutations(
            context.config,
            applyConfigPatch(
              context.config,
              prepareOperatorConfigPatch(context.config, context.configVersion, operation.patch),
            ),
          );
        case 'config_revert': {
          const target = context.configAt?.(operation.version) ?? null;
          if (!target)
            throw new SuperCommandUnclassifiable('the configuration version to revert to is unknown');
          return superConfigMutations(context.config, target);
        }
        case 'member_update':
          return memberUpdate(context, operation.handle, operation.changes);
        case 'member_hire':
          return [runtime(operation.request.provider)];
        case 'member_retire':
          return [{ kind: 'remove', resource: 'member', id: operation.handle }];
        case 'session_stop':
          return [{ kind: 'routine', operation: 'session_stop' }];
        case 'project_pause':
          return [{ kind: 'routine', operation: 'project_pause' }];
        case 'project_resume':
          return [{ kind: 'routine', operation: 'project_resume' }];
        case 'message_send':
          return [{ kind: 'routine', operation: 'message_send' }];
        default:
          throw new SuperCommandUnclassifiable('unknown operation');
      }
    }
    case 'member_update':
      return memberUpdate(context, command.handle, command.request);
    case 'invite_create': {
      // The invite schema leaves `owner` out today; a later widening must not slip past the security class.
      const access = command.request.access as HumanAccess;
      return access === 'owner'
        ? [
            {
              kind: 'access_change',
              handle: command.request.memberHandle ?? command.request.email,
              before: null,
              after: access,
            },
          ]
        : [{ kind: 'routine', operation: 'invite_create' }];
    }
    case 'merge':
      return [{ kind: 'routine', operation: 'merge_start' }];
    case 'merge_order':
      return [{ kind: 'routine', operation: 'merge_order' }];
    case 'task_create':
      return [{ kind: 'routine', operation: 'task_create' }];
    case 'task_update':
      return [{ kind: 'routine', operation: 'task_write' }];
    case 'task_labels':
    case 'task_start':
    case 'inbox_resolve':
    case 'workspace_release':
      return [{ kind: 'routine', operation: command.kind }];
    case 'task_cancel':
      return [{ kind: 'routine', operation: 'task_write' }];
    case 'credential_revoke':
      return [{ kind: 'remove', resource: 'credential', id: command.keyId }];
    case 'administration':
      return [administrationMutation(command.request)];
    default:
      throw new SuperCommandUnclassifiable('unknown command');
  }
}

/** The owner-reserved effects of the whole command (empty: it can run on the integrator's own power). */
export function superCommandEffects(
  command: SuperCommand,
  context: SuperCommandContext,
): OwnerReservedEffect[] {
  const effects = new Set<OwnerReservedEffect>();
  for (const mutation of superCommandMutations(command, context)) {
    let effect: OwnerReservedEffect | null;
    try {
      effect = ownerReservedEffect(context.config, mutation);
    } catch (error) {
      throw new SuperCommandUnclassifiable(error instanceof Error ? error.message : 'unknown mutation');
    }
    if (effect) effects.add(effect);
  }
  return [...effects];
}
