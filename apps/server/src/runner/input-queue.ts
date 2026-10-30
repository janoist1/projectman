import { Clock, Data, Deferred, Effect, Exit, FiberHandle, Scope } from 'effect';
import type { FastifyBaseLogger } from 'fastify';
import { runFork, runPromise } from '../kernel';
import type { SessionTiming } from './providers/types';
import { ENTER_KEY, messageKeystrokes } from './typing';

/**
 * Messages typed into an agent CLI's prompt. A message waits in the queue until the session
 * is idle and settled; then it is typed (typing.ts) and Enter is pressed. Until the CLI
 * reports the prompt (UserPromptSubmit) nothing else is typed: Enter is pressed again if the
 * session stays idle (an autocomplete may have eaten it), and after a timeout the queue moves
 * on anyway. A caller of `enqueueSubmitted` hears whether the CLI took the message (PM-571). After the
 * timeout the CLI either showed it was working (a turn hook, or no longer idle): it queued the text or took
 * it mid-turn, so the message counts as taken, unconfirmed (PM-1205). Or it stayed silent and idle: the
 * caller keeps waiting for `lateSubmitMs` more and is told the message was not taken only after that.
 *
 * A message may carry a `deliveryId` (the hub's key for it): while its text is awaited the same id joins
 * that wait, and once taken it is never typed again, so a retried call (a lost reply, a hub restart)
 * cannot type the text twice. A message that was not taken may be typed again.
 *
 * The queue is an Effect program (`makeInputQueue`) that lives as long as its `Scope`; every
 * timer is a fiber in that scope, so closing it is the whole cleanup. `InputQueue` is the plain
 * facade the session uses (docs/EFFECT.md).
 */

/** What the queue needs from its session. */
export interface InputQueueHost {
  readonly sessionId: string;
  readonly timing: Pick<
    SessionTiming,
    'stepDelayMs' | 'enterDelayMs' | 'enterRetryMs' | 'maxEnterRetries' | 'submitTimeoutMs' | 'lateSubmitMs'
  >;
  readonly logger: FastifyBaseLogger;
  /** The CLI is ready for input and idle. */
  isIdle(): boolean;
  /**
   * The last check before a message is typed: 0 to type it now, a number of milliseconds to
   * check again after, or null to hold the queue until the next pump (e.g. a dialog covers the
   * prompt; the session pumps again once it is gone).
   */
  checkBeforeTyping(): number | null;
  write(data: string): void;
  /**
   * Typing ended, or a typed message stopped being awaited as submitted (its time ran out): the
   * session may re-check whether it has stopped (PM-218).
   */
  onChange?(): void;
  /** Bounded session diagnostics when a typed prompt was not reported as submitted. */
  describeStall?(): Record<string, unknown>;
}

/**
 * A typed message was never reported as submitted: it may still sit in the CLI's prompt box, so the
 * message did not reach the agent and must not count as delivered (PM-571).
 */
export class NotSubmittedError extends Data.TaggedError('NotSubmittedError')<{
  readonly sessionId: string;
  readonly message: string;
}> {
  constructor(sessionId: string) {
    super({ sessionId, message: `Session ${sessionId} did not take the typed message` });
  }
}

/** The message could not be typed: the session is closed, or it exited before the message was typed. */
export class SessionGoneError extends Data.TaggedError('SessionGoneError')<{
  readonly sessionId: string;
  readonly reason: 'not_running' | 'exited';
  readonly message: string;
}> {
  constructor(sessionId: string, reason: 'not_running' | 'exited') {
    super({
      sessionId,
      reason,
      message:
        reason === 'not_running'
          ? `Session ${sessionId} is not running`
          : `Session ${sessionId} exited before the message was typed`,
    });
  }
}

export interface InputQueueState {
  readonly typing: boolean;
  readonly queued: number;
  readonly awaitingSubmit: boolean;
  readonly closed: boolean;
}

