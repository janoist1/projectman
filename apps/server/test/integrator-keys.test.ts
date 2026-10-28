import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from '../src/auth';
import { createRepositories, LATEST_SCHEMA_VERSION, migrate, migrations, openDatabase } from '../src/db';
import type { Db, Repositories } from '../src/db';

const START = '2026-10-17T10:00:00.000Z';
const user = (id: string) => ({
  id,
  name: id,
  email: `${id}@example.com`,
  passwordHash: 'test-hash',
  createdAt: START,
});

describe('integrator key modes and lifecycle', () => {
  let db: Db;
  let repos: Repositories;
  let auth: AuthService;
  let now: Date;
  beforeEach(() => {
    db = openDatabase(':memory:');
    repos = createRepositories(db);
    repos.users.insert(user('owner'));
    now = new Date(START);
    auth = new AuthService({ repos, now: () => now });
  });
  afterEach(() => db.close());
  const create = (mode: 'super' | 'read') =>
    auth.createIntegratorAccessKey('owner', { mode, expiresInDays: 7 });
  const list = () => auth.integratorAccessKeys('owner');
  const audit = () => auth.integratorKeyAudit('owner', { limit: 100 });
  const advance = (ms: number) => {
    now = new Date(now.getTime() + ms);
  };

  it('replaces only the same mode', () => {
    const first = create('super');
    const read = create('read');
    const second = create('super');
    expect(list().map((key) => [key.mode, key.state])).toEqual([
      ['super', 'active'],
      ['read', 'active'],
      ['super', 'revoked'],
    ]);
    expect(auth.resolveIntegratorCredential(first.secret, 'rest')).toBeNull();
    expect(auth.resolveIntegratorCredential(read.secret, 'rest')).toMatchObject({ mode: 'read' });
    expect(auth.resolveIntegratorCredential(second.secret, 'rest')).toMatchObject({ mode: 'super' });
    expect(audit().entries.map((entry) => entry.action)).toEqual([
      'created',
      'revoked',
      'created',
      'created',
    ]);
  });

  it('reports a live super key by email: not a read key, an expired, a revoked or an unknown one (PM-1045)', () => {
    expect(auth.hasActiveSuperKey('owner@example.com')).toBe(false);
    create('read');
    expect(auth.hasActiveSuperKey('owner@example.com')).toBe(false);
    const key = create('super');
    expect(auth.hasActiveSuperKey('owner@example.com')).toBe(true);
    expect(auth.hasActiveSuperKey('nobody@example.com')).toBe(false);
    advance(8 * 24 * 60 * 60_000);
    expect(auth.hasActiveSuperKey('owner@example.com')).toBe(false);
    advance(-8 * 24 * 60 * 60_000);
    auth.revokeIntegratorAccessKey('owner', key.key.id);
    expect(auth.hasActiveSuperKey('owner@example.com')).toBe(false);
  });

  it('enforces one unrevoked key per owner and mode in SQL', () => {
    create('super');
    expect(() =>
      db
        .prepare(
          `INSERT INTO integrator_keys (id, user_id, prefix, token_hash, created_at, mode)
       VALUES ('duplicate', 'owner', 'prefix', 'hash', ?, 'super')`,
        )
        .run(START),
    ).toThrow(/UNIQUE/);
    expect(() => db.prepare("UPDATE integrator_keys SET mode = 'unknown'").run()).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE integrator_keys SET last_used_channel = 'unknown'").run()).toThrow(
      /CHECK/,
    );
    expect(create('read').key.state).toBe('active');
  });

  it('rolls replacement and its audit back together when the create audit cannot be written', () => {
    const first = create('super');
    const before = list();
    db.exec(`CREATE TRIGGER reject_creation BEFORE INSERT ON integrator_key_audit
      WHEN NEW.action = 'created' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`);
    expect(() => create('super')).toThrow('audit unavailable');
    expect(list()).toEqual(before);
    expect(audit().entries).toHaveLength(1);
    expect(auth.resolveIntegratorCredential(first.secret, 'rest')).not.toBeNull();
  });

  it('rolls revocation back if its audit fails and audits an idempotent revoke only once', () => {
    const created = auth.createIntegratorAccessKey('owner', { mode: 'read', expiresInDays: 1 });
    db.exec(`CREATE TRIGGER reject_revocation BEFORE INSERT ON integrator_key_audit
      WHEN NEW.action = 'revoked' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`);
    expect(() => auth.revokeIntegratorAccessKey('owner', created.key.id)).toThrow('audit unavailable');
    expect(list()[0]!.state).toBe('active');
    expect(audit().entries).toHaveLength(1);
    db.exec('DROP TRIGGER reject_revocation');
    const revoked = auth.revokeIntegratorAccessKey('owner', created.key.id);
    advance(86_400_000);
    expect(auth.revokeIntegratorAccessKey('owner', created.key.id)).toEqual(revoked);
    expect(audit().entries).toHaveLength(2);
    expect(auth.revokeIntegratorAccessKey('other', created.key.id)).toBeNull();
  });

  it('keeps secrets and hashes out of list and audit views and pages by sequence', () => {
    const created = create('super');
    const hash = createHash('sha256').update(created.secret).digest('hex');
    expect(created.secret).toMatch(/^pmi_[A-Za-z0-9_-]{43}$/);
    expect(db.prepare('SELECT token_hash FROM integrator_keys').get()).toEqual({ token_hash: hash });
    create('super');
    create('read');
    const first = auth.integratorKeyAudit('owner', { limit: 2 });
    expect(first.entries.map((entry) => entry.seq)).toEqual([4, 3]);
    expect(first.nextBefore).toBe(3);
    expect(auth.integratorKeyAudit('owner', { limit: 2, before: 3 })).toMatchObject({
      entries: [{ seq: 2 }, { seq: 1 }],
      nextBefore: null,
    });
    expect(auth.integratorKeyAudit('other', { limit: 100 }).entries).toEqual([]);
    for (const view of [JSON.stringify(list()), JSON.stringify(audit())]) {
      expect(view).not.toContain(created.secret);
      expect(view).not.toContain(hash);
      expect(view).not.toContain('token_hash');
      expect(view).not.toContain('owner_user_id');
    }
  });

  it('samples the timestamp per channel and rechecks validity without touching telemetry', () => {
    const created = create('super');
    expect(list()[0]).toMatchObject({ lastUsedAt: null, lastUsedChannel: null });
    const principal = auth.resolveIntegratorCredential(created.secret, 'mcp')!;
    expect(principal).toMatchObject({ keyId: list()[0]!.id, mode: 'super' });
    expect(list()[0]).toMatchObject({ lastUsedAt: START, lastUsedChannel: 'mcp' });
    advance(299_999);
    const beforeThrottle = db.prepare('SELECT total_changes() AS n').get();
    auth.resolveIntegratorCredential(created.secret, 'mcp');
    expect(list()[0]!.lastUsedAt).toBe(START);
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(beforeThrottle);
    advance(1);
    auth.resolveIntegratorCredential(created.secret, 'mcp');
    expect(list()[0]!.lastUsedAt).toBe(now.toISOString());
    for (const channel of ['cli', 'rest', 'mcp'] as const) {
      advance(1);
      auth.resolveIntegratorCredential(created.secret, channel);
      expect(list()[0]).toMatchObject({ lastUsedAt: now.toISOString(), lastUsedChannel: channel });
    }
    const before = list();
    const beforeRecheck = db.prepare('SELECT total_changes() AS n').get();
    advance(300_000);
    auth.assertActive(principal);
    expect(list()).toEqual(before);
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(beforeRecheck);
    for (const changed of [
      { keyId: 'other' },
      { userId: 'other' },
      { prefix: 'other' },
      { mode: 'read' as const },
    ]) {
      expect(() => auth.assertActive({ ...principal, ...changed })).toThrow(/invalid/);
    }
  });

  it.each(['super', 'read'] as const)(
    'rejects revoked, expired and invalid %s credentials without usage writes',
    (mode) => {
      const created = auth.createIntegratorAccessKey('owner', { mode, expiresInDays: 1 });
      const principal = auth.resolveIntegratorCredential(created.secret, 'cli')!;
      const used = list()[0]!.lastUsedAt;
      advance(86_400_000);
      expect(auth.resolveIntegratorCredential(created.secret, 'mcp')).toBeNull();
      expect(auth.resolveIntegratorCredential('pmi_invalid', 'rest')).toBeNull();
      expect(list()[0]!.lastUsedAt).toBe(used);
      expect(list()[0]!.lastUsedChannel).toBe('cli');
      expect(() => auth.assertActive(principal)).toThrow(/invalid/);
      expect(auth.revokeIntegratorAccessKey('owner', principal.keyId)?.state).toBe('revoked');
      now = new Date(START);
      expect(auth.resolveIntegratorCredential(created.secret, 'rest')).toBeNull();
      expect(() => auth.assertActive(principal)).toThrow(/invalid/);
      expect(list()[0]!.lastUsedAt).toBe(used);
    },
  );

  it('refuses reactivation and validity checks after a key becomes legacy', () => {
    const created = create('super');
    const principal = auth.resolveIntegratorCredential(created.secret, 'rest')!;
    db.prepare("UPDATE integrator_keys SET mode = 'legacy' WHERE id = ?").run(principal.keyId);
    expect(auth.reactivate(principal)).toBeNull();
    expect(() => auth.assertActive(principal)).toThrow(expect.objectContaining({ status: 401 }));
  });

  it('keeps a non-expiring explicit key active until revocation', () => {
    const created = auth.createIntegratorAccessKey('owner', { mode: 'super', expiresInDays: null });
    advance(2 * 365 * 86_400_000);
    expect(list()[0]).toMatchObject({ state: 'active', expiresAt: null });
    const principal = auth.resolveIntegratorCredential(created.secret, 'mcp')!;
    expect(principal).not.toBeNull();
    expect(auth.integratorKeyExpiresInMs(principal.keyId)).toBeNull();
    expect(() => auth.assertActive(principal)).not.toThrow();
    auth.revokeIntegratorAccessKey('owner', principal.keyId);
    expect(auth.resolveIntegratorCredential(created.secret, 'mcp')).toBeNull();
    expect(() => auth.assertActive(principal)).toThrow(/invalid/);
  });

  it('rejects keys whose owner is no longer a password account or an owner, and issues none to a non-owner', () => {
    const created = create('super');
    const principal = auth.resolveIntegratorCredential(created.secret, 'cli')!;
    const before = list();
    db.prepare("UPDATE users SET password_hash = '' WHERE id = ?").run('owner');
    expect(auth.resolveIntegratorCredential(created.secret, 'mcp')).toBeNull();
    expect(() => auth.assertActive(principal)).toThrow(/invalid/);
    expect(list()).toEqual(before);
    repos.users.insert(user('other'));
    expect(() => auth.createIntegratorAccessKey('other', { mode: 'read', expiresInDays: 1 })).toThrow(
      /owner with a password/,
    );
    repos.ownerAccounts.grant('other', 'owner', START);
    const foreign = auth.createIntegratorAccessKey('other', { mode: 'read', expiresInDays: 1 });
    repos.ownerAccounts.revoke('other', 'owner', START);
    expect(auth.resolveIntegratorCredential(foreign.secret, 'rest')).toBeNull();
    expect(auth.integratorAccessKeys('other')[0]!.lastUsedAt).toBeNull();
  });
});

