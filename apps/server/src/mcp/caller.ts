import path from 'node:path';
import {
  CardBusyDetails,
  coordinationActorRefusal,
  ERROR_CODES,
  ownerHandles,
  isOperator,
  MAX_ATTACHMENT_BYTES,
  memberOf,
  OPERATOR_SIGNAL_STEP_GAP_MINUTES,
  operatorSignalStepRefusal,
  operatorWatchOf,
  operatorKnowledgeOperationIncluded,
  TaskKey,
} from '@projectman/shared';
import type {
  ErrorCode,
  OperatorAction,
  OperatorOperation,
  ProjectConfig,
  Session,
} from '@projectman/shared';
import { TeamToolError, WorkspaceFileRefusal } from '../contracts';
import type { EngineHost, WorkspaceFile, ToolContext } from '../contracts';
import { isWithin } from '../runtime/permissions';
import type { DomainContext } from '../core/base';
import { isoNow } from '../core/base';
import { DomainError } from '../kernel';
import type { ApprovalRequirement, UnmetCondition } from '@projectman/shared';
import {
  OPERATOR_GUEST_TOOLS,
  OPERATOR_NEVER_TOOLS,
  OPERATOR_READ_TOOLS,
  OPERATOR_SCREENING_TOOLS,
  OPERATOR_TOOL_ACTIONS,
} from '../services/operator';
import type { CoordinationRequests, OperatorRequests, OperatorSteps } from '../services/operator';
import { canSeeTask } from '../core/projects';
import type { Viewer } from '../core/projects';
import type { OperatorSignals } from '../services/operator';
import type { ProjectService } from '../core/projects';
import type { TaskService } from '../core/tasks';

/** Explains a blocked stage move to the agent in plain English. */
function describeGateBlock(err: DomainError): string {
  const details = (err.details ?? {}) as { unmet?: UnmetCondition[]; approvals?: ApprovalRequirement[] };
  const reasons = (details.unmet ?? []).map((u) => {
    if (u.condition.type !== 'has_label')
      return `the label "${u.condition.label}" is on the task and holds it back (stage "${u.stageId}")`;
    const setters = u.setters?.length ? `; only ${u.setters.join(' or ')} may set it` : '';
    return `the label "${u.condition.label}" is missing (required to enter stage "${u.stageId}"${setters})`;
  });
  if (reasons.length === 0 && details.approvals?.length) {
    reasons.push(
      ...details.approvals.map(
        (a) =>
          `stage "${a.stageId}" needs a human approval (label "${a.label}", from ${a.approvers.join(' or ')})`,
      ),
    );
  }
  return reasons.length > 0
    ? `The stage move is blocked: ${reasons.join('; ')}. Nothing from this call was recorded; ` +
        'send the labels and the note again, without stage_id or once the gate is met.'
    : err.message;
}

/** attach_file refusals: the file's own (path, kind, size, change), and the size limit hit while reading. */
export function toFileToolError(
  err: unknown,
  requested: string,
  done: 'attached' | 'sent' = 'attached',
): unknown {
  if (err instanceof WorkspaceFileRefusal)
    return new TeamToolError(
      err.reason === 'outside' ? 'forbidden' : 'invalid',
      // The refusal may not name the file; with several files the caller must know which one.
      `${err.message.includes(requested) ? '' : `${requested}: `}${err.message} Nothing was ${done}.`,
    );
  if (err instanceof DomainError && err.code === 'attachment_too_large')
    return new TeamToolError(
      'invalid',
      `${requested} grew past ${MAX_ATTACHMENT_BYTES} bytes while it was read; nothing was ${done}.`,
    );
  return err;
}

/** A refused call as the step log keeps it: the named error code, or the nearest one of the tool error. */
export function refusalOf(err: unknown): { code: ErrorCode; message: string } {
  if (err instanceof DomainError) return { code: err.code, message: err.message };
  if (err instanceof TeamToolError) {
    const named = /^([a-z_]+):/.exec(err.message)?.[1];
    if (named && (ERROR_CODES as readonly string[]).includes(named))
      return { code: named as ErrorCode, message: err.message };
    const byTool = {
      not_found: 'not_found',
      forbidden: 'unauthorized',
      invalid: 'invalid_request',
      gate_blocked: 'gate_blocked',
    } as const;
    return { code: byTool[err.code], message: err.message };
  }
  return { code: 'internal_error', message: err instanceof Error ? err.message : String(err) };
}

