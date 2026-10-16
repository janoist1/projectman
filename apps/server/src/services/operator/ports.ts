import type {
  MemberHandle,
  TaskKey,
  AiMemberConfig,
  ProjectConfig,
  ProjectPauseView,
  Session,
  SessionDetail,
  SessionStartCause,
  SessionStop,
  Task,
  TaskStartWaiting,
  WorkItemRef,
} from '@projectman/shared';
import type { EnsureSessionResult, ReleaseStateReport } from '../../contracts';

/** Runtime owns the mutation and rechecks facts while holding its task lock. */
export interface LoopTriageActions {
  assess(input: {
    projectKey: string;
    taskKey: TaskKey;
    loopId: string;
    generation: number;
    by: MemberHandle;
    outcome: 'progress' | 'loop';
    note: string;
    evidenceIds: string[];
  }): Promise<{
    state: 'observing' | 'awaiting_owner' | 'resolved';
    loopId: string;
    inboxItemId: string | null;
  }>;
}

/** The sessions the Operator looks at, stops and wakes (SessionOrchestrator). */
export interface OperatorSessions {
  find(sessionId: string): Session | null;
  get(projectKey: string, sessionId: string): Session;
  isRunning(sessionId: string): boolean;
  busyCount(): number;
  findRunning(projectKey: string, member: string, workItem: WorkItemRef): Session | null;
  isPaused(session: Pick<Session, 'id' | 'projectKey'>): boolean;
  stop(projectKey: string, sessionId: string, stop?: SessionStop): Promise<Session>;
  detail(projectKey: string, sessionId: string): Promise<SessionDetail>;
}
/** The Operator's wake-up as an automatic start; assignable to admission's AutomaticStart. */
export interface OperatorWakeStart {
  key: string;
  projectKey: string;
  taskKey: null;
  spec(): { kind: 'operator_signals'; projectKey: string };
  stillValid(): boolean;
  run(): Promise<void>;
  waitsFor(): string | undefined;
  retry(): Promise<void>;
  log: { deferred: string; retryFailed: string; fields(): Record<string, unknown> };
}
/** Admission (runtime/admission). */
export interface OperatorAdmission {
  attempt(start: OperatorWakeStart): Promise<unknown>;
  start(request: {
    config: ProjectConfig;
    member: AiMemberConfig;
    workItem: WorkItemRef;
    cause: SessionStartCause;
    messages: string[];
  }): Promise<EnsureSessionResult>;
  memberLoad(config: ProjectConfig, handle: string): number;
}
/** Message delivery (runtime/delivery). */
export interface OperatorDelivery {
  notice(session: Session, from: string, text: string, taskKey: string | null): Promise<boolean>;
  startAndDeliver(
    projectKey: string,
    handle: string,
    workItem: WorkItemRef,
    start: (messages: string[]) => Promise<EnsureSessionResult>,
  ): Promise<void>;
}
/** The refused starts that wait for admission (DeferredStarts). */
export interface WaitingStarts {
  list(): readonly {
    start: {
      key: string;
      projectKey: string;
      taskKey: string | null;
      stillValid(task: Task | null): boolean;
    };
    waiting: TaskStartWaiting;
  }[];
}
/** The message wake-ups (MessageStarts). */
export interface OperatorMessageStarts {
  wakeKey(projectKey: string, handle: string, workItem: WorkItemRef): string;
  lastFailure(projectKey: string, handle: string, workItem: WorkItemRef): { code: string; at: string } | null;
}
/** Releases (services/releases). */
export interface OperatorReleases {
  unreleased(
    projectKey: string,
  ): { base: string; count: number; oldestAt: string; taskKeys: string[] } | null;
  overview(projectKey: string): Promise<ReleaseStateReport | null>;
}
/** Who pauses or resumes a project through the Operator: a person's approval in the app. */
export interface OperatorPauseRequester {
  check?: () => void;
  userId: string | null;
  source: 'app';
}
/** Pauses (PauseService in runtime/sessions); the Operator pauses and resumes one project. */
export interface OperatorPauses {
  projectView(projectKey: string): ProjectPauseView;
  pause(target: { scope: 'project'; projectKey: string }, by: OperatorPauseRequester): Promise<void>;
  resume(target: { scope: 'project'; projectKey: string }, by: OperatorPauseRequester): Promise<void>;
}
