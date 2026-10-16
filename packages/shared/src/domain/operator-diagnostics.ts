import type { SessionState } from './session';
import type { StageKind } from './pipeline';
import type { TaskStartWaiting } from './task';
import type { StartBlock } from '../config/start-block';
import type { TaskWait } from '../config/task-wait';
import type { OperatorSignal } from '../api/dto';
import type { WakeBlock } from './message-wake';
import type { StaleReason } from './message';
import type { WorkItemRef } from './session';
import type { EngineId } from './engine';
import type { MemberHandle } from './member';

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

/** Delivery facts, without message text or attachments. */
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
    /** The receipt's route, else the card's route (or the general conversation). */
    route: WorkItemRef;
    /** The recipient's live session on that route. */
    session: { id: string; state: SessionState; since: string } | null;
    /** The admission deferral of the recipient's start on that route. */
    waiting: { reason: TaskStartWaiting['reason']; since: string } | null;
    /** The last failed start on that route since the server started. */
    lastStartFailure: { code: string; at: string } | null;
    /** Why the message does not wake the recipient, from current facts. */
    noWake: WakeBlock | 'info' | null;
    stale: StaleReason | null;
  }>;
}

/** A bounded, read-only diagnostic projection. Never includes raw runner or check output. */
export interface OperatorDiagnostics {
  task: TaskStateReport;
  asOf: string;
  sessions: Array<{
    id: string;
    member: MemberHandle;
    state: SessionState;
    lastActivityAt: string;
    lastTool: { name: string; at: string } | null;
    lastError: { code: string; at: string } | null;
  }>;
  deliveries: MessageStateReport[];
  checks: Array<{
    runId: string;
    outcome: 'passed' | 'failed' | 'error';
    failedFiles: string[];
    at: string;
  }>;
  machine: {
    engineId: EngineId;
    /** Whole-machine CPU percentage, 0..100, when measurable. */
    cpuLoad: number | null;
    memoryUsedBytes: number | null;
    memoryTotalBytes: number | null;
    freeDiskBytes: number | null;
    measuredAt: string | null;
  } | null;
}
