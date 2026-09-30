import { BUILT_IN_ROLE_DUTIES, customRoleDuties, isBuiltInRole } from '../domain/role';
import type { DutyId } from '../domain/duty';
import type { Stage } from '../domain/pipeline';
import type { Task } from '../domain/task';
import { memberRoles } from './lookup';
import type { MemberConfig, ProjectConfig } from './schema';

export function roleBundle(config: Pick<ProjectConfig, 'team'>, role: string) {
  if (isBuiltInRole(role))
    return config.team.roleOverrides?.[role] ?? { duties: BUILT_IN_ROLE_DUTIES[role], instructions: '' };
  const custom = config.team.roles.find((r) => r.id === role);
  return { duties: custom ? customRoleDuties(custom) : [], instructions: custom?.instructions ?? '' };
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
