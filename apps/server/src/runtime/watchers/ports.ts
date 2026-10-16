import type { LoopTriageFacts, TaskKey } from '@projectman/shared';

/** Reporting only: this callback must never call back into the loop watch's task lock. */
export interface LoopTriageNotices {
  report(input: { projectKey: string; taskKey: TaskKey; facts: LoopTriageFacts }): Promise<{
    state: 'delivered' | 'queued' | 'unavailable' | 'failed';
    signalId: string | null;
  }>;
}

/** The PM engine's durable link state, composed in assembly like question screening. */
export interface LoopTriageEngine {
  read(
    projectKey: string,
    member: string,
  ): {
    state: 'online' | 'offline' | 'unknown';
    lastConfirmedOnlineAt: string | null;
  };
}
