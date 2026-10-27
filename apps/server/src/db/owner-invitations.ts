import type { Db } from './database';

export interface OwnerInvitationRecord {
  id: string;
  email: string;
  tokenHash: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  acceptedUserId: string | null;
  revokedAt: string | null;
}

interface OwnerInvitationRow {
  id: string;
  email: string;
  token_hash: string;
  created_by: string;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  accepted_user_id: string | null;
  revoked_at: string | null;
}

const fromRow = (row: OwnerInvitationRow): OwnerInvitationRecord => ({
  id: row.id,
  email: row.email,
  tokenHash: row.token_hash,
  createdBy: row.created_by,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  acceptedAt: row.accepted_at,
  acceptedUserId: row.accepted_user_id,
  revokedAt: row.revoked_at,
});

/** The owner invitations (PM-1062), the sibling of the project invitations. */
export function createOwnerInvitationRepository(db: Db) {
  return {
    insert(invite: OwnerInvitationRecord): void {
      db.prepare(
        `INSERT INTO owner_invitations
         (id, email, token_hash, created_by, created_at, expires_at, accepted_at, accepted_user_id, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        invite.id,
        invite.email,
        invite.tokenHash,
        invite.createdBy,
        invite.createdAt,
        invite.expiresAt,
        invite.acceptedAt,
        invite.acceptedUserId,
        invite.revokedAt,
      );
    },
    get(id: string): OwnerInvitationRecord | null {
      const row = db.prepare('SELECT * FROM owner_invitations WHERE id = ?').get(id) as
        OwnerInvitationRow | undefined;
      return row ? fromRow(row) : null;
    },
    byTokenHash(tokenHash: string): OwnerInvitationRecord | null {
      const row = db.prepare('SELECT * FROM owner_invitations WHERE token_hash = ?').get(tokenHash) as
        OwnerInvitationRow | undefined;
      return row ? fromRow(row) : null;
    },
    /** All pending invitations and the ones created or closed in the last 30 days. */
    list(now: string, recentSince: string): OwnerInvitationRecord[] {
      return (
        db
          .prepare(
            `SELECT * FROM owner_invitations WHERE
             (accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?) OR
             created_at >= ? OR accepted_at >= ? OR revoked_at >= ? ORDER BY created_at DESC, id DESC`,
          )
          .all(now, recentSince, recentSince, recentSince) as OwnerInvitationRow[]
      ).map(fromRow);
    },
    accept(id: string, userId: string, at: string): void {
      db.prepare('UPDATE owner_invitations SET accepted_at = ?, accepted_user_id = ? WHERE id = ?').run(
        at,
        userId,
        id,
      );
    },
    revoke(id: string, at: string): void {
      db.prepare('UPDATE owner_invitations SET revoked_at = ? WHERE id = ?').run(at, id);
    },
  };
}
