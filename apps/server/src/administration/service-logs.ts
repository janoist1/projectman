import { ADMINISTRATION_LIMITS, MAX_DIAGNOSTIC_ENTRIES, MAX_DIAGNOSTIC_MESSAGE } from '../contracts';
import type { AdministrationLogsOptions, DiagnosticLevel, DiagnosticLogEntry } from '../contracts';
import { JOURNALCTL } from './host';
import type { HostSystem } from './host';
import { redactLine } from './redact';
import { readFileTail } from './secure-fs';
import type { SupervisorConfig } from './schemas';

/**
 * The managed service's own log (PM-886), read only by the supervisor: the one `service.logFile` of a launchd
 * service (a path from the protected configuration, read from its end) or `journalctl -u <unit>` of a systemd
 * one. Every line is redacted before it is filtered or returned, is cut to the entry size, and keeps the level
 * and time the line itself shows. Nothing a caller sends can name the file, the unit or any argument.
 */

export const SERVICE_LOG_CODE = 'service_log';

/** How much of the file's end is looked at, and how many lines the filters may scan. */
const TAIL_BYTES = 512 * 1024;
const SCAN_LINES = 1000;
/** A line is cut before the redaction runs: a secret cut in half is still taken for one by its prefix or length. */
const MAX_RAW_LINE = 4096;

/** The entries of one answer stay well under the socket's response limit (a quarter of it is left for the frame). */
const ANSWER_BUDGET_BYTES = Math.floor(ADMINISTRATION_LIMITS.responseBytes * 0.75);

const LEVEL_RANK: Record<DiagnosticLevel, number> = { info: 0, warn: 1, error: 2 };

const LEVEL_WORDS: Record<string, DiagnosticLevel> = {
  fatal: 'error',
  critical: 'error',
  error: 'error',
  err: 'error',
  warn: 'warn',
  warning: 'warn',
  info: 'info',
  notice: 'info',
  debug: 'info',
  trace: 'info',
};

