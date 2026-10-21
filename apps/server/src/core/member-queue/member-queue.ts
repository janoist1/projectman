import type {
  InboxItem,
  MemberQueueCloseReason,
  MemberQueueItem,
  MemberQueueSummary,
  MemberQueuesView,
  MemberQueueView,
  ProjectConfig,
  TeamMessage,
} from '@projectman/shared';
import {
  MEMBER_QUEUE_CLOSED_DEFAULT_MS,
  MEMBER_QUEUE_CLOSED_LIMIT,
  isIntegratorFixLimitDecision,
  isIntegratorInboxItem,
  memberOf,
  memberQueueSourceOf,
  messageRoute,
  messageWakes,
  nominalMessagePlace,
  operatorOf,
  SYSTEM_SENDER,
} from '@projectman/shared';
import type { MemberQueueSourceKey, StoredMemberQueueItem } from '../../db';
import { excerpt, newId } from '../../kernel';
import { isoNow } from '../base';
import type { DomainContext } from '../base';
import { wakeFactsFor } from '../messages';

/** What the queue reads of the projects: the loaded configuration, and the loading of every project's. */
export interface MemberQueueProjects {
  cachedConfig(key: string): ProjectConfig | undefined;
  config(key: string): Promise<ProjectConfig>;
  summaries(): Array<{ key: string }>;
}

const TITLE_MAX = 200;

/** The first line that says anything, cut. */
const titleOf = (text: string): string =>
  excerpt(text.split('\n').find((line) => line.trim() !== '') ?? '', TITLE_MAX);

const toView = (item: StoredMemberQueueItem): MemberQueueItem => ({
  ...item,
  source: memberQueueSourceOf(item.source.type, item.source.id),
});

/**
 * The member queue (PM-894, slice A): a row per message or Operator item addressed to an AI member,
 * kept true by the two writes that make the sources (a message's pending receipts, an inbox item) and by
 * `recover` at startup. It stores and shows; waking and delivery stay with the messaging (PM-925 takes them over).
 *
 * The sources call nothing: their repositories run `syncMessage` and `syncInbox` inside the transaction of
 * every write, so a row commits with its source. Both are idempotent reconcilers (the source's state decides),
 * and a failure of theirs is logged and never changes what the source write does.
 */
export class MemberQueue {
  private readonly ctx: DomainContext;
  private readonly projects: MemberQueueProjects;

  constructor(deps: { ctx: DomainContext; projects: MemberQueueProjects }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.ctx.repos.messages.onPendingChange((message) =>
      this.guarded('message', message.id, () => this.syncMessage(message)),
    );
    this.ctx.repos.inbox.onChange((item) => this.guarded('inbox', item.id, () => this.syncInbox(item)));
  }

  private guarded(source: string, id: string, work: () => void): void {
    try {
      work();
    } catch (err) {
      this.ctx.logger.warn({ err, source, id }, 'keeping the member queue true failed');
    }
  }

  private changed(items: Array<Pick<StoredMemberQueueItem, 'projectKey' | 'member'>>): void {
    const seen = new Set<string>();
    for (const { projectKey, member } of items) {
      const key = `${projectKey}\n${member}`;
      if (seen.has(key)) continue;
      seen.add(key);
      this.ctx.bus.publish({ type: 'member_queue_changed', projectKey, member });
    }
  }

  /**
   * Makes the message's items equal its pending receipts: an item for each AI recipient it is pending for,
   * and the open items of the others closed (delivered, or taken away some other way).
   */
  syncMessage(message: TeamMessage): void {
    const config = this.projects.cachedConfig(message.projectKey);
    if (!config) {
      this.ctx.logger.warn({ id: message.id }, 'the member queue has no configuration for a message');
      return;
    }
    const repo = this.ctx.repos.memberQueue;
    const pending = new Set(this.ctx.repos.messages.pendingHandlesOf(message.id));
    const source: MemberQueueSourceKey = { type: 'message', id: message.id };
    const touched: StoredMemberQueueItem[] = [];
    const at = isoNow(this.ctx);
    for (const handle of pending) {
      if (memberOf(config, handle)?.kind !== 'ai') continue;
      const item = {
        id: newId('mqi'),
        projectKey: message.projectKey,
        member: handle,
        kind: 'message' as const,
        source,
        place: nominalMessagePlace(config, handle, messageRoute(message, handle), message.from),
        taskKey: message.taskKey,
        wake: messageWakes(message, wakeFactsFor(this.ctx, config, message, handle), null),
        title: titleOf(message.body),
        from: message.from === SYSTEM_SENDER ? null : message.from,
        queuedAt: message.createdAt,
      };
      if (repo.insert(item)) touched.push(repo.get(item.id)!);
    }
    for (const open of repo.listOpenOfSource(message.projectKey, source)) {
      if (pending.has(open.member)) continue;
      const receipt = message.receipts?.find((r) => r.handle === open.member);
      const delivered = !!receipt?.deliveredAt && !receipt.handedOffTo;
      touched.push(
        ...repo.closeBySource(message.projectKey, source, {
          state: delivered ? 'done' : 'cancelled',
          reason: delivered ? 'delivered' : 'source_closed',
          at,
          member: open.member,
        }),
      );
    }
    this.changed(touched);
  }

