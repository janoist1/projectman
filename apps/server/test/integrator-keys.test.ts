import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IntegratorKeyMode } from '@projectman/shared';
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
  const create = (mode: IntegratorKeyMode) =>
    mode === 'legacy'
      ? auth.createIntegratorKey('owner', null)
      : auth.createIntegratorAccessKey('owner', { mode, expiresInDays: 7 });
  const list = () => auth.integratorAccessKeys('owner');
  const audit = () => auth.integratorKeyAudit('owner', { limit: 100 });
  const advance = (ms: number) => {
    now = new Date(now.getTime() + ms);
  };

  it('replaces only the same mode and keeps the singular legacy view unchanged', () => {
    const legacy = create('legacy');
    const first = create('super');
    const read = create('read');
    const second = create('super');
    expect(list().map((key) => [key.mode, key.state])).toEqual([
      ['super', 'active'],
      ['read', 'active'],
      ['super', 'revoked'],
      ['legacy', 'active'],
    ]);
    expect(auth.integratorKey('owner')).toEqual(legacy.key);
    expect(auth.resolveIntegratorCredential(first.secret, 'rest')).toBeNull();
    for (const [created, mode] of [
      [legacy, 'legacy'],
      [read, 'read'],
      [second, 'super'],
    ] as const) {
      expect(auth.resolveIntegratorCredential(created.secret, 'rest')).toMatchObject({ mode });
    }
    expect(auth.resolveIntegratorKey(second.secret)).toBeNull();
    auth.revokeIntegratorKey('owner');
    expect(
      list()
        .filter((key) => key.state === 'active')
        .map((key) => key.mode),
    ).toEqual(['super', 'read']);
    expect(auth.resolveIntegratorCredential(legacy.secret, 'rest')).toBeNull();
    expect(audit().entries.map((entry) => [entry.mode, entry.action])).toEqual([
      ['legacy', 'revoked'],
      ['super', 'created'],
      ['super', 'revoked'],
      ['read', 'created'],
      ['super', 'created'],
      ['legacy', 'created'],
    ]);
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

  it('replaces a legacy key without revoking explicit modes', () => {
    const first = create('legacy');
    create('super');
    create('read');
    const second = create('legacy');
    expect(list().map((key) => [key.mode, key.state])).toEqual([
      ['legacy', 'active'],
      ['read', 'active'],
      ['super', 'active'],
      ['legacy', 'revoked'],
    ]);
    expect(auth.integratorKey('owner')).toEqual(second.key);
    expect(auth.resolveIntegratorCredential(first.secret, 'rest')).toBeNull();
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

  it.each(['legacy', 'super', 'read'] as const)(
    'rejects revoked, expired and invalid %s credentials without usage writes',
    (mode) => {
      const created =
        mode === 'legacy'
          ? auth.createIntegratorKey('owner', 1)
          : auth.createIntegratorAccessKey('owner', { mode, expiresInDays: 1 });
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

  it('rejects keys whose owner is no longer a password account or is not the host owner', () => {
    const created = create('super');
    const principal = auth.resolveIntegratorCredential(created.secret, 'cli')!;
    const before = list();
    db.prepare("UPDATE users SET password_hash = '' WHERE id = ?").run('owner');
    expect(auth.resolveIntegratorCredential(created.secret, 'mcp')).toBeNull();
    expect(() => auth.assertActive(principal)).toThrow(/invalid/);
    expect(list()).toEqual(before);
    repos.users.insert(user('other'));
    const foreign = auth.createIntegratorAccessKey('other', { mode: 'read', expiresInDays: 1 });
    expect(auth.resolveIntegratorCredential(foreign.secret, 'rest')).toBeNull();
    expect(auth.integratorAccessKeys('other')[0]!.lastUsedAt).toBeNull();
  });
});

describe('integrator credential migration', () => {
  it('preserves an old credential as legacy with no recorded channel and migrates idempotently', () => {
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
          state: 'active',
          createdAt: START,
          lastUsedAt: START,
          expiresAt: null,
          revokedAt: null,
          mode: 'legacy',
          lastUsedChannel: null,
        },
      ]);
      expect(repos.integratorKeys.resolveKey('old-hash', START)).toMatchObject({ id: 'old', mode: 'legacy' });
      expect(repos.integratorKeyAudit.list('owner', { limit: 50 }).entries).toEqual([]);
    } finally {
      db.close();
    }
  });
});
