import {
  hasRelated,
  isOpenTask,
  openPrerequisites,
  relationRefusal,
  taskRelations,
  taskSeq,
} from '@projectman/shared';
import type {
  AddableRelationKind,
  RelationsChange,
  Task,
  TaskRelation,
  TaskRelationKind,
} from '@projectman/shared';
import { isApiError } from '../../api/client';
import { t } from '../../i18n/t';
import { codeMessage, errorMessage } from '../../lib/errors';

/** The kinds the dialog adds, in the order it offers them (the other direction is set on the other card). */
export const DIALOG_KINDS: readonly AddableRelationKind[] = [
  'part_of',
  'prerequisite',
  'related',
  'duplicate_of',
];

/** The dialog's own choices: the four relations and a new subtask. */
export type DialogKind = AddableRelationKind | 'subtask';

/** A group of the section: the cards that relate to the card in one way. */
export interface RelationGroup {
  kind: TaskRelationKind;
  relations: TaskRelation[];
}

/** The card's relations from both directions, grouped by kind in the shared order; empty groups left out. */
export function relationGroups(task: Task, tasks: readonly Task[]): RelationGroup[] {
  const groups: RelationGroup[] = [];
  for (const relation of taskRelations(task, tasks)) {
    const last = groups[groups.length - 1];
    if (last?.kind === relation.kind) last.relations.push(relation);
    else groups.push({ kind: relation.kind, relations: [relation] });
  }
  return groups;
}

/** How many of a group's cards are done, for the head of the groups that have progress. */
export function groupProgress(group: RelationGroup): { done: number; total: number } | null {
  if (group.kind !== 'has_part' && !(group.kind === 'prerequisite' && group.relations.length > 1))
    return null;
  return {
    done: group.relations.filter((relation) => relation.status === 'done').length,
    total: group.relations.length,
  };
}

/**
 * What deleting a relation lets happen, as a sentence, or null: the card (or the other one) starts
 * waiting no more, leaves its collection, or stays closed. `tasks` are the cards as the viewer sees them.
 */
export function removeConsequence(relation: TaskRelation, task: Task, tasks: readonly Task[]): string | null {
  const other = tasks.find((card) => card.key === relation.key);
  switch (relation.kind) {
    case 'part_of':
      return t('task.relations.consequence.leaveParent');
    case 'has_part':
      return t('task.relations.consequence.leaveChild', { key: relation.key });
    case 'prerequisite': {
      const open = openPrerequisites(task, tasks);
      return isOpenTask(task) && open.length === 1 && open[0]!.key === relation.key
        ? t('task.relations.consequence.frees')
        : null;
    }
    case 'prerequisite_of': {
      if (!other || !isOpenTask(other) || !isOpenTask(task)) return null;
      const open = openPrerequisites(other, tasks);
      return open.length === 1 && open[0]!.key === task.key
        ? t('task.relations.consequence.freesOther', { key: other.key })
        : null;
    }
    case 'duplicate_of':
      return isOpenTask(task) ? null : t('task.relations.consequence.staysClosed');
    case 'duplicated_by':
      return other && !isOpenTask(other)
        ? t('task.relations.consequence.otherStaysClosed', { key: other.key })
        : null;
    default:
      return null;
  }
}

/** Lower case without accents: "Előfeltétel" matches "elofeltetel". */
export function searchText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Why a card cannot be the target of the chosen kind: shown under the row, which cannot be chosen. */
export type CandidateWhy =
  | { type: 'cycle'; path: string[] }
  | { type: 'duplicateOfDuplicate'; original: string }
  | { type: 'exists' }
  | { type: 'sameParent' }
  | { type: 'isSubtask' }
  | { type: 'code'; code: string };

export function whyText(why: CandidateWhy): string {
  switch (why.type) {
    case 'cycle':
      return t('relationDialog.why.cycle', { path: why.path.join(' → ') });
    case 'duplicateOfDuplicate':
      return t('relationDialog.why.duplicateOfDuplicate', { key: why.original });
    case 'exists':
      return t('relationDialog.why.exists');
    case 'sameParent':
      return t('relationDialog.why.sameParent');
    case 'isSubtask':
      return t('relationDialog.why.isSubtask');
    case 'code':
      return codeMessage(why.code) ?? t('errors.generic');
  }
}

export interface Candidate {
  card: Task;
  why: CandidateWhy | null;
}

/** Why `kind` from `task` to `card` would be refused, with the shared rules (the server's too). */
export function candidateRefusal(
  kind: AddableRelationKind,
  task: Task,
  card: Task,
  tasks: readonly Task[],
): CandidateWhy | null {
  if (kind === 'part_of' && task.parentKey === card.key) return { type: 'sameParent' };
  if (kind === 'prerequisite' || kind === 'duplicate_of') {
    if (task.links.some((link) => link.kind === kind && link.ref === card.key)) return { type: 'exists' };
  }
  if (kind === 'related' && hasRelated(task, card)) return { type: 'exists' };
  const refusal = relationRefusal(kind, { key: task.key, projectKey: task.projectKey }, card.key, tasks);
  // A card that is part of another one is moved: the request removes the old relation first.
  if (!refusal || refusal.code === 'relation_parent_exists') return null;
  switch (refusal.code) {
    case 'relation_cycle':
      return { type: 'cycle', path: refusal.path ?? [] };
    case 'relation_duplicate_of_duplicate':
      return { type: 'duplicateOfDuplicate', original: refusal.original ?? '' };
    case 'subtask_parent_is_subtask':
      return { type: 'isSubtask' };
    default:
      return { type: 'code', code: refusal.code };
  }
}

/** How many candidates the list shows at most. */
export const CANDIDATE_LIMIT = 8;

/**
 * The cards of the project that match the search (key or title, accents ignored), open ones first,
 * newest first inside each; at most `CANDIDATE_LIMIT`, with the count of all matches.
 */
export function candidates(
  kind: AddableRelationKind,
  task: Task,
  tasks: readonly Task[],
  query: string,
): { rows: Candidate[]; total: number } {
  const needle = searchText(query.trim());
  const matches = tasks
    .filter((card) => card.key !== task.key)
    .filter((card) => !needle || searchText(`${card.key} ${card.title}`).includes(needle))
    .sort((a, b) => Number(isOpenTask(b)) - Number(isOpenTask(a)) || taskSeq(b.key) - taskSeq(a.key));
  return {
    rows: matches
      .slice(0, CANDIDATE_LIMIT)
      .map((card) => ({ card, why: candidateRefusal(kind, task, card, tasks) })),
    total: matches.length,
  };
}

/** The `relations` of the request that adds `kind` to `key` (a card that is part of another is moved). */
export function addRelationChange(kind: AddableRelationKind, key: string, task: Task): RelationsChange {
  return {
    ...(kind === 'part_of' && task.parentKey
      ? { remove: [{ kind: 'part_of' as const, key: task.parentKey }] }
      : {}),
    add: [{ kind, key }],
  };
}

/** The error of a relation change in words: the code's text, and for a loop the cards it goes through. */
export function relationErrorText(error: unknown): string {
  const text = errorMessage(error);
  if (isApiError(error) && error.code === 'relation_cycle') {
    const path = (error.details as { path?: unknown } | undefined)?.path;
    if (Array.isArray(path) && path.length > 0)
      return `${text} ${t('relationDialog.cyclePath', { path: path.join(' → ') })}`;
  }
  return text;
}
