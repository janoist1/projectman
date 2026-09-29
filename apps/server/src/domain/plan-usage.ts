import type { FastifyBaseLogger } from 'fastify';
import { DEFAULT_AGENT_PROVIDER, type AgentProvider, type PlanUsage } from '@projectman/shared';
import type { PlanUsageProvider } from '../contracts';

interface Entry {
  value: PlanUsage | null;
  fetchedAt: number;
  pending: Promise<PlanUsage | null> | null;
}

/**
 * Caches the plan usage per provider (fetching it may be slow); failures read as "unknown"
 * (null). Claude's usage comes from `provider`; other providers' from `providerFor` (looked
 * up when needed), and a provider without a source is unknown.
 */
export class PlanUsageCache {
  private readonly provider: PlanUsageProvider;
  private readonly providerFor: ((provider: AgentProvider) => PlanUsageProvider | undefined) | undefined;
  private readonly ttlMs: number;
  private readonly logger: FastifyBaseLogger;
  private readonly now: () => Date;
  private readonly onFetched:
    ((provider: AgentProvider, usage: PlanUsage | null) => void | Promise<void>) | undefined;
  private readonly entries = new Map<AgentProvider, Entry>();

  constructor(opts: {
    provider: PlanUsageProvider;
    providerFor?: (provider: AgentProvider) => PlanUsageProvider | undefined;
    logger: FastifyBaseLogger;
    now: () => Date;
    ttlMs?: number;
    onFetched?: (provider: AgentProvider, usage: PlanUsage | null) => void | Promise<void>;
  }) {
    this.onFetched = opts.onFetched;
    this.provider = opts.provider;
    this.providerFor = opts.providerFor;
    this.logger = opts.logger;
    this.now = opts.now;
    this.ttlMs = opts.ttlMs ?? 60_000;
  }

  /** Plan usage of a provider's account (default: Claude). */
  async get(provider: AgentProvider = DEFAULT_AGENT_PROVIDER): Promise<PlanUsage | null> {
    const source = this.providerFor?.(provider) ?? (provider === 'claude' ? this.provider : undefined);
    let entry = this.entries.get(provider);
    if (!entry) {
      entry = { value: null, fetchedAt: 0, pending: null };
      this.entries.set(provider, entry);
    }
    const current = entry;
    if (current.fetchedAt > 0 && this.now().getTime() - current.fetchedAt < this.ttlMs) return current.value;
    current.pending ??= Promise.resolve()
      .then(() => source?.get() ?? null)
      .catch((err: unknown) => {
        this.logger.warn({ err, provider }, 'plan usage unavailable');
        return null;
      })
      .then(async (value) => {
        current.value = value;
        current.fetchedAt = this.now().getTime();
        try {
          await this.onFetched?.(provider, value);
        } finally {
          current.pending = null;
        }
        return value;
      });
    return current.pending;
  }

  invalidate(): void {
    for (const entry of this.entries.values()) entry.fetchedAt = 0;
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
