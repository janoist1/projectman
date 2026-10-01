import { BUILT_IN_ROLE_DUTIES, customRoleDuties, isBuiltInRole } from '../domain/role';
import { DUTIES } from '../domain/duty';
import type { DutyId } from '../domain/duty';
import type { Stage } from '../domain/pipeline';
import type { SessionState } from '../domain/session';
import type { Task } from '../domain/task';
import { memberRoles, stageOf } from './lookup';
import type { MemberConfig, ProjectConfig } from './schema';

export function roleBundle(config: Pick<ProjectConfig, 'team'>, role: string) {
  if (isBuiltInRole(role))
    return config.team.roleOverrides?.[role] ?? { duties: BUILT_IN_ROLE_DUTIES[role], instructions: '' };
  const custom = config.team.roles.find((r) => r.id === role);
  return { duties: custom ? customRoleDuties(custom) : [], instructions: custom?.instructions ?? '' };
}
/**
 * Whether a role changes files: one of its duties has the `task_worktree` tool policy, so its task
 * sessions work in the task's own git worktree (custom roles and project overrides included).
 */
export function roleUsesWorktree(config: Pick<ProjectConfig, 'team'>, role: string): boolean {
  return roleBundle(config, role).duties.some((id) => DUTIES[id].toolPolicy === 'task_worktree');
}
export function memberDuties(config: Pick<ProjectConfig, 'team'>, member: MemberConfig): DutyId[] {
  return [...new Set(memberRoles(member).flatMap((role) => roleBundle(config, role).duties))];
}
export function dutyMembers(config: Pick<ProjectConfig, 'team'>, duty: DutyId): MemberConfig[] {
  return config.team.members.filter((m) => memberDuties(config, m).includes(duty));
}
export function stageOwners(config: Pick<ProjectConfig, 'team'>, stage: Stage): string[] {
  return stage.owners ?? (stage.duty ? dutyMembers(config, stage.duty).map((m) => m.handle) : []);
}
/**
 * Session states of a member that is doing something now: a turn runs, or it waits for an answer.
 * The server's `BUSY_SESSION_STATES` (the concurrency limit) leaves out `waiting_input`: a session
 * waiting for a person's answer does no work, but its member still holds the task.
 */
const ENGAGED_SESSION_STATES: SessionState[] = ['starting', 'working', 'waiting_permission', 'waiting_input'];
/**
 * Whether a member's live session on an open task is work it does now (what counts against its
 * capacity): a turn is running or waiting for an answer, or the task sits in a stage the member
 * works in (the assignee of a work stage, an owner of a step or release stage). A session idling after the
 * member handed the task on does not count.
 */
export function isWorkingOnTask(
  config: Pick<ProjectConfig, 'team' | 'pipeline'>,
  task: Pick<Task, 'stageId' | 'assignee'>,
  handle: string,
  sessionState: SessionState,
): boolean {
  if (ENGAGED_SESSION_STATES.includes(sessionState)) return true;
  const stage = stageOf(config, task.stageId);
  if (!stage) return false;
  if (stage.kind === 'work')
    return task.assignee ? task.assignee === handle : stageOwners(config, stage).includes(handle);
  return stage.kind !== 'queue' && stage.kind !== 'done' && stageOwners(config, stage).includes(handle);
}
/** The task's assignee and the attributed authors of its pull requests. */
export function taskAuthors(task: Pick<Task, 'assignee' | 'links'>): string[] {
  return [
    ...new Set(
      [task.assignee, ...task.links.filter((l) => l.kind === 'pull_request').map((l) => l.author)].filter(
        (h): h is string => !!h,
      ),
    ),
  ];
}
/** Resolve at use time, never persist derived member lists into customization YAML. */
export function resolvedStages(config: ProjectConfig): (Stage & { owners: string[] })[] {
  return config.pipeline.stages.map((stage) => ({ ...stage, owners: stageOwners(config, stage) }));
}
