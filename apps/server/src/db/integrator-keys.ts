import type { IntegratorKeyInfo } from '@projectman/shared';
import type { Db } from './database';

interface KeyRow {
  id: string;
  user_id: string;
  prefix: string;
  token_hash: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
}
export function createIntegratorKeyRepository(db: Db) {
  const info = (row: KeyRow, now: string): IntegratorKeyInfo => ({
    prefix: row.prefix,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
    state: row.revoked_at ? 'revoked' : row.expires_at && row.expires_at <= now ? 'expired' : 'active',
  });
  return {
    latest(userId: string, now: string): IntegratorKeyInfo | null {
      const row = db
        .prepare('SELECT * FROM integrator_keys WHERE user_id = ? ORDER BY rowid DESC LIMIT 1')
        .get(userId) as KeyRow | undefined;
      return row ? info(row, now) : null;
    },
    create(input: {
      id: string;
      userId: string;
      prefix: string;
      hash: string;
      at: string;
      expiresAt: string | null;
    }): IntegratorKeyInfo {
      return db.transaction(() => {
        db.prepare('UPDATE integrator_keys SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(
          input.at,
          input.userId,
        );
        db.prepare(
          'INSERT INTO integrator_keys (id, user_id, prefix, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(input.id, input.userId, input.prefix, input.hash, input.at, input.expiresAt);
        return this.latest(input.userId, input.at)!;
      })();
    },
    revoke(userId: string, at: string): IntegratorKeyInfo | null {
      const result = db
        .prepare(
          'UPDATE integrator_keys SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)',
        )
        .run(at, userId, at);
      return result.changes ? this.latest(userId, at) : null;
    },
    resolve(hash: string, at: string): string | null {
      const row = db
        .prepare(
          'SELECT * FROM integrator_keys WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)',
        )
        .get(hash, at) as KeyRow | undefined;
      if (!row) return null;
      if (!row.last_used_at || Date.parse(at) - Date.parse(row.last_used_at) >= 300_000)
        db.prepare('UPDATE integrator_keys SET last_used_at = ? WHERE id = ?').run(at, row.id);
      return row.user_id;
    },
  };
}
