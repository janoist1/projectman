import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { LATEST_SCHEMA_VERSION, migrate, migrations } from '../src/db';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';

describe('the message pending index (PM-925)', () => {
  it('is dropped by the migration: the member queue is the one place a waiting message lives', () => {
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys = ON');
      const drop = migrations.find((m) => m.name === 'drop the message pending index')!;
      for (const m of migrations.filter((m) => m.version < drop.version)) db.exec(m.sql);
      db.pragma(`user_version = ${drop.version - 1}`);
      const table = () =>
        db.prepare("SELECT name FROM sqlite_master WHERE name = 'team_message_pending'").all();
      expect(table()).toHaveLength(1);
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(table()).toEqual([]);
    } finally {
      db.close();
    }
  });
});

it('keeps human reading, partial delivery, handoff and unitOfWork rollback consistent with pending counts', async () => {
  const h = await createDomainHarness();
  try {
    const record = (kind: 'info' | 'action') =>
      h.domain.messages.record({
        projectKey: 'AR',
        from: 'owner',
        to: ['dev-1', 'dev-2', 'owner'],
        taskKey: null,
        body: 'Synthetic delivery',
        actor: OWNER_ACTOR,
        humanRecipients: ['owner'],
        kind,
      });
    const info = record('info');
    const action = record('action');
    const count = () => h.domain.messageRouter.waitingForEngine('local');
    const pending = () => ['dev-1', 'dev-2'].map((handle) => h.repos.messages.pendingCount('AR', handle));
    const openItems = () =>
      ['dev-1', 'dev-2'].map((handle) =>
        h.repos.memberQueue
          .listOpen('AR', handle)
          .map((item) => item.source.id)
          .sort(),
      );
    expect(pending()).toEqual([2, 2]);
    expect(count()).toBe(4);
    h.domain.messages.markRead('AR', info.id, 'owner');
    expect(pending()).toEqual([2, 2]);
    h.domain.messages.markRecipientDelivered(info.id, 'dev-1');
    expect(pending()).toEqual([1, 2]);
    expect(count()).toBe(3);
    h.domain.messages.markRecipientForwarded(info.id, 'dev-2', 'dev-1');
    expect(pending()).toEqual([1, 1]);
    expect(count()).toBe(2);
    expect(h.repos.messages.get(info.id)?.receipts?.find((r) => r.handle === 'dev-2')?.handedOffTo).toBe(
      'dev-1',
    );
    const before = openItems();
    expect(() =>
      h.domain.ctx.unitOfWork(() => {
        h.domain.messages.markRecipientDelivered(action.id, 'dev-1');
        h.domain.messages.markRecipientForwarded(action.id, 'dev-2', 'dev-1');
        record('info');
        throw new Error('unitOfWork rollback');
      }),
    ).toThrow('unitOfWork rollback');
    expect(openItems()).toEqual(before);
    expect(pending()).toEqual([1, 1]);
    h.domain.messages.markRecipientDelivered(action.id, 'dev-1');
    h.domain.messages.markRecipientDelivered(action.id, 'dev-2');
    h.domain.messages.markRecipientDelivered(action.id, 'dev-2');
    expect(pending()).toEqual([0, 0]);
    const hydrate = vi.spyOn(h.repos.messages, 'pending').mockImplementation(() => {
      throw new Error('must count without hydration');
    });
    try {
      expect(count()).toBe(0);
    } finally {
      hydrate.mockRestore();
    }
  } finally {
    await h.cleanup();
  }
});
