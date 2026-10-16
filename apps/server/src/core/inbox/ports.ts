import type {
  AgentProvider,
  AiMemberConfig,
  EngineId,
  MemberHandle,
  ProjectConfig,
  RoleId,
  Session,
  SessionStartCause,
  Task,
  TaskStartWaiting,
  WorkItemRef,
} from '@projectman/shared';
import type { EnsureSessionResult } from '../../contracts';

/** The runtime's existing engine and command policy, evaluated with the session engine's paths. */
export interface InboxPermissionPolicy {
  engineIdOf(session: Pick<Session, 'engineId'>): EngineId;
  readableRootsFor(input: {
    config: Pick<ProjectConfig, 'project'>;
    cwd: string;
    projectKey: string;
    task: Pick<Task, 'key' | 'repo'> | null;
    worktreesRootDir?: string;
    attachmentsDir?: string | null;
    parentAttachmentsDir?: string | null;
  }): string[];
  commandVerdict(input: {
    config: ProjectConfig;
    session: { cwd: string; role: RoleId; provider?: AgentProvider; member?: string; branch?: string | null };
    task: Pick<Task, 'repo' | 'merge'> | null;
    toolName: string;
    toolInput: unknown;
    worktreesRootDir?: string;
    workspacesRootDir?: string;
    readableRoots?: readonly string[];
  }): { behavior: 'allow' } | { behavior: 'deny'; message: string } | null;
}

/** A question-screening start that admission can defer and rebuild from its existing persisted spec. */
export interface ScreeningAttempt {
  key: string;
  projectKey: string;
  taskKey: string | null;
  spec(): { kind: 'question_screening'; projectKey: string };
  stillValid(task: Task | null): boolean;
  run(): Promise<void>;
  waitsFor(): string | undefined;
  retry(): Promise<void>;
  log: { deferred: string; retryFailed: string; fields(): Record<string, unknown> };
}

/** Admission of the Operator's general conversation for question screening. */
export interface ScreeningAdmission {
  attempt(
    start: ScreeningAttempt,
  ): Promise<{ kind: 'done' } | { kind: 'deferred'; waiting: TaskStartWaiting }>;
  start(input: {
    config: ProjectConfig;
    member: AiMemberConfig;
    workItem: WorkItemRef;
    cause: SessionStartCause;
    capacity: boolean;
    messages: string[];
  }): Promise<EnsureSessionResult>;
}

/**
 * Whether the machine a member's sessions run on is reachable (PM-708). `online`: its link is up; `offline`:
 * known but not connected; `unknown`: no machine is chosen. `lastConfirmedOnlineAt` is the last moment the
 * server recorded the machine online (null: never recorded). The state is data of the link, not a member setting.
 */
export interface ScreeningEngineState {
  read(
    projectKey: string,
    member: MemberHandle,
  ): { state: 'online' | 'offline' | 'unknown'; lastConfirmedOnlineAt: string | null };
}

/** Only the running-session and pause queries used to deliver screened questions. */
export interface ScreeningSessions {
  findRunning(projectKey: string, member: string, workItem: WorkItemRef): Session | null;
  isPaused(session: Pick<Session, 'id' | 'projectKey'>): boolean;
}
