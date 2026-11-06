import {
  MEMBER_QUEUE_CLOSED_DEFAULT_MS,
  MEMBER_QUEUE_CLOSED_LIMIT,
  WORK_QUEUE_OPEN_LIMIT,
  WORK_QUEUE_OPEN_PREVIEW,
  WorkQueueWaitFacts,
  canSeeWorkQueue,
  canSeeWorkQueueItem,
  canSeeWorkQueueItems,
  isIntegratorFixLimitDecision,
  memberQueueSourceOf,
  projectManagerOf,
  sameWorkItem,
  sessionWorkItemOf,
  workQueueScopeOf,
  workQueueReasonOf,
  workQueueSourceNeedsFacts,
} from '@projectman/shared';
import type {
  AiMemberConfig,
  InboxItem,
  MemberQueueSource,
  ProjectConfig,
  Session,
  WorkQueueConnection,
  WorkQueueDetail,
  WorkQueueGroup,
  WorkQueueItem,
  WorkQueueRef,
  WorkQueueSourceFacts,
  WorkQueueViewer,
  WorkQueuesView,
} from '@projectman/shared';
import type { DomainContext } from '../../core/base';
import type { InboxService, IntegratorTodoAccess } from '../../core/inbox';
import type { ProjectService } from '../../core/projects';
import type { StoredMemberQueueItem } from '../../db';
import { DomainError, forbidden } from '../../kernel';

interface Deps {
  ctx: DomainContext;
  projects: Pick<ProjectService, 'config'>;
  inbox: Pick<InboxService, 'integratorQueue'>;
  integratorAccess?: IntegratorTodoAccess;
}

/** The viewer's reading of one queue, before it is cut to a group. */
interface Reading {
  /** Every open item the viewer may see, the order of the queue. */
  open: WorkQueueItem[];
  everQueued: boolean;
  restricted: boolean;
  connections?: WorkQueueConnection[];
}

const byQueueOrder = (a: WorkQueueItem, b: WorkQueueItem) =>
  Number(b.state === 'processing') - Number(a.state === 'processing') ||
  a.queuedAt.localeCompare(b.queuedAt) ||
  a.id.localeCompare(b.id);

/**
 * The work queues (PM-1294): what waits for the AI members (their member queues) and for the connected Claude (the
 * open items addressed to the integrator) in one read model. Every item is first filtered by the read rule of its
 * source; counts, `everQueued` and the preview come only from what is left, so a hidden item leaves no trace.
 */
export class WorkQueues {
  private readonly deps: Deps;

  constructor(deps: Deps) {
    this.deps = deps;
    // A key created or revoked changes who is connected: every project's viewers read the connections again.
    deps.integratorAccess?.onChange?.(() => {
      for (const project of deps.ctx.repos.projects.list())
        deps.ctx.bus.publish({ type: 'integrator_connections_changed', projectKey: project.key });
    });
  }

  /** Every AI member's queue in the configured order, then the integrator's, as the viewer may read them. */
  async view(projectKey: string, viewer: WorkQueueViewer): Promise<WorkQueuesView> {
    const scope = workQueueScopeOf(viewer);
    if (!scope) throw forbidden('work_queues_forbidden', 'the work queues are not for this access');
    const config = await this.deps.projects.config(projectKey);
    const isProjectManager = this.projectManagerCheck(config);
    const refs = this.refsOf(config).filter((ref) => canSeeWorkQueue(viewer, ref, isProjectManager));
    const openOfProject = this.deps.ctx.repos.memberQueue.listOpenOfProject(projectKey);
    const live = this.deps.ctx.repos.sessions.listLive(projectKey);
    const ever = this.deps.ctx.repos.memberQueue.everQueuedMembers(projectKey);
    const groups = refs.map((ref) => {
      const reading =
        ref.type === 'member'
          ? this.readMember(
              projectKey,
              viewer,
              config,
              ref.member,
              openOfProject.filter((item) => item.member === ref.member),
              live,
              ever.has(ref.member),
            )
          : this.readIntegrator(projectKey, viewer, config);
      return this.groupOf(ref, reading, WORK_QUEUE_OPEN_PREVIEW);
    });
    return { scope, groups, readAt: this.deps.ctx.now().toISOString() };
  }

