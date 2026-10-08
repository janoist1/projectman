import type { TaskRelation, TaskRelationKind } from '@projectman/shared';
import { describeRelatedCard, relationPhrase } from './relations';

/** One new relation of a card, with what the notice says of the other card. */
export interface RelationNoticeRelation {
  kind: TaskRelationKind;
  other: Pick<TaskRelation, 'key' | 'title' | 'stageId' | 'status'> & {
    /** The start of the other card's description (empty when it has none). */
    summary: string;
    /** Whether the recipient may read the other card: when not, only its key and title are told. */
    visible: boolean;
  };
}

/**
 * The text of the notice that a new relation reaches a member working on the card (PM-421), or of the
 * analyst check (`check`). The first line is the whole news and fits the timeline's excerpt; the
 * lines after it tell the other card and what to do.
 */
export function relationNoticeText(input: {
  cardKey: string;
  actor: string;
  check: boolean;
  relations: readonly RelationNoticeRelation[];
}): string {
  const heading = input.check ? 'Analyst check' : 'Relation notice';
  const phrases = input.relations.map(({ kind, other }) => `${relationPhrase(kind)} ${other.key}`).join(', ');
  const lines = [`${heading} (${input.cardKey}): this card ${phrases} (added by ${input.actor}).`];
  for (const { kind, other } of input.relations) {
    lines.push(
      `- This card ${relationPhrase(kind)}: ${
        other.visible ? describeRelatedCard(other) : `${other.key} "${other.title}"`
      }`,
    );
    if (other.visible && other.summary) lines.push(`  Summary: ${other.summary}`);
  }
  lines.push(
    'If this affects your work, read the card with get_task; ask the analyst or the owner with your question.',
  );
  if (input.check)
    lines.push(
      'You are the analyst of this card: check whether the new relation changes the work (the task narrows or grows, an order is needed, it conflicts). Write the result as a note on the card with update_task ("does not affect it", or what changes). If it does affect the work, update the requirement and tell the members working on the card with send_message. Ask for a decision with ask_human. Do not move or stop the card.',
    );
  lines.push('This message is from projectman: do not answer it with send_message.');
  return lines.join('\n');
}
