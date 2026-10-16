import type { ToolContext } from '../../contracts';
import { TeamToolError } from '../../contracts';
import type { ToolCaller } from '../caller';
import {
  coordinationMemberOf,
  isOperator,
  memberOf,
  messageRoute,
  sessionWorkItemOf,
} from '@projectman/shared';
import type { ProjectConfig, WorkItemRef } from '@projectman/shared';
import type { MessageToolsHandler } from '../../contracts';
import type { SentMessageRecipient, WorkspaceFile } from '../../contracts';
import type { DomainContext } from '../../core/base';
import type { Messaging } from '../../core/messages';
import type { MessageAttachmentService } from '../../core/attachments';
import { RELAY_WINDOW_MS, type OperatorRequests } from '../../services/operator';
import { aiActor } from '../../kernel';
import { toMessageToolError, toFileToolError, isOwner, OWNER_ONLY } from '../caller';

export class MessageTools implements MessageToolsHandler {
  private readonly calls: ToolCaller;
  private readonly ctx: DomainContext;
  private readonly messaging: Messaging;
  private readonly operatorRequests: Pick<OperatorRequests, 'roundFor'>;
  private readonly messageAttachments: Pick<
    MessageAttachmentService,
    'assertCanUpload' | 'upload' | 'delete'
  >;
  constructor(deps: {
    calls: ToolCaller;
    ctx: DomainContext;
    messaging: Messaging;
    operatorRequests: Pick<OperatorRequests, 'roundFor'>;
    messageAttachments: Pick<MessageAttachmentService, 'assertCanUpload' | 'upload' | 'delete'>;
  }) {
    this.calls = deps.calls;
    this.ctx = deps.ctx;
    this.messaging = deps.messaging;
    this.operatorRequests = deps.operatorRequests;
    this.messageAttachments = deps.messageAttachments;
  }

  async sendMessage(
    ctx: ToolContext,
    args: {
      to: string[];
      text: string;
      taskKey?: string;
      kind: 'action' | 'info';
      despiteWorkers?: boolean;
      signalId?: string;
      signalActionable?: boolean;
      signalIds?: string[];
      actionableSignalIds?: string[];
      /** Paths of files of the caller's session folder or working directory (PM-520). */
      attachments?: string[];
    },
  ): Promise<{
    messageId: string;
    deliveredTo: string[];
    recipients: SentMessageRecipient[];
    routed?: { handle: string; workItem: WorkItemRef }[];
    operator: boolean;
  }> {
    return this.calls.guard(async () => {
      const legacy = args.signalId !== undefined || args.signalActionable !== undefined;
      const batch = args.signalIds !== undefined || args.actionableSignalIds !== undefined;
      const ids = batch ? (args.signalIds ?? []) : args.signalId !== undefined ? [args.signalId] : [];
      const actionable = args.actionableSignalIds ?? [];
      if (
        (legacy && batch) ||
        ((legacy || batch) && ids.length === 0) ||
        ids.length > 20 ||
        new Set(ids).size !== ids.length ||
        new Set(actionable).size !== actionable.length ||
        actionable.some((id) => !ids.includes(id))
      )
        throw new TeamToolError('invalid', 'invalid_request: invalid signal presentation arguments.');
      const signal = legacy || batch;
      const who = await this.calls.callerWithRequest(
        ctx,
        'send_message',
        signal ? { ids, to: args.to } : undefined,
      );
      const { config, guest } = who;
      const operator = isOperator(memberOf(config, ctx.member));
      const coordinator = coordinationMemberOf(config)?.handle === ctx.member;
      // In a guest's conversation the Operator answers that person and nobody else; that is no step (PM-475).
      if (guest) {
        const other = args.to.find((handle) => handle !== guest.handle);
        if (other !== undefined || args.to.length === 0) {
          this.calls.recordRefusedWrite(who, 'send_message', other);
          throw new TeamToolError(
            'forbidden',
            `${OWNER_ONLY}: in this conversation you answer ${guest.handle} only; a message to anyone else is for the project owner to ask.`,
          );
        }
        if (args.taskKey !== undefined) this.calls.visibleTaskKey(ctx, guest, args.taskKey);
      }
      this.calls.assertOperatorMessageRecipients(ctx.member, who, args.to);
      // To the owner the Operator only reports; to anyone else it acts for the request: a step (PM-463).
      // A message has one step, so with several such recipients it names the first as its `member`.
      const elsewhere = guest ? undefined : args.to.find((handle) => !isOwner(config, handle));
      return this.calls.recorded(
        who,
        elsewhere !== undefined
          ? { action: 'message', taskKey: args.taskKey ?? ctx.taskKey ?? null, member: elsewhere }
          : null,
        async () => {
          // A person's decision or action is asked with ask_human, which lands in their "Rád vár" list; a message
          // to a person carries information only (PM-445). The whole call is refused, so no half message goes out.
          if (
            args.kind === 'action' &&
            args.to.some((handle) => memberOf(config, handle)?.kind === 'human')
          ) {
            throw new TeamToolError(
              'invalid',
              'use_ask_human: a human\'s decision or action is asked with ask_human; send_message to a human carries information only (kind "info"). Nothing was sent: ask the human with ask_human, and message AI members separately.',
            );
          }
          const taskKey =
            this.calls.taskKeyFor(ctx, args.taskKey) ??
            (who.request || guest ? null : this.repliedCardOf(ctx, config));
          // The files are stored first and bound in the same send: a file that cannot be read stops the
          // message, and the ones stored for it are removed (PM-520).
          const attachmentIds =
            args.attachments && args.attachments.length > 0
              ? await this.uploadMessageFiles(ctx, args.attachments)
              : [];
          // Humans have it in their messages now; AI recipients get it typed into their session
          // for the work item as soon as that session is idle (queued, never awaited here).
          const { message, recipients } = await this.messaging
            .sendReporting(
              ctx.projectKey,
              ctx.member,
              {
                to: args.to,
                text: args.text,
                taskKey,
                ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
              },
              {
                actor: aiActor(ctx.member),
                sessionId: ctx.sessionId,
                kind: args.kind,
                workerCheck: !args.despiteWorkers,
                // The report sits under the round of the own steps on signals when no request is open (PM-545).
                operatorRequest:
                  who.request?.id ??
                  (operator || coordinator ? this.operatorRequests.roundFor(ctx.sessionId)?.id : undefined),
                operatorSignals: signal
                  ? ids.map((id) => ({
                      id,
                      actionable: batch ? actionable.includes(id) : (args.signalActionable ?? false),
                    }))
                  : undefined,
                // The Operator is told what became of waking each recipient (PM-543); others' sends stay quick.
                ...(operator ? { awaitWake: true } : {}),
              },
            )
            .catch(async (err: unknown) => {
              await this.discardMessageFiles(ctx, attachmentIds);
              throw toMessageToolError(err);
            });
          const routed = (message.receipts ?? []).flatMap((r) =>
            r.route ? [{ handle: r.handle, workItem: r.route }] : [],
          );
          return {
            messageId: message.id,
            deliveredTo: message.to,
            recipients,
            operator,
            ...(routed.length > 0 ? { routed } : {}),
          };
        },
      );
    });
  }

