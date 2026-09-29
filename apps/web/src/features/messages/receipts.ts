import type { TeamMessage } from '@projectman/shared';

export function unreadMessages(messages: readonly TeamMessage[], handle: string | null): TeamMessage[] {
  return handle
    ? messages.filter((m) => m.to.includes(handle) && !m.receipts?.find((r) => r.handle === handle)?.readAt)
    : [];
}
