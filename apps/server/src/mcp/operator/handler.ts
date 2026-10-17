import { isOperator, memberOf, roleBundle } from '@projectman/shared';
import type {
  OperatorOperation,
  BuiltInRoleId,
  RoleConfigurationRead,
  ProposeOperatorKnowledgeRequest,
  OperatorPlan,
  OperatorPreferenceData,
  ScreeningOutcome,
  QuestionTodo,
  Task,
} from '@projectman/shared';
import { TeamToolError } from '../../contracts';
import type { OperatorToolsHandler, MemberStartResult, ToolContext } from '../../contracts';
import type { DomainContext } from '../../core/base';
import { DomainError } from '../../kernel';
import type { InboxService } from '../../core/inbox';
import type { Messaging } from '../../core/messages';
import { recipientHasCardRole } from '../../core/messages';
import type { ProjectService } from '../../core/projects';
import type { TaskService } from '../../core/tasks';
import type { TaskStarts } from '../../runtime/admission';
import { aiActor } from '../../kernel';
import type {
  ProjectState,
  OperatorActions,
  OperatorSignals,
  OperatorPreferences,
  OperatorKnowledge,
  StructuralReviews,
  LoopTriages,
} from '../../services/operator';
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
  private readonly operatorSignals: Pick<OperatorSignals, 'dismissByOperator'>;
  private readonly operatorPreferences: OperatorPreferences;
  private readonly operatorKnowledge: OperatorKnowledge;
  private readonly structuralReviews: StructuralReviews;
  private readonly loopTriages: LoopTriages;

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
    operatorSignals: Pick<OperatorSignals, 'dismissByOperator'>;
    operatorPreferences: OperatorPreferences;
    operatorKnowledge: OperatorKnowledge;
    structuralReviews: StructuralReviews;
    loopTriages: LoopTriages;
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
    this.operatorSignals = deps.operatorSignals;
    this.operatorPreferences = deps.operatorPreferences;
    this.operatorKnowledge = deps.operatorKnowledge;
    this.structuralReviews = deps.structuralReviews;
    this.loopTriages = deps.loopTriages;
  }

  async requestStructuralReview(ctx: ToolContext, args: { signalId: string; note: string }) {
    return this.calls.guard(async () => {
      await this.calls.callerWithRequest(ctx, 'request_structural_review');
      return this.structuralReviews.request(ctx, args.signalId, args.note, (member, text) =>
        this.startMember(ctx, { member, text }),
      );
    });
  }

  async getRoleConfiguration(
    ctx: ToolContext,
    args: { role: BuiltInRoleId },
  ): Promise<RoleConfigurationRead> {
    return this.calls.guard(async () => {
      const config = await this.calls.caller(ctx, 'get_role_configuration');
      if (!isOperator(memberOf(config, ctx.member)))
        throw new TeamToolError('forbidden', 'operator_only: only the Operator may read role configuration.');
      const session = this.ctx.repos.sessions.get(ctx.sessionId);
      if (
        !session ||
        session.projectKey !== ctx.projectKey ||
        session.member !== ctx.member ||
        session.workItem.type !== 'general' ||
        session.workItem.with
      )
        throw new TeamToolError(
          'forbidden',
          'operator_owner_only: role configuration requires your own owner general conversation.',
        );
      const loaded = await this.projects.load(ctx.projectKey);
      return {
        version: loaded.version,
        role: args.role,
        override: loaded.config.team.roleOverrides?.[args.role] ?? null,
        effective: roleBundle(loaded.config, args.role),
      };
    });
  }

  async getOperatorKnowledge(ctx: ToolContext) {
    await this.calls.caller(ctx, 'get_operator_knowledge');
    return this.operatorKnowledge.get(ctx).catch((err: unknown) => {
      if (err instanceof DomainError)
        throw new TeamToolError(err.status === 403 ? 'forbidden' : 'invalid', `${err.code}: ${err.message}`);
      throw err;
    });
  }

  async proposeOperatorKnowledge(ctx: ToolContext, args: ProposeOperatorKnowledgeRequest) {
    const config = await this.projects.config(ctx.projectKey);
    if (!isOperator(memberOf(config, ctx.member)))
      throw new TeamToolError('forbidden', 'operator_only: only the Operator may propose shared knowledge.');
    await this.calls.callerWithRequest(ctx, 'propose_operator_knowledge');
    return this.operatorKnowledge.propose(ctx, args).catch((err: unknown) => {
      if (err instanceof DomainError)
        throw new TeamToolError(err.status === 403 ? 'forbidden' : 'invalid', `${err.code}: ${err.message}`);
      throw err;
    });
  }

  async getOperatorPreference(ctx: ToolContext) {
    return this.preferenceCall(ctx, 'get_operator_preference', () => this.operatorPreferences.get(ctx));
  }

  async setOperatorPreference(
    ctx: ToolContext,
    args: { expectedRevision: number; preference: OperatorPreferenceData },
  ) {
    return this.preferenceCall(ctx, 'set_operator_preference', () =>
      this.operatorPreferences.set(ctx, args.expectedRevision, args.preference),
    );
  }

  private async preferenceCall<T>(ctx: ToolContext, tool: string, run: () => Promise<T>): Promise<T> {
    const config = await this.projects.config(ctx.projectKey);
    if (!isOperator(memberOf(config, ctx.member)))
      throw new TeamToolError('forbidden', 'operator_only: only the Operator may use preferences.');
    await this.calls.callerWithRequest(ctx, tool);
    try {
      return await run();
    } catch (err) {
      if (err instanceof DomainError)
        throw new TeamToolError(err.status === 403 ? 'forbidden' : 'invalid', `${err.code}: ${err.message}`);
      throw err;
    }
  }

  async triageLoop(
    ctx: ToolContext,
    args: {
      signalId: string;
      outcome: 'progress' | 'loop';
      note: string;
      evidenceIds: string[];
    },
  ) {
    return this.calls.guard(async () => {
      await this.calls.callerWithRequest(ctx, 'triage_loop');
      return this.loopTriages.assess({ ...args, projectKey: ctx.projectKey, by: ctx.member });
    });
  }

  async dismissSignal(
    ctx: ToolContext,
    args: { signalId: string; note: string },
  ): Promise<{ signalId: string; state: 'dismissed' }> {
    return this.calls.guard(async () => {
      await this.calls.callerWithRequest(ctx, 'dismiss_signal');
      try {
        const signal = this.operatorSignals.dismissByOperator(
          ctx.projectKey,
          args.signalId,
          ctx.member,
          args.note,
        );
        return { signalId: signal.id, state: 'dismissed' };
      } catch (err) {
        if (err instanceof DomainError) throw toToolError(err);
        throw err;
      }
    });
  }

  async getOperatorDiagnostics(ctx: ToolContext, args: { taskKey: string; limit?: number }) {
    return this.calls.guard(async () => {
      await this.calls.caller(ctx, 'get_operator_diagnostics');
      return this.projectState.diagnostics(ctx, args.taskKey, args.limit).catch((err: unknown) => {
        if (err instanceof DomainError && err.status === 403)
          throw new TeamToolError('forbidden', `${err.code}: ${err.message}`);
        throw err;
      });
    });
  }

  async getProjectState(ctx: ToolContext, args: { taskKey?: string; messageId?: string }) {
    return this.calls.guard(async () => {
      const config = await this.calls.caller(ctx, 'get_project_state');
      const member = memberOf(config, ctx.member);
      if (!isOperator(member)) this.calls.assertCoordinationSession(ctx, config);
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

  async operate(
    ctx: ToolContext,
    args: { title: string; operation: OperatorOperation; plan?: OperatorPlan },
  ) {
    const config = await this.projects.config(ctx.projectKey);
    if (!isOperator(memberOf(config, ctx.member)))
      throw new TeamToolError('forbidden', 'operator_only: only the Operator may operate.');
    const caller = await this.calls.callerWithRequest(ctx, 'operate', undefined, undefined, args.operation);
    return this.operatorActions
      .run(ctx.projectKey, caller.request!.id, args.title, args.operation, args.plan)
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
   * The PM settles a question it screens: it answers it, passes it to a member, closes it as
   * moot, or sends it on to the people as a decision or a todo. Only the selected PM, never from a guest
   * conversation. Throws before anything changes when the fields do not fit the outcome.
   */
  async combineQuestions(ctx: ToolContext, args: { itemIds: string[]; question: string; note: string }) {
    return this.calls.guard(async () => {
      await this.calls.callerWithRequest(ctx, 'combine_questions');
      return this.inbox.combineQuestions(ctx.projectKey, args, ctx.member);
    });
  }

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
      const { config } = await this.calls.callerWithRequest(ctx, 'screen_question');
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
      const group = this.ctx.repos.inbox.groupOf(item.id);
      const primary = group ? this.ctx.repos.inbox.get(group.primaryItemId) : null;
      // A moot question may also be one that already went to the people, if an AI member asked it.
      const mootOpen =
        outcome === 'moot' &&
        (item.state === 'open' || (item.state === 'screening' && primary?.state === 'open')) &&
        asker?.kind === 'ai' &&
        item.source !== ctx.member;
      if (item.source === ctx.member)
        throw new TeamToolError('forbidden', 'project_manager_only: the PM cannot screen its own question.');
      if ((item.state !== 'screening' || (group && primary?.state !== 'screening')) && !mootOpen)
        throw new TeamToolError(
          'invalid',
          `question_not_screening: ${item.id} is not waiting for the PM (it is ${item.state}).`,
        );
      if (forwardTo !== undefined) {
        const recipient = memberOf(config, forwardTo);
        if (recipient?.kind !== 'ai' || forwardTo === ctx.member || forwardTo === item.source)
          throw fieldError(
            `forward_to must be an AI member of the project other than the asker and the PM; ${forwardTo} is not.`,
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
          `question_not_screening: ${item.id} is not waiting for the PM any more.`,
        );
      return { inboxItemId: item.id, outcome };
    });
  }

  async startTask(
    ctx: ToolContext,
    args: { taskKey: string; assignee?: string; despitePrerequisites?: boolean; signalId?: string },
  ) {
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
    const config = caller.config;
    return this.calls
      .recorded<Awaited<ReturnType<OperatorToolsHandler['startTask']>>>(
        caller,
        { action: 'task_start', taskKey: args.taskKey, madeMember: (result) => result.hired },
        async () => {
          const coordinator = memberOf(config, ctx.member)!;
          const taskKey = this.calls.validTaskKey(ctx, args.taskKey);
          const card = signalId !== undefined ? this.tasks.get(ctx.projectKey, taskKey) : null;
          if (card && !card.assignee)
            throw new TeamToolError('invalid', 'invalid_request: the card has no assignee to start.');
          const result = await this.taskStarts.start(ctx.projectKey, taskKey, {
            ...startArgs,
            stillWanted: () => {
              caller.beforeRecord?.();
              return true;
            },
            actor: aiActor(ctx.member),
            author: { name: coordinator.displayName, email: `${ctx.member}@projectman.local` },
            ...(card
              ? {
                  // The assignee as the signal named it; a card that moved on meanwhile is left alone.
                  assignee: card.assignee!,
                  stillWanted: (now: Task) => {
                    caller.beforeRecord?.();
                    return now.assignee === card.assignee && now.stageId === card.stageId;
                  },
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
    args: { member: string; text: string; taskKey?: string; signalId?: string; despiteWorkers?: boolean },
  ): Promise<MemberStartResult> {
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
    const config = who.config;
    return this.calls
      .recorded<MemberStartResult>(
        who,
        { action: 'task_start', taskKey: args.taskKey ?? null, member: args.member },
        async () => {
          // The message is the card's: the member needs a role on it (PM-545).
          this.structuralReviews.assertStart(ctx, args);
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
          if (isOperator(member) || member.handle === ctx.member)
            throw new TeamToolError('invalid', 'cannot_start_self');
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
                workerCheck: !args.despiteWorkers,
                beforeRecord: () => {
                  who.beforeRecord?.();
                  this.structuralReviews.assertStart(ctx, args);
                },
              },
            )
            .catch((err: unknown) => {
              throw toMessageToolError(err);
            });
          return { messageId: message.id, recipient: recipients[0]! };
        },
      )
      .catch((err: unknown) => {
        throw toToolError(err);
      });
  }
}
