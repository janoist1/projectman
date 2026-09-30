import type { FastifyBaseLogger } from 'fastify';
import { DEFAULT_AGENT_PROVIDER, type AgentProvider, type PlanUsage } from '@projectman/shared';
import type { EventBus, PlanUsageProvider } from '../contracts';
import type { BackgroundTasks } from './background';
import type { ProjectService } from './projects';

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

  /** Last background result; reading a board must never start a CLI or scan transcripts. */
  peek(provider: AgentProvider = DEFAULT_AGENT_PROVIDER): PlanUsage | null {
    return this.entries.get(provider)?.value ?? null;
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

/**
 * Keeps the plan usage of the providers the projects' AI members run on fresh: probes them in
 * the background periodically and after configuration changes, and publishes every result to
 * the projects whose AI members run on that provider. Owns the cache admission reads.
 */
export class PlanUsageMonitor {
  readonly cache: PlanUsageCache;
  private readonly projects: ProjectService;
  private readonly bus: EventBus;
  private readonly logger: FastifyBaseLogger;
  private readonly background: BackgroundTasks;
  private readonly intervalMs: number;
  private refreshing = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: {
    provider: PlanUsageProvider;
    providerFor?: (provider: AgentProvider) => PlanUsageProvider | undefined;
    projects: ProjectService;
    bus: EventBus;
    logger: FastifyBaseLogger;
    now: () => Date;
    background: BackgroundTasks;
    /** How long a probe result is fresh, and how often the providers are probed (default 1 minute). */
    ttlMs?: number;
  }) {
    this.projects = opts.projects;
    this.bus = opts.bus;
    this.logger = opts.logger;
    this.background = opts.background;
    this.intervalMs = opts.ttlMs && opts.ttlMs > 0 ? opts.ttlMs : 60_000;
    this.cache = new PlanUsageCache({
      provider: opts.provider,
      providerFor: opts.providerFor,
      logger: opts.logger,
      now: opts.now,
      ttlMs: opts.ttlMs,
      onFetched: (provider, usage) => this.publish(provider, usage),
    });
  }

  /** Probes now and then every interval. */
  start(): void {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Probes every provider the AI members run on, in the background; one round at a time. */
  refresh(): void {
    if (this.refreshing) return;
    this.refreshing = this.background.run(
      async () => {
        try {
          const providers = new Set([...(await this.providersByProject()).values()].flatMap((p) => [...p]));
          await Promise.all([...providers].map((provider) => this.cache.get(provider)));
        } finally {
          this.refreshing = false;
        }
      },
      (err) => this.logger.warn({ err }, 'plan usage refresh failed'),
    );
  }

  /** A probe result goes to the projects whose AI members run on the provider. */
  private async publish(provider: AgentProvider, usage: PlanUsage | null): Promise<void> {
    for (const [projectKey, providers] of await this.providersByProject()) {
      if (providers.has(provider)) this.bus.publish({ type: 'plan_usage', projectKey, provider, usage });
    }
  }

  /** The providers each project's AI members run on. */
  private async providersByProject(): Promise<Map<string, Set<AgentProvider>>> {
    const result = new Map<string, Set<AgentProvider>>();
    for (const project of this.projects.summaries()) {
      const config = await this.projects.config(project.key);
      const providers = new Set<AgentProvider>();
      for (const member of config.team.members) {
        if (member.kind === 'ai') providers.add(member.provider ?? DEFAULT_AGENT_PROVIDER);
      }
      result.set(project.key, providers);
    }
    return result;
  }
}
