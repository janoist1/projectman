import { DEFAULT_COMPLEXITY_LIMIT } from '../domain/complexity';
import type { ComplexityPoints } from '../domain/complexity';
import { memberDuties, stageDuty, stageOwners } from './duties';
import type { AiMemberConfig, MemberConfig, ProjectConfig } from './schema';

export function canSetComplexity(config: Pick<ProjectConfig, 'team'>, handle: string): boolean {
  const member = config.team.members.find((m) => m.handle === handle);
  if (!member) return false;
  if (member.kind === 'human' && member.access === 'owner') return true;
  const duties = memberDuties(config, member);
  return duties.includes('task_breakdown') || duties.includes('requirements_analysis');
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
