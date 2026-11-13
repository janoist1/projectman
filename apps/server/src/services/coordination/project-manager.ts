import type { ProjectManagerPauses } from './ports';
import {
  isOnLeave,
  managerConversationOf,
  nominalMessagePlace,
  ownerHandles,
  projectManagerOf,
  sessionWorkItemOf,
  TaskStartWaiting,
} from '@projectman/shared';
import type {
  AiMemberConfig,
  ProjectManagerChannel,
  ProjectManagerCorner,
  WorkItemRef,
  WorkQueueViewer,
} from '@projectman/shared';
import { encodeWorkItem } from '../../db';
import type { DomainContext } from '../../core/base';
import type { ProjectManagerRequests } from './requests';
import type { ProjectManagerSignals } from './signals';
import type { WorkQueues } from './work-queues';
import type { ProjectService } from '../../core/projects';

/** The project's permanent project-manager conversation and why it may have to wait. */
export class ProjectManagerChannels {
  private readonly deps: {
    ctx: DomainContext;
    projects: ProjectService;
    pauses: Pick<ProjectManagerPauses, 'projectView'>;
    projectManagerRequests: ProjectManagerRequests;
    projectManagerSignals: ProjectManagerSignals;
    workQueues: Pick<WorkQueues, 'pmSummary'>;
  };

  constructor(deps: ProjectManagerChannels['deps']) {
    this.deps = deps;
  }

  /**
   * The viewer's conversation with the project manager in the corner (PM-1042), plus its latest requests and
   * their steps: the owners share one, every other person has their own and only reads and answers in it
   * (PM-475, decision 59). The system signals are the owners' business, so a person reading along sees them
   * empty; the queue count is the viewer's own reading of the manager's work queue (PM-1294).
   */
  async view(projectKey: string, viewer: WorkQueueViewer): Promise<ProjectManagerCorner> {
    const config = await this.deps.projects.config(projectKey);
    const manager = projectManagerOf(config);
    return this.cornerOf(
      projectKey,
      viewer,
      manager,
      managerConversationOf(config, viewer.handle),
      // The session and its state are where a message to the manager really goes, so they follow the route when
      // a person who is not an owner gets a conversation of their own (PM-1080).
      manager
        ? nominalMessagePlace(config, manager.handle, { type: 'general' }, viewer.handle)
        : { type: 'general' },
      ownerHandles(config),
    );
  }

  private async cornerOf(
    projectKey: string,
    viewer: WorkQueueViewer,
    member: AiMemberConfig | null,
    conversation: WorkItemRef,
    place: WorkItemRef,
    ownerRequestSenders: string[],
  ): Promise<ProjectManagerCorner> {
    const channel = await this.channelOf(projectKey, member, place);
    const readOnly = conversation.type === 'general' && conversation.with !== undefined;
    const queue = await this.deps.workQueues.pmSummary(projectKey, viewer);
    return {
      ...channel,
      requests: this.deps.projectManagerRequests.views(
        projectKey,
        readOnly ? [viewer.handle] : ownerRequestSenders,
        member?.handle,
      ),
      readOnly,
      // The system signals are the owners' business (a card key, a subject): a person reading along sees none.
      ...(readOnly ? { signals: [], openSignals: 0 } : this.deps.projectManagerSignals.channel(projectKey)),
      queue,
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
