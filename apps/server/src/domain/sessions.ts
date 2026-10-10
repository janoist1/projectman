import { wakesFor } from './messaging';
import path from 'node:path';
import {
  approverBlocker,
  ALERT_SEEN_OPTION,
  autoCompactWindowOf,
  cardWorkerSessions,
  DEFAULT_AGENT_PROVIDER,
  LOCAL_ENGINE_ID,
  effectiveRepo,
  effectiveSessionPermissions,
  handoffBlocksStart,
  isOnLeave,
  isOpenTask,
  isTheme,
  isWorkingOnTask,
  isWorkPaused,
  memberOf,
  permissionDecidersNow,
  messageRoute,
  outboundNetworkOf,
  repoOf,
  routes,
  sameWorkItem,
  sessionWorkItemOf,
  stageOf,
  stageOwners,
} from '@projectman/shared';
import type {
  Actor,
  AgentProvider,
  AiMemberConfig,
  Attachment,
  ChatItem,
  EngineId,
  ExecutionProfile,
  HandoffSummary,
  MemberConfig,
  MemberStatus,
  PausePoint,
  PlanUsage,
  ProjectConfig,
  Session,
  SessionDetail,
  SessionState,
  SessionStop,
  Task,
  UpdateSessionRequest,
  WorkDoing,
  WorkItemRef,
} from '@projectman/shared';
import {
  BROWSERS_PATH_VARIABLE,
  COMPACTING_PROVIDERS,
  MANAGED_VM_UNAVAILABLE,
  SESSION_DIR_VARIABLE,
  WORKSPACE_CODEX_CONFIG,
  openingTurnOrigin,
  PROVIDER_NOT_LOGGED_IN,
} from '../contracts';
import type {
  AttachmentOperations,
  CardRelation,
  CardWorker,
  ContextFocus,
  ContextPackBuilder,
  HandoffTakeover,
  ManagedVmAttestation,
  ManagedVmBoundary,
  MemberMemoryStore,
  MemberWorkspaceManager,
  EngineDirectory,
  EngineHost,
  EngineSessionFolders,
  PreviousConversation,
  RelatedSession,
  RunnerEvent,
  RuntimeBoundary,
  ScreenshotScope,
  SessionPolicy,
  SessionRunner,
  SourceHead,
  ToolContext,
  TranscriptReader,
  WorktreeInfo,
} from '../contracts';
import { encodeWorkItem } from '../db';
import type { TaskHandoffRow } from '../db';
import { roleLabel } from '../agent-text';
import { ownerHandles, requireAiMember } from './access';
import { assertAiEnabled, assertNotOnLeave, assertNotPaused, assertRepoChosen } from './admission/rules';
import { QUESTION_LIMIT } from './card-questions';
import type { CardQuestions } from './card-questions';
import { isoNow } from './context';
import type { DomainContext } from './context';
import { conflict, DomainError, notFound, themeRefused } from './errors';
import type { MemberService } from './members';
import type { ProjectFocusService } from './project-focus';
import type { ConfigChange, ProjectService } from './projects';
import {
  allowedToolsFor,
  attachmentToolRules,
  deniedToolsFor,
  buildSessionPolicy,
  sessionPolicyFor,
  DONE_TASK_CLEANUP_DELAY_MS,
  DONE_TASK_TURN_LIMIT_MS,
  memberSandboxDir,
  sensitivePaths,
  sessionSandbox,
  usesWorktree,
  withSessionFolders,
} from './session-policy';
import type { TaskService } from './tasks';
import type { TimelineService } from './timeline';
import type { InputStallAlerts } from './input-stall-alert';
import type { UsageAlerts } from './usage-alerts';
import { ProviderQuotaHolds } from './provider-quota-hold';
import type { PlanUsageCache } from './plan-usage';
import type { InboxService } from './inbox';
import { aiActor, KeyedMutex, newId, newToken, newUuid, SYSTEM_ACTOR } from './util';
import { MemberWorkspaces } from './workspaces';
import type { WorkspacePlacement } from './workspaces';
import { engineIdOf, engineOption } from './engines';

export const LIVE_SESSION_STATES: SessionState[] = [
  'starting',
  'idle',
  'working',
  'waiting_permission',
  'waiting_input',
];
/** A turn is in progress: these count against `maxConcurrentAi`. */
export const BUSY_SESSION_STATES: SessionState[] = ['starting', 'working', 'waiting_permission'];
const ENDED = new Set<SessionState>(['exited', 'failed']);

/**
 * A session that owes a compaction (PM-213), idle at the end of its round or stopped and resuming,
 * gets it only if its conversation is bigger than this: its last measured context (input, cache read
 * and cache write of the last step). A fresh session already starts at 52-56k (the PM-209
 * measurement), a fixed share a compaction does not shrink, so a smaller conversation, one that was
 * just compacted included, is not worth the summary. An unknown context counts as small.
 */
export const COMPACT_MIN_CONTEXT_TOKENS = 100_000;

export interface EnsureSessionResult {
  session: Session;
  /** A new row was created (first session for this member x work item). */
  created: boolean;
  /** The agent's conversation was resumed (`--resume`, `codex resume`). */
  resumed: boolean;
  /** A process was started (false when a running session was reused). */
  started: boolean;
  /**
   * How many of the messages passed in `EnsureSessionOptions` (the first ones, in order) became part
   * of the session's first input: the caller counts exactly these as delivered.
   */
  messagesSent: number;
  /**
   * Settles when the session's first input (with the `messagesSent` messages in it) is known to have
   * reached it: true once it was typed (Codex: started with it on its command line), false when the
   * process ended first (PM-189). Only then do the messages count as delivered; until then they wait.
   * Already true when nothing was sent.
   */
  firstInput: Promise<boolean>;
}

export type { SessionStartCause } from '@projectman/shared';
import type { SessionStartCause } from '@projectman/shared';

export interface EnsureSessionOptions {
  /** Why the session starts; passed on to `task_session_joined`. None: the notice names no reason. */
  cause?: SessionStartCause;
  /**
   * The same session started again after a pause or a shutdown (PM-219): not a joining, no
   * `task_session_joined`.
   */
  pauseRestart?: boolean;
  /**
   * The messages that cause this start (a person writing to a stopped session, the waiting team
   * messages), oldest first, as they are typed in. The session takes them in its first input, in
   * full: a resumed one in place of the continue message, a new conversation after its brief;
   * `messagesSent` tells the caller how many. What does not fit `MAX_FIRST_INPUT_CHARS` is left to
   * the caller, which types it after the session started.
   */
  messages?: string[];
  /**
   * What a pause that ended tells a resumed conversation (PM-219, `ContextPackBuilder.pauseNudge`): the
   * first thing in its first input, before the messages, or in place of the continue message when there
   * are none. A new conversation ignores it.
   */
  nudge?: string;
}

/**
 * The most message text a session takes in its first input: it may go on a command line (Codex),
 * which the system limits (about 128 KB for one argument). What is more is typed in after the
 * session started, as it is for a session that runs. A team message (at most 20 000 characters)
 * with its prefix fits.
 */
export const MAX_FIRST_INPUT_CHARS = 24_000;

/** Between the messages of a first input, and before the first one after a brief. */
export const MESSAGE_SEPARATOR = '\n\n';

/** What introduces the messages that wait for a new conversation, after its brief. */
const WAITING_MESSAGES_HEADER = 'Messages that were waiting for you when this session started:';

/**
 * The messages that go into a first input: the longest run from the first that fits
 * `MAX_FIRST_INPUT_CHARS` together. It stops at the first one that does not fit (or is blank), so
 * that what is typed in afterwards keeps the order.
 */
function messagesForFirstInput(messages: string[] | undefined): string[] {
  const taken: string[] = [];
  let size = 0;
  for (const text of messages ?? []) {
    size += text.length + MESSAGE_SEPARATOR.length;
    if (!text.trim() || size > MAX_FIRST_INPUT_CHARS) break;
    taken.push(text);
  }
  return taken;
}

/** The first input of a new conversation: its brief, then the messages that wait for it. */
function newConversationInput(brief: string | null, messages: string[]): string | null {
  if (messages.length === 0) return brief;
  const waiting = messages.join(MESSAGE_SEPARATOR);
  return brief ? [brief, WAITING_MESSAGES_HEADER, waiting].join(MESSAGE_SEPARATOR) : waiting;
}

export interface SessionOrchestratorDeps {
  onAuthError?: (projectKey: string, handle: string, provider: AgentProvider, engineId: EngineId) => void;
  ctx: DomainContext;
  projects: ProjectService;
  tasks: TaskService;
  /** The project's focus (PM-437), named in the kick-off brief. */
  projectFocus: Pick<ProjectFocusService, 'get' | 'places'>;
  members: MemberService;
  timeline: TimelineService;
  runner: SessionRunner;
  transcripts: TranscriptReader;
  contextBuilder: ContextPackBuilder;
  /** The questions asked on a card, listed in the brief and in a resumed session's first message (PM-249). */
  cardQuestions: Pick<CardQuestions, 'list'>;
  memory: MemberMemoryStore;
  /**
   * The engines (PM-311): a session's worktrees, member workspaces, session folders, sandbox places
   * and process probe are its engine's, never the server's own.
   */
  engines: EngineDirectory;
  /** Base URL the claude CLI reaches this server at, e.g. http://127.0.0.1:4700. */
  publicBaseUrl: string;
  /** Delay before a done task's sessions are stopped and its worktrees removed. */
  doneCleanupDelayMs?: number;
  /** How long the session that moved a task to done may take to finish its turn (PM-190). */
  doneTurnLimitMs?: number;
  /** The task's attachments, listed in the kick-off brief (as the member may read them). */
  attachments?: Pick<AttachmentOperations, 'list'>;
  /** The attachment directory of a task (`AttachmentStorage.taskDirectory`): its session reads it without asking. */
  attachmentDirectory?: (projectKey: string, taskKey: string) => Promise<string>;
  /**
   * The VM boundary (PM-140). In the managed VM no session starts while it is not ready, every
   * session runs in its member's worker home (its workspace, or a directory for sessions without
   * one) and gets egress proxy credentials; the legacy worktree per task is not used there.
   */
  runtimeBoundary?: RuntimeBoundary;
  /**
   * The installation's execution profile (PM-141; default `legacy`). `managed_vm` is the owner's
   * choice for a verified managed VM: every session then starts question-free in the member's own
   * workspace, but only while `managedVm` proves the boundary at that start.
   */
  executionProfile?: ExecutionProfile;
  /** The proof of the managed VM boundary; without it a `managed_vm` installation starts nothing. */
  managedVm?: ManagedVmBoundary;
  /** A standby copy of the installation (`instance.json`): every session start is refused. */
  standby?: boolean;
  /**
   * A session changed execution profile: what it asked or was granted under the old one is
   * void (revokes its unconsumed boundary requests).
   */
  onExecutionProfileChange?: (projectKey: string, sessionId: string) => Promise<unknown>;
  /** The warning limit of a session's tokens (PM-187), checked whenever its usage grows. */
  usageAlerts?: Pick<UsageAlerts, 'check'>;
  /** Quota alerts are raised once per shared-provider hold (PM-377). */
  inbox?: Pick<InboxService, 'create' | 'openPermissionOf'>;
  /** Tells the owners of a session that waits for input unseen (PM-199). */
  inputStall?: Pick<InputStallAlerts, 'raise'>;
  /** How long a session may wait for input before they are told (default `INPUT_STALL_MS`). */
  inputStallMs?: number;
}

/** A session waiting for input at its terminal this long is reported to the owners (PM-199). */
export const INPUT_STALL_MS = 10 * 60_000;

/** Worktree removals that are refused on purpose (the worktree module's error codes). */
const KEPT_WORKTREE_CODES = new Set(['dirty', 'outside_root', 'not_a_worktree', 'main_worktree']);

/** The `code` of module errors (e.g. WorktreeError), without depending on their classes. */
function errorCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

function providerNotLoggedIn(provider: AgentProvider, details: Record<string, unknown>, detail?: string) {
  if (provider === 'nanogpt' && details.problem === 'no_key')
    return conflict('nanogpt_key_missing', 'NanoGPT is not ready', { provider });
  if (
    provider === 'nanogpt' &&
    ['cli_missing', 'cli_too_old', 'chatgpt_login'].includes(String(details.problem))
  )
    return conflict('nanogpt_setup_incomplete', 'NanoGPT is not ready', {
      provider,
      problem: details.problem,
      cliVersion: details.cliVersion,
      minCliVersion: details.minCliVersion,
    });
  return conflict(
    PROVIDER_NOT_LOGGED_IN,
    `${provider} is not logged in with a subscription${detail ? `: ${detail}` : ''}`,
    { provider, ...details },
  );
}

/**
 * A managed VM start that is refused (PM-141): the boundary is not proven now, the installed CLI is
 * not a version the question-free settings are proven for, or the VM's own configuration would
 * override the protected start. Only facts the runner or the boundary gave (never file content).
 */
function managedVmUnavailable(err: unknown, details: Record<string, unknown> = {}) {
  const known = errorCode(err) === MANAGED_VM_UNAVAILABLE;
  const reason = (err as { reason?: unknown } | null)?.reason;
  const more = (err as { details?: unknown } | null)?.details;
  return conflict(
    MANAGED_VM_UNAVAILABLE,
    known ? (err as Error).message : 'the managed VM boundary could not be verified',
    {
      reason: known && typeof reason === 'string' ? reason : 'verification_failed',
      ...(known && more && typeof more === 'object' ? (more as Record<string, unknown>) : {}),
      ...details,
    },
  );
}

/** The managed VM's placement of a session: the member's own workspace as PM-138 prepared it, or its home. */
function memberWorkspacePlacement(
  ws: WorkspacePlacement | null,
  cwd: string,
): Extract<SessionPolicy['placement'], { kind: 'member_workspace' }> {
  const placement = ws?.placement;
  if (placement?.kind === 'task_worktree' && placement.workspace)
    return { kind: 'member_workspace', path: placement.path, use: 'work', workspace: placement.workspace };
  if (placement?.kind === 'review_copy') {
    const { sourceCommit, roundId, sourceBranch, baseBranch, baseCommit } = placement;
    return {
      kind: 'member_workspace',
      path: placement.path,
      use: 'review',
      review: {
        sourceCommit,
        roundId,
        ...(sourceBranch ? { sourceBranch } : {}),
        ...(baseBranch ? { baseBranch } : {}),
        ...(baseCommit ? { baseCommit } : {}),
      },
    };
  }
  return { kind: 'member_workspace', path: cwd, use: 'home' };
}

/** One start, stop or settings change at a time per (member x work item). */
function sessionLockKey(projectKey: string, handle: string, workItem: WorkItemRef): string {
  const wi = encodeWorkItem(workItem);
  return `${projectKey}:${handle}:${wi.type}:${wi.ref}`;
}

/** A restart of a session for a new permission mode: what it drops. */
interface PermissionRestart {
  /** The process had permissions granted "for this session", which the CLI forgets with it. */
  grantsLost: boolean;
}

function workItemLabel(item: WorkItemRef, member: AiMemberConfig): string {
  if (item.type === 'task') return item.taskKey;
  if (item.type === 'meeting') return item.meetingId;
  return member.handle;
}

/**
 * The lifecycle of AI sessions, one per (AI member x work item): starts, reuses and resumes
 * them through the runner, maps MCP tokens to tool contexts, and mirrors runner events into
 * the database, the event bus (clients) and the domain events (`session_started`,
 * `session_ended`). Admission (src/domain/admission) decides whether an automatic start may
 * happen; team messages (src/domain/messaging) are typed in through `typeInto`.
 */
export class SessionOrchestrator {
  private readonly deps: SessionOrchestratorDeps;
  private fullTests: { runsFor(task: Task, config: ProjectConfig): boolean } | undefined;

