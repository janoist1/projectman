import type { Actor } from '../domain/event';
import type { AgentProvider } from '../domain/member';
import type { TaskKey, Visibility } from '../domain/task';
import type { AiMemberConfig, ProjectConfig } from './schema';
import { canonical } from './canonical';

export type OwnerReservedEffect = 'cost' | 'deletion' | 'publication' | 'direction';
export type SuperRoutineMutation =
  | 'task_write'
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
  | 'release_propose';
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
        | 'project';
      id: string;
    }
  | { kind: 'focus_change'; before: TaskKey[]; after: TaskKey[] }
  | { kind: 'runtime_start'; providers: AgentProvider[] }
  | { kind: 'routine'; operation: SuperRoutineMutation };

const routines = new Set<SuperRoutineMutation>([
  'task_write',
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
]);

/** Server-generated authorization projection, never an executable command or a client exemption. */
export function ownerReservedEffect(
  previous: ProjectConfig | null,
  command: SuperMutationCommand,
): OwnerReservedEffect | null {
  switch (command.kind) {
    case 'remove':
      return 'deletion';
    case 'task_visibility':
      return command.after === 'shared' && command.before !== 'shared' ? 'publication' : null;
    case 'focus_change':
      return canonical(command.before) !== canonical(command.after) ? 'direction' : null;
    case 'runtime_start':
      if (command.providers.some((provider) => !['claude', 'codex', 'gemini', 'nanogpt'].includes(provider)))
        throw new Error('unknown runtime provider');
      return command.providers.includes('nanogpt') ? 'cost' : null;
    case 'routine':
      if (!routines.has(command.operation)) throw new Error('unknown super mutation');
      return null;
    case 'config_change': {
      if (!previous) throw new Error('a configuration mutation needs its previous snapshot');
      const next = command.next;
      const removed = <T>(before: T[], after: T[], id: (value: T) => string) => {
        const kept = new Set(after.map(id));
        return before.some((value) => !kept.has(id(value)));
      };
      const feedbackBefore = previous.project.feedback?.surfaces ?? [];
      const feedbackAfter = next.project.feedback?.surfaces ?? [];
      if (
        removed(previous.team.members, next.team.members, (m) => m.handle) ||
        removed(previous.project.repos, next.project.repos, (r) => r.name) ||
        removed(previous.team.roles, next.team.roles, (r) => r.id) ||
        removed(previous.pipeline.labels, next.pipeline.labels, (l) => l.id) ||
        removed(previous.pipeline.stages, next.pipeline.stages, (s) => s.id) ||
        removed(previous.pipeline.columns, next.pipeline.columns, (c) => c.id) ||
        removed(feedbackBefore, feedbackAfter, (s) => s.id) ||
        Object.keys(previous.team.roleOverrides ?? {}).some(
          (id) => !Object.hasOwn(next.team.roleOverrides ?? {}, id),
        ) ||
        previous.pipeline.stages.some((stage) => {
          const after = next.pipeline.stages.find((s) => s.id === stage.id);
          return (
            after &&
            removed(stage.gate?.conditions ?? [], after.gate?.conditions ?? [], (c) =>
              canonical({ type: c.type, label: c.label, when: c.when ?? null }),
            )
          );
        })
      )
        return 'deletion';
      if (
        feedbackAfter.some((surface) => {
          const before = feedbackBefore.find((s) => s.id === surface.id);
          return !before || new URL(before.origin).origin !== new URL(surface.origin).origin;
        })
      )
        return 'publication';
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
      if (
        previous.project.workspacePath !== next.project.workspacePath ||
        next.project.repos.some((repo) => {
          const before = previous.project.repos.find((r) => r.name === repo.name);
          return (
            before &&
            (before.path !== repo.path ||
              before.defaultBranch !== repo.defaultBranch ||
              before.github !== repo.github)
          );
        })
      )
        return 'direction';
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
