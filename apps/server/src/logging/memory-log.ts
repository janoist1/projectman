import { getHeapStatistics } from 'node:v8';

/** One `memory` log line (PM-775): whole megabytes, rounded. */
export interface MemoryLogFields {
  module: 'memory';
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  arrayBuffersMb: number;
  heapLimitMb: number;
  uptimeS: number;
}

const MEMORY_LOG_MIN_SECONDS = 60;
const MEMORY_LOG_MAX_SECONDS = 86_400;

/** A wrong `PROJECTMAN_MEMORY_LOG_SECONDS` stops the start; main() prints it as `projectman: <message>`. */
export class MemoryLogSettingError extends Error {}

/** `PROJECTMAN_MEMORY_LOG_SECONDS`: 0 or unset is off (0), otherwise a whole number of seconds from 60 to 86400. */
export function parseMemoryLogSeconds(value: string | undefined): number {
  const text = value?.trim();
  if (!text) return 0;
  const seconds = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (seconds === 0) return 0;
  if (!Number.isInteger(seconds) || seconds < MEMORY_LOG_MIN_SECONDS || seconds > MEMORY_LOG_MAX_SECONDS)
    throw new MemoryLogSettingError(
      `invalid PROJECTMAN_MEMORY_LOG_SECONDS: ${text} (0 turns it off, otherwise ${MEMORY_LOG_MIN_SECONDS} to ${MEMORY_LOG_MAX_SECONDS} seconds)`,
    );
  return seconds;
}

const MB = 1024 * 1024;

/**
 * Logs the process memory every `intervalS` seconds through `log` (PM-775). The timer is unref'ed, so it
 * never keeps the process alive; the returned function stops it.
 */
export function startMemoryLog(options: {
  intervalS: number;
  log: (fields: MemoryLogFields) => void;
  /** The clock in milliseconds; uptime is counted from the start of the log. */
  now?: () => number;
}): () => void {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const timer = setInterval(() => {
    const usage = process.memoryUsage();
    options.log({
      module: 'memory',
      rssMb: Math.round(usage.rss / MB),
      heapUsedMb: Math.round(usage.heapUsed / MB),
      heapTotalMb: Math.round(usage.heapTotal / MB),
      externalMb: Math.round(usage.external / MB),
      arrayBuffersMb: Math.round(usage.arrayBuffers / MB),
      heapLimitMb: Math.round(getHeapStatistics().heap_size_limit / MB),
      uptimeS: Math.round((now() - startedAt) / 1000),
    });
  }, options.intervalS * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
