import type { AgentProvider } from '@projectman/shared';

export const PROVIDER_COOLDOWN_INITIAL_MS = 15 * 60_000;
export const PROVIDER_COOLDOWN_MAX_MS = 240 * 60_000;

/**
 * Shared provider credentials require an instance-wide cooldown. This state intentionally
 * lives only in memory: after a server restart the next 429 arms the cooldown again.
 */
export class ProviderCooldowns {
  private readonly entries = new Map<AgentProvider, { until: Date; streak: number }>();

  hit(provider: AgentProvider, at: Date): { until: Date; streak: number } {
    const streak = (this.entries.get(provider)?.streak ?? 0) + 1;
    const delay = Math.min(
      PROVIDER_COOLDOWN_INITIAL_MS * 2 ** Math.min(streak - 1, 4),
      PROVIDER_COOLDOWN_MAX_MS,
    );
    const entry = { until: new Date(at.getTime() + delay), streak };
    this.entries.set(provider, entry);
    return { ...entry, until: new Date(entry.until) };
  }

  check(provider: AgentProvider, now: Date): { until: Date } | null {
    const entry = this.entries.get(provider);
    return entry && entry.until > now ? { until: new Date(entry.until) } : null;
  }

  succeeded(provider: AgentProvider): void {
    this.entries.delete(provider);
  }
}