const LEVEL_KEYED = /\blevel["']?\s*[=:]\s*["']?([A-Za-z]+)/i;
const LEVEL_NUMBER = /"level"\s*:\s*(\d+)/;
const LEVEL_BRACKET = /[[<(]\s*(fatal|critical|error|err|warn|warning|info|notice|debug|trace)\s*[\]>)]/i;
const LEVEL_UPPER = /\b(FATAL|CRITICAL|ERROR|WARN|WARNING)\b/;

/** The level a log line states about itself (`level=warn`, `[error]`, `"level":50`, `ERROR`), else `info`. */
export function levelOfText(line: string): DiagnosticLevel {
  const keyed = LEVEL_KEYED.exec(line)?.[1];
  if (keyed && LEVEL_WORDS[keyed.toLowerCase()]) return LEVEL_WORDS[keyed.toLowerCase()]!;
  const number = LEVEL_NUMBER.exec(line)?.[1];
  if (number !== undefined) return Number(number) >= 50 ? 'error' : Number(number) >= 40 ? 'warn' : 'info';
  const bracket = LEVEL_BRACKET.exec(line)?.[1];
  if (bracket) return LEVEL_WORDS[bracket.toLowerCase()]!;
  const upper = LEVEL_UPPER.exec(line)?.[1];
  return upper ? LEVEL_WORDS[upper.toLowerCase()]! : 'info';
}

const LEADING_TIME = /^\s*\[?(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?\]?/;
const JSON_TIME = /"(?:time|timestamp|ts)"\s*:\s*(?:"([^"]{10,40})"|(\d{12,16}))/;

/** The time a log line states (a leading ISO-like time, or a JSON `time` field), or null. */
export function timeOfText(line: string): Date | null {
  const lead = LEADING_TIME.exec(line);
  if (lead) {
    const zone = lead[4]
      ? lead[4].includes(':') || lead[4] === 'Z'
        ? lead[4]
        : `${lead[4].slice(0, 3)}:${lead[4].slice(3)}`
      : '';
    // Without a zone the machine's local time is meant, which is how Date reads a zone-less date-time.
    const date = new Date(`${lead[1]}T${lead[2]}${lead[3] ?? ''}${zone}`);
    if (!Number.isNaN(date.getTime())) return date;
  }
  const json = JSON_TIME.exec(line);
  if (json) {
    const date = json[1] ? new Date(json[1]) : new Date(Number(json[2]));
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

/** A printable, redacted, size-limited message; control characters (including line breaks) become spaces. */
export function cleanMessage(raw: string): string {
  const plain = raw
    .slice(0, MAX_RAW_LINE)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim();
  return redactLine(plain).slice(0, MAX_DIAGNOSTIC_MESSAGE);
}

/**
 * Applies the caller's filters to entries that are already redacted, oldest first, and keeps the newest
 * `limit`. The text filter sees only the redacted message, so a caller cannot search for a secret.
 */
export function filterEntries(
  entries: DiagnosticLogEntry[],
  query: Pick<AdministrationLogsOptions, 'limit' | 'minLevel' | 'since' | 'contains'>,
): DiagnosticLogEntry[] {
  const since = query.since === undefined ? null : Date.parse(query.since);
  const contains = query.contains?.toLowerCase();
  const minRank = LEVEL_RANK[query.minLevel ?? 'info'];
  const kept = entries.filter(
    (entry) =>
      LEVEL_RANK[entry.level] >= minRank &&
      (since === null || Number.isNaN(since) || Date.parse(entry.at) >= since) &&
      (contains === undefined || entry.message.toLowerCase().includes(contains)),
  );
  const newest = kept.slice(-Math.max(0, Math.min(query.limit, MAX_DIAGNOSTIC_ENTRIES)));
  // 200 lines of 1000 characters that all need escaping would not fit the socket's answer; the oldest give way.
  let size = JSON.stringify(newest).length;
  let drop = 0;
  while (size > ANSWER_BUDGET_BYTES && drop < newest.length) {
    size -= JSON.stringify(newest[drop]).length + 1;
    drop += 1;
  }
  return newest.slice(drop);
}

/** The lines of a log file's tail as entries, oldest first. A line without a time takes the one before it. */
export function entriesOfFileText(text: string, complete: boolean, modifiedAt: Date): DiagnosticLogEntry[] {
  const lines = text.split('\n');
  // The tail starts inside a line unless it starts at the file's first byte.
  if (!complete) lines.shift();
  let carried = modifiedAt;
  const entries: DiagnosticLogEntry[] = [];
  for (const line of lines.slice(-SCAN_LINES)) {
    if (line.trim().length === 0) continue;
    const at = timeOfText(line) ?? carried;
    carried = at;
    entries.push({
      at: at.toISOString(),
      level: levelOfText(line.slice(0, MAX_RAW_LINE)),
      code: SERVICE_LOG_CODE,
      message: cleanMessage(line),
    });
  }
  return entries;
}

/** One `journalctl -o json` line as an entry, or null when it is not a message of the unit. */
export function entryOfJournalLine(raw: string): DiagnosticLogEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const { MESSAGE, PRIORITY, __REALTIME_TIMESTAMP } = parsed as Record<string, unknown>;
  // A binary message is an array of byte values.
  const message =
    typeof MESSAGE === 'string'
      ? MESSAGE
      : Array.isArray(MESSAGE) && MESSAGE.every((byte) => Number.isInteger(byte))
        ? Buffer.from(MESSAGE as number[]).toString('utf8')
        : null;
  const micros = Number(__REALTIME_TIMESTAMP);
  if (message === null || !Number.isFinite(micros)) return null;
  const priority = Number(PRIORITY);
  return {
    at: new Date(Math.floor(micros / 1000)).toISOString(),
    level: priority <= 3 ? 'error' : priority === 4 ? 'warn' : 'info',
    code: SERVICE_LOG_CODE,
    message: cleanMessage(message),
  };
}

export interface ServiceLogReader {
  /** Whether this installation has a service log to read (the `service_logs` capability). */
  available(): boolean;
  read(query: AdministrationLogsOptions): Promise<DiagnosticLogEntry[]>;
}

export interface ServiceLogReaderOptions {
  host: HostSystem;
  service: SupervisorConfig['service'];
}

const hasFilter = (query: AdministrationLogsOptions) =>
  query.minLevel !== undefined || query.since !== undefined || query.contains !== undefined;

export function createServiceLogReader({ host, service }: ServiceLogReaderOptions): ServiceLogReader {
  async function readFile(file: string): Promise<DiagnosticLogEntry[]> {
    const tail = await readFileTail(file, TAIL_BYTES, host.uid);
    return tail ? entriesOfFileText(tail.text, tail.complete, tail.modifiedAt) : [];
  }

  async function readJournal(unit: string, query: AdministrationLogsOptions): Promise<DiagnosticLogEntry[]> {
    // With a filter, more lines than asked for are fetched, because the filter runs on this side.
    const count = hasFilter(query) ? SCAN_LINES : query.limit;
    const output = await host.exec(JOURNALCTL, ['-u', unit, '-o', 'json', '--no-pager', '-n', String(count)]);
    return output
      .split('\n')
      .map((line) => (line.trim() ? entryOfJournalLine(line) : null))
      .filter((entry): entry is DiagnosticLogEntry => entry !== null);
  }

  return {
    available: () => (service.kind === 'launchd' ? service.logFile !== undefined : true),
    async read(query) {
      const entries =
        service.kind === 'launchd'
          ? service.logFile
            ? await readFile(service.logFile)
            : []
          : await readJournal(service.unit, query);
      return filterEntries(entries, query);
    },
  };
}
