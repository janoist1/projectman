import {
  coordinationMemberOf,
  structuralReviewContinuation,
  memberOf,
  projectManagerKnowledgeApprovalOf,
  projectManagerKnowledgeContinuationOf,
  PROJECT_MANAGER_SIGNAL_ROUND_FROM,
  projectManagerAuthorityOf,
} from '@projectman/shared';
import type {
  ConfigChangeRow,
  ErrorCode,
  ProjectManagerAction,
  ProjectManagerRequestView,
  ProjectManagerStep,
  ProjectManagerStepStatus,
  ProjectConfig,
} from '@projectman/shared';
import type { ProjectManagerRequestRecord, ProjectManagerStepRecord } from '../../db';
import type { ProjectService } from '../../core/projects';
import { isoNow } from '../../core/base';
import type { DomainContext } from '../../core/base';
import { forbidden, newId } from '../../kernel';

/** An owner's request to the project manager stays open this long at most; the end of its turn closes it sooner. */
const PROJECT_MANAGER_REQUEST_TTL_MS = 30 * 60_000;
/** The part of the owner's text a request quotes. */
const PROJECT_MANAGER_QUOTE_LENGTH = 280;
/** How many requests the project manager's channel lists. */
const PROJECT_MANAGER_CHANNEL_REQUESTS = 50;

/** The first `PROJECT_MANAGER_QUOTE_LENGTH` characters of the text, its line breaks as spaces. */
function projectManagerQuoteOf(text: string): string {
  return Array.from(text.replace(/\s*[\r\n]+\s*/g, ' ').trim())
    .slice(0, PROJECT_MANAGER_QUOTE_LENGTH)
    .join('');
}

/** The team tools (MCP names) the project manager may call without an open request: they only read. */
export const PROJECT_MANAGER_READ_TOOLS: ReadonlySet<string> = new Set([
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
  'read_project_doc',
  'list_decision_candidates',
  'search_history',
  'read_history_source',
  'list_system_feedback',
]);

/**
 * The PM's standing screening tools (legacy constant name), with no owner request or step logged:
 * question screening and signal triage are answered on their own records.
 * Never in a guest conversation.
 */
export const PROJECT_MANAGER_SCREENING_TOOLS: ReadonlySet<string> = new Set([
  'combine_questions',
  'screen_question',
  'dismiss_signal',
  'triage_loop',
]);

/**
 * The PM's card tools (PM-1040, PM-1098, PM-1267): reassign, cancel and reopen a card, or involve a member on
 * it, with a reason on the timeline. The
 * selected PM in its internal conversation, with no owner request; refused in an approval continuation.
 */
export const PM_CARD_TOOLS: readonly string[] = [
  'reassign_task',
  'cancel_task',
  'reopen_task',
  'involve_member',
];

/**
 * The team tools the project manager may call in a conversation with someone who is not an owner (PM-475):
 * it reads what that person can see, answers them (`send_message`, to them only), and changes only
 * their personal conversation style (PM-688).
 * `get_project_state` is left out on purpose: guest access needs a viewer filter in a separate task.
 * The history search reads with the guest's own view (PM-787).
 */
export const PROJECT_MANAGER_GUEST_TOOLS: ReadonlySet<string> = new Set([
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
]);

/**
 * The step a refused write is logged as: the action the call would have been. A tool that is no
 * action of the project manager's (`ProjectManagerAction`) is refused with no step.
 */
