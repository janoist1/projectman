import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { JournalStore } from './journal';
import { FAILURES } from './messages';
import type { JournalFailureCode } from './journal';
import { watcherState } from './service';
import type { WatcherDeps } from './service';

/**
 * `npm run release -- status` (PM-751): one JSON object, secret-free by construction. It is built only from the
 * launchd state, the journal's release id and phase, and the last failure's code with a fixed or sanitized text;
 * no path, no host, no raw error and no id of the cloud ever reaches it.
 */

const LAST_ERROR_FILE = 'last-error.json';
const MESSAGE_LIMIT = 200;

interface LastError {
  code: string;
  message: string;
}

interface WatcherStatus {
  installed: boolean;
  loaded: boolean;
  running: boolean;
  releaseId: string | null;
  phase: string | null;
  lastError: LastError | null;
}

const lastErrorSchema = z.strictObject({
  code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  message: z.string().max(MESSAGE_LIMIT),
  at: z.iso.datetime(),
});

/** Printable ASCII only and short: a message that reaches `status` cannot carry a control sequence or a long dump. */
export const sanitizeMessage = (text: string): string =>
  text
    .replace(/[^\x20-\x7e]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MESSAGE_LIMIT);

/** Records why the last round failed; the file is replaced, never appended. */
export function writeLastError(stateDir: string, error: LastError, now: Date): void {
  const file = path.join(stateDir, LAST_ERROR_FILE);
  const temporary = `${file}.${process.pid}.tmp`;
  const body = lastErrorSchema.parse({
    code: error.code,
    message: sanitizeMessage(error.message),
    at: now.toISOString(),
  });
  fs.writeFileSync(temporary, `${JSON.stringify(body)}\n`, { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
}

/** A round that ended well (or found nothing to do) clears the last error. */
export function clearLastError(stateDir: string): void {
  fs.rmSync(path.join(stateDir, LAST_ERROR_FILE), { force: true });
}

function readLastError(stateDir: string): LastError | null {
  try {
    const parsed = lastErrorSchema.safeParse(
      JSON.parse(fs.readFileSync(path.join(stateDir, LAST_ERROR_FILE), 'utf8')),
    );
    return parsed.success ? { code: parsed.data.code, message: parsed.data.message } : null;
  } catch {
    return null;
  }
}

const fixedText = (code: JournalFailureCode): LastError => ({ code, message: FAILURES[code].message });

/** The status of the watcher: launchd, the journal, the last failure. An unreadable journal shows as its own error. */
export async function readStatus(deps: WatcherDeps, stateDir: string): Promise<WatcherStatus> {
  const launchd = await watcherState(deps);
  let releaseId: string | null = null;
  let phase: string | null = null;
  let lastError = readLastError(stateDir);
  try {
    const read = new JournalStore(stateDir).read();
    if (read.kind === 'ok') {
      releaseId = read.journal.releaseId;
      phase = read.journal.phase;
      if (!lastError && read.journal.failure) lastError = fixedText(read.journal.failure.code);
    }
  } catch {
    lastError ??= {
      code: 'journal_unreadable',
      message: 'the release journal cannot be read: it stays where it is until a person looks',
    };
  }
  return { ...launchd, releaseId, phase, lastError };
}
