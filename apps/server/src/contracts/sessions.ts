import type { Session, SessionStartCause } from '@projectman/shared';

export interface EnsureSessionOptions {
  /** Why the session starts; passed on to `task_session_joined`. None: the notice names no reason. */
  cause?: SessionStartCause;
  /**
   * The same session started again after a pause or a shutdown (PM-219): not a joining, no
   * `task_session_joined`.
   */
  pauseRestart?: boolean;
  /**
   * The messages that cause this start (a person writing to a stopped session, the waiting team
   * messages), oldest first, as they are typed in. The session takes them in its first input, in
   * full: a resumed one in place of the continue message, a new conversation after its brief;
   * `messagesSent` tells the caller how many. What does not fit `MAX_FIRST_INPUT_CHARS` is left to
   * the caller, which types it after the session started.
   */
  messages?: string[];
  /**
   * What a pause that ended tells a resumed conversation (PM-219, `ContextPackBuilder.pauseNudge`): the
   * first thing in its first input, before the messages, or in place of the continue message when there
   * are none. A new conversation ignores it.
   */
  nudge?: string;
}

export interface EnsureSessionResult {
  session: Session;
  /** A new row was created (first session for this member x work item). */
  created: boolean;
  /** The agent's conversation was resumed (`--resume`, `codex resume`). */
  resumed: boolean;
  /** A process was started (false when a running session was reused). */
  started: boolean;
  /**
   * How many of the messages passed in `EnsureSessionOptions` (the first ones, in order) became part
   * of the session's first input: the caller counts exactly these as delivered.
   */
  messagesSent: number;
  /**
   * Settles when the session's first input (with the `messagesSent` messages in it) is known to have
   * reached it: true once it was typed (Codex: started with it on its command line), false when the
   * process ended first (PM-189). Only then do the messages count as delivered; until then they wait.
   * Already true when nothing was sent.
   */
  firstInput: Promise<boolean>;
}
