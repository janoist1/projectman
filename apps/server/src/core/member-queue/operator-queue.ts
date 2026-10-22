import type {
  FixLimitOptionId,
  InboxItem,
  MemberQueueItem,
  OperatorHandoff,
  OperatorHandoffReason,
  OperatorQueueOutcome,
  QuestionTodo,
} from '@projectman/shared';
import { TODO_DONE_OPTION } from '@projectman/shared';
import { getLocale } from '@projectman/templates';
import type { StoredMemberQueueItem } from '../../db';
import { conflict, excerpt, invalid } from '../../kernel';
import type { DomainContext } from '../base';
import type { ProjectService } from '../projects';
import type { MemberQueue, PlannedClose } from './member-queue';

/** What the finisher asks of the inbox: the three ways the Operator ends an inbox item (PM-885). */
interface OperatorQueueInbox {
  resolveForOperatorQueue(
    projectKey: string,
    id: string,
    optionId: string,
    note: string,
    operator: string,
  ): Promise<InboxItem>;
  passOnToOwners(
    projectKey: string,
    id: string,
    operator: string,
    how: { note: string; handoff: OperatorHandoff },
  ): Promise<InboxItem>;
  openOperatorHandoffTodo(input: {
    projectKey: string;
    taskKey: string | null;
    operator: string;
    title: string;
    todo: QuestionTodo;
    handoff: OperatorHandoff;
  }): Promise<InboxItem>;
}

interface FinishQueueItemInput {
  projectKey: string;
  /** The Operator member that calls. */
  member: string;
  /** The session the call comes from; the item must be processing in it. */
  sessionId: string;
  itemId: string;
  outcome: 'done' | 'handed_off';
  summary: string;
  operationIds: string[];
  fixLimitOption?: FixLimitOptionId;
  handoff?: {
    reason: Exclude<OperatorHandoffReason, 'processing_failed'>;
    action: string;
    detail?: string;
    operationId?: string;
  };
}

const NOT_PROCESSING = 'queue_item_not_processing';

/**
 * The Operator ends its queue item (`finish_queue_item`, PM-885): done, or handed to the owner. The item's
 * source closes in the same step — a todo or a held decision in the inbox, a message only its queue row —
 * and the close of the row is planned first, so the reconciler writes the Operator's outcome and not a generic one.
 */
export class OperatorQueueFinisher {
  private readonly ctx: DomainContext;
  private readonly projects: Pick<ProjectService, 'config'>;
  private readonly queue: MemberQueue;
  private readonly inbox: OperatorQueueInbox;

  constructor(deps: {
    ctx: DomainContext;
    projects: Pick<ProjectService, 'config'>;
    queue: MemberQueue;
    inbox: OperatorQueueInbox;
  }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.queue = deps.queue;
    this.inbox = deps.inbox;
  }

  async finish(input: FinishQueueItemInput): Promise<MemberQueueItem> {
    const item = this.queue.stored(input.itemId);
    if (
      !item ||
      item.projectKey !== input.projectKey ||
      item.member !== input.member ||
      item.state !== 'processing' ||
      item.sessionId !== input.sessionId
    )
      throw conflict(NOT_PROCESSING, `queue item ${input.itemId} is not being processed by this session`);
    if (item.kind !== 'todo' && item.kind !== 'fix_limit' && item.kind !== 'message')
      throw invalid('invalid_request', `queue item ${input.itemId} is not an Operator item`);
    this.assertCombination(item, input);
    const operations = this.operationsOf(input);

    if (input.outcome === 'done') {
      const outcome: OperatorQueueOutcome = {
        summary: input.summary,
        operationIds: input.operationIds,
        machine: operations.machine,
        handoff: null,
      };
      await this.close(item, { state: 'done', reason: 'finished', outcome }, async () => {
        if (item.kind === 'message') return;
        const option = item.kind === 'fix_limit' ? (input.fixLimitOption as string) : TODO_DONE_OPTION.id;
        await this.inbox.resolveForOperatorQueue(
          item.projectKey,
          item.source.id,
          option,
          input.summary,
          input.member,
        );
      });
    } else {
      await this.handOff(item, { ...input, handoff: input.handoff! }, operations);
    }
    const closed = this.queue.get(item.id);
    if (!closed) throw conflict(NOT_PROCESSING, `queue item ${input.itemId} is gone`);
    return closed;
  }

  private assertCombination(item: StoredMemberQueueItem, input: FinishQueueItemInput): void {
    if (input.outcome === 'done') {
      if (input.handoff) throw invalid('invalid_request', 'a finished item has no handoff');
      if (item.kind === 'fix_limit' && !input.fixLimitOption)
        throw invalid('invalid_request', 'a fix limit decision needs fix_limit_option');
      if (item.kind !== 'fix_limit' && input.fixLimitOption)
        throw invalid('invalid_request', 'fix_limit_option belongs to a fix limit decision only');
      return;
    }
    if (!input.handoff) throw invalid('invalid_request', 'a handed-off item needs a handoff');
    if (input.fixLimitOption)
      throw invalid('invalid_request', 'fix_limit_option belongs to a finished decision only');
    if (input.handoff.operationId && input.handoff.reason !== 'owner_reserved')
      throw invalid('invalid_request', 'handoff.operation_id belongs to the reason owner_reserved');
  }

