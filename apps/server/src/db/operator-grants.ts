import type { Db } from './database';

interface OperatorGrantRow {
  id: string;
  userId: string;
  grantedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedReason: 'revoked' | 'replaced' | null;
  lastUsedAt: string | null;
}

interface Row {
  id: string;
  user_id: string;
  granted_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  revoked_reason: 'revoked' | 'replaced' | null;
  last_used_at: string | null;
}

const toRow = (r: Row): OperatorGrantRow => ({
  id: r.id,
  userId: r.user_id,
  grantedAt: r.granted_at,
  expiresAt: r.expires_at,
  revokedAt: r.revoked_at,
  revokedReason: r.revoked_reason,
  lastUsedAt: r.last_used_at,
});

/** The host owner's grants for the Operator's machine operations (PM-881); the audit is read from these rows. */
export function createOperatorGrantRepository(db: Db) {
  return {
    insert(grant: { id: string; userId: string; grantedAt: string; expiresAt: string | null }): void {
      db.prepare('INSERT INTO operator_grants (id, user_id, granted_at, expires_at) VALUES (?, ?, ?, ?)').run(
        grant.id,
        grant.userId,
        grant.grantedAt,
        grant.expiresAt,
      );
    },
    /** The user's grant that is neither revoked nor expired at `now`. */
    active(userId: string, now: string): OperatorGrantRow | null {
      const row = db
        .prepare(
          `SELECT * FROM operator_grants
         WHERE user_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY rowid DESC LIMIT 1`,
        )
        .get(userId, now) as Row | undefined;
      return row ? toRow(row) : null;
    },
    /** Closes the user's active grant with the reason; returns it, or null when there was none. */
    closeActive(userId: string, now: string, reason: 'revoked' | 'replaced'): OperatorGrantRow | null {
      const row = this.active(userId, now);
      if (!row) return null;
      db.prepare('UPDATE operator_grants SET revoked_at = ?, revoked_reason = ? WHERE id = ?').run(
        now,
        reason,
        row.id,
      );
      return { ...row, revokedAt: now, revokedReason: reason };
    },
    touch(id: string, at: string): void {
      db.prepare('UPDATE operator_grants SET last_used_at = ? WHERE id = ?').run(at, id);
    },
    /** The newest rows first. */
    recent(userId: string, limit: number): OperatorGrantRow[] {
      return (
        db
          .prepare('SELECT * FROM operator_grants WHERE user_id = ? ORDER BY rowid DESC LIMIT ?')
          .all(userId, limit) as Row[]
      ).map(toRow);
    },
  };
}