describe('integrator credential migration', () => {
  it('audits only newly revoked legacy rows and leaves explicit keys and earlier audit untouched', () => {
    const db = openDatabase(':memory:');
    try {
      const repos = createRepositories(db);
      repos.users.insert(user('owner'));
      const insert = db.prepare(`INSERT INTO integrator_keys
        (id, user_id, prefix, token_hash, created_at, mode, revoked_at, expires_at)
        VALUES (?, 'owner', ?, ?, ?, ?, ?, ?)`);
      for (const [id, mode, revokedAt, expiresAt] of [
        ['active', 'legacy', null, null],
        ['revoked', 'legacy', START, null],
        ['super', 'super', null, null],
        ['read', 'read', null, null],
      ] as const)
        insert.run(id, id, id, START, mode, revokedAt, expiresAt);
      repos.integratorKeyAudit.insert('owner', {
        keyId: 'revoked',
        prefix: 'revoked',
        mode: 'legacy',
        action: 'revoked',
        at: START,
      });
      const migration = migrations.find((m) => m.name === 'revoke legacy integrator keys')!;
      db.transaction(() => db.exec(migration.sql))();
      const keys = repos.integratorKeys.list('owner', START);
      expect(keys.filter((k) => k.mode !== 'legacy').map((k) => k.state)).toEqual(['active', 'active']);
      expect(keys.filter((k) => k.mode === 'legacy').every((k) => k.state === 'revoked')).toBe(true);
      const entries = repos.integratorKeyAudit.list('owner', { limit: 50 }).entries;
      expect(entries).toHaveLength(2);
      expect(entries.find((e) => e.keyId === 'revoked')!.at).toBe(START);
      for (const id of ['active'])
        expect(entries.find((e) => e.keyId === id)).toMatchObject({
          action: 'revoked',
          mode: 'legacy',
          at: keys.find((k) => k.id === id)!.revokedAt,
        });
      db.transaction(() => db.exec(migration.sql))();
      expect(repos.integratorKeyAudit.list('owner', { limit: 50 }).entries).toEqual(entries);
    } finally {
      db.close();
    }
  });

  it('revokes an old credential, preserves its history and migrates idempotently', () => {
    const db = new Database(':memory:');
    try {
      const version = migrations.find(
        (migration) => migration.name === 'explicit integrator key modes and lifecycle audit',
      )!.version;
      for (const migration of migrations.filter((migration) => migration.version < version))
        db.exec(migration.sql);
      db.pragma(`user_version = ${version - 1}`);
      db.prepare('INSERT INTO users (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(
        'owner',
        'Owner',
        'owner@example.com',
        'hash',
        START,
      );
      db.prepare(
        `INSERT INTO integrator_keys (id, user_id, prefix, token_hash, created_at, last_used_at)
        VALUES ('old', 'owner', 'pmi_old', 'old-hash', ?, ?)`,
      ).run(START, START);
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      const repos = createRepositories(db);
      expect(repos.integratorKeys.list('owner', START)).toEqual([
        {
          id: 'old',
          prefix: 'pmi_old',
          state: 'revoked',
          createdAt: START,
          lastUsedAt: START,
          expiresAt: null,
          revokedAt: expect.any(String),
          mode: 'legacy',
          lastUsedChannel: null,
        },
      ]);
      expect(repos.integratorKeys.resolveKey('old-hash', START)).toBeNull();
      const entries = repos.integratorKeyAudit.list('owner', { limit: 50 }).entries;
      expect(entries).toEqual([
        expect.objectContaining({
          keyId: 'old',
          mode: 'legacy',
          action: 'revoked',
          at: repos.integratorKeys.list('owner', START)[0]!.revokedAt,
        }),
      ]);
    } finally {
      db.close();
    }
  });
});
