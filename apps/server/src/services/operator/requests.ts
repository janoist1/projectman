import {
  coordinationMemberOf,
  structuralReviewContinuation,
  memberOf,
  operatorKnowledgeApprovalOf,
  operatorKnowledgeContinuationOf,
  OPERATOR_SIGNAL_ROUND_FROM,
} from '@projectman/shared';
import type {
  ConfigChangeRow,
  ErrorCode,
  OperatorAction,
  OperatorRequestView,
  OperatorStep,
  OperatorStepStatus,
  ProjectConfig,
} from '@projectman/shared';
import type { OperatorRequestRecord, OperatorStepRecord } from '../../db';
import type { ProjectService } from '../../core/projects';
import { isoNow } from '../../core/base';
import type { DomainContext } from '../../core/base';
import { forbidden, newId } from '../../kernel';

/** An owner's request to the Operator stays open this long at most; the end of its turn closes it sooner. */
export const OPERATOR_REQUEST_TTL_MS = 30 * 60_000;
/** The part of the owner's text a request quotes. */
const OPERATOR_QUOTE_LENGTH = 280;
/** How many requests the Operator's channel lists. */
const OPERATOR_CHANNEL_REQUESTS = 50;

/** The first `OPERATOR_QUOTE_LENGTH` characters of the text, its line breaks as spaces. */
function operatorQuoteOf(text: string): string {
  return Array.from(text.replace(/\s*[\r\n]+\s*/g, ' ').trim())
    .slice(0, OPERATOR_QUOTE_LENGTH)
    .join('');
}

/** The team tools (MCP names) the Operator may call without an open request: they only read. */
export const OPERATOR_READ_TOOLS: ReadonlySet<string> = new Set([
  'get_guide',
  'get_role_configuration',
  'get_operator_preference',
  'get_operator_knowledge',
  'get_checklist',
  'get_task',
  'list_tasks',
  'list_members',
  'list_attachments',
  'read_attachment',
  'read_message_attachment',
  'get_screenshot_run',
  'get_project_state',
  'get_operator_diagnostics',
  'check_release',
  'read_project_doc',
  'list_decision_candidates',
  'search_history',
  'read_history_source',
  'list_system_feedback',
]);

/**
 * The writes the Operator may make without an open request (PM-479): a finding about projectman itself is
 * recorded when it is found, not only while an owner is waiting. Under an approval continuation they stay
 * refused, and a guest conversation never reaches them (`OPERATOR_GUEST_TOOLS`).
 */
export const OPERATOR_NO_REQUEST_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'record_system_feedback',
  'update_checklist',
]);

/**
 * The PM's standing screening tools (legacy constant name), with no owner request or step logged:
 * question screening and signal triage are answered on their own records.
 * Never in a guest conversation.
 */
export const OPERATOR_SCREENING_TOOLS: ReadonlySet<string> = new Set([
  'combine_questions',
  'screen_question',
  'dismiss_signal',
  'open_integrator_todo',
  'triage_loop',
]);

/**
 * The PM's card tools (PM-1040): reassign and cancel a card with a reason on the timeline. The selected PM in its
 * internal conversation, with no owner request; refused in an approval continuation.
 */
export const PM_CARD_TOOLS: readonly string[] = ['reassign_task', 'cancel_task'];

/**
 * The team tools the Operator never calls, request or not: decisions of other members, handovers and
 * publishing outside the machine.
 */
export const OPERATOR_NEVER_TOOLS: ReadonlySet<string> = new Set([
  'decide_permission_request',
  'decide_fix_limit',
  'hand_off',
  'merge_task',
  'propose_release',
]);

/**
 * The team tools the Operator may call in a conversation with someone who is not an owner (PM-475):
 * it reads what that person can see, answers them (`send_message`, to them only), and changes only
 * their personal conversation style (PM-688).
 * `get_project_state` is left out on purpose: guest access needs a viewer filter in a separate task.
 * The history search reads with the guest's own view (PM-787). `get_history_search_stats` is here only so that
 * an admin's guest conversation reaches its own check; any other guest is refused `history_stats_forbidden`.
 */
