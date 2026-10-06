import type { DutyId } from '../domain/duty';
import { CODE_REVIEW_CHANGES_LABEL, DESIGN_REVIEW_CHANGES_LABEL } from '../domain/card-measure';
import { isHumanOnlyLabel } from '../domain/label';
import type { LabelDefinition } from '../domain/label';
import type { GateCondition, Stage } from '../domain/pipeline';
import { isCodeReviewStage, memberDuties, stageDuty, stageOwners } from './duties';
import { labelDefinition, labelExcludesAuthors, labelHolders } from './labels';
import { memberRoles } from './lookup';
import { refinementSetters } from './refinement';
import type { MemberConfig, ProjectConfig } from './schema';
import { teamRules } from './team-rules';
import type { TeamRule } from './team-rules';

export interface TeamMap {
  stages: TeamMapStage[];
  labels: TeamMapLabel[];
  members: TeamMapMember[];
  rules: TeamRule[];
  blockingLabels: string[];
  fixRounds: TeamMapFixRounds;
  refinement: TeamMapRefinement | null;
}
export interface TeamMapStage {
  stage: Stage;
  duty: DutyId | null;
  owners: string[];
  ownersFrom: 'members' | 'duty' | 'none';
  approvals: string[];
  humanDecides: boolean;
  nextStageId: string | null;
}
export interface TeamMapLabel {
  label: LabelDefinition;
  approval: boolean;
  holders: string[];
  excludesAuthors: boolean;
  fixRound: boolean;
  usedBy: { stageId: string; condition: GateCondition; as: 'label' | 'when' }[];
}
export interface TeamMapMember {
  member: MemberConfig;
  roles: string[];
  duties: DutyId[];
  ownsStages: string[];
  sets: string[];
  approves: string[];
}
export interface TeamMapFixRounds {
  limit: number;
  labels: string[];
  lead: string | null;
  deciders: string[];
  loops: { fromStageId: string; toStageId: string; label: string | null }[];
}
export interface TeamMapRefinement {
  label: string | null;
  stageIds: string[];
  workStageId: string;
  steps: {
    stageId: string;
    label: string;
    when: string | null;
    aiSetters: string[];
    humanSetters: string[];
  }[];
}

export function teamMap(config: Pick<ProjectConfig, 'team' | 'pipeline'>): TeamMap {
  const rules = teamRules(config);
  const labels: TeamMapLabel[] = config.pipeline.labels.map((label) => ({
    label,
    approval: isHumanOnlyLabel(label),
    holders: labelHolders(config, label),
    excludesAuthors: labelExcludesAuthors(config, label),
    fixRound: label.id === CODE_REVIEW_CHANGES_LABEL || label.id === DESIGN_REVIEW_CHANGES_LABEL,
    usedBy: config.pipeline.stages.flatMap((stage) =>
      (stage.gate?.conditions ?? []).flatMap((condition) => {
        const uses: TeamMapLabel['usedBy'] = [];
        if (condition.label === label.id) uses.push({ stageId: stage.id, condition, as: 'label' });
        if (condition.when === label.id) uses.push({ stageId: stage.id, condition, as: 'when' });
        return uses;
      }),
    ),
  }));
  const stages: TeamMapStage[] = config.pipeline.stages.map((stage, index) => {
    const approvals = (stage.gate?.conditions ?? [])
      .filter(
        (condition) =>
          condition.type === 'has_label' &&
          labels.some((label) => label.label.id === condition.label && label.approval),
      )
      .map((condition) => condition.label);
    return {
      stage,
      duty: stageDuty(stage) ?? null,
      owners: stageOwners(config, stage),
      ownersFrom: stage.owners !== undefined ? 'members' : stage.duty ? 'duty' : 'none',
      approvals,
      humanDecides: approvals.length > 0 || stage.kind === 'release',
      nextStageId: config.pipeline.stages[index + 1]?.id ?? null,
    };
  });
  const members = config.team.members.map((member): TeamMapMember => {
    const sets = labels.filter(
      (label) =>
        label.label.setBy !== 'anyone' &&
        label.label.setBy !== 'system' &&
        label.holders.includes(member.handle),
    );
    return {
      member,
      roles: memberRoles(member),
      duties: memberDuties(config, member),
      ownsStages: stages
        .filter((stage) => stage.owners.includes(member.handle))
        .map((stage) => stage.stage.id),
      sets: sets.map((label) => label.label.id),
      approves: sets.filter((label) => label.approval).map((label) => label.label.id),
    };
  });
  const fix = rules.find((rule) => rule.id === 'fix_limit')!;
  const { id: _fixId, ...fixFields } = fix;
  const loops = stages.flatMap(({ stage }, index) => {
    if (!isCodeReviewStage(config, stage)) return [];
    const work = stages
      .slice(0, index)
      .reverse()
      .find((entry) => entry.stage.kind === 'work');
    return work
      ? [
          {
            fromStageId: stage.id,
            toStageId: work.stage.id,
            label: labelDefinition(config, CODE_REVIEW_CHANGES_LABEL) ? CODE_REVIEW_CHANGES_LABEL : null,
          },
        ]
      : [];
  });
  const refine = rules.find((rule) => rule.id === 'refinement');
  let refinement: TeamMapRefinement | null = null;
  if (refine) {
    const steps = stages
      .slice(0, stages.findIndex((entry) => entry.stage.id === refine.workStageId) + 1)
      .flatMap(({ stage }) =>
        (stage.gate?.conditions ?? [])
          .filter(
            (condition) =>
              condition.type === 'has_label' && labelDefinition(config, condition.label)?.setBy !== 'system',
          )
          .map((condition) => {
            const definition = labelDefinition(config, condition.label);
            return {
              stageId: stage.id,
              label: condition.label,
              when: condition.when ?? null,
              ...refinementSetters(config, definition, definition ? labelHolders(config, definition) : []),
            };
          }),
      );
    refinement = { label: refine.label, stageIds: refine.stageIds, workStageId: refine.workStageId, steps };
  }
  return {
    stages,
    labels,
    members,
    rules,
    blockingLabels: labels.filter((entry) => entry.label.blocks).map((entry) => entry.label.id),
    fixRounds: { ...fixFields, loops },
    refinement,
  };
}
