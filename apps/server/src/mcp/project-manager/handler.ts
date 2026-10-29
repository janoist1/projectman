import {
  isProjectManager,
  coordinationMemberOf,
  canonical,
  operatorCriticalOp,
  OperatorPlan as OperatorPlanSchema,
  machineTodoIssuerAllowed,
  memberOf,
  roleBundle,
  ScreeningTodo as ScreeningTodoSchema,
  questionPayloadOf,
} from '@projectman/shared';
import type { QuestionRecipient, QuestionRecipientRefusal } from '@projectman/shared';
import type {
  OperatorOperation,
  BuiltInRoleId,
  RoleConfigurationRead,
  ProposeOperatorKnowledgeRequest,
  OperatorPlan,
  OperatorPreferenceData,
  ProjectConfig,
  ScreeningOutcome,
  ScreeningTodo,
  Task,
  SuperOperation,
} from '@projectman/shared';
import { TeamToolError } from '../../contracts';
import type {
  ChecklistToolView,
  OperatorToolsHandler,
  UpdateChecklistInput,
  UpdateChecklistResult,
  MemberStartResult,
  ToolContext,
  SystemFeedbackLookup,
} from '../../contracts';
import type { DomainContext } from '../../core/base';
import { DomainError } from '../../kernel';
import type { InboxService } from '../../core/inbox';
import type { Messaging } from '../../core/messages';
import { recipientHasCardRole } from '../../core/messages';
import type { ChecklistService, ProjectService } from '../../core/projects';
import type { TaskService } from '../../core/tasks';
import type { TaskStarts } from '../../runtime/admission';
import { aiActor } from '../../kernel';
import type {
  ProjectState,
  OperatorSignals,
  OperatorPreferences,
  OperatorKnowledge,
  StructuralReviews,
  LoopTriages,
} from '../../services/coordination';
import type { ObligationsService } from '../../services/obligations';
import { appRequestId } from '../../services/super-operator';
import type { OperatorAppOperations, SuperAdministration } from '../../services/super-operator';
import { toToolError, toMessageToolError, type ToolCaller } from '../caller';

/** What the super-operation tools stand on (PM-888). */
interface SuperPath {
  operations: OperatorAppOperations;
  administration: Pick<SuperAdministration, 'operation'>;
}

/** What the checklist tools stand on (PM-977): every write goes through the checklist service. */
type OperatorToolsChecklist = Pick<
  ChecklistService,
  'get' | 'init' | 'add' | 'edit' | 'setCondition' | 'setStateByOperator' | 'applyTemplate' | 'templateBases'
>;

export class OperatorTools implements OperatorToolsHandler {
  private readonly calls: ToolCaller;
  private readonly ctx: DomainContext;
  private readonly projects: ProjectService;
  private readonly tasks: TaskService;
  private readonly inbox: InboxService;
  private readonly systemFeedback: SystemFeedbackLookup;
  private readonly obligations: Pick<ObligationsService, 'listOpen'>;
  private readonly messaging: Pick<Messaging, 'answer' | 'forwardQuestion' | 'sendReporting'>;
  private readonly projectState: ProjectState;
  private readonly taskStarts: TaskStarts;
  private readonly operatorSignals: Pick<OperatorSignals, 'dismissByOperator'>;
  private readonly operatorPreferences: OperatorPreferences;
  private readonly operatorKnowledge: OperatorKnowledge;
  private readonly structuralReviews: StructuralReviews;
  private readonly loopTriages: LoopTriages;
  private readonly superPath: () => SuperPath;
  private readonly checklist: OperatorToolsChecklist;

  constructor(deps: {
    calls: ToolCaller;
    ctx: DomainContext;
    projects: ProjectService;
    tasks: TaskService;
    inbox: InboxService;
    systemFeedback: SystemFeedbackLookup;
    obligations: Pick<ObligationsService, 'listOpen'>;
    messaging: Pick<Messaging, 'answer' | 'forwardQuestion' | 'sendReporting'>;
    projectState: ProjectState;
    taskStarts: TaskStarts;
    operatorSignals: Pick<OperatorSignals, 'dismissByOperator'>;
    operatorPreferences: OperatorPreferences;
    operatorKnowledge: OperatorKnowledge;
    structuralReviews: StructuralReviews;
    loopTriages: LoopTriages;
    checklist: OperatorToolsChecklist;
    /** The shared super-operation path; read at the call, because it is composed after the tools. */
    superPath: () => SuperPath;
  }) {
    this.calls = deps.calls;
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.tasks = deps.tasks;
    this.inbox = deps.inbox;
    this.systemFeedback = deps.systemFeedback;
    this.obligations = deps.obligations;
    this.messaging = deps.messaging;
    this.projectState = deps.projectState;
    this.taskStarts = deps.taskStarts;
    this.operatorSignals = deps.operatorSignals;
    this.operatorPreferences = deps.operatorPreferences;
    this.operatorKnowledge = deps.operatorKnowledge;
    this.structuralReviews = deps.structuralReviews;
    this.loopTriages = deps.loopTriages;
    this.checklist = deps.checklist;
    this.superPath = deps.superPath;
  }

