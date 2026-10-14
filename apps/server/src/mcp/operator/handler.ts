import { isOperator, memberOf } from '@projectman/shared';
import type { OperatorOperation, ScreeningOutcome, QuestionTodo, Task } from '@projectman/shared';
import { TeamToolError } from '../../contracts';
import type { OperatorToolsHandler, MemberStartResult, ToolContext } from '../../contracts';
import type { DomainContext } from '../../domain/context';
import { DomainError } from '../../domain/errors';
import type { InboxService } from '../../domain/inbox';
import type { Messaging } from '../../domain/messaging';
import { recipientHasCardRole } from '../../domain/messaging';
import type { ProjectService } from '../../domain/projects';
import type { TaskService } from '../../domain/tasks';
import type { TaskStarts } from '../../runtime/admission';
import { aiActor } from '../../domain/util';
import type { ProjectState, OperatorActions } from '../../services/operator';
import { toToolError, toMessageToolError, type ToolCaller } from '../caller';

export class OperatorTools implements OperatorToolsHandler {
  private readonly calls: ToolCaller;
  private readonly ctx: DomainContext;
  private readonly projects: ProjectService;
  private readonly tasks: TaskService;
  private readonly inbox: InboxService;
  private readonly messaging: Pick<Messaging, 'answer' | 'forwardQuestion' | 'sendReporting'>;
  private readonly projectState: ProjectState;
  private readonly operatorActions: OperatorActions;
  private readonly taskStarts: TaskStarts;

  constructor(deps: {
    calls: ToolCaller;
    ctx: DomainContext;
    projects: ProjectService;
    tasks: TaskService;
    inbox: InboxService;
    messaging: Pick<Messaging, 'answer' | 'forwardQuestion' | 'sendReporting'>;
    projectState: ProjectState;
    operatorActions: OperatorActions;
    taskStarts: TaskStarts;
  }) {
    this.calls = deps.calls;
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.tasks = deps.tasks;
    this.inbox = deps.inbox;
    this.messaging = deps.messaging;
    this.projectState = deps.projectState;
    this.operatorActions = deps.operatorActions;
    this.taskStarts = deps.taskStarts;
  }

  async getProjectState(ctx: ToolContext, args: { taskKey?: string; messageId?: string }) {
    return this.calls.guard(async () => {
      const config = await this.calls.caller(ctx, 'get_project_state');
      const member = memberOf(config, ctx.member);
      if (!member || !isOperator(member))
        throw new TeamToolError('forbidden', 'operator_only: only the Operator may read project state.');
      if (args.messageId !== undefined) {
        if (args.taskKey !== undefined)
          throw new TeamToolError('invalid', 'Give either task_key or message_id, not both.');
        return this.projectState.message(ctx.projectKey, args.messageId);
      }
      return args.taskKey
        ? this.projectState.task(ctx.projectKey, this.calls.validTaskKey(ctx, args.taskKey))
        : this.projectState.overview(ctx.projectKey);
    });
  }

  async operate(ctx: ToolContext, args: { title: string; operation: OperatorOperation }) {
    const config = await this.projects.config(ctx.projectKey);
    if (!isOperator(memberOf(config, ctx.member)))
      throw new TeamToolError('forbidden', 'operator_only: only the Operator may operate.');
    const caller = await this.calls.callerWithRequest(ctx, 'operate');
    return this.operatorActions
      .run(ctx.projectKey, caller.request!.id, args.title, args.operation)
      .catch((err: unknown) => {
        if (err instanceof DomainError)
          throw new TeamToolError(
            err.status === 403 ? 'forbidden' : 'invalid',
            `${err.code}: ${err.message}`,
          );
        throw err;
      });
  }

