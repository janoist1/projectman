import type { StaleReason, TeamMessage } from './message';

export interface StaleFacts {
  fromHuman: boolean;
  card: { open: boolean; stageId: string } | null;
  recipientOwnsStage: boolean;
  superseded: boolean;
  senderResultLabel: string | null;
  resultCommits: readonly string[];
  subjectClosed: boolean;
}

export function messageStaleReason(
  message: Pick<TeamMessage, 'kind' | 'version' | 'subject'>,
  facts: StaleFacts,
): StaleReason | null {
  if (facts.fromHuman || message.kind === 'info') return null;
  if (message.subject && facts.subjectClosed) return 'permission_closed';
  if (!message.version) return null;
  if (facts.card && !facts.card.open) return 'card_closed';
  if (facts.card && facts.card.stageId !== message.version.stageId && !facts.recipientOwnsStage)
    return 'stage_moved';
  if (facts.superseded) return 'superseded';
  if (facts.senderResultLabel !== null) return 'sender_result';
  if (message.version.commit && facts.resultCommits.includes(message.version.commit))
    return 'result_recorded';
  return null;
}

/**
 * Why a valid action message starts no session for its recipient: an AI member has no role on the card
 * (PM-426), or the recipient is the Operator and the message is not a person's own (PM-447, PM-475).
 */
export type WakeBlock = 'no_card_role' | 'operator_owner_only';

export interface WakeFacts {
  fromHuman: boolean;
  /** The sender is an AI member of the project; people and `system` are not. */
  fromAi: boolean;
  /** `hasCardRole` of the recipient on the message's card; true for a message about no card or about a theme. */
  recipientHasRole: boolean;
  /** The recipient is the project's Operator, who works only on the owner's request (PM-447). */
  recipientIsOperator: boolean;
  /** The sender is a person with their own login, not acting through the integrator key (PM-475). */
  fromOwnLogin: boolean;
}

/**
 * The block, only when it alone keeps a valid action from waking: null for a person's, the system's, an
 * info or a stale message (PM-426). The Operator is the exception: only a person's message sent with their
 * own login wakes it (PM-475), so an AI member's, the system's or the integrator key's action message to it
 * is blocked (PM-447).
 */
export function messageWakeBlock(
  message: Pick<TeamMessage, 'kind'>,
  facts: WakeFacts,
  stale: StaleReason | null,
): WakeBlock | null {
  if ((message.kind ?? 'action') !== 'action' || stale !== null) return null;
  if (facts.recipientIsOperator) return facts.fromHuman && facts.fromOwnLogin ? null : 'operator_owner_only';
  return !facts.fromHuman && facts.fromAi && !facts.recipientHasRole ? 'no_card_role' : null;
}

export function messageWakes(
  message: Pick<TeamMessage, 'kind'>,
  facts: WakeFacts,
  stale: StaleReason | null,
): boolean {
  if (facts.recipientIsOperator) return facts.fromHuman && facts.fromOwnLogin;
  return (
    facts.fromHuman ||
    ((message.kind ?? 'action') === 'action' &&
      stale === null &&
      messageWakeBlock(message, facts, stale) === null)
  );
}
