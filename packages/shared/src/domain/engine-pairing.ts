import { canHoldIntegratorKey } from '../config/integrator';
import { canCreateEngine } from './owner-account';

/**
 * Device pairing of a friend's machine (PM-1437): the machine asks the hub for a short code, its owner approves
 * the code in the web app, and the hub makes the engine and the `super` integrator key from the hashes the
 * machine sent. The code uses the RFC 8628 alphabet: 20 consonants, no vowel (it spells no word), no 0/O or 1/I.
 */
export const PAIRING_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
export const PAIRING_CODE_LENGTH = 8;
/** How long a code may be approved after the machine asked for it. */
export const PAIRING_TTL_MS = 10 * 60_000;
/** How long the integrator key of an approved pairing lives (the owner's decision: no choice). */
export const PAIRING_KEY_DAYS = 365;
/** How often the machine asks for the pairing's state. */
export const PAIRING_POLL_SECONDS = 3;

const CODE_SHAPE = new RegExp(`^[${PAIRING_CODE_ALPHABET}]{${PAIRING_CODE_LENGTH}}$`);

/**
 * The code as it is stored and compared: upper case, without hyphens and spaces; null unless that leaves exactly
 * `PAIRING_CODE_LENGTH` letters of the alphabet.
 */
export function normalizePairingCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[-\s]/g, '');
  return CODE_SHAPE.test(code) ? code : null;
}

/** The code as people read it: `XXXX-XXXX`. */
export function formatPairingCode(code: string): string {
  const half = PAIRING_CODE_LENGTH / 2;
  return `${code.slice(0, half)}-${code.slice(half)}`;
}

/**
 * Whether the account may approve a pairing: it gets an engine (`canCreateEngine`) and a `super` integrator key
 * (`canHoldIntegratorKey`) at once, so it needs both rights.
 */
export function canApprovePairing(input: {
  hostOwner: boolean;
  ownerAccount: boolean;
  hasPassword: boolean;
}): boolean {
  return (
    canCreateEngine({ isHostOwner: input.hostOwner, isOwnerAccount: input.ownerAccount }) &&
    canHoldIntegratorKey(input)
  );
}
