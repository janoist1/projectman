import type { ChatItem } from '../chat/chat';
import type { SessionState, SessionWorkMetadata } from './session';

/** The code stored for a failed tool result; the result's own text is never kept (PM-694). */
export const TOOL_FAILED_CODE = 'tool_failed';

const TOOL_NAME_MAX = 120;

/**
 * The session's work metadata after a batch of its chat items (PM-694), or null when nothing changed.
 * Only a tool call and a sent team message prove a step; assistant text counts only while the session
 * is working. An item at or before the time already kept writes nothing, so a transcript read again
 * cannot move the metadata, and no time goes beyond `now`. The texts of the items are never read.
 */
export function workMetadataAfterChat(
  current: SessionWorkMetadata | undefined,
  items: readonly ChatItem[],
  context: { state: SessionState; now: number },
): SessionWorkMetadata | null {
  const seenWork = current?.lastWorkAt ? Date.parse(current.lastWorkAt) : Number.NEGATIVE_INFINITY;
  const seenError = current?.lastError ? Date.parse(current.lastError.at) : Number.NEGATIVE_INFINITY;
  const next: SessionWorkMetadata = {
    lastWorkAt: current?.lastWorkAt ?? null,
    lastTool: current?.lastTool ?? null,
    lastError: current?.lastError ?? null,
  };
  let changed = false;
  for (const item of items) {
    const parsed = Date.parse(item.ts);
    if (Number.isNaN(parsed)) continue;
    const ts = Math.min(parsed, context.now);
    const at = new Date(ts).toISOString();
    const step =
      item.kind === 'tool_call' ||
      (item.kind === 'team_message' && item.direction === 'out') ||
      (item.kind === 'assistant_text' && context.state === 'working');
    if (step && ts > seenWork) {
      if (next.lastWorkAt === null || ts >= Date.parse(next.lastWorkAt)) next.lastWorkAt = at;
      const name = item.kind === 'tool_call' ? item.name.trim().slice(0, TOOL_NAME_MAX) : '';
      if (name) next.lastTool = { name, at };
      changed = true;
    }
    if (item.kind === 'tool_result' && !item.ok && ts > seenError) {
      next.lastError = { code: TOOL_FAILED_CODE, at };
      changed = true;
    }
  }
  return changed ? next : null;
}
