import type {
  InboxKind,
  SessionState,
  StageKind,
  StaleReason,
  StartBlock,
  TaskStartWaiting,
  WakeBlock,
  WorkItemRef,
} from '@projectman/shared';
import type { TaskWait, OperatorSignal } from '@projectman/shared';

export interface TaskStateReport {
  taskKey: string;
  title: string;
  stageId: string;
  stageKind: StageKind;
  assignee: string | null;
  labels: string[];
  startWaiting: TaskStartWaiting | null;
  startBlock: StartBlock | null;
  missingGateLabels: string[];
  openQuestions: Array<{ id: string; from: string; at: string; title: string }>;
  session: { id: string; member: string; state: SessionState; since: string } | null;
  holds: Array<'fix_limit' | 'senior_wait' | 'loop' | 'paused'>;
  wait: TaskWait | null;
  signals: OperatorSignal[];
}

export interface ProjectStateReport {
  paused: { project: boolean; instance: boolean };
  stages: Array<{ stageId: string; count: number }>;
  sessions: Array<{ id: string; member: string; taskKey: string | null; state: SessionState; since: string }>;
  waitingStarts: Array<{ taskKey: string; member: string | null; reason: TaskStartWaiting['reason'] }>;
  openOwnerItems: Array<{ id: string; kind: InboxKind; taskKey: string | null; title: string }>;
  signals: OperatorSignal[];
}

/** What became of one team message for each recipient (PM-543), from today's facts. */
export interface MessageStateReport {
  messageId: string;
  from: string;
  taskKey: string | null;
  kind: 'action' | 'info';
  sentAt: string;
  recipients: Array<{
    handle: string;
    human: boolean;
    deliveredAt: string | null;
    /** Where the recipient gets it: the receipt's route, else the card's (or the general chat). */
    route: WorkItemRef;
    /** The recipient's live session on that route. */
    session: { id: string; state: SessionState; since: string } | null;
    /** The admission deferral of the recipient's start on that route. */
    waiting: { reason: TaskStartWaiting['reason']; since: string } | null;
    /** The last failed start on that route since the server started (MessageStarts memory). */
    lastStartFailure: { code: string; at: string } | null;
    /** Why it does not wake, from today's facts. */
    noWake: WakeBlock | 'info' | null;
    stale: StaleReason | null;
  }>;
}
