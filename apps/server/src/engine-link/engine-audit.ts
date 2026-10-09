import { createRotatingFile } from '../logging/rotating-file';

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
  const now = options.now ?? (() => new Date());
  const target = createRotatingFile(file, {
    maxBytes: options.maxBytes ?? AUDIT_MAX_BYTES,
    keep: options.keep ?? AUDIT_KEEP_FILES,
  });
  return {
    record(entry) {
      const line = `${JSON.stringify({ at: now().toISOString(), ...entry })}\n`;
      try {
        target.append(line);
      } catch (error) {
        options.onError?.(error);
      }
    },
  };
}
