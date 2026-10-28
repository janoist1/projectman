import {
  formatInjectedTeamMessage,
  formatTeamMessageBatch,
  messageTextWithAttachments,
  memberDuties,
  memberOf,
  REVIEW_DUTIES,
  stageOf,
} from '@projectman/shared';
import type { Session, Task, TeamMessage, WorkItemRef } from '@projectman/shared';
import { Cause, Data, Effect, Exit, FiberMap, Scope } from 'effect';
import { encodeWorkItem } from '../../db';
import type { DomainContext } from '../../core/base';
import { runPromise } from '../../kernel';
import type { MessageService } from '../../core/messages';
import { senderResultLabelFor, staleReasonFor } from '../../core/messages';
import type { ProjectService } from '../../core/projects';
import { MAX_FIRST_INPUT_CHARS, MESSAGE_SEPARATOR } from '../sessions';
import type { EnsureSessionResult, SessionOrchestrator } from '../sessions';

/**
 * Types waiting AI messages into running sessions as one batch at idle.
 * A stored message is typed once per recipient and then counts as delivered to it; when typing
 * fails it stays waiting for the recipient's next session. A session that starts for waiting
 * messages takes them in its first input instead (`startAndDeliver`); they count as delivered once
 * that input was typed.
 *
 * The delivery is an Effect program (`makeMessageDelivery`) that lives as long as its `Scope`;
 * every retry timer and background delivery is a fiber in that scope. `MessageDelivery` is the
 * plain facade the rest of the server uses (docs/EFFECT.md).
 */

export interface DeliveryDeps {
  readonly ctx: DomainContext;
  readonly sessions: Pick<
    SessionOrchestrator,
    | 'find'
    | 'isRunning'
    | 'isPaused'
    | 'permissionRestartDue'
    | 'hasPendingInput'
    | 'reviewRoundDue'
    | 'typeInto'
    | 'sourceHead'
    | 'refreshWorkspaceBase'
  >;
  readonly projects: Pick<ProjectService, 'cachedConfig' | 'config'>;
  readonly messages: Pick<MessageService, 'waiting' | 'get' | 'wakes' | 'markRecipientDelivered'>;
  /** Structural on purpose: the delivery must not import the project-docs service (layer rule). */
}

/** The session did not take the typed text (PM-571), or it ended. */
class TypeIntoFailed extends Data.TaggedError('TypeIntoFailed')<{ readonly cause: unknown }> {}

/** The session for the waiting messages could not be started. */
class StartFailed extends Data.TaggedError('StartFailed')<{ readonly cause: unknown }> {}

export interface DeliveryEffects {
  /** Types a stored message into its recipient's session, once; forks and returns at once. */
  readonly deliver: (session: Session, message: TeamMessage, text?: string) => Effect.Effect<void>;
  readonly deliverWithFirstInput: (
    handle: string,
    messages: TeamMessage[],
    firstInput: Promise<boolean>,
    session?: Session,
  ) => Effect.Effect<void>;
  readonly startAndDeliver: (
    projectKey: string,
    handle: string,
    workItem: WorkItemRef,
    start: (messages: string[]) => Promise<EnsureSessionResult>,
  ) => Effect.Effect<void, StartFailed>;
  readonly deliverWaiting: (session: Session) => Effect.Effect<void>;
  readonly flushWaiting: (session: Session) => Effect.Effect<boolean, TypeIntoFailed>;
  readonly notice: (
    session: Session,
    from: string,
    text: string,
    taskKey: string | null,
  ) => Effect.Effect<boolean>;
  readonly noticeOrHold: (
    session: Session,
    from: string,
    text: string,
    taskKey: string | null,
  ) => Effect.Effect<void>;
  readonly holdUntilInput: (session: Session, message: TeamMessage) => Effect.Effect<void>;
  readonly holdAsWritten: (session: Session, message: TeamMessage) => Effect.Effect<void>;
  readonly holdForPause: (session: Session, message: TeamMessage) => Effect.Effect<void>;
  readonly deliverPauseHeld: (session: Session) => Effect.Effect<void>;
  readonly dropPauseHeld: (sessionId: string) => Effect.Effect<void>;
  readonly dropHeld: (sessionId: string) => Effect.Effect<void>;
  readonly useMessageHolds: (check: (session: Session) => Promise<boolean>) => Effect.Effect<void>;
}

