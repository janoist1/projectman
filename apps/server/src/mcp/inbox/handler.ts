import type { ToolContext } from '../../contracts';
import { TeamToolError } from '../../contracts';
import { type ToolCaller, toToolError } from '../caller';
import { questionPayloadOf } from '@projectman/shared';
import type {
  QuestionAttachment,
  QuestionOptionInput,
  QuestionResponsePurpose,
  QuestionRecipient,
} from '@projectman/shared';
import type { HumanQuestionsPort, InboxToolsHandler } from '../../contracts';
import type { DomainContext } from '../../core/base';
import { DomainError } from '../../kernel';
import type { InboxService } from '../../core/inbox';

export class InboxTools implements InboxToolsHandler {
  private readonly calls: ToolCaller;
  private readonly ctx: DomainContext;
  private readonly inbox: InboxService;
  private readonly humanQuestions: HumanQuestionsPort;
  constructor(deps: {
    calls: ToolCaller;
    ctx: DomainContext;
    inbox: InboxService;
    humanQuestions: HumanQuestionsPort;
  }) {
    this.calls = deps.calls;
    this.ctx = deps.ctx;
    this.inbox = deps.inbox;
    this.humanQuestions = deps.humanQuestions;
  }

  async decidePermissionRequest(
    ctx: ToolContext,
    args: { requestId: string; decision: 'allow' | 'deny' | 'escalate'; reason: string },
  ) {
    try {
      await this.calls.caller(ctx, 'decide_permission_request');
      const item = await this.inbox.resolveDelegated(ctx.projectKey, args.requestId, ctx.member, {
        decision: args.decision,
        reason: args.reason,
      });
      return {
        requestId: item.id,
        decision: args.decision,
        outcome: args.decision === 'escalate' ? 'handed to a person' : 'decided; the request is answered',
      };
    } catch (err) {
      if (err instanceof DomainError && err.code === 'inbox_item_closed') {
        const state = (err.details as { state?: string }).state;
        throw new TeamToolError(
          'invalid',
          state === 'expired'
            ? 'inbox_item_closed: expired — nothing reached the session'
            : 'inbox_item_closed: already decided',
        );
      }
      throw toToolError(err);
    }
  }

  async askHuman(
    ctx: ToolContext,
    args: {
      question: string;
      options?: QuestionOptionInput[];
      taskKey?: string;
      to?: string[];
      recommended?: string;
      recommendationReason?: string;
      details?: string;
      attachmentIds?: string[];
      /** The question asked again after the Operator screened it away (PM-558), and why a person must see it. */
      reaskOf?: string;
      reaskReason?: string;
      /** The open signal delivered to the asking coordinator that the question is about (PM-455). */
      signalId?: string;
      responsePurpose?: QuestionResponsePurpose;
      recipient?: QuestionRecipient;
    },
  ): Promise<{
    inboxItemId: string;
    approvalLabel?: string;
    attachments?: QuestionAttachment[];
    screening?: true;
  }> {
    return this.calls.guard(async () => {
      await this.calls.caller(ctx, 'ask_human');
      const signal = args.signalId ? this.ctx.repos.operatorSignals.get(args.signalId) : null;
      // Signals are delivered only to the coordinator, so "delivered to the asker" is the coordinator check.
      if (
        args.signalId &&
        (!signal ||
          signal.projectKey !== ctx.projectKey ||
          signal.deliveredTo !== ctx.member ||
          signal.resolvedAt ||
          !(signal.state === 'pending' || signal.state === 'open'))
      )
        throw new TeamToolError(
          'invalid',
          'signal_not_open: signal_id must name an open signal that was delivered to you.',
        );
      const taskKey = this.calls.taskKeyFor(ctx, args.taskKey ?? signal?.taskKey ?? undefined);
      return this.humanQuestions.ask(
        ctx.projectKey,
        { kind: 'member', member: ctx.member, sessionId: ctx.sessionId },
        { ...args, taskKey },
      );
    });
  }

  async withdrawQuestion(
    ctx: ToolContext,
    args: { itemId: string; reason: string },
  ): Promise<{ itemId: string }> {
    return this.calls.guard(async () => {
      await this.calls.caller(ctx, 'withdraw_question');
      const reason = args.reason.trim();
      if (!reason) throw new TeamToolError('invalid', 'The reason is empty.');
      const item = this.ctx.repos.inbox.get(args.itemId);
      if (!item || item.projectKey !== ctx.projectKey || item.kind !== 'question')
        throw new TeamToolError('not_found', `Question ${args.itemId} does not exist in this project.`);
      // A question the integrator asked through the bearer MCP is withdrawn by the integrator, not by the Operator's session.
      if (item.source !== ctx.member || questionPayloadOf(item)?.externalQuestion)
        throw new TeamToolError(
          'forbidden',
          `not_your_question: question ${item.id} was asked by ${item.source}; only the asker withdraws it.`,
        );
      const closed = await this.inbox.closeQuestion(item.id, {
        rule: 'withdrawn',
        by: ctx.member,
        note: reason,
      });
      if (!closed)
        throw new TeamToolError('invalid', `question_closed: question ${item.id} is not waiting any more.`);
      return { itemId: closed.id };
    });
  }
}