  private readonly ctx: DomainContext;
  private readonly locks = new KeyedMutex();
  private readonly tokens = new Map<string, ToolContext>();
  private readonly tokenBySession = new Map<string, string>();
  /** Egress proxy credentials of live sessions (managed VM): token -> session. */
  private readonly egressTokens = new Map<string, ToolContext>();
  private readonly egressTokenBySession = new Map<string, string>();
  private readonly cleanupTimers = new Set<NodeJS.Timeout>();
  /** The wait of each session that waits for input at its terminal (PM-199), until it is over. */
  private readonly inputWaits = new Map<string, { since: string; timer: NodeJS.Timeout }>();
  /**
   * Sessions that moved their task to done in the middle of a turn (PM-190): the task's cleanup
   * runs once the turn ends, or at the limit.
   */
  private readonly finishingTurns = new Map<
    string,
    { projectKey: string; taskKey: string; timer: NodeJS.Timeout }
  >();
  /** The provider each session's current process runs, for the transcript it reports. */
  private readonly processProviders = new Map<string, AgentProvider>();
  /** Sessions whose current process resumes a conversation: one that exits before it is ready gives it up (PM-340). */
  private readonly resumingProcesses = new Set<string>();
  /** Sessions whose first input (with messages in it) is not known to have reached them: settles it. */
  private readonly firstInputWaiters = new Map<string, (typed: boolean) => void>();
  /**
   * Sessions started with an opening input whose first turn has not begun: their CLI reports `idle`
   * once it can take input, before the input is typed (PM-242).
   */
  private readonly awaitingFirstTurn = new Set<string>();
  /** The permission mode each session's current process runs in (PM-170): another one restarts it. */
  private readonly processModes = new Map<string, string | undefined>();
  /** The session's grants "for this session" when its current process started (`sessionGrants`). */
  private readonly processGrants = new Map<string, number>();
  /**
   * Sessions marked to close at their next idle moment (PM-288), with the reason. In memory only: the
   * next sweep finds a session that is still due.
   */
  private readonly closePending = new Map<string, SessionStop>();
  /** Sessions `close` is stopping now: nothing is typed into them (`typeInto`). */
  private readonly closing = new Set<string>();
  /**
   * The reason of a stop in progress, for `markEnded` to record when the runner's own exit event
   * reaches it first.
   */
  private readonly stopReasons = new Map<string, SessionStop>();
  /** What a screenshot run of each live session with a folder in its worktree needs (PM-351). */
  private readonly screenshotScopes = new Map<string, ScreenshotScope>();
  /** Told when a session's folder is removed (the session ended), before it is (PM-351). */
  private readonly folderListeners = new Set<(sessionId: string) => void>();
  /** The removals of session folders that are going on, by session (see `removeSessionFolderOf`). */
  private readonly folderRemovals = new Map<string, Promise<void>>();
  private readonly unsubscribe: () => void;
  private readonly providerHolds = new ProviderQuotaHolds();
  private quotaUsage: Pick<PlanUsageCache, 'get' | 'invalidate'> | undefined;
  private quotaResume:
    ((session: Session, stageId: string, after: 'quota' | 'login') => Promise<void>) | undefined;
  /** Sessions whose CLI reported a lost login, and of which provider, until they end (PM-467). */
  private readonly lostLogins = new Map<string, AgentProvider>();
  private quotaProbe: Promise<PlanUsage | null> | null = null;
  /** The member workspaces (PM-138) of each engine that has them, made when first used. */
  private readonly workspaceSets = new Map<
    EngineId,
    { manager: MemberWorkspaceManager; workspaces: MemberWorkspaces }
  >();

  constructor(deps: SessionOrchestratorDeps) {
    this.deps = deps;
    this.ctx = deps.ctx;
    this.unsubscribe = deps.runner.onEvent((event) => this.handleRunnerEvent(event));
  }

  /** The member workspaces of the engine (PM-138); null: the engine has none, or is not connected. */
  private workspacesOf(engineId: EngineId): MemberWorkspaces | null {
    const engine = this.deps.engines.get(engineId);
    const manager = engine?.memberWorkspaces;
    if (!engine || !manager) return null;
    const known = this.workspaceSets.get(engineId);
    if (known && known.manager === manager) return known.workspaces;
    const workspaces = new MemberWorkspaces({
      ctx: this.ctx,
      manager,
      isRunning: (sessionId) => this.isRunning(sessionId),
      stop: (projectKey, sessionId) => this.stop(projectKey, sessionId),
      processExists: (pid) => engine.processExists(pid),
    });
    this.workspaceSets.set(engineId, { manager, workspaces });
    return workspaces;
  }

  /** The member workspaces of every engine that has them. */
  private allWorkspaces(): MemberWorkspaces[] {
    return this.deps.engines
      .ids()
      .map((id) => this.workspacesOf(id))
      .filter((w): w is MemberWorkspaces => w !== null);
  }

  /**
   * The member workspaces of the engine a session ran or runs on. While the engine is not connected
   * the set it had is used, so a session's end still releases its reservation.
   */
  private workspacesOfSession(session: Session): MemberWorkspaces | null {
    const engineId = engineIdOf(session);
    return this.workspacesOf(engineId) ?? this.workspaceSets.get(engineId)?.workspaces ?? null;
  }

  /**
   * The engine of the card (PM-311): the one its assignee's session runs on, else the one the
   * assignee starts on, else the local one. Where the task's branch is read and its worktrees go.
   */
  cardEngineId(projectKey: string, task: Task): EngineId {
    if (task.assignee) {
      const session = this.ctx.repos.sessions.findByWorkItem(projectKey, task.assignee, {
        type: 'task',
        taskKey: task.key,
      });
      if (session) return engineIdOf(session);
      return this.deps.engines.engineFor(projectKey, task.assignee) ?? LOCAL_ENGINE_ID;
    }
    return LOCAL_ENGINE_ID;
  }

  /** Wire the full-test policy into every session brief, including resumes. */
  useFullTests(fullTests: { runsFor(task: Task, config: ProjectConfig): boolean }): void {
    this.fullTests = fullTests;
  }

  private projectManagerStart?: (
    projectKey: string,
    handle: string,
    taskKey: string,
    cause?: SessionStartCause,
  ) => Promise<void>;

  useProjectManagerStarts(send: NonNullable<SessionOrchestrator['projectManagerStart']>): void {
    this.projectManagerStart = send;
  }

  /** Called after the session lock, including admission's running-session shortcut. */
  async notifyProjectManagerStart(
    projectKey: string,
    handle: string,
    requested: WorkItemRef,
    opts: EnsureSessionOptions,
    result: EnsureSessionResult,
  ): Promise<void> {
    if (requested.type !== 'task' || result.session.workItem.type !== 'general') return;
    if (opts.cause && ['message', 'mention', 'answer'].includes(opts.cause.kind)) return;
    if (result.started && result.messagesSent > 0) return;
    await this.projectManagerStart?.(projectKey, handle, requested.taskKey, opts.cause);
  }

  useQuotaRecovery(
    usage: Pick<PlanUsageCache, 'get' | 'invalidate'>,
    resume: (session: Session, stageId: string, after: 'quota' | 'login') => Promise<void>,
  ): void {
    this.quotaUsage = usage;
    this.quotaResume = resume;
  }

  observeProviderUsage(provider: AgentProvider, usage: PlanUsage | null): void {
    if (provider === 'nanogpt' && !this.quotaProbe)
      this.providerHolds.observed(provider, usage, this.ctx.now());
  }

  /** Persisted quota deferrals must check usage again before any restart-time inference. */
  restoreProviderQuota(): void {
    if (this.providerHolds.start('nanogpt', this.ctx.now())) this.quotaUsage?.invalidate();
  }

  /** Unknown quota holds retry only the read-only usage probe, never inference. */
  async refreshProviderQuota(): Promise<void> {
    if (this.providerHolds.check('nanogpt', this.ctx.now())?.kind !== 'unknown' || this.quotaProbe) return;
    const usage = (await this.quotaUsage?.get('nanogpt')) ?? null;
    this.providerHolds.observed('nanogpt', usage, this.ctx.now());
  }

  dispose(): void {
    this.unsubscribe();
    for (const timer of this.cleanupTimers) clearTimeout(timer);
    this.cleanupTimers.clear();
    for (const { timer } of this.finishingTurns.values()) clearTimeout(timer);
    this.finishingTurns.clear();
    for (const { timer } of this.inputWaits.values()) clearTimeout(timer);
    this.inputWaits.clear();
  }

  /**
   * A session in `waiting_input` holds its messages back, and nothing in the app need show why:
   * after `inputStallMs` the owners are told (PM-199). The wait is timed from its first state event;
   * a repeated one (a new activity) does not restart it.
   */
  private watchInputWait(session: Session): void {
    const waiting = session.state === 'waiting_input';
    const current = this.inputWaits.get(session.id);
    if (!waiting) {
      if (current) clearTimeout(current.timer);
      this.inputWaits.delete(session.id);
      return;
    }
    const alerts = this.deps.inputStall;
    if (current || !alerts) return;
    const since = isoNow(this.ctx);
    const delay = this.deps.inputStallMs ?? INPUT_STALL_MS;
    const timer = setTimeout(() => {
      this.inputWaits.delete(session.id);
      // The wait may have ended some other way than a state event: nothing to say then.
      if (this.ctx.repos.sessions.get(session.id)?.state !== 'waiting_input') return;
      // A pause held the session: nobody is to blame for the wait, and `afterPause` watches it again.
      if (this.isPaused(session)) return;
      try {
        const item = alerts.raise(session.id, since, Math.max(1, Math.round(delay / 60_000)));
        if (item) this.ctx.logger.warn({ sessionId: session.id, since }, 'session waits for input unseen');
      } catch (err) {
        this.ctx.logger.warn({ err, sessionId: session.id }, 'input wait alert failed');
      }
    }, delay);
    timer.unref();
    this.inputWaits.set(session.id, { since, timer });
  }

  /** MCP: maps /mcp/:token to the calling session; null rejects the call. */
  resolveToken(token: string): ToolContext | null {
    return this.tokens.get(token) ?? null;
  }

  /** Egress proxy: maps a session's proxy credentials to that live session; null otherwise. */
  resolveEgressToken(token: string): ToolContext | null {
    return this.egressTokens.get(token) ?? null;
  }

  /** Whether the server runs behind the managed VM boundary. */
  private get managed(): boolean {
    return this.deps.runtimeBoundary?.mode === 'managed_vm';
  }

  /** A session of any project, or null. */
  find(sessionId: string): Session | null {
    return this.ctx.repos.sessions.get(sessionId);
  }

  get(projectKey: string, sessionId: string): Session {
    const session = this.find(sessionId);
    if (!session || session.projectKey !== projectKey) throw notFound('session', sessionId);
    return session;
  }

  list(projectKey: string, filter: { member?: string; taskKey?: string } = {}): Session[] {
    return this.ctx.repos.sessions.list(projectKey, filter);
  }

  isRunning(sessionId: string): boolean {
    try {
      return this.deps.runner.isRunning(sessionId);
    } catch {
      return false;
    }
  }

  /**
   * Whether the session was started with an opening input and its first turn has not begun: it is
   * about to work although its CLI may report `idle` meanwhile (counts against the member's capacity).
   */
  awaitsFirstTurn(sessionId: string): boolean {
    return this.awaitingFirstTurn.has(sessionId);
  }

  /** Whether text typed into the session has not started a turn yet (the runner still holds it). */
  hasPendingInput(sessionId: string): boolean {
    return this.deps.runner.hasPendingInput?.(sessionId) ?? false;
  }

  /** Running AI sessions with a turn in progress, across all projects. */
  busyCount(): number {
    return this.ctx.repos.sessions.listInStates(BUSY_SESSION_STATES).filter((s) => this.isRunning(s.id))
      .length;
  }

  /**
   * The member's running session for the work item, to type into. Not a review session whose round
   * is over (`MemberWorkspaces.isStale`): a start restarts that one on the new commit.
   */
  findRunning(projectKey: string, member: string, workItem: WorkItemRef): Session | null {
    const session = this.ctx.repos.sessions.findByWorkItem(projectKey, member, workItem);
    return session && this.isRunning(session.id) && !this.workspacesOfSession(session)?.isStale(session)
      ? session
      : null;
  }

  /**
   * A new review round is due (PM-138): the task entered a stage (every reviewer of it), or its
   * developer wrote to a reviewer (that one). Their next start pins the latest commit.
   */
  requestReviewRound(projectKey: string, taskKey: string, member?: string): void {
    for (const workspaces of this.allWorkspaces()) workspaces.requestReviewRound(projectKey, taskKey, member);
  }

  /**
   * The head of the branch the task's developer hands over, and whether their working directory
   * holds uncommitted work (PM-183): the member workspace's with member workspaces, else the task's
   * worktree. Null for a task without a repository or a branch, and when it cannot be read.
   */
  async sourceHead(
    config: ProjectConfig,
    task: Task,
    opts: { strict?: boolean } = {},
  ): Promise<SourceHead | null> {
    const repoName = effectiveRepo(config, task);
    if (!repoName) return null;
    try {
      const engineId = this.cardEngineId(config.project.key, task);
      const engine = this.deps.engines.get(engineId);
      if (!engine) {
        if (opts.strict)
          throw conflict('engine_offline', 'the card engine is not connected', { engine: engineId });
        return null;
      }
      const workspaces = this.workspacesOf(engineId);
      if (workspaces) return await workspaces.sourceHead(config, task);
      const found = await engine.worktrees.find({ project: config, repoName, taskKey: task.key });
      return found ? await engine.worktrees.head(found.path) : null;
    } catch (err) {
      if (opts.strict) throw err;
      this.ctx.logger.warn({ err, taskKey: task.key }, 'could not read the head of the task branch');
      return null;
    }
  }

  /**
   * The session's review round is over while it is still in a turn: messages for it wait instead of
   * reaching the old round, and it restarts on the new commit once it idles (see `handleRunnerEvent`).
   */
  reviewRoundDue(session: Session): boolean {
    return this.workspacesOfSession(session)?.roundDue(session) ?? false;
  }

  /** Admission: `workspace_busy` while another task's live session holds the member's workspace. */
  assertWorkspaceFree(config: ProjectConfig, member: AiMemberConfig, task: Task): void {
    const engineId = this.deps.engines.engineFor(config.project.key, member.handle);
    if (engineId) this.workspacesOf(engineId)?.check(config, member, task);
  }

  /**
   * Running -> reuse; exited -> resume the same conversation; none -> create (worktree or
   * workspace cwd, context pack, MCP token, runner.start). Only the AI master switch and the
   * member's leave apply here; automatic starts pass admission first.
   *
   * What the session gets as its first input: a new conversation, its brief; a resumed task
   * conversation, the message that caused the resume (`opts.message`) or else a short message
   * that it was restarted and should check where it left off (the context pack's continue
   * message), so it does not sit at its prompt. It goes on the command line where the agent CLI
   * takes a prompt there (Codex), and is typed once the CLI is ready otherwise.
   */
  async ensureSession(
    projectKey: string,
    handle: string,
    workItem: WorkItemRef,
    opts: EnsureSessionOptions = {},
  ): Promise<EnsureSessionResult> {
    const requested = workItem;
    const config = await this.deps.projects.config(projectKey);
    workItem = sessionWorkItemOf(requireAiMember(config, handle), workItem);
    const result = await this.locks.run(sessionLockKey(projectKey, handle, workItem), async () => {
      const config = await this.deps.projects.config(projectKey);
      const member = requireAiMember(config, handle);
      const task = workItem.type === 'task' ? this.deps.tasks.get(projectKey, workItem.taskKey) : null;
      const existing = this.ctx.repos.sessions.findByWorkItem(projectKey, handle, workItem);
      // A resumed conversation is told first who works on the card and what was asked (PM-249), except
      // a review session that restarts on a new commit: its message is the new round's.
      let announce = true;
      if (existing && this.isRunning(existing.id)) {
        if (!this.workspacesOfSession(existing)?.isStale(existing))
          return {
            session: existing,
            created: false,
            resumed: false,
            started: false,
            messagesSent: 0,
            firstInput: Promise.resolve(true),
          };
        // Its review round is over: no live process while the workspace moves to the new commit.
        // Not while paused: the start would be refused after the stop.
        assertNotPaused(this.ctx.repos.pauses, projectKey);
        this.stopReasons.set(existing.id, { kind: 'restart', restartFor: 'new_round' });
        await this.deps.runner.stop(existing.id);
        this.markEnded(existing.id, null);
        announce = false;
      }
      return this.start(
        config,
        member,
        workItem,
        task,
        existing,
        messagesForFirstInput(opts.messages),
        announce,
        null,
        opts.nudge ?? null,
        opts.cause ?? null,
        opts.pauseRestart ?? false,
      );
    });
    await this.notifyProjectManagerStart(projectKey, handle, requested, opts, result);
    return result;
  }

