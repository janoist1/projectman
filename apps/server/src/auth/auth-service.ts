import { createHash, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import {
  canHoldIntegratorKey,
  DEFAULT_UI_LANGUAGE,
  integratorKeyCoversProject,
  isOwnerAccount,
} from '@projectman/shared';
import type {
  CreateIntegratorAccessKeyRequest,
  IntegratorChannel,
  IntegratorKeyAuditQuery,
  UiLanguage,
} from '@projectman/shared';
import type { IntegratorPrincipal } from '../contracts';
import type { Repositories, UserRecord } from '../db';
import { conflict, DomainError, forbidden, notFound } from '../kernel';
import { newId } from '../kernel';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  language: UiLanguage;
}

const authUserOf = (user: UserRecord): AuthUser => ({
  id: user.id,
  name: user.name,
  email: user.email,
  language: user.language,
});

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
  private readonly revokeListeners = new Set<(token: string) => void>();

  constructor(opts: { repos: Repositories; now?: () => Date; sessionTtlMs?: number }) {
    this.repos = opts.repos;
    this.now = opts.now ?? (() => new Date());
    this.sessionTtlMs = opts.sessionTtlMs ?? SESSION_TTL_MS;
  }

  needsSetup(): boolean {
    return this.repos.users.count() === 0;
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

  /** Revokes every integrator key of the user, with the audit rows; the revocation of an owner account (PM-1062). */
  revokeIntegratorAccessKeysOf(userId: string): number {
    const revoked = this.repos.integratorKeys.revokeAllOf(userId, this.now().toISOString());
    if (revoked > 0) this.keysChanged();
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

  /**
   * Whether the account with this email has a live (not revoked, not expired) super key that reaches the
   * project: the owner's connected client can work the project's integrator queue (PM-1045, PM-1063). False for
   * an unknown email, and for a project another owner account created (`keyCoversProject`).
   */
  hasActiveSuperKey(email: string, projectKey: string): boolean {
    const user = this.repos.users.findByEmail(email.trim());
    return (
      !!user &&
      this.keyHolderAllowed(user.id) &&
      this.keyCoversProject(user.id, projectKey) &&
      this.repos.integratorKeys.hasActiveSuper(user.id, this.now().toISOString())
    );
  }

  /**
   * Whether a key of this holder reaches the project (`integratorKeyCoversProject`, PM-1063): the creator
   * of a project an owner account made is the only holder, whatever its editable team says.
   */
  keyCoversProject(userId: string, projectKey: string): boolean {
    const createdBy = this.repos.projects.get(projectKey)?.createdBy ?? null;
    return integratorKeyCoversProject({
      createdBy,
      creatorIsHost: createdBy !== null && this.isHostOwner(createdBy),
      holder: userId,
    });
  }

  /** Whether this account may hold an integrator key right now (`canHoldIntegratorKey`, PM-1063). */
  keyHolderAllowed(userId: string): boolean {
    return canHoldIntegratorKey({
      hostOwner: this.isHostOwner(userId),
      ownerAccount: this.isOwnerAccount(userId),
      hasPassword: this.hasPassword(userId),
    });
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
    if (!this.keyHolderAllowed(userId))
      throw forbidden('owner_only', 'only an owner with a password may hold an integrator key');
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

  /** The common credential resolver for REST, external MCP and event polling. */
  resolveIntegratorCredential(secret: string, channel: IntegratorChannel): IntegratorPrincipal | null {
    const at = this.now().toISOString();
    const key = this.repos.integratorKeys.resolveKey(tokenId(secret), at);
    if (!key || key.mode === 'legacy' || !this.keyHolderAllowed(key.userId)) return null;
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

  /**
   * The live principal of a stored key (PM-784), for work that outlives its call. It records no use of the key
   * and gives nothing when the key is gone, expired, or no longer matches the stored owner and prefix.
   */
  reactivate(stored: { userId: string; keyId: string; prefix: string }): IntegratorPrincipal | null {
    const key = this.repos.integratorKeys.activeById(stored.keyId, this.now().toISOString());
    if (
      !key ||
      key.mode === 'legacy' ||
      key.userId !== stored.userId ||
      key.prefix !== stored.prefix ||
      !this.keyHolderAllowed(key.userId)
    )
      return null;
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
      key.mode === 'legacy' ||
      principal.kind !== 'integrator' ||
      key.userId !== principal.userId ||
      key.prefix !== principal.prefix ||
      key.mode !== principal.mode ||
      !this.keyHolderAllowed(key.userId)
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
    return this.hostOwner()?.id === userId;
  }

  /** The host owner's account (the one `isHostOwner` recognises), or null before the first-run setup. */
  hostOwner(): { id: string; email: string; name: string } | null {
    const user = this.repos.users.list()[0];
    return user ? { id: user.id, email: user.email, name: user.name } : null;
  }

  /**
   * Whether the account with this e-mail is the chopper's host owner (`isHostOwner`): the one rule behind the
   * instance-level rights (machine display, instance pause), independent of any project membership.
   */
  async instanceOwner(email: string): Promise<boolean> {
    const user = this.repos.users.findByEmail(email.trim());
    return user !== null && this.isHostOwner(user.id);
  }

  /** Whether the user holds an active owner account (PM-1062); the host owner has none, they are above it. */
  isOwnerAccount(userId: string): boolean {
    return isOwnerAccount(this.repos.ownerAccounts.get(userId));
  }

  /** First-run setup: creates the owner account; refused once any user exists. */
  async createFirstUser(input: {
    name: string;
    email: string;
    password: string;
    language?: UiLanguage;
  }): Promise<UserRecord> {
    if (!this.needsSetup()) throw conflict('already_set_up', 'the owner account already exists');
    const passwordHash = await hash(input.password, PASSWORD_OPTIONS);
    const user: UserRecord = {
      id: newId('usr'),
      name: input.name.trim(),
      email: input.email.trim(),
      passwordHash,
      createdAt: this.now().toISOString(),
      language: input.language ?? DEFAULT_UI_LANGUAGE,
    };
    this.repos.transaction(() => {
      if (!this.needsSetup()) throw conflict('already_set_up', 'the owner account already exists');
      this.repos.users.insert(user);
    });
    return user;
  }

  /** Prepares a new colleague account; it is persisted only after the config commit succeeds. */
  async prepareUser(input: {
    name: string;
    email: string;
    password: string;
    language?: UiLanguage;
  }): Promise<UserRecord> {
    return {
      id: newId('usr'),
      name: input.name.trim(),
      email: input.email.trim().toLowerCase(),
      passwordHash: await hash(input.password, PASSWORD_OPTIONS),
      createdAt: this.now().toISOString(),
      language: input.language ?? DEFAULT_UI_LANGUAGE,
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
  preparePasswordlessUser(input: { name: string; email: string; language?: UiLanguage }): UserRecord {
    return {
      id: newId('usr'),
      name: input.name.trim(),
      email: input.email.trim().toLowerCase(),
      passwordHash: null,
      createdAt: this.now().toISOString(),
      language: input.language ?? DEFAULT_UI_LANGUAGE,
    };
  }

  /** The account with this id, or null. */
  user(id: string): AuthUser | null {
    const user = this.repos.users.get(id);
    return user ? authUserOf(user) : null;
  }

  /** Saves the account's system language (PM-1168) and gives the account back. */
  setLanguage(userId: string, language: UiLanguage): AuthUser {
    this.repos.users.setLanguage(userId, language);
    const user = this.user(userId);
    if (!user) throw notFound('user', userId);
    return user;
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
    return authUserOf(user);
  }

  revoke(token: string): void {
    this.repos.authSessions.delete(tokenId(token));
    for (const listener of [...this.revokeListeners]) {
      try {
        listener(token);
      } catch {
        // A holder of a remembered login that cannot be told still re-checks it on its own.
      }
    }
  }

  /** Calls `listener` with the token of every session revoked (logout, login rotation), so a remembered login can be dropped at once. */
  onSessionRevoked(listener: (token: string) => void): () => void {
    this.revokeListeners.add(listener);
    return () => {
      this.revokeListeners.delete(listener);
    };
  }
}