/** A notice kept for an idle session; `messageId` is set when a stored message is behind it. */
interface HeldNotice {
  text: string;
  messageId: string | null;
}

/** Pauses before a message the session did not take is typed again (PM-571); the last one repeats no more. */
const RETRY_DELAYS_MS = [10_000, 30_000, 60_000, 120_000, 300_000];

function recipientKey(projectKey: string, handle: string, workItem: WorkItemRef): string {
  const wi = encodeWorkItem(workItem);
  return `${projectKey}:${handle}:${wi.type}:${wi.ref}`;
}

/** Lives as long as its Scope; closing the Scope stops every retry and background delivery. */
export const makeMessageDelivery = (deps: DeliveryDeps): Effect.Effect<DeliveryEffects, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { ctx, sessions, projects, messages } = deps;
    const scope = yield* Effect.scope;
    /** The pending retry of each session (PM-571): a fiber asleep until the next attempt. */
    const retryTimers = yield* FiberMap.make<string>();
    /** Retries started for a session since typing last worked (`retryLater`). */
    const retryAttempts = new Map<string, number>();
    let messageHolds: ((session: Session) => Promise<boolean>) | undefined;
    const flushing = new Set<string>();
    /** Messages being typed, by message and recipient. */
    const claims = new Set<string>();
    /** Recipients whose session is starting for their waiting messages: nothing is typed before it runs. */
    const starting = new Set<string>();
    /**
     * Messages a person wrote into a session that waited for its restart (PM-170), by message and
     * recipient: typed as they were written once it runs, like the ones that reach it at once.
     */
    const asWritten = new Set<string>();
    /**
     * Messages kept back because their recipient's running session is paused (PM-219), by message and
     * recipient, with the session they are for. Memory only: a restart leaves the session without a
     * process, and the messages wait like any that wait for a start (the resume starts it with them).
     */
    const pauseHeld = new Map<string, { sessionId: string; messageId: string; member: string }>();
    /**
     * Notices kept for idle sessions (PM-249), by session id: typed before the session's next input. A
     * stored message kept the same way (PM-421, `holdUntilInput`) counts as delivered once typed.
     */
    const held = new Map<string, HeldNotice[]>();

    const typeInto = (session: Session, text: string) =>
      Effect.tryPromise({
        try: () => sessions.typeInto(session, text),
        catch: (cause) => new TypeIntoFailed({ cause }),
      });

    /**
     * The developer's workspace gets a fresh default branch before a reviewer's action message is typed
     * into their running session (PM-740), whatever the message says ("merge main" included). Only a
     * message that is still valid counts. A failed fetch fails the delivery: the message stays waiting
     * and is tried again, like one the session did not take.
     */
    const refreshBaseFor = (session: Session, batchMessages: readonly TeamMessage[]) =>
      Effect.gen(function* () {
        const config = projects.cachedConfig(session.projectKey);
        if (!config || session.workItem.type !== 'task') return;
        const task: Task | null = ctx.repos.tasks.get(session.workItem.taskKey);
        if (!task || task.assignee !== session.member) return;
        const fromReviewer = (message: TeamMessage) => {
          const sender = memberOf(config, message.from);
          return (
            !!sender &&
            (message.kind ?? 'action') === 'action' &&
            message.taskKey === task.key &&
            memberDuties(config, sender).some((duty) => REVIEW_DUTIES.includes(duty)) &&
            staleReasonFor(ctx, config, message, session.member) === null
          );
        };
        if (!batchMessages.some(fromReviewer)) return;
        yield* Effect.tryPromise({
          try: () => sessions.refreshWorkspaceBase(config, task, session.member),
          catch: (cause) => new TypeIntoFailed({ cause }),
        });
      });

    const keep = (session: Session, notice: HeldNotice) => {
      const kept = held.get(session.id) ?? [];
      kept.push(notice);
      held.set(session.id, kept);
    };

    /** `text` with the notices kept for the session in front of it, and the stored messages among them; they are taken out. */
    const withHeld = (session: Session, text: string) => {
      const kept = held.get(session.id);
      if (!kept) return { text, messageIds: [] as string[], kept: [] as HeldNotice[] };
      held.delete(session.id);
      return {
        text: [...kept.map((notice) => notice.text), text].join(MESSAGE_SEPARATOR),
        messageIds: kept.flatMap((notice) => (notice.messageId ? [notice.messageId] : [])),
        kept,
      };
    };

    /** The notices `withHeld` took out go back, ahead of the newer ones: their text was not taken (PM-571). */
    const restoreHeld = (session: Session, kept: HeldNotice[]) => {
      if (kept.length) held.set(session.id, [...kept, ...(held.get(session.id) ?? [])]);
    };

    /** Typing worked: the retry count starts over. */
    const typedOk = (session: Session) => {
      if (!retryAttempts.has(session.id)) return;
      if (FiberMap.hasUnsafe(retryTimers, session.id)) retryAttempts.set(session.id, 0);
      else retryAttempts.delete(session.id);
    };

    /**
     * A message typed into a session that did not take it (the CLI never reported the prompt, PM-571)
     * is not delivered: it stays waiting, and is typed again after a growing pause while the session
     * runs, so a busy machine does not leave it lost. Past `RETRY_DELAYS_MS` it is left to the
     * session's next idle moment, with an error in the log.
     */
    const retryLater = (session: Session): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (FiberMap.hasUnsafe(retryTimers, session.id)) return;
        const attempts = retryAttempts.get(session.id) ?? 0;
        if (attempts >= RETRY_DELAYS_MS.length) {
          retryAttempts.delete(session.id);
          ctx.logger.error(
            { sessionId: session.id, member: session.member },
            'team messages could not be typed into the session; they stay waiting for its next idle moment',
          );
          return;
        }
        retryAttempts.set(session.id, attempts + 1);
        const retry = Effect.suspend(() => {
          const current = sessions.find(session.id);
          if (current && sessions.isRunning(current.id)) return deliverWaiting(current);
          retryAttempts.delete(session.id);
          return Effect.void;
        }).pipe(
          catchFailure((cause) =>
            Effect.sync(() => {
              ctx.logger.warn(
                { err: Cause.squash(cause), sessionId: session.id },
                'retrying the team messages failed',
              );
              retryAttempts.delete(session.id);
            }),
          ),
        );
        yield* FiberMap.run(
          retryTimers,
          session.id,
          Effect.andThen(Effect.sleep(RETRY_DELAYS_MS[attempts]!), retry),
          { onlyIfMissing: true },
        );
      });

    const deliver: DeliveryEffects['deliver'] = (session, message, text) =>
      Effect.gen(function* () {
        const claim = `${message.id}:${session.member}`;
        if (claims.has(claim)) return;
        claims.add(claim);
        const plain = asWritten.has(claim);
        const typing = Effect.gen(function* () {
          yield* refreshBaseFor(session, [message]);
          const {
            text: typed,
            messageIds,
            kept,
          } = withHeld(
            session,
            text ??
              (plain && !message.via
                ? messageTextWithAttachments(message)
                : formatInjectedTeamMessage(
                    message.from,
                    messageTextWithAttachments(message),
                    message.taskKey,
                    message.via,
                    message.actor,
                    message.location,
                  )),
          );
          yield* typeInto(session, typed).pipe(
            Effect.tapError(() => Effect.sync(() => restoreHeld(session, kept))),
          );
          typedOk(session);
          for (const id of messageIds) messages.markRecipientDelivered(id, session.member);
          asWritten.delete(claim);
          messages.markRecipientDelivered(message.id, session.member);
        }).pipe(
          catchFailure((cause) =>
            Effect.andThen(
              Effect.sync(() =>
                ctx.logger.warn(
                  { err: failure(cause), messageId: message.id },
                  'team message delivery failed',
                ),
              ),
              retryLater(session),
            ),
          ),
          Effect.ensuring(Effect.sync(() => claims.delete(claim))),
        );
        yield* Effect.forkIn(typing, scope, { startImmediately: true });
      });

    /**
     * Messages a session took in its first input count as delivered to `handle` once that input was
     * typed (`EnsureSessionResult.firstInput`), not when the process started: one that ends first
     * (a lost login, a start-up dialog, a crash) never got them, so they stay waiting for the next
     * session (PM-189). Until then nothing types them again.
     */
    const deliverWithFirstInput: DeliveryEffects['deliverWithFirstInput'] = (
      handle,
      batchMessages,
      firstInput,
      session,
    ) =>
      Effect.gen(function* () {
        const batchClaims = batchMessages.map((message) => `${message.id}:${handle}`);
        for (const claim of batchClaims) claims.add(claim);
        const typedFirst = Effect.gen(function* () {
          if (yield* Effect.promise(() => firstInput)) {
            for (const message of batchMessages) messages.markRecipientDelivered(message.id, handle);
            return;
          }
          // The input may not have been taken by a session that lives on (PM-571): type the messages again.
          if (session && batchMessages.length > 0) {
            ctx.logger.warn({ sessionId: session.id, handle }, 'team messages in the first input not taken');
            yield* retryLater(session);
          }
        }).pipe(
          catchFailure((cause) =>
            Effect.sync(() => ctx.logger.warn({ err: failure(cause) }, 'team message delivery failed')),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              for (const claim of batchClaims) claims.delete(claim);
            }),
          ),
        );
        yield* Effect.forkIn(typedFirst, scope, { startImmediately: true });
      });

    const batchOf = (
      projectKey: string,
      handle: string,
      workItem: WorkItemRef,
      waiting: TeamMessage[],
    ): Effect.Effect<{ text: string; messages: TeamMessage[] }> =>
      Effect.gen(function* () {
        const config = yield* Effect.promise(() => projects.config(projectKey));
        const taskKey = workItem.type === 'task' ? workItem.taskKey : null;
        const source = taskKey ? ctx.repos.tasks.get(taskKey) : null;
        const head = source ? yield* Effect.promise(() => sessions.sourceHead(config, source)) : null;
        const task = taskKey ? ctx.repos.tasks.get(taskKey) : null;
        const stage = task ? stageOf(config, task.stageId) : null;
        const card = task
          ? {
              stageId: task.stageId,
              stageName: stage?.name ?? task.stageId,
              commit: head?.commit ?? null,
              labels: task.labels,
            }
          : null;
        const batch: TeamMessage[] = [];
        let text = '';
        for (const message of waiting) {
          const next = [...batch, message];
          const candidate = formatTeamMessageBatch(
            taskKey,
            card,
            next.map((m) => ({
              from: m.from,
              via: m.via,
              actor: m.actor,
              taskKey: m.taskKey,
              body: m.body,
              attachments: m.attachments,
              email: m.email,
              location: m.location,
              kind: m.kind ?? 'action',
              sentAt: m.createdAt,
              version: m.version,
              stale: staleReasonFor(ctx, config, m, handle) ?? undefined,
              staleDetail: senderResultLabelFor(ctx, config, m, handle) ?? stage?.name,
            })),
          );
          if (candidate.length + MESSAGE_SEPARATOR.length > MAX_FIRST_INPUT_CHARS) break;
          batch.push(message);
          text = candidate;
        }
        return { text, messages: batch };
      });

    /** Claims one snapshot of waiting messages and types it as a single input at idle. */
    const flushWaiting: DeliveryEffects['flushWaiting'] = (session) =>
      Effect.gen(function* () {
        if (messageHolds && (yield* Effect.promise(() => messageHolds!(session)))) return false;
        const current = sessions.find(session.id);
        if (
          !current ||
          current.state !== 'idle' ||
          !sessions.isRunning(current.id) ||
          sessions.isPaused(current) ||
          sessions.hasPendingInput(current.id) ||
          sessions.permissionRestartDue(current) ||
          starting.has(recipientKey(current.projectKey, current.member, current.workItem)) ||
          flushing.has(current.id)
        )
          return false;
        // A stored message kept for the session's next input goes in with it, not on its own (PM-421).
        const keptIds = new Set(
          (held.get(current.id) ?? []).flatMap((notice) => (notice.messageId ? [notice.messageId] : [])),
        );
        const waiting = messages
          .waiting(current.projectKey, current.member, current.workItem)
          .filter((message) => !claims.has(`${message.id}:${current.member}`) && !keptIds.has(message.id));
        const config = projects.cachedConfig(current.projectKey);
        if (
          sessions.reviewRoundDue(current) &&
          config &&
          waiting.some((m) => messages.wakes(config, m, current.member))
        )
          return false;
        if (!waiting.length) return false;
        flushing.add(current.id);
        for (const message of waiting) claims.add(`${message.id}:${current.member}`);
        return yield* Effect.gen(function* () {
          const batch = yield* batchOf(current.projectKey, current.member, current.workItem, waiting);
          // The workspace's default branch is refreshed before the text goes in; the session is looked up
          // again after it, as the fetch takes a while.
          yield* refreshBaseFor(current, batch.messages).pipe(Effect.tapError(() => retryLater(current)));
          const fresh = sessions.find(current.id);
          if (
            !fresh ||
            fresh.state !== 'idle' ||
            sessions.hasPendingInput(current.id) ||
            sessions.isPaused(fresh) ||
            sessions.permissionRestartDue(fresh) ||
            (sessions.reviewRoundDue(fresh) &&
              config &&
              batch.messages.some((m) => messages.wakes(config, m, current.member)))
          )
            return false;
          if (!batch.messages.length) return false;
          const heldNotices = held.get(fresh.id) ?? [];
          let text = batch.text;
          let taken = 0;
          for (const notice of heldNotices) {
            if (text.length + MESSAGE_SEPARATOR.length + notice.text.length > MAX_FIRST_INPUT_CHARS) break;
            text += MESSAGE_SEPARATOR + notice.text;
            taken++;
          }
          // Not taken by the session (PM-571), or it ended: the messages stay waiting, and are tried again.
          yield* typeInto(fresh, text).pipe(Effect.tapError(() => retryLater(fresh)));
          typedOk(fresh);
          // Keep notices on failure, and preserve ones appended while the input was being typed.
          const remaining = (held.get(fresh.id) ?? []).slice(taken);
          if (remaining.length) held.set(fresh.id, remaining);
          else held.delete(fresh.id);
          for (const message of batch.messages) messages.markRecipientDelivered(message.id, current.member);
          for (const notice of heldNotices.slice(0, taken))
            if (notice.messageId) messages.markRecipientDelivered(notice.messageId, current.member);
          return true;
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              for (const message of waiting) claims.delete(`${message.id}:${current.member}`);
              flushing.delete(current.id);
            }),
          ),
        );
      });

    /** Types the messages waiting for the session's member and work item (after it started). */
    const deliverWaiting: DeliveryEffects['deliverWaiting'] = (session) =>
      Effect.gen(function* () {
        const current = sessions.find(session.id);
        const config = projects.cachedConfig(session.projectKey);
        // Human inputs retain the existing queue and as-written restart behavior (K3/K6).
        if (
          current &&
          config &&
          sessions.isRunning(current.id) &&
          !sessions.isPaused(current) &&
          !sessions.permissionRestartDue(current) &&
          !starting.has(recipientKey(current.projectKey, current.member, current.workItem))
        ) {
          for (const message of messages.waiting(current.projectKey, current.member, current.workItem))
            if (memberOf(config, message.from)?.kind === 'human') yield* deliver(current, message);
        }
        const flush = flushWaiting(session).pipe(
          catchFailure((cause) =>
            Effect.sync(() =>
              ctx.logger.warn(
                { err: failure(cause), sessionId: session.id },
                'team message batch delivery failed',
              ),
            ),
          ),
        );
        yield* Effect.forkIn(flush, scope, { startImmediately: true });
      });

    const notice: DeliveryEffects['notice'] = (session, from, text, taskKey) =>
      Effect.gen(function* () {
        const {
          text: typed,
          messageIds,
          kept,
        } = withHeld(session, formatInjectedTeamMessage(from, text, taskKey));
        yield* typeInto(session, typed).pipe(
          Effect.tapError(() => Effect.sync(() => restoreHeld(session, kept))),
        );
        for (const id of messageIds) messages.markRecipientDelivered(id, session.member);
        return true;
      }).pipe(
        catchFailure((cause) =>
          Effect.sync(() => {
            ctx.logger.warn({ err: failure(cause), sessionId: session.id }, 'could not deliver a message');
            return false;
          }),
        ),
      );

    return {
      deliver,
      deliverWithFirstInput,
      startAndDeliver: (projectKey, handle, workItem, start) =>
        Effect.gen(function* () {
          const recipient = recipientKey(projectKey, handle, workItem);
          const waiting = messages.waiting(projectKey, handle, workItem);
          starting.add(recipient);
          const result = yield* Effect.gen(function* () {
            const batch = yield* batchOf(projectKey, handle, workItem, waiting);
            const started = yield* Effect.tryPromise({
              try: () => start(batch.messages.length ? [batch.text] : []),
              catch: (cause) => new StartFailed({ cause }),
            });
            yield* deliverWithFirstInput(
              handle,
              started.messagesSent ? batch.messages : [],
              started.firstInput,
              started.session,
            );
            return started;
          }).pipe(Effect.ensuring(Effect.sync(() => starting.delete(recipient))));
          yield* deliverWaiting(result.session);
        }),
      deliverWaiting,
      flushWaiting,
      notice,
      /**
       * Keep an idle session's notice for its next input (PM-249); busy sessions retain
       * the existing runner queue delivery of coordination and answer notices.
       */
      noticeOrHold: (session, from, text, taskKey) =>
        session.state !== 'idle'
          ? Effect.asVoid(
              Effect.forkIn(notice(session, from, text, taskKey), scope, { startImmediately: true }),
            )
          : Effect.sync(() =>
              keep(session, { text: formatInjectedTeamMessage(from, text, taskKey), messageId: null }),
            ),
      /**
       * An idle session gets the stored message before its next input, and starts nothing for it (PM-421).
       * `flushWaiting` leaves it alone, so an idle session is not typed into only for it; it counts as
       * delivered once typed. When the session ends first, it stays waiting for the member's next session.
       */
      holdUntilInput: (session, message) =>
        Effect.sync(() =>
          keep(session, {
            text: formatInjectedTeamMessage(
              message.from,
              messageTextWithAttachments(message),
              message.taskKey,
              undefined,
              undefined,
              message.location,
            ),
            messageId: message.id,
          }),
        ),
      /**
       * A person wrote into a session that waits for its restart (PM-170): the message waits with the
       * others and is typed as it was written, without the team prefix, once the session runs again.
       */
      holdAsWritten: (session, message) =>
        Effect.sync(() => {
          asWritten.add(`${message.id}:${session.member}`);
        }),
      /**
       * The session is paused (PM-219): the message waits, stored, and goes in when the pause is over
       * (`deliverPauseHeld`). Not `deliverWaiting`'s business: that one would also type what other holds
       * keep back (the fix round limit, a refinement turn).
       */
      holdForPause: (session, message) =>
        Effect.sync(() => {
          pauseHeld.set(`${message.id}:${session.member}`, {
            sessionId: session.id,
            messageId: message.id,
            member: session.member,
          });
        }),
      /** The messages kept back for the session's pause go in now, in the order they came. */
      deliverPauseHeld: (session) =>
        Effect.gen(function* () {
          for (const [claim, heldMessage] of [...pauseHeld]) {
            if (heldMessage.sessionId !== session.id) continue;
            pauseHeld.delete(claim);
            const message = messages.get(heldMessage.messageId);
            const receipt = message?.receipts?.find((r) => r.handle === heldMessage.member);
            // Taken in by another way meanwhile (a restart's first input): not typed twice.
            const config = projects.cachedConfig(session.projectKey);
            if (
              message &&
              !receipt?.deliveredAt &&
              config &&
              memberOf(config, message.from)?.kind === 'human'
            )
              yield* deliver(session, message);
          }
          yield* deliverWaiting(session);
        }),
      /** The session's held messages are not typed in any more: its restart takes them as waiting ones. */
      dropPauseHeld: (sessionId) =>
        Effect.sync(() => {
          for (const [claim, heldMessage] of [...pauseHeld])
            if (heldMessage.sessionId === sessionId) pauseHeld.delete(claim);
        }),
      /**
       * Drops what was kept for a session that ended (`session_ended`), and its pending retry: the
       * restart takes the waiting messages in its first input.
       */
      dropHeld: (sessionId) =>
        Effect.gen(function* () {
          held.delete(sessionId);
          retryAttempts.delete(sessionId);
          yield* FiberMap.remove(retryTimers, sessionId);
        }),
      /** Binds the card's existing refinement and fix-limit holds after messaging is built. */
      useMessageHolds: (check) =>
        Effect.sync(() => {
          messageHolds = check;
        }),
    };
  });

