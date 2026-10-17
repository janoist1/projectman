import {
  coordinationMemberOf,
  hasSuperOrigin,
  structuralReviewOf,
  structuralReviewContinuation,
  isOperator,
  isProjectManager,
  isUnreadBy,
  memberOf,
  messageRoute,
  operatorConversationOf,
  operatorKnowledgeApprovalOf,
  operatorKnowledgeContinuationOf,
  sameWorkItem,
  threadPeersOf,
} from '@projectman/shared';
import type {
  Actor,
  AnswerDelivery,
  InboxItem,
  MessageAttachmentRef,
  ProjectConfig,
  TeamMessage,
  TeamMessageAnswer,
  TeamThread,
  WorkItemRef,
} from '@projectman/shared';
import { isoNow } from '../../core/base';
import { wakeFactsFor, wakesFor } from './staleness';
import type { DomainContext } from '../../core/base';
import type { MessageRequests } from './ports';
import type { TimelineService } from '../../core/timeline';
import type { ProjectService } from '../../core/projects';
import { forbidden, notFound } from '../../kernel';
import { excerpt, newId, SYSTEM_ACTOR } from '../../kernel';

export interface RecordMessageInput {
  id?: string;
  kind?: TeamMessage['kind'];
  version?: TeamMessage['version'];
  subject?: TeamMessage['subject'];
  projectKey: string;
  from: string;
  to: string[];
  taskKey: string | null;
  body: string;
  actor: Actor;
  sessionId?: string | null;
  /** Set when the message is delivered at once (e.g. to humans only). */
  delivered?: boolean;
  humanRecipients?: string[];
  /** Recipients that get the message somewhere else than its default place (`routeFor`), by handle. */
  routes?: Record<string, WorkItemRef>;
  /** Set on the message that carries a person's answer to an AI member's question (PM-249). */
  answer?: TeamMessageAnswer;
  relayed?: TeamMessage['relayed'];
  origin?: TeamMessage['origin'];
  /** The Operator's request this message was sent during (PM-463). */
  operatorRequest?: string;
  operatorSignal?: string;
  /** The files the message carries (PM-516), already bound to it by `MessageAttachmentService.bindForSend`. */
  attachments?: MessageAttachmentRef[];
}

/**
 * Stored team messages (between any members, humans and AI) with their timeline entries, and
 * their receipts: delivered (typed into an AI recipient's session, or at once for a human) and
 * read (by a human recipient).
 */
export class MessageService {
  private questionProjection: (item: InboxItem) => InboxItem = (item) => item;
  registerQuestionProjection(project: (item: InboxItem) => InboxItem): void {
    this.questionProjection = project;
  }
  private readonly ctx: DomainContext;
  private readonly timeline: TimelineService;
  private readonly projects: ProjectService;

  private readonly operatorRequests: MessageRequests;
  private readonly coordinationRequests: MessageRequests;

  constructor(deps: {
    ctx: DomainContext;
    timeline: TimelineService;
    projects: ProjectService;
    operatorRequests: MessageRequests;
    coordinationRequests: MessageRequests;
  }) {
    this.ctx = deps.ctx;
    this.timeline = deps.timeline;
    this.projects = deps.projects;
    this.operatorRequests = deps.operatorRequests;
    this.coordinationRequests = deps.coordinationRequests;
  }

  get(id: string): TeamMessage | null {
    return this.ctx.repos.messages.get(id);
  }

  wakes(config: ProjectConfig, message: TeamMessage, recipient: string): boolean {
    return wakesFor(this.ctx, config, message, recipient);
  }