export interface InputQueueEffects {
  /** A synchronous snapshot. */
  readonly state: () => InputQueueState;
  readonly enqueue: (text: string) => Effect.Effect<void, SessionGoneError>;
  readonly enqueueSubmitted: (
    text: string,
    deliveryId?: string,
  ) => Effect.Effect<void, NotSubmittedError | SessionGoneError>;
  readonly pump: Effect.Effect<void>;
  readonly schedule: (delayMs: number) => Effect.Effect<void>;
  readonly submitted: Effect.Effect<void>;
  readonly noteTurnActivity: Effect.Effect<void>;
  readonly awaitCommandLinePrompt: (timeoutMs: number) => Effect.Effect<void>;
  readonly hold: Effect.Effect<void>;
  readonly unhold: (first?: string) => Effect.Effect<void>;
}

type Outcome = Deferred.Deferred<void, NotSubmittedError | SessionGoneError>;

const HELD_WARN_MS = 10 * 60_000;
/** Delivery ids remembered per process; when full, the oldest settled one is forgotten. */
const MAX_DELIVERIES = 100;

/** A caller waiting to hear about its message; `deliveryId` is set only for a tracked `enqueueSubmitted`. */
interface Waiter {
  readonly outcome: Outcome;
  readonly deliveryId?: string;
}

interface QueuedMessage extends Waiter {
  readonly text: string;
  /** The message counts as done once typed (`enqueue`), or only once the CLI took it (`enqueueSubmitted`). */
  readonly untilSubmitted: boolean;
}

/** `pending`: queued, typed or awaited; `taken`: the CLI took it (confirmed or not); `not_taken`: it may be typed again. */
type DeliveryState = 'pending' | 'taken' | 'not_taken';

interface AwaitedSubmit {
  readonly at: number;
  retries: number;
  /** A slash command, or a prompt passed on the command line: Enter is never pressed again. */
  readonly command: boolean;
  readonly timeoutMs: number;
  /** Settles the caller of `enqueueSubmitted`: done when the CLI took the prompt, failed when it did not. */
  readonly settle?: Waiter;
}

