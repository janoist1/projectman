import { labelDefinition, labelRefusal } from '@projectman/shared';
import type { LabelRefusal, LabelView, ProjectConfig, Task } from '@projectman/shared';

/**
 * Why the viewer (a human) may not add or remove a label on a task, or null when they may. It
 * is the server's own rule, including four eyes on release approvals, so the picker only
 * offers what the server accepts.
 */
export function viewerLabelRefusal(
  config: Pick<ProjectConfig, 'team' | 'pipeline'>,
  id: string,
  me: string,
  task: Pick<Task, 'assignee' | 'links'>,
): LabelRefusal | null {
  return labelRefusal(config, labelDefinition(config, id), { kind: 'human', handle: me }, task);
}

/** Defined labels grouped for pickers: each group is one "state"; ungrouped labels come last. */
export function labelGroups(labels: readonly LabelView[]): LabelView[][] {
  const groups = new Map<string, LabelView[]>();
  const loose: LabelView[] = [];
  for (const label of labels) {
    if (!label.group) loose.push(label);
    else groups.set(label.group, [...(groups.get(label.group) ?? []), label]);
  }
  return [...groups.values(), ...loose.map((label) => [label])];
}
