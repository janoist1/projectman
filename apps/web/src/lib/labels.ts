import { taskAuthors } from '@projectman/shared';
import type { LabelView, Task } from '@projectman/shared';

/** Why the viewer may not add or remove a label (the server has the final word). */
export type LabelRefusalReason = 'system_only' | 'not_holder' | 'self_review';

export function labelRefusalFor(
  labels: readonly LabelView[],
  id: string,
  me: string | null,
  task: Pick<Task, 'assignee' | 'links'>,
): LabelRefusalReason | null {
  const label = labels.find((entry) => entry.id === id);
  if (!label) return null; // a plain tag
  if (label.setBy === 'system') return 'system_only';
  if (!me || !label.holders.includes(me)) return 'not_holder';
  if (label.notByAuthor && taskAuthors(task as Task).includes(me)) return 'self_review';
  return null;
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