/** Lives as long as its Scope; closing the Scope is the process exit. */
export const makeInputQueue = (host: InputQueueHost): Effect.Effect<InputQueueEffects, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const pumpTimer = yield* FiberHandle.make();
    const submitWatch = yield* FiberHandle.make();
    const heldWatch = yield* FiberHandle.make();
    const { timing } = host;
    const queue: QueuedMessage[] = [];
    const s = {
      typing: false,
      /** Nothing is typed before this time (the TUI settles after SessionStart, Stop, ...). */
      notBefore: 0,
      awaiting: null as AwaitedSubmit | null,
      /** The message being typed. */
      current: null as QueuedMessage | null,
      closed: false,
      /** Nothing new is typed while held (a pause, PM-218); what is being typed is finished. */
      held: false,
      /** The CLI's main agent ran a turn hook since the last message started to be typed (PM-1205). */
      turnActivity: false,
    };
    /** Callers whose typed message was not reported in time while the CLI sat silent and idle: still awaited. */
    const late: Waiter[] = [];
    const deliveries = new Map<string, { state: DeliveryState; readonly outcome: Outcome }>();
    const gone = (reason: 'not_running' | 'exited') => new SessionGoneError(host.sessionId, reason);

    const remember = (deliveryId: string, outcome: Outcome) => {
      deliveries.delete(deliveryId);
      if (deliveries.size >= MAX_DELIVERIES) {
        for (const [id, known] of deliveries) {
          if (known.state === 'pending') continue;
          deliveries.delete(id);
          break;
        }
      }
      deliveries.set(deliveryId, { state: 'pending', outcome });
    };
    const record = (waiter: Waiter, state: DeliveryState) => {
      const known = waiter.deliveryId ? deliveries.get(waiter.deliveryId) : undefined;
      if (known?.outcome === waiter.outcome) known.state = state;
    };
    /** The CLI took the message (or it needs no more waiting for). */
    const taken = (waiter: Waiter) => {
      record(waiter, 'taken');
      Deferred.doneUnsafe(waiter.outcome, Effect.void);
    };
    const notTaken = (waiter: Waiter, error: NotSubmittedError | SessionGoneError) => {
      record(waiter, 'not_taken');
      Deferred.doneUnsafe(waiter.outcome, Effect.fail(error));
    };

    // Registered last, so it runs first on close: the state is closed before the fibers stop.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        s.closed = true;
        const pending = s.awaiting;
        s.awaiting = null;
        const unsettled = [s.current, pending?.settle, ...late.splice(0), ...queue.splice(0)];
        s.current = null;
        for (const waiter of unsettled) if (waiter) notTaken(waiter, gone('exited'));
      }),
    );

    const pump: Effect.Effect<void> = Effect.gen(function* () {
      if (s.closed || s.held || s.typing || queue.length === 0) return;
      if (s.awaiting || !host.isIdle()) return;
      const now = yield* Clock.currentTimeMillis;
      if (now < s.notBefore) return yield* schedule(s.notBefore - now);
      const wait = host.checkBeforeTyping();
      if (wait === null) return;
      if (wait > 0) return yield* schedule(wait);
      s.typing = true;
      s.turnActivity = false;
      yield* Effect.forkIn(type(queue.shift()!), scope, { startImmediately: true });
    });

    /** Types nothing for `delayMs` (at least), then pumps. */
    const schedule = (delayMs: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (s.closed) return;
        s.notBefore = Math.max(s.notBefore, (yield* Clock.currentTimeMillis) + delayMs);
        yield* FiberHandle.run(pumpTimer, Effect.andThen(Effect.sleep(delayMs), pump));
      });

    /**
     * The CLI sat silent and idle past the submit timeout: the caller keeps waiting, for a submission or a turn
     * hook, until `lateSubmitMs` passed. Does not count as pending input (a pause or stop is not held back).
     */
    const awaitLate = (waiter: Waiter): Effect.Effect<void> =>
      Effect.gen(function* () {
        late.push(waiter);
        yield* Effect.forkIn(
          Effect.andThen(
            Effect.sleep(timing.lateSubmitMs),
            Effect.sync(() => {
              const at = late.indexOf(waiter);
              if (at < 0 || s.closed) return;
              late.splice(at, 1);
              host.logger.warn(
                {
                  sessionId: host.sessionId,
                  lateMs: timing.lateSubmitMs,
                  ...(waiter.deliveryId ? { deliveryId: waiter.deliveryId } : {}),
                },
                'typed message was not taken by the CLI',
              );
              notTaken(waiter, new NotSubmittedError(host.sessionId));
            }),
          ),
          scope,
        );
      });

    /** The CLI did not report the prompt yet: press Enter again, or stop waiting for it. */
    const watchSubmit = (pending: AwaitedSubmit): Effect.Effect<void> =>
      Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep(timing.enterRetryMs);
          if (s.awaiting !== pending || s.closed) return;
          const waitMs = (yield* Clock.currentTimeMillis) - pending.at;
          if (waitMs >= pending.timeoutMs) {
            const waiter = pending.settle;
            // The CLI was busy (a turn hook came, or it left idle): it queued the text or took it mid-turn.
            const outcome = waiter
              ? s.turnActivity || !host.isIdle()
                ? 'taken_unconfirmed'
                : 'waiting_late'
              : null;
            host.logger.warn(
              {
                ...host.describeStall?.(),
                sessionId: host.sessionId,
                enterRetries: pending.retries,
                waitMs,
                command: pending.command,
                idle: host.isIdle(),
                ...(waiter?.deliveryId ? { deliveryId: waiter.deliveryId } : {}),
                ...(outcome ? { outcome } : {}),
              },
              'typed message was not reported as submitted',
            );
            s.awaiting = null;
            if (waiter) {
              if (outcome === 'taken_unconfirmed') taken(waiter);
              else yield* awaitLate(waiter);
            }
            yield* pump;
            host.onChange?.();
            return;
          }
          if (!pending.command && pending.retries < timing.maxEnterRetries && host.isIdle()) {
            pending.retries += 1;
            host.write(ENTER_KEY);
          }
        }
      });

    const awaitSubmit = (command: boolean, timeoutMs: number, settle?: Waiter): Effect.Effect<void> =>
      Effect.gen(function* () {
        const pending: AwaitedSubmit = {
          at: yield* Clock.currentTimeMillis,
          retries: 0,
          command,
          timeoutMs,
          settle,
        };
        s.awaiting = pending;
        yield* FiberHandle.run(submitWatch, watchSubmit(pending));
      });

    const type = (message: QueuedMessage): Effect.Effect<void> =>
      Effect.gen(function* () {
        s.current = message;
        const steps = messageKeystrokes(message.text);
        if (steps.length === 0) {
          s.current = null;
          return taken(message);
        }
        for (const step of steps) {
          if (s.closed) return;
          host.write(step);
          yield* Effect.sleep(timing.stepDelayMs);
        }
        yield* Effect.sleep(timing.enterDelayMs);
        if (s.closed) return;
        host.write(ENTER_KEY);
        // A slash command reports no UserPromptSubmit and may open a dialog: never press Enter blindly.
        const command = message.text.trim().startsWith('/');
        s.current = null;
        if (message.untilSubmitted && !command) {
          // Settled by `submitted` (taken), the give-up (not taken) or the close (the process is gone).
          yield* awaitSubmit(false, timing.submitTimeoutMs, message);
        } else {
          yield* awaitSubmit(command, timing.submitTimeoutMs);
          taken(message);
        }
      }).pipe(
        // A failing `host.write` is a defect: the caller hears the original error.
        Effect.catchDefect((defect) => {
          record(message, 'not_taken');
          return Deferred.die(message.outcome, defect);
        }),
        Effect.ensuring(
          Effect.sync(() => {
            // `current` stays: a close interrupts this fiber first, and the close finalizer fails it.
            s.typing = false;
            host.onChange?.();
          }),
        ),
      );

    const add = (
      text: string,
      untilSubmitted: boolean,
      deliveryId?: string,
    ): Effect.Effect<void, NotSubmittedError | SessionGoneError> =>
      Effect.gen(function* () {
        if (s.closed) return yield* Effect.fail(gone('not_running'));
        const known = deliveryId ? deliveries.get(deliveryId) : undefined;
        if (known?.state === 'taken') {
          host.logger.info({ sessionId: host.sessionId, deliveryId }, 'repeated delivery skipped');
          return;
        }
        // The same message is already on its way: this call waits for that one instead of typing it again.
        if (known?.state === 'pending') return yield* Deferred.await(known.outcome);
        const outcome = yield* Deferred.make<void, NotSubmittedError | SessionGoneError>();
        if (deliveryId) remember(deliveryId, outcome);
        queue.push({ text, untilSubmitted, outcome, ...(deliveryId ? { deliveryId } : {}) });
        yield* pump;
        return yield* Deferred.await(outcome);
      });

    return {
      state: () => ({
        typing: s.typing,
        queued: queue.length,
        awaitingSubmit: s.awaiting !== null,
        closed: s.closed,
      }),
      enqueue: (text) => add(text, false) as Effect.Effect<void, SessionGoneError>,
      enqueueSubmitted: (text, deliveryId) => add(text, true, deliveryId),
      pump,
      schedule,
      submitted: Effect.gen(function* () {
        const pending = s.awaiting;
        s.awaiting = null;
        yield* FiberHandle.clear(submitWatch);
        if (pending?.settle) taken(pending.settle);
        // A busy CLI submits the text it queued in order: whatever it takes next settles the late ones too.
        for (const waiter of late.splice(0)) taken(waiter);
      }),
      noteTurnActivity: Effect.sync(() => {
        s.turnActivity = true;
        for (const waiter of late.splice(0)) taken(waiter);
      }),
      awaitCommandLinePrompt: (timeoutMs) => awaitSubmit(true, timeoutMs),
      hold: Effect.gen(function* () {
        if (s.closed || s.held) return;
        s.held = true;
        const heldAt = yield* Clock.currentTimeMillis;
        yield* FiberHandle.run(
          heldWatch,
          Effect.gen(function* () {
            yield* Effect.sleep(HELD_WARN_MS);
            if (s.closed || !s.held || queue.length === 0) return;
            host.logger.warn(
              {
                sessionId: host.sessionId,
                queued: queue.length,
                heldMs: (yield* Clock.currentTimeMillis) - heldAt,
              },
              'input held with waiting messages',
            );
          }),
        );
      }),
      unhold: (first) =>
        Effect.gen(function* () {
          s.held = false;
          yield* FiberHandle.clear(heldWatch);
          if (first?.trim() && !s.closed) {
            const outcome = yield* Deferred.make<void, NotSubmittedError | SessionGoneError>();
            queue.unshift({ text: first, untilSubmitted: false, outcome });
          }
          yield* pump;
        }),
    };
  });

