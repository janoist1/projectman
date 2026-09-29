import type { InvitationView } from '@projectman/shared';
import type { Db } from './database';

export interface InvitationRecord extends InvitationView {
  tokenHash: string;
}

interface InvitationRow {
  id: string;
  project_key: string;
  email: string;
  display_name: string | null;
  access: InvitationView['access'];
  roles: string;
  invited_by: string;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  token_hash: string;
}

function fromRow(row: InvitationRow): InvitationRecord {
  return {
    id: row.id,
    projectKey: row.project_key,
    email: row.email,
    displayName: row.display_name,
    access: row.access,
    roles: JSON.parse(row.roles),
    invitedBy: row.invited_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    revokedAt: row.revoked_at,
    tokenHash: row.token_hash,
  };
}

export function createInvitationRepository(db: Db) {
  return {
    insert(invite: InvitationRecord): void {
      db.prepare(
        `INSERT INTO invitations
        (id, project_key, email, display_name, access, roles, invited_by, created_at,
         expires_at, accepted_at, revoked_at, token_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        invite.id,
        invite.projectKey,
        invite.email,
        invite.displayName,
        invite.access,
        JSON.stringify(invite.roles),
        invite.invitedBy,
        invite.createdAt,
        invite.expiresAt,
        invite.acceptedAt,
        invite.revokedAt,
        invite.tokenHash,
      );
    },
    get(id: string): InvitationRecord | null {
      const row = db.prepare('SELECT * FROM invitations WHERE id = ?').get(id) as InvitationRow | undefined;
      return row ? fromRow(row) : null;
    },
    byTokenHash(tokenHash: string): InvitationRecord | null {
      const row = db.prepare('SELECT * FROM invitations WHERE token_hash = ?').get(tokenHash) as
        InvitationRow | undefined;
      return row ? fromRow(row) : null;
    },
    /** All pending invites and invites created or closed in the last 30 days. */
    list(projectKey: string, now: string, recentSince: string): InvitationRecord[] {
      return (
        db
          .prepare(
            `SELECT * FROM invitations WHERE project_key = ? AND
        ((accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?) OR
         created_at >= ? OR accepted_at >= ? OR revoked_at >= ?) ORDER BY created_at DESC, id DESC`,
          )
          .all(projectKey, now, recentSince, recentSince, recentSince) as InvitationRow[]
      ).map(fromRow);
    },
    accept(id: string, at: string): void {
      db.prepare('UPDATE invitations SET accepted_at = ? WHERE id = ?').run(at, id);
    },
    revoke(id: string, at: string): void {
      db.prepare('UPDATE invitations SET revoked_at = ? WHERE id = ?').run(at, id);
    },
  };
}
