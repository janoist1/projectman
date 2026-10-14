import type { Session, SessionStop } from '@projectman/shared';

export interface StageReviewerSessions {
  list(projectKey: string, filter?: { member?: string; taskKey?: string }): Session[];
  isRunning(sessionId: string): boolean;
  stop(projectKey: string, sessionId: string, stop?: SessionStop): Promise<Session>;
}