  /** One queue with its closed items since `closedSince` (default 24 hours). */
  async detail(
    projectKey: string,
    viewer: WorkQueueViewer,
    ref: WorkQueueRef,
    closedSince?: Date,
  ): Promise<WorkQueueDetail> {
    const config = await this.deps.projects.config(projectKey);
    if (!canSeeWorkQueue(viewer, ref, this.projectManagerCheck(config)))
      throw forbidden('work_queues_forbidden', 'this work queue is not for this access');
    if (ref.type === 'member' && !this.aiMemberOf(config, ref.member))
      throw new DomainError('unknown_member', `no AI member ${ref.member} in this project`, { status: 404 });
    const since = closedSince ?? new Date(this.deps.ctx.now().getTime() - MEMBER_QUEUE_CLOSED_DEFAULT_MS);
    const live = this.deps.ctx.repos.sessions.listLive(projectKey);
    if (ref.type === 'integrator') {
      const reading = this.readIntegrator(projectKey, viewer, config);
      return {
        ...this.groupOf(ref, reading, WORK_QUEUE_OPEN_LIMIT),
        closed: reading.restricted ? [] : this.integratorClosed(projectKey, viewer, since),
      };
    }
    const repo = this.deps.ctx.repos.memberQueue;
    const reading = this.readMember(
      projectKey,
      viewer,
      config,
      ref.member,
      repo.listOpen(projectKey, ref.member),
      live,
      repo.everQueued(projectKey, ref.member),
    );
    // Hidden items leave gaps in the newest closed ones, so more are read than listed.
    const closed = this.visible(
      projectKey,
      viewer,
      repo.listClosed(projectKey, ref.member, since.toISOString(), MEMBER_QUEUE_CLOSED_LIMIT * 4),
    )
      .slice(0, MEMBER_QUEUE_CLOSED_LIMIT)
      .map((item) => this.itemOf(item, ref, []));
    return { ...this.groupOf(ref, reading, WORK_QUEUE_OPEN_LIMIT), closed };
  }

  /**
   * The project manager's corner counter: the items of the manager's queue the viewer may see, the one being
   * processed included. It is the group `view` gives the same viewer, counted the same way.
   */
  async pmSummary(
    projectKey: string,
    viewer: WorkQueueViewer,
  ): Promise<{ open: number; current: { id: string; title: string } | null }> {
    const none = { open: 0, current: null };
    const config = await this.deps.projects.config(projectKey);
    const manager = projectManagerOf(config);
    if (!manager || !workQueueScopeOf(viewer)) return none;
    const ref: WorkQueueRef = { type: 'member', member: manager.handle };
    if (!canSeeWorkQueue(viewer, ref, this.projectManagerCheck(config))) return none;
    const reading = this.readMember(
      projectKey,
      viewer,
      config,
      manager.handle,
      this.deps.ctx.repos.memberQueue.listOpen(projectKey, manager.handle),
      [],
      false,
    );
    const current = reading.open.find((item) => item.state === 'processing');
    return { open: reading.open.length, current: current ? { id: current.id, title: current.title } : null };
  }

  /**
   * The items of the member's queue (as the old queue view lists them) that the viewer may see; the one rule
   * the old route and the work queues share.
   */
  visibleToViewer<T extends { source: MemberQueueSource }>(
    projectKey: string,
    viewer: WorkQueueViewer,
    items: readonly T[],
  ): T[] {
    const facts = this.factsOf(
      projectKey,
      viewer,
      items.map((item) => item.source),
    );
    return items.filter((item) => canSeeWorkQueueItem(viewer, item, facts(item.source)));
  }

  /** Whether the viewer may see any item the member ever had (the "first use" state of the old view). */
  everQueuedFor(projectKey: string, viewer: WorkQueueViewer, member: string): boolean {
    return (
      this.deps.ctx.repos.memberQueue.everQueued(projectKey, member) &&
      this.everQueuedVisible(projectKey, viewer, member)
    );
  }

  // --- Member queues --------------------------------------------------------------------------------------

  private readMember(
    projectKey: string,
    viewer: WorkQueueViewer,
    config: ProjectConfig,
    member: string,
    stored: StoredMemberQueueItem[],
    live: Session[],
    hasHistory: boolean,
  ): Reading {
    const ref: WorkQueueRef = { type: 'member', member };
    const ai = this.aiMemberOf(config, member);
    const liveOf = live.filter((session) => session.member === member);
    const open = this.visible(projectKey, viewer, stored)
      .map((item) => this.itemOf(item, ref, liveOf, ai))
      .sort(byQueueOrder);
    return {
      open,
      everQueued: open.length > 0 || (hasHistory && this.everQueuedVisible(projectKey, viewer, member)),
      restricted: false,
    };
  }