  /**
   * Stops a running task session and resumes its conversation at once, with `messages` as its first
   * input (PM-184: a review made against a description that has changed is worthless, and the reviewer
   * must not go on with it until its turn ends). The system prompt is built again. False, with nothing
   * stopped, when the session does not run or cannot restart now (AI work off, the member on leave).
   */
  async restartWithMessages(
    projectKey: string,
    sessionId: string,
    messages: string[],
    cause?: SessionStartCause,
  ): Promise<boolean> {
    const found = this.find(sessionId);
    if (!found || found.projectKey !== projectKey) return false;
    return this.locks.run(sessionLockKey(projectKey, found.member, found.workItem), async () => {
      const session = this.find(sessionId);
      if (!session || !this.isRunning(session.id)) return false;
      const config = await this.deps.projects.config(projectKey);
      const member = memberOf(config, session.member);
      if (!this.mayWorkNow(config, member)) return false;
      const task =
        session.workItem.type === 'task' ? this.deps.tasks.get(projectKey, session.workItem.taskKey) : null;
      this.stopReasons.set(session.id, { kind: 'restart', restartFor: 'description' });
      await this.deps.runner.stop(session.id);
      this.markEnded(session.id, null);
      await this.start(
        config,
        member,
        session.workItem,
        task,
        this.find(sessionId),
        messagesForFirstInput(messages),
        false,
        null,
        null,
        cause ?? null,
      );
      return true;
    });
  }

  /**
   * An owner sets the session's own permission settings (PM-170; the route checks the owner):
   * `null` goes back to the member's, which never changes. The approver applies to the next
   * question at once (`InboxService` reads it then). A new mode applies from the next start of the
   * process: a running session restarts with its conversation (`--resume`) once it is idle and no
   * message is on its way into it, so nothing it said or was told is lost. Until then messages for
   * it wait (`permissionRestartDue`). Each changed setting is recorded on the timeline.
   */
  async updatePermissions(
    projectKey: string,
    sessionId: string,
    req: UpdateSessionRequest,
    actor: Actor,
  ): Promise<Session> {
    const found = this.get(projectKey, sessionId);
    return this.locks.run(sessionLockKey(projectKey, found.member, found.workItem), async () => {
      const config = await this.deps.projects.config(projectKey);
      const member = requireAiMember(config, found.member);
      if (req.approver) {
        const blocker = approverBlocker(config, member.handle, req.approver);
        if (blocker)
          throw new DomainError(
            'approver_unavailable',
            `the approver ${req.approver} is not available: ${blocker}`,
            {
              status: 422,
              details: { blocker },
            },
          );
      }
      const before = this.get(projectKey, sessionId);
      const from = effectiveSessionPermissions(member, before);
      let session = this.ctx.repos.sessions.update(sessionId, {
        ...(req.permissionMode !== undefined ? { permissionModeOverride: req.permissionMode } : {}),
        ...(req.approver !== undefined ? { approverOverride: req.approver } : {}),
      })!;
      const to = effectiveSessionPermissions(member, session);
      const running = this.isRunning(sessionId);
      const restart = running && this.modeNeedsRestart(sessionId, to.permissionMode);
      const wasPending = Boolean(session.permissionRestartPending);
      if (running && wasPending !== restart)
        session = this.ctx.repos.sessions.update(sessionId, { permissionRestartPending: restart })!;
      // The mode went back to the one the process runs in: what waited for the restart goes in now.
      if (running && wasPending && !restart) void this.ctx.events.emit('session_input_released', session);
      const record = (
        field: 'mode' | 'approver',
        values: [string | null, string | null],
        sources: [string, string],
        extra: { restart?: true },
      ) => {
        if (values[0] === values[1] && sources[0] === sources[1]) return;
        this.deps.timeline.append({
          projectKey,
          taskKey: session.workItem.type === 'task' ? session.workItem.taskKey : null,
          sessionId,
          actor,
          type: 'session_permission_changed',
          data: {
            member: session.member,
            field,
            from: values[0],
            to: values[1],
            ...(sources[1] === 'member' ? { reset: true } : {}),
            ...extra,
          },
        });
      };
      if (req.permissionMode !== undefined)
        record(
          'mode',
          [from.permissionMode ?? null, to.permissionMode ?? null],
          [from.source.mode, to.source.mode],
          restart ? { restart: true } : {},
        );
      if (req.approver !== undefined)
        record('approver', [from.approver, to.approver], [from.source.approver, to.source.approver], {});
      this.publishSession(session);
      // The setting is saved either way: a restart that fails leaves the conversation for the next start.
      if (restart)
        await this.restartForPermissions(projectKey, sessionId).catch((err: unknown) =>
          this.ctx.logger.warn({ err, sessionId }, 'could not restart the session into its new mode'),
        );
      return this.get(projectKey, sessionId);
    });
  }

  /**
   * Messages for a running session that waits for its restart into a new permission mode are not
   * typed into the old process: it takes them after the restart (`session_started` delivers them).
   */
  permissionRestartDue(session: Session): boolean {
    return Boolean(this.find(session.id)?.permissionRestartPending) && this.isRunning(session.id);
  }

  /**
   * Whether the session's process runs in another mode than `mode`. Behind the managed VM profile
   * only `plan` makes a difference there (research only); every other mode runs question-free.
   */
  private modeNeedsRestart(sessionId: string, mode: string | undefined): boolean {
    if (!this.processModes.has(sessionId)) return false;
    const current = this.processModes.get(sessionId);
    if (this.ctx.repos.sessions.executionProfile(sessionId) === 'managed_vm')
      return (current === 'plan') !== (mode === 'plan');
    return (current ?? 'default') !== (mode ?? 'default');
  }

  /**
   * Restarts a session that waits for a new permission mode, if it is idle with nothing on its way
   * into it; otherwise its next idle moment does (`handleRunnerEvent`). The caller holds the
   * session's lock. Nothing restarts while AI work is off or the member is on leave: the process
   * keeps running in its mode until it ends, its next start takes the new one, and the messages
   * held for the restart are typed in now (they would otherwise wait for a restart that does not come).
   */
  private async restartForPermissions(projectKey: string, sessionId: string): Promise<void> {
    const ready = (s: Session | null): s is Session =>
      Boolean(
        s?.permissionRestartPending &&
        s.state === 'idle' &&
        this.isRunning(s.id) &&
        !this.deps.runner.hasPendingInput?.(s.id),
      );
    if (!ready(this.find(sessionId))) return;
    // Paused: the restart stays due, and `afterPause` takes it up again on resume.
    if (this.workPaused(projectKey)) return;
    const config = await this.deps.projects.config(projectKey);
    const session = this.find(sessionId);
    if (!ready(session)) return;
    const member = memberOf(config, session.member);
    if (this.workPaused(projectKey)) return;
    if (!this.mayWorkNow(config, member)) {
      const released = this.ctx.repos.sessions.update(session.id, { permissionRestartPending: false })!;
      this.publishSession(released);
      void this.ctx.events.emit('session_input_released', released);
      return;
    }
    const task = session.workItem.type === 'task' ? this.ctx.repos.tasks.get(session.workItem.taskKey) : null;
    const grantsLost = this.grantedForSession(session);
    const change = this.ctx.repos.timeline.latestForSession(
      projectKey,
      sessionId,
      'session_permission_changed',
    );
    this.stopReasons.set(session.id, { kind: 'restart', restartFor: 'permission' });
    await this.deps.runner.stop(session.id);
    this.markEnded(session.id, null);
    await this.start(
      config,
      member,
      session.workItem,
      task,
      this.find(sessionId),
      [],
      false,
      {
        grantsLost,
      },
      null,
      { kind: 'permission_change', by: change?.actor, eventId: change?.id },
    );
  }

  /**
   * Whether a session of `member` may be stopped and started again now: AI work is on, the member is
   * not on leave and the team is not paused. Checked before the stop, so that a refused restart
   * leaves the running session alone.
   */
  private mayWorkNow(config: ProjectConfig, member: MemberConfig | undefined): member is AiMemberConfig {
    return (
      member?.kind === 'ai' &&
      !isOnLeave(member) &&
      config.team.limits.aiEnabled &&
      !this.workPaused(config.project.key)
    );
  }

  /** The project's work is paused: its own pause or the instance's (PM-219). */
  private workPaused(projectKey: string): boolean {
    return isWorkPaused(this.ctx.repos.pauses.open(), projectKey);
  }

  /**
   * The session is held by a pause: it has an open pause row, or its project's work is paused (PM-219).
   * Nothing is typed into it, and it does not restart, compact or wake for a new round meanwhile.
   */
  isPaused(session: Pick<Session, 'id' | 'projectKey'>): boolean {
    return this.workPaused(session.projectKey) || this.ctx.repos.pauses.openSession(session.id) !== null;
  }

  /** A person allowed something "for this session" since the session's process started. */
  private grantedForSession(session: Session): boolean {
    const before = this.processGrants.get(session.id);
    return before !== undefined && this.sessionGrants(session) > before;
  }

  /** How many requests of the session a person allowed "for this session", ever. */
  private sessionGrants(session: Pick<Session, 'id' | 'projectKey'>): number {
    return this.ctx.repos.inbox
      .list(session.projectKey, { kind: 'permission', state: 'resolved' })
      .filter((item) => item.sessionId === session.id && item.resolution?.optionId === 'allow_session')
      .length;
  }

  /** Types text into a running session (queued by the runner until the session is idle). */
  typeInto(session: Session, text: string): Promise<void> {
    this.assertProviderCooldown(session.provider ?? DEFAULT_AGENT_PROVIDER);
    // The session is being closed (PM-288): the message stays waiting, and its wake-up resumes the session.
    if (this.closing.has(session.id)) throw new Error(`session ${session.id} is closing`);
    return this.deps.runner.sendUserMessage(session.id, text);
  }

  async memory(projectKey: string, handle: string): Promise<string> {
    requireAiMember(await this.deps.projects.config(projectKey), handle);
    return this.deps.memory.read(projectKey, handle);
  }

  /** Stops a session; `stop` is why (PM-288), recorded on the session and its `session_ended` event. */
  async stop(projectKey: string, sessionId: string, stop?: SessionStop): Promise<Session> {
    const session = this.get(projectKey, sessionId);
    this.dropPause(session);
    // The runner's exit event may end the session before this call does: it takes the reason from here.
    if (stop) this.stopReasons.set(session.id, stop);
    if (this.isRunning(session.id)) await this.deps.runner.stop(session.id);
    return this.markEnded(session.id, null, null, stop) ?? this.get(projectKey, sessionId);
  }

  // ---------------------------------------------------------------- closing idle sessions (PM-288)

  /**
   * Marks the session to close at its next idle moment (`SessionCloser.sessionIdle`): the member that
   * moved the card finishes its round first.
   */
  closeWhenIdle(session: Session, stop: SessionStop): void {
    this.closePending.set(session.id, stop);
  }

  /** Why the session is marked to close; undefined: it is not. */
  pendingClose(sessionId: string): SessionStop | undefined {
    return this.closePending.get(sessionId);
  }

  /**
   * The session is not to close after all (its member has a step on the card again). A compaction the
   * mark held back is looked at now: the session is idle, and it drops the compaction of a card that is
   * back in a stage its member works it in.
   */
  cancelClose(sessionId: string): void {
    if (!this.closePending.delete(sessionId)) return;
    const session = this.find(sessionId);
    if (session && this.ctx.repos.sessions.compaction(session.id).pending) this.compactWhenIdle(session);
  }

  /**
   * Closes the session if it does not work now, and says whether it did (null: it did not). Under the
   * session's lock, and checked again just before the stop: a message or an input that came meanwhile
   * keeps it open. The conversation stays: the next message, answer or hand-over resumes it.
   */
  close(projectKey: string, sessionId: string, stop: SessionStop): Promise<Session | null> {
    const found = this.find(sessionId);
    if (!found || found.projectKey !== projectKey) return Promise.resolve(null);
    return this.locks.run(sessionLockKey(projectKey, found.member, found.workItem), async () => {
      const session = this.find(sessionId);
      if (
        !session ||
        session.state !== 'idle' ||
        !this.isRunning(session.id) ||
        this.isPaused(session) ||
        this.awaitsFirstTurn(session.id) ||
        this.hasPendingInput(session.id)
      )
        return null;
      this.closing.add(session.id);
      this.stopReasons.set(session.id, stop);
      try {
        await this.deps.runner.stop(session.id);
      } catch (err) {
        this.ctx.logger.warn({ err, sessionId: session.id }, 'could not stop a session to close it');
      }
      return this.markEnded(session.id, null, null, stop) ?? this.find(session.id);
    });
  }

  /** A team message for the session's member and work item is not typed into it yet, a held one too. */
  messageWaiting(session: Session): boolean {
    const config = this.deps.projects.cachedConfig(session.projectKey);
    const member = config ? memberOf(config, session.member) : undefined;
    return this.ctx.repos.messages
      .pending(session.projectKey, session.member)
      .some((m) =>
        sameWorkItem(sessionWorkItemOf(member, messageRoute(m, session.member)), session.workItem),
      );
  }

  /**
   * A stop somebody meant (`stop`, `stopTask`, `stopMember`) lets a pause go of the session, also while
   * it is open: it is not started again on resume. Before the runner stops it, so that its exit is
   * not read as the process of a paused session ending.
   */
  private dropPause(session: Pick<Session, 'id' | 'projectKey'>): void {
    if (this.ctx.repos.pauses.closeSession(session.id, isoNow(this.ctx)))
      this.pauseDropped?.(session.projectKey);
  }

  private pauseDropped: ((projectKey: string) => void) | undefined;

  /** Tells the pause service that a stop closed a session's pause row (see `dropPause`). */
  onPauseDropped(listener: (projectKey: string) => void): void {
    this.pauseDropped = listener;
  }

  /**
   * A pause ended for the session (PM-219): what its idle moments held back while it lasted (a review
   * round to wake for, a restart into a new permission mode, a compaction, the watch of an input
   * wait) runs now.
   */
  afterPause(session: Session): void {
    const current = this.find(session.id);
    if (!current || ENDED.has(current.state) || !this.isRunning(current.id)) return;
    this.watchInputWait(current);
    this.wakeForNewRound(current);
    if (current.state !== 'idle') return;
    if (current.permissionRestartPending) this.restartWhenIdle(current);
    if (this.ctx.repos.sessions.compaction(current.id).pending) this.compactWhenIdle(current);
  }

  /** What a session that was cut at `point` is told when the pause ends (undefined: the builder has no text). */
  pauseNudge(point: PausePoint, tool: string | null, restarted: boolean): string | undefined {
    return this.deps.contextBuilder.pauseNudge?.({ point, tool, restarted });
  }

  /** Stops all live sessions for a cancelled task without cleaning up its worktrees. */
  async stopTask(
    projectKey: string,
    taskKey: string,
    stop: SessionStop,
    opts: { except?: string | null } = {},
  ): Promise<void> {
    for (const session of this.list(projectKey, { taskKey })) {
      // The member the card is handed over from (PM-342) keeps its session to write the handoff note.
      if (opts.except && session.member === opts.except) continue;
      if (LIVE_SESSION_STATES.includes(session.state) || this.isRunning(session.id)) {
        await this.stop(projectKey, session.id, stop);
      }
    }
  }

