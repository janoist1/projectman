import { isOnLeave, operatorOf, projectManagerOf } from '@projectman/shared';
import type { AiMemberConfig, OperatorChannel, ProjectManagerChannel } from '@projectman/shared';
import type { DomainContext } from './context';
import type { DeferredStarts } from './admission';
import type { OperatorRequests } from './operator-requests';
import type { OperatorSignals } from './operator-signals';
import type { PauseService } from './pause';
import type { ProjectService } from './projects';

/** The project's permanent project-manager conversation and why it may have to wait. */
export class ProjectManagerChannels {
  private readonly deps: {
    ctx: DomainContext;
    projects: ProjectService;
    deferred: DeferredStarts;
    pauses: PauseService;
    operatorRequests: OperatorRequests;
    operatorSignals: OperatorSignals;
  };

  constructor(deps: ProjectManagerChannels['deps']) {
    this.deps = deps;
  }

  async view(projectKey: string): Promise<ProjectManagerChannel> {
    const manager = projectManagerOf(await this.deps.projects.config(projectKey));
    return this.channelOf(projectKey, manager);
  }

  /** The Operator's one conversation as the project manager's, plus its latest requests and their steps (PM-463). */
  async operatorView(projectKey: string): Promise<OperatorChannel> {
    const operator = operatorOf(await this.deps.projects.config(projectKey));
    const channel = await this.channelOf(projectKey, operator);
    return {
      ...channel,
      requests: this.deps.operatorRequests.views(projectKey),
      ...this.deps.operatorSignals.channel(projectKey),
    };
  }

  private async channelOf(
    projectKey: string,
    manager: AiMemberConfig | null,
  ): Promise<ProjectManagerChannel> {
    const { ctx, deferred, pauses } = this.deps;
    if (!manager) return { member: null, state: 'missing', sessionId: null };
    const session = ctx.repos.sessions.findByWorkItem(projectKey, manager.handle, { type: 'general' });
    const base = {
      member: { handle: manager.handle, displayName: manager.displayName, onLeave: isOnLeave(manager) },
      sessionId: session?.id ?? null,
    };
    if (isOnLeave(manager)) return { ...base, state: 'on_leave' };
    const waiting = deferred
      .list()
      .filter((entry) => entry.start.key.startsWith(`message:${projectKey}:${manager.handle}:general:`))
      .sort((a, b) => a.waiting.since.localeCompare(b.waiting.since))[0]?.waiting;
    if (waiting) return { ...base, state: 'waiting', waiting };
    const pause = pauses.projectView(projectKey);
    const since = [pause.project?.requestedAt, pause.instance?.requestedAt]
      .filter((at) => at !== undefined)
      .sort()[0];
    if (since) return { ...base, state: 'waiting', waiting: { reason: 'team_paused', since } };
    if (session?.state === 'starting') return { ...base, state: 'starting' };
    if (session?.state === 'working' || session?.state === 'waiting_permission')
      return { ...base, state: 'working' };
    return { ...base, state: 'available' };
  }
}
