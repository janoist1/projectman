import type { WaitingStarts, OperatorPauses } from './ports';
import {
  isOnLeave,
  OPERATOR_SIGNAL_ROUND_FROM,
  operatorConversationOf,
  operatorOf,
  ownerHandles,
  projectManagerOf,
} from '@projectman/shared';
import type { AiMemberConfig, OperatorChannel, ProjectManagerChannel, WorkItemRef } from '@projectman/shared';
import { encodeWorkItem } from '../../db';
import type { DomainContext } from '../../core/base';
import type { OperatorRequests } from './requests';
import type { OperatorSignals } from './signals';
import type { ProjectService } from '../../core/projects';

/** The project's permanent project-manager conversation and why it may have to wait. */
export class ProjectManagerChannels {
  private readonly deps: {
    ctx: DomainContext;
    projects: ProjectService;
    deferred: WaitingStarts;
    pauses: Pick<OperatorPauses, 'projectView'>;
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

  /**
   * The viewer's conversation with the Operator as the project manager's, plus its latest requests and their
   * steps (PM-463): the owners share one, every other person has their own and only reads and answers in it (PM-475).
   */
  async operatorView(projectKey: string, viewer: string): Promise<OperatorChannel> {
    const config = await this.deps.projects.config(projectKey);
    const operator = operatorOf(config);
    const conversation = operatorConversationOf(config, viewer);
    const channel = await this.channelOf(projectKey, operator, conversation);
    const readOnly = conversation.type === 'general' && conversation.with !== undefined;
    return {
      ...channel,
      // The owners' channel also lists the rounds of the Operator's own steps on signals (PM-545).
      requests: this.deps.operatorRequests.views(
        projectKey,
        readOnly ? [viewer] : [...ownerHandles(config), OPERATOR_SIGNAL_ROUND_FROM],
      ),
      readOnly,
      // The system signals are the owners' business (a card key, a subject): a person reading along sees none.
      ...(readOnly ? { signals: [], openSignals: 0 } : this.deps.operatorSignals.channel(projectKey)),
    };
  }

  private async channelOf(
    projectKey: string,
    manager: AiMemberConfig | null,
    conversation: WorkItemRef = { type: 'general' },
  ): Promise<ProjectManagerChannel> {
    const { ctx, deferred, pauses } = this.deps;
    if (!manager) return { member: null, state: 'missing', sessionId: null };
    const session = ctx.repos.sessions.findByWorkItem(projectKey, manager.handle, conversation);
    const base = {
      member: { handle: manager.handle, displayName: manager.displayName, onLeave: isOnLeave(manager) },
      sessionId: session?.id ?? null,
    };
    if (isOnLeave(manager)) return { ...base, state: 'on_leave' };
    const wi = encodeWorkItem(conversation);
    const waiting = deferred
      .list()
      .filter((entry) => entry.start.key === `message:${projectKey}:${manager.handle}:${wi.type}:${wi.ref}`)
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