/** The owners of the project: the people the Operator may report and ask. */
export function isOwner(config: ProjectConfig, handle: string): boolean {
  return ownerHandles(config).includes(handle);
}

export function toToolError(err: unknown): unknown {
  if (err instanceof TeamToolError || !(err instanceof DomainError)) return err;
  if (err.code === 'operator_signal_closed')
    return new TeamToolError('invalid', `${err.code}: ${err.message}`);
  if (err.code === 'not_found') return new TeamToolError('not_found', err.message);
  if (err.status === 403) return new TeamToolError('forbidden', err.message);
  if (err.code === 'gate_blocked' || err.code === 'approval_requested') {
    return new TeamToolError('gate_blocked', describeGateBlock(err));
  }
  return new TeamToolError('invalid', err.message);
}

/** A tool's caller and, for the Operator, the owner request the call runs for (null for any other caller). */
export interface CallerWithRequest {
  config: ProjectConfig;
  request: ReturnType<OperatorRequests['openFor']>;
  /** The person the Operator talks with when they are not an owner: it reads what they see and answers them (PM-475). */
  guest: GuestView | null;
  /** The system signal the call acts on (PM-545); with no owner request, `request` is the signal round. */
  signalId?: string;
  /** The call holds its signal's step slot (`signalStepsRunning`) until `recorded` logs the step. */
  holdsSignalStep?: boolean;
  beforeWrite?: () => Promise<void>;
  beforeRecord?: () => void;
}

/** The Operator's own step on a system signal, as the guard sees it (PM-545). */
export interface SignalStep {
  signalId: string;
  tool: 'start_task' | 'start_member';
  member: string | null;
  taskKey: string | null;
}

export interface GuestView {
  handle: string;
  viewer: Viewer;
}

export const OWNER_ONLY = 'operator_owner_only';

