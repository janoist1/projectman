import type { WorkItemRef } from '../domain/session';
import { stageIndex } from './gates';
import { isOnLeave } from './leave';
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
 * The only stage move a project manager makes on its own: from a queue stage that is not the
 * first into a later work stage. Anything else needs the owner.
 */
export function projectManagerMoveRefusal(
  config: Pick<ProjectConfig, 'pipeline'>,
  fromStageId: string,
  toStageId: string,
): 'project_manager_move_refused' | null {
  const from = stageIndex(config.pipeline, fromStageId);
  const to = stageIndex(config.pipeline, toStageId);
  if (from <= 0 || to <= from) return 'project_manager_move_refused';
  if (config.pipeline.stages[from]!.kind !== 'queue') return 'project_manager_move_refused';
  if (config.pipeline.stages[to]!.kind !== 'work') return 'project_manager_move_refused';
  return null;
}

/** Where a member's work item runs: a project manager's card work runs in its one general conversation. */
export function sessionWorkItemOf(
  member: MemberConfig | null | undefined,
  workItem: WorkItemRef,
): WorkItemRef {
  return isProjectManager(member) && workItem.type === 'task' ? { type: 'general' } : workItem;
}
