import type { FastifyBaseLogger } from 'fastify';
import type { PermissionBroker, PermissionDecision } from '../contracts';
import { sessionAllowScope, type HookPayload } from './hook-payload';

/**
 * Permission requests of one session (the CLI's PermissionRequest hook), waiting for the
 * broker's decision (a human in the inbox). A request ends with the decision, a denial after
 * the permission timeout, or no answer at all when the CLI stopped waiting (the hook request
 * closed) or the session exited. For CLIs that cannot be told to remember an "allow for this
 * session", the gate remembers it and answers repeats itself.
 */

const DENY_TIMEOUT =
  'No human answered this permission request in time, so it was denied. Continue without it, or ask a human for help.';
const DENY_FAILED = 'The permission request could not be processed, so it was denied.';

type PermissionEnd = 'timeout' | 'withdrawn' | 'session_exit';

export interface PermissionGateOptions {
  sessionId: string;
  broker: PermissionBroker;
  /** How long a request may wait for a human before it is denied. */
  timeoutMs: number;
  logger: FastifyBaseLogger;
  /** Remember "allow for this session" here (the CLI cannot be told to remember it). */
  remembersSessionAllows: boolean;
  /** The hook answer for a decision. */
  answer(decision: PermissionDecision, payload: HookPayload): unknown;
  /** The hook answer that denies with `message`. */
  deny(message: string): unknown;
  /** A request was denied (by a decision, the timeout or a failure): the call will not run. */
  onDenied?(payload: HookPayload): void;
  /** A request is waiting for a human now. */
  onWaiting(activity: string): void;
  /** A request ended; `pending` requests are still waiting. */
  onSettled(pending: number): void;
}

/**
 * The key of a runner-side "allow for this session": the same Bash command again, or the same
 * tool for other tools (see sessionAllowScope).
 */
function sessionAllowKey(payload: HookPayload): string | null {
  const scope = sessionAllowScope(payload);
  if (!scope) return null;
  return scope.command === undefined ? scope.toolName : `${scope.toolName}\u0000${scope.command}`;
}

export class PermissionGate {
  private readonly opts: PermissionGateOptions;
  private readonly waiting = new Map<AbortController, { end: PermissionEnd | null }>();
  /** Runner-side "allow for this session" answers (see sessionAllowKey). */
  private readonly sessionAllows = new Set<string>();
  private closed = false;

  constructor(opts: PermissionGateOptions) {
    this.opts = opts;
  }

  /** Requests waiting for a decision. */
  get pending(): number {
    return this.waiting.size;
  }

  /**
   * Waits for the decision on one request and returns the hook answer, or null when nobody
   * waits for an answer any more. `withdrawn` aborts when the CLI stops waiting.
   */
  async request(payload: HookPayload, activity: string, withdrawn: AbortSignal): Promise<unknown> {
    const { opts } = this;
    const toolName = payload.tool_name ?? 'unknown';
    const allowKey = opts.remembersSessionAllows ? sessionAllowKey(payload) : null;
    if (allowKey && this.sessionAllows.has(allowKey)) return opts.answer({ behavior: 'allow' }, payload);

    const controller = new AbortController();
    const entry: { end: PermissionEnd | null } = { end: null };
    this.waiting.set(controller, entry);
    const end = (reason: PermissionEnd) => {
      if (entry.end) return;
      entry.end = reason;
      controller.abort(new Error(`permission request ended: ${reason}`));
    };
    const timeout = setTimeout(() => end('timeout'), opts.timeoutMs);
    const onWithdrawn = () => end('withdrawn');
    if (withdrawn.aborted) onWithdrawn();
    else withdrawn.addEventListener('abort', onWithdrawn, { once: true });
    opts.onWaiting(activity);

    try {
      const decision = await new Promise<PermissionDecision>((resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
        opts.broker
          .decide(
            { sessionId: opts.sessionId, toolName, toolInput: payload.tool_input ?? null, raw: payload },
            controller.signal,
          )
          .then(resolve, reject);
      });
      if (controller.signal.aborted || this.closed) return null;
      if (allowKey && decision.behavior === 'allow' && decision.rememberForSession) {
        this.sessionAllows.add(allowKey);
      }
      if (decision.behavior === 'deny') opts.onDenied?.(payload);
      return opts.answer(decision, payload);
    } catch (err) {
      if (entry.end === 'timeout') {
        opts.onDenied?.(payload);
        return opts.deny(DENY_TIMEOUT);
      }
      if (entry.end) return null; // nobody is waiting for the answer any more
      opts.logger.error({ err, sessionId: opts.sessionId, toolName }, 'permission broker failed');
      opts.onDenied?.(payload);
      return opts.deny(DENY_FAILED);
    } finally {
      clearTimeout(timeout);
      withdrawn.removeEventListener('abort', onWithdrawn);
      this.waiting.delete(controller);
      opts.onSettled(this.waiting.size);
    }
  }

  /** The session exited: every waiting request ends without an answer. */
  close(): void {
    this.closed = true;
    for (const [controller, entry] of this.waiting) {
      if (!entry.end) {
        entry.end = 'session_exit';
        controller.abort(new Error('session exited'));
      }
    }
  }
}