  /**
   * Makes the Operator's item of an inbox item true: queued while the item is open and addressed to the
   * integrator (a todo, or a fix limit decision), closed otherwise: done when the integrator resolved it,
   * cancelled when anything else ended it, escalation to the owner included.
   */
  syncInbox(item: InboxItem): void {
    const config = this.projects.cachedConfig(item.projectKey);
    if (!config) {
      this.ctx.logger.warn({ id: item.id }, 'the member queue has no configuration for an inbox item');
      return;
    }
    if (item.kind !== 'question' && item.kind !== 'decision') return;
    const repo = this.ctx.repos.memberQueue;
    const source: MemberQueueSourceKey = { type: 'inbox', id: item.id };
    const touched: StoredMemberQueueItem[] = [];
    const operator = operatorOf(config);
    if (item.state === 'open' && isIntegratorInboxItem(item)) {
      if (!operator) return;
      const row = {
        id: newId('mqi'),
        projectKey: item.projectKey,
        member: operator.handle,
        kind: isIntegratorFixLimitDecision(item) ? ('fix_limit' as const) : ('todo' as const),
        source,
        place: { type: 'general' as const },
        taskKey: item.taskKey,
        wake: true,
        title: titleOf(item.title),
        from: null,
        queuedAt: isoNow(this.ctx),
      };
      if (repo.insert(row)) touched.push(repo.get(row.id)!);
    } else {
      const resolution = item.state === 'resolved' ? item.resolution : null;
      const byIntegrator = !!resolution && (resolution.integratorTodo || resolution.integratorFixLimit);
      const reason: MemberQueueCloseReason = byIntegrator ? 'resolved' : 'source_closed';
      touched.push(
        ...repo.closeBySource(item.projectKey, source, {
          state: byIntegrator ? 'done' : 'cancelled',
          reason,
          at: isoNow(this.ctx),
        }),
      );
    }
    this.changed(touched);
  }

  /**
   * Startup: fills in what the source writes did not (an item of before this slice, a failed sync), and closes
   * what no longer holds. Safe to run any number of times.
   */
  async recover(): Promise<void> {
    for (const { key } of this.projects.summaries())
      await this.projects.config(key).catch((err: unknown) => {
        this.ctx.logger.warn({ err, projectKey: key }, 'the member queue could not load a configuration');
      });
    const { repos } = this.ctx;
    this.ctx.unitOfWork(() => {
      for (const item of repos.inbox.listOpen()) this.guarded('inbox', item.id, () => this.syncInbox(item));
      for (const row of repos.memberQueue.listOpenOfType('inbox')) {
        const item = repos.inbox.get(row.source.id);
        if (item) this.guarded('inbox', item.id, () => this.syncInbox(item));
        else
          this.changed(
            repos.memberQueue.closeBySource(row.projectKey, row.source, {
              state: 'cancelled',
              reason: 'source_closed',
              at: isoNow(this.ctx),
            }),
          );
      }
      const messageIds = new Set([
        ...repos.memberQueue.pendingMessagesWithoutItem().map((p) => p.messageId),
        ...repos.memberQueue.openMessageItemsNotPending().map((q) => q.source.id),
      ]);
      for (const id of messageIds) {
        const message = repos.messages.get(id);
        if (message) this.guarded('message', id, () => this.syncMessage(message));
      }
    });
  }

  /** One member's queue: the open items, the ones closed since `closedSince` (default 24 hours) and whether it ever had any. */
  view(projectKey: string, member: string, closedSince?: Date): MemberQueueView {
    const repo = this.ctx.repos.memberQueue;
    const since = closedSince ?? new Date(this.ctx.now().getTime() - MEMBER_QUEUE_CLOSED_DEFAULT_MS);
    return {
      member,
      items: repo.listOpen(projectKey, member).map(toView),
      closed: repo.listClosed(projectKey, member, since.toISOString(), MEMBER_QUEUE_CLOSED_LIMIT).map(toView),
      everQueued: repo.everQueued(projectKey, member),
    };
  }

  /** Every AI member of the project in configuration order, members with nothing waiting included. */
  summaries(projectKey: string, config: Pick<ProjectConfig, 'team'>): MemberQueuesView {
    const counted = new Map(this.ctx.repos.memberQueue.summaries(projectKey).map((s) => [s.member, s]));
    const empty = (member: string): MemberQueueSummary => ({
      member,
      queued: 0,
      processing: 0,
      waking: 0,
      oldestQueuedAt: null,
    });
    return {
      members: config.team.members
        .filter((m) => m.kind === 'ai')
        .map((m) => counted.get(m.handle) ?? empty(m.handle)),
    };
  }
}
