import { isUnreadBy } from '@projectman/shared';
import type { MessageReceipt, TeamMessage } from '@projectman/shared';
import type { MemberIndex } from '../../lib/members';

export function unreadMessages(messages: readonly TeamMessage[], handle: string | null): TeamMessage[] {
  return messages.filter((m) => isUnreadBy(m, handle));
}

/** The message's receipts; a message that carries none (an older one) is shown as delivered, unread. */
export function receiptsOf(message: TeamMessage, members: MemberIndex): readonly MessageReceipt[] {
  return (
    message.receipts ??
    message.to.map((handle): MessageReceipt => ({
      handle,
      kind: members.get(handle)?.kind ?? 'human',
      deliveredAt: message.deliveredAt,
      readAt: null,
    }))
  );
}

export type DeliveryState = 'queued' | 'delivered' | 'read' | 'unread';

/**
 * One word for how a message stands: waiting for an AI recipient's session, read by every human
 * recipient, delivered but not yet read by a human, or delivered.
 */
export function deliveryState(receipts: readonly MessageReceipt[]): DeliveryState {
  if (receipts.some((r) => r.kind === 'ai' && !r.deliveredAt)) return 'queued';
  const humans = receipts.filter((r) => r.kind === 'human');
  if (humans.length === 0) return 'delivered';
  if (humans.every((r) => r.readAt)) return receipts.length === humans.length ? 'read' : 'delivered';
  return receipts.length === humans.length ? 'unread' : 'delivered';
}
