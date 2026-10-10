import { isHumanOnlyLabel, releaseGateAccepts } from '../domain/label';
import type { LabelDefinition } from '../domain/label';
import type { GateCondition, Pipeline, Stage } from '../domain/pipeline';
import type { Task } from '../domain/task';
import { isOnLeave } from './leave';
import { labelDefinition, labelHolders, labelSetters } from './labels';
import { memberOf } from './lookup';
import type { AiMemberConfig, ProjectConfig } from './schema';

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
  /** Who may put the missing label on the task (a `has_label` condition on a label that is not a human approval). */
  setters?: string[];
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

/** Whether the task meets a gate condition (one bound to a `when` label the task lacks always holds). */
export function conditionHolds(task: Pick<Task, 'labels'>, condition: GateCondition): boolean {
  if (condition.when !== undefined && !task.labels.includes(condition.when)) return true;
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

/**
 * Whether the gate of a stage may hold this condition on this label. The approval of a release is
 * the release approval duty's alone (decision 19), so a release gate may not require a label that
 * other humans may set (`releaseGateAccepts`). Forbidding a label is no approval, and the gates of
 * other stages take any label. A release gate holds for every task, so it takes no `when` either:
 * a condition that binds only some tasks would weaken the approval.
 */
export function gateAcceptsCondition(
  stage: Pick<Stage, 'kind'>,
  condition: Pick<GateCondition, 'type' | 'when'>,
  label: Pick<LabelDefinition, 'setBy'>,
): boolean {
  return (
    gateAcceptsWhen(stage, condition) &&
    (stage.kind !== 'release' || condition.type !== 'has_label' || releaseGateAccepts(label))
  );
}

/** Whether the gate of a stage may bind this condition to a `when` label (never on a release gate). */
export function gateAcceptsWhen(stage: Pick<Stage, 'kind'>, condition: Pick<GateCondition, 'when'>): boolean {
  return stage.kind !== 'release' || condition.when === undefined;
}

/** At least one linked PR is merged and none is still open (closed ones are ignored). */
export function pullRequestsMerged(task: Pick<Task, 'links'>): boolean {
  const prs = task.links.filter((l) => l.kind === 'pull_request');
  return (
    prs.some((l) => l.state === 'merged') && prs.every((l) => l.state === 'merged' || l.state === 'closed')
  );
}

/** The labels a gate lacks that AI members set, and the members who set them (PM-236). */
export interface AiLabelSetters {
  labels: string[];
  /** One AI member per label, the same member once. */
  members: AiMemberConfig[];
}

/**
 * When a gate refuses a move only for labels that AI members can put on the card, who sets them:
 * a person's Start then starts that member first instead of being refused. Null when anything else
 * is unmet (a blocking label, a label nobody or only a person sets): the refusal stays. `known`
 * ranks the setters: one that already has a session on the card goes first, one on leave last (its
 * start would only be refused).
 */
export function aiLabelSetters(
  config: Pick<ProjectConfig, 'team'>,
  unmet: readonly UnmetCondition[],
  known: (handle: string) => boolean,
): AiLabelSetters | null {
  if (unmet.length === 0) return null;
  const rank = (m: AiMemberConfig) => (isOnLeave(m) ? 2 : 0) + (known(m.handle) ? 0 : 1);
  const labels: string[] = [];
  const members: AiMemberConfig[] = [];
  for (const u of unmet) {
    if (u.condition.type !== 'has_label') return null;
    const candidates = (u.setters ?? [])
      .map((handle) => memberOf(config, handle))
      .filter((m): m is AiMemberConfig => m?.kind === 'ai')
      .sort((a, b) => rank(a) - rank(b));
    const setter = members.find((m) => candidates.includes(m)) ?? candidates[0];
    if (!setter) return null;
    if (!labels.includes(u.condition.label)) labels.push(u.condition.label);
    if (!members.includes(setter)) members.push(setter);
  }
  return { labels, members };
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
        evaluation.unmet.push({
          stageId: stage.id,
          condition,
          ...(label ? { setters: labelSetters(config, label, task) } : {}),
        });
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

/**
 * Gates of a person's Start of a card (PM-248): every gate on the way to the work stage, and the
 * entry gate of the stage the card is in as well. A card that sits in a stage while its entry gate
 * does not hold (it got there before the gate existed, or the label the gate is `when` on came
 * later) is not let through by a Start. A card already in or past the work stage has no start to
 * gate: the result is empty.
 */
export function evaluateStart(
  task: GateTask & Pick<Task, 'stageId'>,
  config: GateConfig,
  workStageId: string,
): GateEvaluation {
  const from = stageIndex(config.pipeline, task.stageId);
  const to = stageIndex(config.pipeline, workStageId);
  if (from < 0 || to <= from) return { unmet: [], approvals: [] };
  return evaluateGates(task, config.pipeline.stages.slice(from, to + 1), config, { forward: true });
}

/**
 * What the card does next on its own (PM-445): the next stage, entered because every condition of its
 * gate holds (`move`), or because only approvals only a person may give are missing (`approve`: the
 * system asks for them in the inbox).
 */
export type StageAdvance =
  { kind: 'move'; to: Stage } | { kind: 'approve'; to: Stage; approvals: ApprovalRequirement[] };

/**
 * The rule of a card that goes on by itself (PM-445). Only a card in a `step` or `release` stage does,
 * because there the result of the stage is a label: the gate of the next stage then says the stage is done.
 * A `work` stage never goes on by itself (its gate does not say the work is finished: the developer hands
 * it over), nor does a queue, a card never goes on by itself into a work stage (that starts the work), and a
 * next stage with no gate has no result to wait for. Null when a
 * condition other than a human approval is unmet, a blocking label holds the card, or there is no next stage.
 * Whether somebody works on the card, or it is held in another way, is the caller's to check.
 */
export function stageAdvance(
  task: GateTask & Pick<Task, 'stageId'>,
  config: GateConfig,
): StageAdvance | null {
  const stages = config.pipeline.stages;
  const from = stages[stageIndex(config.pipeline, task.stageId)];
  const to = from ? stages[stageIndex(config.pipeline, from.id) + 1] : undefined;
  if (!from || !to || (from.kind !== 'step' && from.kind !== 'release')) return null;
  // Entering a work stage starts the work: that is the refinement's and the people's to decide.
  if (to.kind === 'work') return null;
  // The result of the stage must be a label this card is to get: a `has_label` condition that binds it.
  const resultLabel = (to.gate?.conditions ?? []).some(
    (c) => c.type === 'has_label' && (c.when === undefined || task.labels.includes(c.when)),
  );
  if (!resultLabel) return null;
  const evaluation = evaluateMove(task, config, from.id, to.id);
  if (evaluation.unmet.length > 0) return null;
  return evaluation.approvals.length > 0
    ? { kind: 'approve', to, approvals: evaluation.approvals }
    : { kind: 'move', to };
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
