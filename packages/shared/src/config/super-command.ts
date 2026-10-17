import type { SuperCommand } from '../api/super-handoff';
import type { AgentProvider } from '../domain/member';
import { applyConfigPatch, prepareOperatorConfigPatch } from './edit';
import type { ProjectConfig } from './schema';
import { ownerReservedEffect } from './super-mutation';
import type { OwnerReservedEffect, SuperMutationCommand } from './super-mutation';

/**
 * The server-side classification of a handoff command (PM-762): which owner-reserved effect it would have
 * (cost, deletion, publication, direction), by projecting it onto the closed `SuperMutationCommand` list
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

function memberUpdate(
  context: SuperCommandContext,
  handle: string,
  changes: { provider?: AgentProvider; onLeave?: boolean } & Record<string, unknown>,
): SuperMutationCommand[] {
  const member = context.config.team.members.find((candidate) => candidate.handle === handle);
  if (!member) throw new SuperCommandUnclassifiable('unknown member');
  if ('access' in changes && changes.access !== undefined)
    throw new SuperCommandUnclassifiable('a member access change is not a handoff command');
  if ('roles' in changes && changes.roles !== undefined)
    throw new SuperCommandUnclassifiable('a member role change is not a handoff command');
  const effective = changes.provider ?? (member.kind === 'ai' ? member.provider : undefined);
  const keys = Object.keys(changes).filter((key) => changes[key] !== undefined);
  // Only sending a paid member on leave costs nothing; every other change to it may.
  const onlyLeave = keys.length === 1 && changes.onLeave === true;
  if (effective === 'nanogpt' && !onlyLeave) return [runtime('nanogpt')];
  return [{ kind: 'routine', operation: 'member_update' }];
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
          return [
            {
              kind: 'config_change',
              next: applyConfigPatch(
                context.config,
                prepareOperatorConfigPatch(context.config, context.configVersion, operation.patch),
              ),
            },
          ];
        case 'config_revert': {
          const target = context.configAt?.(operation.version) ?? null;
          if (!target)
            throw new SuperCommandUnclassifiable('the configuration version to revert to is unknown');
          return [{ kind: 'config_change', next: target }];
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
    case 'invite_create':
      return [{ kind: 'routine', operation: 'invite_create' }];
    case 'merge':
      return [{ kind: 'routine', operation: 'merge_start' }];
    case 'merge_order':
      return [{ kind: 'routine', operation: 'merge_order' }];
    case 'administration':
      return [{ kind: 'administration', command: command.request.kind }];
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