  async stopMember(projectKey: string, handle: string, stop?: SessionStop): Promise<void> {
    for (const session of this.ctx.repos.sessions.list(projectKey, { member: handle })) {
      this.dropPause(session);
      try {
        if (stop) this.stopReasons.set(session.id, stop);
        if (this.isRunning(session.id)) await this.deps.runner.stop(session.id);
      } catch (err) {
        this.ctx.logger.warn({ err, sessionId: session.id }, 'could not stop a session');
      }
      this.markEnded(session.id, null, null, stop);
    }
  }

  /**
   * Whether the session's conversation was written: its transcript is a file with content (PM-340).
   * Behind the VM boundary the worker owns its transcripts: only a real file in its home counts. A file
   * that cannot be checked counts as not written, as the CLI could hardly resume it.
   */
  async transcriptWritten(session: Session): Promise<boolean> {
    if (!session.transcriptPath) return false;
    const layout = this.managed ? this.deps.runtimeBoundary?.layout : null;
    try {
      return await this.deps.transcripts.hasContent(session.transcriptPath, {
        ...(layout ? { confineTo: layout.home(session.member) } : {}),
        ...engineOption(engineIdOf(session)),
      });
    } catch (err) {
      this.ctx.logger.warn({ err, sessionId: session.id }, 'could not check the transcript');
      return false;
    }
  }

  /**
   * What the session's transcript says about where its conversation stood (PM-342), as its provider wrote
   * it; null when there is no transcript or it cannot be read.
   */
  async transcriptSummary(session: Session): Promise<HandoffSummary | null> {
    if (!session.transcriptPath) return null;
    const layout = this.managed ? this.deps.runtimeBoundary?.layout : null;
    try {
      return await this.deps.transcripts.summary(session.transcriptPath, {
        provider: session.provider ?? DEFAULT_AGENT_PROVIDER,
        ...(layout ? { confineTo: layout.home(session.member) } : {}),
        ...engineOption(engineIdOf(session)),
      });
    } catch (err) {
      this.ctx.logger.warn({ err, sessionId: session.id }, 'could not summarize the transcript');
      return null;
    }
  }

  /** A closed handoff to the session's member, as the context pack tells it (PM-342). */
  private handoffTakeover(row: TaskHandoffRow, toProvider: AgentProvider): HandoffTakeover {
    return {
      handoffId: row.id,
      from: row.from,
      fromProvider: row.fromProvider,
      toProvider,
      endedAt: row.endedAt ?? row.startedAt,
      outcome: row.outcome === 'note' ? 'note' : 'fallback',
      ...(row.fallbackReason ? { fallbackReason: row.fallbackReason } : {}),
      note: row.note,
      branch: row.branch,
      lastCommit: row.lastCommit,
      uncommitted: row.uncommitted,
      summary: row.summary,
    };
  }

  /** The member's session took the handed-over card over (PM-342): the handoff is marked and the timeline says so. */
  private recordTakeover(row: TaskHandoffRow, session: Session, task: Task): void {
    this.ctx.repos.taskHandoffs.save({
      ...row,
      takenOverAt: isoNow(this.ctx),
      takenOverSessionId: session.id,
    });
    this.deps.timeline.append({
      projectKey: task.projectKey,
      taskKey: task.key,
      sessionId: session.id,
      actor: aiActor(session.member),
      type: 'task_handoff',
      data: {
        phase: 'taken_over',
        handoffId: row.id,
        from: row.from,
        to: row.to,
        fromProvider: row.fromProvider,
        toProvider: row.toProvider,
        sessionId: session.id,
      },
    });
  }

  /**
   * Why the new conversation of `existing` is not its old one (PM-342): the provider changed, the old
   * conversation is lost, or it ran elsewhere; with a summary of the old transcript. Null when a
   * conversation was never written (nothing was lost).
   */
  private async previousConversation(
    existing: Session,
    provider: AgentProvider,
    conversationLost: boolean,
    relocated: boolean,
  ): Promise<PreviousConversation | null> {
    const from = existing.provider ?? DEFAULT_AGENT_PROVIDER;
    const summarize = () => this.transcriptSummary(existing);
    if (existing.transcriptPath && from !== provider)
      return { reason: 'provider_changed', fromProvider: from, summary: await summarize(), lastNote: null };
    if (conversationLost) return { reason: 'lost', fromProvider: null, summary: null, lastNote: null };
    if (relocated && existing.transcriptPath)
      return { reason: 'relocated', fromProvider: null, summary: await summarize(), lastNote: null };
    return null;
  }

  /** The session with its chat, read from the transcript as its provider wrote it. */
  async detail(projectKey: string, sessionId: string): Promise<SessionDetail> {
    const session = this.get(projectKey, sessionId);
    let chat: ChatItem[] = [];
    if (session.transcriptPath) {
      // Behind the VM boundary the worker owns its transcripts: read only a real file in its home.
      const layout = this.managed ? this.deps.runtimeBoundary?.layout : null;
      try {
        chat = await this.deps.transcripts.read(session.transcriptPath, {
          provider: session.provider ?? DEFAULT_AGENT_PROVIDER,
          self: session.member,
          cwd: session.cwd,
          firstUserOrigin: openingTurnOrigin(session.workItem),
          ...(layout ? { confineTo: layout.home(session.member) } : {}),
          ...engineOption(engineIdOf(session)),
        });
      } catch (err) {
        this.ctx.logger.warn({ err, sessionId }, 'could not read the transcript');
      }
    }
    const task = session.workItem.type === 'task' ? this.ctx.repos.tasks.get(session.workItem.taskKey) : null;
    return { session, chat, task };
  }

  /**
   * Stage change listener for done tasks: after a short delay (so an in-flight tool result
   * still reaches the agent) the task's sessions stop and its clean worktrees are removed.
   * `mover` is the AI member that made the move: its session finishes the turn it is in first.
   */
  scheduleDoneCleanup(projectKey: string, taskKey: string, mover: string | null = null): void {
    const timer = setTimeout(() => {
      this.cleanupTimers.delete(timer);
      this.runDoneCleanup(projectKey, taskKey, mover);
    }, this.deps.doneCleanupDelayMs ?? DONE_TASK_CLEANUP_DELAY_MS);
    timer.unref();
    this.cleanupTimers.add(timer);
  }

  private runDoneCleanup(projectKey: string, taskKey: string, mover: string | null = null): void {
    this.cleanupDoneTask(projectKey, taskKey, { mover }).catch((err: unknown) =>
      this.ctx.logger.warn({ err, taskKey }, 'cleanup of a done task failed'),
    );
  }

  /**
   * Stops a done task's sessions and removes its worktrees unless they hold uncommitted or unpushed
   * work. The session of `mover` that is still in a turn (it moved the task, and its messages and
   * notes may follow) is left to finish it: the cleanup runs again when it is idle or ended, or
   * after `DONE_TASK_TURN_LIMIT_MS` (PM-190).
   */
  async cleanupDoneTask(
    projectKey: string,
    taskKey: string,
    opts: { mover?: string | null } = {},
  ): Promise<void> {
    const task = this.ctx.repos.tasks.get(taskKey);
    if (!task || task.projectKey !== projectKey || task.status !== 'done') return; // reopened meanwhile
    const sessions = this.ctx.repos.sessions.list(projectKey, { taskKey });
    let finishing = false;
    for (const session of sessions) {
      if (!this.isRunning(session.id)) continue;
      if (opts.mover && session.member === opts.mover && session.state !== 'idle') {
        this.finishTurnThenCleanUp(session, taskKey);
        finishing = true;
        continue;
      }
      const stop: SessionStop = { kind: 'card_done', taskKey };
      this.stopReasons.set(session.id, stop);
      try {
        await this.deps.runner.stop(session.id);
      } catch (err) {
        this.ctx.logger.warn({ err, sessionId: session.id }, 'could not stop a session');
      }
      this.markEnded(session.id, null, null, stop);
    }
    // The worktrees go once the finishing session is done with them too.
    if (finishing) return;
    // A member workspace outlives its tasks (PM-138): only per-task worktrees are removed.
    // Each is removed through the engine its session ran on.
    const worktrees = new Map<string, { engineId: EngineId; path: string }>();
    for (const s of sessions) {
      if (s.branch === null || this.workspacesOfSession(s)?.isWorkspacePath(s.cwd)) continue;
      worktrees.set(`${engineIdOf(s)}\0${s.cwd}`, { engineId: engineIdOf(s), path: s.cwd });
    }
    for (const { engineId, path } of worktrees.values()) {
      const engine = this.deps.engines.get(engineId);
      if (!engine) {
        this.ctx.logger.info({ path, taskKey, engineId }, 'worktree not removed: its engine is offline');
        continue;
      }
      try {
        const status = await engine.worktrees.status(path);
        if (status.dirty || status.unpushedCommits > 0) {
          this.ctx.logger.info({ path, taskKey, ...status }, 'keeping a worktree with local work');
          continue;
        }
        await engine.worktrees.remove({ path });
      } catch (err) {
        // Expected refusals (WorktreeError codes): local changes, a checkout we do not own.
        const code = errorCode(err);
        const expected = code !== null && KEPT_WORKTREE_CODES.has(code);
        this.ctx.logger[expected ? 'info' : 'warn']({ err, path, taskKey, code }, 'worktree not removed');
      }
    }
  }

  /** Waits for the session's turn to end (`turnEnded`), at most `DONE_TASK_TURN_LIMIT_MS`. */
  private finishTurnThenCleanUp(session: Session, taskKey: string): void {
    if (this.finishingTurns.has(session.id)) return; // the first deadline stands
    const timer = setTimeout(() => {
      this.ctx.logger.info({ sessionId: session.id, taskKey }, 'done task: the turn limit passed');
      this.turnEnded(session.id);
    }, this.deps.doneTurnLimitMs ?? DONE_TASK_TURN_LIMIT_MS);
    timer.unref();
    this.finishingTurns.set(session.id, { projectKey: session.projectKey, taskKey, timer });
    this.ctx.logger.info({ sessionId: session.id, taskKey }, 'done task: the mover finishes its turn first');
  }

  /** A finishing session is idle, ended or out of time: its done task is cleaned up now. */
  private turnEnded(sessionId: string): void {
    const finishing = this.finishingTurns.get(sessionId);
    if (!finishing) return;
    this.finishingTurns.delete(sessionId);
    clearTimeout(finishing.timer);
    this.runDoneCleanup(finishing.projectKey, finishing.taskKey);
  }

  /**
   * Config change listener: sessions of removed members and of members just sent on leave are
   * stopped (their conversations stay, so a call-back resumes them).
   */
  async handleConfigChange(change: ConfigChange): Promise<void> {
    if (!change.previous) return;
    const next = new Map(change.next.team.members.map((m) => [m.handle, m]));
    for (const m of change.previous.team.members) {
      if (m.kind !== 'ai') continue;
      const stays = next.get(m.handle);
      if (!stays || (isOnLeave(stays) && !isOnLeave(m)))
        await this.stopMember(change.projectKey, m.handle, {
          kind: !stays ? 'member_retired' : 'member_on_leave',
          by: change.actor,
        });
    }
  }

  /** Startup: sessions do not survive a restart (their conversations do, via --resume). */
  async reconcileAfterRestart(): Promise<void> {
    for (const session of this.ctx.repos.sessions.listInStates(LIVE_SESSION_STATES)) {
      if (this.isRunning(session.id)) continue;
      this.markEnded(session.id, null, null, { kind: 'server_restart' });
    }
    // No process of an earlier run survives: what is left of the session folders is removed (PM-268).
    for (const engineId of this.deps.engines.ids()) {
      const folders = this.deps.engines.get(engineId)?.sessionFolders;
      if (!folders) continue;
      try {
        const removed = await folders.sweep((id) => this.isRunning(id));
        if (removed.length > 0)
          this.ctx.logger.info({ count: removed.length }, 'removed old session folders');
      } catch (err) {
        this.ctx.logger.warn({ err, dir: folders.root }, 'could not sweep the session folders');
      }
    }
  }

  /** How many live sessions the database holds on the engine (PM-315, the engine's settings view). */
  liveOn(engineId: EngineId): number {
    return this.ctx.repos.sessions
      .listInStates(LIVE_SESSION_STATES)
      .filter((session) => engineIdOf(session) === engineId).length;
  }

  /**
   * A remote engine connected (PM-315), `reported` being the sessions it runs. Like after a restart, a
   * session this server believes live on it that the engine does not run is over (its process went with
   * the engine's restart); a session the engine runs that this server does not know, or has ended, is
   * stopped; and the engine's folders of other sessions are removed. A session whose start is still being
   * answered (`starting`) is neither. Run for every connect, a resumed link too: the engine may have
   * restarted in between. Safe to repeat.
   */
  async reconcileEngine(
    engineId: EngineId,
    reported: ReadonlySet<string>,
    starting: (sessionId: string) => boolean,
  ): Promise<void> {
    for (const session of this.ctx.repos.sessions.listInStates(LIVE_SESSION_STATES)) {
      if (engineIdOf(session) !== engineId || reported.has(session.id) || starting(session.id)) continue;
      this.markEnded(session.id, null, null, { kind: 'server_restart' });
    }
    for (const sessionId of reported) {
      const session = this.ctx.repos.sessions.get(sessionId);
      if (session && !ENDED.has(session.state)) continue;
      this.ctx.logger.warn(
        { engineId, sessionId },
        'stopping a session the engine runs that this server does not',
      );
      await this.deps.runner.stop(sessionId, { force: true }).catch((err: unknown) => {
        this.ctx.logger.warn({ err, engineId, sessionId }, 'could not stop an unknown session of an engine');
      });
    }
    const folders = this.deps.engines.get(engineId)?.sessionFolders;
    if (!folders) return;
    try {
      await folders.sweep((id) => reported.has(id) || starting(id));
    } catch (err) {
      this.ctx.logger.warn({ err, engineId }, 'could not sweep the session folders of the engine');
    }
  }

  /**
   * Records what the session's member says it does on its card (PM-238): only the latest is kept,
   * and it is published with the session. Nothing is written (false) unless the session has a live
   * process and is in a round: an idle or ended session has no work to describe.
   */
  setDoing(sessionId: string, doing: WorkDoing): boolean {
    const session = this.ctx.repos.sessions.get(sessionId);
    if (!session || session.state === 'idle' || ENDED.has(session.state) || !this.isRunning(sessionId))
      return false;
    this.publishSession(this.ctx.repos.sessions.update(sessionId, { doing })!);
    return true;
  }

  /** Starts the session's process; a member workspace it reserved is freed again when that fails. */
  private async start(
    config: ProjectConfig,
    member: AiMemberConfig,
    workItem: WorkItemRef,
    task: Task | null,
    existing: Session | null,
    messages: string[],
    announce: boolean,
    restart: PermissionRestart | null = null,
    nudge: string | null = null,
    cause: SessionStartCause | null = null,
    pauseRestart = false,
  ): Promise<EnsureSessionResult> {
    // A theme is not worked on: its description is written from the member's general chat.
    if (task && isTheme(task)) throw themeRefused(task.key, 'have a session');
    const sessionId = existing?.id ?? newId('ses');
    try {
      return await this.launch(
        config,
        member,
        workItem,
        task,
        existing,
        messages,
        announce,
        sessionId,
        restart,
        nudge,
        cause,
        pauseRestart,
      );
    } catch (err) {
      for (const workspaces of this.allWorkspaces()) workspaces.ended(sessionId);
      // A start that failed leaves no folder behind (PM-268).
      this.removeSessionFolderOf(sessionId);
      throw err;
    }
  }