// `Effect.runSync` brings its own synchronous scheduler; the inline one (`runFork`, `runPromise`) is in kernel.
const runSync = Effect.runSync;

/** Facade for session.ts: plain methods and promises, the Effect program runs in the queue's own scope. */
export class InputQueue {
  private readonly scope = Scope.makeUnsafe();
  private readonly core: InputQueueEffects;

  constructor(host: InputQueueHost) {
    this.core = runSync(Scope.provide(makeInputQueue(host), this.scope));
  }

  /** A message is being typed (or its Enter is still to come). */
  get isTyping(): boolean {
    return this.core.state().typing;
  }

  /** Types nothing new until `unhold`: a message already being typed, its Enter and Enter repeats go on. */
  hold(): void {
    runSync(this.core.hold);
  }

  /** Ends the hold; a non-empty `first` is queued ahead of the waiting messages. Then it pumps. */
  unhold(first?: string): void {
    runSync(this.core.unhold(first));
  }

  /** Messages waiting to be typed. */
  get length(): number {
    return this.core.state().queued;
  }

  /** A typed message (or a command-line prompt) was not reported as submitted yet. */
  get isAwaitingSubmit(): boolean {
    return this.core.state().awaitingSubmit;
  }

  /** Something is still on its way to the agent: queued, being typed, or not yet submitted. */
  get hasPending(): boolean {
    const { closed, typing, queued, awaitingSubmit } = this.core.state();
    return !closed && (typing || queued > 0 || awaitingSubmit);
  }