  async requestStructuralReview(ctx: ToolContext, args: { signalId: string; note: string }) {
    return this.calls.guard(async () => {
      await this.calls.callerWithRequest(ctx, 'request_structural_review');
      return this.structuralReviews.request(ctx, args.signalId, args.note, (member, text) =>
        this.startMember(ctx, { member, text }),
      );
    });
  }

  /** The selected project manager's own coordination session (PM-1043). */
  private assertChecklistSession(ctx: ToolContext, config: ProjectConfig): void {
    this.calls.assertCoordinationSession(ctx, config);
  }

  async getChecklist(ctx: ToolContext): Promise<ChecklistToolView> {
    return this.calls.guard(async () => {
      const config = await this.calls.caller(ctx, 'get_checklist');
      this.assertChecklistSession(ctx, config);
      return {
        checklist: await this.checklist.get(ctx.projectKey),
        templates: this.checklist.templateBases(),
      };
    });
  }

  async updateChecklist(ctx: ToolContext, args: UpdateChecklistInput): Promise<UpdateChecklistResult> {
    return this.calls.guard(async () => {
      const config = await this.calls.caller(ctx, 'update_checklist');
      if (!isProjectManager(memberOf(config, ctx.member)))
        throw new TeamToolError(
          'forbidden',
          'operator_only: only the project manager may change the checklist.',
        );
      this.assertChecklistSession(ctx, config);
      try {
        return await this.runChecklistOp(ctx.projectKey, ctx.member, args);
      } catch (err) {
        if (err instanceof DomainError)
          throw new TeamToolError(
            err.status === 403 ? 'forbidden' : err.status === 404 ? 'not_found' : 'invalid',
            `${err.code}: ${err.message}`,
          );
        throw err;
      }
    });
  }

  /** `check` of the tool has made sure each operation has the fields it needs. */
  private async runChecklistOp(
    key: string,
    handle: string,
    args: UpdateChecklistInput,
  ): Promise<UpdateChecklistResult> {
    const { checklist } = this;
    const itemId = args.itemId!;
    switch (args.op) {
      case 'init':
        return { checklist: await checklist.init(key) };
      case 'add': {
        const added = await checklist.add(
          key,
          {
            title: args.title!,
            ...(args.hint !== undefined ? { hint: args.hint } : {}),
            ...(args.condition !== undefined ? { condition: args.condition } : {}),
          },
          handle,
        );
        return { checklist: added.checklist, itemId: added.itemId };
      }
      case 'edit':
        return {
          checklist: await checklist.edit(
            key,
            itemId,
            {
              ...(args.title !== undefined ? { title: args.title } : {}),
              ...(args.hint !== undefined ? { hint: args.hint } : {}),
            },
            handle,
          ),
          itemId,
        };
      case 'set_condition':
        return { checklist: await checklist.setCondition(key, itemId, args.condition!, handle), itemId };
      case 'set_state':
        return {
          checklist: await checklist.setStateByOperator(
            key,
            itemId,
            args.state === 'not_needed'
              ? { state: 'not_needed', reason: args.reason! }
              : { state: args.state! },
            handle,
          ),
          itemId,
        };
      case 'apply_template':
        return await checklist.applyTemplate(key, args.templateId!, handle);
    }
  }

