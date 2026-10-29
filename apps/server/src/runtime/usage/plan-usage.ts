import type { FastifyBaseLogger } from 'fastify';
import {
  DEFAULT_AGENT_PROVIDER,
  type AgentProvider,
  type EngineId,
  type PlanUsage,
  type ProjectConfig,
} from '@projectman/shared';
import type { EngineDirectory, EventBus, PlanUsageProvider } from '../../contracts';
import type { BackgroundTasks } from '../../kernel';
import type { ProjectService } from '../../core/projects';

import { RefreshLoop } from './refresh-loop';

interface Entry {
  value: PlanUsage | null;
  fetchedAt: number;
  pending: Promise<PlanUsage | null> | null;
}

type OnFetched = (
  provider: AgentProvider,
  engineId: EngineId,
  usage: PlanUsage | null,
) => void | Promise<void>;

interface Accounts {
  pairs: Array<{ provider: AgentProvider; engineId: EngineId }>;
  representative: Map<AgentProvider, EngineId>;
}

const entryKey = (engineId: EngineId, provider: AgentProvider): string => `${engineId}\0${provider}`;

/**
 * A value this many TTLs old still answers `get` at once while a fresh one is fetched behind it: the probe
 * spawns a CLI, and admission asks for it under its lock (PM-1133). A TTL of 0 never serves a stale value.
 */
const STALE_TTL_FACTOR = 5;

/**
 * Caches the plan usage per engine and provider (an account lives on an engine's machine; fetching it
 * may be slow); failures read as "unknown" (null). Claude's usage comes from `provider`; other
 * providers' from `providerFor` (looked up when needed), and a provider without a source is unknown.
 * No engine (null): nothing is asked and the usage is unknown. The TTL, the last value and the
 * request in flight belong to one engine and provider.
 */
export class PlanUsageCache {
  private readonly provider: PlanUsageProvider;
  private readonly providerFor: ((provider: AgentProvider) => PlanUsageProvider | undefined) | undefined;
  private readonly ttlMs: number;
  private readonly logger: FastifyBaseLogger;
  private readonly now: () => Date;
  private readonly onFetched: OnFetched | undefined;
  private readonly entries = new Map<string, Entry & { engineId: EngineId }>();

  constructor(opts: {
    provider: PlanUsageProvider;
    providerFor?: (provider: AgentProvider) => PlanUsageProvider | undefined;
    logger: FastifyBaseLogger;
    now: () => Date;
    ttlMs?: number;
    onFetched?: OnFetched;
  }) {
    this.onFetched = opts.onFetched;
    this.provider = opts.provider;
    this.providerFor = opts.providerFor;
    this.logger = opts.logger;
    this.now = opts.now;
    this.ttlMs = opts.ttlMs ?? 60_000;
  }

  /** Last background result; reading a board must never start a CLI or scan transcripts. */
  peek(provider: AgentProvider, engineId: EngineId | null): PlanUsage | null {
    if (engineId === null) return null;
    return this.entries.get(entryKey(engineId, provider))?.value ?? null;
  }

  /** Plan usage of a provider's account on one engine. */
  async get(provider: AgentProvider, engineId: EngineId | null): Promise<PlanUsage | null> {
    if (engineId === null) return null;
    const source = this.providerFor?.(provider) ?? (provider === 'claude' ? this.provider : undefined);
    const key = entryKey(engineId, provider);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { engineId, value: null, fetchedAt: 0, pending: null };
      this.entries.set(key, entry);
    }
    const current = entry;
    const age = this.now().getTime() - current.fetchedAt;
    if (current.fetchedAt > 0 && age < this.ttlMs) return current.value;
    const stale = current.fetchedAt > 0 && age < this.ttlMs * STALE_TTL_FACTOR;
    current.pending ??= Promise.resolve()
      .then(() => source?.get(engineId) ?? null)
      .catch((err: unknown) => {
        this.logger.warn({ err, provider, engineId }, 'plan usage unavailable');
        return null;
      })
      .then(async (value) => {
        current.value = value;
        current.fetchedAt = this.now().getTime();
        try {
          await this.onFetched?.(provider, engineId, value);
        } finally {
          current.pending = null;
        }
        return value;
      });
    if (!stale) return current.pending;
    current.pending.catch((err: unknown) =>
      this.logger.warn({ err, provider, engineId }, 'plan usage refresh failed'),
    );
    return current.value;
  }

  /** Every entry's age is reset; with an engine only that engine's entries, never another one's. */
  invalidate(engineId?: EngineId): void {
    for (const entry of this.entries.values())
      if (!engineId || entry.engineId === engineId) entry.fetchedAt = 0;
  }
}

/**
 * Keeps the plan usage of the providers the projects' AI members run on fresh: probes them in
 * the background periodically and after configuration changes, and publishes every result to
 * the projects whose AI members run on that provider. Owns the cache admission reads.
 */