  /**
   * The Operator settles a question it screens (PM-558): it answers it, passes it to a member, closes it as
   * moot, or sends it on to the people as a decision or a todo. Only the Operator, and not from a guest
   * conversation. Throws before anything changes when the fields do not fit the outcome.
   */
  async screenQuestion(
    ctx: ToolContext,
    args: {
      itemId: string;
      outcome: ScreeningOutcome;
      note: string;
      answer?: string;
      forwardTo?: string;
      todo?: QuestionTodo;
    },
  ): Promise<{ inboxItemId: string; outcome: ScreeningOutcome }> {
    return this.calls.guard(async () => {
      const config = await this.projects.config(ctx.projectKey);
      if (!isOperator(memberOf(config, ctx.member)))
        throw new TeamToolError('forbidden', 'operator_only: only the Operator may screen questions.');
      await this.calls.callerWithRequest(ctx, 'screen_question');
      const { outcome } = args;
      const note = args.note.trim();
      const answer = args.answer?.trim();
      const forwardTo = args.forwardTo?.trim();
      const fieldError = (problem: string) =>
        new TeamToolError('invalid', `invalid_outcome_fields: ${problem}`);
      if (!note) throw fieldError('note is required with every outcome.');
      if ((outcome === 'answered') !== (answer !== undefined && answer !== ''))
        throw fieldError(
          outcome === 'answered' ? 'answered needs an answer.' : 'only answered takes an answer.',
        );
      if ((outcome === 'forwarded') !== (forwardTo !== undefined))
        throw fieldError(
          outcome === 'forwarded' ? 'forwarded needs forward_to.' : 'only forwarded takes forward_to.',
        );
      if ((outcome === 'todo') !== (args.todo !== undefined))
        throw fieldError(
          outcome === 'todo' ? 'todo needs the todo fields.' : 'only todo takes the todo fields.',
        );
      const item = this.ctx.repos.inbox.get(args.itemId);
      if (!item || item.projectKey !== ctx.projectKey || item.kind !== 'question')
        throw new TeamToolError('not_found', `No question ${args.itemId} in this project.`);
      const asker = memberOf(config, item.source);
      // A moot question may also be one that already went to the people, if an AI member asked it.
      const mootOpen =
        outcome === 'moot' && item.state === 'open' && asker?.kind === 'ai' && !isOperator(asker);
      if (item.state !== 'screening' && !mootOpen)
        throw new TeamToolError(
          'invalid',
          `question_not_screening: ${item.id} is not waiting for the Operator (it is ${item.state}).`,
        );
      if (forwardTo !== undefined) {
        const recipient = memberOf(config, forwardTo);
        if (recipient?.kind !== 'ai' || isOperator(recipient) || forwardTo === item.source)
          throw fieldError(
            `forward_to must be an AI member of the project other than the asker and the Operator; ${forwardTo} is not.`,
          );
      }
      const by = ctx.member;
      const settled =
        outcome === 'decision' || outcome === 'todo'
          ? await this.inbox.releaseScreened(item.id, {
              outcome,
              by,
              note,
              ...(args.todo ? { todo: args.todo } : {}),
            })
          : await this.inbox.settleScreened(
              item.id,
              {
                outcome,
                by,
                note,
                ...(answer ? { answer } : {}),
                ...(forwardTo ? { forwardedTo: forwardTo } : {}),
              },
              outcome === 'answered'
                ? (resolved, close) => this.messaging.answer(resolved, [], close)
                : outcome === 'forwarded'
                  ? (resolved, close) =>
                      this.messaging.forwardQuestion(resolved, { to: forwardTo!, note }, close)
                  : undefined,
            );
      if (!settled)
        throw new TeamToolError(
          'invalid',
          `question_not_screening: ${item.id} is not waiting for the Operator any more.`,
        );
      return { inboxItemId: item.id, outcome };
    });
  }

