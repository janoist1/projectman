import type { InboxKind, SessionState, TaskStartWaiting, WorkQueueReason } from '@projectman/shared';
import type { ProjectManagerSignal, ProjectManagerWatch } from '@projectman/shared';
export type { TaskStateReport, MessageStateReport, ProjectManagerDiagnostics } from '@projectman/shared';

export interface ReleaseStateReport {
  running: { version: string; commit: string | null; tag: string | null };
  latestLive: {
    id: string;
    taskKey: string;
    tag: string | null;
    commit: string;
    liveAt: string | null;
  } | null;
  open: {
    id: string;
    taskKey: string;
    state: 'proposed' | 'approved' | 'deploying';
    commit: string;
    proposedBy: string;
  } | null;
  /** The last merges of cards into the release repository, newest first. */
  recentMerges: Array<{
    taskKey: string;
    title: string;
    commit: string | null;
    at: string | null;
    by: string | null;
  }>;
}

export interface ProjectStateReport {
  operatorWatch: ProjectManagerWatch;
  paused: { project: boolean; instance: boolean };
  stages: Array<{ stageId: string; count: number }>;
  sessions: Array<{ id: string; member: string; taskKey: string | null; state: SessionState; since: string }>;
  /** taskKey null: a start without a card (it goes to a general conversation), e.g. a wake-up for a message. */
  waitingStarts: Array<{
    taskKey: string | null;
    member: string | null;
    reason: TaskStartWaiting['reason'];
  }>;
  openOwnerItems: Array<{ id: string; kind: InboxKind; taskKey: string | null; title: string }>;
  signals: ProjectManagerSignal[];
  /** null: this instance does not release this project (no release target, or another project's). */
  release: ReleaseStateReport | null;
  /** The undelivered team messages of the AI members, per member; a member with none is left out. */
  waitingMessages: Array<{ member: string; count: number; oldestAt: string }>;
  /** The AI members' open queue items and whether a Claude is connected (PM-1294): numbers only, no titles. */
  workQueues: {
    /** Only members with an open item. */
    members: Array<{
      member: string;
      queued: number;
      processing: number;
      /** Queued items that have waited for `WORK_QUEUE_LONG_WAIT_MS` or more. */
      longWait: number;
      oldestQueuedAt: string | null;
      /** What the queued items wait for, counted per reason. */
      reasons: Partial<Record<WorkQueueReason, number>>;
      /** The oldest queued item's card; only for a start, obligation or fix limit item (a fact the board shows). */
      oldestTaskKey: string | null;
    }>;
    /** The integrator queue's items are the owner's alone: only whether a Claude is connected. */
    integratorConnected: boolean;
  };
}
