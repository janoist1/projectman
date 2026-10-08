import { z } from 'zod';
import { isOpenTask, isTheme, subtaskParentRefusal, TaskKey, taskSeq } from './task';
import type { SubtaskParentRefusal, Task, TaskKind, TaskLink } from './task';
import type { StageKind } from './pipeline';

/**
 * Relations between the cards of a project (PM-192). Storage has no table of its own: "part of"
 * is `Task.parentKey`, and the other three live as `Task.links` of the card that set them
 * (`prerequisite`, `related`, `duplicate_of`; `ref` is the other card's key), once. The other
 * direction is read, never stored, so a relation cannot disagree with itself. This module is the
 * one place that turns the stored form into what a card shows, and decides what may be stored.
 */

/** What a card shows: the stored kinds, each seen from both of its cards. */
export const TaskRelationKind = z.enum([
  'part_of',
  'has_part',
  'prerequisite',
  'prerequisite_of',
  'related',
  'duplicate_of',
  'duplicated_by',
]);
export type TaskRelationKind = z.infer<typeof TaskRelationKind>;

/** The kinds in the order a card lists them. */
export const TASK_RELATION_KINDS: readonly TaskRelationKind[] = TaskRelationKind.options;

/** The kinds that are stored on the card that sets them: the forward ones, which may be added. */
export const AddableRelationKind = z.enum(['part_of', 'prerequisite', 'related', 'duplicate_of']);
export type AddableRelationKind = z.infer<typeof AddableRelationKind>;

/**
 * The kinds a theme cannot have from its own side: it is no part of another card, and it has no
 * prerequisites (`relationRefusal` refuses both). A theme also collects no subtasks (the other
 * direction of `part_of`). A theme may be related to any card and duplicate only a theme.
 */
export const THEME_REFUSED_KINDS: readonly AddableRelationKind[] = ['part_of', 'prerequisite'];

/**
 * The kinds that may change the work of a card that is being worked on (PM-421): the order of work
 * changes (a prerequisite, either way), or another card was closed as this card's duplicate, so its
 * content may belong here. The `duplicate_of` side is no check: that card is closed by it.
 */
export const ANALYST_CHECK_RELATIONS: readonly TaskRelationKind[] = [
  'prerequisite',
  'prerequisite_of',
  'duplicated_by',
];

/** Whether a new relation of this kind asks the card's analyst to check whether it changes the work. */
export function relationAsksAnalyst(kind: TaskRelationKind): boolean {
  return ANALYST_CHECK_RELATIONS.includes(kind);
}

/** The `TaskLink` kinds that relate two cards. */
export const RELATION_LINK_KINDS = ['prerequisite', 'related', 'duplicate_of'] as const;
export type RelationLinkKind = (typeof RELATION_LINK_KINDS)[number];

export function isRelationLinkKind(kind: string): kind is RelationLinkKind {
  return (RELATION_LINK_KINDS as readonly string[]).includes(kind);
}

/** Whether a link relates two cards (rather than pointing at a pull request, a branch or the web). */
export function isCardLink(link: Pick<TaskLink, 'kind'>): boolean {
  return isRelationLinkKind(link.kind);
}

export const RelationRef = z.object({ kind: TaskRelationKind, key: TaskKey });
export type RelationRef = z.infer<typeof RelationRef>;

export const AddRelationRef = z.object({ kind: AddableRelationKind, key: TaskKey });
export type AddRelationRef = z.infer<typeof AddRelationRef>;

/** A change of a card's relations (`UpdateTaskRequest.relations`): removals apply first, then additions. */
export const RelationsChange = z.object({
  add: z.array(AddRelationRef).optional(),
  remove: z.array(RelationRef).optional(),
});
export type RelationsChange = z.infer<typeof RelationsChange>;

/** The cards another card relates to, with what is needed to list them. */
export type RelatedCard = Pick<Task, 'key' | 'title' | 'stageId' | 'status'>;

export interface TaskRelation extends RelatedCard {
  kind: TaskRelationKind;
}

/** What `taskRelations` reads of a card. */
export type RelationCard = Pick<
  Task,
  'key' | 'title' | 'stageId' | 'status' | 'projectKey' | 'parentKey' | 'links' | 'kind'
>;

/** The key a card-to-card link points at, for the link kinds that relate cards. */
function linkTargets(card: Pick<RelationCard, 'links'>, kind: RelationLinkKind): string[] {
  return card.links.filter((link) => link.kind === kind).map((link) => link.ref);
}

const REVERSE: Record<RelationLinkKind, TaskRelationKind> = {
  prerequisite: 'prerequisite_of',
  related: 'related',
  duplicate_of: 'duplicated_by',
};