  /** Queues a message; it is typed once the session is idle. Resolves once typed. */
  enqueue(text: string): Promise<void> {
    return runPromise(this.core.enqueue(text));
  }

  /**
   * Queues a message like `enqueue`, but resolves only once the CLI took it (UserPromptSubmit); a
   * slash command reports none, so it resolves once typed. Rejects with `NotSubmittedError` when the
   * CLI did not take the typed message in time (PM-571): it did not reach the agent. With a `deliveryId`,
   * a repeated call joins the message still awaited, or resolves at once when it was taken (PM-1205).
   */
  enqueueSubmitted(text: string, deliveryId?: string): Promise<void> {
    return runPromise(this.core.enqueueSubmitted(text, deliveryId));
  }

  /**
   * The CLI's main agent ran a turn (a tool, a permission request, a stop): a typed message it did not
   * report is then taken unconfirmed, and one still awaited late is taken at once.
   */
  noteTurnActivity(): void {
    runSync(this.core.noteTurnActivity);
  }

  /** Types the next message if the session can take it now. */
  pump(): void {
    runSync(this.core.pump);
  }

  /** Types nothing for `delayMs` (at least), then pumps. */
  schedule(delayMs: number): void {
    runSync(this.core.schedule(delayMs));
  }

  /**
   * The CLI took the prompt (UserPromptSubmit), or started a new conversation (/clear): stop
   * waiting for the typed message to be submitted.
   */
  submitted(): void {
    runSync(this.core.submitted);
  }

  /**
   * The CLI submits a prompt given on its command line by itself: nothing is typed until it
   * reports it, or `timeoutMs` passed.
   */
  awaitCommandLinePrompt(timeoutMs: number): void {
    runSync(this.core.awaitCommandLinePrompt(timeoutMs));
  }

  /** The process is gone: stops typing and rejects every queued message. */
  close(): void {
    runFork(Scope.close(this.scope, Exit.void));
  }
}
