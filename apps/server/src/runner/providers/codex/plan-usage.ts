import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { PlanUsage } from '@projectman/shared';
import type { PlanUsageProvider } from '../../../contracts';
import { rateLimitsOf, type CodexRateLimits, type CodexRateWindow } from './transcript';

/**
 * Plan usage of the ChatGPT account Codex runs on. Codex writes the plan's rate limits
 * (`used_percent`, `window_minutes`, `resets_at` per window) into its transcripts with every
 * `token_count` event, so reading them spends nothing and needs no Codex process: the newest
 * record among the most recently written rollouts wins (Codex use outside projectman counts
 * too, as it shares the plan). Transcripts are only read, never changed.
 */

/** How many day folders ($CODEX_HOME/sessions/YYYY/MM/DD) are looked at, newest first. */
const MAX_DAY_DIRS = 14;
/** How many of the most recently written rollouts are read. */
const MAX_FILES = 8;
/** Only the end of a rollout is read. */
const TAIL_BYTES = 1024 * 1024;
/** Transcripts of live sessions remembered as candidates. */
const MAX_NOTED = 50;
/** Windows up to this long count as the short (five-hour) window. */
const SHORT_WINDOW_MAX_MINUTES = 6 * 60;

function isoFromUnix(seconds: number | null): string | null {
  return seconds === null ? null : new Date(seconds * 1000).toISOString();
}

/** Maps Codex rate limits to the plan usage shape; windows that have reset since read as unknown. */
export function toCodexPlanUsage(limits: CodexRateLimits, now: Date = new Date()): PlanUsage {
  let short: CodexRateWindow | null = null;
  let long: CodexRateWindow | null = null;
  const place = (window: CodexRateWindow | null, fallback: 'short' | 'long') => {
    if (!window) return;
    const slot =
      window.windowMinutes === null
        ? fallback
        : window.windowMinutes <= SHORT_WINDOW_MAX_MINUTES
          ? 'short'
          : 'long';
    if (slot === 'short') short ??= window;
    else long ??= window;
  };
  place(limits.primary, 'short');
  place(limits.secondary, 'long');
  const current = (window: CodexRateWindow | null) => {
    if (!window) return { percent: null, resetsAt: null };
    if (window.resetsAt !== null && window.resetsAt * 1000 <= now.getTime()) {
      return { percent: null, resetsAt: null }; // reset since the record: unknown
    }
    return {
      percent: Math.max(0, Math.min(100, window.usedPercent)),
      resetsAt: isoFromUnix(window.resetsAt),
    };
  };
  const five = current(short);
  const week = current(long);
  return {
    fiveHourPercent: five.percent,
    weeklyPercent: week.percent,
    fiveHourResetsAt: five.resetsAt,
    weeklyResetsAt: week.resetsAt,
    fetchedAt: limits.at,
  };
}

/** The newest rate limits in the last part of a rollout, or null. */
export async function lastRateLimits(file: string): Promise<CodexRateLimits | null> {
  let handle;
  try {
    handle = await open(file, 'r');
  } catch {
    return null;
  }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    await handle.read(buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (!line.includes('"token_count"') || !line.includes('"rate_limits"')) continue;
      try {
        const entry = JSON.parse(line) as { timestamp?: unknown; type?: unknown; payload?: unknown };
        const payload = entry.payload as Record<string, unknown> | null;
        if (entry.type !== 'event_msg' || !payload || payload.type !== 'token_count') continue;
        const at = typeof entry.timestamp === 'string' ? entry.timestamp : new Date(0).toISOString();
        const limits = rateLimitsOf(payload, at);
        if (limits) return limits;
      } catch {
        // a partial first line of the tail, or a malformed line
      }
    }
    return null;
  } finally {
    await handle.close();
  }
}

async function numberedDirs(dir: string, width: number): Promise<string[]> {
  try {
    const names = await readdir(dir);
    const re = new RegExp(`^\\d{${width}}$`);
    return names.filter((n) => re.test(n)).sort((a, b) => b.localeCompare(a));
  } catch {
    return [];
  }
}

/** The most recently written rollouts under `sessionsDir` (newest day folders first). */
export async function recentRollouts(sessionsDir: string): Promise<Array<{ file: string; mtimeMs: number }>> {
  const days: string[] = [];
  for (const year of await numberedDirs(sessionsDir, 4)) {
    for (const month of await numberedDirs(path.join(sessionsDir, year), 2)) {
      for (const day of await numberedDirs(path.join(sessionsDir, year, month), 2)) {
        days.push(path.join(sessionsDir, year, month, day));
        if (days.length >= MAX_DAY_DIRS) break;
      }
      if (days.length >= MAX_DAY_DIRS) break;
    }
    if (days.length >= MAX_DAY_DIRS) break;
  }
  const files: Array<{ file: string; mtimeMs: number }> = [];
  for (const dir of days) {
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/^rollout-.*\.jsonl$/.test(name)) continue;
      const file = path.join(dir, name);
      try {
        files.push({ file, mtimeMs: (await stat(file)).mtimeMs });
      } catch {
        // removed meanwhile
      }
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_FILES);
}

export interface CodexPlanUsageOptions {
  codexHome: string;
  logger: FastifyBaseLogger;
  /** Results are reused for this long (default one minute). */
  minIntervalMs?: number;
  now?: () => Date;
}

export class CodexPlanUsage implements PlanUsageProvider {
  private readonly opts: CodexPlanUsageOptions;
  private readonly noted = new Set<string>();
  private last: { value: PlanUsage | null; at: number } | null = null;
  private inflight: Promise<PlanUsage | null> | null = null;

  constructor(opts: CodexPlanUsageOptions) {
    this.opts = opts;
  }

  /** A transcript of a live session: read it too (a resumed session writes to an old day folder). */
  noteTranscript(file: string): void {
    this.noted.delete(file);
    this.noted.add(file);
    while (this.noted.size > MAX_NOTED) {
      const oldest = this.noted.values().next().value;
      if (oldest === undefined) break;
      this.noted.delete(oldest);
    }
  }

  get(): Promise<PlanUsage | null> {
    const minIntervalMs = this.opts.minIntervalMs ?? 60_000;
    if (this.last && Date.now() - this.last.at < minIntervalMs) return Promise.resolve(this.last.value);
    this.inflight ??= this.read()
      .catch((err: unknown) => {
        this.opts.logger.warn({ err }, 'plan usage: could not read Codex transcripts');
        return this.last?.value ?? null;
      })
      .then((value) => {
        this.last = { value, at: Date.now() };
        this.inflight = null;
        return value;
      });
    return this.inflight;
  }

  private async read(): Promise<PlanUsage | null> {
    const candidates = new Set(
      (await recentRollouts(path.join(this.opts.codexHome, 'sessions'))).map((f) => f.file),
    );
    for (const file of this.noted) candidates.add(file);
    let newest: CodexRateLimits | null = null;
    for (const file of candidates) {
      const limits = await lastRateLimits(file);
      if (limits && (!newest || Date.parse(limits.at) > Date.parse(newest.at))) newest = limits;
    }
    return newest ? toCodexPlanUsage(newest, (this.opts.now ?? (() => new Date()))()) : null;
  }
}
