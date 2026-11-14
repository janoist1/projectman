import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import {
  canApprovePairing,
  formatPairingCode,
  normalizePairingCode,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  PAIRING_KEY_DAYS,
  PAIRING_POLL_SECONDS,
  PAIRING_TTL_MS,
} from '@projectman/shared';
import type {
  EnginePairingStatus,
  PairingView,
  StartEnginePairingRequest,
  StartEnginePairingResponse,
} from '@projectman/shared';
import type { EnginePairingRecord, Repositories } from '../db';
import { createAttemptLimiter, DomainError, forbidden, invalid } from '../kernel';

/** Pairing starts per machine address and window, all machines together, and the pending ones at once. */
const MAX_STARTS = 10;
const MAX_STARTS_ALL = 30;
const MAX_LIVE_PENDING = 20;
/** Wrong codes on the web per user and per address and window, all clients together. */
const MAX_WRONG_CODES = 10;
const MAX_WRONG_CODES_ALL = 50;
const WINDOW_MS = 15 * 60_000;
/** A pending pairing this long past its expiry is deleted at the next start; its machine polls `expired` until then. */
const PRUNE_AFTER_MS = 24 * 60 * 60_000;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** The approver's account, as `canApprovePairing` reads it. */
export interface PairingApprover {
  userId: string;
  address: string;
}

export interface EnginePairingDeps {
  repos: Pick<Repositories, 'enginePairings' | 'engines' | 'integratorKeys' | 'users' | 'transaction'>;
  auth: {
    isHostOwner(userId: string): boolean;
    isOwnerAccount(userId: string): boolean;
    hasPassword(userId: string): boolean;
    createPairedKey(input: {
      userId: string;
      tokenHash: string;
      prefix: string;
      expiresInDays: number;
      pairingId: string;
    }): { key: { id: string }; announce: () => void };
  };
  engines: {
    createPaired(input: {
      name: string;
      userId: string;
      keyHash: string;
      keyPrefix: string;
      pairingId: string;
    }): { engine: { id: string }; announce: () => void };
  };
  log: { info(fields: Record<string, unknown>, message: string): void };
  now?: () => Date;
}

export type EnginePairingService = ReturnType<typeof createEnginePairingService>;

const codeInvalid = () =>
  new DomainError('pairing_code_invalid', 'the pairing code is mistyped, expired or already used', {
    status: 404,
  });

/**
 * Device pairing on the hub (PM-1437): a machine that has made its own machine key and integrator key asks for a
 * pairing with their hashes, shows its owner a short code, and polls until the owner approves the code on the web;
 * the approval makes the engine and the integrator key from the hashes in one transaction. The keys never reach the
 * hub, only their hashes and display prefixes.
 */
