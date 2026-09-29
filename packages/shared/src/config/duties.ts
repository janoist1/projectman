import { BUILT_IN_ROLE_DUTIES, customRoleDuties, isBuiltInRole } from '../domain/role';
import type { DutyId } from '../domain/duty';
import type { GateCondition, Stage } from '../domain/pipeline';
import type { Task } from '../domain/task';
import type { MemberConfig, ProjectConfig } from './schema';

export function roleBundle(config: Pick<ProjectConfig, 'team'>, role: string) {
  if (isBuiltInRole(role))
    return config.team.roleOverrides?.[role] ?? { duties: BUILT_IN_ROLE_DUTIES[role], instructions: '' };
  const custom = config.team.roles.find((r) => r.id === role);
  return { duties: custom ? customRoleDuties(custom) : [], instructions: custom?.instructions ?? '' };
}
export function memberDuties(config: Pick<ProjectConfig, 'team'>, member: MemberConfig): DutyId[] {
  return [
    ...new Set(
      (member.kind === 'ai' ? [member.role] : member.roles).flatMap(
        (role) => roleBundle(config, role).duties,
      ),
    ),
  ];
}
export function dutyMembers(config: Pick<ProjectConfig, 'team'>, duty: DutyId): MemberConfig[] {
  return config.team.members.filter((m) => memberDuties(config, m).includes(duty));
}
export function stageOwners(config: Pick<ProjectConfig, 'team'>, stage: Stage): string[] {
  return stage.owners ?? (stage.duty ? dutyMembers(config, stage.duty).map((m) => m.handle) : []);
}
export function gateApprovers(
  config: Pick<ProjectConfig, 'team'>,
  gate: Extract<GateCondition, { type: 'human_approval' }>,
): string[] {
  const candidates = gate.approvers ?? (gate.duty ? dutyMembers(config, gate.duty).map((m) => m.handle) : []);
  return candidates.filter((h) => config.team.members.some((m) => m.handle === h && m.kind === 'human'));
}
export function taskAuthors(task: Task): string[] {
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
  return config.pipeline.stages.map((stage) => ({
    ...stage,
    owners: stageOwners(config, stage),
    gate: stage.gate
      ? {
          conditions: stage.gate.conditions.map((c) =>
            c.type === 'human_approval' ? { ...c, approvers: gateApprovers(config, c) } : c,
          ),
        }
      : undefined,
  }));
}
