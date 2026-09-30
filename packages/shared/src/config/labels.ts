import type { Actor } from '../domain/event';
import { isHumanOnlyLabel } from '../domain/label';
import type { LabelDefinition, LabelRefusal } from '../domain/label';
import type { Stage } from '../domain/pipeline';
import type { Task } from '../domain/task';
import { dutyMembers, taskAuthors } from './duties';
import type { ProjectConfig } from './schema';

type LabelConfig = Pick<ProjectConfig, 'team' | 'pipeline'>;

export function labelDefinition(
  config: Pick<ProjectConfig, 'pipeline'>,
  id: string,
): LabelDefinition | undefined {
  return config.pipeline.labels.find((label) => label.id === id);
}

/** Label ids required by the gates of release stages (four eyes applies to them). */
export function releaseGateLabels(config: Pick<ProjectConfig, 'pipeline'>): Set<string> {
  return new Set(
    config.pipeline.stages
      .filter((stage) => stage.kind === 'release')
      .flatMap((stage) => stage.gate?.conditions ?? [])
      .filter((condition) => condition.type === 'has_label')
      .map((condition) => condition.label),
  );
}

/** Members who may set a label, before the self-review rule (system labels: nobody). */
export function labelHolders(config: Pick<ProjectConfig, 'team'>, label: LabelDefinition): string[] {
  const setBy = label.setBy;
  if (setBy === 'system') return [];
  if (setBy === 'anyone') return config.team.members.map((m) => m.handle);
  if (setBy === 'humans') return config.team.members.filter((m) => m.kind === 'human').map((m) => m.handle);
  const handles = new Set(setBy.members ?? []);
  for (const duty of setBy.duties ?? [])
    for (const member of dutyMembers(config, duty)) handles.add(member.handle);
  return config.team.members
    .filter((m) => handles.has(m.handle) && (!setBy.humansOnly || m.kind === 'human'))
    .map((m) => m.handle);
}

/** A label excludes the task's authors: its own rule, or four eyes on a release approval. */
export function labelExcludesAuthors(config: LabelConfig, label: LabelDefinition): boolean {
  return (
    label.notByAuthor === true ||
    (config.team.releaseFourEyes === true && releaseGateLabels(config).has(label.id))
  );
}

/** Members who may set a label on this task: holders minus authors where self-review is excluded. */
export function labelSetters(
  config: LabelConfig,
  label: LabelDefinition,
  task: Pick<Task, 'assignee' | 'links'>,
) {
  const authors = labelExcludesAuthors(config, label) ? taskAuthors(task) : [];
  return labelHolders(config, label).filter((handle) => !authors.includes(handle));
}

/**
 * Why an actor may not add or remove a label on a task, or null when it may. The system actor
 * (integrations, automatic clearing) may change any label; plain tags (no definition) are open.
 */
export function labelRefusal(
  config: LabelConfig,
  label: LabelDefinition | undefined,
  actor: Actor,
  task: Pick<Task, 'assignee' | 'links'>,
): LabelRefusal | null {
  if (actor.kind === 'system' || !label) return null;
  if (label.setBy === 'system') return 'system_only';
  if (isHumanOnlyLabel(label) && actor.kind !== 'human') return 'humans_only';
  if (!labelHolders(config, label).includes(actor.handle ?? '')) return 'not_holder';
  if (labelExcludesAuthors(config, label) && taskAuthors(task).includes(actor.handle ?? ''))
    return 'self_review';
  return null;
}

/** Labels a stage's gate requires, split into approvals (human-only) and other facts. */
export function gateLabels(config: Pick<ProjectConfig, 'pipeline'>, stage: Stage) {
  const required = (stage.gate?.conditions ?? []).filter((c) => c.type === 'has_label').map((c) => c.label);
  return {
    approvals: required.filter((id) => {
      const label = labelDefinition(config, id);
      return label !== undefined && isHumanOnlyLabel(label);
    }),
    facts: required.filter((id) => {
      const label = labelDefinition(config, id);
      return label === undefined || !isHumanOnlyLabel(label);
    }),
    forbidden: (stage.gate?.conditions ?? []).filter((c) => c.type === 'lacks_label').map((c) => c.label),
  };
}
