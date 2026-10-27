import type { OperatorPauses } from './ports';
import {
  isOnLeave,
  managerConversationOf,
  nominalMessagePlace,
  OPERATOR_SIGNAL_ROUND_FROM,
  operatorConversationOf,
  operatorOf,
  ownerHandles,
  projectManagerOf,
  sessionWorkItemOf,
  TaskStartWaiting,
} from '@projectman/shared';
import type {
  AiMemberConfig,
  OperatorChannel,
  ProjectManagerChannel,
  ProjectManagerCorner,
  WorkItemRef,
} from '@projectman/shared';
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
    pauses: Pick<OperatorPauses, 'projectView'>;
    operatorRequests: OperatorRequests;
    operatorSignals: OperatorSignals;
  };

  constructor(deps: ProjectManagerChannels['deps']) {
    this.deps = deps;
  }

  /**
   * The viewer's conversation with the project manager in the corner (PM-1042), plus its latest requests and
   * their steps: the owners share one, every other person has their own and only reads and answers in it
   * (PM-475, decision 59). The system signals and the queue are the owners' business, so a person reading along
   * sees them empty.
   */
  async view(projectKey: string, viewer: string): Promise<ProjectManagerCorner> {
    const config = await this.deps.projects.config(projectKey);
    const manager = projectManagerOf(config);
    return this.cornerOf(
      projectKey,
      viewer,
      manager,
      managerConversationOf(config, viewer),
      // The session and its state are where a message to the manager really goes, so they follow the route when
      // a person who is not an owner gets a conversation of their own (PM-1080).
      manager
        ? nominalMessagePlace(config, manager.handle, { type: 'general' }, viewer)
        : { type: 'general' },
      ownerHandles(config),
    );
  }

  /**
   * The viewer's conversation with the Operator, shaped like the corner (PM-463, PM-475). Until the Operator
   * leaves the app (PM-1045).
   */
  async operatorView(projectKey: string, viewer: string): Promise<OperatorChannel> {
    const config = await this.deps.projects.config(projectKey);
    const conversation = operatorConversationOf(config, viewer);
    return this.cornerOf(
      projectKey,
      viewer,
      operatorOf(config),
      conversation,
      conversation,
      // The owners' channel also lists the rounds of the Operator's own steps on signals (PM-545).
      [...ownerHandles(config), OPERATOR_SIGNAL_ROUND_FROM],
    );
  }

  private async cornerOf(
    projectKey: string,
    viewer: string,
    member: AiMemberConfig | null,
    conversation: WorkItemRef,
    place: WorkItemRef,
    ownerRequestSenders: string[],
  ): Promise<ProjectManagerCorner> {
    const channel = await this.channelOf(projectKey, member, place);
    const readOnly = conversation.type === 'general' && conversation.with !== undefined;
    // Like the signals, the queue is the owners' business: a person reading along sees it empty.
    const queued =
      member && !readOnly ? this.deps.ctx.repos.memberQueue.listOpen(projectKey, member.handle) : [];
    const current = queued.find((item) => item.state === 'processing');
    return {
      ...channel,
      requests: this.deps.operatorRequests.views(
        projectKey,
        readOnly ? [viewer] : ownerRequestSenders,
        member?.handle,
      ),
      readOnly,
      // The system signals are the owners' business (a card key, a subject): a person reading along sees none.
      ...(readOnly ? { signals: [], openSignals: 0 } : this.deps.operatorSignals.channel(projectKey)),
      queue: { open: queued.length, current: current ? { id: current.id, title: current.title } : null },
    };
  }

  private async channelOf(
    projectKey: string,
    manager: AiMemberConfig | null,
    conversation: WorkItemRef = { type: 'general' },
  ): Promise<ProjectManagerChannel> {
    const { ctx, pauses } = this.deps;
    if (!manager) return { member: null, state: 'missing', sessionId: null };
    const session = ctx.repos.sessions.findByWorkItem(projectKey, manager.handle, conversation);
    const base = {
      member: { handle: manager.handle, displayName: manager.displayName, onLeave: isOnLeave(manager) },
      sessionId: session?.id ?? null,
    };
    if (isOnLeave(manager)) return { ...base, state: 'on_leave' };
    // What the queue holds for this conversation and cannot start yet carries the code of what stops it.
    const wi = encodeWorkItem(conversation);
    const waiting = ctx.repos.memberQueue
      .listOpen(projectKey, manager.handle)
      .flatMap((item) => {
        const encoded = encodeWorkItem(sessionWorkItemOf(manager, item.place));
        const reason = item.wait ? TaskStartWaiting.shape.reason.safeParse(item.wait.code) : null;
        return item.state === 'queued' &&
          item.wake &&
          item.wait &&
          reason?.success &&
          encoded.type === wi.type &&
          encoded.ref === wi.ref
          ? [{ reason: reason.data, since: item.wait.at }]
          : [];
      })
      .sort((a, b) => a.since.localeCompare(b.since))[0];
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