export function createEnginePairingService(deps: EnginePairingDeps) {
  const { repos, auth, engines, log } = deps;
  const now = deps.now ?? (() => new Date());
  const ms = () => now().getTime();
  const starts = createAttemptLimiter({
    max: MAX_STARTS,
    sharedMax: MAX_STARTS_ALL,
    windowMs: WINDOW_MS,
    message: 'too many pairing requests; try again later',
    now: ms,
  });
  const wrongByUser = createAttemptLimiter({
    max: MAX_WRONG_CODES,
    windowMs: WINDOW_MS,
    message: 'too many wrong pairing codes; try again later',
    now: ms,
  });
  const wrongByAddress = createAttemptLimiter({
    max: MAX_WRONG_CODES,
    sharedMax: MAX_WRONG_CODES_ALL,
    windowMs: WINDOW_MS,
    message: 'too many wrong pairing codes; try again later',
    now: ms,
  });

  /** The pairing whose machine key this bearer header carries; null for any mismatch. */
  const machinePairing = (id: string, authorization: string | undefined): EnginePairingRecord | null => {
    const key = authorization?.match(/^Bearer (pme_[A-Za-z0-9_-]{43})$/)?.[1];
    if (!key) return null;
    const row = repos.enginePairings.findById(id);
    if (!row) return null;
    const given = Buffer.from(sha256(key), 'hex');
    const stored = Buffer.from(row.machineKeyHash, 'hex');
    return given.length === stored.length && timingSafeEqual(given, stored) ? row : null;
  };

  const newCode = () =>
    Array.from(
      { length: PAIRING_CODE_LENGTH },
      () => PAIRING_CODE_ALPHABET[randomInt(PAIRING_CODE_ALPHABET.length)],
    ).join('');

  const decidedView = (row: EnginePairingRecord, code: string): PairingView =>
    row.state === 'approved'
      ? {
          state: 'approved',
          code: formatPairingCode(code),
          machineName: row.machineName,
          engineId: row.engineId ?? '',
          decidedAt: row.decidedAt ?? '',
        }
      : {
          state: 'denied',
          code: formatPairingCode(code),
          machineName: row.machineName,
          decidedAt: row.decidedAt ?? '',
        };

  /**
   * Runs a web request about a code: the right first, so a missing right tells nothing about the code; then the
   * wrong-code budgets, reserved before the lookup and given back when `work` found the pairing.
   */
  const withCode = <T>(
    approver: PairingApprover,
    rawCode: string,
    work: (code: string, hash: string) => T,
  ): T => {
    if (
      !canApprovePairing({
        hostOwner: auth.isHostOwner(approver.userId),
        ownerAccount: auth.isOwnerAccount(approver.userId),
        hasPassword: auth.hasPassword(approver.userId),
      })
    )
      throw forbidden('owner_only', 'only an owner with a password may approve a device pairing');
    const releaseUser = wrongByUser.reserve(approver.userId);
    let releaseAddress: () => void;
    try {
      releaseAddress = wrongByAddress.reserve(approver.address);
    } catch (err) {
      releaseUser();
      throw err;
    }
    const code = normalizePairingCode(rawCode);
    if (!code) throw codeInvalid();
    const result = work(code, sha256(code));
    releaseUser();
    releaseAddress();
    return result;
  };

  return {
    start(body: StartEnginePairingRequest, address: string): StartEnginePairingResponse {
      const at = now();
      repos.enginePairings.prune(new Date(at.getTime() - PRUNE_AFTER_MS).toISOString());
      const live = repos.enginePairings.livePending(at.toISOString());
      if (live.count >= MAX_LIVE_PENDING) {
        const wait = live.firstExpiry ? Date.parse(live.firstExpiry) - at.getTime() : WINDOW_MS;
        throw new DomainError('too_many_attempts', 'too many pairings are waiting; try again later', {
          status: 429,
          details: { retryAfterSeconds: Math.max(1, Math.ceil(wait / 1000)) },
        });
      }
      starts.reserve(address);
      if (
        body.machineKey.hash === body.integratorKey.hash ||
        repos.enginePairings.keyHashKnown(body.machineKey.hash, body.integratorKey.hash)
      )
        throw invalid('invalid_request', 'the request is invalid: make new keys and start again');
      const id = `epr_${randomBytes(8).toString('hex')}`;
      const expiresAt = new Date(at.getTime() + PAIRING_TTL_MS).toISOString();
      for (let attempt = 0; ; attempt += 1) {
        const code = newCode();
        try {
          repos.enginePairings.insert({
            id,
            codeHash: sha256(code),
            machineName: body.name,
            machineKeyHash: body.machineKey.hash,
            machineKeyPrefix: body.machineKey.prefix,
            integratorKeyHash: body.integratorKey.hash,
            integratorKeyPrefix: body.integratorKey.prefix,
            requestedAt: at.toISOString(),
            expiresAt,
          });
          return { id, code: formatPairingCode(code), expiresAt, pollIntervalSeconds: PAIRING_POLL_SECONDS };
        } catch (err) {
          // A pending pairing holds the same code: draw again (one in hundreds of millions while 20 wait).
          const unique = (err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE';
          if (!unique || attempt >= 4) throw err;
        }
      }
    },

    /** The pairing as its machine polls it; null (404) for an unknown id or a key that is not the machine's. */
    poll(id: string, authorization: string | undefined): EnginePairingStatus | null {
      const row = machinePairing(id, authorization);
      if (!row) return null;
      if (row.state === 'pending')
        return row.expiresAt > now().toISOString()
          ? { state: 'pending', expiresAt: row.expiresAt }
          : { state: 'expired' };
      if (row.state === 'denied') return { state: 'denied' };
      if (row.state === 'cancelled') return { state: 'cancelled' };
      const approver = row.decidedBy ? repos.users.get(row.decidedBy) : null;
      const engine = row.engineId ? repos.engines.get(row.engineId) : null;
      const keyExpiresAt = row.integratorKeyId ? repos.integratorKeys.expiresAt(row.integratorKeyId) : null;
      if (!approver || !engine || !keyExpiresAt) return null;
      return {
        state: 'approved',
        engineId: engine.id,
        engineName: engine.name,
        approvedBy: { name: approver.name, email: approver.email },
        integratorKeyExpiresAt: keyExpiresAt,
      };
    },

    /** Cancels the machine's pending pairing; false (404) for an unknown id or a key that is not the machine's. */
    cancel(id: string, authorization: string | undefined): boolean {
      const row = machinePairing(id, authorization);
      if (!row) return false;
      repos.enginePairings.cancel(row.id);
      return true;
    },

    /** A pending pairing before its expiry; a decided one only to its decider. */
    lookup(approver: PairingApprover, rawCode: string): PairingView {
      return withCode(approver, rawCode, (code, hash) => {
        const at = now().toISOString();
        const pending = repos.enginePairings.findPendingByCodeHash(hash, at);
        if (pending)
          return {
            state: 'pending',
            code: formatPairingCode(code),
            machineName: pending.machineName,
            requestedAt: pending.requestedAt,
            expiresAt: pending.expiresAt,
            replacesKeyPrefix: repos.integratorKeys.activeSuper(approver.userId, at)?.prefix ?? null,
          };
        const decided = repos.enginePairings.findDecidedByCodeHash(hash, approver.userId);
        if (!decided) throw codeInvalid();
        return decidedView(decided, code);
      });
    },

    /**
     * Approves the code's pending pairing in one transaction: the decision, the integrator key (which revokes the
     * approver's previous live `super` key) and the engine, all in the approver's name; any failure leaves the
     * pairing pending. The same approval again shows the approved pairing.
     */
    approve(approver: PairingApprover, rawCode: string): PairingView {
      return withCode(approver, rawCode, (code, hash) => {
        const at = now().toISOString();
        const made = repos.transaction(() => {
          const row = repos.enginePairings.decide(hash, 'approved', approver.userId, at);
          if (!row) return null;
          const key = auth.createPairedKey({
            userId: approver.userId,
            tokenHash: row.integratorKeyHash,
            prefix: row.integratorKeyPrefix,
            expiresInDays: PAIRING_KEY_DAYS,
            pairingId: row.id,
          });
          const engine = engines.createPaired({
            name: row.machineName,
            userId: approver.userId,
            keyHash: row.machineKeyHash,
            keyPrefix: row.machineKeyPrefix,
            pairingId: row.id,
          });
          repos.enginePairings.setResult(row.id, engine.engine.id, key.key.id);
          return { row, key, engine };
        });
        if (!made) {
          const decided = repos.enginePairings.findDecidedByCodeHash(hash, approver.userId);
          if (decided?.state !== 'approved') throw codeInvalid();
          return decidedView(decided, code);
        }
        made.key.announce();
        made.engine.announce();
        log.info(
          {
            pairingId: made.row.id,
            engineId: made.engine.engine.id,
            keyPrefix: made.row.integratorKeyPrefix,
            machineName: made.row.machineName,
            userId: approver.userId,
          },
          'Engine pairing approved',
        );
        return decidedView(
          { ...made.row, engineId: made.engine.engine.id, integratorKeyId: made.key.key.id },
          code,
        );
      });
    },

    /** Denies the code's pending pairing; the same denial again shows the denied pairing. */
    deny(approver: PairingApprover, rawCode: string): PairingView {
      return withCode(approver, rawCode, (code, hash) => {
        const row = repos.enginePairings.decide(hash, 'denied', approver.userId, now().toISOString());
        if (!row) {
          const decided = repos.enginePairings.findDecidedByCodeHash(hash, approver.userId);
          if (decided?.state !== 'denied') throw codeInvalid();
          return decidedView(decided, code);
        }
        log.info(
          { pairingId: row.id, machineName: row.machineName, userId: approver.userId },
          'Engine pairing denied',
        );
        return decidedView(row, code);
      });
    },
  };
}
