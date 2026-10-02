import { useEffect, useState } from 'react';
import type { ChatItem } from '@projectman/shared';
import type { PendingMessage } from './ChatView';

export interface PendingEcho extends PendingMessage {
  sentAt: string;
}

/** How far the server's transcript clock may lag behind the browser's. */
const ECHO_SKEW_MS = 2 * 60_000;

/** The pending messages the transcript does not show yet (allowing for clock skew). */
export function withoutEchoed(pending: readonly PendingEcho[], chat: readonly ChatItem[]): PendingEcho[] {
  return pending.filter(
    (message) =>
      !chat.some(
        (item) =>
          item.kind === 'user_text' &&
          item.origin === 'human' &&
          item.text.trim() === message.text.trim() &&
          Date.parse(item.ts) >= Date.parse(message.sentAt) - ECHO_SKEW_MS,
      ),
  );
}

let pendingSeq = 0;

/**
 * Local echoes of the messages the viewer sent: shown at once, marked failed when sending
 * fails, and dropped once the session's transcript shows them.
 */
export function usePendingEchoes(chat: readonly ChatItem[]) {
  const [pending, setPending] = useState<PendingEcho[]>([]);
  useEffect(() => {
    setPending((list) => withoutEchoed(list, chat));
  }, [chat]);
  return {
    pending,
    /** Adds an echo and returns its id. */
    add: (text: string): string => {
      const entry = {
        id: `local-${(pendingSeq += 1)}`,
        text,
        failed: false,
        sentAt: new Date().toISOString(),
      };
      setPending((list) => [...list, entry]);
      return entry.id;
    },
    fail: (id: string) =>
      setPending((list) =>
        list.map((message) => (message.id === id ? { ...message, failed: true } : message)),
      ),
    /** Marks a failed echo as sending again. */
    retry: (id: string) =>
      setPending((list) =>
        list.map((message) => (message.id === id ? { ...message, failed: false } : message)),
      ),
  };
}
