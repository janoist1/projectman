import { fixLimitDeciders, fixLimitLead, maxFixRoundsOf } from '../domain/fix-limit';
import { CODE_REVIEW_CHANGES_LABEL, DESIGN_REVIEW_CHANGES_LABEL } from '../domain/card-measure';
import { isHumanOnlyLabel, REFINE_LABEL, WAITING_ANSWER_LABEL } from '../domain/label';
import { TASK_CREATE_MIN_ACCESS } from '../domain/member';
import type { HumanAccess } from '../domain/member';
import { labelDefinition, labelExcludesAuthors } from './labels';
import { ownerHandles } from './lookup';
import { developmentStage, isRefinementStage, projectRefines } from './refinement';
import type { ProjectConfig } from './schema';

export const TEAM_RULE_IDS = [
  'new_card',
  'gates_in_order',
  'approvals',
  'self_review',
  'fix_limit',
  'refinement',
  'waiting_answer',
] as const;
export type TeamRuleId = (typeof TEAM_RULE_IDS)[number];
export type TeamRule =
  | { id: 'new_card'; firstStageId: string; minimumAccess: HumanAccess }
  | { id: 'gates_in_order'; clearedOnMoveBack: string[] }
  | { id: 'approvals'; labels: string[] }
  | { id: 'self_review'; labels: string[] }
  | { id: 'fix_limit'; limit: number; labels: string[]; lead: string | null; deciders: string[] }
  | { id: 'refinement'; label: string | null; stageIds: string[]; workStageId: string; steps: string[] }
  | { id: 'waiting_answer'; label: string };

/** The rules the system enforces beyond the configured gates and labels, in TEAM_RULE_IDS order; a rule that does not apply to the project is left out. */
export function teamRules(config: Pick<ProjectConfig, 'team' | 'pipeline'>): TeamRule[] {
  const { labels, stages } = config.pipeline;
  const rules: TeamRule[] = [
    { id: 'new_card', firstStageId: stages[0]!.id, minimumAccess: TASK_CREATE_MIN_ACCESS },
    {
      id: 'gates_in_order',
      clearedOnMoveBack: labels
        .filter((label) => label.clearedWhen?.includes('moved_back'))
        .map((label) => label.id),
    },
  ];
  const approvals = labels.filter(isHumanOnlyLabel).map((label) => label.id);
  if (approvals.length) rules.push({ id: 'approvals', labels: approvals });
  const selfReview = labels.filter((label) => labelExcludesAuthors(config, label)).map((label) => label.id);
  if (selfReview.length) rules.push({ id: 'self_review', labels: selfReview });
  rules.push({
    id: 'fix_limit',
    limit: maxFixRoundsOf(config.team.limits),
    labels: [CODE_REVIEW_CHANGES_LABEL, DESIGN_REVIEW_CHANGES_LABEL].filter((id) =>
      labelDefinition(config, id),
    ),
    lead: fixLimitLead(config, []),
    deciders: fixLimitDeciders(config, ownerHandles(config)),
  });
  const work = developmentStage(config);
  if (projectRefines(config) && work) {
    const steps = stages
      .slice(0, stages.indexOf(work) + 1)
      .flatMap((stage) =>
        (stage.gate?.conditions ?? [])
          .filter(
            (condition) =>
              condition.type === 'has_label' && labelDefinition(config, condition.label)?.setBy !== 'system',
          )
          .map((condition) => condition.label),
      );
    rules.push({
      id: 'refinement',
      label: labelDefinition(config, REFINE_LABEL) ? REFINE_LABEL : null,
      stageIds: stages.filter(isRefinementStage).map((stage) => stage.id),
      workStageId: work.id,
      steps: [...new Set(steps)],
    });
  }
  if (labelDefinition(config, WAITING_ANSWER_LABEL))
    rules.push({ id: 'waiting_answer', label: WAITING_ANSWER_LABEL });
  return rules;
}
