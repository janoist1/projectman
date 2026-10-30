import { DEFAULT_AGENT_PROVIDER, planUsagePause } from '@projectman/shared';
import type { AgentProvider, EngineId, PlanUsage } from '@projectman/shared';
import type { ProjectService } from '../../core/projects';
import type { DomainContext } from '../../core/base';
import type { EngineDirectory } from '../../contracts';
import type { BackgroundTasks } from '../../kernel';
import type { MemberQueueWorker } from '../member-queue';

interface UsageWakeDeps {
  projects: Pick<ProjectService, 'summaries' | 'cachedConfig'>;
  ctx: DomainContext;
  engines: Pick<EngineDirectory, 'engineFor'>;
  background: BackgroundTasks;
  driver: Pick<MemberQueueWorker, 'ensure'>;
  retry(): void;
  standby?: boolean;
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
    for (const { key } of this.deps.projects.summaries()) {
      const config = this.deps.projects.cachedConfig(key);
      if (!config) continue;
      const mark = `${key}\0${engineId}\0${provider}`;
      if (planUsagePause(provider, usage, config.team.limits.pauseAbovePlanUsagePercent))
        this.paused.add(mark);
      else if (this.paused.delete(mark)) this.wake(key, provider, engineId);
    }
  }

  configChanged(projectKey: string, before: number | undefined, after: number): void {
    if (before !== undefined && before !== after) this.wake(projectKey);
  }

  private wake(projectKey: string, provider?: AgentProvider, engineId?: EngineId): void {
    if (this.deps.standby) return;
    this.deps.retry();
    const config = this.deps.projects.cachedConfig(projectKey);
    for (const open of this.deps.ctx.repos.memberQueue.listOpenMembers()) {
      if (open.projectKey !== projectKey) continue;
      const member = config?.team.members.find((candidate) => candidate.handle === open.member);
      if (provider && (member?.kind !== 'ai' || (member.provider ?? DEFAULT_AGENT_PROVIDER) !== provider))
        continue;
      if (engineId && this.deps.engines.engineFor(projectKey, open.member) !== engineId) continue;
      this.deps.background.run(
        () => this.deps.driver.ensure(projectKey, open.member),
        (err) =>
          this.deps.ctx.logger.warn(
            { err, projectKey, member: open.member },
            'could not wake the member queue after the plan usage changed',
          ),
      );
    }
  }
}
