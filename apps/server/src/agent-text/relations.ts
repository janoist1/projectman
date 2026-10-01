import type { TaskRelation, TaskRelationKind } from '@projectman/shared';
import { oneLine, PLAIN_STYLE, type TextStyle } from './text';

/** Longer card titles are shortened. */
const TITLE_LIMIT = 200;

/** What a card is to the card that shows the relation: "needs first", "is part of". */
const RELATION_PHRASES: Record<TaskRelationKind, string> = {
  part_of: 'is part of',
  has_part: 'has as parts',
  prerequisite: 'needs first (prerequisite)',
  prerequisite_of: 'is the prerequisite of',
  related: 'is related to',
  duplicate_of: 'is a duplicate of',
  duplicated_by: 'has as duplicates',
};

/** The kind of relation as the viewing card sees it: `needs first (prerequisite)`. */
export function relationPhrase(kind: string): string {
  return RELATION_PHRASES[kind as TaskRelationKind] ?? kind.replace(/_/g, ' ');
}

/** One related card: `PM-12 "Title" · Stage: dev · Status: active`. */
export function describeRelatedCard(
  card: Pick<TaskRelation, 'key' | 'title' | 'stageId' | 'status'>,
  style: Pick<TextStyle, 'code' | 'stage'> = PLAIN_STYLE,
): string {
  return `${style.code(card.key)} "${oneLine(card.title, TITLE_LIMIT)}" · Stage: ${style.stage(card.stageId)} · Status: ${card.status}`;
}

/** The relations grouped by kind, one line per card, in the order the cards come in. Empty without any. */
export function relationLines(
  relations: readonly TaskRelation[],
  style: Pick<TextStyle, 'code' | 'stage'> = PLAIN_STYLE,
): string[] {
  const lines: string[] = [];
  let kind: string | null = null;
  for (const relation of relations) {
    if (relation.kind !== kind) {
      kind = relation.kind;
      lines.push(`This card ${relationPhrase(kind)}:`);
    }
    lines.push(`- ${describeRelatedCard(relation, style)}`);
  }
  return lines;
}