  private visible(
    projectKey: string,
    viewer: WorkQueueViewer,
    items: StoredMemberQueueItem[],
  ): StoredMemberQueueItem[] {
    const sources = items.map((item) => memberQueueSourceOf(item.source.type, item.source.id));
    const facts = this.factsOf(projectKey, viewer, sources);
    return items.filter((item, index) =>
      canSeeWorkQueueItem(viewer, { source: sources[index]! }, facts(sources[index]!)),
    );
  }

  /** `everQueued` from the member's whole history: it is true only if the viewer may see one of its items. */
  private everQueuedVisible(projectKey: string, viewer: WorkQueueViewer, member: string): boolean {
    const sources = this.deps.ctx.repos.memberQueue
      .sourcesOfMember(projectKey, member)
      .map((source) => memberQueueSourceOf(source.type, source.id));
    const facts = this.factsOf(projectKey, viewer, sources);
    return sources.some((source) => canSeeWorkQueueItem(viewer, { source }, facts(source)));
  }

  /** The source records the sources' read rules need, read together; a source that is missing has none. */
  private factsOf(
    projectKey: string,
    viewer: WorkQueueViewer,
    sources: readonly MemberQueueSource[],
  ): (source: MemberQueueSource) => WorkQueueSourceFacts {
    const { repos } = this.deps.ctx;
    const ids = (type: 'message' | 'inbox') => [
      ...new Set(
        sources.flatMap((source) =>
          workQueueSourceNeedsFacts(source) && source.type === type
            ? [source.type === 'message' ? source.messageId : source.inboxItemId]
            : [],
        ),
      ),
    ];
    const messages = repos.messages.getMany(ids('message'));
    const inbox = repos.inbox.getMany(ids('inbox'));
    return (source) => {
      if (source.type === 'message') {
        const message = messages.get(source.messageId);
        return { message: message && message.projectKey === projectKey ? message : null };
      }
      if (source.type === 'inbox') {
        const item = inbox.get(source.inboxItemId);
        return { inbox: item && item.projectKey === projectKey ? item : null };
      }
      return {};
    };
  }

  private itemOf(
    stored: StoredMemberQueueItem,
    queue: WorkQueueRef,
    live: readonly Session[],
    ai?: AiMemberConfig,
  ): WorkQueueItem {
    const queued = stored.state === 'queued';
    const code = queued ? (stored.wait?.code ?? null) : null;
    const placeLive = live.some((session) =>
      sameWorkItem(session.workItem, ai ? sessionWorkItemOf(ai, stored.place) : stored.place),
    );
    return {
      id: stored.id,
      queue,
      kind: stored.kind,
      source: memberQueueSourceOf(stored.source.type, stored.source.id),
      place: stored.place,
      title: stored.title,
      from: stored.from,
      taskKey: stored.taskKey,
      state: stored.state,
      queuedAt: stored.queuedAt,
      startedAt: stored.startedAt,
      reason: queued ? workQueueReasonOf({ code, wake: stored.wake, placeLive }) : null,
      reasonCode: code,
      reasonSince: queued ? (stored.wait?.at ?? null) : null,
      waitFacts: queued ? waitFactsOf(stored.waitDetails) : null,
      attempts: stored.attempts,
      restartedAt: stored.restartedAt,
      closedAt: stored.closedAt,
      closeReason: stored.closeReason,
      outcome: stored.outcome,
    };
  }

  // --- The integrator queue -------------------------------------------------------------------------------

  private readIntegrator(projectKey: string, viewer: WorkQueueViewer, config: ProjectConfig): Reading {
    const connections = (this.deps.integratorAccess?.connections?.(config) ?? []).map(
      (connection): WorkQueueConnection => ({
        owner: connection.ownerHandle,
        connectionId: connection.keyId,
        expiresAt: connection.expiresAt,
        lastUsedAt: connection.lastUsedAt,
        lastUsedChannel: connection.lastUsedChannel,
      }),
    );
    const ref: WorkQueueRef = { type: 'integrator' };
    // The items are the owner's alone; the admin sees that the queue and its connection exist, nothing of its content.
    if (!canSeeWorkQueueItems(viewer, ref))
      return { open: [], everQueued: false, restricted: true, connections };
    const open = this.deps.inbox
      .integratorQueue(projectKey, 'open', viewer, WORK_QUEUE_OPEN_LIMIT)
      .map((item) => this.integratorItemOf(item, connections.length > 0))
      .sort(byQueueOrder);
    const everQueued =
      open.length > 0 ||
      this.deps.inbox.integratorQueue(projectKey, 'all', viewer, WORK_QUEUE_OPEN_LIMIT).length > 0;
    return { open, everQueued, restricted: false, connections };
  }