  async startTask(
    ctx: ToolContext,
    args: { taskKey: string; assignee?: string; despitePrerequisites?: boolean; signalId?: string },
  ) {
    const config = await this.projects.config(ctx.projectKey);
    if (!isOperator(memberOf(config, ctx.member)))
      throw new TeamToolError(
        'forbidden',
        'operator_only: only the Operator may start tasks through this tool.',
      );
    const { signalId, ...startArgs } = args;
    // On a signal the call starts the card's own assignee and nothing else (PM-545).
    if (signalId !== undefined && (args.assignee !== undefined || args.despitePrerequisites !== undefined))
      throw new TeamToolError(
        'invalid',
        'invalid_request: with signal_id start_task takes no assignee and no despite_prerequisites.',
      );
    const caller = await this.calls.callerWithRequest(
      ctx,
      'start_task',
      undefined,
      signalId !== undefined
        ? { signalId, tool: 'start_task', member: null, taskKey: args.taskKey }
        : undefined,
    );
    return this.calls
      .recorded<Awaited<ReturnType<OperatorToolsHandler['startTask']>>>(
        caller,
        { action: 'task_start', taskKey: args.taskKey, madeMember: (result) => result.hired },
        async () => {
          const operator = memberOf(config, ctx.member)!;
          const taskKey = this.calls.validTaskKey(ctx, args.taskKey);
          const card = signalId !== undefined ? this.tasks.get(ctx.projectKey, taskKey) : null;
          if (card && !card.assignee)
            throw new TeamToolError('invalid', 'invalid_request: the card has no assignee to start.');
          const result = await this.taskStarts.start(ctx.projectKey, taskKey, {
            ...startArgs,
            actor: aiActor(ctx.member),
            author: { name: operator.displayName, email: `${ctx.member}@projectman.local` },
            ...(card
              ? {
                  // The assignee as the signal named it; a card that moved on meanwhile is left alone.
                  assignee: card.assignee!,
                  stillWanted: (now: Task) => now.assignee === card.assignee && now.stageId === card.stageId,
                }
              : { startSetters: true, sponsor: caller.request!.fromHandle }),
          });
          return {
            task_key: result.task.key,
            session_id: result.session?.id ?? null,
            hired: result.hired?.handle ?? null,
            assignee: result.task.assignee,
            ...(result.awaiting ? { awaiting: result.awaiting } : {}),
            ...(result.seniorWait ? { senior_wait: result.seniorWait } : {}),
          };
        },
      )
      .catch((err: unknown) => {
        if (err instanceof DomainError) {
          const converted = toToolError(err) as TeamToolError;
          throw new TeamToolError(converted.code, `${err.code}: ${converted.message}`);
        }
        throw toToolError(err);
      });
  }

  async startMember(
    ctx: ToolContext,
    args: { member: string; text: string; taskKey?: string; signalId?: string },
  ): Promise<MemberStartResult> {
    const config = await this.projects.config(ctx.projectKey);
    if (!isOperator(memberOf(config, ctx.member)))
      throw new TeamToolError(
        'forbidden',
        'operator_only: only the Operator may start members through this tool.',
      );
    const who = await this.calls.callerWithRequest(
      ctx,
      'start_member',
      undefined,
      args.signalId !== undefined
        ? {
            signalId: args.signalId,
            tool: 'start_member',
            member: args.member,
            taskKey: args.taskKey ?? null,
          }
        : undefined,
    );
    return this.calls.recorded<MemberStartResult>(
      who,
      { action: 'task_start', taskKey: args.taskKey ?? null, member: args.member },
      async () => {
        // The message is the card's: the member needs a role on it (PM-545).
        const card = args.taskKey
          ? this.tasks.get(ctx.projectKey, this.calls.validTaskKey(ctx, args.taskKey))
          : null;
        const member = memberOf(config, args.member);
        if (!member) throw new TeamToolError('not_found', `Unknown team member: ${args.member}.`);
        if (member.kind === 'human')
          throw new TeamToolError(
            'invalid',
            `not_ai_member: ${args.member} is a person; ask them with ask_human.`,
          );
        if (isOperator(member)) throw new TeamToolError('invalid', 'cannot_start_self');
        if (card && !recipientHasCardRole(this.ctx, config, card, member.handle))
          throw new TeamToolError(
            'invalid',
            `not_card_role: ${member.handle} has no role on ${card.key}; start a member who holds it, or use start_task.`,
          );
        const { message, recipients } = await this.messaging
          .sendReporting(
            ctx.projectKey,
            ctx.member,
            { to: [member.handle], text: args.text, taskKey: card?.key ?? null },
            {
              actor: aiActor(ctx.member),
              sessionId: ctx.sessionId,
              kind: 'action',
              operatorRequest: who.request!.id,
              awaitWake: true,
            },
          )
          .catch((err: unknown) => {
            throw toMessageToolError(err);
          });
        return { messageId: message.id, recipient: recipients[0]! };
      },
    );
  }
}
