import { fixLimitDeciders, fixLimitLead, maxFixRoundsOf } from '../domain/fix-limit';
import { CODE_REVIEW_CHANGES_LABEL, DESIGN_REVIEW_CHANGES_LABEL } from '../domain/card-measure';
import {
  ACCEPTANCE_OPEN_LABEL,
  ACCEPTANCE_UNCONFIRMED_LABEL,
  isHumanOnlyLabel,
  REFINE_LABEL,
  WAITING_ANSWER_LABEL,
} from '../domain/label';
import type { HumanAccess } from '../domain/member';
import { pullSourceStage } from '../domain/start-order';
import { complexitySetterMembers, tempMaxPointsOf } from './complexity';
import { labelDefinition, labelExcludesAuthors } from './labels';
import { projectManagerLifecycleOf } from './lifecycle';
import { ownerHandles } from './lookup';
import { prerequisiteOverrideOf } from './prerequisite-override';
import { prioritySetterMembers } from './priority';
import { projectManagerMovesOf, projectManagersOf } from './project-manager';
import { developmentStage, isRefinementStage, projectRefines } from './refinement';
import type { ProjectConfig, ProjectManagerMoves, ViewerRecipients } from './schema';
import { taskCreateAccessOf } from './task-create';
import type { TeamRuleId } from './team-rule-ids';
import { viewerRecipientsOf } from './communication';

export { RULE_REASON_MAX, TEAM_RULE_IDS } from './team-rule-ids';
export type { TeamRuleId } from './team-rule-ids';
export type TeamRule =
  | { id: 'new_card'; firstStageId: string; minimumAccess: HumanAccess }
  | { id: 'gates_in_order'; clearedOnMoveBack: string[] }
  | { id: 'approvals'; labels: string[] }
  | { id: 'self_review'; labels: string[] }
  | { id: 'start_order'; urgentPull: boolean }
  | { id: 'priority_setters'; members: string[] }
  | { id: 'complexity_setters'; members: string[] }
  | { id: 'assignee_fit'; tempMaxPoints: number }
  | { id: 'acceptance'; reviewStageId: string | null; doneStageId: string | null }
  | {
      id: 'project_manager_rights';
      moves: ProjectManagerMoves;
      lifecycle: string[];
      prerequisiteOverride: boolean;
    }
  | { id: 'fix_limit'; limit: number; labels: string[]; lead: string | null; deciders: string[] }
  | { id: 'refinement'; label: string | null; stageIds: string[]; workStageId: string; steps: string[] }
  | { id: 'waiting_answer'; label: string }
  | { id: 'viewer_recipients'; mode: ViewerRecipients };

/** The rules a team cannot switch off: the system itself enforces them in every project. */
export const ALWAYS_VALID_RULE_IDS: readonly TeamRuleId[] = [
  'gates_in_order',
  'approvals',
  'self_review',
  'start_order',
];

/** The first stage whose gate asks that the label is not on the card. */
function stageLackingLabel(
  stages: ProjectConfig['pipeline']['stages'],
  label: string,
  prefer?: (stage: ProjectConfig['pipeline']['stages'][number]) => boolean,
): string | null {
  const gated = stages.filter((stage) =>
    stage.gate?.conditions.some((condition) => condition.type === 'lacks_label' && condition.label === label),
  );
  return (gated.find((stage) => prefer?.(stage)) ?? gated[0])?.id ?? null;
}

/** The rules the system enforces beyond the configured gates and labels, in TEAM_RULE_IDS order; a rule that does not apply to the project is left out. */
export function teamRules(config: Pick<ProjectConfig, 'team' | 'pipeline'>): TeamRule[] {
  const { labels, stages } = config.pipeline;
  const rules: TeamRule[] = [
    { id: 'new_card', firstStageId: stages[0]!.id, minimumAccess: taskCreateAccessOf(config) },
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
  rules.push(
    { id: 'start_order', urgentPull: pullSourceStage(config) !== null },
    { id: 'priority_setters', members: prioritySetterMembers(config).map((member) => member.handle) },
    { id: 'complexity_setters', members: complexitySetterMembers(config).map((member) => member.handle) },
  );
  if (config.team.assigneeFit === 'automatic_and_ai')
    rules.push({ id: 'assignee_fit', tempMaxPoints: tempMaxPointsOf(config) });
  const reviewStageId = stageLackingLabel(stages, ACCEPTANCE_OPEN_LABEL);
  const doneStageId = stageLackingLabel(
    stages,
    ACCEPTANCE_UNCONFIRMED_LABEL,
    (stage) => stage.kind === 'done',
  );
  if (reviewStageId || doneStageId) rules.push({ id: 'acceptance', reviewStageId, doneStageId });
  if (projectManagersOf(config).length > 0)
    rules.push({
      id: 'project_manager_rights',
      moves: projectManagerMovesOf(config),
      lifecycle: [...projectManagerLifecycleOf(config)],
      prerequisiteOverride: prerequisiteOverrideOf(config) === 'people_and_project_manager',
    });
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
  rules.push({ id: 'viewer_recipients', mode: viewerRecipientsOf(config) });
  return rules;
}
