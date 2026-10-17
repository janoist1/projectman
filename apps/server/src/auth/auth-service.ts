import { createHash, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { IntegratorKeyInfo } from '@projectman/shared';
import type {
  CreateIntegratorAccessKeyRequest,
  IntegratorChannel,
  IntegratorKeyAuditQuery,
} from '@projectman/shared';
import type { IntegratorPrincipal } from '../contracts';
import type { Repositories, UserRecord } from '../db';
import { conflict, DomainError } from '../kernel';
import { newId } from '../kernel';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
}

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Argon2id (algorithm 2): 19 MiB, two iterations, one lane. */
const PASSWORD_OPTIONS = { algorithm: 2 as const, memoryCost: 19456, timeCost: 2, parallelism: 1 };
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

/** Hash of a password nobody knows: verifying against it keeps failed logins equally slow. */
let dummyHash: Promise<string> | null = null;

function tokenId(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Users, argon2 passwords and login sessions (stored as SHA-256 of the cookie token). */
export class AuthService {
  private readonly principals = new WeakSet<IntegratorPrincipal>();
  private readonly repos: Repositories;
  private readonly now: () => Date;
  readonly sessionTtlMs: number;
  private readonly keyListeners = new Set<() => void>();

  constructor(opts: { repos: Repositories; now?: () => Date; sessionTtlMs?: number }) {
    this.repos = opts.repos;
    this.now = opts.now ?? (() => new Date());
    this.sessionTtlMs = opts.sessionTtlMs ?? SESSION_TTL_MS;
  }

  needsSetup(): boolean {
    return this.repos.users.count() === 0;
  }

  integratorKey(userId: string) {
    return this.repos.integratorKeys.latest(userId, this.now().toISOString());
  }

  createIntegratorKey(userId: string, expiresInDays: number | null) {
    const created = this.createKey(userId, 'legacy', expiresInDays);
    return { ...created, key: IntegratorKeyInfo.parse(created.key) };
  }

  integratorAccessKeys(userId: string) {
    return this.repos.integratorKeys.list(userId, this.now().toISOString());
  }

  createIntegratorAccessKey(userId: string, input: CreateIntegratorAccessKeyRequest) {
    return this.createKey(userId, input.mode, input.expiresInDays);
  }

  revokeIntegratorAccessKey(userId: string, id: string) {
    const revoked = this.repos.integratorKeys.revokeById(userId, id, this.now().toISOString());
    this.keysChanged();
    return revoked;
  }

  /**
   * Calls `listener` once any integrator key was created, replaced or revoked, so a request that waits
   * on a key (the long-polling event read, PM-761) checks it again at once. Expiry has no event:
   * the waiting request times its own check from `integratorKeyExpiresInMs`.
   */
  onIntegratorKeysChanged(listener: () => void): () => void {
    this.keyListeners.add(listener);
    return () => {
      this.keyListeners.delete(listener);
    };
  }

  /** Milliseconds until an integrator key expires; null: it does not (or is unknown). */
  integratorKeyExpiresInMs(keyId: string): number | null {
    const at = this.repos.integratorKeys.expiresAt(keyId);
    return at ? Date.parse(at) - this.now().getTime() : null;
  }

  private keysChanged(): void {
    for (const listener of [...this.keyListeners]) {
      try {
        listener();
      } catch {
        // A waiting request that cannot be woken still times out on its own.
      }
    }
  }

  integratorKeyAudit(userId: string, query: IntegratorKeyAuditQuery) {
    return this.repos.integratorKeyAudit.list(userId, query);
  }

  private createKey(userId: string, mode: IntegratorPrincipal['mode'], expiresInDays: number | null) {
    const secret = `pmi_${randomBytes(32).toString('base64url')}`;
    const at = this.now();
    const key = this.repos.integratorKeys.create({
      id: newId('ikey'),
      userId,
      mode,
      prefix: secret.slice(0, 12),
      hash: tokenId(secret),
      at: at.toISOString(),
      expiresAt:
        expiresInDays === null ? null : new Date(at.getTime() + expiresInDays * 86_400_000).toISOString(),
    });
    this.keysChanged();
    return { key, secret };
  }

  revokeIntegratorKey(userId: string) {
    const revoked = this.repos.integratorKeys.revoke(userId, this.now().toISOString());
    this.keysChanged();
    return revoked;
  }

  resolveIntegratorKey(secret: string): AuthUser | null {
    return this.resolveIntegratorPrincipal(secret)?.user ?? null;
  }

  /**
   * Compatibility for legacy callers that use the owner's identity. Explicit super/read keys must use
   * resolveIntegratorCredential and their own execution policy instead.
   */
  resolveIntegratorPrincipal(secret: string): { user: AuthUser; principal: IntegratorPrincipal } | null {
    const principal = this.resolveIntegratorCredential(secret, 'rest');
    if (!principal || principal.mode !== 'legacy') return null;
    return { user: this.user(principal.userId)!, principal };
  }

  /** The common credential resolver for REST, external MCP and event polling. */
  resolveIntegratorCredential(secret: string, channel: IntegratorChannel): IntegratorPrincipal | null {
    const at = this.now().toISOString();
    const key = this.repos.integratorKeys.resolveKey(tokenId(secret), at);
    if (!key || !this.isHostOwner(key.userId) || !this.hasPassword(key.userId)) return null;
    this.repos.integratorKeys.touch(key.id, at, channel);
    const principal = Object.freeze({
      kind: 'integrator' as const,
      userId: key.userId,
      keyId: key.id,
      prefix: key.prefix,
      mode: key.mode,
    });
    this.principals.add(principal);
    return principal;
  }

  /** Rechecks the exact credential and its current owner without recording another use. */
  assertActive(principal: IntegratorPrincipal): void {
    const key = this.repos.integratorKeys.activeById(principal.keyId, this.now().toISOString());
    if (
      !this.principals.has(principal) ||
      !key ||
      principal.kind !== 'integrator' ||
      key.userId !== principal.userId ||
      key.prefix !== principal.prefix ||
      key.mode !== principal.mode ||
      !this.isHostOwner(key.userId) ||
      !this.hasPassword(key.userId)
    ) {
      throw new DomainError('integrator_key_invalid', 'Integrator key is invalid, revoked or expired', {
        status: 401,
      });
    }
  }

  /**
   * The initial host owner: the account created by the first-run setup, the only one trusted
   * with host operations such as choosing a workspace directory for a new project.
   */
  isHostOwner(userId: string): boolean {
    return this.repos.users.list()[0]?.id === userId;
  }

  /** First-run setup: creates the owner account; refused once any user exists. */
  async createFirstUser(input: { name: string; email: string; password: string }): Promise<UserRecord> {
    if (!this.needsSetup()) throw conflict('already_set_up', 'the owner account already exists');
    const passwordHash = await hash(input.password, PASSWORD_OPTIONS);
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

  /** Prepares a new colleague account; it is persisted only after the config commit succeeds. */
  async prepareUser(input: { name: string; email: string; password: string }): Promise<UserRecord> {
    return {
      id: newId('usr'),
      name: input.name.trim(),
      email: input.email.trim().toLowerCase(),
      passwordHash: await hash(input.password, PASSWORD_OPTIONS),
      createdAt: this.now().toISOString(),
    };
  }

  /** Returns the user when the password matches; null otherwise (timing does not reveal which part failed). */
  async verifyPassword(email: string, password: string): Promise<UserRecord | null> {
    const user = this.repos.users.findByEmail(email.trim());
    // No account and a passwordless one (PM-670) both verify against the dummy hash: the same time, never a match.
    if (!user || user.passwordHash === null) {
      dummyHash ??= hash(randomBytes(16).toString('hex'), PASSWORD_OPTIONS);
      await verify(await dummyHash, password).catch(() => false);
      return null;
    }
    const ok = await verify(user.passwordHash, password).catch(() => false);
    return ok ? user : null;
  }

  /**
   * Prepares a passwordless account for an invited client (PM-670); like `prepareUser` it is persisted
   * only after the config commit succeeds. It can never log in with a password or hold an integrator key.
   */
  preparePasswordlessUser(input: { name: string; email: string }): UserRecord {
    return {
      id: newId('usr'),
      name: input.name.trim(),
      email: input.email.trim().toLowerCase(),
      passwordHash: null,
      createdAt: this.now().toISOString(),
    };
  }

  /** The account with this id, or null. */
  user(id: string): AuthUser | null {
    const user = this.repos.users.get(id);
    return user ? { id: user.id, name: user.name, email: user.email } : null;
  }

  /** Whether the account can log in with a password (a passwordless account cannot). */
  hasPassword(userId: string): boolean {
    return this.repos.users.get(userId)?.passwordHash != null;
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