export class ToolCaller {
  private readonly ctx: DomainContext;
  private readonly projects: Pick<ProjectService, 'config' | 'cachedConfig'>;
  private readonly tasks: Pick<TaskService, 'find' | 'get'>;
  private readonly operatorRequests: Pick<OperatorRequests, 'openFor' | 'openRound' | 'approvalFor'>;
  private readonly coordinationRequests: Pick<CoordinationRequests, 'openFor'>;
  private readonly operatorSteps: Pick<OperatorSteps, 'record' | 'ofSignal'>;
  private readonly operatorSignals: Pick<
    OperatorSignals,
    'presentation' | 'stepTargets' | 'currentStepTargets' | 'stepTaken'
  >;
  private readonly sessionEngine:
    | ((
        sessionId: string,
      ) => Pick<EngineHost, 'sessionFolders' | 'isRealDirectory' | 'openWorkspaceFile'> | undefined)
    | undefined;
  constructor(deps: {
    ctx: DomainContext;
    projects: Pick<ProjectService, 'config' | 'cachedConfig'>;
    tasks: Pick<TaskService, 'find' | 'get'>;
    operatorRequests: Pick<OperatorRequests, 'openFor' | 'openRound' | 'approvalFor'>;
    coordinationRequests: Pick<CoordinationRequests, 'openFor'>;
    operatorSteps: Pick<OperatorSteps, 'record' | 'ofSignal'>;
    operatorSignals: Pick<
      OperatorSignals,
      'presentation' | 'stepTargets' | 'currentStepTargets' | 'stepTaken'
    >;
    sessionEngine?:
      | ((
          sessionId: string,
        ) => Pick<EngineHost, 'sessionFolders' | 'isRealDirectory' | 'openWorkspaceFile'> | undefined)
      | undefined;
  }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.tasks = deps.tasks;
    this.operatorRequests = deps.operatorRequests;
    this.coordinationRequests = deps.coordinationRequests;
    this.operatorSteps = deps.operatorSteps;
    this.operatorSignals = deps.operatorSignals;
    this.sessionEngine = deps.sessionEngine;
  }
  /** Signals with an own step of the Operator running now (PM-545); one at a time, whatever the budget left. */
  private readonly signalStepsRunning = new Set<string>();
  /**
   * `caller`, plus the owner request the guard let the Operator's call through on (null for any other
   * caller and for a reading tool with none open). The step log must use this very request: opening it
   * again could find it expired between the guard and the write.
   */
  async callerWithRequest(
    ctx: ToolContext,
    tool: string,
    signal?: { ids: string[]; to: string[] },
    signalStep?: SignalStep,
    operation?: OperatorOperation,
  ): Promise<CallerWithRequest> {
    const config = await this.projects.config(ctx.projectKey);
    if (['screen_question', 'dismiss_signal', 'triage_loop', 'start_task', 'start_member'].includes(tool)) {
      this.assertCoordinationSession(ctx, config);
      const request = this.coordinationRequests.openFor(ctx.sessionId);
      if (OPERATOR_SCREENING_TOOLS.has(tool)) return { config, request: null, guest: null };
      // A signal always keeps its exact binding and budget, even when an owner request is open.
      if (signalStep) return this.signalStepCaller(ctx, config, signalStep);
      if (!request)
        throw new TeamToolError(
          'forbidden',
          'operator_no_request: coordination starts require your own open owner request or a permitted signal.',
        );
      const beforeRecord = () => {
        this.assertCoordinationSession(ctx, this.projects.cachedConfig(ctx.projectKey)!);
        if (this.coordinationRequests.openFor(ctx.sessionId)?.id !== request.id)
          throw new TeamToolError(
            'forbidden',
            'operator_no_request: the coordination request expired or closed.',
          );
      };
      return {
        config,
        request,
        guest: null,
        beforeRecord,
        beforeWrite: async () => {
          this.assertCoordinationSession(ctx, await this.projects.config(ctx.projectKey));
          beforeRecord();
        },
      };
    }
    const member = memberOf(config, ctx.member);
    if (member?.kind !== 'ai')
      throw new TeamToolError(
        'forbidden',
        `${ctx.member} is not an active AI member of this team, so the team tools are not available.`,
      );
    const operator = isOperator(member);
    if (operator && (tool === 'get_operator_preference' || tool === 'set_operator_preference')) {
      const session = this.ctx.repos.sessions.get(ctx.sessionId);
      if (
        !session ||
        session.projectKey !== ctx.projectKey ||
        session.member !== ctx.member ||
        session.workItem.type !== 'general'
      )
        throw new TeamToolError(
          'forbidden',
          `${OWNER_ONLY}: preferences require your own general conversation.`,
        );
    }
    const request = operator ? this.operatorRequests.openFor(ctx.sessionId) : null;
    const guest = operator ? this.guestOf(ctx, config, request) : null;
    if (
      request?.source === 'approval' &&
      !OPERATOR_READ_TOOLS.has(tool) &&
      !OPERATOR_SCREENING_TOOLS.has(tool)
    ) {
      const proposal = this.operatorRequests.approvalFor(config, request, ctx.member);
      if (tool !== 'operate' || !proposal || !operatorKnowledgeOperationIncluded(proposal, operation))
        throw new TeamToolError(
          'forbidden',
          'operator_no_request: an approval continuation permits only its stored operate operations; a new owner message or answer is required.',
        );
    }
    if (signal) {
      if (tool === 'send_message')
        this.assertOperatorMessageRecipients(ctx.member, { config, request, guest }, signal.to);
      // Signals are the owners' business: never from a guest conversation, never to anyone else.
      if (
        tool !== 'send_message' ||
        coordinationActorRefusal(config, { kind: 'ai', handle: ctx.member }) !== null ||
        guest ||
        signal.ids.length === 0 ||
        signal.to.some((handle) => !isOwner(config, handle))
      )
        throw new TeamToolError(
          'invalid',
          'invalid_request: only the selected PM may present signals to owners.',
        );
      this.assertCoordinationSession(ctx, config);
      for (const id of signal.ids) this.operatorSignals.presentation(ctx.projectKey, id, ctx.member);
    }
    if (!operator) return { config, request: null, guest: null };
    if (guest) {
      // A guest only reads, answers and changes their own conversational preference (PM-475, PM-688).
      if (!OPERATOR_GUEST_TOOLS.has(tool)) {
        this.recordRefusedWrite({ config, request, guest }, tool);
        throw new TeamToolError(
          'forbidden',
          `${OWNER_ONLY}: ${tool} is not for a conversation with ${guest.handle}.`,
        );
      }
      return { config, request, guest };
    }
    if (OPERATOR_NEVER_TOOLS.has(tool))
      throw new TeamToolError(
        'forbidden',
        `operator_never: ${tool} is not for the Operator. Decisions of other members, hand-overs and publishing outside are not its to do; tell the owner what you found.`,
      );
    if (!request && !OPERATOR_READ_TOOLS.has(tool) && !signal) {
      throw new TeamToolError(
        'forbidden',
        `operator_no_request: ${tool} writes, and the Operator writes only for an open request of an owner. ` +
          "There is none (its round is over or it timed out); wait for the owner's next message.",
      );
    }
    return { config, request, guest: null };
  }

