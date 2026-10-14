import { Cause, Effect, Exit, FiberSet, Scope } from 'effect';
import type { FastifyBaseLogger } from 'fastify';
import type { PermissionBroker, PermissionDecision } from '../contracts';
import { runFork } from '../kernel';
import { sessionAllowScope, type HookPayload } from './hook-payload';
import { awaitPermission, type PermissionWaitOutcome } from './permission-wait';

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
  private readonly scope = Scope.makeUnsafe();
  private readonly fibers = Effect.runSync(Scope.provide(FiberSet.make<PermissionWaitOutcome>(), this.scope));
  private readonly waiting = new Set<object>();
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
  async request(
    payload: HookPayload,
    activity: string,
    withdrawn: AbortSignal,
    tracking: { onAllowed?: () => void; trackState?: boolean } = {},
  ): Promise<unknown> {
    if (withdrawn.aborted || this.closed) return null;
    const { opts } = this;
    const toolName = payload.tool_name ?? 'unknown';
    const allowKey = opts.remembersSessionAllows ? sessionAllowKey(payload) : null;
    if (allowKey && this.sessionAllows.has(allowKey)) {
      tracking.onAllowed?.();
      return opts.answer({ behavior: 'allow' }, payload);
    }

    const entry = {};
    this.waiting.add(entry);
    if (tracking.trackState !== false) opts.onWaiting(activity);
    const fiber = runFork(
      awaitPermission({
        broker: opts.broker,
        request: { sessionId: opts.sessionId, toolName, toolInput: payload.tool_input ?? null, raw: payload },
        timeoutMs: opts.timeoutMs,
        withdrawn,
      }),
    );
    FiberSet.addUnsafe(this.fibers, fiber);
    const exit = await new Promise<Exit.Exit<PermissionWaitOutcome>>((resolve) => fiber.addObserver(resolve));
    try {
      if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) return null;
      const outcome: PermissionWaitOutcome = Exit.isFailure(exit)
        ? { kind: 'failed', cause: Cause.squash(exit.cause) }
        : exit.value;
      if (outcome.kind === 'withdrawn') return null; // nobody is waiting for the answer any more
      if (outcome.kind === 'timeout') {
        opts.onDenied?.(payload);
        return opts.deny(DENY_TIMEOUT);
      }
      if (outcome.kind === 'failed') {
        opts.logger.error(
          { err: outcome.cause, sessionId: opts.sessionId, toolName },
          'permission broker failed',
        );
        opts.onDenied?.(payload);
        return opts.deny(DENY_FAILED);
      }
      if (this.closed) return null;
      const { decision } = outcome;
      if (allowKey && decision.behavior === 'allow' && decision.rememberForSession) {
        this.sessionAllows.add(allowKey);
      }
      if (decision.behavior === 'deny') opts.onDenied?.(payload);
      else tracking.onAllowed?.();
      return opts.answer(decision, payload);
    } finally {
      this.waiting.delete(entry);
      if (tracking.trackState !== false) opts.onSettled(this.waiting.size);
    }
  }

  /** The session exited: every waiting request ends without an answer. */
  close(): void {
    this.closed = true;
    runFork(Scope.close(this.scope, Exit.void));
  }
}