  /** Every named operation must exist in the project; `machine` is true when one ran on the supervisor. */
  private operationsOf(input: FinishQueueItemInput): { machine: boolean } {
    const ids = [...input.operationIds];
    if (input.handoff?.operationId) ids.push(input.handoff.operationId);
    let machine = false;
    for (const id of ids) {
      const operation = this.ctx.repos.superHandoffs.operation(input.projectKey, id);
      if (!operation) throw invalid('invalid_request', `unknown operation ${id}`);
      if (operation.command.kind === 'administration') machine = true;
    }
    return { machine };
  }

  /** Plans the close of the row, runs the source's write, and takes the plan back whatever happens. */
  private async close(
    item: StoredMemberQueueItem,
    close: PlannedClose,
    write: () => Promise<void>,
  ): Promise<void> {
    const unplan = this.queue.plan(item.id, close);
    try {
      await write();
    } catch (err) {
      if (isClosedConflict(err)) throw conflict(NOT_PROCESSING, `queue item ${item.id} is already closed`);
      throw err;
    } finally {
      unplan();
    }
    // A message has no source write that closes its row: the row ends here.
    if (item.kind === 'message') this.queue.finish(item, close);
  }

  /**
   * The Operator did not finish the item (its session ended in vain, or the attempts ran out): the owner
   * gets it to look at, in the project's language. The item need not be processing.
   */
  async handOffUnfinished(item: StoredMemberQueueItem): Promise<void> {
    const config = await this.projects.config(item.projectKey);
    const text = getLocale(config.project.language).operatorQueue;
    await this.handOff(
      item,
      {
        member: item.member,
        summary: text.failedSummary,
        operationIds: [],
        handoff: {
          reason: 'processing_failed',
          action: excerpt(text.failedAction(item.title), 300),
        },
      },
      { machine: false },
    );
  }

  private async handOff(
    item: StoredMemberQueueItem,
    input: Pick<FinishQueueItemInput, 'member' | 'summary' | 'operationIds'> & {
      handoff: {
        reason: OperatorHandoffReason;
        action: string;
        detail?: string;
        operationId?: string;
      };
    },
    operations: { machine: boolean },
  ): Promise<void> {
    const handoff = input.handoff;
    const operation = handoff.operationId
      ? this.ctx.repos.superHandoffs.operation(item.projectKey, handoff.operationId)
      : null;
    // owner_reserved with an operation that already asks the owner: that question is the hand-off.
    const ownQuestion =
      operation && operation.state === 'waiting_owner' && operation.ownerQuestionId
        ? operation.ownerQuestionId
        : null;
    if (handoff.operationId && !ownQuestion)
      throw invalid('invalid_request', `operation ${handoff.operationId} has no open owner question`);

    const record: OperatorHandoff = {
      queueItemId: item.id,
      reason: handoff.reason,
      action: handoff.action,
      detail: handoff.detail ?? null,
      operationId: handoff.operationId ?? null,
    };
    const outcome = (inboxItemId: string): OperatorQueueOutcome => ({
      summary: input.summary,
      operationIds: input.operationIds,
      machine: operations.machine,
      handoff: { reason: handoff.reason, inboxItemId },
    });

    if (item.kind === 'message') {
      const inboxItemId =
        ownQuestion ??
        (
          await this.inbox.openOperatorHandoffTodo({
            projectKey: item.projectKey,
            taskKey: item.taskKey,
            operator: input.member,
            title: excerpt(handoff.action, 200),
            todo: {
              what: handoffText(input.summary, handoff.detail),
              where: item.taskKey ?? 'general',
              expected: handoff.action,
              recipient: 'owner',
            },
            handoff: record,
          })
        ).id;
      await this.close(
        item,
        { state: 'handed_off', reason: 'handed_off', outcome: outcome(inboxItemId) },
        async () => {},
      );
      return;
    }

    if (ownQuestion && item.kind === 'todo') {
      // No second question: the operation's own owner question carries the ask; the todo closes with that note.
      await this.close(
        item,
        { state: 'handed_off', reason: 'handed_off', outcome: outcome(ownQuestion) },
        async () => {
          await this.inbox.resolveForOperatorQueue(
            item.projectKey,
            item.source.id,
            TODO_DONE_OPTION.id,
            handoffText(input.summary, handoff.detail),
            input.member,
          );
        },
      );
      return;
    }

    await this.close(
      item,
      { state: 'handed_off', reason: 'handed_off', outcome: outcome(item.source.id) },
      async () => {
        await this.inbox.passOnToOwners(item.projectKey, item.source.id, input.member, {
          note: handoffText(input.summary, handoff.detail),
          handoff: record,
        });
      },
    );
  }
}

const handoffText = (summary: string, detail: string | undefined): string =>
  excerpt(detail ? `${summary}\n\n${detail}` : summary, 2000);

const isClosedConflict = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'inbox_item_closed';