  private integratorItemOf(item: InboxItem, connected: boolean): WorkQueueItem {
    const opened =
      typeof item.payload.integratorOpenedAt === 'string' ? item.payload.integratorOpenedAt : null;
    return {
      id: item.id,
      queue: { type: 'integrator' },
      kind: isIntegratorFixLimitDecision(item) ? 'fix_limit' : 'todo',
      source: { type: 'inbox', inboxItemId: item.id },
      place: item.taskKey ? { type: 'task', taskKey: item.taskKey } : { type: 'general' },
      title: item.title.slice(0, 200),
      from: item.source,
      taskKey: item.taskKey,
      state: 'queued',
      queuedAt: opened ?? item.createdAt,
      startedAt: null,
      reason: connected ? 'next_session' : 'human',
      reasonCode: null,
      reasonSince: null,
      waitFacts: null,
      attempts: 0,
      restartedAt: null,
      closedAt: null,
      closeReason: null,
      outcome: null,
    };
  }

  /** What was once opened to the integrator and has left its queue since: resolved, or passed on to the owners. */
  private integratorClosed(projectKey: string, viewer: WorkQueueViewer, since: Date): WorkQueueItem[] {
    const sinceIso = since.toISOString();
    const open = new Set(
      this.deps.inbox
        .integratorQueue(projectKey, 'open', viewer, WORK_QUEUE_OPEN_LIMIT)
        .map((item) => item.id),
    );
    return this.deps.inbox
      .integratorQueue(projectKey, 'all', viewer, WORK_QUEUE_OPEN_LIMIT)
      .filter((item) => !open.has(item.id))
      .flatMap((item) => {
        const escalated =
          typeof item.payload.integratorEscalatedAt === 'string' ? item.payload.integratorEscalatedAt : null;
        const base = this.integratorItemOf(item, false);
        const closed = escalated
          ? { state: 'handed_off' as const, closeReason: 'handed_off' as const, closedAt: escalated }
          : item.resolution
            ? { state: 'done' as const, closeReason: 'resolved' as const, closedAt: item.resolution.at }
            : null;
        return closed && closed.closedAt >= sinceIso ? [{ ...base, reason: null, ...closed }] : [];
      })
      .sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''))
      .slice(0, MEMBER_QUEUE_CLOSED_LIMIT);
  }

  // --- Shared ---------------------------------------------------------------------------------------------

  private groupOf(queue: WorkQueueRef, reading: Reading, previewLimit: number): WorkQueueGroup {
    const { open } = reading;
    return {
      queue,
      items: reading.restricted ? [] : open.slice(0, previewLimit),
      queued: reading.restricted ? null : open.filter((item) => item.state === 'queued').length,
      processing: reading.restricted ? null : open.filter((item) => item.state === 'processing').length,
      everQueued: reading.everQueued,
      ...(reading.connections ? { connections: reading.connections } : {}),
      restricted: reading.restricted,
    };
  }

  private refsOf(config: ProjectConfig): WorkQueueRef[] {
    return [
      ...config.team.members.flatMap((member): WorkQueueRef[] =>
        member.kind === 'ai' ? [{ type: 'member', member: member.handle }] : [],
      ),
      { type: 'integrator' },
    ];
  }

  private aiMemberOf(config: ProjectConfig, handle: string): AiMemberConfig | undefined {
    return config.team.members.find(
      (member): member is AiMemberConfig => member.kind === 'ai' && member.handle === handle,
    );
  }

  private projectManagerCheck(config: ProjectConfig): (handle: string) => boolean {
    const manager = projectManagerOf(config);
    return (handle) => manager?.handle === handle;
  }
}

/** What the wait shows of its stored details: the known keys only, each parsed on its own; nothing else leaves. */
function waitFactsOf(details: Record<string, unknown> | null): WorkQueueWaitFacts | null {
  if (!details) return null;
  const { shape } = WorkQueueWaitFacts;
  const keep = <T>(schema: { safeParse(value: unknown): { success: boolean; data?: T } }, value: unknown) => {
    const parsed = schema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  };
  const facts: WorkQueueWaitFacts = {
    member: keep(shape.member, details.member),
    until: keep(shape.until, details.until),
    taskKeys: keep(shape.taskKeys, details.prerequisites),
    labels: keep(shape.labels, details.labels),
  };
  const present = Object.fromEntries(Object.entries(facts).filter(([, value]) => value !== undefined));
  return Object.keys(present).length > 0 ? present : null;
}
