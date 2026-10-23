import type { ProjectConfig, Session, Task, TeamMessage, WorkItemRef } from '@projectman/shared';
import type { SentMessageRecipient, SourceHead } from '../../contracts';

/** The session operations used by `Messaging` and `RelationNotices`. */
export interface MessageSessions {
  find(sessionId: string): Session | null;
  list(projectKey: string, filter?: { member?: string; taskKey?: string }): Session[];
  isRunning(sessionId: string): boolean;
  requestReviewRound(projectKey: string, taskKey: string, member?: string): void;
  sourceHead(config: ProjectConfig, task: Task, opts?: { strict?: boolean }): Promise<SourceHead | null>;
  cardWorkers(projectKey: string, task: Task, config: ProjectConfig): Session[];
}

/** Whose turn it is on a card that is being refined. */
export interface MessageRefinement {
  turnMember(projectKey: string, taskKey: string): string | null;
}

interface MessageRequestInput {
  projectKey: string;
  sessionId: string;
  source: 'message' | 'answer' | 'approval';
  messageId: string | null;
  inboxItemId?: string | null;
  from: string;
  text: string;
}

/** The owner's requests to the Operator that a message or an answer opens (PM-463). */
export interface MessageRequests {
  open(input: MessageRequestInput): void;
}

export type MessageHoldName = 'handoff' | 'refinement_turn' | 'fix_limit' | 'full_test' | 'engine';

export interface MessagePlace {
  readonly workItem: WorkItemRef;
  readonly running: Session | null;
}

export interface MessagePlacement extends MessagePlace {
  readonly handle: string;
  readonly hold: MessageHoldName | null;
}

export type RecipientDelivery = Omit<SentMessageRecipient, 'handle'>;

/** Runtime placement, holds and delivery of recorded team messages. */
export interface MessageRouting {
  /** Where an AI recipient gets a message meant for `workItem`, and the running session there. */
  place(
    projectKey: string,
    config: ProjectConfig,
    handle: string,
    workItem: WorkItemRef,
    ownCard?: boolean,
    from?: string,
  ): MessagePlace;
  /** Why a message to AI member `handle` is held back when it is sent, in today's order of checks. */
  holdOf(
    config: ProjectConfig,
    task: Task | null,
    from: string,
    handle: string,
    opts: { readonly duringRefinement?: boolean },
  ): MessageHoldName | null;
  /**
   * Types the recorded message in, holds it or wakes each placed recipient. Synchronous unless
   * `awaitWake` is set and a waker is registered; then it resolves once each wake-up result is known
   * (at most WAKE_REPLY_WAIT_MS).
   */
  deliver(input: {
    config: ProjectConfig;
    projectKey: string;
    message: TeamMessage;
    placements: readonly MessagePlacement[];
    untilInput: boolean;
    awaitWake: boolean;
  }): ReadonlyMap<string, RecipientDelivery> | Promise<ReadonlyMap<string, RecipientDelivery>>;
}
