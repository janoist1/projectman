import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRepositories, migrate, migrations } from '../src/db';
import type { Db, EmailMessageRecord } from '../src/db';
import { openMigratedMemoryDatabase } from './helpers/database-seed';

const now = '2026-10-22T00:00:00.000Z';
const message = (
  extra: Partial<EmailMessageRecord> = {},
): Omit<EmailMessageRecord, 'id'> & { id?: string } => ({
  projectKey: 'AR',
  direction: 'outbound',
  member: 'dev',
  contact: 'ann',
  taskKey: 'AR-1',
  subject: 'Update',
  text: 'Ready',
  status: 'pending_approval',
  parkReason: null,
  note: null,
  fromAddress: null,
  attachmentNames: [],
  replyTokenHash: null,
  replyExpiresAt: null,
  inReplyTo: null,
  providerId: null,
  inboxItemId: null,
  messageId: null,
  decidedBy: null,
  decidedAt: null,
  createdAt: now,
  updatedAt: now,
  ...extra,
});
const contact = {
  projectKey: 'AR',
  handle: 'ann',
  wants: true,
  by: 'dev',
  requestedBy: 'ann',
  source: 'message' as const,
  sourceRef: 'msg_1',
  quote: 'Please email me',
  at: now,
};

describe('email channel repository', () => {
  let db: Db;
  let repo: ReturnType<typeof createRepositories>['emailChannel'];
  beforeEach(() => {
    db = openMigratedMemoryDatabase();
    repo = createRepositories(db).emailChannel;
  });
  afterEach(() => db.close());

  it('migrates an existing database without changing its stored rows', () => {
    const old = new Database(':memory:');
    try {
      const emailVersion = migrations.find((migration) => migration.name === 'email channel')!.version;
      for (const migration of migrations.filter((migration) => migration.version < emailVersion))
        old.exec(migration.sql);
      old.pragma(`user_version = ${emailVersion - 1}`);
      old
        .prepare(
          "INSERT INTO projects (key, name, config_version, created_at, updated_at) VALUES ('AR', 'Test', 'v1', ?, ?)",
        )
        .run(now, now);
      migrate(old);
      expect(old.prepare("SELECT key FROM projects WHERE key = 'AR'").get()).toEqual({ key: 'AR' });
      expect(createRepositories(old).emailChannel.contacts.list('AR')).toEqual([]);
      expect(
        old
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('email_messages', 'email_contact_events') AND name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all(),
      ).toEqual([{ name: 'email_contact_events_project' }, { name: 'email_messages_project' }]);
    } finally {
      old.close();
    }
  });
  it('upserts a contact and retains each attributed setting event', () => {
    const event = repo.contacts.set(contact);
    expect(event.id).toMatch(/^emc_/);
    repo.contacts.set({
      ...contact,
      wants: false,
      by: 'system',
      source: 'complaint',
      at: '2026-10-23T00:00:00.000Z',
    });
    expect(repo.contacts.get('AR', 'ann')).toEqual({
      projectKey: 'AR',
      handle: 'ann',
      wants: false,
      changedBy: 'system',
      changedAt: '2026-10-23T00:00:00.000Z',
      requestedBy: 'ann',
      source: 'complaint',
    });
    expect(repo.contacts.list('OTHER')).toEqual([]);
    expect(repo.contacts.get('OTHER', 'ann')).toBeNull();
    expect(repo.log('AR').entries).toEqual([
      expect.objectContaining({ kind: 'setting', wants: false, by: 'system' }),
      expect.objectContaining({
        id: event.id,
        kind: 'setting',
        wants: true,
        sourceRef: 'msg_1',
        quote: contact.quote,
      }),
    ]);
  });
  it('rolls back the contact update if writing its audit event fails', () => {
    repo.contacts.set({ ...contact, id: 'emc_duplicate' });
    expect(() => repo.contacts.set({ ...contact, id: 'emc_duplicate', wants: false })).toThrow();
    expect(repo.contacts.get('AR', 'ann')?.wants).toBe(true);
    expect(repo.log('AR').entries).toHaveLength(1);
  });
  it('round trips message metadata and updates nullable fields', () => {
    const row = repo.messages.insert(
      message({
        attachmentNames: ['report.pdf'],
        replyTokenHash: 'hash',
        providerId: 'provider_1',
        replyExpiresAt: '2026-12-21T00:00:00.000Z',
      }),
    );
    expect(row.id).toMatch(/^eml_/);
    expect(repo.messages.byTokenHash('hash')).toEqual(row);
    expect(repo.messages.byProviderId('provider_1')).toEqual(row);
    const updated = repo.messages.update(row.id, {
      status: 'failed',
      note: 'unavailable',
      inboxItemId: 'in_1',
      attachmentNames: [],
      replyTokenHash: null,
    });
    expect(updated).toMatchObject({
      status: 'failed',
      note: 'unavailable',
      attachmentNames: [],
      replyTokenHash: null,
      inboxItemId: 'in_1',
    });
    expect(repo.messages.get(row.id)).toEqual(updated);
    expect(repo.messages.byTokenHash('hash')).toBeNull();
    expect(repo.messages.get('missing')).toBeNull();
  });
  it.each(['replyTokenHash', 'providerId'] as const)('deduplicates messages by %s', (field) => {
    repo.messages.insert(message({ [field]: 'unique' }));
    expect(() => repo.messages.insert(message({ [field]: 'unique' }))).toThrow();
  });
  it('counts outbound rows by project, member or contact and time', () => {
    repo.messages.insert(message());
    repo.messages.insert(message({ direction: 'inbound', status: 'delivered' }));
    repo.messages.insert(message({ projectKey: 'OTHER' }));
    repo.messages.insert(message({ member: 'other', contact: 'other' }));
    repo.messages.insert(message({ createdAt: '2026-10-01T00:00:00.000Z' }));
    expect(repo.countOutboundSince('AR', { member: 'dev' }, now)).toBe(1);
    expect(repo.countOutboundSince('AR', { contact: 'ann' }, now)).toBe(1);
  });
  it('paginates a merged log without skipping equal timestamps and excludes other projects', () => {
    repo.contacts.set({ ...contact, id: 'emc_1' });
    repo.messages.insert(message({ id: 'eml_1' }));
    repo.messages.insert(
      message({
        id: 'eml_2',
        direction: 'inbound',
        status: 'parked',
        parkReason: 'token_invalid',
        fromAddress: 'unknown@example.org',
        attachmentNames: ['file.pdf'],
      }),
    );
    repo.messages.insert(message({ projectKey: 'OTHER' }));
    const first = repo.log('AR', null, 2);
    expect(first.entries.map((entry) => entry.id)).toEqual(['eml_2', 'eml_1']);
    expect(first.entries[0]).toMatchObject({
      kind: 'inbound',
      attachmentNames: ['file.pdf'],
      parkReason: 'token_invalid',
    });
    expect(first.entries[1]).toMatchObject({ kind: 'outbound', note: null });
    const last = repo.log('AR', first.nextCursor, 2);
    expect(last.entries.map((entry) => entry.id)).toEqual(['emc_1']);
    expect(last.nextCursor).toBeNull();
  });
  it('prunes only the text and sender address of parked inbound messages older than thirty days', () => {
    const old = '2026-09-21T00:00:00.000Z';
    const parked = repo.messages.insert(
      message({
        createdAt: old,
        direction: 'inbound',
        status: 'parked',
        fromAddress: 'unknown@example.org',
        parkReason: 'unknown_sender',
      }),
    );
    const delivered = repo.messages.insert(
      message({ createdAt: old, direction: 'inbound', status: 'delivered' }),
    );
    const outbound = repo.messages.insert(message({ createdAt: old }));
    const boundary = repo.messages.insert(
      message({ createdAt: '2026-09-22T00:00:00.000Z', direction: 'inbound', status: 'parked' }),
    );
    expect(repo.prune(now)).toBe(1);
    expect(repo.messages.get(parked.id)).toMatchObject({
      text: '',
      fromAddress: '',
      subject: 'Update',
      parkReason: 'unknown_sender',
    });
    for (const row of [delivered, outbound, boundary]) expect(repo.messages.get(row.id)?.text).toBe('Ready');
    expect(repo.prune(now)).toBe(0);
  });
});
