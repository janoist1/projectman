import {
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  PAIRING_TTL_MS,
  PairingCodeRequest,
  canApprovePairing,
  formatPairingCode,
  normalizePairingCode,
} from '@projectman/shared';
import type { ErrorCode, PairingView } from '@projectman/shared';

export interface PairingResponse {
  status: number;
  body?: unknown;
}

/** What the device pairing needs of the fake backend (the backend implements it). */
export interface PairingHost {
  /** The logged-in user, with the rights `canApprovePairing` looks at. */
  viewer(): { userId: string; hostOwner: boolean; ownerAccount: boolean; hasPassword: boolean };
  /** Whether the request came through an integrator key (such a request never approves). */
  viaIntegrator(): boolean;
  /** The prefix of the user's live `super` integrator key, which an approval revokes; null without one. */
  liveKeyPrefix(userId: string): string | null;
  /** Makes the machine's engine and its `super` key in the user's name, as the server's approval does. */
  create(input: { machineName: string; userId: string }): { engineId: string };
}

interface Pairing {
  id: string;
  code: string;
  machineName: string;
  requestedAt: number;
  expiresAt: number;
  state: 'pending' | 'approved' | 'denied';
  decidedBy: string | null;
  decidedAt: number | null;
  engineId: string | null;
}

function failure(status: number, code: ErrorCode, message: string, details?: unknown): PairingResponse {
  return { status, body: { error: { code, message, ...(details === undefined ? {} : { details }) } } };
}

/** A code of the server's alphabet, deterministic: the first one is the plan's `WDJB-MJHT` look-alike. */
function codeAt(index: number): string {
  let value = 2_000_000_000 + index * 7_919;
  let code = '';
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    code += PAIRING_CODE_ALPHABET[value % PAIRING_CODE_ALPHABET.length];
    value = Math.floor(value / PAIRING_CODE_ALPHABET.length) + 3 * (i + 1);
  }
  return code;
}

/**
 * The fake of the device pairing (PM-1437): a test or a scenario `open`s a pairing the way a machine's
 * `pair start` does, and the three web routes answer as the server's do (the rights first, then the code;
 * a wrong, expired, used or foreign code is one `pairing_code_invalid`). The rights are the shared
 * `canApprovePairing`, the code shape the shared `normalizePairingCode`.
 */
export class MockPairing {
  /** While set, every route answers `too_many_attempts` with this many seconds to wait. */
  rateLimitedFor: number | null = null;
  /** While set, every route answers this status as a server failure (5xx). */
  serverFailure: number | null = null;
  /** Every pairing the machines asked for, in order. */
  readonly pairings: Pairing[] = [];
  private readonly host: PairingHost;

  constructor(host: PairingHost) {
    this.host = host;
  }

  /** A machine asks for a code; returns the code as the machine prints it (`XXXX-XXXX`). */
  open(machineName: string, options: { ttlMs?: number; requestedAgoMs?: number } = {}): string {
    const at = Date.now();
    const requestedAt = at - (options.requestedAgoMs ?? 0);
    const code = codeAt(this.pairings.length);
    this.pairings.push({
      id: `epr_${String(this.pairings.length + 1).padStart(16, '0')}`,
      code,
      machineName,
      requestedAt,
      expiresAt: requestedAt + (options.ttlMs ?? PAIRING_TTL_MS),
      state: 'pending',
      decidedBy: null,
      decidedAt: null,
      engineId: null,
    });
    return formatPairingCode(code);
  }

  lookup(body: unknown): PairingResponse {
    return this.act(body, (pairing, viewer) => ({ status: 200, body: this.view(pairing, viewer.userId) }));
  }

  approve(body: unknown): PairingResponse {
    return this.act(body, (pairing, viewer) => {
      if (pairing.state !== 'pending' || pairing.expiresAt <= Date.now()) return this.invalid();
      const { engineId } = this.host.create({ machineName: pairing.machineName, userId: viewer.userId });
      Object.assign(pairing, {
        state: 'approved',
        decidedBy: viewer.userId,
        decidedAt: Date.now(),
        engineId,
      });
      return { status: 200, body: this.view(pairing, viewer.userId) };
    });
  }

  deny(body: unknown): PairingResponse {
    return this.act(body, (pairing, viewer) => {
      if (pairing.state !== 'pending' || pairing.expiresAt <= Date.now()) return this.invalid();
      Object.assign(pairing, { state: 'denied', decidedBy: viewer.userId, decidedAt: Date.now() });
      return { status: 200, body: this.view(pairing, viewer.userId) };
    });
  }

  private invalid(): PairingResponse {
    return failure(404, 'pairing_code_invalid', 'This pairing code is not valid');
  }

  /** The rights, the limit and the code, in the server's order; `run` gets a pairing only its viewer may see. */
  private act(
    body: unknown,
    run: (pairing: Pairing, viewer: ReturnType<PairingHost['viewer']>) => PairingResponse,
  ): PairingResponse {
    if (this.serverFailure !== null)
      return failure(this.serverFailure, 'internal_error', 'The pairing failed');
    if (this.host.viaIntegrator())
      return failure(403, 'integrator_not_allowed', 'An integrator key cannot approve a pairing');
    const viewer = this.host.viewer();
    if (!canApprovePairing(viewer)) return failure(403, 'owner_only', 'Own owner login required');
    if (this.rateLimitedFor !== null)
      return failure(429, 'too_many_attempts', 'Too many attempts', {
        retryAfterSeconds: this.rateLimitedFor,
      });
    const input = PairingCodeRequest.safeParse(body);
    if (!input.success) return failure(400, 'invalid_request', 'Invalid pairing request');
    const code = normalizePairingCode(input.data.code);
    const pairing = code ? this.pairings.find((entry) => entry.code === code) : undefined;
    if (!pairing) return this.invalid();
    const decided = pairing.state !== 'pending';
    if (decided ? pairing.decidedBy !== viewer.userId : pairing.expiresAt <= Date.now())
      return this.invalid();
    return run(pairing, viewer);
  }

  private view(pairing: Pairing, userId: string): PairingView {
    const base = { code: formatPairingCode(pairing.code), machineName: pairing.machineName };
    if (pairing.state === 'approved')
      return {
        state: 'approved',
        ...base,
        engineId: pairing.engineId ?? '',
        decidedAt: new Date(pairing.decidedAt ?? Date.now()).toISOString(),
      };
    if (pairing.state === 'denied')
      return {
        state: 'denied',
        ...base,
        decidedAt: new Date(pairing.decidedAt ?? Date.now()).toISOString(),
      };
    return {
      state: 'pending',
      ...base,
      requestedAt: new Date(pairing.requestedAt).toISOString(),
      expiresAt: new Date(pairing.expiresAt).toISOString(),
      replacesKeyPrefix: this.host.liveKeyPrefix(userId),
    };
  }
}
