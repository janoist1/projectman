import { isHumanOnlyLabel } from '../domain/label';
import type { GateCondition, Pipeline, Stage } from '../domain/pipeline';
import type { Task } from '../domain/task';
import { labelDefinition, labelHolders, labelSetters } from './labels';
import type { ProjectConfig } from './schema';

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

type GateConfig = Pick<ProjectConfig, 'team' | 'pipeline'>;
type GateTask = Pick<Task, 'labels' | 'assignee' | 'links'>;

/** Position of a stage in the pipeline, -1 when it does not exist. */
export function stageIndex(pipeline: Pick<Pipeline, 'stages'>, stageId: string): number {
  return pipeline.stages.findIndex((s) => s.id === stageId);
}

function stagesEntered(pipeline: Pick<Pipeline, 'stages'>, fromStageId: string, toStageId: string): Stage[] {
  const to = stageIndex(pipeline, toStageId);
  if (to < 0) return [];
  const from = stageIndex(pipeline, fromStageId);
  if (from < 0 || to <= from) return [pipeline.stages[to]!];
  return pipeline.stages.slice(from + 1, to + 1);
}

function conditionHolds(task: Pick<Task, 'labels'>, condition: GateCondition): boolean {
  const has = task.labels.includes(condition.label);
  return condition.type === 'has_label' ? has : !has;
}

/**
 * The humans who approve a task into this stage: the holders of every label only humans may
 * set that its gate requires (one entry per label held).
 */
export function stageApprovers(config: Pick<ProjectConfig, 'team' | 'pipeline'>, stage: Stage): string[] {
  return (stage.gate?.conditions ?? []).flatMap((c) => {
    const label = c.type === 'has_label' ? labelDefinition(config, c.label) : undefined;
    return label && isHumanOnlyLabel(label) ? labelHolders(config, label) : [];
  });
}

/** At least one linked PR is merged and none is still open (closed ones are ignored). */
export function pullRequestsMerged(task: Pick<Task, 'links'>): boolean {
  const prs = task.links.filter((l) => l.kind === 'pull_request');
  return (
    prs.some((l) => l.state === 'merged') && prs.every((l) => l.state === 'merged' || l.state === 'closed')
  );
}

/** Evaluates the gates of the entered stages; `forward` moves also respect blocking labels. */
function evaluateGates(
  task: GateTask,
  stages: Stage[],
  config: GateConfig,
  opts: { forward?: boolean } = {},
): GateEvaluation {
  const evaluation: GateEvaluation = { unmet: [], approvals: [] };
  for (const stage of stages) {
    for (const condition of stage.gate?.conditions ?? []) {
      if (conditionHolds(task, condition)) continue;
      const label = condition.type === 'has_label' ? labelDefinition(config, condition.label) : undefined;
      if (label && isHumanOnlyLabel(label)) {
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
  if (opts.forward && stages[0]) {
    for (const id of task.labels) {
      if (labelDefinition(config, id)?.blocks)
        evaluation.unmet.push({ stageId: stages[0].id, condition: { type: 'lacks_label', label: id } });
    }
  }
  return evaluation;
}

/** Gates of a move from one stage to another; forward moves also respect blocking labels. */
export function evaluateMove(
  task: GateTask,
  config: GateConfig,
  fromStageId: string,
  toStageId: string,
): GateEvaluation {
  const forward = stageIndex(config.pipeline, toStageId) > stageIndex(config.pipeline, fromStageId);
  return evaluateGates(task, stagesEntered(config.pipeline, fromStageId, toStageId), config, { forward });
}