/**
 * Handles a failure or a defect, not an interruption: a fiber stopped by `close()` or `dropHeld`
 * is not a failed delivery, so it logs no warning and starts no retry.
 */
function catchFailure<A2, E2, R2>(handler: (cause: Cause.Cause<unknown>) => Effect.Effect<A2, E2, R2>) {
  return <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A | A2, E2, R | R2> =>
    Effect.catchCause(self, (cause) =>
      // An interrupt-only cause carries no typed error, so the cast to `never` is exact.
      Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause as Cause.Cause<never>) : handler(cause),
    );
}

/** What the facade throws: the error the service call failed with, not its Effect wrapper. */
function failure(cause: Cause.Cause<unknown>): unknown {
  const error = Cause.squash(cause);
  return error instanceof TypeIntoFailed || error instanceof StartFailed ? error.cause : error;
}

// `Effect.runSync` brings its own synchronous scheduler; the inline one (`runPromise`) is in kernel.
const runSync = Effect.runSync;

/** Facade: the same members as before, plus `close()`. */
export class MessageDelivery {
  private readonly scope = Scope.makeUnsafe();
  private readonly core: DeliveryEffects;

  constructor(deps: DeliveryDeps) {
    this.core = runSync(Scope.provide(makeMessageDelivery(deps), this.scope));
  }

