import type {
  IntegratorAccessKeyInfo,
  IntegratorChannel,
  IntegratorKeyInfo,
  IntegratorKeyMode,
} from '@projectman/shared';
import type { Db } from './database';
import { createIntegratorKeyAuditRepository } from './integrator-key-audit';

interface KeyRow {
  id: string;
  user_id: string;
  prefix: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  mode: IntegratorKeyMode;
  last_used_channel: IntegratorChannel | null;
}
export function createIntegratorKeyRepository(db: Db) {
  const audit = createIntegratorKeyAuditRepository(db);
  const info = (row: KeyRow, now: string): IntegratorKeyInfo => ({
    prefix: row.prefix,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
    state: row.revoked_at ? 'revoked' : row.expires_at && row.expires_at <= now ? 'expired' : 'active',
  });
  const accessInfo = (row: KeyRow, now: string): IntegratorAccessKeyInfo => ({
    ...info(row, now),
    id: row.id,
    mode: row.mode,
    lastUsedChannel: row.last_used_channel,
  });
  const credential = (row: KeyRow | undefined) =>
    row ? { id: row.id, userId: row.user_id, prefix: row.prefix, mode: row.mode } : null;
  const record = (row: KeyRow, action: 'created' | 'revoked', at: string) =>
    audit.insert(row.user_id, { keyId: row.id, prefix: row.prefix, mode: row.mode, action, at });
  const revokeRow = (row: KeyRow, at: string) => {
    if (!row.revoked_at) {
      db.prepare('UPDATE integrator_keys SET revoked_at = ? WHERE id = ?').run(at, row.id);
      record(row, 'revoked', at);
    }
    return { ...row, revoked_at: row.revoked_at ?? at };
  };
  return {
    /** The singular API remains a view of the legacy key only. */
    latest(userId: string, now: string): IntegratorKeyInfo | null {
      const row = db
        .prepare(
          "SELECT * FROM integrator_keys WHERE user_id = ? AND mode = 'legacy' ORDER BY rowid DESC LIMIT 1",
        )
        .get(userId) as KeyRow | undefined;
      return row ? info(row, now) : null;
    },
    list(userId: string, now: string): IntegratorAccessKeyInfo[] {
      return (
        db
          .prepare('SELECT * FROM integrator_keys WHERE user_id = ? ORDER BY rowid DESC')
          .all(userId) as KeyRow[]
      ).map((row) => accessInfo(row, now));
    },
    create(input: {
      id: string;
      userId: string;
      prefix: string;
      hash: string;
      at: string;
      expiresAt: string | null;
      mode?: IntegratorKeyMode;
    }): IntegratorAccessKeyInfo {
      return db.transaction(() => {
        const mode = input.mode ?? 'legacy';
        const previous = db
          .prepare('SELECT * FROM integrator_keys WHERE user_id = ? AND mode = ? AND revoked_at IS NULL')
          .get(input.userId, mode) as KeyRow | undefined;
        if (previous) revokeRow(previous, input.at);
        db.prepare(
          'INSERT INTO integrator_keys (id, user_id, prefix, token_hash, created_at, expires_at, mode) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).run(input.id, input.userId, input.prefix, input.hash, input.at, input.expiresAt, mode);
        const row = db.prepare('SELECT * FROM integrator_keys WHERE id = ?').get(input.id) as KeyRow;
        record(row, 'created', input.at);
        return accessInfo(row, input.at);
      })();
    },
    revoke(userId: string, at: string): IntegratorKeyInfo | null {
      return db.transaction(() => {
        const row = db
          .prepare(
            `SELECT * FROM integrator_keys WHERE user_id = ? AND mode = 'legacy'
           AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
          )
          .get(userId, at) as KeyRow | undefined;
        return row ? info(revokeRow(row, at), at) : null;
      })();
    },
    revokeById(userId: string, id: string, at: string): IntegratorAccessKeyInfo | null {
      return db.transaction(() => {
        const row = db
          .prepare('SELECT * FROM integrator_keys WHERE user_id = ? AND id = ?')
          .get(userId, id) as KeyRow | undefined;
        return row ? accessInfo(revokeRow(row, at), at) : null;
      })();
    },
    resolveKey(hash: string, at: string) {
      return credential(
        db
          .prepare(
            'SELECT * FROM integrator_keys WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)',
          )
          .get(hash, at) as KeyRow | undefined,
      );
    },
    activeById(id: string, at: string) {
      return credential(
        db
          .prepare(
            'SELECT * FROM integrator_keys WHERE id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)',
          )
          .get(id, at) as KeyRow | undefined,
      );
    },
    /** Authentication alone records use; validity rechecks never touch telemetry. */
    touch(id: string, at: string, channel: IntegratorChannel): void {
      db.prepare(
        `UPDATE integrator_keys SET last_used_at = ?, last_used_channel = ? WHERE id = ?
         AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
         AND (last_used_at IS NULL OR last_used_channel IS NOT ? OR last_used_at <= ?)`,
      ).run(at, channel, id, at, channel, new Date(Date.parse(at) - 300_000).toISOString());
    },
  };
}