  /**
   * Stores the files of a `send_message` as the caller's unsent message attachments (PM-520). All or
   * nothing: when one cannot be stored, the ones stored so far are deleted and the error names the file.
   */
  private async uploadMessageFiles(ctx: ToolContext, paths: readonly string[]): Promise<string[]> {
    const actor = aiActor(ctx.member);
    await this.messageAttachments.assertCanUpload(ctx.projectKey, actor);
    const ids: string[] = [];
    try {
      for (const requested of paths) {
        const file = await this.openSessionFile(ctx, requested, 'sent');
        try {
          const stored = await this.messageAttachments.upload({
            projectKey: ctx.projectKey,
            actor,
            fileName: file.name,
            content: file.stream(),
            beforeCommit: () => file.verifyUnchanged(),
          });
          ids.push(stored.id);
        } catch (err) {
          throw toFileToolError(err, requested, 'sent');
        } finally {
          await file.close();
        }
      }
      return ids;
    } catch (err) {
      await this.discardMessageFiles(ctx, ids);
      throw err;
    }
  }

  /** Removes unsent message files after a refused send; a failure is left to the 24 h sweep. */
  private async discardMessageFiles(ctx: ToolContext, ids: readonly string[]): Promise<void> {
    const actor = aiActor(ctx.member);
    for (const id of ids)
      await this.messageAttachments.delete(ctx.projectKey, id, actor).catch(() => undefined);
  }

  /**
   * The card a message with no card of its own is the reply to (PM-504): a member working in a general
   * session (no card) is often answering or forwarding a card's message that was typed into that session.
   * That is the latest recent message delivered to the member in a general session (its route for the
   * member is general: the project manager's and the Operator's card messages always are), when it is
   * about a card. A message that went to the member's own card session says nothing about this one.
   */
  private repliedCardOf(ctx: ToolContext, config: ProjectConfig): string | null {
    if (ctx.taskKey) return null;
    const workItem = this.ctx.repos.sessions.get(ctx.sessionId)?.workItem;
    if (workItem?.type !== 'general') return null;
    const member = memberOf(config, ctx.member);
    const cutoff = this.ctx.now().getTime() - RELAY_WINDOW_MS;
    const latest = this.ctx.repos.messages
      .list(ctx.projectKey, { member: ctx.member, limit: 20 })
      .findLast((message) => {
        const at = message.receipts?.find((r) => r.handle === ctx.member)?.deliveredAt;
        return (
          message.to.includes(ctx.member) &&
          at &&
          Date.parse(at) >= cutoff &&
          sessionWorkItemOf(member, messageRoute(message, ctx.member)).type === 'general'
        );
      });
    return latest?.taskKey ?? null;
  }

  /**
   * Opens a file of the caller's session for reading: a path inside its session folder or relative to
   * its working directory (`attach_file`, and the files of `send_message`). The directories are the ones
   * the server started the session with; the caller never names them. The session folder is the one the
   * server made for this process (it remembers it; the path is never derived from the id) and counts
   * only while it exists.
   */
  private async openSessionFile(
    ctx: ToolContext,
    requested: string,
    done: 'attached' | 'sent',
  ): Promise<WorkspaceFile> {
    return this.calls.openSessionFile(ctx, requested, done);
  }
}
