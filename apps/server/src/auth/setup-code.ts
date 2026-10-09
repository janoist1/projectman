import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const CODE_LENGTH = 12;

/** Wrong codes the server tolerates; the code is void after this many, until the server restarts. */
export const MAX_SETUP_CODE_FAILURES = 10;

/** A 12-character base32 code in groups of four (60 bits): XXXX-XXXX-XXXX. */
export function generateSetupCode(random: (size: number) => Buffer = randomBytes): string {
  // 32 divides 256, so masking a random byte to five bits is unbiased.
  const bytes = random(CODE_LENGTH);
  const chars = Array.from(bytes, (byte) => BASE32[byte & 31]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
}

/** Case, dashes and spaces do not matter when a person types the code from the log. */
function normalize(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}

function digest(code: string): Buffer {
  return createHash('sha256').update(normalize(code)).digest();
}

export type SetupCodeResult = 'ok' | 'wrong' | 'void';

/**
 * The one-time code that lets the first setup come from a non-local request in cloud mode
 * (PM-317). It lives in memory only: a restart makes a new one. Ten wrong tries (all clients
 * together) void it, and a successful setup consumes it.
 */
export interface SetupCode {
  /** The code, for the server log; null once it is consumed or void. */
  readonly value: string | null;
  /** True while a try can still succeed. */
  active(): boolean;
  /** Compares in constant time; a wrong try counts, and the tenth voids the code. */
  verify(candidate: string): SetupCodeResult;
  /** The setup succeeded: the code is gone. */
  consume(): void;
}

export function createSetupCode(opts: { code?: string; maxFailures?: number } = {}): SetupCode {
  const maxFailures = opts.maxFailures ?? MAX_SETUP_CODE_FAILURES;
  let code: string | null = opts.code ?? generateSetupCode();
  let expected: Buffer | null = digest(code);
  let failures = 0;

  const clear = (): void => {
    code = null;
    expected = null;
  };

  return {
    get value() {
      return code;
    },
    active: () => expected !== null,
    verify(candidate) {
      if (!expected) return 'void';
      // Equal-length digests, so the comparison takes the same time whatever was typed.
      if (timingSafeEqual(expected, digest(candidate))) return 'ok';
      failures += 1;
      if (failures >= maxFailures) clear();
      return 'wrong';
    },
    consume: clear,
  };
}
