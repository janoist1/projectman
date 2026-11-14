import { z } from 'zod';

/** A SHA-256 hash in lower-case hex: the hub stores only this of a key the machine made (PM-1437). */
const KeyHash = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * The machine's pairing request (`POST /engine/pairings`): its name and the hashes and display prefixes of the
 * machine key and the integrator key it made. The prefixes are as long as the hub's own (`pme_` + 6, `pmi_` + 8).
 */
export const StartEnginePairingRequest = z.strictObject({
  name: z.string().trim().min(1).max(64),
  machineKey: z.strictObject({ hash: KeyHash, prefix: z.string().regex(/^pme_[A-Za-z0-9_-]{6}$/) }),
  integratorKey: z.strictObject({ hash: KeyHash, prefix: z.string().regex(/^pmi_[A-Za-z0-9_-]{8}$/) }),
});
export type StartEnginePairingRequest = z.infer<typeof StartEnginePairingRequest>;

export const StartEnginePairingResponse = z.object({
  /** `epr_` and 16 hex digits. */
  id: z.string(),
  /** `XXXX-XXXX`. */
  code: z.string(),
  expiresAt: z.string(),
  pollIntervalSeconds: z.number().int().positive(),
});
export type StartEnginePairingResponse = z.infer<typeof StartEnginePairingResponse>;

/** The pairing as its machine polls it (`GET /engine/pairings/:id`). */
export const EnginePairingStatus = z.discriminatedUnion('state', [
  z.object({ state: z.literal('pending'), expiresAt: z.string() }),
  z.object({
    state: z.literal('approved'),
    engineId: z.string(),
    engineName: z.string(),
    approvedBy: z.object({ name: z.string(), email: z.string() }),
    integratorKeyExpiresAt: z.string(),
  }),
  z.object({ state: z.literal('denied') }),
  z.object({ state: z.literal('expired') }),
  z.object({ state: z.literal('cancelled') }),
]);
export type EnginePairingStatus = z.infer<typeof EnginePairingStatus>;

/** The body of the web's lookup, approve and deny: the code in the body, never in the URL. */
export const PairingCodeRequest = z.strictObject({ code: z.string().min(1).max(32) });
export type PairingCodeRequest = z.infer<typeof PairingCodeRequest>;

/** The pairing as the approving owner sees it. A decided one only its decider sees. */
export const PairingView = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('pending'),
    code: z.string(),
    machineName: z.string(),
    requestedAt: z.string(),
    expiresAt: z.string(),
    /** The prefix of the viewer's live `super` key that an approval revokes; null when they have none. */
    replacesKeyPrefix: z.string().nullable(),
  }),
  z.object({
    state: z.literal('approved'),
    code: z.string(),
    machineName: z.string(),
    engineId: z.string(),
    decidedAt: z.string(),
  }),
  z.object({ state: z.literal('denied'), code: z.string(), machineName: z.string(), decidedAt: z.string() }),
]);
export type PairingView = z.infer<typeof PairingView>;