/** How a stored link reads on the card it points at: `prerequisite` is `prerequisite_of` there. */
export function reverseRelationKind(kind: RelationLinkKind): TaskRelationKind {
  return REVERSE[kind];
}

function bySeq(a: RelatedCard, b: RelatedCard): number {
  return taskSeq(a.key) - taskSeq(b.key);
}

/**
 * The relations of `task` seen from it, both directions: its parent and its subtasks, the cards it
 * has as prerequisites and the cards that have it, the related cards (stored on either), the
 * original it duplicates and its duplicates. Grouped in `TASK_RELATION_KINDS` order, by key
 * within a kind. A relation to a card that is not in `tasks` is left out, so a caller that
 * passes only the cards a viewer may see gets only those. A card that is on a relation twice
 * (related on both cards) is listed once.
 */
export function taskRelations(task: RelationCard, tasks: readonly RelationCard[]): TaskRelation[] {
  const byKey = new Map(tasks.map((card) => [card.key, card]));
  const found = new Map<string, TaskRelation>();
  const add = (kind: TaskRelationKind, card: RelationCard | undefined) => {
    if (!card || card.key === task.key) return;
    const id = `${kind}:${card.key}`;
    if (!found.has(id))
      found.set(id, { kind, key: card.key, title: card.title, stageId: card.stageId, status: card.status });
  };
  if (task.parentKey) add('part_of', byKey.get(task.parentKey));
  for (const card of tasks) if (card.parentKey === task.key) add('has_part', card);
  for (const kind of RELATION_LINK_KINDS) {
    for (const ref of linkTargets(task, kind)) add(kind, byKey.get(ref));
    for (const card of tasks) if (linkTargets(card, kind).includes(task.key)) add(REVERSE[kind], card);
  }
  const order = new Map(TASK_RELATION_KINDS.map((kind, index) => [kind, index]));
  return [...found.values()].sort((a, b) => order.get(a.kind)! - order.get(b.kind)! || bySeq(a, b));
}

/** The prerequisites of `task` that are not closed yet: the work that has to finish first. */
export function openPrerequisites(
  task: Pick<RelationCard, 'links'>,
  tasks: readonly RelatedCard[],
): RelatedCard[] {
  const byKey = new Map(tasks.map((card) => [card.key, card]));
  return linkTargets(task, 'prerequisite')
    .map((ref) => byKey.get(ref))
    .filter((card): card is RelatedCard => !!card && isOpenTask(card))
    .sort(bySeq);
}

/** Why a relation may not be stored: codes of the shared error list. */
export type RelationRefusalCode =
  | SubtaskParentRefusal
  | 'relation_self'
  | 'relation_target_not_found'
  | 'relation_target_project'
  | 'relation_cycle'
  | 'relation_duplicate_of_duplicate'
  | 'relation_parent_exists'
  | 'relation_theme';

export interface RelationRefusal {
  code: RelationRefusalCode;
  /** `relation_theme`: the kind a theme may not have in that way (a theme has no prerequisites; it duplicates only a theme). */
  kind?: AddableRelationKind;
  /** `relation_parent_exists`: the card the card is part of already. */
  parent?: string;
  /** `relation_cycle`: the cards of the loop, starting and ending with the card that would close it. */
  path?: string[];
  /** `relation_duplicate_of_duplicate`: the card the target is a duplicate of, which to point at instead. */
  original?: string;
}

/**
 * Why `kind` from the card `from` to the card `to` may not be stored, or null when it may. `from`
 * is null while the card is created: nothing can point at it yet, so only the target and the
 * subtask rule are checked. `tasks` are the cards of the project as they are now, read in the
 * same unit of work as the write.
 *
 * - every kind: not itself, the target exists, in the same project;
 * - `part_of`: the one-level rule of `subtaskParentRefusal`;
 * - `prerequisite`: no loop, directly or through other prerequisites; a theme has none and is none;
 * - `duplicate_of`: the target is not a duplicate itself (point at the original, not a chain); a theme
 *   duplicates only a theme, and a card only a card;
 * - `related`: any card, a theme too.
 * `from.kind` is the kind of a card that does not exist yet; an existing card's is read from `tasks`.
 */
