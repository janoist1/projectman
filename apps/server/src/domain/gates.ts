import { isHumanOnlyLabel, labelDefinition, labelSetters } from '@projectman/shared';
import type { GateCondition, Pipeline, Stage, Task, ProjectConfig } from '@projectman/shared';

/**
 * Gate evaluation. A gate on a stage must hold before a task may ENTER that stage.
 * Moving forward enters every stage on the way (so skipping stages cannot bypass their
 * gates); moving backward enters only the target stage. Conditions are about labels: a
 * missing label only humans may set is an approval to request in the inbox, and a blocking
 * label on the task (e.g. "waiting for an answer") holds every forward move.
 */

export interface UnmetCondition {
  stageId: string;
  condition: GateCondition;
}

export interface ApprovalRequirement {
  stageId: string;
  /** The human-only label that stands for the approval. */
  label: string;
  /** Humans who may set it on this task (self-review and four eyes applied). */
  approvers: string[];
}

export interface GateEvaluation {
  /** Label conditions that do not hold, blocking labels included. */
  unmet: UnmetCondition[];
  /** Missing human-only labels: satisfied only by an approver's explicit decision in the inbox. */
  approvals: ApprovalRequirement[];
}

export function stageIndex(pipeline: Pipeline, stageId: string): number {
  return pipeline.stages.findIndex((s) => s.id === stageId);
}

export function stagesEntered(pipeline: Pipeline, fromStageId: string, toStageId: string): Stage[] {
  const to = stageIndex(pipeline, toStageId);
  if (to < 0) return [];
  const from = stageIndex(pipeline, fromStageId);
  if (from < 0 || to <= from) return [pipeline.stages[to]!];
  return pipeline.stages.slice(from + 1, to + 1);
}

/** At least one linked PR is merged and none is still open (closed ones are ignored). */
export function pullRequestsMerged(task: Task): boolean {
  const prs = task.links.filter((l) => l.kind === 'pull_request');
  return (
    prs.some((l) => l.state === 'merged') && prs.every((l) => l.state === 'merged' || l.state === 'closed')
  );
}

export function conditionHolds(task: Pick<Task, 'labels'>, condition: GateCondition): boolean {
  const has = task.labels.includes(condition.label);
  return condition.type === 'has_label' ? has : !has;
}

export function evaluateGates(
  task: Task,
  stages: Stage[],
  config?: ProjectConfig,
  opts: { forward?: boolean } = {},
): GateEvaluation {
  const evaluation: GateEvaluation = { unmet: [], approvals: [] };
  for (const stage of stages) {
    for (const condition of stage.gate?.conditions ?? []) {
      if (conditionHolds(task, condition)) continue;
      const label =
        config && condition.type === 'has_label' ? labelDefinition(config, condition.label) : undefined;
      if (config && label && isHumanOnlyLabel(label)) {
        evaluation.approvals.push({
          stageId: stage.id,
          label: label.id,
          approvers: labelSetters(config, label, task),
        });
      } else {
        evaluation.unmet.push({ stageId: stage.id, condition });
      }
    }
  }
  if (config && opts.forward && stages[0]) {
    for (const id of task.labels) {
      if (labelDefinition(config, id)?.blocks)
        evaluation.unmet.push({ stageId: stages[0].id, condition: { type: 'lacks_label', label: id } });
    }
  }
  return evaluation;
}

/** Gates of a move from one stage to another; forward moves also respect blocking labels. */
export function evaluateMove(task: Task, config: ProjectConfig, fromStageId: string, toStageId: string) {
  const forward = stageIndex(config.pipeline, toStageId) > stageIndex(config.pipeline, fromStageId);
  return evaluateGates(task, stagesEntered(config.pipeline, fromStageId, toStageId), config, { forward });
}
