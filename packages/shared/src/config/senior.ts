import { isSenior } from '../domain/developer-level';
import type { Stage } from '../domain/pipeline';
import type { Task } from '../domain/task';
import { memberDuties, stageOwners } from './duties';
import { stageOf } from './lookup';
import type { AiMemberConfig, ProjectConfig } from './schema';

/** The task's work stage: the one it is in, else the pipeline's first. */
export function workStageOf(
  config: Pick<ProjectConfig, 'pipeline'>,
  task: Pick<Task, 'stageId'>,
): Stage | undefined {
  const current = stageOf(config, task.stageId);
  return current?.kind === 'work' ? current : config.pipeline.stages.find((s) => s.kind === 'work');
}

/** The owners of the stage who are Seniors; a Senior on leave is one too. */
export function seniorsOf(config: Pick<ProjectConfig, 'team'>, stage: Stage): AiMemberConfig[] {
  const owners = new Set(stageOwners(config, stage));
  return config.team.members.filter(
    (member): member is AiMemberConfig =>
      member.kind === 'ai' && owners.has(member.handle) && isSenior(member),
  );
}

/** Whether the work stage of the card has a Senior among its owners. */
export function hasActiveSenior(config: ProjectConfig, task: Pick<Task, 'stageId'>): boolean {
  const stage = workStageOf(config, task);
  return !!stage && seniorsOf(config, stage).length > 0;
}

/**
 * Who may set the recommended developer of a card (PM-347): a person with `owner` access, or a
 * member (a person or an AI member) that holds the task breakdown or the requirements analysis duty.
 */
export function canSetDeveloperLevel(config: Pick<ProjectConfig, 'team'>, handle: string): boolean {
  const member = config.team.members.find((m) => m.handle === handle);
  if (!member) return false;
  if (member.kind === 'human' && member.access === 'owner') return true;
  const duties = memberDuties(config, member);
  return duties.includes('task_breakdown') || duties.includes('requirements_analysis');
}
