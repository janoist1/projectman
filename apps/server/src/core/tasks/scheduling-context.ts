import { taskSeq } from '@projectman/shared';
import type { Task } from '@projectman/shared';
import type { TaskSchedulingReader } from '../../contracts';

/** The cards this one names with `prerequisite` links, closed ones too, read for exactly their keys (PM-770). */
export function prerequisiteCards(
  reader: TaskSchedulingReader,
  projectKey: string,
  card: Pick<Task, 'links'>,
): Task[] {
  const keys = card.links.filter((link) => link.kind === 'prerequisite').map((link) => link.ref);
  return keys.length === 0 ? [] : reader.readSchedulingTasks(projectKey, { kind: 'keys', keys });
}

/**
 * The rows the shared start rules look at for these cards (PM-770), read for exactly them: the cards, their
 * subtasks, including closed ones (a collector must not get a start offer), and the cards their
 * `prerequisite` links name, closed ones too (`openPrerequisites` tells which are open), and the parents and
 * themes of the cards, closed ones too (`effectivePriority` skips the closed). Given to the unchanged
 * shared rules (`pullCandidates`, `startableCards`, `openPrerequisites`) in place of the project's whole list,
 * so no gate or priority rule is repeated here. The result is by number, once each; no cards: no read.
 * The parents, the themes and the prerequisites come in one read by keys; a subtask's theme is its parent's
 * (the stored row has none), so the themes of the parents that are not known yet take a second read.
 */
export function startContext(
  reader: TaskSchedulingReader,
  projectKey: string,
  cards: readonly Task[],
): Task[] {
  if (cards.length === 0) return [];
  const known = new Map(cards.map((card) => [card.key, card]));
  const children = reader.readSchedulingTasks(projectKey, {
    kind: 'children',
    parentKeys: cards.map((card) => card.key),
    includeClosed: true,
  });
  for (const child of children) known.set(child.key, child);
  const readKeys = (keys: Iterable<string | null | undefined>) => {
    const wanted = [...new Set([...keys].filter((key): key is string => !!key))].filter(
      (key) => !known.has(key),
    );
    if (wanted.length > 0)
      for (const target of reader.readSchedulingTasks(projectKey, { kind: 'keys', keys: wanted }))
        known.set(target.key, target);
  };
  const all = [...known.values()];
  readKeys([
    ...cards.flatMap((card) =>
      card.links.filter((link) => link.kind === 'prerequisite').map((link) => link.ref),
    ),
    ...all.flatMap((card) => [card.parentKey, card.themeKey]),
  ]);
  readKeys(all.map((card) => (card.parentKey ? known.get(card.parentKey)?.themeKey : undefined)));
  return [...known.values()].sort((a, b) => taskSeq(a.key) - taskSeq(b.key));
}
