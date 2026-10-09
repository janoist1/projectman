import type { EngineId } from '@projectman/shared';
import type { Db } from './database';

export interface EngineRecord {
  id: EngineId;
  name: string;
  key_hash: string;
  key_prefix: string;
  is_default: number;
  created_by: string;
  created_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
  last_seen_at: string | null;
  last_seen_ip: string | null;
  last_hello: string | null;
  creator_name: string;
}

export function createEngineRepository(db: Db) {
  const select =
    'SELECT engines.*, users.name AS creator_name FROM engines JOIN users ON users.id = engines.created_by';
  const get = (id: string): EngineRecord | null =>
    (db.prepare(`${select} WHERE engines.id = ?`).get(id) as EngineRecord | undefined) ?? null;
  return {
    get,
    list(): EngineRecord[] {
      return db.prepare(`${select} ORDER BY engines.rowid`).all() as EngineRecord[];
    },
    resolve(hash: string): EngineRecord | null {
      return (
        (db.prepare(`${select} WHERE key_hash = ? AND revoked_at IS NULL`).get(hash) as
          EngineRecord | undefined) ?? null
      );
    },
    create(input: {
      id: EngineId;
      name: string;
      hash: string;
      prefix: string;
      userId: string;
      at: string;
    }): EngineRecord {
      return db.transaction(() => {
        // Only the first engine ever created becomes default; revoking it does not elect another.
        const first = (db.prepare('SELECT COUNT(*) AS n FROM engines').get() as { n: number }).n === 0;
        db.prepare(
          'INSERT INTO engines (id, name, key_hash, key_prefix, is_default, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).run(input.id, input.name, input.hash, input.prefix, first ? 1 : 0, input.userId, input.at);
        return get(input.id)!;
      })();
    },
    revoke(id: string, userId: string, at: string): void {
      db.prepare(
        'UPDATE engines SET revoked_at = ?, revoked_by = ?, is_default = 0 WHERE id = ? AND revoked_at IS NULL',
      ).run(at, userId, id);
    },
    setDefault(id: string): void {
      db.transaction(() => {
        db.prepare('UPDATE engines SET is_default = 0 WHERE is_default = 1').run();
        db.prepare('UPDATE engines SET is_default = 1 WHERE id = ? AND revoked_at IS NULL').run(id);
      })();
    },
    seen(id: string, at: string, ip: string, hello?: string): void {
      db.prepare(
        'UPDATE engines SET last_seen_at = ?, last_seen_ip = ?, last_hello = COALESCE(?, last_hello) WHERE id = ? AND revoked_at IS NULL',
      ).run(at, ip, hello ?? null, id);
    },
    hello(id: string, hello: string): void {
      db.prepare('UPDATE engines SET last_hello = ? WHERE id = ? AND revoked_at IS NULL').run(hello, id);
    },
  };
}