  /** Stops every pending retry and background delivery; the server's shutdown calls it. */
  close(): Promise<void> {
    return runPromise(Scope.close(this.scope, Exit.void));
  }

  deliver(session: Session, message: TeamMessage, text?: string): void {
    runSync(this.core.deliver(session, message, text));
  }

  deliverWithFirstInput(
    handle: string,
    messages: TeamMessage[],
    firstInput: Promise<boolean>,
    session?: Session,
  ): void {
    runSync(this.core.deliverWithFirstInput(handle, messages, firstInput, session));
  }

  startAndDeliver(
    projectKey: string,
    handle: string,
    workItem: WorkItemRef,
    start: (messages: string[]) => Promise<EnsureSessionResult>,
  ): Promise<void> {
    return runPromise(
      this.core
        .startAndDeliver(projectKey, handle, workItem, start)
        .pipe(Effect.catchTag('StartFailed', (error) => Effect.die(error.cause))),
    );
  }

  holdAsWritten(session: Session, message: TeamMessage): void {
    runSync(this.core.holdAsWritten(session, message));
  }

  holdForPause(session: Session, message: TeamMessage): void {
    runSync(this.core.holdForPause(session, message));
  }

  deliverPauseHeld(session: Session): void {
    runSync(this.core.deliverPauseHeld(session));
  }

  dropPauseHeld(sessionId: string): void {
    runSync(this.core.dropPauseHeld(sessionId));
  }

  deliverWaiting(session: Session): void {
    runSync(this.core.deliverWaiting(session));
  }

  flushWaiting(session: Session): Promise<boolean> {
    return runPromise(
      this.core
        .flushWaiting(session)
        .pipe(Effect.catchTag('TypeIntoFailed', (error) => Effect.die(error.cause))),
    );
  }

  notice(session: Session, from: string, text: string, taskKey: string | null): Promise<boolean> {
    return runPromise(this.core.notice(session, from, text, taskKey));
  }

  noticeOrHold(session: Session, from: string, text: string, taskKey: string | null): void {
    runSync(this.core.noticeOrHold(session, from, text, taskKey));
  }

  holdUntilInput(session: Session, message: TeamMessage): void {
    runSync(this.core.holdUntilInput(session, message));
  }

  dropHeld(sessionId: string): void {
    runSync(this.core.dropHeld(sessionId));
  }

  /** Binds the card's existing refinement and fix-limit holds after messaging is built. */
  useMessageHolds(check: (session: Session) => Promise<boolean>): void {
    runSync(this.core.useMessageHolds(check));
  }
}
