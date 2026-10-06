import { effectiveRepo, isHumanOnlyLabel, needsRepoChoice, repoOf } from '@projectman/shared';
import type { Gate, LabelDefinition, ProjectConfig, Stage, Task } from '@projectman/shared';
import { describeRepo } from '../agent-text';
import type { TextStyle } from '../agent-text';
import type { CardRelation } from '../contracts';

/** Inline-code form of a handle, task key or id: `fe-1`. */
export function code(value: string): string {
  return `\`${value}\``;
}

export function codeList(values: readonly string[]): string {
  return values.map(code).join(', ');
}

/**
 * Where the task's work happens, worded for the brief and the system prompt: its repository as
 * inline code (the task's own, else the project's only one), else why it has none.
 */
export function repoText(project: Pick<ProjectConfig, 'project'>, task: Pick<Task, 'repo'>): string {
  return describeRepo(
    { name: effectiveRepo(project, task), choiceNeeded: needsRepoChoice(project, task) },
    { code },
  );
}

/**
 * What the server's full test of the handed-over commit found (PM-217), for the reviewer's brief and
 * its resume message; none while there is no result (not asked for, still queued or running).
 */
export function fullTestLine(project: ProjectConfig, task: Pick<Task, 'repo' | 'reviewPin'>): string | null {
  const test = task.reviewPin?.fullTest;
  if (!test) return null;
  const command = repoOf(project, effectiveRepo(project, task))?.reviewTest?.command ?? 'the full test';
  if (test.status === 'passed')
    return `The full test (${code(command)}, PTY tests included) passed on this commit at ${test.at}: you need not run the tests or the type check again.`;
  if (test.status === 'error')
    return repoOf(project, effectiveRepo(project, task))?.fullTestAtMerge
      ? `The full test could not run on this commit (${test.reason ? code(test.reason) : 'unknown reason'}): run only targeted checks if needed for this review. Do not run the whole test suite: the integrator or merge step runs the full check before merge.`
      : `The full test could not run on this commit (${test.reason ? code(test.reason) : 'unknown reason'}): run the checks yourself as usual; your sandbox leaves out the PTY tests.`;
  return null;
}

/** "Code review (`code_review`)" */
export function stageLabel(stage: Stage): string {
  return `${stage.name} (${code(stage.id)})`;
}

const RELATION_TEXT: Record<CardRelation, string> = {
  parent: 'the parent card',
  subtask: 'a subtask of this card',
  prerequisite: 'a prerequisite of this card',
  prerequisite_of: 'a card that has this one as a prerequisite',
};

/** How a related card is worded: "the parent card". */
export function relationText(relation: CardRelation): string {
  return RELATION_TEXT[relation];
}

/** "`qa-ok` (QA ok)": a label by id and name. */
export function labelRef(id: string, labels: readonly LabelDefinition[]): string {
  const label = labels.find((l) => l.id === id);
  return label && label.name !== id ? `${code(id)} (${label.name})` : code(id);
}

/**
 * "label `code-review-ok` (Code review ok) and no label `waiting-answer` (...)", or null without a
 * gate. A condition that binds only some cards says which: "..., only on cards with label `ui`".
 */
export function describeGate(gate: Gate | undefined, labels: readonly LabelDefinition[]): string | null {
  if (!gate || gate.conditions.length === 0) return null;
  return gate.conditions
    .map((condition) => {
      const label = labels.find((l) => l.id === condition.label);
      const approval = label && isHumanOnlyLabel(label) ? ', a human approval' : '';
      const only = condition.when ? `, only on cards with label ${labelRef(condition.when, labels)}` : '';
      return condition.type === 'has_label'
        ? `label ${labelRef(condition.label, labels)}${approval}${only}`
        : `no label ${labelRef(condition.label, labels)}${only}`;
    })
    .join(' and ');
}

const FALLBACK_LANGUAGE_NAMES: Record<string, string> = { en: 'English', hu: 'Hungarian' };

/** English name of a BCP 47 language tag ("hu" -> "Hungarian"); the tag itself if unknown. */
export function languageName(tag: string): string {
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(tag);
    if (name && name.toLowerCase() !== tag.toLowerCase()) return name;
  } catch {
    // invalid tag: fall through
  }
  return FALLBACK_LANGUAGE_NAMES[tag.toLowerCase()] ?? tag;
}

/** Markdown with names for prompt text: handles as inline code, stage names, labels with their names. */
export function promptStyle(project: Pick<ProjectConfig, 'pipeline'>): TextStyle {
  const { stages, labels } = project.pipeline;
  return {
    code,
    stage: (id) => stages.find((s) => s.id === id)?.name ?? id,
    label: (id) => labelRef(id, labels),
  };
}

/** Lowercases the first character ("Move the task" -> "move the task"). */
export function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
