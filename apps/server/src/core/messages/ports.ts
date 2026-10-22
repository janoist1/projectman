import type {
  AgentProvider,
  ProjectConfig,
  Session,
  SessionStartCause,
  Task,
  TeamMessage,
  WorkItemRef,
} from '@projectman/shared';
import type { CardWorker, EnsureSessionOptions, EnsureSessionResult, SourceHead } from '../../contracts';

/** The sessions a message is sent to, woken or held for: what `Messaging` and `RelationNotices` read and start. */
export interface MessageSessions {
  get(projectKey: string, sessionId: string): Session;
  find(sessionId: string): Session | null;
  list(projectKey: string, filter?: { member?: string; taskKey?: string }): Session[];
  isRunning(sessionId: string): boolean;
  findRunning(projectKey: string, member: string, workItem: WorkItemRef): Session | null;
  isPaused(session: Pick<Session, 'id' | 'projectKey'>): boolean;
  ensureSession(
    projectKey: string,
    handle: string,
    workItem: WorkItemRef,
    opts?: EnsureSessionOptions,
  ): Promise<EnsureSessionResult>;
  /** Restarts a running session with the messages as its first input; false when it is no longer running. */
  restartWithMessages(
    projectKey: string,
    sessionId: string,
    messages: string[],
    cause?: SessionStartCause,
  ): Promise<boolean>;
  requestReviewRound(projectKey: string, taskKey: string, member?: string): void;
  sourceHead(config: ProjectConfig, task: Task, opts?: { strict?: boolean }): Promise<SourceHead | null>;
  cardWorkers(projectKey: string, task: Task, config: ProjectConfig): Session[];
  waitingPermissionFor(config: ProjectConfig, session: Session): CardWorker['waitingPermission'];
  reviewRoundDue(session: Session): boolean;
  permissionRestartDue(session: Session): boolean;
  assertProviderCooldown(provider: AgentProvider): void;
}

/** How a message reaches a session: typed in, held until a turn, a pause or an input, or started with it. */
export interface MessageDeliveryPort {
  deliver(session: Session, message: TeamMessage, text?: string): void;
  deliverWithFirstInput(
    handle: string,
    messages: TeamMessage[],
    firstInput: Promise<boolean>,
    session?: Session,
  ): void;
  startAndDeliver(
    projectKey: string,
    handle: string,
    workItem: WorkItemRef,
    start: (messages: string[]) => Promise<EnsureSessionResult>,
  ): Promise<void>;
  holdAsWritten(session: Session, message: TeamMessage): void;
  holdForPause(session: Session, message: TeamMessage): void;
  deliverWaiting(session: Session): void;
  notice(session: Session, from: string, text: string, taskKey: string | null): Promise<boolean>;
  noticeOrHold(session: Session, from: string, text: string, taskKey: string | null): void;
  holdUntilInput(session: Session, message: TeamMessage): void;
}

/** Whose turn it is on a card that is being refined. */
export interface MessageRefinement {
  turnMember(projectKey: string, taskKey: string): string | null;
}

interface MessageRequestInput {
  projectKey: string;
  sessionId: string;
  source: 'message' | 'answer' | 'approval';
  messageId: string | null;
  inboxItemId?: string | null;
  from: string;
  text: string;
}

/** The owner's requests to the Operator that a message or an answer opens (PM-463). */
export interface MessageRequests {
  open(input: MessageRequestInput): void;
}
