import type { InboxKind, SessionState, StageKind, StartBlock, TaskStartWaiting } from '@projectman/shared';

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
}

export interface ProjectStateReport {
  paused: { project: boolean; instance: boolean };
  stages: Array<{ stageId: string; count: number }>;
  sessions: Array<{ id: string; member: string; taskKey: string | null; state: SessionState; since: string }>;
  waitingStarts: Array<{ taskKey: string; member: string | null; reason: TaskStartWaiting['reason'] }>;
  openOwnerItems: Array<{ id: string; kind: InboxKind; taskKey: string | null; title: string }>;
}
