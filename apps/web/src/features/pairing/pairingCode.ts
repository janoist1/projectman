import { EmailLoginRateLimitedDetails, PAIRING_CODE_LENGTH } from '@projectman/shared';
import { isApiError } from '../../api/client';

/** The wait when a 429 comes without its `retryAfterSeconds`. */
const DEFAULT_WAIT_SECONDS = 60;

/** What a typed code looks like in the field: upper case, a hyphen after the first half, no more than the code holds. */
export function formatTypedCode(raw: string): string {
  const letters = raw.toUpperCase().replace(/[-\s]/g, '').slice(0, PAIRING_CODE_LENGTH);
  const half = PAIRING_CODE_LENGTH / 2;
  return letters.length > half ? `${letters.slice(0, half)}-${letters.slice(half)}` : letters;
}

/** The code read out letter by letter, for a screen reader (`W D J B  M J H T`). */
export function spelledCode(formatted: string): string {
  return formatted
    .split('-')
    .map((half) => [...half].join(' '))
    .join('  ');
}

/** How a failed call reads for the page; the page decides what each kind shows. */
export type PairingFailure =
  | { kind: 'invalid' }
  | { kind: 'limit'; seconds: number }
  | { kind: 'no_right' }
  | { kind: 'failed'; error: unknown };

export function classifyFailure(error: unknown): PairingFailure {
  if (isApiError(error)) {
    if (error.code === 'pairing_code_invalid') return { kind: 'invalid' };
    if (error.code === 'owner_only') return { kind: 'no_right' };
    if (error.status === 429) {
      const details = EmailLoginRateLimitedDetails.safeParse(error.details);
      return {
        kind: 'limit',
        seconds: details.success ? details.data.retryAfterSeconds : DEFAULT_WAIT_SECONDS,
      };
    }
  }
  return { kind: 'failed', error };
}