export const OPERATOR_GUEST_TOOLS: ReadonlySet<string> = new Set([
  'get_guide',
  'get_operator_preference',
  'set_operator_preference',
  'get_task',
  'list_tasks',
  'list_members',
  'list_attachments',
  'read_attachment',
  'read_message_attachment',
  'send_message',
  'search_history',
  'read_history_source',
  'get_history_search_stats',
]);

/**
 * The step a refused write is logged as: the action the call would have been. A tool that is no
 * action of the Operator's (`OperatorAction`) is refused with no step.
 */
export const OPERATOR_TOOL_ACTIONS: Readonly<Record<string, OperatorAction>> = {
  send_message: 'message',
  create_task: 'task_create',
  update_task: 'task_update',
  attach_file: 'task_update',
  delete_attachment: 'task_update',
  link_pull_request: 'task_update',
  start_task: 'task_start',
  start_member: 'task_start',
  operate: 'config_change',
  execute_operation: 'operation',
  propose_operator_knowledge: 'knowledge_change',
  write_project_docs: 'docs_write',
  mark_decision_candidates: 'decision_offer',
  prioritize_merge: 'task_update',
  record_system_feedback: 'system_feedback',
};

interface OpenOperatorRequest {
  projectKey: string;
  sessionId: string;
  source: 'message' | 'answer' | 'approval' | 'queue';
  messageId: string | null;
  inboxItemId?: string | null;
  /** The member queue item a `queue` request works on (PM-885). */
  queueItemId?: string | null;
  from: string;
  text: string;
}

/**
 * The owner's requests to the Operator (PM-463). A request opens when an owner's message, or an owner's
 * answer to the Operator's question, enters its session; it closes when that session's turn ends
 * (`closeForSession` on `session_idle` and `session_ended`), when a new request opens, or after
 * `OPERATOR_REQUEST_TTL_MS`. The Operator writes only while one is open (`openFor`).
 */
export class OperatorRequests {
  private readonly ctx: DomainContext;

  constructor(deps: { ctx: DomainContext }) {
    this.ctx = deps.ctx;
  }

  /** Opens a request and closes the session's previous ones. */
  open(input: OpenOperatorRequest): OperatorRequestRecord {
    const { repos } = this.ctx;
    const now = isoNow(this.ctx);
    return this.ctx.unitOfWork(() => {
      const id = input.source === 'approval' ? `opr_approval_${input.inboxItemId}` : newId('opr');
      const previousApproval = input.source === 'approval' ? repos.operatorRequests.get(id) : null;
      // A consumed continuation, including a closed one, never opens a fresh authorization round.
      if (previousApproval) return previousApproval;
      for (const previous of repos.operatorRequests.openOfSession(input.sessionId))
        repos.operatorRequests.close(previous.id, now);
      const request = {
        id,
        projectKey: input.projectKey,
        sessionId: input.sessionId,
        source: input.source,
        messageId: input.messageId,
        inboxItemId: input.inboxItemId ?? null,
        queueItemId: input.queueItemId ?? null,
        fromHandle: input.from,
        quote: operatorQuoteOf(input.text),
        openedAt: now,
      };
      repos.operatorRequests.insert(request);
      return { ...request, closedAt: null };
    });
  }

