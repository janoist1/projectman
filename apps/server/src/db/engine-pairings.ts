import type { Db } from './database';

export type EnginePairingState = 'pending' | 'approved' | 'denied' | 'cancelled';

/**
 * One device pairing (PM-1437). Only hashes of the code and the keys are stored; the keys themselves stay on the
 * machine that made them. A pending row past `expiresAt` is expired.
 */
export interface EnginePairingRecord {
  id: string;
  codeHash: string;
  machineName: string;
  machineKeyHash: string;
  machineKeyPrefix: string;
  integratorKeyHash: string;
  integratorKeyPrefix: string;
  requestedAt: string;
  expiresAt: string;
  state: EnginePairingState;
  decidedBy: string | null;
  decidedAt: string | null;
  engineId: string | null;
  integratorKeyId: string | null;
}

interface PairingRow {
  id: string;
  code_hash: string;
  machine_name: string;
  machine_key_hash: string;
  machine_key_prefix: string;
  integrator_key_hash: string;
  integrator_key_prefix: string;
  requested_at: string;
  expires_at: string;
  state: EnginePairingState;
  decided_by: string | null;
  decided_at: string | null;
  engine_id: string | null;
  integrator_key_id: string | null;
}

const toRecord = (r: PairingRow): EnginePairingRecord => ({
  id: r.id,
  codeHash: r.code_hash,
  machineName: r.machine_name,
  machineKeyHash: r.machine_key_hash,
  machineKeyPrefix: r.machine_key_prefix,
  integratorKeyHash: r.integrator_key_hash,
  integratorKeyPrefix: r.integrator_key_prefix,
  requestedAt: r.requested_at,
  expiresAt: r.expires_at,
  state: r.state,
  decidedBy: r.decided_by,
  decidedAt: r.decided_at,
  engineId: r.engine_id,
  integratorKeyId: r.integrator_key_id,
});

const orNull = (row: unknown): EnginePairingRecord | null => (row ? toRecord(row as PairingRow) : null);

export function createEnginePairingRepository(db: Db) {
  return {
    /** Inserts a pending pairing; throws a unique-constraint error when a pending row holds the same code hash. */
    insert(
      input: Omit<EnginePairingRecord, 'state' | 'decidedBy' | 'decidedAt' | 'engineId' | 'integratorKeyId'>,
    ) {
      db.prepare(
        `INSERT INTO engine_pairings (id, code_hash, machine_name, machine_key_hash, machine_key_prefix,
           integrator_key_hash, integrator_key_prefix, requested_at, expires_at, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      ).run(
        input.id,
        input.codeHash,
        input.machineName,
        input.machineKeyHash,
        input.machineKeyPrefix,
        input.integratorKeyHash,
        input.integratorKeyPrefix,
        input.requestedAt,
        input.expiresAt,
      );
    },
    findById(id: string): EnginePairingRecord | null {
      return orNull(db.prepare('SELECT * FROM engine_pairings WHERE id = ?').get(id));
    },
    /** The pending pairing of the code that has not expired at `at`, or null. */
    findPendingByCodeHash(codeHash: string, at: string): EnginePairingRecord | null {
      return orNull(
        db
          .prepare(
            `SELECT * FROM engine_pairings WHERE code_hash = ? AND state = 'pending' AND expires_at > ?`,
          )
          .get(codeHash, at),
      );
    },
    /** The latest pairing of the code that `userId` approved or denied, or null. */
    findDecidedByCodeHash(codeHash: string, userId: string): EnginePairingRecord | null {
      return orNull(
        db
          .prepare(
            `SELECT * FROM engine_pairings WHERE code_hash = ? AND decided_by = ? AND state IN ('approved', 'denied')
             ORDER BY decided_at DESC, rowid DESC LIMIT 1`,
          )
          .get(codeHash, userId),
      );
    },
    /**
     * Decides the live pending pairing of the code (compare-and-set): the one write that may turn it, so two
     * decisions at once never both win. Null when no live pending pairing has the code.
     */
    decide(
      codeHash: string,
      state: 'approved' | 'denied',
      userId: string,
      at: string,
    ): EnginePairingRecord | null {
      return orNull(
        db
          .prepare(
            `UPDATE engine_pairings SET state = ?, decided_by = ?, decided_at = ?
             WHERE code_hash = ? AND state = 'pending' AND expires_at > ? RETURNING *`,
          )
          .get(state, userId, at, codeHash, at),
      );
    },
    /** What an approval made: the engine and the integrator key. */
    setResult(id: string, engineId: string, integratorKeyId: string): void {
      db.prepare('UPDATE engine_pairings SET engine_id = ?, integrator_key_id = ? WHERE id = ?').run(
        engineId,
        integratorKeyId,
        id,
      );
    },
    /** Cancels a pending pairing; a decided one stays as it is. */
    cancel(id: string): void {
      db.prepare(`UPDATE engine_pairings SET state = 'cancelled' WHERE id = ? AND state = 'pending'`).run(id);
    },
    /** Deletes the pending pairings that expired before `before` and the cancelled ones; decided rows stay. */
    prune(before: string): void {
      db.prepare(
        `DELETE FROM engine_pairings WHERE state = 'cancelled' OR (state = 'pending' AND expires_at < ?)`,
      ).run(before);
    },
    /** The pending pairings that have not expired at `at`, and the earliest of their expiries. */
    livePending(at: string): { count: number; firstExpiry: string | null } {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS n, MIN(expires_at) AS first FROM engine_pairings WHERE state = 'pending' AND expires_at > ?`,
        )
        .get(at) as { n: number; first: string | null };
      return { count: row.n, firstExpiry: row.first };
    },
    /**
     * Whether either hash already belongs to an engine, an integrator key or a pending pairing: a machine never
     * pairs with a key the hub knows.
     */
    keyHashKnown(machineKeyHash: string, integratorKeyHash: string): boolean {
      const row = db
        .prepare(
          `SELECT EXISTS (SELECT 1 FROM engines WHERE key_hash = @machine)
             OR EXISTS (SELECT 1 FROM integrator_keys WHERE token_hash = @integrator)
             OR EXISTS (SELECT 1 FROM engine_pairings WHERE state = 'pending'
               AND (machine_key_hash IN (@machine, @integrator) OR integrator_key_hash IN (@machine, @integrator)))
           AS known`,
        )
        .get({ machine: machineKeyHash, integrator: integratorKeyHash }) as { known: number };
      return row.known === 1;
    },
  };
}