export const PROJECT_MANAGER_TOOL_ACTIONS: Readonly<Record<string, ProjectManagerAction>> = {
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

interface OpenProjectManagerRequest {
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
 * The owner's requests to the project manager (PM-463). A request opens when an owner's message, or an owner's
 * answer to the project manager's question, enters its session; it closes when that session's turn ends
 * (`closeForSession` on `session_idle` and `session_ended`), when a new request opens, or after
 * `PROJECT_MANAGER_REQUEST_TTL_MS`. The project manager writes only while one is open (`openFor`); the project manager
 * under `outside_owner_only` also writes on its session's own round (`actingRequest`, PM-1287).
 */
export class ProjectManagerRequests {
  private readonly ctx: DomainContext;

  constructor(deps: { ctx: DomainContext }) {
    this.ctx = deps.ctx;
  }

  /** Opens a request and closes the session's previous ones. */
  open(input: OpenProjectManagerRequest): ProjectManagerRequestRecord {
    const { repos } = this.ctx;
    const now = isoNow(this.ctx);
    return this.ctx.unitOfWork(() => {
      const id = input.source === 'approval' ? `opr_approval_${input.inboxItemId}` : newId('opr');
      const previousApproval = input.source === 'approval' ? repos.projectManagerRequests.get(id) : null;
      // A consumed continuation, including a closed one, never opens a fresh authorization round.
      if (previousApproval) return previousApproval;
      for (const previous of repos.projectManagerRequests.openOfSession(input.sessionId))
        repos.projectManagerRequests.close(previous.id, now);
      const request = {
        id,
        projectKey: input.projectKey,
        sessionId: input.sessionId,
        source: input.source,
        messageId: input.messageId,
        inboxItemId: input.inboxItemId ?? null,
        queueItemId: input.queueItemId ?? null,
        fromHandle: input.from,
        quote: projectManagerQuoteOf(input.text),
        openedAt: now,
      };
      repos.projectManagerRequests.insert(request);
      return { ...request, closedAt: null };
    });
  }

  approvalFor(config: ProjectConfig, request: ProjectManagerRequestRecord, operator: string) {
    if (request.source !== 'approval' || !request.inboxItemId || !request.messageId) return null;
    const message = this.ctx.repos.messages.get(request.messageId);
    const item = this.ctx.repos.inbox.get(request.inboxItemId);
    const payload = item && projectManagerKnowledgeApprovalOf(item);
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
    return projectManagerKnowledgeContinuationOf(item, {
      projectKey: request.projectKey,
      from: request.fromHandle,
      operator,
      messageId: message.id,
      owner: owner?.kind === 'human' && owner.access === 'owner',
      via: message.via,
      approvedStep: this.ctx.repos.projectManagerRequests
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
  openFor(sessionId: string): ProjectManagerRequestRecord | null {
    let found: ProjectManagerRequestRecord | null = null;
    for (const request of this.ctx.repos.projectManagerRequests.openOfSession(sessionId)) {
      if (this.expire(request) || request.source === 'signal') continue;
      found ??= request;
    }
    return found;
  }

  /**
   * The session's round (PM-545): the row its own steps hang on, open until the turn ends or its time is up.
   * It holds the steps on system signals, and (PM-1287) the PM's steps on its own authority, which carry no
   * signal. It authorizes nothing: `openFor` never returns it; `CoordinationRequests.actingRequest` does.
   */
  roundFor(sessionId: string): ProjectManagerRequestRecord | null {
    for (const request of this.ctx.repos.projectManagerRequests.openOfSession(sessionId))
      if (request.source === 'signal' && !this.expire(request)) return request;
    return null;
  }

  /** The session's signal round, opened by the first step on a signal. */
  openRound(projectKey: string, sessionId: string): ProjectManagerRequestRecord {
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
      fromHandle: PROJECT_MANAGER_SIGNAL_ROUND_FROM,
      quote: '',
      openedAt: isoNow(this.ctx),
    };
    this.ctx.repos.projectManagerRequests.insert(request);
    return { ...request, closedAt: null };
  }

  /** The session's turn is over (idle) or the session ended: its open requests close. */
  closeForSession(sessionId: string): void {
    const now = isoNow(this.ctx);
    for (const request of this.ctx.repos.projectManagerRequests.openOfSession(sessionId))
      this.ctx.repos.projectManagerRequests.close(request.id, now);
  }

  /**
   * The latest requests that these members made with their steps, the newest last; the ones past their
   * time are closed first. The owners' channel lists the owners' requests, a guest's their own (PM-475).
   */
  views(projectKey: string, fromHandles: string[], recipient?: string): ProjectManagerRequestView[] {
    const { projectManagerRequests } = this.ctx.repos;
    for (const request of projectManagerRequests.openOfProject(projectKey)) this.expire(request);
    return projectManagerRequests
      .latestFrom(projectKey, fromHandles, PROJECT_MANAGER_CHANNEL_REQUESTS, recipient)
      .map((request) => ({
        id: request.id,
        messageId: request.messageId,
        quote: request.quote,
        openedAt: request.openedAt,
        closedAt: request.closedAt,
        steps: projectManagerRequests.steps(request.id).map(stepView),
      }));
  }

  /** Closes the request when its time is up, at the moment it ran out; true when it is closed. */
  private expire(request: ProjectManagerRequestRecord): boolean {
    const until = Date.parse(request.openedAt) + PROJECT_MANAGER_REQUEST_TTL_MS;
    if (this.ctx.now().getTime() < until) return false;
    this.ctx.repos.projectManagerRequests.close(request.id, new Date(until).toISOString());
    return true;
  }
}

/** The PM's requests use separate session rows and never inherit a project manager request or signal round. */
interface OpenCoordinationRequest extends OpenProjectManagerRequest {}

export class CoordinationRequests extends ProjectManagerRequests {
  private readonly coordinationCtx: DomainContext;
  private readonly projects: Pick<ProjectService, 'cachedConfig'>;

  constructor(deps: { ctx: DomainContext; projects: Pick<ProjectService, 'cachedConfig'> }) {
    super(deps);
    this.coordinationCtx = deps.ctx;
    this.projects = deps.projects;
  }

  override open(input: OpenCoordinationRequest): ProjectManagerRequestRecord {
    if (!this.isCoordinationSession(input.sessionId, input.projectKey))
      throw forbidden('project_manager_only', 'coordination requires the selected PM internal conversation');
    if (input.source === 'approval' && !this.validApproval(input))
      throw forbidden('operator_no_request', 'no structural approval continuation is authorized for the PM');
    return super.open(input);
  }

  override openFor(sessionId: string): ProjectManagerRequestRecord | null {
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

  /**
   * The request the PM acts on in this session (PM-1287): the open owner request, as `openFor` has it. With none,
   * under `outside_owner_only` and in the PM's own internal general conversation (never a guest's), the session's
   * own round: the PM acts on its own authority, and its steps hang on the round without a signal. Else null.
   */
  actingRequest(projectKey: string, sessionId: string): ProjectManagerRequestRecord | null {
    const request = this.openFor(sessionId);
    if (request) return request;
    const config = this.projects.cachedConfig(projectKey);
    if (
      !config ||
      projectManagerAuthorityOf(config) !== 'outside_owner_only' ||
      !this.isCoordinationSession(sessionId, projectKey)
    )
      return null;
    return this.openRound(projectKey, sessionId);
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

function stepView(step: ProjectManagerStepRecord): ProjectManagerStep {
  return {
    ...step,
    agreementVersion: step.agreementVersion ?? null,
    approvalMode: step.approvalMode ?? null,
    operationId: step.operationId ?? null,
    systemFeedback: step.systemFeedback ?? null,
    refusal: step.refusal ? { code: step.refusal.code as ErrorCode, message: step.refusal.message } : null,
  };
}

interface ProjectManagerStepInput {
  agreementVersion?: number | null;
  approvalMode?: 'click' | 'waived' | null;
  id?: string;
  requestId: string;
  action: ProjectManagerAction;
  status: ProjectManagerStepStatus;
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

/** What the project manager did for a request, one step per call, the refused ones too. */
export class ProjectManagerSteps {
  private readonly ctx: DomainContext;

  constructor(deps: { ctx: DomainContext }) {
    this.ctx = deps.ctx;
  }

  record(input: ProjectManagerStepInput): ProjectManagerStepRecord {
    const step: ProjectManagerStepRecord = {
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
    this.ctx.repos.projectManagerRequests.insertStep(step);
    return step;
  }

  /** The steps the project manager took on a signal, the oldest first. */
  ofSignal(signalId: string): ProjectManagerStepRecord[] {
    return this.ctx.repos.projectManagerRequests.stepsOfSignal(signalId);
  }
}
