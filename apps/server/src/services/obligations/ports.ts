import type { ProjectConfig, SessionState } from '@projectman/shared';

/** One session of a member on a card, as the obligation tracking reads it. */
interface ObligationSession {
  state: SessionState;
  /** The process runs (or starts). */
  running: boolean;
  /** The session works now: engaged, or idle with its first turn or an input still to begin (`isSessionAtWork`). */
  atWork: boolean;
  lastActivityAt: string;
  endedAt: string | null;
}

/** What the tracking needs from the sessions (the runtime's orchestrator is adapted to it in the assembly). */
export interface ObligationSessions {
  /** The member's sessions on the card, any state. */
  ofMember(projectKey: string, taskKey: string, member: string): ObligationSession[];
  /** Whether the session is running and working a turn now (not idle, not waiting for its first input). */
  atWork(sessionId: string): boolean;
}

/** What the tracking needs from admission: the code that would refuse the member's next start on the card. */
export interface ObligationAdmission {
  refusal(config: ProjectConfig, member: string, taskKey: string): Promise<string | null>;
}

/** The refinement turn that is on a member now (`RefinementSteps.openTurn`). */
export interface ObligationRefinement {
  openTurn(projectKey: string, taskKey: string): { label: string | null; member: string; at: string } | null;
}

/**
 * How the start round sees the open offer of a card (PM-804): `offered` it still stands, `paused` a frame
 * lock or a hold keeps the card for now, `ended` it is not among the startable cards any more, null the round
 * has no view of the project now (the rows then stay as they are).
 */
export interface ObligationStartOffers {
  stateOf(projectKey: string, taskKey: string): 'offered' | 'paused' | 'ended' | null;
}

/** The runtime's existing fix-limit decision path, adapted by the assembly. */
export interface ObligationFixLimit {
  timeOut(projectKey: string, taskKey: string, decider: string): Promise<{ decisionItemId: string } | null>;
}
