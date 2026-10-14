import type { Db } from './database';

export type EmailLoginEventKind = 'request' | 'send' | 'verify';

/** The live code of one address. `addressHash` is a keyed hash: the address itself is never stored. */
export interface EmailLoginCodeRecord {
  addressHash: string;
  id: string;
  codeHash: string;
  createdAt: string;
  expiresAt: string;
  failedAttempts: number;
  usedAt: string | null;
}

interface CodeRow {
  address_hash: string;
  id: string;
  code_hash: string;
  created_at: string;
  expires_at: string;
  failed_attempts: number;
  used_at: string | null;
}

const toCode = (r: CodeRow): EmailLoginCodeRecord => ({
  addressHash: r.address_hash,
  id: r.id,
  codeHash: r.code_hash,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  failedAttempts: r.failed_attempts,
  usedAt: r.used_at,
});

/** The most failed tries one code takes; the one after is refused (the code is void). */
export const EMAIL_LOGIN_MAX_FAILED_ATTEMPTS = 5;

/**
 * The durable state of the e-mail login (PM-670): one live code per address and the events the
 * limits count. `subject` is `ip:<hmac>` or `addr:<hmac>`; `null` in a count means all subjects.
 */
export function createEmailLoginRepository(db: Db) {
  return {
    countEvents(kind: EmailLoginEventKind, subject: string | null, since: string): number {
      const row =
        subject === null
          ? db
              .prepare('SELECT COUNT(*) AS n FROM email_login_events WHERE kind = ? AND at > ?')
              .get(kind, since)
          : db
              .prepare(
                'SELECT COUNT(*) AS n FROM email_login_events WHERE kind = ? AND subject = ? AND at > ?',
              )
              .get(kind, subject, since);
      return (row as { n: number }).n;
    },
    /** The time of the oldest event after `since`, or null: when the window next frees a place. */
    oldestEvent(kind: EmailLoginEventKind, subject: string | null, since: string): string | null {
      const row =
        subject === null
          ? db
              .prepare('SELECT MIN(at) AS at FROM email_login_events WHERE kind = ? AND at > ?')
              .get(kind, since)
          : db
              .prepare(
                'SELECT MIN(at) AS at FROM email_login_events WHERE kind = ? AND subject = ? AND at > ?',
              )
              .get(kind, subject, since);
      return (row as { at: string | null }).at;
    },
    addEvent(kind: EmailLoginEventKind, subject: string, at: string): void {
      db.prepare('INSERT INTO email_login_events (kind, subject, at) VALUES (?, ?, ?)').run(
        kind,
        subject,
        at,
      );
    },
    /** Drops the events older than `before` and the codes that expired before it. */
    prune(before: string): void {
      db.prepare('DELETE FROM email_login_events WHERE at < ?').run(before);
      db.prepare('DELETE FROM email_login_codes WHERE expires_at < ?').run(before);
    },
    /** Makes this the address's only live code: an earlier one is gone. */
    putCode(row: EmailLoginCodeRecord): void {
      db.prepare(
        `INSERT INTO email_login_codes (address_hash, id, code_hash, created_at, expires_at, failed_attempts, used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(address_hash) DO UPDATE SET id = excluded.id, code_hash = excluded.code_hash,
           created_at = excluded.created_at, expires_at = excluded.expires_at,
           failed_attempts = excluded.failed_attempts, used_at = excluded.used_at`,
      ).run(
        row.addressHash,
        row.id,
        row.codeHash,
        row.createdAt,
        row.expiresAt,
        row.failedAttempts,
        row.usedAt,
      );
    },
    code(addressHash: string): EmailLoginCodeRecord | null {
      const row = db.prepare('SELECT * FROM email_login_codes WHERE address_hash = ?').get(addressHash) as
        CodeRow | undefined;
      return row ? toCode(row) : null;
    },
    failAttempt(id: string): void {
      db.prepare('UPDATE email_login_codes SET failed_attempts = failed_attempts + 1 WHERE id = ?').run(id);
    },
    /** Uses the code up. True for exactly one caller: the code must be unused, valid and within its tries. */
    consume(id: string, at: string): boolean {
      return (
        db
          .prepare(
            `UPDATE email_login_codes SET used_at = ?
             WHERE id = ? AND used_at IS NULL AND failed_attempts < ? AND expires_at > ?`,
          )
          .run(at, id, EMAIL_LOGIN_MAX_FAILED_ATTEMPTS, at).changes === 1
      );
    },
  };
}