  /**
   * The caller must still be an AI member of the project. The Operator (PM-463) also needs an open
   * owner request for every tool but the reading ones, and never calls the tools of other members'
   * decisions; `tool` is the MCP name of the tool being called.
   */
  async caller(ctx: ToolContext, tool: string): Promise<ProjectConfig> {
    return (await this.callerWithRequest(ctx, tool)).config;
  }

  /** The same recipient guard applies to ordinary sends and signal presentations. */
  assertOperatorMessageRecipients(source: string, who: CallerWithRequest, to: string[]): void {
    if (who.guest || !isOperator(memberOf(who.config, source))) return;
    const recipient = to.find((handle) => {
      const member = memberOf(who.config, handle);
      return member?.kind === 'human' && member.access !== 'owner';
    });
    if (recipient === undefined) return;
    const refusal: { code: ErrorCode; message: string } = {
      code: 'operator_owner_approval',
      message:
        'use operate with message_send and a plan; the owner must approve the exact message before it is sent',
    };
    this.recordRefusedWrite(who, 'send_message', recipient, refusal);
    throw new TeamToolError('forbidden', `${refusal.code}: ${refusal.message}.`);
  }

  /** Logs a write the Operator was refused as a refused step of its request. */
  recordRefusedWrite(
    who: CallerWithRequest,
    tool: string,
    member?: string,
    refusal?: { code: ErrorCode; message: string },
  ): void {
    const action = OPERATOR_TOOL_ACTIONS[tool];
    if (!action || !who.request) return;
    this.operatorSteps.record({
      requestId: who.request.id,
      action,
      taskKey: null,
      member: member && memberOf(who.config, member) ? member : null,
      status: 'refused',
      refusal: refusal ?? {
        code: 'operator_owner_only',
        message: `${tool} is for the project owner's request`,
      },
    });
  }

