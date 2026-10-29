import type {
  AgentProvider,
  MemberHandle,
  TaskKey,
  ProjectConfig,
  ProjectPauseView,
  Session,
  SessionDetail,
  SessionStop,
  Task,
  TaskStartWaiting,
  WorkItemRef,
  OperatorDiagnostics,
} from '@projectman/shared';

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

/** Filtered check history and engine-bound machine readings, composed by assembly. */
export interface OperatorDiagnosticSources {
  checks(projectKey: string, taskKey: string): OperatorDiagnostics['checks'];
  machine(session: Session | undefined): Promise<OperatorDiagnostics['machine']>;
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
  detail(
    projectKey: string,
    sessionId: string,
    window?: { limit: number; before?: string },
  ): Promise<SessionDetail>;
}
/** Admission (runtime/admission). */
export interface OperatorAdmission {
  memberLoad(config: ProjectConfig, handle: string): number;
  /** The AI owners of the work stage with capacity, not on leave, not on hold and with no start waiting for them. */
  freeDevelopers(config: ProjectConfig, stageId: string): readonly { handle: MemberHandle }[];
  engineOffline(projectKey: string, handle: string): object | null;
  providerAvailable(config: ProjectConfig, provider: AgentProvider, member: MemberHandle): boolean;
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
  /** The member queue's wake-ups that wait for a code a start can wait for (PM-925). */
  queueWaits(): readonly { projectKey: string; taskKey: string | null; waiting: TaskStartWaiting }[];
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
  pause(
    target: { scope: 'project'; projectKey: string },
    by: OperatorPauseRequester,
    options?: { reason?: string },
  ): Promise<void>;
  resume(target: { scope: 'project'; projectKey: string }, by: OperatorPauseRequester): Promise<void>;
}