export function relationRefusal(
  kind: AddableRelationKind,
  from: { key: string | null; projectKey: string; kind?: TaskKind | undefined },
  to: string,
  tasks: readonly RelationCard[],
): RelationRefusal | null {
  const target = tasks.find((card) => card.key === to);
  const fromKind = from.kind ?? tasks.find((card) => card.key === from.key)?.kind;
  if (kind === 'part_of') {
    const code = subtaskParentRefusal(to, target, {
      key: from.key,
      projectKey: from.projectKey,
      hasSubtasks: from.key !== null && tasks.some((card) => card.parentKey === from.key),
      kind: fromKind,
    });
    if (code) return { code };
    // A card is part of one card: moving it means removing the relation first (a call may do both).
    const parent = tasks.find((card) => card.key === from.key)?.parentKey;
    return parent ? { code: 'relation_parent_exists', parent } : null;
  }
  if (to === from.key) return { code: 'relation_self' };
  if (!target) return { code: 'relation_target_not_found' };
  if (target.projectKey !== from.projectKey) return { code: 'relation_target_project' };
  if (kind === 'prerequisite' && (isTheme({ kind: fromKind }) || isTheme(target)))
    return { code: 'relation_theme', kind };
  if (kind === 'duplicate_of' && isTheme({ kind: fromKind }) !== isTheme(target))
    return { code: 'relation_theme', kind };
  if (kind === 'duplicate_of') {
    const original = linkTargets(target, 'duplicate_of')[0];
    return original ? { code: 'relation_duplicate_of_duplicate', original } : null;
  }
  if (kind === 'prerequisite' && from.key !== null) {
    const path = prerequisitePath(to, from.key, tasks);
    if (path) return { code: 'relation_cycle', path: [from.key, ...path] };
  }
  return null;
}

/** The chain of prerequisites from `start` to `goal` (both included), or null when there is none. */
function prerequisitePath(start: string, goal: string, tasks: readonly RelationCard[]): string[] | null {
  const byKey = new Map(tasks.map((card) => [card.key, card]));
  const seen = new Set<string>();
  const walk = (key: string, path: string[]): string[] | null => {
    if (key === goal) return path;
    if (seen.has(key)) return null;
    seen.add(key);
    const card = byKey.get(key);
    for (const next of card ? linkTargets(card, 'prerequisite') : []) {
      const found = walk(next, [...path, next]);
      if (found) return found;
    }
    return null;
  };
  return walk(start, [start]);
}

/** The card pair a stored link or parent joins: where a view kind is stored, and on which card. */
export interface StoredRelation {
  /** `parent`: the `parentKey` of `owner`; otherwise a link of that kind on `owner`. */
  stored: RelationLinkKind | 'parent';
  /** The card that holds it. */
  owner: string;
  /** The card it points at. */
  target: string;
}

/**
 * Where the relation `kind` between `task` and `key` is stored, as it is now, or null when the two
 * cards have no such relation. The same view kind can be stored on either card (`related`), so this
 * looks at both; the other kinds have one possible owner.
 */
export function storedRelation(
  kind: TaskRelationKind,
  task: Pick<RelationCard, 'key' | 'parentKey' | 'links'>,
  other: Pick<RelationCard, 'key' | 'parentKey' | 'links'> | undefined,
): StoredRelation | null {
  if (!other) return null;
  const has = (card: Pick<RelationCard, 'links'>, link: RelationLinkKind, ref: string) =>
    linkTargets(card, link).includes(ref);
  switch (kind) {
    case 'part_of':
      return task.parentKey === other.key ? { stored: 'parent', owner: task.key, target: other.key } : null;
    case 'has_part':
      return other.parentKey === task.key ? { stored: 'parent', owner: other.key, target: task.key } : null;
    case 'prerequisite':
    case 'duplicate_of':
      return has(task, kind, other.key) ? { stored: kind, owner: task.key, target: other.key } : null;
    case 'prerequisite_of':
      return has(other, 'prerequisite', task.key)
        ? { stored: 'prerequisite', owner: other.key, target: task.key }
        : null;
    case 'duplicated_by':
      return has(other, 'duplicate_of', task.key)
        ? { stored: 'duplicate_of', owner: other.key, target: task.key }
        : null;
    case 'related':
      if (has(task, 'related', other.key)) return { stored: 'related', owner: task.key, target: other.key };
      return has(other, 'related', task.key)
        ? { stored: 'related', owner: other.key, target: task.key }
        : null;
  }
}

/** Whether `related` between the two cards is already stored on either of them. */
export function hasRelated(
  a: Pick<RelationCard, 'key' | 'links'>,
  b: Pick<RelationCard, 'key' | 'links'>,
): boolean {
  return linkTargets(a, 'related').includes(b.key) || linkTargets(b, 'related').includes(a.key);
}

/**
 * Whether the actor may mark the card as a duplicate, or why not (`duplicate_not_allowed`).
 * Marking closes the card (it is cancelled, like any cancellation), so:
 * - a card that is closed already only gets the relation, which needs nobody's right to cancel;
 * - a card that has not started (it waits in a queue stage and has no live session) can be marked by
 *   whoever may edit it, an AI member included (the owner's decision, 2026-10-01);
 * - a card that has started can be marked only by whoever may cancel it today: `mayCancel`.
 */
