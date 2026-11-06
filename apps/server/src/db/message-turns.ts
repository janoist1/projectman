import type { Db } from './database';

export type MessageTurnEnd = 'idle' | 'exited' | 'failed';

/** The turn a message was typed into for one recipient (PM-1290); the session id never leaves the server. */
export interface MessageTurn {
  projectKey: string;
  messageId: string;
  handle: string;
  sessionId: string;
  typedAt: string;
  endedAt: string | null;
  endState: MessageTurnEnd | null;
}

interface TurnRow {
  project_key: string;
  message_id: string;
  handle: string;
  session_id: string;
  typed_at: string;
  ended_at: string | null;
  end_state: MessageTurnEnd | null;
}

const toTurn = (r: TurnRow): MessageTurn => ({
  projectKey: r.project_key,
  messageId: r.message_id,
  handle: r.handle,
  sessionId: r.session_id,
  typedAt: r.typed_at,
  endedAt: r.ended_at,
  endState: r.end_state,
});

export function createMessageTurnRepository(db: Db) {
  const statements = {
    insert: db.prepare(
      `INSERT OR IGNORE INTO message_turns (project_key, message_id, handle, session_id, typed_at)
       VALUES (?, ?, ?, ?, ?)`,
    ),
    open: db.prepare(
      'SELECT * FROM message_turns WHERE session_id = ? AND ended_at IS NULL AND typed_at <= ? ORDER BY typed_at',
    ),
    openOfSession: db.prepare('SELECT * FROM message_turns WHERE session_id = ? AND ended_at IS NULL'),
    close: db.prepare(
      'UPDATE message_turns SET ended_at = ?, end_state = ? WHERE message_id = ? AND handle = ? AND ended_at IS NULL',
    ),
    ofMessages: db.prepare(
      'SELECT * FROM message_turns WHERE message_id IN (SELECT value FROM json_each(?))',
    ),
  };

  return {
    /** Records the turn; false when the message already has one for the recipient (a repeated typing). */
    insert(
      turn: Pick<MessageTurn, 'projectKey' | 'messageId' | 'handle' | 'sessionId' | 'typedAt'>,
    ): boolean {
      return (
        statements.insert.run(turn.projectKey, turn.messageId, turn.handle, turn.sessionId, turn.typedAt)
          .changes > 0
      );
    },
    /** The session's turns that are still open (any time). */
    openOfSession(sessionId: string): MessageTurn[] {
      return (statements.openOfSession.all(sessionId) as TurnRow[]).map(toTurn);
    },
    /**
     * Closes the session's open turns typed at or before `at` and returns them as closed. A turn that is already
     * closed stays as it is, so a late or repeated event closes nothing twice.
     */
    closeOpen(sessionId: string, at: string, endState: MessageTurnEnd): MessageTurn[] {
      return db.transaction(() => {
        const open = (statements.open.all(sessionId, at) as TurnRow[]).map(toTurn);
        const closed: MessageTurn[] = [];
        for (const turn of open) {
          if (statements.close.run(at, endState, turn.messageId, turn.handle).changes === 0) continue;
          closed.push({ ...turn, endedAt: at, endState });
        }
        return closed;
      })();
    },
    /** The turns of these messages in one read: message id → its turns (one per recipient). */
    ofMessages(ids: readonly string[]): Map<string, MessageTurn[]> {
      const byMessage = new Map<string, MessageTurn[]>();
      if (ids.length === 0) return byMessage;
      for (const row of statements.ofMessages.all(JSON.stringify(ids)) as TurnRow[]) {
        const list = byMessage.get(row.message_id) ?? [];
        list.push(toTurn(row));
        byMessage.set(row.message_id, list);
      }
      return byMessage;
    },
  };
}
