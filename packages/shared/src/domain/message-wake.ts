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

export function messageWakes(
  message: Pick<TeamMessage, 'kind'>,
  facts: Pick<StaleFacts, 'fromHuman'>,
  stale: StaleReason | null,
): boolean {
  return facts.fromHuman || ((message.kind ?? 'action') === 'action' && stale === null);
}
