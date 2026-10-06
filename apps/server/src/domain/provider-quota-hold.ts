import type { AgentProvider, PlanUsage } from '@projectman/shared';

export const NANOGPT_RATE_HOLD_MS = 15 * 60_000;
type Hold = { since: Date; until: Date | null; kind: 'quota' | 'rate' | 'unknown' };

/**
 * Shared credentials require an instance-wide hold. The state lives only in memory: a
 * server restart loses it. Persisted quota deferrals restore an unknown hold, so only usage
 * is probed before inference resumes; a new 429 also arms it for sessions without a deferral.
 */
export class ProviderQuotaHolds {
  private readonly entries = new Map<AgentProvider, Hold>();

  start(provider: AgentProvider, at: Date): boolean {
    if (this.check(provider, at)) return false;
    this.entries.set(provider, { since: new Date(at), until: null, kind: 'unknown' });
    return true;
  }

  settle(provider: AgentProvider, usage: PlanUsage | null, at: Date): void {
    const entry = this.entries.get(provider);
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
  observed(provider: AgentProvider, usage: PlanUsage | null, at: Date): void {
    if (this.check(provider, at)?.kind !== 'unknown') return;
    if (usage?.weeklyPercent != null && usage.weeklyPercent < 99) this.entries.delete(provider);
    else this.settle(provider, usage, at);
  }

  check(provider: AgentProvider, now: Date): Pick<Hold, 'until' | 'kind'> | null {
    const entry = this.entries.get(provider);
    return entry && (entry.until === null || entry.until > now)
      ? { until: entry.until && new Date(entry.until), kind: entry.kind }
      : null;
  }
}