  /**
   * Runs the Operator's write and logs it as one step of its open request, done or refused (PM-463).
   * Any other caller (`request` null), and a call that is no step (`step` null), just runs.
   */
  async recorded<T>(
    { config, request, signalId, holdsSignalStep, beforeWrite }: CallerWithRequest,
    step: {
      action: OperatorAction;
      taskKey?: string | null;
      member?: string | null;
      /** The task the call made, when the step names it only afterwards. */
      madeTask?: (result: T) => string;
      madeMember?: (result: T) => string | null;
    } | null,
    run: () => Promise<T>,
    /** A refusal that is no refusal: the change waits for a human's approval. */
    awaitsApproval?: (err: unknown) => boolean,
  ): Promise<T> {
    try {
      if (beforeWrite) await this.guard(beforeWrite);
      if (!step || !request) return await run();
      const target = {
        action: step.action,
        taskKey: step.taskKey && TaskKey.safeParse(step.taskKey).success ? step.taskKey : null,
        member: step.member && memberOf(config, step.member) ? step.member : null,
        ...(signalId ? { signalId } : {}),
      };
      let result: T;
      try {
        result = await run();
      } catch (err) {
        this.operatorSteps.record(
          awaitsApproval?.(err)
            ? { requestId: request.id, ...target, status: 'awaiting_approval' }
            : { requestId: request.id, ...target, status: 'refused', refusal: refusalOf(err) },
        );
        throw err;
      }
      this.operatorSteps.record({
        requestId: request.id,
        ...target,
        ...(step.madeTask ? { taskKey: step.madeTask(result) } : {}),
        ...(step.madeMember ? { member: step.madeMember(result) } : {}),
        status: 'done',
      });
      // An own step on a signal: the signal is shown to the Operator again if its case still stands later (PM-545).
      if (signalId && request.source === 'signal') this.operatorSignals.stepTaken(signalId);
      return result;
    } finally {
      // The step is logged now (or the call failed): the signal's slot is free, the budget counts it.
      if (holdsSignalStep && signalId) this.signalStepsRunning.delete(signalId);
    }
  }

  /** The explicit task key, else the session's task, else null. */
  taskKeyFor(ctx: ToolContext, taskKey: string | undefined): string | null {
    const key = taskKey ?? ctx.taskKey;
    return key ? this.validTaskKey(ctx, key) : null;
  }

  /** A task key of the caller's project. */
  validTaskKey(ctx: ToolContext, taskKey: string): string {
    if (!TaskKey.safeParse(taskKey).success)
      throw new TeamToolError(
        'invalid',
        `Invalid task key "${taskKey}"; task keys look like "${ctx.projectKey}-12".`,
      );
    if (!this.tasks.find(ctx.projectKey, taskKey))
      throw new TeamToolError('not_found', `Task ${taskKey} does not exist in this project.`);
    return taskKey;
  }

  /**
   * A task key of the caller's project that the guest may see: a card they may not see does not exist
   * for them (PM-475). Without a guest (any other caller) it is `validTaskKey`.
   */
  visibleTaskKey(ctx: ToolContext, guest: GuestView | null, taskKey: string): string {
    const key = this.validTaskKey(ctx, taskKey);
    if (guest && !canSeeTask(guest.viewer, this.tasks.get(ctx.projectKey, key)))
      throw new TeamToolError('not_found', `Task ${key} does not exist in this project.`);
    return key;
  }

  /**
   * The calling session, whose working directory (`cwd`) is as the server recorded it when it
   * started the session. The token names the session; it must still be this member's session in
   * this project.
   */
  callerSession(ctx: ToolContext): Session {
    const session = this.ctx.repos.sessions.get(ctx.sessionId);
    if (!session || session.projectKey !== ctx.projectKey || session.member !== ctx.member)
      throw new TeamToolError(
        'forbidden',
        'Your session is not known to the server, so no file can be attached.',
      );
    return session;
  }

  /**
   * Opens a file of the caller's session for reading: a path inside its session folder or relative to
   * its working directory (`attach_file`, and the files of `send_message`). The directories are the ones
   * the server started the session with; the caller never names them. The session folder is the one the
   * server made for this process (it remembers it; the path is never derived from the id) and counts
   * only while it exists.
   */
  async openSessionFile(
    ctx: ToolContext,
    requested: string,
    done: 'attached' | 'sent',
  ): Promise<WorkspaceFile> {
    const session = this.callerSession(ctx);
    const engine = this.sessionEngine?.(session.id);
    if (!engine) throw new TeamToolError('invalid', 'The engine your session runs on is not connected.');
    const recorded = engine.sessionFolders?.of(session.id);
    const folder = recorded && (await engine.isRealDirectory(recorded)) ? recorded : null;
    const inFolder =
      folder !== null && path.isAbsolute(requested) && isWithin(folder, path.resolve(requested));
    const place = inFolder
      ? { name: 'your session folder' }
      : {
          name: 'your working directory',
          ...(folder ? { other: { name: 'your session folder', path: folder } } : {}),
        };
    return engine
      .openWorkspaceFile(inFolder ? folder : session.cwd, requested, {
        maxBytes: MAX_ATTACHMENT_BYTES,
        place,
        // The sandbox lets the session empty and replace its own folder, so it must be its own real path.
        exactRoot: inFolder,
        sessionId: session.id,
      })
      .catch((err: unknown) => {
        throw toFileToolError(err, requested, done);
      });
  }

