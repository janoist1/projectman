import type { Session } from '@projectman/shared';

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
