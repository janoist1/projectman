import { OPERATOR_SIGNAL_ROUND_FROM } from '@projectman/shared';
import type {
  ConfigChangeRow,
  ErrorCode,
  OperatorAction,
  OperatorRequestView,
  OperatorStep,
  OperatorStepStatus,
} from '@projectman/shared';
import type { OperatorRequestRecord, OperatorStepRecord } from '../../db';
import { isoNow } from '../../core/base';
import type { DomainContext } from '../../core/base';
import { newId } from '../../kernel';

/** An owner's request to the Operator stays open this long at most; the end of its turn closes it sooner. */
export const OPERATOR_REQUEST_TTL_MS = 30 * 60_000;
/** The part of the owner's text a request quotes. */
export const OPERATOR_QUOTE_LENGTH = 280;
/** How many requests the Operator's channel lists. */
export const OPERATOR_CHANNEL_REQUESTS = 50;

/** The first `OPERATOR_QUOTE_LENGTH` characters of the text, its line breaks as spaces. */
export function operatorQuoteOf(text: string): string {
  return Array.from(text.replace(/\s*[\r\n]+\s*/g, ' ').trim())
    .slice(0, OPERATOR_QUOTE_LENGTH)
    .join('');
}

/** The team tools (MCP names) the Operator may call without an open request: they only read. */
export const OPERATOR_READ_TOOLS: ReadonlySet<string> = new Set([
  'get_task',
  'list_tasks',
  'list_members',
  'list_attachments',
  'read_attachment',
  'read_message_attachment',
  'get_boundary_request',
  'get_screenshot_run',
  'get_project_state',
  'check_release',
  'read_project_doc',
  'list_decision_candidates',
]);

/**
 * The team tools the Operator may call with no owner request open and no step logged (PM-558): the
 * screening of an AI member's question is its standing duty, answered on the question's own record.
 * Never in a guest conversation.
 */
export const OPERATOR_SCREENING_TOOLS: ReadonlySet<string> = new Set(['screen_question']);

/**
 * The team tools the Operator never calls, request or not: decisions of other members, handovers and
 * publishing outside the machine.
 */
export const OPERATOR_NEVER_TOOLS: ReadonlySet<string> = new Set([
  'decide_permission_request',
  'decide_boundary_request',
  'decide_fix_limit',
  'submit_boundary_request',
  'hand_off',
  'merge_task',
  'propose_release',
]);

/**
 * The team tools the Operator may call in a conversation with someone who is not an owner (PM-475):
 * it reads what that person can see and answers them (`send_message`, to them only).
 * `get_project_state` is left out on purpose: guest access needs a viewer filter in a separate task.
 */
export const OPERATOR_GUEST_TOOLS: ReadonlySet<string> = new Set([
  'get_task',
  'list_tasks',
  'list_members',
  'list_attachments',
  'read_attachment',
  'read_message_attachment',
  'send_message',
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
  write_project_docs: 'docs_write',
  mark_decision_candidates: 'decision_offer',
  prioritize_merge: 'task_update',
};

export interface OpenOperatorRequest {
  projectKey: string;
  sessionId: string;
  source: 'message' | 'answer';
  messageId: string | null;
  inboxItemId?: string | null;
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
      for (const previous of repos.operatorRequests.openOfSession(input.sessionId))
        repos.operatorRequests.close(previous.id, now);
      const request = {
        id: newId('opr'),
        projectKey: input.projectKey,
        sessionId: input.sessionId,
        source: input.source,
        messageId: input.messageId,
        inboxItemId: input.inboxItemId ?? null,
        fromHandle: input.from,
        quote: operatorQuoteOf(input.text),
        openedAt: now,
      };
      repos.operatorRequests.insert(request);
      return { ...request, closedAt: null };
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
  views(projectKey: string, fromHandles: string[]): OperatorRequestView[] {
    const { operatorRequests } = this.ctx.repos;
    for (const request of operatorRequests.openOfProject(projectKey)) this.expire(request);
    return operatorRequests.latestFrom(projectKey, fromHandles, OPERATOR_CHANNEL_REQUESTS).map((request) => ({
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

function stepView(step: OperatorStepRecord): OperatorStep {
  return {
    ...step,
    refusal: step.refusal ? { code: step.refusal.code as ErrorCode, message: step.refusal.message } : null,
  };
}

export interface OperatorStepInput {
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
