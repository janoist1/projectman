import type { Actor } from '../domain/event';
import type { WorkItemRef } from '../domain/session';
import { stageIndex } from './gates';
import { cardMoverOf, isHandOnMove } from './card-mover';
import { isOnLeave } from './leave';
import { memberOf } from './lookup';
import { isOperator } from './operator-member';
import type { AiMemberConfig, MemberConfig, ProjectConfig } from './schema';

/** The built-in role of the project manager every project requires (PM-429). */
export const PROJECT_MANAGER_ROLE = 'project_manager';

/** An AI member holding the built-in project_manager role; a temp worker never counts, leave does not matter. */
export function isProjectManager(member: MemberConfig | null | undefined): member is AiMemberConfig {
  return member?.kind === 'ai' && member.role === PROJECT_MANAGER_ROLE && !member.temp;
}

/** The team's AI project managers, in configuration order. */
export function projectManagersOf(config: Pick<ProjectConfig, 'team'>): AiMemberConfig[] {
  return config.team.members.filter(isProjectManager);
}

/** The one the owner talks to: the first not on leave (isOnLeave), else the first; null when there is none. */
export function projectManagerOf(config: Pick<ProjectConfig, 'team'>): AiMemberConfig | null {
  const managers = projectManagersOf(config);
  return managers.find((m) => !isOnLeave(m)) ?? managers[0] ?? null;
}

/** Whether `handle` is the team's only AI project manager: it cannot be retired or lose the role. */
export function isRequiredProjectManager(config: Pick<ProjectConfig, 'team'>, handle: string): boolean {
  const managers = projectManagersOf(config);
  return managers.length === 1 && managers[0]!.handle === handle;
}

/**
 * A project manager starts cards from a later queue into work, and hands cards on when
 * selected as the project's card mover. Other stage moves need the owner.
 */
export function projectManagerMoveRefusal(
  config: Pick<ProjectConfig, 'team' | 'pipeline'>,
  fromStageId: string,
  toStageId: string,
): 'project_manager_move_refused' | null {
  if (cardMoverOf(config).kind === 'project_manager' && isHandOnMove(config, fromStageId, toStageId))
    return null;
  const from = stageIndex(config.pipeline, fromStageId);
  const to = stageIndex(config.pipeline, toStageId);
  if (from <= 0 || to <= from) return 'project_manager_move_refused';
  if (config.pipeline.stages[from]!.kind !== 'queue') return 'project_manager_move_refused';
  if (config.pipeline.stages[to]!.kind !== 'work') return 'project_manager_move_refused';
  return null;
}

/** Whether the actor is an AI project manager of the team (PM-433): a person, the system or another AI never is. */
export function isProjectManagerActor(
  config: Pick<ProjectConfig, 'team'>,
  actor: Pick<Actor, 'kind' | 'handle'>,
): boolean {
  return actor.kind === 'ai' && isProjectManager(memberOf(config, actor.handle));
}

/** The stage-move refusal that binds `actor`: the project manager's (above); nobody else's here. */
export function actorMoveRefusal(
  config: Pick<ProjectConfig, 'team' | 'pipeline'>,
  actor: Pick<Actor, 'kind' | 'handle'>,
  fromStageId: string,
  toStageId: string,
): 'project_manager_move_refused' | null {
  return isProjectManagerActor(config, actor)
    ? projectManagerMoveRefusal(config, fromStageId, toStageId)
    : null;
}

/**
 * Where a member's work item runs: a project manager's and the Operator's card work runs in their one
 * general conversation (PM-434, PM-463).
 */
export function sessionWorkItemOf(
  member: MemberConfig | null | undefined,
  workItem: WorkItemRef,
): WorkItemRef {
  return (isProjectManager(member) || isOperator(member)) && workItem.type === 'task'
    ? { type: 'general' }
    : workItem;
}