export function duplicateMarkRefusal(input: {
  task: Pick<Task, 'status'>;
  /** The kind of the card's stage; undefined when the stage is not in the pipeline. */
  stageKind: StageKind | undefined;
  hasLiveSession: boolean;
  /** The actor is a human of admin or owner access: who may cancel a card (`TaskService.cancel`). */
  mayCancel: boolean;
}): 'duplicate_not_allowed' | null {
  if (!isOpenTask(input.task)) return null;
  if (input.stageKind === 'queue' && !input.hasLiveSession) return null;
  return input.mayCancel ? null : 'duplicate_not_allowed';
}

/** One write of a relation change: the stored forms, in the order they are applied. */
export type RelationStep =
  | { type: 'link_add'; owner: string; kind: RelationLinkKind; ref: string }
  | { type: 'link_remove'; owner: string; kind: RelationLinkKind; ref: string }
  | { type: 'parent'; child: string; parent: string | null }
  /** The card is marked as a duplicate of `original`: it is cancelled, once, if it is open. */
  | { type: 'duplicate_close'; original: string };

/** A relation change that is refused: the rule that refuses it, and the card it is about. */
export type RelationPlanRefusal =
  | { refusal: RelationRefusal; key: string }
  | { refusal: { code: 'relation_not_found'; kind: TaskRelationKind }; key: string }
  | { refusal: { code: 'duplicate_not_allowed' }; key: string };

export type RelationPlan =
  { ok: true; steps: RelationStep[]; closes: boolean } | ({ ok: false } & RelationPlanRefusal);

/**
 * Plans a change of the relations of the card `task` against the cards as they are now: removals
 * first, then additions, each against what the earlier steps left (so two steps of one call can
 * contradict each other, and the second is refused). Nothing is written: the caller applies the
 * steps, all or none. A relation that is stored already is skipped.
 *
 * `cards` are the cards of the project (`task` among them); `elsewhere` finds a card that is not,
 * so that a relation to another project is refused with its own reason. `markDuplicate` says
 * whether the actor may mark the card as a duplicate (`duplicateMarkRefusal`), asked when the call
 * does so.
 */
export function planRelations(input: {
  task: Pick<RelationCard, 'key' | 'projectKey' | 'kind'>;
  cards: readonly RelationCard[];
  elsewhere: (key: string) => RelationCard | undefined;
  change: RelationsChange;
  markDuplicate: () => 'duplicate_not_allowed' | null;
}): RelationPlan {
  const { task, change } = input;
  const cards = new Map<string, RelationCard>(
    input.cards.map((card) => [card.key, { ...card, links: [...card.links] }]),
  );
  const self = cards.get(task.key);
  if (!self) return { ok: false, key: task.key, refusal: { code: 'relation_target_not_found' } };
  const steps: RelationStep[] = [];

  for (const { kind, key } of change.remove ?? []) {
    const stored = storedRelation(kind, self, cards.get(key));
    if (!stored) return { ok: false, key, refusal: { code: 'relation_not_found', kind } };
    const owner = cards.get(stored.owner)!;
    if (stored.stored === 'parent') {
      owner.parentKey = null;
      steps.push({ type: 'parent', child: owner.key, parent: null });
    } else {
      owner.links = owner.links.filter((l) => !(l.kind === stored.stored && l.ref === stored.target));
      steps.push({ type: 'link_remove', owner: owner.key, kind: stored.stored, ref: stored.target });
    }
  }

  const seen = new Set<string>();
  for (const { kind, key } of change.add ?? []) {
    if (seen.has(`${kind}:${key}`)) continue;
    seen.add(`${kind}:${key}`);
    if (!cards.has(key)) {
      const other = input.elsewhere(key);
      if (other) cards.set(key, { ...other, links: [...other.links] });
    }
    const target = cards.get(key);
    const stored =
      kind === 'part_of'
        ? self.parentKey === key
        : !!target && (kind === 'related' ? hasRelated(self, target) : linkTargets(self, kind).includes(key));
    if (stored) continue;
    const refusal = relationRefusal(
      kind,
      { key: task.key, projectKey: task.projectKey, kind: task.kind },
      key,
      [...cards.values()],
    );
    if (refusal) return { ok: false, key, refusal };
    if (kind === 'part_of') {
      self.parentKey = key;
      steps.push({ type: 'parent', child: task.key, parent: key });
      continue;
    }
    self.links.push({ kind, ref: key });
    steps.push({ type: 'link_add', owner: task.key, kind, ref: key });
    if (kind === 'duplicate_of' && !steps.some((s) => s.type === 'duplicate_close')) {
      const refused = input.markDuplicate();
      if (refused) return { ok: false, key, refusal: { code: refused } };
      steps.push({ type: 'duplicate_close', original: key });
    }
  }
  return { ok: true, steps, closes: steps.some((s) => s.type === 'duplicate_close') && isOpenTask(self) };
}