export class PlanUsageMonitor {
  readonly cache: PlanUsageCache;
  private readonly projects: ProjectService;
  private readonly engines: Pick<EngineDirectory, 'engineFor'>;
  private readonly bus: EventBus;
  private readonly logger: FastifyBaseLogger;
  private readonly background: BackgroundTasks;
  private readonly intervalMs: number;
  private refreshing = false;
  private readonly loop: RefreshLoop;

  constructor(opts: {
    provider: PlanUsageProvider;
    providerFor?: (provider: AgentProvider) => PlanUsageProvider | undefined;
    projects: ProjectService;
    /** Which engine each AI member of a project runs on: its account is measured there. */
    engines: Pick<EngineDirectory, 'engineFor'>;
    bus: EventBus;
    logger: FastifyBaseLogger;
    now: () => Date;
    background: BackgroundTasks;
    /** How long a probe result is fresh, and how often the providers are probed (default 1 minute). */
    ttlMs?: number;
    onFetched?: (provider: AgentProvider, engineId: EngineId, usage: PlanUsage | null) => void;
  }) {
    this.projects = opts.projects;
    this.engines = opts.engines;
    this.bus = opts.bus;
    this.logger = opts.logger;
    this.background = opts.background;
    this.intervalMs = opts.ttlMs && opts.ttlMs > 0 ? opts.ttlMs : 60_000;
    this.loop = new RefreshLoop({
      intervalMs: this.intervalMs,
      tick: () => this.refresh(),
      logger: opts.logger,
    });
    this.cache = new PlanUsageCache({
      provider: opts.provider,
      providerFor: opts.providerFor,
      logger: opts.logger,
      now: opts.now,
      ttlMs: opts.ttlMs,
      onFetched: (provider, engineId, usage) => {
        opts.onFetched?.(provider, engineId, usage);
        return this.publish(provider, engineId, usage);
      },
    });
  }

  /**
   * The last known usage of the project's account of a provider, for the board: the one on the engine of
   * the project's first AI member of that provider. Reading starts no measurement.
   */
  peek(projectKey: string, provider: AgentProvider = DEFAULT_AGENT_PROVIDER): PlanUsage | null {
    const config = this.projects.cachedConfig(projectKey);
    const engineId = config ? this.accounts(config).representative.get(provider) : undefined;
    return engineId ? this.cache.peek(provider, engineId) : null;
  }

  /** Probes now and then every interval. */
  start(): void {
    this.refresh();
    this.loop.start();
  }

  stop(): void {
    this.loop.stop();
  }

  /** Probes every account (engine and provider) the AI members run on, in the background; one round at a time. */
  refresh(): void {
    if (this.refreshing) return;
    this.refreshing = this.background.run(
      async () => {
        try {
          const pairs = new Map<string, { provider: AgentProvider; engineId: EngineId }>();
          for (const { pairs: projectPairs } of (await this.accountsByProject()).values())
            for (const pair of projectPairs) pairs.set(entryKey(pair.engineId, pair.provider), pair);
          await Promise.all([...pairs.values()].map((pair) => this.cache.get(pair.provider, pair.engineId)));
        } finally {
          this.refreshing = false;
        }
      },
      (err) => this.logger.warn({ err }, 'plan usage refresh failed'),
    );
  }

  /** A probe result goes to the projects whose account of that provider is the one measured on that engine. */
  private async publish(provider: AgentProvider, engineId: EngineId, usage: PlanUsage | null): Promise<void> {
    for (const [projectKey, { representative }] of await this.accountsByProject()) {
      if (representative.get(provider) === engineId)
        this.bus.publish({ type: 'plan_usage', projectKey, provider, usage });
    }
  }

  /**
   * The accounts of a project's AI members: every (provider, engine) pair to measure, and per provider
   * the engine whose value the project shows (its first AI member of that provider that has an engine).
   */
  private accounts(config: ProjectConfig): Accounts {
    const pairs = new Map<string, { provider: AgentProvider; engineId: EngineId }>();
    const representative = new Map<AgentProvider, EngineId>();
    for (const member of config.team.members) {
      if (member.kind !== 'ai') continue;
      const provider = member.provider ?? DEFAULT_AGENT_PROVIDER;
      const engineId = this.engines.engineFor(config.project.key, member.handle);
      if (!engineId) continue;
      pairs.set(entryKey(engineId, provider), { provider, engineId });
      if (!representative.has(provider)) representative.set(provider, engineId);
    }
    return { pairs: [...pairs.values()], representative };
  }

  private async accountsByProject(): Promise<Map<string, Accounts>> {
    const result = new Map<string, Accounts>();
    for (const project of this.projects.summaries())
      result.set(project.key, this.accounts(await this.projects.config(project.key)));
    return result;
  }
}
