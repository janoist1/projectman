import type { AgentProvider, EngineId, PlanUsage } from '@projectman/shared';

export const NANOGPT_RATE_HOLD_MS = 15 * 60_000;
/** Whose key a hold is on: the cloud's (`'host'`) or the own key file of an engine (its id), PM-1091. */
export type QuotaScope = 'host' | EngineId;
type Hold = { since: Date; until: Date | null; kind: 'quota' | 'rate' | 'unknown' };

/**
 * A hold per credential. The host's key is shared by the whole instance (`'host'`); an engine with its
 * own NanoGPT key (PM-1068) holds only its own members. Every other provider has the one `'host'` hold.
 * The state lives only in memory: a server restart loses it. The caller restores NanoGPT's unknown hold
 * from persisted quota deferrals (probing usage before inference), and Gemini's timed hold from its quota
 * alert. `scope` is the last parameter and defaults to `'host'`.
 */
export class ProviderQuotaHolds {
  private readonly entries = new Map<string, { provider: AgentProvider; scope: QuotaScope; hold: Hold }>();

  private static key(provider: AgentProvider, scope: QuotaScope): string {
    return provider === 'nanogpt' ? `${provider}\u0000${scope}` : provider;
  }

  private entry(provider: AgentProvider, scope: QuotaScope): Hold | undefined {
    return this.entries.get(ProviderQuotaHolds.key(provider, scope))?.hold;
  }

  private set(provider: AgentProvider, scope: QuotaScope, hold: Hold): void {
    const own = provider === 'nanogpt' ? scope : 'host';
    this.entries.set(ProviderQuotaHolds.key(provider, scope), { provider, scope: own, hold });
  }

  /** A reset reported by the CLI; concurrent failures retain the later reset. */
  until(provider: AgentProvider, until: Date, at: Date, scope: QuotaScope = 'host'): boolean {
    const previous = this.check(provider, at, scope);
    if (!Number.isFinite(until.getTime()) || until <= at) return false;
    if (!previous?.until || previous.until < until)
      this.set(provider, scope, { since: new Date(at), until: new Date(until), kind: 'quota' });
    return previous === null;
  }

  start(provider: AgentProvider, at: Date, scope: QuotaScope = 'host'): boolean {
    if (this.check(provider, at, scope)) return false;
    this.set(provider, scope, { since: new Date(at), until: null, kind: 'unknown' });
    return true;
  }

  settle(provider: AgentProvider, usage: PlanUsage | null, at: Date, scope: QuotaScope = 'host'): void {
    const entry = this.entry(provider, scope);
    if (!entry) return;
    const percent = usage?.weeklyPercent;
    if (percent === null || percent === undefined || !Number.isFinite(percent)) {
      entry.until = null;
      entry.kind = 'unknown';
      return;
    }
    if (percent >= 99) {
      const reset = usage?.weeklyResetsAt ? new Date(usage.weeklyResetsAt) : null;
      if (!reset || !Number.isFinite(reset.getTime()) || reset.getTime() <= at.getTime()) {
        entry.until = null;
        entry.kind = 'unknown';
        return;
      }
      entry.until = reset;
      entry.kind = 'quota';
    } else {
      entry.until = new Date(at.getTime() + NANOGPT_RATE_HOLD_MS);
      entry.kind = 'rate';
    }
  }

  /** A later usage-only probe can release an unknown hold without sending inference requests. */
  observed(provider: AgentProvider, usage: PlanUsage | null, at: Date, scope: QuotaScope = 'host'): void {
    if (this.check(provider, at, scope)?.kind !== 'unknown') return;
    if (usage?.weeklyPercent != null && usage.weeklyPercent < 99)
      this.entries.delete(ProviderQuotaHolds.key(provider, scope));
    else this.settle(provider, usage, at, scope);
  }

  check(provider: AgentProvider, now: Date, scope: QuotaScope = 'host'): Pick<Hold, 'until' | 'kind'> | null {
    const entry = this.entry(provider, scope);
    return entry && (entry.until === null || entry.until > now)
      ? { until: entry.until && new Date(entry.until), kind: entry.kind }
      : null;
  }

  /** The scopes where the provider's hold is unknown: only a usage probe of that key can lift it. */
  unknownScopes(provider: AgentProvider, now: Date): QuotaScope[] {
    return [...this.entries.values()].flatMap((e) =>
      e.provider === provider && this.check(provider, now, e.scope)?.kind === 'unknown' ? [e.scope] : [],
    );
  }
}
