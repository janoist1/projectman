/**
 * The redaction every line of the managed service's log passes before it leaves the supervisor (PM-886).
 * A secret-shaped value becomes `[redacted]`; the filters (`contains`) run on the redacted line, so a caller
 * cannot probe for a secret by searching for it.
 */

export const REDACTED = '[redacted]';

/** Longer than this, a run of hex or base64 characters is taken for a key, a digest or a token. */
const LONG_RUN = 32;

const PATTERNS: Array<[RegExp, string]> = [
  [/\bpmk_[A-Za-z0-9_-]+/g, REDACTED],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{8,}/g, REDACTED],
  // token=…, api_key=…, password=… (a quoted value may hold spaces).
  [/\b([A-Za-z0-9_.-]*(?:token|key|password))=("[^"]*"|'[^']*'|[^\s&;,"']+)/gi, `$1=${REDACTED}`],
  // The JSON form of the same: "token":"…".
  [/"([A-Za-z0-9_.-]*(?:token|key|password))"\s*:\s*"[^"]*"/gi, `"$1":"${REDACTED}"`],
  [new RegExp(`\\b[0-9a-fA-F]{${LONG_RUN + 1},}\\b`, 'g'), REDACTED],
];

const BASE64_RUN = new RegExp(`[A-Za-z0-9+/_-]{${LONG_RUN + 1},}={0,2}`, 'g');

export function redactLine(line: string): string {
  let out = line;
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  // A long base64-looking run needs a digit and a letter, so a long path or a word stays readable.
  return out.replace(BASE64_RUN, (run) => (/\d/.test(run) && /[A-Za-z]/.test(run) ? REDACTED : run));
}