  async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw toToolError(err);
    }
  }

  /**
   * The Operator's own step on a system signal without an owner's request (PM-545): the project's level,
   * the signal's targets and the signal's budget of steps decide; a refusal is no step. The step then hangs
   * on the session's signal round.
   */
  private async signalStepCaller(
    ctx: ToolContext,
    config: ProjectConfig,
    step: SignalStep,
  ): Promise<CallerWithRequest> {
    const level = operatorWatchOf(config);
    const refuse: (code: string, text: string) => never = (code, text) => {
      throw new TeamToolError('forbidden', `${code}: ${text}`);
    };
    const noRequest = `${step.tool} writes, and the Operator writes only for an open request of an owner`;
    if (level === 'report')
      refuse('operator_no_request', `${noRequest}; this project lets it only report signals.`);
    const { signal, allowed } = await this.operatorSignals
      .stepTargets(ctx.projectKey, step.signalId)
      .catch((err: unknown) => {
        if (err instanceof DomainError) throw new TeamToolError('invalid', `${err.code}: ${err.message}`);
        throw err;
      });
    const freshConfig = await this.projects.config(ctx.projectKey);
    this.assertCoordinationSession(ctx, freshConfig);
    if (signal.deliveredTo !== ctx.member)
      refuse('operator_signal_closed', 'the signal was not delivered to this PM.');
    const refusal = operatorSignalStepRefusal({
      level: operatorWatchOf(freshConfig),
      kind: signal.kind,
      tool: step.tool,
      target: { member: step.member, taskKey: step.taskKey },
      allowed,
      stepsAt: this.operatorSteps
        .ofSignal(signal.id)
        .filter((s) => s.status !== 'refused')
        .map((s) => s.at),
      now: isoNow(this.ctx),
    });
    if (refusal?.code === 'operator_no_request')
      refuse(
        'operator_no_request',
        `${noRequest}. At level ${level} a ${signal.kind} signal does not allow this call (${refusal.reason}).`,
      );
    if (refusal)
      refuse(
        'operator_signal_budget',
        refusal.reason === 'used'
          ? 'this signal has no step left; tell the owner what you did and what became of it.'
          : `the last step on this signal was less than ${OPERATOR_SIGNAL_STEP_GAP_MINUTES} minutes ago; retry after ${refusal.retryAt}.`,
      );
    // The budget counts logged steps, and a step is logged only after it ran: a call that arrives while
    // another step on this signal is running would pass the count too. No await between the count and here.
    if (this.signalStepsRunning.has(signal.id))
      refuse(
        'operator_signal_budget',
        'a step on this signal is still running; wait for its result before you take another.',
      );
    const request = this.operatorRequests.openRound(ctx.projectKey, ctx.sessionId);
    this.signalStepsRunning.add(signal.id);
    const card = step.taskKey ? this.tasks.get(ctx.projectKey, step.taskKey) : null;
    const beforeRecord = () => {
      const config = this.projects.cachedConfig(ctx.projectKey)!;
      this.assertCoordinationSession(ctx, config);
      const { signal: current, allowed } = this.operatorSignals.currentStepTargets(ctx.projectKey, signal.id);
      const task = card && this.tasks.get(ctx.projectKey, card.key);
      if (
        !current ||
        current.resolvedAt ||
        current.deliveredTo !== ctx.member ||
        current.deliveredAt !== signal.deliveredAt ||
        !['pending', 'open'].includes(current.state) ||
        (card &&
          (!task ||
            task.stageId !== card.stageId ||
            task.assignee !== card.assignee ||
            task.status !== card.status ||
            task.fixLimit ||
            task.labels.join() !== card.labels.join()))
      )
        refuse('operator_signal_closed', 'the signal or its target changed before execution.');
      const refusal = operatorSignalStepRefusal({
        level: operatorWatchOf(config),
        kind: current.kind,
        tool: step.tool,
        target: { member: step.member, taskKey: step.taskKey },
        allowed,
        stepsAt: this.operatorSteps
          .ofSignal(signal.id)
          .filter((s) => s.status !== 'refused')
          .map((s) => s.at),
        now: isoNow(this.ctx),
      });
      if (refusal) refuse(refusal.code, `the signal no longer permits the step (${refusal.reason}).`);
    };
    return {
      config,
      request,
      guest: null,
      signalId: signal.id,
      holdsSignalStep: true,
      beforeRecord,
      beforeWrite: async () => {
        this.assertCoordinationSession(ctx, await this.projects.config(ctx.projectKey));
        beforeRecord();
      },
    };
  }

  /** The token must name the selected PM's internal general session, never a customer conversation. */
  assertCoordinationSession(ctx: ToolContext, config: ProjectConfig): void {
    const session = this.ctx.repos.sessions.get(ctx.sessionId);
    if (
      coordinationActorRefusal(config, { kind: 'ai', handle: ctx.member }) ||
      !session ||
      session.projectKey !== ctx.projectKey ||
      session.member !== ctx.member ||
      session.workItem.type !== 'general' ||
      session.workItem.with
    )
      throw new TeamToolError(
        'forbidden',
        'project_manager_only: coordination requires the selected PM internal conversation.',
      );
  }

  /**
   * The person the Operator's session talks with when they are not an owner (a `with` conversation, or a
   * request of someone who is no owner), as their view of the project; null in the owner's conversation.
   */
  private guestOf(
    ctx: ToolContext,
    config: ProjectConfig,
    request: ReturnType<OperatorRequests['openFor']>,
  ): GuestView | null {
    const workItem = this.ctx.repos.sessions.get(ctx.sessionId)?.workItem;
    const handle =
      (workItem?.type === 'general' ? workItem.with : undefined) ??
      (request && !isOwner(config, request.fromHandle) ? request.fromHandle : undefined);
    if (handle === undefined) return null;
    const person = memberOf(config, handle);
    // Someone no longer in the team sees nothing: the narrowest access there is.
    const access = person?.kind === 'human' ? person.access : 'client';
    return { handle, viewer: { access, handle } };
  }
}

