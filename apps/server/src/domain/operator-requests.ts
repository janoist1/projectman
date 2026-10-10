import type {
  ConfigChangeRow,
  ErrorCode,
  OperatorAction,
  OperatorRequestView,
  OperatorStep,
  OperatorStepStatus,
} from '@projectman/shared';
import type { OperatorRequestRecord, OperatorStepRecord } from '../db';
import { isoNow } from './context';
import type { DomainContext } from './context';
import { newId } from './util';

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
  'get_remote_state',
  'get_boundary_request',
  'get_screenshot_run',
  'list_network_denials',
  'get_project_state',
]);

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
  'publish_task_branch',
]);

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
      if (this.expire(request)) continue;
      found ??= request;
    }
    return found;
  }

  /** The session's turn is over (idle) or the session ended: its open requests close. */
  closeForSession(sessionId: string): void {
    const now = isoNow(this.ctx);
    for (const request of this.ctx.repos.operatorRequests.openOfSession(sessionId))
      this.ctx.repos.operatorRequests.close(request.id, now);
  }

  /** The project's latest requests with their steps, the newest last; the ones past their time are closed first. */
  views(projectKey: string): OperatorRequestView[] {
    const { operatorRequests } = this.ctx.repos;
    for (const request of operatorRequests.openOfProject(projectKey)) this.expire(request);
    return operatorRequests.latest(projectKey, OPERATOR_CHANNEL_REQUESTS).map((request) => ({
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
  requestId: string;
  action: OperatorAction;
  status: OperatorStepStatus;
  taskKey?: string | null;
  member?: string | null;
  changes?: ConfigChangeRow[];
  configVersion?: string | null;
  inboxItemId?: string | null;
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
      id: newId('ops'),
      requestId: input.requestId,
      at: isoNow(this.ctx),
      action: input.action,
      status: input.status,
      taskKey: input.taskKey ?? null,
      member: input.member ?? null,
      changes: input.changes ?? [],
      configVersion: input.configVersion ?? null,
      inboxItemId: input.inboxItemId ?? null,
      refusal: input.refusal ?? null,
    };
    this.ctx.repos.operatorRequests.insertStep(step);
    return step;
  }
}
