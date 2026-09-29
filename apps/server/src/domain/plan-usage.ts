import type { FastifyBaseLogger } from 'fastify';
import type { PlanUsage } from '@projectman/shared';
import type { PlanUsageProvider } from '../contracts';

/** Caches the plan usage (fetching it may be slow); failures read as "unknown" (null). */
export class PlanUsageCache {
  private readonly provider: PlanUsageProvider;
  private readonly ttlMs: number;
  private readonly logger: FastifyBaseLogger;
  private readonly now: () => Date;
  private value: PlanUsage | null = null;
  private fetchedAt = 0;
  private pending: Promise<PlanUsage | null> | null = null;

  constructor(opts: {
    provider: PlanUsageProvider;
    logger: FastifyBaseLogger;
    now: () => Date;
    ttlMs?: number;
  }) {
    this.provider = opts.provider;
    this.logger = opts.logger;
    this.now = opts.now;
    this.ttlMs = opts.ttlMs ?? 60_000;
  }

  async get(): Promise<PlanUsage | null> {
    if (this.fetchedAt > 0 && this.now().getTime() - this.fetchedAt < this.ttlMs) return this.value;
    this.pending ??= this.provider
      .get()
      .catch((err: unknown) => {
        this.logger.warn({ err }, 'plan usage unavailable');
        return null;
      })
      .then((value) => {
        this.value = value;
        this.fetchedAt = this.now().getTime();
        this.pending = null;
        return value;
      });
    return this.pending;
  }

  invalidate(): void {
    this.fetchedAt = 0;
  }
}

/** Highest known usage percentage (five-hour or weekly window), or null when unknown. */
export function highestUsagePercent(usage: PlanUsage | null): number | null {
  if (!usage) return null;
  const known = [usage.fiveHourPercent, usage.weeklyPercent].filter(
    (v): v is number => typeof v === 'number',
  );
  return known.length > 0 ? Math.max(...known) : null;
}