  approvalFor(config: ProjectConfig, request: OperatorRequestRecord, operator: string) {
    if (request.source !== 'approval' || !request.inboxItemId || !request.messageId) return null;
    const message = this.ctx.repos.messages.get(request.messageId);
    const item = this.ctx.repos.inbox.get(request.inboxItemId);
    const payload = item && operatorKnowledgeApprovalOf(item);
    if (
      !message ||
      message.origin?.kind !== 'operator_knowledge_approval' ||
      message.origin.inboxItemId !== item?.id ||
      message.from !== request.fromHandle ||
      !payload ||
      config.project.key !== request.projectKey ||
      message.projectKey !== request.projectKey ||
      !message.to.includes(operator)
    )
      return null;
    const owner = memberOf(config, request.fromHandle);
    return operatorKnowledgeContinuationOf(item, {
      projectKey: request.projectKey,
      from: request.fromHandle,
      operator,
      messageId: message.id,
      owner: owner?.kind === 'human' && owner.access === 'owner',
      via: message.via,
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
  }

  /** The request the session works on now: the newest one that is not closed and not past its time. */
  openFor(sessionId: string): OperatorRequestRecord | null {
    let found: OperatorRequestRecord | null = null;
    for (const request of this.ctx.repos.operatorRequests.openOfSession(sessionId)) {
      if (this.expire(request) || request.source === 'signal') continue;
      found ??= request;
    }
    return found;
  }

  /**
   * The signal round of the session (PM-545): the row its own steps on system signals hang on, open until
   * the turn ends or its time is up. It authorizes nothing: `openFor` never returns it.
   */
  roundFor(sessionId: string): OperatorRequestRecord | null {
    for (const request of this.ctx.repos.operatorRequests.openOfSession(sessionId))
      if (request.source === 'signal' && !this.expire(request)) return request;
    return null;
  }

  /** The session's signal round, opened by the first step on a signal. */
  openRound(projectKey: string, sessionId: string): OperatorRequestRecord {
    const open = this.roundFor(sessionId);
    if (open) return open;
    const request = {
      id: newId('opr'),
      projectKey,
      sessionId,
      source: 'signal' as const,
      messageId: null,
      inboxItemId: null,
      queueItemId: null,
      fromHandle: OPERATOR_SIGNAL_ROUND_FROM,
      quote: '',
      openedAt: isoNow(this.ctx),
    };
    this.ctx.repos.operatorRequests.insert(request);
    return { ...request, closedAt: null };
  }

  /** The session's turn is over (idle) or the session ended: its open requests close. */
  closeForSession(sessionId: string): void {
    const now = isoNow(this.ctx);
    for (const request of this.ctx.repos.operatorRequests.openOfSession(sessionId))
      this.ctx.repos.operatorRequests.close(request.id, now);
  }

  /**
   * The latest requests that these members made with their steps, the newest last; the ones past their
   * time are closed first. The owners' channel lists the owners' requests, a guest's their own (PM-475).
   */
  views(projectKey: string, fromHandles: string[], recipient?: string): OperatorRequestView[] {
    const { operatorRequests } = this.ctx.repos;
    for (const request of operatorRequests.openOfProject(projectKey)) this.expire(request);
    return operatorRequests
      .latestFrom(projectKey, fromHandles, OPERATOR_CHANNEL_REQUESTS, recipient)
      .map((request) => ({
        id: request.id,
        messageId: request.messageId,
        quote: request.quote,
        openedAt: request.openedAt,
        closedAt: request.closedAt,
        steps: operatorRequests.steps(request.id).map(stepView),
      }));
  }

  /** Closes the request when its time is up, at the moment it ran out; true when it is closed. */
  private expire(request: OperatorRequestRecord): boolean {
    const until = Date.parse(request.openedAt) + OPERATOR_REQUEST_TTL_MS;
    if (this.ctx.now().getTime() < until) return false;
    this.ctx.repos.operatorRequests.close(request.id, new Date(until).toISOString());
    return true;
  }
}

/** The PM's requests use separate session rows and never inherit an Operator request or signal round. */
interface OpenCoordinationRequest extends OpenOperatorRequest {}

export class CoordinationRequests extends OperatorRequests {
  private readonly coordinationCtx: DomainContext;
  private readonly projects: Pick<ProjectService, 'cachedConfig'>;

  constructor(deps: { ctx: DomainContext; projects: Pick<ProjectService, 'cachedConfig'> }) {
    super(deps);
    this.coordinationCtx = deps.ctx;
    this.projects = deps.projects;
  }

  override open(input: OpenCoordinationRequest): OperatorRequestRecord {
    if (!this.isCoordinationSession(input.sessionId, input.projectKey))
      throw forbidden('project_manager_only', 'coordination requires the selected PM internal conversation');
    if (input.source === 'approval' && !this.validApproval(input))
      throw forbidden('operator_no_request', 'no structural approval continuation is authorized for the PM');
    return super.open(input);
  }

  override openFor(sessionId: string): OperatorRequestRecord | null {
    const request = this.isCoordinationSession(sessionId) ? super.openFor(sessionId) : null;
    if (
      request?.source === 'approval' &&
      !this.validApproval({
        projectKey: request.projectKey,
        sessionId,
        messageId: request.messageId,
        inboxItemId: request.inboxItemId,
        source: 'approval',
        from: request.fromHandle,
        text: request.quote,
      })
    )
      return null;
    return request;
  }

  private validApproval(input: OpenCoordinationRequest): boolean {
    const { repos } = this.coordinationCtx;
    const message = input.messageId && repos.messages.get(input.messageId);
    const item = input.inboxItemId && repos.inbox.get(input.inboxItemId);
    const config = this.projects.cachedConfig(input.projectKey);
    const pm = config && coordinationMemberOf(config);
    const owner = config && memberOf(config, input.from);
    return !!(
      message &&
      item &&
      pm &&
      message.from === input.from &&
      structuralReviewContinuation(
        item,
        message,
        pm.handle,
        owner?.kind === 'human' && owner.access === 'owner',
      )
    );
  }

  private isCoordinationSession(sessionId: string, projectKey?: string): boolean {
    const session = this.coordinationCtx.repos.sessions.get(sessionId);
    const config = session && this.projects.cachedConfig(session.projectKey);
    return !!(
      session &&
      config &&
      (!projectKey || session.projectKey === projectKey) &&
      coordinationMemberOf(config)?.handle === session.member &&
      session.workItem.type === 'general' &&
      !session.workItem.with
    );
  }
}

function stepView(step: OperatorStepRecord): OperatorStep {
  return {
    ...step,
    agreementVersion: step.agreementVersion ?? null,
    approvalMode: step.approvalMode ?? null,
    operationId: step.operationId ?? null,
    systemFeedback: step.systemFeedback ?? null,
    refusal: step.refusal ? { code: step.refusal.code as ErrorCode, message: step.refusal.message } : null,
  };
}

interface OperatorStepInput {
  agreementVersion?: number | null;
  approvalMode?: 'click' | 'waived' | null;
  id?: string;
  requestId: string;
  action: OperatorAction;
  status: OperatorStepStatus;
  taskKey?: string | null;
  member?: string | null;
  changes?: ConfigChangeRow[];
  configVersion?: string | null;
  inboxItemId?: string | null;
  /** The system signal the step acted on without a request (PM-545). */
  signalId?: string | null;
  /** The super operation the step started (PM-888). */
  operationId?: string | null;
  /** The system feedback a `system_feedback` step recorded (PM-479). */
  systemFeedback?: { id: string; title: string; occurrence: number } | null;
  refusal?: { code: ErrorCode; message: string } | null;
}

/** What the Operator did for a request, one step per call, the refused ones too. */
export class OperatorSteps {
  private readonly ctx: DomainContext;

  constructor(deps: { ctx: DomainContext }) {
    this.ctx = deps.ctx;
  }

  record(input: OperatorStepInput): OperatorStepRecord {
    const step: OperatorStepRecord = {
      agreementVersion: input.agreementVersion ?? null,
      approvalMode: input.approvalMode ?? null,
      id: input.id ?? newId('ops'),
      requestId: input.requestId,
      at: isoNow(this.ctx),
      action: input.action,
      status: input.status,
      taskKey: input.taskKey ?? null,
      member: input.member ?? null,
      changes: input.changes ?? [],
      configVersion: input.configVersion ?? null,
      inboxItemId: input.inboxItemId ?? null,
      signalId: input.signalId ?? null,
      operationId: input.operationId ?? null,
      systemFeedback: input.systemFeedback ?? null,
      refusal: input.refusal ?? null,
    };
    this.ctx.repos.operatorRequests.insertStep(step);
    return step;
  }

  /** The steps the Operator took on a signal, the oldest first. */
  ofSignal(signalId: string): OperatorStepRecord[] {
    return this.ctx.repos.operatorRequests.stepsOfSignal(signalId);
  }
}
