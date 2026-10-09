import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

/** One line per request the engine served (PM-314). Never prompts, messages, input, file content or keys. */
export interface EngineAuditEntry {
  at: string;
  reqId: string;
  method: string;
  sessionId?: string;
  member?: string;
  outcome: 'ok' | 'refused' | 'error';
  code?: string;
}

export interface EngineAudit {
  record(entry: Omit<EngineAuditEntry, 'at'>): void;
}

export const AUDIT_MAX_BYTES = 10 * 1024 * 1024;
export const AUDIT_KEEP_FILES = 5;

/**
 * Appends JSON lines to `file` and rotates it at `maxBytes`: `file` becomes `file.1`, `file.1`
 * `file.2`, and so on; the oldest of `keep` files is deleted. A failing write never fails a request.
 */
export function createEngineAudit(
  file: string,
  options: { maxBytes?: number; keep?: number; now?: () => Date; onError?: (error: unknown) => void } = {},
): EngineAudit {
  const maxBytes = options.maxBytes ?? AUDIT_MAX_BYTES;
  const keep = Math.max(1, options.keep ?? AUDIT_KEEP_FILES);
  const now = options.now ?? (() => new Date());
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    size = 0;
  }
  const moveIfExists = (from: string, to: string) => {
    try {
      renameSync(from, to);
    } catch (error) {
      // A rotated file that does not exist yet is normal.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  };
  const rotate = () => {
    rmSync(`${file}.${keep - 1}`, { force: true });
    for (let index = keep - 2; index >= 1; index -= 1)
      moveIfExists(`${file}.${index}`, `${file}.${index + 1}`);
    if (keep > 1) moveIfExists(file, `${file}.1`);
    else rmSync(file, { force: true });
    size = 0;
  };
  return {
    record(entry) {
      const line = `${JSON.stringify({ at: now().toISOString(), ...entry })}\n`;
      try {
        if (size > 0 && size + Buffer.byteLength(line) > maxBytes) rotate();
        appendFileSync(file, line, { mode: 0o600 });
        size += Buffer.byteLength(line);
      } catch (error) {
        options.onError?.(error);
      }
    },
  };
}
