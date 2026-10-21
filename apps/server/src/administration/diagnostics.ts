import { MAX_DIAGNOSTIC_ENTRIES, MAX_DIAGNOSTIC_MESSAGE } from '../contracts';
import type { DiagnosticLevel, DiagnosticLogEntry } from '../contracts';

/**
 * The supervisor's diagnostics (PM-763). A line is made only from a known code and a few allowed scalar fields;
 * the journal is written through `journalLine` (no free text can enter it) and read through `readDiagnostics`,
 * which keeps the same rule on the way out: a line that is not one of ours, a code we do not know or a field we
 * did not allow never reaches a caller. No transcript, environment, argv, configuration secret or raw exception
 * is ever part of a message.
 */

/** The only codes a line may carry, with the level each has (the line's own level is ignored). */
export const DIAGNOSTIC_CODES = {
  supervisor_started: 'info',
  submit_accepted: 'info',
  submit_duplicate: 'info',
  submit_refused: 'warn',
  operation_started: 'info',
  restart_requested: 'info',
  restart_confirmed: 'info',
  restart_failed: 'error',
  operation_succeeded: 'info',
  operation_failed: 'error',
  operation_unknown: 'warn',
  service_probe_failed: 'warn',
  cleanup_finished: 'info',
} as const satisfies Record<string, DiagnosticLevel>;
export type DiagnosticCode = keyof typeof DIAGNOSTIC_CODES;

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_TOKEN = /^[a-z][a-z0-9_]{0,63}$/;
const BOOT_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Allowed fields and the check each value passes; a value that fails is left out, never repaired. */
const FIELD_CHECKS = {
  operationId: (value) => typeof value === 'string' && SAFE_ID.test(value),
  kind: (value) => typeof value === 'string' && SAFE_TOKEN.test(value),
  state: (value) => typeof value === 'string' && SAFE_TOKEN.test(value),
  errorCode: (value) => typeof value === 'string' && SAFE_TOKEN.test(value),
  outcome: (value) => typeof value === 'string' && SAFE_TOKEN.test(value),
  bootId: (value) => typeof value === 'string' && BOOT_ID.test(value),
  exitCode: (value) => typeof value === 'number' && Number.isInteger(value) && Math.abs(value) < 2 ** 31,
  durationMs: (value) =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 2 ** 40,
  // The counts of a process cleanup (PM-886): numbers only, never a process id, name or argument.
  found: (value) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 2 ** 20,
  stopped: (value) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 2 ** 20,
  remaining: (value) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 2 ** 20,
} as const satisfies Record<string, (value: unknown) => boolean>;
export type DiagnosticField = keyof typeof FIELD_CHECKS;
export type DiagnosticFields = Partial<Record<DiagnosticField, string | number>>;

const MAX_RAW_LINE = 4096;
const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;

const isCode = (value: unknown): value is DiagnosticCode =>
  typeof value === 'string' && Object.hasOwn(DIAGNOSTIC_CODES, value);

function cleanFields(raw: unknown): DiagnosticFields {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: DiagnosticFields = {};
  for (const name of Object.keys(FIELD_CHECKS) as DiagnosticField[]) {
    const value = (raw as Record<string, unknown>)[name];
    if (value !== undefined && FIELD_CHECKS[name](value)) out[name] = value as string | number;
  }
  return out;
}

/** The text a journal line shows: the code, then `name=value` for the allowed fields in a fixed order. */
function messageOf(code: DiagnosticCode, fields: DiagnosticFields): string {
  const parts: string[] = [code];
  for (const name of Object.keys(FIELD_CHECKS) as DiagnosticField[]) {
    const value = fields[name];
    if (value !== undefined) parts.push(`${name}=${value}`);
  }
  return parts.join(' ').slice(0, MAX_DIAGNOSTIC_MESSAGE);
}

/** One journal line (without the newline) for a known code; the fields are filtered the same way as on reading. */
export function journalLine(at: string, code: DiagnosticCode, fields: DiagnosticFields = {}): string {
  return JSON.stringify({ at, code, fields: cleanFields(fields) });
}

/** One raw line as a caller may see it, or null when the line is not one of ours. */
export function parseDiagnosticLine(raw: string): DiagnosticLogEntry | null {
  if (raw.length === 0 || raw.length > MAX_RAW_LINE) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const { at, code, fields } = parsed as Record<string, unknown>;
  if (typeof at !== 'string' || at.length > 40 || !ISO.test(at) || !isCode(code)) return null;
  return { at, level: DIAGNOSTIC_CODES[code], code, message: messageOf(code, cleanFields(fields)) };
}

/** The newest `limit` entries (oldest first) of a journal's text; at most `MAX_DIAGNOSTIC_ENTRIES`. */
export function readDiagnostics(text: string, limit: number): DiagnosticLogEntry[] {
  const wanted = Math.max(0, Math.min(limit, MAX_DIAGNOSTIC_ENTRIES));
  const entries: DiagnosticLogEntry[] = [];
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0 && entries.length < wanted; index -= 1) {
    const entry = parseDiagnosticLine(lines[index]!);
    if (entry) entries.push(entry);
  }
  return entries.reverse();
}
