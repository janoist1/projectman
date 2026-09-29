import { createHash, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type { Repositories, UserRecord } from '../db';
import { conflict } from '../domain/errors';
import { newId } from '../domain/util';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
}

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

/** Hash of a password nobody knows: verifying against it keeps failed logins equally slow. */
let dummyHash: Promise<string> | null = null;

function tokenId(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Users, argon2 passwords and login sessions (stored as SHA-256 of the cookie token). */
export class AuthService {
  private readonly repos: Repositories;
  private readonly now: () => Date;
  readonly sessionTtlMs: number;

  constructor(opts: { repos: Repositories; now?: () => Date; sessionTtlMs?: number }) {
    this.repos = opts.repos;
    this.now = opts.now ?? (() => new Date());
    this.sessionTtlMs = opts.sessionTtlMs ?? SESSION_TTL_MS;
  }

  needsSetup(): boolean {
    return this.repos.users.count() === 0;
  }

  /** First-run setup: creates the owner account; refused once any user exists. */
  async createFirstUser(input: { name: string; email: string; password: string }): Promise<UserRecord> {
    if (!this.needsSetup()) throw conflict('already_set_up', 'the owner account already exists');
    const passwordHash = await hash(input.password);
    const user: UserRecord = {
      id: newId('usr'),
      name: input.name.trim(),
      email: input.email.trim(),
      passwordHash,
      createdAt: this.now().toISOString(),
    };
    this.repos.transaction(() => {
      if (!this.needsSetup()) throw conflict('already_set_up', 'the owner account already exists');
      this.repos.users.insert(user);
    });
    return user;
  }

  /** Returns the user when the password matches; null otherwise (timing does not reveal which part failed). */
  async verifyPassword(email: string, password: string): Promise<UserRecord | null> {
    const user = this.repos.users.findByEmail(email.trim());
    if (!user) {
      dummyHash ??= hash(randomBytes(16).toString('hex'));
      await verify(await dummyHash, password).catch(() => false);
      return null;
    }
    const ok = await verify(user.passwordHash, password).catch(() => false);
    return ok ? user : null;
  }

  /** Creates a login session; returns the token for the cookie. */
  createSession(userId: string): string {
    const token = randomBytes(32).toString('base64url');
    const now = this.now();
    this.repos.authSessions.deleteExpired(now.toISOString());
    this.repos.authSessions.insert({
      id: tokenId(token),
      userId,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.sessionTtlMs).toISOString(),
      lastSeenAt: now.toISOString(),
    });
    return token;
  }

  /** The user of a valid, unexpired session token. */
  resolve(token: string): AuthUser | null {
    const id = tokenId(token);
    const session = this.repos.authSessions.get(id);
    if (!session) return null;
    const now = this.now();
    if (session.expiresAt <= now.toISOString()) {
      this.repos.authSessions.delete(id);
      return null;
    }
    const user = this.repos.users.get(session.userId);
    if (!user) return null;
    if (now.getTime() - Date.parse(session.lastSeenAt) > TOUCH_INTERVAL_MS) {
      this.repos.authSessions.touch(id, now.toISOString());
    }
    return { id: user.id, name: user.name, email: user.email };
  }

  revoke(token: string): void {
    this.repos.authSessions.delete(tokenId(token));
  }
}
