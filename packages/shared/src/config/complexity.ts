import { DEFAULT_COMPLEXITY_LIMIT } from '../domain/complexity';
import type { ComplexityPoints } from '../domain/complexity';
import type { DutyId } from '../domain/duty';
import { memberDuties, stageDuty, stageOwners } from './duties';
import type { AiMemberConfig, MemberConfig, ProjectConfig } from './schema';

/** The duties that may set complexity points when the project does not say (today's rule, PM-1097). */
export const DEFAULT_COMPLEXITY_SETTERS: readonly DutyId[] = ['requirements_analysis', 'task_breakdown'];

export function complexitySettersOf(config: Pick<ProjectConfig, 'team'>): readonly DutyId[] {
  return config.team.complexitySetters ?? DEFAULT_COMPLEXITY_SETTERS;
}

/** A project owner always may; any other member needs a duty in `team.complexitySetters`. */
export function canSetComplexity(config: Pick<ProjectConfig, 'team'>, handle: string): boolean {
  const member = config.team.members.find((m) => m.handle === handle);
  if (!member) return false;
  if (member.kind === 'human' && member.access === 'owner') return true;
  const setters = complexitySettersOf(config);
  return memberDuties(config, member).some((duty) => setters.includes(duty));
}

/** The members who may set complexity now, in team order. */
export function complexitySetterMembers(config: Pick<ProjectConfig, 'team'>): MemberConfig[] {
  return config.team.members.filter((member) => canSetComplexity(config, member.handle));
}

export function isDeveloper(config: Pick<ProjectConfig, 'team' | 'pipeline'>, member: MemberConfig): boolean {
  if (member.kind !== 'ai') return false;
  const duties = memberDuties(config, member);
  return config.pipeline.stages.some((stage) => {
    if (stage.kind !== 'work') return false;
    const duty = stageDuty(stage);
    return stageOwners(config, stage).includes(member.handle) || (!!duty && duties.includes(duty));
  });
}

export function complexityLimitOf(member: AiMemberConfig): ComplexityPoints {
  return member.temp ? DEFAULT_COMPLEXITY_LIMIT : (member.complexityLimit ?? DEFAULT_COMPLEXITY_LIMIT);
}