  async getRoleConfiguration(
    ctx: ToolContext,
    args: { role: BuiltInRoleId },
  ): Promise<RoleConfigurationRead> {
    return this.calls.guard(async () => {
      await this.appCaller(ctx, 'get_role_configuration');
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
    const member = memberOf(config, ctx.member);
    if (!isProjectManager(member))
      throw new TeamToolError(
        'forbidden',
        'operator_only: only the project manager may propose shared knowledge.',
      );
    this.calls.assertCoordinationSession(ctx, config);
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
    const member = memberOf(config, ctx.member);
    if (!isProjectManager(member))
      throw new TeamToolError('forbidden', 'operator_only: only the PM may use preferences.');
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

  async reassignTask(ctx: ToolContext, args: { taskKey: string; assignee: string | null; reason: string }) {
    return this.calls.guard(async () => {
      await this.calls.callerWithRequest(ctx, 'reassign_task');
      const taskKey = this.calls.validTaskKey(ctx, args.taskKey);
      try {
        const previous = this.tasks.get(ctx.projectKey, taskKey).assignee;
        const task = await this.tasks.update(
          ctx.projectKey,
          taskKey,
          { assignee: args.assignee, assigneeReason: args.reason },
          aiActor(ctx.member),
        );
        return { task_key: task.key, assignee: task.assignee, previous };
      } catch (err) {
        if (err instanceof DomainError) throw toToolError(err);
        throw err;
      }
    });
  }

  async cancelTask(ctx: ToolContext, args: { taskKey: string; reason: string }) {
    return this.calls.guard(async () => {
      await this.calls.callerWithRequest(ctx, 'cancel_task');
      const taskKey = this.calls.validTaskKey(ctx, args.taskKey);
      try {
        const task = await this.tasks.cancel(
          ctx.projectKey,
          taskKey,
          { reason: args.reason },
          aiActor(ctx.member),
        );
        return { task_key: task.key, status: task.status };
      } catch (err) {
        if (err instanceof DomainError) throw toToolError(err);
        throw err;
      }
    });
  }

  async reopenTask(ctx: ToolContext, args: { taskKey: string; reason: string }) {
    return this.calls.guard(async () => {
      await this.calls.callerWithRequest(ctx, 'reopen_task');
      const taskKey = this.calls.validTaskKey(ctx, args.taskKey);
      try {
        const task = await this.tasks.reopen(ctx.projectKey, taskKey, aiActor(ctx.member), {
          reason: args.reason,
        });
        return { task_key: task.key, status: task.status };
      } catch (err) {
        if (err instanceof DomainError) throw toToolError(err);
        throw err;
      }
    });
  }

  async openIntegratorTodo(
    ctx: ToolContext,
    args: { taskKey?: string; question: string; what: string; where: string; expected: string },
  ): Promise<{
    itemId: string;
    recipient: QuestionRecipient;
    recipientRefusal: QuestionRecipientRefusal | null;
  }> {
    return this.calls.guard(async () => {
      const { config } = await this.calls.callerWithRequest(ctx, 'open_integrator_todo');
      // A guest cannot start an installation on the owner's machine.
      const workItem = this.ctx.repos.sessions.get(ctx.sessionId)?.workItem;
      if (workItem?.type === 'general' && workItem.with !== undefined)
        throw new TeamToolError(
          'forbidden',
          'operator_owner_only: open_integrator_todo is not for a conversation with a guest.',
        );
      if (!machineTodoIssuerAllowed(config, ctx.member))
        throw new TeamToolError(
          'forbidden',
          'machine_access_required: this member may not put machine work in the owners queue; an owner can switch it on in the member settings.',
        );
      const taskKey = this.calls.taskKeyFor(ctx, args.taskKey);
      // A followed step has its own wake-up and its own todo: the PM does not open a second one (PM-796 R2.7).
      // A developer on the card always has an open work obligation, which must not keep an installation out.
      const tracked =
        taskKey && isProjectManager(memberOf(config, ctx.member))
          ? this.obligations.listOpen(ctx.projectKey, taskKey)[0]
          : undefined;
      if (tracked)
        throw new TeamToolError(
          'invalid',
          `obligation_tracked: ${taskKey} is followed by projectman (${tracked.kind}, ${tracked.responsible}): it wakes the responsible and hands the step to the integrator itself`,
        );
      try {
        return await this.inbox.openIntegratorTodo({
          projectKey: ctx.projectKey,
          taskKey,
          askedBy: ctx.member,
          question: args.question,
          todo: { what: args.what, where: args.where, expected: args.expected },
        });
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
      this.calls.assertCoordinationSession(ctx, config);
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
    if (coordinationMemberOf(config)?.handle === ctx.member) {
      if (operatorCriticalOp(args.operation.op) && !args.plan)
        throw new TeamToolError('invalid', 'operator_plan_required: critical operations require a plan.');
      if (args.plan) OperatorPlanSchema.parse(args.plan);
      if (!args.title.trim() || args.title.length > 120)
        throw new TeamToolError('invalid', 'invalid_request: title must have 1 to 120 characters.');
      const caller = await this.appCaller(ctx, 'operate');
      try {
        const result = await this.calls.recorded(
          caller,
          {
            action: 'operation',
            taskKey: null,
            madeOperation: (result: { operation: SuperOperation }) => ({
              id: result.operation.id,
              awaitsOwner: result.operation.state === 'waiting_owner',
            }),
          },
          async () => ({
            operation: await this.superPath().operations.execute(ctx.projectKey, ctx.sessionId, {
              requestId: appRequestId(caller.request!.id, canonical(args.operation)),
              command: { kind: 'operate', operation: args.operation },
            }),
          }),
        );
        const operation = result.operation;
        return {
          status:
            operation.state === 'waiting_owner'
              ? ('awaiting_approval' as const)
              : operation.state === 'succeeded'
                ? ('done' as const)
                : ('refused' as const),
          step_id: this.ctx.repos.operatorRequests.steps(caller.request!.id).at(-1)!.id,
          changes: [],
          ...(operation.ownerQuestionId ? { inbox_item_id: operation.ownerQuestionId } : {}),
        };
      } catch (err) {
        throw this.appFailure(err);
      }
    }
    throw new TeamToolError('forbidden', 'operator_only: only the selected PM may operate.');
  }

  /**
   * The selected PM's call on the shared super-operation path (PM-888): in its own general conversation, during a
   * direct internal owner request (a message or an answer) or a queue item (PM-885); not an approval continuation,
   * a signal or a guest. Returns the caller whose request the credential of the call stands on.
   */
  private async appCaller(ctx: ToolContext, tool: string) {
    const caller = await this.calls.callerWithRequest(ctx, tool);
    if (coordinationMemberOf(caller.config)?.handle !== ctx.member)
      throw new TeamToolError(
        'forbidden',
        'operator_only: only the selected PM may use the super operations.',
      );
    const session = this.ctx.repos.sessions.get(ctx.sessionId);
    if (
      !caller.request ||
      caller.guest ||
      (caller.request.source !== 'message' &&
        caller.request.source !== 'answer' &&
        caller.request.source !== 'queue') ||
      !session ||
      session.projectKey !== ctx.projectKey ||
      session.member !== ctx.member ||
      session.workItem.type !== 'general' ||
      session.workItem.with
    )
      throw new TeamToolError(
        'forbidden',
        'operator_owner_only: a super operation needs your own general conversation and an open request of an owner.',
      );
    return caller;
  }

  /** A refusal of the shared path keeps its code in the message, like `operate`'s. */
  private appFailure(err: unknown): unknown {
    if (err instanceof DomainError)
      return new TeamToolError(err.status === 403 ? 'forbidden' : 'invalid', `${err.code}: ${err.message}`);
    return toToolError(err);
  }

  async executeOperation(ctx: ToolContext, args: Parameters<OperatorToolsHandler['executeOperation']>[1]) {
    try {
      const caller = await this.appCaller(ctx, 'execute_operation');
      // Commands that need an owner's own message or answer are refused on the shared path (PM-935, PM-1010).
      const taskKey = args.taskKey ? this.calls.validTaskKey(ctx, args.taskKey) : undefined;
      const requestId = appRequestId(caller.request!.id, args.requestKey);
      return await this.calls.recorded(
        caller,
        {
          action: 'operation',
          taskKey: taskKey ?? null,
          madeOperation: (result) => ({
            id: result.operation.id,
            awaitsOwner: result.operation.state === 'waiting_owner',
          }),
        },
        async () => ({
          operation: await this.superPath().operations.execute(ctx.projectKey, ctx.sessionId, {
            requestId,
            command: args.command,
            ...(taskKey ? { taskKey } : {}),
          }),
        }),
      );
    } catch (err) {
      throw this.appFailure(err);
    }
  }

  async getOperation(ctx: ToolContext, args: { operationId: string }) {
    try {
      await this.appCaller(ctx, 'get_operation');
      return await this.superPath().administration.operation(ctx.projectKey, args.operationId);
    } catch (err) {
      throw this.appFailure(err);
    }
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
      todo?: ScreeningTodo;
      feedbackId?: string;
    },
  ): Promise<{
    inboxItemId: string;
    outcome: ScreeningOutcome;
    recipient?: QuestionRecipient;
    recipientRefusal?: QuestionRecipientRefusal;
  }> {
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
      if (args.todo && !ScreeningTodoSchema.safeParse(args.todo).success)
        throw fieldError('todo needs valid what, where, expected and recipient fields.');
      if (
        args.feedbackId !== undefined &&
        (outcome !== 'todo' ||
          !args.feedbackId.trim() ||
          !this.systemFeedback.belongsToProject(ctx.projectKey, args.feedbackId))
      )
        throw fieldError('feedback_id must identify system feedback in this project, only with todo.');
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
              ...(args.feedbackId !== undefined ? { feedbackId: args.feedbackId } : {}),
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
      const payload = questionPayloadOf(settled);
      return {
        inboxItemId: item.id,
        outcome,
        ...(outcome === 'todo'
          ? {
              recipient: payload?.recipient ?? 'owner',
              ...(payload?.screening?.recipientRefusal
                ? { recipientRefusal: payload.screening.recipientRefusal }
                : {}),
            }
          : {}),
      };
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
          if (member.handle === ctx.member) throw new TeamToolError('invalid', 'cannot_start_self');
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
