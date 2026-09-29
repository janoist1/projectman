import type { GateCondition, Pipeline, Stage, Task } from '@projectman/shared';

/**
 * Gate evaluation. A gate on a stage must hold before a task may ENTER that stage.
 * Moving forward enters every stage on the way (so skipping stages cannot bypass their
 * gates); moving backward enters only the target stage.
 */

export interface UnmetCondition {
  stageId: string;
  condition: GateCondition;
}

export interface ApprovalRequirement {
  stageId: string;
  /** Index of the human_approval condition in the stage's gate. */
  conditionIndex: number;
  approvers: string[];
}

export interface GateEvaluation {
  /** Conditions that do not hold (check_passed, pr_merged). */
  unmet: UnmetCondition[];
  /** human_approval conditions: satisfied only by an approver's explicit decision in the inbox. */
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

export function conditionHolds(task: Task, condition: GateCondition): boolean {
  switch (condition.type) {
    case 'check_passed':
      return task.checks[condition.check] === 'passed';
    case 'pr_merged':
      return pullRequestsMerged(task);
    case 'human_approval':
      return false;
  }
}

export function evaluateGates(task: Task, stages: Stage[]): GateEvaluation {
  const evaluation: GateEvaluation = { unmet: [], approvals: [] };
  for (const stage of stages) {
    (stage.gate?.conditions ?? []).forEach((condition, conditionIndex) => {
      if (condition.type === 'human_approval') {
        evaluation.approvals.push({ stageId: stage.id, conditionIndex, approvers: condition.approvers });
      } else if (!conditionHolds(task, condition)) {
        evaluation.unmet.push({ stageId: stage.id, condition });
      }
    });
  }
  return evaluation;
}
