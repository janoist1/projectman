import type { Db } from './database';

export interface UserRecord {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  createdAt: string;
}

export interface AuthSessionRecord {
  /** SHA-256 of the cookie token. */
  id: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
}

interface UserRow {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  created_at: string;
}

interface AuthSessionRow {
  id: string;
  user_id: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
}

const toUser = (r: UserRow): UserRecord => ({
  id: r.id,
  name: r.name,
  email: r.email,
  passwordHash: r.password_hash,
  createdAt: r.created_at,
});

const toAuthSession = (r: AuthSessionRow): AuthSessionRecord => ({
  id: r.id,
  userId: r.user_id,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  lastSeenAt: r.last_seen_at,
});

export function createUserRepository(db: Db) {
  return {
    count(): number {
      return (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
    },
    insert(user: UserRecord): void {
      db.prepare('INSERT INTO users (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(
        user.id,
        user.name,
        user.email,
        user.passwordHash,
        user.createdAt,
      );
    },
    get(id: string): UserRecord | null {
      const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
      return row ? toUser(row) : null;
    },
    /** Case-insensitive lookup (the column is COLLATE NOCASE). */
    findByEmail(email: string): UserRecord | null {
      const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined;
      return row ? toUser(row) : null;
    },
    list(): UserRecord[] {
      return (db.prepare('SELECT * FROM users ORDER BY created_at').all() as UserRow[]).map(toUser);
    },
  };
}

export function createAuthSessionRepository(db: Db) {
  return {
    insert(s: AuthSessionRecord): void {
      db.prepare(
        'INSERT INTO auth_sessions (id, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
      ).run(s.id, s.userId, s.createdAt, s.expiresAt, s.lastSeenAt);
    },
    get(id: string): AuthSessionRecord | null {
      const row = db.prepare('SELECT * FROM auth_sessions WHERE id = ?').get(id) as
        AuthSessionRow | undefined;
      return row ? toAuthSession(row) : null;
    },
    touch(id: string, at: string): void {
      db.prepare('UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?').run(at, id);
    },
    delete(id: string): void {
      db.prepare('DELETE FROM auth_sessions WHERE id = ?').run(id);
    },
    deleteExpired(now: string): number {
      return db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(now).changes;
    },
  };
}

export type UserRepository = ReturnType<typeof createUserRepository>;
export type AuthSessionRepository = ReturnType<typeof createAuthSessionRepository>;
