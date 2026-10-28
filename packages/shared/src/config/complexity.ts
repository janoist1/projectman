import { DEFAULT_COMPLEXITY_LIMIT, DEFAULT_TEMP_MAX_POINTS } from '../domain/complexity';
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

/** The largest card a temp worker takes (PM-1101). */
export function tempMaxPointsOf(config: Pick<ProjectConfig, 'team'>): ComplexityPoints {
  return config.team.limits.tempWorkers.maxPoints ?? DEFAULT_TEMP_MAX_POINTS;
}

export function complexityLimitOf(
  config: Pick<ProjectConfig, 'team'>,
  member: AiMemberConfig,
): ComplexityPoints {
  return member.temp ? tempMaxPointsOf(config) : (member.complexityLimit ?? DEFAULT_COMPLEXITY_LIMIT);
}
