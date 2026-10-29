import { planUsagePause } from '@projectman/shared';
import type { AgentProvider, EngineId, PlanUsage } from '@projectman/shared';
import type { ProjectService } from '../../core/projects';

interface UsageWakeDeps {
  projects: Pick<ProjectService, 'summaries' | 'cachedConfig'>;
  /** Asks for a retry of what waits (the deferred starts and the member queues). */
  wake(): void;
}

/**
 * What waits for the plan usage to fall below the project's pause threshold starts without another event
 * (PM-1133): each measurement is compared with the verdict the project had of the account before, and a
 * pause that lifted asks for a retry. A project that was never paused by the account asks for nothing.
 */
export class UsageWake {
  private readonly deps: UsageWakeDeps;
  /** The projects (with the engine and provider of the account) the last measurement held back. */
  private readonly paused = new Set<string>();

  constructor(deps: UsageWakeDeps) {
    this.deps = deps;
  }

  observe(provider: AgentProvider, engineId: EngineId, usage: PlanUsage | null): void {
    let lifted = false;
    for (const { key } of this.deps.projects.summaries()) {
      const config = this.deps.projects.cachedConfig(key);
      if (!config) continue;
      const mark = `${key}\0${engineId}\0${provider}`;
      if (planUsagePause(provider, usage, config.team.limits.pauseAbovePlanUsagePercent))
        this.paused.add(mark);
      else if (this.paused.delete(mark)) lifted = true;
    }
    if (lifted) this.deps.wake();
  }
}
