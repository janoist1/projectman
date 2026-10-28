import type { Db } from './database';

export interface OwnerAccountRecord {
  userId: string;
  grantedBy: string;
  grantedAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
}

interface OwnerAccountRow {
  user_id: string;
  granted_by: string;
  granted_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
}

const fromRow = (row: OwnerAccountRow): OwnerAccountRecord => ({
  userId: row.user_id,
  grantedBy: row.granted_by,
  grantedAt: row.granted_at,
  revokedAt: row.revoked_at,
  revokedBy: row.revoked_by,
});

/** The owner accounts (PM-1062): one row per user, kept when revoked. */
export function createOwnerAccountRepository(db: Db) {
  return {
    get(userId: string): OwnerAccountRecord | null {
      const row = db.prepare('SELECT * FROM owner_accounts WHERE user_id = ?').get(userId) as
        OwnerAccountRow | undefined;
      return row ? fromRow(row) : null;
    },
    /** Oldest grant first. */
    list(): OwnerAccountRecord[] {
      return (
        db.prepare('SELECT * FROM owner_accounts ORDER BY granted_at, user_id').all() as OwnerAccountRow[]
      ).map(fromRow);
    },
    /** Grants the account; a revoked one is granted again (the revocation is cleared, the grant renewed). */
    grant(userId: string, grantedBy: string, at: string): void {
      db.prepare(
        `INSERT INTO owner_accounts (user_id, granted_by, granted_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET granted_by = excluded.granted_by, granted_at = excluded.granted_at,
           revoked_at = NULL, revoked_by = NULL`,
      ).run(userId, grantedBy, at);
    },
    /** Revokes an active account; false when there is none (or it is revoked already). */
    revoke(userId: string, revokedBy: string, at: string): boolean {
      return (
        db
          .prepare(
            'UPDATE owner_accounts SET revoked_at = ?, revoked_by = ? WHERE user_id = ? AND revoked_at IS NULL',
          )
          .run(at, revokedBy, userId).changes > 0
      );
    },
  };
}
