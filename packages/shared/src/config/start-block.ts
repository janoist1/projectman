import type { Task } from '../domain/task';
import { isOpenTask, isTheme } from '../domain/task';
import { aiLabelSetters, evaluateStart, stageIndex } from './gates';
import { labelDefinition } from './labels';
import { developmentStage, projectRefines, refinementTurn } from './refinement';
import type { RefinementTurn } from './refinement';
import type { ProjectConfig } from './schema';

/**
 * Whether a person's Start of a card is refused now, and why (PM-291). One rule for the server (which
 * refuses with `gate_blocked`) and for the web (which offers the Start only when it is not refused, and
 * says on the status line what the card waits for instead).
 */

type StartTask = Pick<Task, 'status' | 'kind' | 'stageId' | 'labels' | 'assignee' | 'links'>;
type StartConfig = Pick<ProjectConfig, 'team' | 'pipeline'>;

/** One step of a card's refinement: a label the gates before the work stage ask for. */
export interface RefinementStep {
  label: string;
  done: boolean;
}

export interface RefinementProgress {
  steps: RefinementStep[];
  turn: NonNullable<RefinementTurn>;
  /** The stage the card moves to once every step is done; null when it stands there already. */
  targetStageId: string | null;
}

/** Why a person's Start of a card before the work stage is refused now; null: it goes ahead. */
export type StartBlock =
  | { kind: 'refining'; refinement: RefinementProgress }
  | { kind: 'held'; labels: string[] }
  | { kind: 'approval'; label: string; approvers: string[] }
  | { kind: 'unmet'; labels: string[]; refines: boolean };

/**
 * The steps of a card's refinement: the labels the gates ask for, from the stage the card is in to the
 * work stage (that one too), in the order of the gates and of their conditions. A condition bound to a
 * `when` label counts only when the card carries that label. Each label once; `done` when it is on the card.
 */
export function refinementSteps(task: StartTask, config: StartConfig): RefinementStep[] {
  const { stages } = config.pipeline;
  const to = stages.findIndex((stage) => stage.kind === 'work');
  const from = stageIndex(config.pipeline, task.stageId);
  const labels = stages
    .slice(Math.max(from, 0), to >= 0 ? to + 1 : undefined)
    .flatMap((stage) => stage.gate?.conditions ?? [])
    .flatMap((condition) =>
      condition.type === 'has_label' && (condition.when === undefined || task.labels.includes(condition.when))
        ? [condition.label]
        : [],
    );
  return [...new Set(labels)].map((label) => ({ label, done: task.labels.includes(label) }));
}

/** The standing of a card's refinement; null when the card is not being refined. */
export function refinementProgress(task: StartTask, config: StartConfig): RefinementProgress | null {
  const turn = refinementTurn(task, config);
  if (!turn) return null;
  const { stages } = config.pipeline;
  const from = stageIndex(config.pipeline, task.stageId);
  const to = stageIndex(config.pipeline, developmentStage(config)!.id);
  return {
    steps: refinementSteps(task, config),
    turn,
    targetStageId: to - 1 > from ? stages[to - 1]!.id : null,
  };
}

/** Why a person's Start of this card is refused now; null when it goes ahead (or there is no start to gate). */
export function startBlock(task: StartTask, config: StartConfig): StartBlock | null {
  if (!isOpenTask(task) || isTheme(task)) return null;
  const work = developmentStage(config);
  if (!work || stageIndex(config.pipeline, task.stageId) >= stageIndex(config.pipeline, work.id)) return null;

  const refinement = refinementProgress(task, config);
  if (refinement) return { kind: 'refining', refinement };

  const held = task.labels.filter((id) => labelDefinition(config, id)?.blocks);
  if (held.length > 0) return { kind: 'held', labels: held };

  const evaluation = evaluateStart(task, config, work.id);
  const approval = evaluation.approvals.find((a) => a.stageId === task.stageId);
  if (approval) return { kind: 'approval', label: approval.label, approvers: approval.approvers };

  if (evaluation.unmet.length === 0) return null;
  const refines = projectRefines(config);
  // A project without refinement starts the setters of the missing labels (PM-236): not a dead end.
  if (!refines && aiLabelSetters(config, evaluation.unmet, () => false)) return null;
  return { kind: 'unmet', labels: [...new Set(evaluation.unmet.map((u) => u.condition.label))], refines };
}
