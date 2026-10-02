import { isUnreadBy } from '@projectman/shared';
import type { TeamMessage } from '@projectman/shared';

export function unreadMessages(messages: readonly TeamMessage[], handle: string | null): TeamMessage[] {
  return messages.filter((m) => isUnreadBy(m, handle));
}
