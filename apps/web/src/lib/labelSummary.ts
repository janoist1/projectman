import type { LabelView, Stage, Task } from '@projectman/shared';

/** The labels of a card as the board and the drawer show them (PM-1387). */
export interface LabelSummary {
  /** Shown as chips, in the card's order: area and tag labels, and process labels on a card still in progress. */
  shown: string[];
  /** Process labels folded into "+n" on a done card, in the card's order. */
  folded: string[];
  /** Conditions left out because their result is on the card as well ("needs plan" next to "plan ok"). */
  dropped: string[];
}

/** A card is done by its status or by its stage; a cancelled one keeps its own look. */
export function isDoneCard(task: Pick<Task, 'status' | 'stageId'>, stages: readonly Stage[]): boolean {
  if (task.status === 'cancelled') return false;
  return task.status === 'done' || stages.find((stage) => stage.id === task.stageId)?.kind === 'done';
}

/**
 * Results of the pipeline's `has_label: result, when: condition` gates, by condition. Read from the
 * gates and never from label ids or names, so every project's pipeline works. `lacks_label` is no pair,
 * and neither is a condition that points at itself.
 */
function pairsOf(stages: readonly Stage[]): Map<string, Set<string>> {
  const results = new Map<string, Set<string>>();
  for (const stage of stages) {
    for (const condition of stage.gate?.conditions ?? []) {
      if (condition.type !== 'has_label' || condition.when === undefined) continue;
      if (condition.when === condition.label) continue;
      results.set(condition.when, (results.get(condition.when) ?? new Set()).add(condition.label));
    }
  }
  return results;
}

/**
 * The labels that belong to the process: named by a gate (`label` or `when`), in the group of such a
 * label, or defined as blocking or as cleared by an event. Any other label is an area or a theme and
 * stays where it is, even with a definition; an unknown (imported) tag stays too.
 */
function processLabels(stages: readonly Stage[], definitions: readonly LabelView[]): Set<string> {
  const named = new Set<string>();
  for (const stage of stages) {
    for (const condition of stage.gate?.conditions ?? []) {
      named.add(condition.label);
      if (condition.when !== undefined) named.add(condition.when);
    }
  }
  const groups = new Set<string>();
  for (const definition of definitions) {
    if (named.has(definition.id) && definition.group) groups.add(definition.group);
  }
  const process = new Set(named);
  for (const definition of definitions) {
    if (
      (definition.group && groups.has(definition.group)) ||
      definition.blocks === true ||
      (definition.clearedWhen?.length ?? 0) > 0
    )
      process.add(definition.id);
  }
  return process;
}

/**
 * One rule for the board card and the drawer. First the pairs: a condition label is left out when a
 * result of the pipeline is on the card too. Then, on a done card, the remaining process labels are
 * folded; the count is of those. Without the label definitions (still loading) nothing is hidden.
 */
export function summarizeLabels(input: {
  labels: readonly string[];
  definitions: readonly LabelView[];
  stages: readonly Stage[];
  done: boolean;
}): LabelSummary {
  const { labels, definitions, stages, done } = input;
  if (definitions.length === 0 || stages.length === 0) return { shown: [...labels], folded: [], dropped: [] };
  const present = new Set(labels);
  const pairs = pairsOf(stages);
  const dropped = labels.filter((id) => [...(pairs.get(id) ?? [])].some((result) => present.has(result)));
  const remaining = labels.filter((id) => !dropped.includes(id));
  if (!done) return { shown: remaining, folded: [], dropped };
  const process = processLabels(stages, definitions);
  return {
    shown: remaining.filter((id) => !process.has(id)),
    folded: remaining.filter((id) => process.has(id)),
    dropped,
  };
}
