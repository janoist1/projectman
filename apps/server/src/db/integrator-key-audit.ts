import type {
  IntegratorKeyAuditEntry,
  IntegratorKeyAuditPage,
  IntegratorKeyAuditQuery,
} from '@projectman/shared';
import type { Db } from './database';

interface AuditRow {
  seq: number;
  key_id: string;
  action: IntegratorKeyAuditEntry['action'];
  prefix: string;
  mode: IntegratorKeyAuditEntry['mode'];
  at: string;
  pairing_id: string | null;
}

/** Append-only lifecycle audit; callers include writes in the key's transaction. */
export function createIntegratorKeyAuditRepository(db: Db) {
  return {
    insert(ownerUserId: string, entry: Omit<IntegratorKeyAuditEntry, 'seq'>): void {
      db.prepare(
        'INSERT INTO integrator_key_audit (key_id, owner_user_id, action, prefix, mode, at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(entry.keyId, ownerUserId, entry.action, entry.prefix, entry.mode, entry.at);
    },
    list(ownerUserId: string, query: IntegratorKeyAuditQuery): IntegratorKeyAuditPage {
      const rows = db
        .prepare(
          `SELECT a.seq, a.key_id, a.action, a.prefix, a.mode, a.at, k.pairing_id FROM integrator_key_audit a
         LEFT JOIN integrator_keys k ON k.id = a.key_id
         WHERE a.owner_user_id = ? AND (? IS NULL OR a.seq < ?) ORDER BY a.seq DESC LIMIT ?`,
        )
        .all(ownerUserId, query.before ?? null, query.before ?? null, query.limit + 1) as AuditRow[];
      const entries = rows.slice(0, query.limit).map((row) => ({
        seq: row.seq,
        keyId: row.key_id,
        action: row.action,
        prefix: row.prefix,
        mode: row.mode,
        at: row.at,
        ...(row.pairing_id ? { paired: true } : {}),
      }));
      return { entries, nextBefore: rows.length > query.limit ? entries.at(-1)!.seq : null };
    },
  };
}