/** The send_message refusals of the messaging module, in the words the agent reads. */
export function toMessageToolError(err: unknown): unknown {
  if (!(err instanceof DomainError)) return err;
  if (err.code === 'card_busy') {
    const busy = CardBusyDetails.parse(err.details);
    const groups = busy.groups.map((group) => {
      const joining = group.joining.join(', ');
      if (group.working.length === 0)
        return `this message would put ${joining} to work on it as ${group.role}`;
      const working = group.working.map((worker) => `${worker.handle} (${worker.state})`).join(', ');
      return `${working} already works on it as ${group.role}; this message would also put ${joining} to work on it`;
    });
    return new TeamToolError(
      'invalid',
      `card_busy: ${busy.taskKey}: ${groups.join('; ')}. Nothing was sent. Send it to the member already working, wait until they finish, send it as info, or send again with despite_workers: true if the parallel work is intended.`,
    );
  }
  const details = (err.details ?? {}) as { field?: string; what?: string; ids?: string[] };
  if (err.code === 'invalid_request' && details.field === 'text')
    return new TeamToolError('invalid', 'The message text is empty.');
  if (err.code === 'invalid_request' && details.field === 'to')
    return new TeamToolError('invalid', 'No recipients: name at least one team member other than yourself.');
  if (err.code === 'not_found' && details.what === 'member' && details.ids)
    return new TeamToolError(
      'not_found',
      `Unknown team members: ${details.ids.join(', ')}. Use list_members to see the handles.`,
    );
  return err;
}