  private async launch(
    config: ProjectConfig,
    member: AiMemberConfig,
    workItem: WorkItemRef,
    task: Task | null,
    existing: Session | null,
    messages: string[],
    announce: boolean,
    sessionId: string,
    restart: PermissionRestart | null,
    nudge: string | null,
    cause: SessionStartCause | null,
    pauseRestart: boolean,
  ): Promise<EnsureSessionResult> {
    // A standby copy (PM-143) never works: only one copy of an installation may start AI sessions.
    if (this.deps.standby)
      throw conflict(
        'instance_standby',
        'this instance is a standby copy: AI work runs only in the active one',
      );
    assertAiEnabled(config);
    assertNotPaused(this.ctx.repos.pauses, config.project.key);
    assertNotOnLeave(member);
    // The card is being handed over to the member (PM-342): it starts once the old assignee has handed over.
    const openHandoff = task ? this.ctx.repos.taskHandoffs.open(task.key) : null;
    if (openHandoff && handoffBlocksStart(openHandoff, member.handle))
      throw conflict(
        'task_handoff_open',
        `task ${task!.key} is being handed over from ${openHandoff.from} to ${member.handle}`,
        { taskKey: task!.key, from: openHandoff.from },
      );
    // A role that changes files works in the task's worktree: without a repository to make it in, it
    // would run in the workspace root, so the start is refused until a person chooses one.
    assertRepoChosen(config, member.role, task);
    const projectKey = config.project.key;
    const provider = member.provider ?? DEFAULT_AGENT_PROVIDER;
    if (
      (provider === 'gemini' || provider === 'nanogpt') &&
      (this.deps.executionProfile === 'managed_vm' || this.managed)
    )
      throw conflict('provider_unsupported', `${provider} is not supported in the managed VM profile yet.`, {
        provider,
        profile: 'managed_vm',
      });
    // The session's own permission settings, set by an owner, in place of the member's (PM-170):
    // a resume keeps them (same row), a new session has none. The member's stay as they are.
    const permissions = effectiveSessionPermissions(member, existing ?? {});
    const permissionMode = permissions.permissionMode ?? member.permissionMode;
    const acting: AiMemberConfig = { ...member, permissionMode, approver: permissions.approver };
    // The engine the session runs on (PM-311): every path, worktree and folder below is its. A start
    // is refused while it is not connected (admission makes it wait).
    const engineId = this.deps.engines.engineFor(projectKey, member.handle);
    const engine = engineId ? this.deps.engines.get(engineId) : null;
    if (!engineId || !engine)
      throw conflict(
        'engine_offline',
        engineId ? `engine ${engineId} is not connected` : 'there is no engine to start the session on',
        engineId ? { engine: engineId } : {},
      );
    const paths = engine.paths();
    const workspaces = this.workspacesOf(engineId);
    // Behind the VM boundary nothing starts while it does not hold (fail closed, PM-140).
    await this.assertBoundaryReady();
    // A CLI that is not logged in could only sit at its login screen: refuse before any work.
    await this.assertProviderReady(provider, member.handle, engineId);
    // The question-free profile starts only on a boundary proven right now (PM-141); the runner asks
    // again at the spawn. Nothing is prepared before the proof.
    const vm = await this.managedVmAttestation();
    // The project's working directory on the engine; null: the engine does not hold the project, so
    // the start waits like one for an engine that is not connected (never on the server's own path).
    const workspaceRoot = engine.workspacePath(projectKey);
    if (!workspaceRoot)
      throw conflict('engine_offline', `engine ${engineId} does not hold project ${projectKey}`, {
        engine: engineId,
      });
    let cwd = workspaceRoot;
    let branch: string | null = null;
    let additionalDirectories: string[] | undefined;
    // The repository the task's work happens in: its own, else the project's only one (see
    // `effectiveRepo`). Without one the session runs in the workspace root: a project without
    // repositories, or a role that only reads (the ones that change files were refused above).
    const repoName = effectiveRepo(config, task);
    let placed: WorktreeInfo | null = null;
    let ws: WorkspacePlacement | null = null;
    if (task && repoName && workspaces?.kindFor(config, member, task)) {
      // The member's own durable workspace (PM-138): reserved for this session, on the task's branch
      // or the handed-over commit under review.
      ws = await workspaces.prepare(config, member, task, sessionId);
      cwd = ws.info.path;
      branch = ws.checkout.branch;
      if (ws.binding.kind === 'work' && branch) {
        const github = repoOf(config, repoName)?.github;
        this.deps.tasks.addLink(
          projectKey,
          task.key,
          { kind: 'branch', ref: branch, ...(github ? { repo: github } : {}) },
          SYSTEM_ACTOR,
        );
      }
    } else if (this.managed) {
      // A worker reaches nothing outside its home: a session without a workspace runs in its own
      // directory there (a chat, a meeting, a reader), never in the project's checkout.
      cwd = await this.workerSessionDir(member.handle, projectKey);
    } else if (vm) {
      // The managed VM has no shared checkouts and no worktrees: a session without a repository to
      // work in has the member's own directory (`<workspaces>/<KEY>/<handle>/.home`).
      if (!engine.memberWorkspaces)
        throw conflict(MANAGED_VM_UNAVAILABLE, 'the managed VM profile needs member workspaces', {
          reason: 'no_member_workspaces',
        });
      cwd = await engine.memberWorkspaces.home({ projectKey, member: member.handle });
    } else if (task && repoName && usesWorktree(member.role, config)) {
      // Code-changing roles work in the task's own worktree and branch; others in the workspace.
      try {
        placed = await engine.worktrees.ensureForTask({
          project: config,
          repoName,
          taskKey: task.key,
          title: task.title,
        });
        cwd = placed.path;
        branch = placed.branch;
        // The shared git directory is not made writable: a sandboxed agent could plant hooks or
        // configuration there that run when the host uses git in that repository (PM-131).
      } catch (err) {
        throw new DomainError(
          'session_start_failed',
          `could not prepare the worktree: ${(err as Error).message}`,
          { status: 502, details: { stage: 'worktree', reason: errorCode(err) } },
        );
      }
      const github = repoOf(config, repoName)?.github;
      this.deps.tasks.addLink(
        projectKey,
        task.key,
        { kind: 'branch', ref: branch, ...(github ? { repo: github } : {}) },
        SYSTEM_ACTOR,
      );
    }
    if (this.managed || vm) {
      // A worker reads no other member's directory (docs/VM.md): nothing is added for readers.
    } else if (task && repoName && !ws && workspaces && sessionPolicyFor(member.role, config).readOnlyTools) {
      // A reader without a workspace of its own reads the developer's, while it is on this task.
      const readable = await workspaces.readableWork(config, task.key);
      if (readable) additionalDirectories = [readable];
    } else if (
      task &&
      repoName &&
      !ws &&
      !usesWorktree(member.role, config) &&
      sessionPolicyFor(member.role, config).readOnlyTools
    ) {
      try {
        const found = await engine.worktrees.find({
          project: config,
          repoName,
          taskKey: task.key,
        });
        if (found) additionalDirectories = [found.path];
      } catch (err) {
        this.ctx.logger.warn({ err, taskKey: task.key }, 'could not find the task worktree for review');
      }
    }
    // The conversation of an earlier start belongs to the directory it ran in. When the task's
    // worktree is somewhere else (the task had no repository then, or another one) it cannot carry on
    // there: the session starts a new conversation in the worktree instead of working elsewhere.
    // So does a conversation of an older generation of the member's workspace (made again or moved).
    // A conversation of the other execution profile is never resumed either (PM-141): its directory
    // and what it was allowed belong to that profile. It starts a new conversation where this
    // profile places it, and what it asked or was granted at the boundary under the old one is void.
    const profileChanged = Boolean(
      existing && this.ctx.repos.sessions.executionProfile(existing.id) !== (vm ? 'managed_vm' : 'legacy'),
    );
    // A conversation lives on the engine it ran on (PM-311): it cannot be resumed on another one.
    const engineChanged = Boolean(existing && engineIdOf(existing) !== engineId);
    const relocated = Boolean(
      existing &&
      (profileChanged ||
        engineChanged ||
        // The managed VM (and anything behind the VM boundary) always places the session itself: it
        // never goes back to where it ran.
        ((vm || this.managed) && path.resolve(existing.cwd) !== path.resolve(cwd)) ||
        ((placed || ws) && (path.resolve(existing.cwd) !== path.resolve(cwd) || ws?.newGeneration))),
    );
    if (existing && !relocated && !ws && !vm && !this.managed) {
      // Claude Code keeps conversations per working directory: resume where it started.
      cwd = existing.cwd;
      branch = existing.branch ?? branch;
    }

    const stage = task ? (stageOf(config, task.stageId) ?? null) : null;
    const memory = await this.deps.memory.read(projectKey, member.handle).catch((err: unknown) => {
      this.ctx.logger.warn({ err, member: member.handle }, 'could not read member memory');
      return '';
    });
    const { attachments, parentAttachments, attachmentRules, attachmentDirs } = await this.attachmentsFor(
      projectKey,
      member.handle,
      task,
    );
    const relatedSessions = task ? this.relatedSessions(projectKey, member.handle, task) : [];
    // Resume only a conversation that exists (the runner reported its transcript), that belongs to
    // the member's current provider and that ran where the session runs now. The reported path is not
    // proof (PM-340): the CLI writes the file after its first message, and cannot resume what it never
    // wrote. A session that never got its first round starts a new conversation.
    const resumable =
      !relocated &&
      Boolean(existing?.transcriptPath && (existing.provider ?? DEFAULT_AGENT_PROVIDER) === provider);
    const conversationLost = resumable && !(await this.transcriptWritten(existing!));
    const resume = resumable && !conversationLost;
    // A new conversation that replaces one that could not go on tells the member so (PM-342), with a
    // machine-made summary of the old transcript when it can be read.
    const previousConversation =
      !existing || resume
        ? null
        : await this.previousConversation(existing, provider, conversationLost, relocated);
    // The card handed over to this member, until a session of theirs takes it over (PM-342); a new
    // conversation also gets the card's latest handoff note, whoever wrote it.
    const takenHandoff =
      task && task.assignee === member.handle
        ? this.ctx.repos.taskHandoffs.untakenFor(task.key, member.handle)
        : null;
    const handoff = takenHandoff ? this.handoffTakeover(takenHandoff, provider) : null;
    let lastNoteId: string | undefined;
    if (previousConversation && task) {
      const note = this.ctx.repos.taskHandoffs.latestNote(task.key);
      if (note?.note && note.endedAt) {
        previousConversation.lastNote = { from: note.from, endedAt: note.endedAt, text: note.note };
        lastNoteId = note.id;
      }
    }
    // Who else works on the card and what was asked on it (PM-249): a new conversation gets the latest
    // questions, a resumed one those since it last ran.
    const cardWorkers = task ? this.cardWorkersFor(config, task, member.handle) : [];
    const cardQuestions = task
      ? this.deps.cardQuestions.list(projectKey, task.key, {
          limit: QUESTION_LIMIT,
          ...(resume && existing ? { since: existing.lastActivityAt } : {}),
        })
      : [];
    const relations = task ? this.deps.tasks.relationsOf(projectKey, task.key) : [];
    const themeCard = task?.themeKey ? this.deps.tasks.find(projectKey, task.themeKey) : null;
    const focus = this.focusFor(projectKey, task);
    // What a returning reviewer reviewed last (PM-213), named in the message that wakes it.
    const lastReviewedCommit = existing ? this.ctx.repos.sessions.reviewedCommit(existing.id) : null;
    const { userHome } = paths;
    const appHome = paths.home ?? undefined;
    const folders = engine.sessionFolders;
    // A Claude session of the legacy profile gets its own Claude Code temporary root (PM-353) when the
    // engine can make one; only then are the roots all Claude Code processes share closed to it (the
    // CLI itself still uses them otherwise). Every other provider closes them: its CLI does not.
    const claudeTmpRoots = paths.claudeTmpRoots;
    const claudeOwnTmp = provider === 'claude' && !vm && !this.managed && !!folders?.tmpRoot;
    const policy = buildSessionPolicy({
      config,
      role: member.role,
      task,
      permissionMode,
      deniedPaths: [
        ...sensitivePaths({ userHome, appHome }),
        ...(provider !== 'claude' || claudeOwnTmp ? claudeTmpRoots : []),
      ],
      outboundNetwork: outboundNetworkOf(member),
      placement: vm
        ? memberWorkspacePlacement(ws, cwd)
        : ws
          ? ws.placement
          : placed
            ? {
                kind: 'task_worktree',
                path: cwd,
                ...(placed.gitDir ? { gitDir: placed.gitDir } : {}),
                ...(placed.worktreeGitDir ? { worktreeGitDir: placed.worktreeGitDir } : {}),
              }
            : ({ kind: 'read_only', path: cwd } satisfies SessionPolicy['placement']),
      readableRoots: additionalDirectories,
      ...(attachmentDirs.length > 0 ? { readOnlyPaths: attachmentDirs } : {}),
      ...(vm ? { managedVm: { boundary: vm.profile } } : {}),
    });
    // A developer's npm cache and development data live in its own directory (PM-193).
    const memberDir =
      !vm && !this.managed && policy.access === 'task_worktree' && appHome
        ? await this.prepareMemberSandboxDir(engine, appHome, projectKey, member.handle)
        : undefined;
    const excludesFile = paths.gitExcludesFile;
    // A Claude session of the legacy profile gets its own folder and the browsers (PM-268), a Codex
    // session its own folder when its sandbox writes (PM-339): a read-only Codex sandbox takes no
    // writable root, and the mode changes only with a restart. Codex also needs the short TMPDIR
    // root: without it the shared `/tmp` stays open, so no folder either. The managed VM neither.
    const codexWrites =
      provider === 'codex' && policy.permissions.sandbox === 'workspace-write' && !!folders?.tmpRoot;
    const ownFolders = !vm && !this.managed && (provider === 'claude' || codexWrites);
    // A new path at every start: what an earlier run left running cannot use or pre-empt it.
    const sessionDir = ownFolders && folders ? folders.allocate(sessionId) : undefined;
    const tmpDir = (codexWrites || claudeOwnTmp) && sessionDir ? folders?.allocateTmp(sessionId) : undefined;
    const tmpBase = folders?.tmpRoot ? path.dirname(folders.tmpRoot) : undefined;
    const browsersDir = ownFolders ? (paths.browsersDir ?? undefined) : undefined;
    const sandbox =
      vm || this.managed
        ? undefined
        : sessionSandbox(policy, {
            userHome,
            ...(appHome ? { appHome } : {}),
            ...(sessionDir ? { sessionDir } : {}),
            ...(tmpDir ? { tmpDir, sharedTmpRoots: [...claudeTmpRoots, ...(tmpBase ? [tmpBase] : [])] } : {}),
            ...(browsersDir ? { browsersDir } : {}),
            ...(paths.heavyLockDir ? { heavyLockDir: paths.heavyLockDir } : {}),
            ...(repoName ? { defaultBranch: repoOf(config, repoName)?.defaultBranch } : {}),
            ...(memberDir ? { memberDir } : {}),
            ...(excludesFile ? { excludesFile } : {}),
            github: Boolean(repoOf(config, effectiveRepo(config, task))?.github),
            // A reader changes no checkout of the project or the installation (PM-188).
            readerDenyWrite: [
              workspaceRoot,
              ...[paths.home, paths.worktreesRoot, paths.workspacesRoot, paths.installDir].filter(
                (dir): dir is string => !!dir,
              ),
            ],
          });
    // The shared roots are closed in the policy already: a sandbox that dropped the session's own temporary
    // directory would leave the CLI on a root it can no longer reach. Only a programming error; no start.
    if (claudeOwnTmp && sandbox && sandbox.portable?.tmpDir !== tmpDir)
      throw new Error(`The sandbox of session ${sessionId} dropped its Claude Code temporary directory`);
    // The folder the sandbox kept and its root go into the policy: the adapter renders the file-tool
    // rules from it, and drops the legacy allow list beside a policy (PM-333).
    const sessionFolder = sandbox?.env?.[SESSION_DIR_VARIABLE];
    const startPolicy = withSessionFolders(
      policy,
      sessionFolder && folders ? { own: sessionFolder, root: folders.root } : undefined,
    );
    const pack = this.deps.contextBuilder.build({
      ...(task && this.fullTests?.runsFor(task, config) ? { serverFullTest: true } : {}),
      project: config,
      // The settings that apply to this session: the system prompt tells the agent who answers.
      member: acting,
      workItem,
      task,
      stage,
      timeline: task ? this.deps.timeline.list(projectKey, { taskKey: task.key, limit: 30 }) : [],
      team: this.deps.members.rosterFor(config),
      memory,
      sessionPolicy: startPolicy,
      ...(sandbox ? { sandbox } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(parentAttachments ? { parentAttachments } : {}),
      ...(relatedSessions.length > 0 ? { relatedSessions } : {}),
      ...(cardWorkers.length > 0 ? { cardWorkers } : {}),
      ...(cardQuestions.length > 0 ? { cardQuestions } : {}),
      ...(relations.length > 0 ? { relations } : {}),
      ...(themeCard
        ? {
            theme: {
              key: themeCard.key,
              title: themeCard.title,
              stageId: themeCard.stageId,
              status: themeCard.status,
            },
          }
        : {}),
      ...(focus ? { focus } : {}),
      ...(lastReviewedCommit ? { lastReviewedCommit } : {}),
      ...(previousConversation && task ? { previousConversation } : {}),
      ...(handoff ? { handoff } : {}),
    });

    // Configuration may change while login, worktree and memory preparation await I/O. So may the
    // task's repository: no live session holds it in place before the session is recorded below.
    const latestConfig = await this.deps.projects.config(projectKey);
    assertAiEnabled(latestConfig);
    assertNotPaused(this.ctx.repos.pauses, projectKey);
    assertNotOnLeave(memberOf(latestConfig, member.handle));
    if (task) {
      const latestTask = this.deps.tasks.get(projectKey, task.key);
      assertRepoChosen(latestConfig, member.role, latestTask);
      if ((placed || ws) && effectiveRepo(latestConfig, latestTask) !== repoName) {
        throw conflict(
          'session_start_failed',
          `the repository of task ${task.key} changed while the session was starting: start it again`,
          { taskKey: task.key },
        );
      }
    }
    try {
      await this.deps.runner.assertWorkspaceConfig?.({ provider, cwd, ...engineOption(engineId) });
    } catch (err) {
      if (errorCode(err) !== WORKSPACE_CODEX_CONFIG) throw err;
      const failure = err as Error & { details?: Record<string, unknown> };
      throw conflict(WORKSPACE_CODEX_CONFIG, failure.message, { ...failure.details, provider });
    }
    // Made now, before the process: Claude Code may not handle a write path that does not exist. A
    // failed start removes it (`start`); a restart's old folder was removed when its process ended.
    const sessionTmpDir = sandbox?.portable?.tmpDir;
    if (folders && (sessionFolder || sessionTmpDir))
      await this.prepareSessionFolder(folders, sessionId, sessionFolder, sessionTmpDir);
    // The temporary directory is not made by `preparePortablePaths`: a recursive mkdir takes a path
    // that exists (a link). `make` makes it new, with the folder.
    await this.preparePortablePaths(engine, sandbox?.portable?.allowWrite);
    if (sessionFolder && sandbox && policy.access === 'task_worktree') {
      const browsers = sandbox.env?.[BROWSERS_PATH_VARIABLE];
      this.screenshotScopes.set(sessionId, {
        cwd,
        sessionDir: sessionFolder,
        ...(browsers ? { browsersDir: browsers } : {}),
        sandbox: {
          allowWrite: [...sandbox.allowWrite],
          denyWrite: [...(sandbox.denyWrite ?? [])],
          denyRead: [...(sandbox.denyRead ?? [])],
          // The run reads the worktree it runs in, whatever the home's closure says.
          allowRead: [...new Set([cwd, ...(sandbox.allowRead ?? [])])],
        },
      });
    }
    const at = isoNow(this.ctx);
    // A conversation whose round ended while its session did not run is compacted before anything
    // else is typed (PM-213), if it is big: the wake-up messages and the continue message follow it.
    const owed = resume && existing ? this.ctx.repos.sessions.compaction(existing.id) : null;
    const compactInstruction = this.compactInstruction(provider);
    const compactFirst =
      owed?.pending && compactInstruction && (owed.contextTokens ?? 0) > COMPACT_MIN_CONTEXT_TOKENS
        ? compactInstruction
        : undefined;
    let session: Session;
    if (existing) {
      session = this.ctx.repos.sessions.update(existing.id, {
        state: 'starting',
        activity: null,
        stateSince: at,
        cwd,
        branch,
        engineId,
        lastActivityAt: at,
        endedAt: null,
        lastStop: null,
        ...(relocated || conversationLost ? { claudeSessionId: newUuid(), transcriptPath: null } : {}),
        // This start takes the session's current mode; the header says when it dropped grants.
        permissionRestartPending: false,
        permissionGrantsLost: restart?.grantsLost ?? false,
        // A session from before the measurement (PM-178) is counted from this resume on.
        ...(existing.usage ? {} : { usageSince: at }),
      })!;
    } else {
      session = {
        id: sessionId,
        projectKey,
        member: member.handle,
        workItem,
        claudeSessionId: newUuid(),
        provider,
        cwd,
        branch,
        engineId,
        transcriptPath: null,
        state: 'starting',
        activity: null,
        stateSince: at,
        startedAt: at,
        lastActivityAt: at,
        endedAt: null,
      };
      this.ctx.repos.sessions.insert(session);
      session = this.ctx.repos.sessions.update(session.id, { usageSince: at })!;
    }
    if (profileChanged) {
      await this.deps.onExecutionProfileChange?.(projectKey, session.id).catch((err: unknown) => {
        this.ctx.logger.warn(
          { err, sessionId: session.id },
          'could not void the requests of the old profile',
        );
      });
    }
    const token = this.issueToken(session);
    const egressToken = this.managed ? this.issueEgressToken(session) : undefined;
    this.processProviders.set(session.id, provider);
    if (resume) this.resumingProcesses.add(session.id);
    // Before the process starts: Codex reports its first input as it starts.
    const firstInput = messages.length > 0 ? this.awaitFirstInput(session.id) : Promise.resolve(true);
    // A pause's nudge (PM-219) goes first on a resumed conversation: before the messages, or in place of
    // the continue message. A new conversation has nothing to be nudged about.
    const resumedInput = resume
      ? messages.length > 0
        ? [...(nudge ? [nudge] : []), ...messages].join(MESSAGE_SEPARATOR)
        : (nudge ?? (restart ? null : pack.continueMessage))
      : null;
    // A resumed conversation is told first about the card now (PM-249): who else works on it, and the
    // questions asked or answered since it last ran.
    const initialMessage = resume
      ? announce && pack.standing
        ? [pack.standing, resumedInput].filter((part) => part?.trim()).join(MESSAGE_SEPARATOR)
        : resumedInput
      : newConversationInput(pack.initialMessage, messages);
    if (initialMessage?.trim()) this.awaitingFirstTurn.add(session.id);

    try {
      const info = await this.deps.runner.start({
        sessionId: session.id,
        claudeSessionId: session.claudeSessionId,
        resume,
        cwd,
        engineId,
        member: member.handle,
        displayName: `${member.displayName} · ${workItemLabel(workItem, member)}`,
        model: member.model,
        effort: member.effort,
        // The member's value, else the project's, else the default (PM-212); on a resume too.
        autoCompactWindowTokens: autoCompactWindowOf(config.team.limits, member),
        // `--permission-mode` (Claude Code) and the `-c` settings (Codex) take it on a resume too.
        permissionMode,
        appendSystemPrompt: pack.appendSystemPrompt,
        // The cheap subagent (PM-179), on a resume too: the CLI takes its subagents per process.
        ...(pack.subagents.length > 0 ? { subagents: pack.subagents } : {}),
        // A resumed conversation has its brief already; it needs to know why it was woken: by the
        // messages that did it, else by the continue message. One that restarts into a new mode
        // (PM-170) was idle: it waits at its prompt, as it did, and its waiting messages are typed in
        // once it runs. A new conversation gets the messages after its brief, in full (PM-180):
        // typed in later they would wait for the end of its first turn.
        initialMessage,
        ...(compactFirst ? { compactFirst } : {}),
        firstUserOrigin: openingTurnOrigin(workItem),
        mcpUrl: `${this.deps.publicBaseUrl}${routes.mcp(token)}`,
        policy: startPolicy,
        // The managed VM profile (PM-141) hands the CLI no tool rules, no denied tools and no sandbox of
        // its own: the legacy ones below would put inner limits back (PM-134's sandbox included).
        allowedTools: vm ? [] : [...allowedToolsFor(member.role, config), ...attachmentRules.allow],
        deniedTools: vm ? [] : [...deniedToolsFor(config, task), ...attachmentRules.deny],
        additionalDirectories,
        // The CLI's own sandbox (decision 28): a developer's in its worktree, a reader's that writes
        // only the temp directory (PM-167). Behind the VM boundary the worker unit is the sandbox:
        // the CLI's own (bubblewrap) needs namespaces, which the unit does not allow.
        ...(sandbox ? { sandbox } : {}),
        provider,
        ...(egressToken ? { egressToken } : {}),
      });
      this.ctx.repos.sessions.setExecutionProfile(session.id, vm ? 'managed_vm' : 'legacy');
      // A new conversation owes and measures nothing yet. A resumed one that was asked to compact
      // keeps owing it until the runner reports it done or given up; one that owed it but is small
      // owes nothing any more.
      if (!resume) {
        this.ctx.repos.sessions.setCompactPending(session.id, false);
        this.ctx.repos.sessions.setContextTokens(session.id, null);
        this.ctx.repos.sessions.setReviewedCommit(session.id, null);
      } else if (!compactFirst) {
        this.ctx.repos.sessions.setCompactPending(session.id, false);
      }
      // The commit a reviewer works on this round: the next wake-up names it as the last reviewed.
      if (task?.reviewPin && task.assignee !== member.handle)
        this.ctx.repos.sessions.setReviewedCommit(session.id, task.reviewPin.commit);
      this.processModes.set(session.id, permissionMode);
      this.processGrants.set(session.id, this.sessionGrants(session));
      workspaces?.started(session.id, info.pid);
      const current = this.ctx.repos.sessions.get(session.id);
      if (current?.state === 'starting' && info.state !== 'starting') {
        this.ctx.repos.sessions.update(session.id, { state: info.state, stateSince: isoNow(this.ctx) });
      }
    } catch (err) {
      this.settleFirstInput(session.id, false);
      this.awaitingFirstTurn.delete(session.id);
      this.revokeToken(session.id);
      this.processProviders.delete(session.id);
      this.resumingProcesses.delete(session.id);
      this.processModes.delete(session.id);
      this.processGrants.delete(session.id);
      const failed = this.ctx.repos.sessions.update(session.id, {
        state: 'failed',
        stateSince: isoNow(this.ctx),
        endedAt: isoNow(this.ctx),
      });
      if (failed) {
        this.publishSession(failed);
        void this.ctx.events.emit('session_ended', failed);
      }
      this.recomputeMemberState(projectKey, member.handle);
      if (errorCode(err) === PROVIDER_NOT_LOGGED_IN) {
        const status = (err as { status?: { problem?: string; cliVersion?: string; minCliVersion?: string } })
          .status;
        throw providerNotLoggedIn(provider, { sessionId: session.id, ...status }, (err as Error).message);
      }
      if (
        [
          'nanogpt_key_missing',
          'nanogpt_setup_incomplete',
          'codex_setup_incomplete',
          'provider_unsupported',
        ].includes(errorCode(err) ?? '')
      ) {
        const failure = err as Error & {
          code:
            | 'nanogpt_key_missing'
            | 'nanogpt_setup_incomplete'
            | 'codex_setup_incomplete'
            | 'provider_unsupported';
          details?: Record<string, unknown>;
        };
        throw conflict(failure.code, failure.message, failure.details);
      }
      if (errorCode(err) === MANAGED_VM_UNAVAILABLE) {
        throw managedVmUnavailable(err, { sessionId: session.id });
      }
      if (errorCode(err) === WORKSPACE_CODEX_CONFIG) {
        const failure = err as Error & { details?: Record<string, unknown> };
        throw conflict(WORKSPACE_CODEX_CONFIG, failure.message, {
          ...failure.details,
          sessionId: session.id,
          provider,
        });
      }
      throw new DomainError(
        'session_start_failed',
        `could not start the session: ${(err as Error).message}`,
        {
          status: 502,
          details: { sessionId: session.id },
        },
      );
    }

    this.deps.timeline.append({
      projectKey,
      taskKey: task?.key ?? null,
      sessionId: session.id,
      actor: aiActor(member.handle),
      type: 'session_started',
      data: { member: member.handle, resumed: resume, ...(cause ? { cause } : {}) },
    });
    this.ctx.repos.sessions.update(session.id, { startCause: cause });
    if (previousConversation && task) {
      this.deps.timeline.append({
        projectKey,
        taskKey: task.key,
        sessionId: session.id,
        actor: SYSTEM_ACTOR,
        type: 'session_conversation_restarted',
        data: {
          member: member.handle,
          reason: previousConversation.reason,
          ...(previousConversation.fromProvider
            ? { fromProvider: previousConversation.fromProvider, toProvider: provider }
            : {}),
          summary: previousConversation.summary !== null,
          ...(previousConversation.lastNote && lastNoteId ? { lastHandoffId: lastNoteId } : {}),
        },
      });
    }
    if (takenHandoff && task) this.recordTakeover(takenHandoff, session, task);
    const fresh = this.ctx.repos.sessions.get(session.id)!;
    this.publishSession(fresh);
    this.recomputeMemberState(projectKey, member.handle);
    void this.ctx.events.emit('session_started', fresh);
    // The card's other workers are told who joined (PM-249); a restart is not a joining.
    if (announce && !pauseRestart && workItem.type === 'task')
      void this.ctx.events.emit('task_session_joined', { session: fresh, resumed: resume, cause });
    return {
      session: fresh,
      created: !existing,
      resumed: resume,
      started: true,
      messagesSent: messages.length,
      firstInput,
    };
  }

  /**
   * What a screenshot run of the session needs (PM-351): its worktree, its own folder and the limits of
   * its sandbox. Undefined when the session has no folder of its own or does not work in a worktree.
   */
  screenshotScope(sessionId: string): ScreenshotScope | undefined {
    return this.screenshotScopes.get(sessionId);
  }

  /** The engine the session runs on (PM-311); the local one for an unknown session. */
  engineOf(sessionId: string): EngineId {
    const session = this.ctx.repos.sessions.get(sessionId);
    return session ? engineIdOf(session) : LOCAL_ENGINE_ID;
  }

  /**
   * `listener` is called with the id of a session whose folder is about to be removed (it ended, or its
   * start failed): a run that uses the folder stops first. Returns the function that removes it.
   */
  onFolderRemoved(listener: (sessionId: string) => void): () => void {
    this.folderListeners.add(listener);
    return () => this.folderListeners.delete(listener);
  }

  /**
   * The running sessions that work on the card now (PM-249): see `cardWorkerSessions` for who counts and
   * in which order.
   */
  cardWorkers(projectKey: string, task: Task, config: ProjectConfig): Session[] {
    const stage = stageOf(config, task.stageId);
    return cardWorkerSessions(
      stage && { kind: stage.kind, owners: stageOwners(config, stage) },
      task,
      this.ctx.repos.sessions.list(projectKey, { taskKey: task.key }),
    ).filter((s) => this.isRunning(s.id));
  }

  /**
   * The project's focus as the brief tells it (PM-437): the open items in order (closed ones keep
   * their numbers) and the place of the session's card; undefined when no item is open.
   */
  private focusFor(projectKey: string, task: Task | null): ContextFocus | undefined {
    const items = this.deps.projectFocus
      .get(projectKey)
      .items.flatMap<ContextFocus['items'][number]>((item, index) => {
        const card = this.deps.tasks.find(projectKey, item.key);
        return card && isOpenTask(card)
          ? [
              {
                position: index + 1,
                key: card.key,
                title: card.title,
                kind: isTheme(card) ? 'theme' : 'task',
              },
            ]
          : [];
      });
    if (items.length === 0) return undefined;
    const place = task ? (this.deps.projectFocus.places(projectKey).get(task.key) ?? null) : null;
    return { items, place };
  }

  /** The other members working on the card, as the member's brief names them (PM-249). */
  cardWorkersFor(config: ProjectConfig, task: Task, self: string): CardWorker[] {
    return this.cardWorkers(config.project.key, task, config)
      .filter((s) => s.member !== self)
      .map((s) => {
        const worker = memberOf(config, s.member);
        return {
          handle: s.member,
          displayName: worker?.displayName ?? s.member,
          role: worker?.kind === 'ai' ? roleLabel(worker.role, config.team.roles) : s.member,
          state: s.state,
          waitingPermission: this.waitingPermissionFor(config, s),
          ...(s.doing ? { doing: s.doing } : {}),
        };
      });
  }

  waitingPermissionFor(config: ProjectConfig, session: Session): CardWorker['waitingPermission'] {
    if (session.state !== 'waiting_permission') return undefined;
    const item = this.deps.inbox?.openPermissionOf(session.projectKey, session.id);
    return item
      ? {
          inboxItemId: item.id,
          deciders: permissionDecidersNow(config, item, this.ctx.now().getTime()),
          since: item.createdAt,
        }
      : undefined;
  }

  /**
   * The member's running sessions on the cards that belong with `task` (PM-184): its parent and its
   * subtasks (`TaskService.family`), and the cards on the prerequisite links, in both directions. A
   * card that belongs in several ways is named once, by the first. The task's own session is not one.
   */
  private relatedSessions(projectKey: string, member: string, task: Task): RelatedSession[] {
    const related = new Map<string, CardRelation>();
    for (const card of this.deps.tasks.family(projectKey, task.key))
      related.set(card.key, card.key === task.parentKey ? 'parent' : 'subtask');
    for (const link of task.links)
      if (link.kind === 'prerequisite' && !related.has(link.ref)) related.set(link.ref, 'prerequisite');
    for (const card of this.deps.tasks.list(projectKey))
      if (
        !related.has(card.key) &&
        card.links.some((link) => link.kind === 'prerequisite' && link.ref === task.key)
      )
        related.set(card.key, 'prerequisite_of');
    const found: RelatedSession[] = [];
    for (const [taskKey, relation] of related) {
      if (taskKey === task.key) continue;
      const card = this.deps.tasks.find(projectKey, taskKey);
      const session = card && this.findRunning(projectKey, member, { type: 'task', taskKey });
      if (card && session) found.push({ taskKey, title: card.title, relation, state: session.state });
    }
    return found;
  }

  /** A promise for the session's first input: see `EnsureSessionResult.firstInput`. */
  private awaitFirstInput(sessionId: string): Promise<boolean> {
    this.settleFirstInput(sessionId, false);
    return new Promise<boolean>((resolve) => this.firstInputWaiters.set(sessionId, resolve));
  }

  private settleFirstInput(sessionId: string, typed: boolean): void {
    const settle = this.firstInputWaiters.get(sessionId);
    this.firstInputWaiters.delete(sessionId);
    settle?.(typed);
  }

  /** The attachments of a card the member may read (empty when it may not, or on a failure). */
  private async readableAttachments(
    projectKey: string,
    taskKey: string,
    handle: string,
  ): Promise<Attachment[]> {
    return (
      (await this.deps.attachments?.list(projectKey, taskKey, aiActor(handle)).catch((err: unknown) => {
        this.ctx.logger.warn({ err, taskKey }, 'could not list the task attachments');
        return undefined;
      })) ?? []
    );
  }

  /**
   * A task session's attachments: the list for its brief, and the task's attachment directory,
   * which it reads (never edits) without asking: in the session policy as a read-only path, and as
   * rules for sessions without a policy. Only that one directory: not the other tasks' ones, nor
   * the rest of the server's home, and only when it can be written as a plain rule path. A failure
   * leaves the session without them. A subtask also gets its direct parent's files and directory
   * (PM-228): the brief names them, so they open without asking too.
   */
  private async attachmentsFor(
    projectKey: string,
    handle: string,
    task: Task | null,
  ): Promise<{
    attachments: Attachment[];
    parentAttachments: { taskKey: string; attachments: Attachment[] } | null;
    attachmentRules: { allow: string[]; deny: string[] };
    attachmentDirs: string[];
  }> {
    if (!task)
      return {
        attachments: [],
        parentAttachments: null,
        attachmentRules: attachmentToolRules(null),
        attachmentDirs: [],
      };
    const attachments = await this.readableAttachments(projectKey, task.key, handle);
    const parentKey =
      task.parentKey && this.deps.tasks.find(projectKey, task.parentKey) ? task.parentKey : null;
    const parentFiles = parentKey ? await this.readableAttachments(projectKey, parentKey, handle) : [];
    const rules = { allow: [] as string[], deny: [] as string[] };
    const dirs: string[] = [];
    for (const key of parentKey ? [task.key, parentKey] : [task.key]) {
      const dir =
        (await this.deps.attachmentDirectory?.(projectKey, key).catch((err: unknown) => {
          this.ctx.logger.warn({ err, taskKey: key }, 'could not find the task attachment directory');
          return undefined;
        })) ?? null;
      const dirRules = attachmentToolRules(dir);
      // The rules are empty when the directory cannot be a plain rule path; then it is not granted.
      if (dir && dirRules.allow.length > 0) {
        dirs.push(dir);
        rules.allow.push(...dirRules.allow);
        rules.deny.push(...dirRules.deny);
      }
    }
    return {
      attachments,
      parentAttachments:
        parentKey && parentFiles.length > 0 ? { taskKey: parentKey, attachments: parentFiles } : null,
      attachmentRules: rules,
      attachmentDirs: dirs,
    };
  }

  /**
   * Behind the managed VM boundary: `runtime_boundary_not_ready` (503) unless a current readiness
   * report passed and the launcher and the egress proxy answer. No other kind of start is offered.
   */
  private async assertBoundaryReady(): Promise<void> {
    const boundary = this.deps.runtimeBoundary;
    if (boundary?.mode !== 'managed_vm') return;
    const status = await boundary.status();
    if (!status.ready)
      throw new DomainError('runtime_boundary_not_ready', 'the VM boundary is not ready; no session starts', {
        status: 503,
        details: { problems: status.problems },
      });
  }

  /**
   * The member's sandbox directory with its npm cache and development data, made if missing on the
   * session's engine (PM-193); the git settings in it are written at every start (PM-216).
   */
  private async prepareMemberSandboxDir(
    engine: EngineHost,
    appHome: string,
    projectKey: string,
    handle: string,
  ): Promise<string> {
    const dir = memberSandboxDir(appHome, projectKey, handle);
    try {
      await engine.prepareMemberSandboxDir(dir);
    } catch (err) {
      throw new DomainError(
        'session_start_failed',
        `could not prepare the member's sandbox directory: ${(err as Error).message}`,
        { status: 502, details: { stage: 'member_sandbox_dir', reason: errorCode(err) } },
      );
    }
    return dir;
  }

  /**
   * The session's own folder (PM-268) and, for Codex, its temporary directory (PM-339), made before
   * its process starts. A path that exists already stops the start.
   */
  private async prepareSessionFolder(
    folders: EngineSessionFolders,
    sessionId: string,
    dir: string | undefined,
    tmpDir?: string,
  ): Promise<void> {
    try {
      // The folder an earlier run of this session had goes first (see `removeSessionFolderOf`).
      await this.folderRemovals.get(sessionId);
      await folders.make(sessionId, dir, tmpDir);
    } catch (err) {
      throw new DomainError(
        'session_start_failed',
        `could not prepare the session folder: ${(err as Error).message}`,
        { status: 502, details: { stage: 'session_folder', reason: errorCode(err) } },
      );
    }
  }

  /**
   * The writable paths a CLI with a sandbox of its own takes from ours (`AgentSandbox.portable`,
   * PM-346), made before its process starts so it gets an existing path. A failure is logged: the
   * start goes on.
   */
  private async preparePortablePaths(
    engine: EngineHost,
    paths: readonly string[] | undefined,
  ): Promise<void> {
    if (paths?.length) await engine.preparePortablePaths(paths);
  }

  /**
   * Removes the session's folder (PM-268), on whichever engine holds it: a session's folder is on the
   * engine it ran on, and nothing elsewhere. The removal starts at once and is tracked
   * (`folderRemovals`): whoever makes the session's next folder (`prepareSessionFolder`) awaits it,
   * so a restart's new folder is made after the old one's removal. A failure is logged and never
   * stops the caller.
   */
  private removeSessionFolderOf(sessionId: string): void {
    this.screenshotScopes.delete(sessionId);
    for (const listener of this.folderListeners) {
      try {
        listener(sessionId);
      } catch (err) {
        this.ctx.logger.warn({ err, sessionId }, 'a listener of the session folder removal failed');
      }
    }
    const removals: Promise<void>[] = [];
    for (const engineId of this.deps.engines.ids()) {
      const folders = this.deps.engines.get(engineId)?.sessionFolders;
      if (!folders) continue;
      const failed = (err: unknown) =>
        this.ctx.logger.warn({ err, sessionId, engineId }, 'could not remove the session folder');
      try {
        removals.push(folders.remove(sessionId).catch(failed));
      } catch (err) {
        failed(err);
      }
    }
    if (removals.length === 0) return;
    // After an earlier removal of the same session that is still going, so the order is kept.
    const done = Promise.all([this.folderRemovals.get(sessionId), ...removals]).then(() => undefined);
    this.folderRemovals.set(sessionId, done);
    void done.then(() => {
      if (this.folderRemovals.get(sessionId) === done) this.folderRemovals.delete(sessionId);
    });
  }

  /** Resolves when every removal of a session folder that was started has finished (the server's stop, tests). */
  async settleFolderRemovals(): Promise<void> {
    await Promise.all([...this.folderRemovals.values()]);
  }

  private async workerSessionDir(handle: string, projectKey: string): Promise<string> {
    const boundary = this.deps.runtimeBoundary!;
    const layout = boundary.layout!;
    const dir = layout.sessions(handle, projectKey);
    const made = await boundary
      .launcher!.run({
        member: handle,
        program: 'mkdir',
        args: ['-p', '-m', '0750', '--', dir],
        cwd: layout.home(handle),
      })
      .catch((err: unknown) => ({ exitCode: null, stderr: (err as Error).message }));
    if (made.exitCode !== 0)
      throw new DomainError(
        'session_start_failed',
        `could not prepare the session directory: ${made.stderr.slice(0, 200)}`,
        {
          status: 502,
          details: { stage: 'session_dir' },
        },
      );
    return dir;
  }

  private issueEgressToken(session: Session): string {
    this.revokeEgressToken(session.id);
    const token = newToken();
    this.egressTokens.set(token, {
      sessionId: session.id,
      projectKey: session.projectKey,
      member: session.member,
      taskKey: session.workItem.type === 'task' ? session.workItem.taskKey : null,
    });
    this.egressTokenBySession.set(session.id, token);
    return token;
  }

  private revokeEgressToken(sessionId: string): void {
    const token = this.egressTokenBySession.get(sessionId);
    if (token) this.egressTokens.delete(token);
    this.egressTokenBySession.delete(sessionId);
  }

  /**
   * The proof of the managed VM boundary for this start, or null in the legacy profile. A
   * `managed_vm` installation without a boundary, or whose boundary does not verify, refuses the
   * start (`managed_vm_unavailable`): the profile is never entered on a flag.
   */
  private async managedVmAttestation(): Promise<ManagedVmAttestation | null> {
    if ((this.deps.executionProfile ?? 'legacy') !== 'managed_vm') return null;
    const boundary = this.deps.managedVm;
    if (!boundary)
      throw conflict(MANAGED_VM_UNAVAILABLE, 'this installation has no verified managed VM boundary', {
        reason: 'no_boundary',
      });
    try {
      return await boundary.verify();
    } catch (err) {
      throw managedVmUnavailable(err);
    }
  }

  /**
   * Throws `provider_not_logged_in` when the runner knows the provider's CLI is not logged in. A
   * status that cannot be checked (`loggedIn: null`, or the check failing) holds nothing back.
   */
  async assertProviderReady(provider: AgentProvider, member: string, engineId?: EngineId): Promise<void> {
    let status;
    try {
      status = await this.deps.runner.providerStatus?.(provider, {
        member,
        ...(engineId ? engineOption(engineId) : {}),
      });
    } catch (err) {
      this.ctx.logger.warn({ err, provider }, 'could not check the provider login');
    }
    if (status?.loggedIn === false) {
      throw providerNotLoggedIn(
        provider,
        {
          method: status.method,
          problem: status.problem,
          cliVersion: status.cliVersion,
          minCliVersion: status.minCliVersion,
        },
        status.detail,
      );
    }
    await this.refreshProviderQuota();
    this.assertProviderCooldown(provider);
  }

  assertProviderCooldown(provider: AgentProvider): void {
    const hold = this.providerHolds.check(provider, this.ctx.now());
    if (hold)
      throw conflict('provider_rate_limited', 'Provider request limit reached', {
        provider,
        until: hold.until?.toISOString() ?? null,
        kind: hold.kind,
      });
  }

  private issueToken(session: Session): string {
    this.revokeToken(session.id);
    const token = newToken();
    this.tokens.set(token, {
      sessionId: session.id,
      projectKey: session.projectKey,
      member: session.member,
      taskKey: session.workItem.type === 'task' ? session.workItem.taskKey : null,
    });
    this.tokenBySession.set(session.id, token);
    return token;
  }

  private revokeToken(sessionId: string): void {
    const token = this.tokenBySession.get(sessionId);
    if (token) this.tokens.delete(token);
    this.tokenBySession.delete(sessionId);
    this.revokeEgressToken(sessionId);
  }

  /**
   * Marks a live session as ended (exit, stop, retire); returns the updated row or null if it
   * had ended. `reason` (e.g. a lost login) stays as the session's activity.
   */
  private markEnded(
    sessionId: string,
    exitCode: number | null,
    reason: string | null = null,
    stop?: SessionStop,
  ): Session | null {
    const session = this.ctx.repos.sessions.get(sessionId);
    const failed = exitCode !== null && exitCode !== 0;
    // A session a pause held ends as paused, unless it failed; the other ends without a reason are PM-274's.
    const why =
      stop ??
      this.stopReasons.get(sessionId) ??
      (session && !failed && this.isPaused(session)
        ? ({ kind: 'pause' } as const)
        : ({ kind: failed ? (reason ? 'login_lost' : 'failed') : 'exited' } as const));
    // A resumed conversation whose CLI failed before it was ready cannot be resumed (PM-340): the next
    // start begins a new conversation, so it does not fail again and again with the same resume.
    const resumeFailed =
      failed && session?.state === 'starting' && this.resumingProcesses.has(sessionId) && !stop;
    this.resumingProcesses.delete(sessionId);
    this.lostLogins.delete(sessionId);
    this.stopReasons.delete(sessionId);
    this.closePending.delete(sessionId);
    this.closing.delete(sessionId);
    this.settleFirstInput(sessionId, false);
    this.awaitingFirstTurn.delete(sessionId);
    this.revokeToken(sessionId);
    this.removeSessionFolderOf(sessionId);
    this.processProviders.delete(sessionId);
    this.processModes.delete(sessionId);
    this.processGrants.delete(sessionId);
    this.turnEnded(sessionId);
    const wait = this.inputWaits.get(sessionId);
    if (wait) clearTimeout(wait.timer);
    this.inputWaits.delete(sessionId);
    if (!session || ENDED.has(session.state)) return null;
    const at = isoNow(this.ctx);
    const state: SessionState = failed ? 'failed' : 'exited';
    const ended = this.ctx.repos.sessions.update(sessionId, {
      state,
      activity: reason,
      stateSince: at,
      endedAt: at,
      lastActivityAt: at,
      // No process waits for a restart now: the next start takes the session's mode anyway.
      permissionRestartPending: false,
      doing: null,
      ...(why ? { lastStop: why } : {}),
      ...(resumeFailed ? { claudeSessionId: newUuid(), transcriptPath: null } : {}),
    })!;
    if (resumeFailed)
      this.ctx.logger.warn(
        { sessionId, member: ended.member, exitCode },
        'a resumed conversation exited before it was ready: the next start begins a new one',
      );
    this.workspacesOfSession(ended)?.ended(sessionId);
    this.deps.timeline.append({
      projectKey: ended.projectKey,
      taskKey: ended.workItem.type === 'task' ? ended.workItem.taskKey : null,
      sessionId,
      actor: aiActor(ended.member),
      type: 'session_ended',
      data: { member: ended.member, exitCode, ...(reason ? { reason } : {}), ...(why ? { stop: why } : {}) },
    });
    this.publishSession(ended);
    void this.ctx.events.emit('session_ended', ended);
    this.recomputeMemberState(ended.projectKey, ended.member);
    return ended;
  }

  private handleRunnerEvent(event: RunnerEvent): void {
    try {
      if (event.type === 'terminal_data') {
        this.ctx.bus.publish({ type: 'terminal_data', sessionId: event.sessionId, data: event.data });
        return;
      }
      const session = this.ctx.repos.sessions.get(event.sessionId);
      if (!session) {
        this.ctx.logger.warn(
          { sessionId: event.sessionId, type: event.type },
          'runner event for an unknown session',
        );
        return;
      }
      const at = isoNow(this.ctx);
      switch (event.type) {
        case 'first_input_sent': {
          this.settleFirstInput(session.id, true);
          return;
        }
        case 'state': {
          if (ENDED.has(event.state)) {
            const lostLogin = this.lostLogins.get(session.id);
            const ended = this.markEnded(session.id, event.state === 'failed' ? 1 : null, event.activity);
            if (ended && lostLogin && ended.lastStop?.kind === 'login_lost')
              void this.resumeAfterLoginLost(ended, lostLogin).catch((err: unknown) =>
                this.ctx.logger.error({ err, sessionId: session.id }, 'provider login deferral failed'),
              );
            return;
          }
          // A late event from a process that already ended must not revive the session.
          if (ENDED.has(session.state) && !this.isRunning(session.id)) return;
          if (event.state !== 'starting' && event.state !== 'idle') this.awaitingFirstTurn.delete(session.id);
          const updated = this.ctx.repos.sessions.update(session.id, {
            state: event.state,
            activity: event.activity,
            // The age of a state counts from the change, not from every tool the session runs.
            ...(event.state !== session.state ? { stateSince: at } : {}),
            lastActivityAt: at,
            // The round is over: its sentence does not belong to the next one (PM-238).
            ...(event.state === 'idle' ? { doing: null } : {}),
          })!;
          this.publishSession(updated);
          this.watchInputWait(updated);
          this.recomputeMemberState(session.projectKey, session.member);
          this.wakeForNewRound(updated);
          if (updated.state === 'idle' && session.state !== 'idle') {
            void this.ctx.events.emit('session_idle', updated);
          }
          if (updated.state === 'idle') this.turnEnded(updated.id);
          if (updated.state === 'idle' && updated.permissionRestartPending) this.restartWhenIdle(updated);
          if (updated.state === 'idle' && this.ctx.repos.sessions.compaction(updated.id).pending)
            this.compactWhenIdle(updated);
          return;
        }
        case 'transcript_path': {
          // The conversation at this path is the one the current process runs.
          const provider = this.processProviders.get(session.id) ?? session.provider;
          if (session.transcriptPath === event.path && session.provider === provider) return;
          this.publishSession(
            this.ctx.repos.sessions.update(session.id, { transcriptPath: event.path, provider })!,
          );
          return;
        }
        case 'chat': {
          this.ctx.repos.sessions.update(session.id, { lastActivityAt: at });
          this.ctx.bus.publish({
            type: 'chat_appended',
            projectKey: session.projectKey,
            sessionId: session.id,
            items: event.items,
          });
          return;
        }
        case 'exit': {
          this.markEnded(session.id, event.exitCode);
          return;
        }
        case 'provider_session_id': {
          // The CLI chose its own conversation id (Codex): keep it for resuming.
          if (session.claudeSessionId === event.providerSessionId) return;
          this.publishSession(
            this.ctx.repos.sessions.update(session.id, { claudeSessionId: event.providerSessionId })!,
          );
          return;
        }
        case 'compaction': {
          // The compaction the server asked for is over, or given up: it is not owed any more (PM-213).
          // What the conversation's context is, is measured again from its next step.
          if (event.phase === 'finished') this.ctx.repos.sessions.setContextTokens(session.id, null);
          if (event.requested && event.phase !== 'started')
            this.ctx.repos.sessions.setCompactPending(session.id, false);
          this.ctx.logger.info(
            { sessionId: session.id, phase: event.phase, trigger: event.trigger, requested: event.requested },
            'conversation compaction',
          );
          return;
        }
        case 'usage': {
          if (event.contextTokens !== undefined)
            this.ctx.repos.sessions.setContextTokens(session.id, event.contextTokens);
          if (event.entries.length === 0) return;
          // Counted at once (PM-178). During a turn the session's state changes carry the new sum to
          // the screens; once the turn is over (its last lines may come after the Stop), this does.
          this.ctx.repos.tokenUsage.add(
            {
              sessionId: session.id,
              projectKey: session.projectKey,
              member: session.member,
              taskKey: session.workItem.type === 'task' ? session.workItem.taskKey : null,
            },
            this.ctx.now(),
            event.entries,
          );
          // The warning limit (PM-187) only marks the session and tells the owners: it keeps running.
          let alerted = false;
          try {
            alerted = this.deps.usageAlerts?.check(session.id) != null;
          } catch (err) {
            this.ctx.logger.warn({ err, sessionId: session.id }, 'usage alert check failed');
          }
          if (session.state !== 'working' || alerted)
            this.publishSession(this.ctx.repos.sessions.get(session.id)!);
          return;
        }
        case 'auth_error': {
          this.lostLogins.set(session.id, event.provider);
          this.deps.onAuthError?.(session.projectKey, session.member, event.provider, engineIdOf(session));
          // The runner stops the session; its final state carries the message.
          this.ctx.logger.warn(
            { sessionId: session.id, provider: event.provider, message: event.message },
            'agent CLI lost its login',
          );
          return;
        }
        case 'rate_limited': {
          if (event.provider !== 'nanogpt') return;
          const started = this.providerHolds.start(event.provider, this.ctx.now());
          if (started) {
            this.quotaUsage?.invalidate();
            this.quotaProbe = Promise.resolve()
              .then(() => this.quotaUsage?.get('nanogpt') ?? null)
              .catch(() => null);
          }
          const stageId =
            session.workItem.type === 'task'
              ? this.ctx.repos.tasks.get(session.workItem.taskKey)?.stageId
              : undefined;
          // Persist the continuation while the usage request is still pending: a restart
          // during its timeout must not lose the affected task's wake-up.
          if (stageId)
            void this.quotaResume?.(session, stageId, 'quota').catch((err: unknown) =>
              this.ctx.logger.error({ err, sessionId: session.id }, 'provider quota deferral failed'),
            );
          void this.finishQuotaFailure(session, event.message, started, stageId).catch((err: unknown) =>
            this.ctx.logger.error({ err, sessionId: session.id }, 'provider quota recovery failed'),
          );
          return;
        }
      }
    } catch (err) {
      this.ctx.logger.error(
        { err, sessionId: event.sessionId, type: event.type },
        'runner event handling failed',
      );
    }
  }

  private async finishQuotaFailure(
    session: Session,
    message: string,
    started: boolean,
    stageId?: string,
  ): Promise<void> {
    const usage = await this.quotaProbe;
    if (started) {
      this.providerHolds.settle('nanogpt', usage, this.ctx.now());
      this.quotaProbe = null;
      const hold = this.providerHolds.check('nanogpt', this.ctx.now());
      const config = this.deps.projects.cachedConfig(session.projectKey);
      const owners = config ? ownerHandles(config) : [];
      if (owners.length > 0)
        this.deps.inbox?.create({
          projectKey: session.projectKey,
          kind: 'alert',
          assignees: owners,
          source: session.member,
          sessionId: session.id,
          taskKey: session.workItem.type === 'task' ? session.workItem.taskKey : null,
          title: 'NanoGPT request limit reached',
          payload: {
            alert: 'provider_rate_limited',
            provider: 'nanogpt',
            until: hold?.until?.toISOString() ?? null,
            weeklyPercent: usage?.weeklyPercent ?? null,
            message,
            workItem: session.workItem,
          },
          options: [ALERT_SEEN_OPTION],
        });
    }
    if (session.workItem.type === 'task' && stageId) await this.quotaResume?.(session, stageId, 'quota');
  }

  /**
   * A task's session ended because its CLI lost the provider login (PM-467). The login is checked
   * afresh: only a confirmed logout parks the task until the login is back (then admission resumes
   * it). A login the check still finds, or cannot judge, is not a reason to start again: the
   * server may refuse a login the CLI believes in, and every restart would fail the same way.
   */
  private async resumeAfterLoginLost(session: Session, provider: AgentProvider): Promise<void> {
    if (session.workItem.type !== 'task') return;
    const stageId = this.ctx.repos.tasks.get(session.workItem.taskKey)?.stageId;
    if (!stageId) return;
    let status;
    try {
      status = await this.deps.runner.providerStatus?.(provider, {
        member: session.member,
        refresh: true,
        ...engineOption(engineIdOf(session)),
      });
    } catch (err) {
      this.ctx.logger.warn({ err, sessionId: session.id, provider }, 'could not check the provider login');
    }
    if (status?.loggedIn !== false) {
      this.ctx.logger.warn(
        { sessionId: session.id, provider, loggedIn: status?.loggedIn ?? null },
        'the session lost its login but the provider is not confirmed logged out: no automatic resume',
      );
      return;
    }
    await this.quotaResume?.(session, stageId, 'login');
  }

  /**
   * A review session that finished its turn after its round ended, with messages that waited for
   * it (a re-review request): their wake-up restarts it on the new commit with them.
   */
  private wakeForNewRound(session: Session): void {
    if (session.workItem.type !== 'task' || !this.workspacesOfSession(session)?.isStale(session)) return;
    if (this.isPaused(session)) return;
    const workItem = session.workItem;
    const config = this.deps.projects.cachedConfig(session.projectKey);
    const first = this.ctx.repos.messages
      .pending(session.projectKey, session.member)
      .find(
        (m) =>
          sameWorkItem(
            sessionWorkItemOf(
              config ? memberOf(config, session.member) : undefined,
              messageRoute(m, session.member),
            ),
            workItem,
          ) &&
          !!config &&
          wakesFor(this.ctx, config, m, session.member),
      );
    if (!first) return;
    void this.ctx.events.emit('message_waiting', {
      projectKey: session.projectKey,
      handle: session.member,
      workItem: session.workItem,
      messageId: first.id,
    });
  }

  /** A session that waits for a new permission mode finished its turn: it restarts into it now. */
  private restartWhenIdle(session: Session): void {
    if (this.isPaused(session)) return;
    this.locks
      .run(sessionLockKey(session.projectKey, session.member, session.workItem), () =>
        this.restartForPermissions(session.projectKey, session.id),
      )
      .catch((err: unknown) =>
        this.ctx.logger.warn(
          { err, sessionId: session.id },
          'could not restart the session into its new mode',
        ),
      );
  }

  // ---------------------------------------------------------------- end-of-round compaction (PM-213)

  /** The text the compaction command takes, when sessions of this provider are compacted at all. */
  private compactInstruction(provider: AgentProvider | undefined): string | null {
    const instruction = this.deps.contextBuilder.compactInstruction;
    if (!instruction || !this.deps.runner.compact) return null;
    return COMPACTING_PROVIDERS.has(provider ?? DEFAULT_AGENT_PROVIDER) ? instruction : null;
  }

  /**
   * The card left a stage (`task_stage_changed`): the round of every member's session on it ends
   * when the card is no longer in a stage that member works it in, so that conversation owes a
   * compaction. A session in a turn is compacted once it idles, an idle one now; one that does not
   * run is compacted when it resumes (`start`). A member who works the card in the next stage as
   * well goes on in the same conversation, and a card that is done or cancelled needs nothing.
   */
  async roundEnded(task: Task): Promise<void> {
    if (!isOpenTask(task)) return;
    const config = await this.deps.projects.config(task.projectKey);
    for (const session of this.ctx.repos.sessions.list(task.projectKey, { taskKey: task.key })) {
      if (!this.compactInstruction(session.provider)) continue;
      if (isWorkingOnTask(config, task, session.member, 'idle')) continue;
      this.ctx.repos.sessions.setCompactPending(session.id, true);
    }
  }

  /**
   * Compacts the session now if it is idle, else its next idle moment does (`handleRunnerEvent`). Not
   * one marked to close (PM-288): its conversation is compacted when it resumes (`compactFirst`).
   */
  private compactWhenIdle(session: Session): void {
    if (session.state !== 'idle' || this.isPaused(session) || this.closePending.has(session.id)) return;
    this.locks
      .run(sessionLockKey(session.projectKey, session.member, session.workItem), () =>
        this.compactIdle(session.id),
      )
      .catch((err: unknown) =>
        this.ctx.logger.warn({ err, sessionId: session.id }, 'could not compact the session'),
      );
  }

  /**
   * Types the compaction command into an idle session whose round ended, unless something is on its
   * way into it: a message goes first, and the compaction waits for the session's next idle moment.
   * The caller holds the session's lock.
   */
  private async compactIdle(sessionId: string): Promise<void> {
    const ready = (s: Session | null): s is Session =>
      Boolean(
        s &&
        s.workItem.type === 'task' &&
        s.state === 'idle' &&
        this.isRunning(s.id) &&
        this.ctx.repos.sessions.compaction(s.id).pending &&
        !this.deps.runner.hasPendingInput?.(s.id) &&
        !this.messageWaiting(s),
      );
    if (!ready(this.find(sessionId))) return;
    const found = this.find(sessionId)!;
    const config = await this.deps.projects.config(found.projectKey);
    const session = this.find(sessionId);
    if (!ready(session) || session.workItem.type !== 'task') return;
    const instruction = this.compactInstruction(session.provider);
    if (!instruction) return;
    const task = this.deps.tasks.get(session.projectKey, session.workItem.taskKey);
    if (isWorkingOnTask(config, task, session.member, 'idle')) {
      // The card is back in a stage the member works it in: the conversation goes on with it.
      this.ctx.repos.sessions.setCompactPending(session.id, false);
      return;
    }
    if (!isOpenTask(task)) return;
    // A small conversation is not worth a summary (a just compacted one is small): nothing is owed.
    const { contextTokens } = this.ctx.repos.sessions.compaction(session.id);
    if ((contextTokens ?? 0) <= COMPACT_MIN_CONTEXT_TOKENS) {
      this.ctx.repos.sessions.setCompactPending(session.id, false);
      return;
    }
    const asked = await this.deps.runner.compact!(session.id, instruction);
    this.ctx.logger.info(
      { sessionId: session.id, taskKey: task.key, asked },
      asked ? 'compacting the conversation at the end of its round' : 'the compaction was not asked for',
    );
  }

  private publishSession(session: Session): void {
    this.ctx.bus.publish({ type: 'session_upserted', projectKey: session.projectKey, session });
  }

  /** An AI member's status follows its live sessions: waiting beats working beats idle. */
  private recomputeMemberState(projectKey: string, handle: string): void {
    const live = this.ctx.repos.sessions
      .list(projectKey, { member: handle })
      .filter((s) => !ENDED.has(s.state));
    const waiting = live.find((s) => s.state === 'waiting_permission' || s.state === 'waiting_input');
    const working = live.find((s) => s.state === 'working' || s.state === 'starting');
    let status: MemberStatus = 'idle';
    let activity: string | null = null;
    if (waiting) {
      status = 'waiting_for_human';
      activity = waiting.activity;
    } else if (working) {
      status = 'working';
      activity = working.activity;
    }
    this.deps.members.setState(projectKey, handle, status, activity);
  }
}
