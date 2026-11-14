import type { Db } from './database';

/** How far a session has been told of the changes to its card: the greatest timeline `seq` it has looked at (PM-1512). */
export function createCardNoticeCursorRepository(db: Db) {
  const find = db.prepare('SELECT seq FROM card_notice_cursors WHERE session_id = ?');
  const insert = db.prepare(
    'INSERT OR IGNORE INTO card_notice_cursors (session_id, project_key, seq, updated_at) VALUES (?, ?, ?, ?)',
  );
  const raiseTo = db.prepare(
    'UPDATE card_notice_cursors SET seq = ?, updated_at = ? WHERE session_id = ? AND seq < ?',
  );
  const move = db.prepare(
    'UPDATE card_notice_cursors SET seq = ?, updated_at = ? WHERE session_id = ? AND seq = ?',
  );

  return {
    get(sessionId: string): number | null {
      const row = find.get(sessionId) as { seq: number } | undefined;
      return row ? row.seq : null;
    },
    /** Sets the cursor to `seq`, or keeps a greater one: it never goes back this way. */
    raise(sessionId: string, projectKey: string, seq: number, at: string): void {
      insert.run(sessionId, projectKey, seq, at);
      raiseTo.run(seq, at, sessionId, seq);
    },
    /** Moves the cursor from `from` to `to` only while it stands at `from`; whether it did. */
    advance(sessionId: string, from: number, to: number, at: string): boolean {
      return move.run(to, at, sessionId, from).changes > 0;
    },
    /** Takes `advance` back: from `to` to `from`, only while it still stands at `to`; whether it did. */
    rollback(sessionId: string, from: number, to: number, at: string): boolean {
      return move.run(from, at, sessionId, to).changes > 0;
    },
  };
}