  record(input: RecordMessageInput): TeamMessage {
    // A super-mode origin names the Operator: a message from anyone else cannot carry it (PM-757).
    if (hasSuperOrigin(input.actor) && input.actor.handle !== input.from)
      throw new Error('a super-mode message must be sent from its actor');
    const at = isoNow(this.ctx);
    const message: TeamMessage = {
      id: input.id ?? newId('msg'),
      projectKey: input.projectKey,
      from: input.from,
      to: [...new Set(input.to)],
      taskKey: input.taskKey,
      body: input.body,
      createdAt: at,
      deliveredAt: input.delivered ? at : null,
      kind: input.kind,
      version: input.version,
      subject: input.subject,
      receipts: [...new Set(input.to)].map((handle) => ({
        handle,
        kind: input.humanRecipients?.includes(handle) ? 'human' : 'ai',
        deliveredAt: input.humanRecipients?.includes(handle) || input.delivered ? at : null,
        readAt: null,
        ...(input.routes?.[handle] ? { route: input.routes[handle] } : {}),
      })),
      ...(input.answer ? { answer: input.answer } : {}),
      ...(input.relayed ? { relayed: input.relayed } : {}),
      ...(input.actor.via ? { via: input.actor.via } : {}),
      ...(hasSuperOrigin(input.actor) ? { actor: input.actor } : {}),
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.operatorRequest ? { operatorRequest: input.operatorRequest } : {}),
      ...(input.operatorSignal ? { operatorSignal: input.operatorSignal } : {}),
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    };
    return this.ctx.unitOfWork(() => {
      this.ctx.repos.messages.insert(message);
      this.ctx.bus.publish({ type: 'team_message', projectKey: message.projectKey, message });
      this.timeline.append({
        projectKey: message.projectKey,
        taskKey: message.taskKey,
        sessionId: input.sessionId ?? null,
        actor: input.actor,
        type: 'team_message',
        data: {
          messageId: message.id,
          from: message.from,
          to: message.to,
          // A message of files alone is told by their names.
          excerpt: excerpt(message.body || (message.attachments ?? []).map((a) => a.fileName).join(', ')),
          kind: message.kind,
          version: message.version,
        },
      });
      return message;
    });
  }

  /** Messages an AI recipient has not received yet for a work item (where `messageRoute` puts them), oldest first. */
  waiting(projectKey: string, handle: string, workItem: WorkItemRef): TeamMessage[] {
    const config = this.projects.cachedConfig(projectKey);
    const recipient = config ? memberOf(config, handle) : undefined;
    // The project manager has one conversation: every route lands in it. The Operator has one per person who is
    // not an owner and one shared by the others (PM-475): a message lands in the one its route names.
    const operator = workItem.type === 'general' && isOperator(recipient);
    const allRoutes = workItem.type === 'general' && isProjectManager(recipient);
    // A task's session takes the messages routed to that task; any other chat takes everything not
    // routed to a task (general ones, and answers routed to a schedule run or meeting whose session ended).
    return this.ctx.repos.messages.pending(projectKey, handle).filter((m) => {
      if (allRoutes) return true;
      const route = messageRoute(m, handle);
      if (operator) return (route.type === 'general' ? route.with : undefined) === workItem.with;
      return workItem.type === 'task' ? sameWorkItem(route, workItem) : route.type !== 'task';
    });
  }

  markRecipientDelivered(id: string, handle: string): TeamMessage | null {
    // Receipt and authorization must commit together: a crash cannot consume a continuation
    // without opening its request, nor open a request for a receipt that rolled back.
    return this.ctx.unitOfWork(() => this.markRecipientDeliveredLocked(id, handle));
  }

  private markRecipientDeliveredLocked(id: string, handle: string): TeamMessage | null {
    const before = this.ctx.repos.messages.get(id);
    if (!before) return null;
    const at = isoNow(this.ctx);
    const receipts = (
      before.receipts ??
      before.to.map((h) => ({
        handle: h,
        kind: 'ai' as const,
        deliveredAt: before.deliveredAt,
        readAt: null,
      }))
    ).map((r) => (r.handle === handle && !r.deliveredAt ? { ...r, deliveredAt: at } : r));
    const deliveredAt = receipts.every((r) => r.deliveredAt) ? (before.deliveredAt ?? at) : null;
    const message = this.ctx.repos.messages.updateReceipts(id, receipts, deliveredAt);
    if (message) {
      this.ctx.bus.publish({ type: 'team_message', projectKey: message.projectKey, message });
      const first = !(before.receipts
        ? before.receipts.find((r) => r.handle === handle)?.deliveredAt
        : before.deliveredAt);
      if (first) {
        this.openOperatorRequest(message, handle);
        this.openCoordinationRequest(message, handle);
        this.recordAnswerDelivery(message, handle, { state: 'delivered', at });
      }
    }
    return message;
  }

  /** Track only the asking recipient; a late deferral cannot overwrite a completed receipt. */
  recordAnswerDelivery(message: TeamMessage, handle: string, delivery: AnswerDelivery): void {
    if (message.origin?.kind !== 'answer') return;
    const item = this.ctx.repos.inbox.get(message.origin.inboxItemId);
    if (!item || item.kind !== 'question' || item.source !== handle || item.projectKey !== message.projectKey)
      return;
    const previous = item.payload.answerDelivery as AnswerDelivery | undefined;
    if (delivery.state === 'waiting') {
      const latest = this.ctx.repos.messages.get(message.id);
      if (latest?.receipts?.find((r) => r.handle === handle)?.deliveredAt) return;
      if (previous?.state === 'waiting' && previous.reason === delivery.reason) return;
      if (previous?.state === 'waiting') delivery = { ...delivery, since: previous.since };
    } else if (previous?.state === 'delivered') return;
    const at = isoNow(this.ctx);
    const updated = this.ctx.repos.inbox.updatePayload(
      item.id,
      { ...item.payload, answerDelivery: delivery },
      at,
    );
    if (!updated) return;
    this.ctx.bus.publish({
      type: 'inbox_upserted',
      projectKey: item.projectKey,
      item: this.questionProjection(updated),
    });
    if (delivery.state === 'waiting' || previous?.state === 'waiting')
      this.timeline.append({
        projectKey: item.projectKey,
        taskKey: item.taskKey,
        sessionId: item.sessionId,
        actor: SYSTEM_ACTOR,
        type: 'question_answer_delivery',
        data: {
          inboxItemId: item.id,
          asker: handle,
          state: delivery.state,
          ...(delivery.state === 'waiting' ? { reason: delivery.reason } : {}),
        },
      });
  }

  /**
   * A person's message, or the owner's answer to the Operator's question, entered the Operator's session of
   * their conversation: the Operator may act on it until its turn ends (PM-463); for a person who is not an
   * owner it only reads and answers (PM-475). Anyone else's message (an AI member's, the system's) opens nothing.
   */
  private openOperatorRequest(message: TeamMessage, handle: string): void {
    const config = this.projects.cachedConfig(message.projectKey);
    if (!config || !isOperator(memberOf(config, handle))) return;
    if (message.origin?.kind === 'operator_knowledge_approval') {
      const item = this.ctx.repos.inbox.get(message.origin.inboxItemId);
      const payload = item && operatorKnowledgeApprovalOf(item);
      const owner = memberOf(config, message.from);
      const session = this.ctx.repos.sessions.findByWorkItem(message.projectKey, handle, { type: 'general' });
      if (!item || !payload || !session || !message.to.includes(handle)) return;
      const approved = operatorKnowledgeContinuationOf(item, {
        projectKey: message.projectKey,
        operator: handle,
        from: message.from,
        messageId: message.id,
        via: message.via,
        owner: owner?.kind === 'human' && owner.access === 'owner',
        approvedStep: this.ctx.repos.operatorRequests
          .steps(payload.requestId)
          .some(
            (step) =>
              step.id === payload.stepId &&
              step.inboxItemId === item.id &&
              step.status === 'approved' &&
              step.action === 'knowledge_change',
          ),
      });
      // A malformed approval origin must never fall back to a normal human-message request.
      if (!approved) return;
      this.operatorRequests.open({
        projectKey: message.projectKey,
        sessionId: session.id,
        source: 'approval',
        messageId: message.id,
        inboxItemId: item.id,
        from: message.from,
        text: message.body,
      });
      return;
    }
    const facts = wakeFactsFor(this.ctx, config, message, handle);
    if (!facts.fromHuman || !facts.fromOwnLogin) return;
    const session = this.ctx.repos.sessions.findByWorkItem(
      message.projectKey,
      handle,
      operatorConversationOf(config, message.from),
    );
    if (!session) return;
    this.operatorRequests.open({
      projectKey: message.projectKey,
      sessionId: session.id,
      source: message.answer ? 'answer' : 'message',
      messageId: message.id,
      inboxItemId: message.answer?.inboxItemId ?? null,
      from: message.from,
      text: message.answer?.answer ?? message.body,
    });
  }

  /** Only a delivered owner's own-login message or answer opens a PM request. Signal rounds never do. */
  private openCoordinationRequest(message: TeamMessage, handle: string): void {
    const config = this.projects.cachedConfig(message.projectKey);
    if (!config || coordinationMemberOf(config)?.handle !== handle) return;
    const owner = memberOf(config, message.from);
    if (
      owner?.kind !== 'human' ||
      owner.access !== 'owner' ||
      message.via ||
      !message.to.includes(handle) ||
      message.operatorRequest ||
      (message.origin && message.origin.kind !== 'answer')
    )
      return;
    if (message.operatorSignal) {
      const signal = this.ctx.repos.operatorSignals.get(message.operatorSignal);
      const presentation = signal?.messageId && this.ctx.repos.messages.get(signal.messageId);
      if (
        !signal ||
        signal.projectKey !== message.projectKey ||
        signal.state !== 'accepted' ||
        !signal.actionable ||
        signal.decidedBy !== message.from ||
        signal.deliveredTo !== handle ||
        !presentation ||
        presentation.projectKey !== message.projectKey ||
        presentation.from !== handle
      )
        return;
    }
    const route = messageRoute(message, handle);
    if (route.type === 'general' && route.with) return;
    const session = this.ctx.repos.sessions.findByWorkItem(message.projectKey, handle, { type: 'general' });
    if (!session || session.workItem.type !== 'general' || session.workItem.with) return;
    const answerItem = message.answer && this.ctx.repos.inbox.get(message.answer.inboxItemId);
    const structural = answerItem && structuralReviewOf(answerItem);
    if (structural && !structuralReviewContinuation(answerItem, message, handle, true)) return;
    this.coordinationRequests.open({
      projectKey: message.projectKey,
      sessionId: session.id,
      source: structural ? 'approval' : message.answer ? 'answer' : 'message',
      messageId: message.id,
      inboxItemId: message.answer?.inboxItemId ?? null,
      from: message.from,
      text: message.answer?.answer ?? message.body,
    });
  }

  /**
   * The message was for `handle`, whose card went to `to` (PM-342): its receipt is closed as handed on, so
   * the old member's session never takes it and the receiver gets it in the handoff message instead.
   */
  markRecipientForwarded(id: string, handle: string, to: string): TeamMessage | null {
    const before = this.ctx.repos.messages.get(id);
    if (!before?.receipts) return null;
    const at = isoNow(this.ctx);
    const receipts = before.receipts.map((r) =>
      r.handle === handle && !r.deliveredAt ? { ...r, deliveredAt: at, handedOffTo: to } : r,
    );
    const deliveredAt = receipts.every((r) => r.deliveredAt) ? (before.deliveredAt ?? at) : null;
    const message = this.ctx.repos.messages.updateReceipts(id, receipts, deliveredAt);
    if (message) this.ctx.bus.publish({ type: 'team_message', projectKey: message.projectKey, message });
    return message;
  }

  markRead(
    projectKey: string,
    id: string,
    handle: string,
    humanRecipients: string[] = [handle],
  ): TeamMessage {
    const before = this.ctx.repos.messages.get(id);
    if (!before || before.projectKey !== projectKey) throw notFound('message', id);
    if (!before.to.includes(handle))
      throw forbidden('not_a_recipient', 'Only a recipient may mark a message read');
    return this.applyRead(before, handle, humanRecipients);
  }

  /**
   * Marks the messages among `ids` read that were sent to `handle` and that they have not read yet
   * (an unknown, foreign, not-addressed or already read one is left out), as one unit with one
   * `team_message` event each. Returns the messages that changed, oldest first.
   */
  markReadMany(
    projectKey: string,
    ids: readonly string[],
    handle: string,
    humanRecipients: string[] = [handle],
  ): TeamMessage[] {
    return this.ctx.unitOfWork(() => {
      const changed: TeamMessage[] = [];
      for (const id of new Set(ids)) {
        const before = this.ctx.repos.messages.get(id);
        if (!before || before.projectKey !== projectKey || !isUnreadBy(before, handle)) continue;
        changed.push(this.applyRead(before, handle, humanRecipients));
      }
      return changed;
    });
  }

  /**
   * The member's conversations with the other members, the most recently active first: the peers
   * each message falls to by `threadPeersOf`, each with its latest message and unread count. It
   * counts over every message of the member, not over a page of them.
   */
  threads(projectKey: string, handle: string): TeamThread[] {
    const threads = new Map<string, { lastId: string; unreadCount: number }>();
    for (const summary of this.ctx.repos.messages.involving(projectKey, handle)) {
      const unread = isUnreadBy(summary, handle) ? 1 : 0;
      for (const peer of threadPeersOf(summary, handle)) {
        const thread = threads.get(peer);
        // Most recent last: re-inserting moves a conversation to the end of the iteration order.
        threads.delete(peer);
        threads.set(peer, { lastId: summary.id, unreadCount: (thread?.unreadCount ?? 0) + unread });
      }
    }
    return [...threads].reverse().map(([peer, { lastId, unreadCount }]) => ({
      peer,
      lastMessage: this.ctx.repos.messages.get(lastId)!,
      unreadCount,
    }));
  }

  private applyRead(before: TeamMessage, handle: string, humanRecipients: string[]): TeamMessage {
    const projectKey = before.projectKey;
    const id = before.id;
    const at = isoNow(this.ctx);
    const receipts = (
      before.receipts ??
      before.to.map((h) => ({
        handle: h,
        kind: humanRecipients.includes(h) ? ('human' as const) : ('ai' as const),
        deliveredAt: before.deliveredAt,
        readAt: null,
      }))
    ).map((r) =>
      r.handle === handle
        ? { ...r, kind: 'human' as const, deliveredAt: r.deliveredAt ?? at, readAt: r.readAt ?? at }
        : r,
    );
    const message = this.ctx.repos.messages.updateReceipts(id, receipts, before.deliveredAt)!;
    this.ctx.bus.publish({ type: 'team_message', projectKey, message });
    return message;
  }

  list(
    projectKey: string,
    filter: {
      taskKey?: string;
      member?: string;
      participant?: string;
      between?: [string, string];
      unreadFor?: string;
      limit?: number;
    } = {},
  ): TeamMessage[] {
    return this.ctx.repos.messages.list(projectKey, filter);
  }

  /** Messages to the member that they have not read. */
  countUnread(projectKey: string, handle: string): number {
    return this.ctx.repos.messages.countUnread(projectKey, handle);
  }
}
