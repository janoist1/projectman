import { wakesFor } from '../../core/messages';
import { assertIntegratorAccess, assertSuperMutation } from '../../kernel';
import { LIVE_SESSION_STATES, workMetadataAfterChat } from '@projectman/shared';
import type { EnsureSessionOptions, EnsureSessionResult } from '../../contracts';
import {
  approverBlocker,
  cardWorkerSessions,
  DEFAULT_AGENT_PROVIDER,
  LOCAL_ENGINE_ID,
  effectiveRepo,
  isMergeFixer,
  isMergeRunningFor,
  effectiveSessionPermissions,
  sessionApproverChangeRefusal,
  isOnLeave,
  isOperator,
  isTheme,
  roleBundle,
  isWorkPaused,
  memberOf,
  memberStorageHandle,
  permissionDecidersNow,
  messageRoute,
  sameWorkItem,
  sessionWorkItemOf,
  stageOf,
  stageOwners,
} from '@projectman/shared';
import type {
  Actor,
  AgentProvider,
  AiMemberConfig,
  ChatItem,
  EngineId,
  HandoffSummary,
  MemberConfig,
  MemberContextPreview,
  MemberHandle,
  MemberStatus,
  OperatorPreferenceData,
  PausePoint,
  PlanUsage,
  ProjectConfig,
  Session,
  SessionDetail,
  SessionState,
  SessionStop,
  Task,
  TaskKey,
  UpdateSessionRequest,
  WorkDoing,
  WorkItemRef,
} from '@projectman/shared';
import { GUIDE_TOPICS, openingTurnOrigin } from '../../contracts';
import type {
  AttachmentOperations,
  CardWorker,
  ContextPackBuilder,
  ContextPack,
  ContextPackInput,
  MemberMemoryStore,
  MemberWorkspaceManager,
  EngineDirectory,
  RunnerEvent,
  ScreenshotScope,
  SessionRunner,
  SessionCleanup,
  SourceHead,
  ToolContext,
  MemberAudience,
  TranscriptReader,
  VisibleTeamTools,
} from '../../contracts';
import { encodeWorkItem } from '../../db';
import { roleLabel } from '../../agent-text';
import { requireAiMember } from '../../core/members';
import { assertNotPaused } from '../admission';
import type { CardQuestions } from '../../core/inbox';
import { isoNow } from '../../core/base';
import type { DomainContext } from '../../core/base';
import { conflict, DomainError, forbidden, invalid, notFound } from '../../kernel';
import type { MemberService } from '../../core/members';
import type { ProjectFocusService } from '../../core/tasks';
import type { ConfigChange, ProjectService } from '../../core/projects';
import { RoundCompaction } from './compaction';
import { DoneCleanup } from './done-cleanup';
import { CleanupFailures } from './cleanup-failures';
import { DONE_TASK_CLEANUP_DELAY_MS, DONE_TASK_TURN_LIMIT_MS } from './session-policy';
import type { TaskService } from '../../core/tasks';
import type { TimelineService } from '../../core/timeline';
import type { InputStallAlerts } from '../watchers';
import type { UsageAlerts } from '../usage';
import type { PlanUsageCache } from '../usage';
import type { InboxService } from '../../core/inbox';
import { aiActor, KeyedMutex, newUuid } from '../../kernel';
import { MergeCardLock } from '../../kernel';
import { CloseStates } from './close-states';
import { SessionLifecycle } from './lifecycle';
import { MESSAGE_SEPARATOR, providerNotLoggedIn, SessionLauncher } from './launch';
import { INPUT_STALL_MS, InputWaits } from './input-waits';
import { LiveSessions } from './live-sessions';
import { LiveSessionSweep } from './live-reconcile';
import { ProviderLimits } from './provider-limits';
import { SessionTimers } from './session-timers';
import type { StartHolds } from './start-holds';
import { TurnFinishes } from './turn-finish';
import { MemberWorkspaces } from './workspaces';
import { engineIdOf, engineOption } from './engines';
import { memberAudience } from './audience';
import { SessionContextInput } from './context-input';

export { LIVE_SESSION_STATES } from '@projectman/shared';
/** A turn is in progress: these count against `maxConcurrentAi`. */
const BUSY_SESSION_STATES: SessionState[] = ['starting', 'working', 'waiting_permission'];
const ENDED = new Set<SessionState>(['exited', 'failed']);

export { MESSAGE_SEPARATOR } from './launch';
export { COMPACT_MIN_CONTEXT_TOKENS } from './compaction';

export type { EnsureSessionResult } from '../../contracts';

export type { SessionStartCause } from '@projectman/shared';
import type { SessionStartCause } from '@projectman/shared';

/**
 * The most message text a session takes in its first input: it may go on a command line (Codex),
 * which the system limits (about 128 KB for one argument). What is more is typed in after the
 * session started, as it is for a session that runs. A team message (at most 20 000 characters)
 * with its prefix fits.
 */
export const MAX_FIRST_INPUT_CHARS = 24_000;

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

export interface SessionOrchestratorDeps {
  mergeCards?: MergeCardLock;
  onAuthError?: (projectKey: string, handle: string, provider: AgentProvider, engineId: EngineId) => void;
  ctx: DomainContext;
  projects: ProjectService;
  tasks: TaskService;
  /** The project's focus (PM-437), named in the kick-off brief. */
  projectFocus: Pick<ProjectFocusService, 'get' | 'places'>;
  members: MemberService;
  /** Members whose starts a handle rename holds back (PM-1025). */
  startHolds?: Pick<StartHolds, 'assertFree'>;
  timeline: TimelineService;
  runner: SessionRunner;
  transcripts: TranscriptReader;
  contextBuilder: ContextPackBuilder;
  visibleTeamTools: VisibleTeamTools;
  /** The questions asked on a card, listed in the brief and in a resumed session's first message (PM-249). */
  cardQuestions: Pick<CardQuestions, 'list'>;
  memory: MemberMemoryStore;
  /** Server-side projection of approved shared data for internal general conversations only. */
  operatorKnowledge: {
    forConversation(
      projectKey: string,
      member: string,
      workItem: WorkItemRef,
      cause: SessionStartCause | null,
    ): Promise<ContextPackInput['operatorKnowledge']>;
  };
  /** Server-side selection of the current conversational partner's style only. */
  operatorPreferences: {
    forConversation(
      projectKey: string,
      member: string,
      workItem: WorkItemRef,
      cause: SessionStartCause | null,
    ): Promise<OperatorPreferenceData | undefined>;
  };
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
  /** A standby copy of the installation (`instance.json`): every session start is refused. */
  standby?: boolean;
  /** The warning limit of a session's tokens (PM-187), checked whenever its usage grows. */
  usageAlerts?: Pick<UsageAlerts, 'check'>;
  /** Quota alerts are raised once per shared-provider hold (PM-377). */
  inbox?: Pick<InboxService, 'create' | 'openPermissionOf'>;
  /** Tells the owners of a session that waits for input unseen (PM-199). */
  inputStall?: Pick<InputStallAlerts, 'raise'>;
  /** How long a session may wait for input before they are told (default `INPUT_STALL_MS`). */
  inputStallMs?: number;
}

/** One start, stop or settings change at a time per (member x work item). */
function sessionLockKey(projectKey: string, handle: string, workItem: WorkItemRef): string {
  const wi = encodeWorkItem(workItem);
  return `${projectKey}:${handle}:${wi.type}:${wi.ref}`;
}

/**
 * The lifecycle of AI sessions, one per (AI member x work item): starts, reuses and resumes
 * them through the runner, maps MCP tokens to tool contexts, and mirrors runner events into
 * the database, the event bus (clients) and the domain events (`session_started`,
 * `session_ended`). Admission (src/runtime/admission) decides whether an automatic start may
 * happen; team messages (src/core/messages) are typed in through `typeInto`.
 */
export class SessionOrchestrator {
  private readonly deps: SessionOrchestratorDeps;
  private fullTests: { runsFor(task: Task, config: ProjectConfig): boolean } | undefined;

  private readonly ctx: DomainContext;
  private readonly locks = new KeyedMutex();
  private readonly endingStates = new Map<string, { state: SessionState; activity: string | null }>();
  private scopeRetryRunning = false;
  private readonly cleanupFailures: CleanupFailures;
  private readonly mergeCards: MergeCardLock;
  /** What is held for each session's current process: tokens, first input, modes, stop reasons. */
  readonly live = new LiveSessions();
  /** The timers of the turn, input wait and cleanup parts (`session-timers.ts`). */
  private readonly timers: SessionTimers;
  /** The sessions that wait for input at their terminal (PM-199, `input-waits.ts`). */
  private readonly inputWaits: InputWaits;
  /** The compaction at the end of a round (PM-213, `compaction.ts`). */
  private readonly compaction: RoundCompaction;
  /** The sessions that moved their task to done in the middle of a turn (PM-190, `turn-finish.ts`). */
  private readonly turns: TurnFinishes;
  /** The cleanup of done tasks (`done-cleanup.ts`). */
  private readonly cleanup: DoneCleanup;
  /**
   * Where each session stands on closing (PM-288): marked, waiting for a fix, held by a heavy run,
   * closing. Only the `runtime/sessions` module uses it (`SessionCloser` reaches it through here).
   */
  readonly closeStates = new CloseStates();
  /** What a screenshot run of each live session with a folder in its worktree needs (PM-351). */
  private readonly screenshotScopes = new Map<string, ScreenshotScope>();
  /** Told when a session's folder is removed (the session ended), before it is (PM-351). */
  private readonly folderListeners = new Set<(sessionId: string) => void>();
  /** The removals of session folders that are going on, by session (see `removeSessionFolderOf`). */
  private readonly folderRemovals = new Map<string, Promise<void>>();
  /** The runner subscription, the background jobs and the shutdown of this manager (`lifecycle.ts`). */
  private readonly lifecycle: SessionLifecycle;
  /** Starts the sessions' processes (`launch.ts`). */
  private readonly launcher: SessionLauncher;
  private readonly contextInput: SessionContextInput;
  /** What the provider limits: token usage, the request quota and a lost login (`provider-limits.ts`). */
  private readonly limits: ProviderLimits;
  /** Compares live rows with the runner between restarts (`live-reconcile.ts`). */
  private readonly liveSweep: LiveSessionSweep;
  /** The member workspaces (PM-138) of each engine that has them, made when first used. */
  private readonly workspaceSets = new Map<
    EngineId,
    { manager: MemberWorkspaceManager; workspaces: MemberWorkspaces }
  >();

  constructor(deps: SessionOrchestratorDeps) {
    this.mergeCards = deps.mergeCards ?? new MergeCardLock();
    this.deps = deps;
    this.ctx = deps.ctx;
    this.liveSweep = new LiveSessionSweep({
      listLive: () => this.ctx.repos.sessions.listInStates(LIVE_SESSION_STATES),
      isRunning: (sessionId) => this.isRunning(sessionId),
      engineConnected: (engineId) => deps.engines.get(engineId) !== null,
      end: (sessionId) => {
        this.markEnded(sessionId, null, null, { kind: 'exited' });
      },
      now: () => this.ctx.now().getTime(),
      logger: this.ctx.logger,
    });
    this.cleanupFailures = new CleanupFailures(this.ctx);
    this.lifecycle = new SessionLifecycle({
      subscribe: () => deps.runner.onEvent((event) => this.handleRunnerEvent(event)),
      onClose: () => {
        this.timers.close();
        this.turns.dispose();
        this.inputWaits.dispose();
      },
    });
    this.timers = new SessionTimers(this.ctx.logger);
    this.turns = new TurnFinishes({
      logger: this.ctx.logger,
      timers: this.timers,
      limitMs: deps.doneTurnLimitMs ?? DONE_TASK_TURN_LIMIT_MS,
      cleanUp: (projectKey, taskKey) => this.cleanup.run(projectKey, taskKey),
    });
    this.cleanup = new DoneCleanup({
      ctx: this.ctx,
      engines: deps.engines,
      runner: deps.runner,
      timers: this.timers,
      turns: this.turns,
      delayMs: deps.doneCleanupDelayMs ?? DONE_TASK_CLEANUP_DELAY_MS,
      isRunning: (sessionId) => this.isRunning(sessionId),
      noteStop: (sessionId, stop) => this.live.stopReasons.set(sessionId, stop),
      markEnded: (sessionId, stop) => {
        this.markEnded(sessionId, null, null, stop);
      },
      inWorkspace: (session) => Boolean(this.workspacesOfSession(session)?.isWorkspacePath(session.cwd)),
      background: (job) => this.lifecycle.run(job),
    });
    this.inputWaits = new InputWaits({
      ctx: this.ctx,
      timers: this.timers,
      ...(deps.inputStall ? { alerts: deps.inputStall } : {}),
      stallMs: deps.inputStallMs ?? INPUT_STALL_MS,
      isPaused: (session) => this.isPaused(session),
    });
    this.compaction = new RoundCompaction({
      ctx: this.ctx,
      projects: deps.projects,
      tasks: deps.tasks,
      runner: deps.runner,
      contextBuilder: deps.contextBuilder,
      find: (sessionId) => this.find(sessionId),
      isRunning: (sessionId) => this.isRunning(sessionId),
      isPaused: (session) => this.isPaused(session),
      closePending: (sessionId) => this.closeStates.markOf(sessionId) !== undefined,
      messageWaiting: (session) => this.messageWaiting(session),
      underLock: (session, work) =>
        this.lifecycle.run(() =>
          this.locks.run(sessionLockKey(session.projectKey, session.member, session.workItem), work),
        ),
    });
    this.limits = new ProviderLimits({
      ctx: this.ctx,
      engines: deps.engines,
      projects: deps.projects,
      runner: deps.runner,
      ...(deps.usageAlerts ? { usageAlerts: deps.usageAlerts } : {}),
      ...(deps.inbox ? { inbox: deps.inbox } : {}),
      ...(deps.onAuthError ? { onAuthError: deps.onAuthError } : {}),
      publish: (session) => this.publishSession(session),
      background: (job) => this.lifecycle.run(job),
    });
    this.contextInput = new SessionContextInput(deps, {
      fullTests: () => this.fullTests,
      findRunning: (projectKey, member, workItem) => this.findRunning(projectKey, member, workItem),
      cardWorkersFor: (config, task, self) => this.cardWorkersFor(config, task, self),
    });
    this.launcher = new SessionLauncher(deps, {
      live: this.live,
      mergeCards: this.mergeCards,
      screenshotScopes: this.screenshotScopes,
      contextInput: this.contextInput,
      workspacesOf: (engineId) => this.workspacesOf(engineId),
      allWorkspaces: () => this.allWorkspaces(),
      publishSession: (session) => this.publishSession(session),
      recomputeMemberState: (projectKey, handle) => this.recomputeMemberState(projectKey, handle),
      sessionGrants: (session) => this.sessionGrants(session),
      cardEngineId: (projectKey, task) => this.cardEngineId(projectKey, task),
      transcriptWritten: (session) => this.transcriptWritten(session),
      transcriptSummary: (session) => this.transcriptSummary(session),
      compactFirst: (existing, resume, provider) => this.compaction.firstOnResume(existing, resume, provider),
      assertProviderReady: (provider, member, engineId) =>
        this.assertProviderReady(provider, member, engineId),
      removeSessionFolderOf: (sessionId) => this.removeSessionFolderOf(sessionId),
      folderRemoval: (sessionId) => this.folderRemovals.get(sessionId),
    });
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

  /** Server-owned retries survive runner restarts and never signal a remote pid locally. */
  private async retryScopeCleanup(): Promise<void> {
    if (this.scopeRetryRunning) return;
    this.scopeRetryRunning = true;
    try {
      const groups = new Map<EngineId, Array<{ sessionId: string; scopeId: string; sinceAgeMs?: number }>>();
      for (const record of this.cleanupFailures.pending()) {
        const session = this.find(record.sessionId);
        if (!session) continue;
        const engineId = engineIdOf(session);
        const scopes = groups.get(engineId) ?? [];
        // Resumes preserve startedAt from the first generation, so this bound precedes every failed scope.
        const sinceAgeMs = Math.max(
          0,
          this.ctx.now().getTime() - Math.min(Date.parse(session.startedAt), Date.parse(record.failedAt)),
        );
        scopes.push({
          sessionId: session.id,
          scopeId: record.scopeId,
          ...(Number.isFinite(sinceAgeMs) ? { sinceAgeMs } : {}),
        });
        groups.set(engineId, scopes);
      }
      await Promise.all(
        [...groups.values()].map(async (scopes) => {
          try {
            if (!this.deps.runner.closeScopes) return;
            for (let offset = 0; offset < scopes.length; offset += 50) {
              const batch = scopes.slice(offset, offset + 50);
              for (const scope of batch) this.cleanupFailures.attempted(scope.scopeId);
              for (const result of await this.deps.runner.closeScopes(batch)) {
                // A result that returns after the owner released the scope must not bring its record back.
                const session = this.find(result.sessionId);
                if (!session || !this.cleanupFailures.find(session.projectKey, result.cleanup.scopeId)) {
                  this.ctx.logger.debug(
                    { sessionId: result.sessionId, scopeId: result.cleanup.scopeId },
                    'process scope result ignored: the record was released',
                  );
                  continue;
                }
                this.handleRunnerEvent({ type: 'scope_recovered', ...result });
              }
            }
          } catch (err) {
            this.ctx.logger.warn(
              { err },
              'process scope cleanup retry unavailable; workspace remains reserved',
            );
          }
        }),
      );
      if (this.cleanupFailures.pending().length)
        this.timers.arm('cleanup', 'process-scopes', 60_000, () => {
          void this.lifecycle.run(() => this.retryScopeCleanup());
        });
    } finally {
      this.scopeRetryRunning = false;
    }
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
   * assignee starts on. Without an assignee, use the latest developer workspace's member placement,
   * then the latest task session with a source trace, else the local engine (PM-818).
   * Where the task's branch is read and its worktrees go.
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
    const work = this.ctx.repos.memberWorkspaces
      .bindingsOfTask(projectKey, task.key)
      .filter((binding) => binding.kind === 'work' && binding.branch)
      .at(-1);
    if (work) return this.deps.engines.engineFor(projectKey, work.member) ?? LOCAL_ENGINE_ID;
    const sourceSession = this.ctx.repos.sessions.latestSourceOfTask(projectKey, task.key);
    if (sourceSession) return engineIdOf(sourceSession);
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
    reassign?: (session: Session, stageId: string) => Promise<void>,
  ): void {
    this.limits.useQuotaRecovery(usage, resume, reassign);
  }

  observeProviderUsage(provider: AgentProvider, engineId: EngineId, usage: PlanUsage | null): void {
    this.limits.observeProviderUsage(provider, engineId, usage);
  }

  /** Persisted quota deferrals must check usage again before any restart-time inference. */
  restoreProviderQuota(): void {
    this.limits.restoreProviderQuota();
  }

  /** Unknown quota holds retry only the read-only usage probe, never inference. */
  refreshProviderQuota(): Promise<void> {
    return this.limits.refreshProviderQuota();
  }

  dispose(): void {
    this.lifecycle.close();
  }

  /** MCP: maps /mcp/:token to the calling session; null rejects the call. */
  resolveToken(token: string): ToolContext | null {
    return this.live.resolveToken(token);
  }

  /** Recomputed from the current project configuration for each MCP request. */
  audienceOf(ctx: ToolContext): MemberAudience {
    const config = this.deps.projects.cachedConfig(ctx.projectKey);
    return config
      ? memberAudience(config, ctx.member)
      : {
          operator: false,
          projectManager: false,
          merger: false,
          email: false,
          machineAccess: false,
          duties: new Set(),
        };
  }

  /** Builds the current context without reserving placement or recording a session. */
  async previewContext(
    projectKey: string,
    handle: MemberHandle,
    opts: { taskKey?: TaskKey; viewer: MemberHandle },
  ): Promise<MemberContextPreview> {
    const config = await this.deps.projects.config(projectKey);
    const member = requireAiMember(config, handle);
    const task = opts.taskKey ? this.deps.tasks.find(projectKey, opts.taskKey) : null;
    if (opts.taskKey && !task) throw new DomainError('task_not_found', 'task not found', { status: 404 });
    if (task && isTheme(task)) throw invalid('task_is_theme', 'a theme has no task context');
    const workItem: WorkItemRef = task ? { type: 'task', taskKey: task.key } : { type: 'general' };
    const cause: SessionStartCause = {
      kind: task ? 'start_button' : 'conversation',
      by: { kind: 'human', handle: opts.viewer },
    };
    const prepared = await this.contextInput.prepare(config, member, workItem, task, {
      placementDeferred: true,
    });
    const { handoff } = this.contextInput.handoffFor(task, member);
    const standing = this.contextInput.standingFor(config, member, task, null, false);
    const input = await this.contextInput.build(
      config,
      member,
      workItem,
      task,
      null,
      cause,
      prepared,
      standing,
      handoff,
    );
    const pack = this.deps.contextBuilder.build({ ...input, placementDeferred: true });
    const counted = (text: string) => ({ text, chars: Array.from(text).length });
    return {
      generatedAt: isoNow(this.ctx),
      member: {
        handle,
        role: member.role,
        duties: roleBundle(config, member.role).duties,
        onLeave: isOnLeave(member),
      },
      situation: task ? { kind: 'task', taskKey: task.key, stageId: task.stageId } : { kind: 'general' },
      prompt: {
        ...counted(pack.appendSystemPrompt),
        sections: pack.sections.map((section) => ({ ...section, ...counted(section.text) })),
      },
      initialMessage: pack.initialMessage === null ? null : counted(pack.initialMessage),
      guides: GUIDE_TOPICS.flatMap((topic) => {
        const text = pack.guide[topic];
        if (!text) return [];
        const title =
          text
            .split('\n')
            .find((line) => line.startsWith('# '))
            ?.slice(2) ?? topic;
        return [{ topic, title, ...counted(text) }];
      }),
      tools: this.deps.visibleTeamTools(memberAudience(config, handle)),
    };
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

  /** Whether the session is the Operator's: only the owner and the admin see those (PM-475). */
  isOperatorSession(sessionId: string): boolean {
    const session = this.find(sessionId);
    const config = session ? this.deps.projects.cachedConfig(session.projectKey) : null;
    return !!session && !!config && isOperator(memberOf(config, session.member));
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
    return this.live.awaitingFirstTurn.has(sessionId);
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
    const config = this.deps.projects.cachedConfig(projectKey);
    for (const workspaces of this.allWorkspaces())
      workspaces.requestReviewRound(projectKey, taskKey, member, config);
    // A reviewer that gave the work back has a new round now (PM-570).
    for (const s of this.list(projectKey, { taskKey }))
      if ((!member || s.member === member) && this.closeStates.isAwaitingFix(s.id)) this.cancelClose(s.id);
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
      // A cloud hub has no local worktree. Without an assignee, developer workspace or source session,
      // there is no engine source to read; recorded handovers and pins are read by the merge service.
      if (
        !task.assignee &&
        !this.deps.engines.ids().includes(LOCAL_ENGINE_ID) &&
        !this.ctx.repos.sessions.latestSourceOfTask(config.project.key, task.key) &&
        !this.ctx.repos.memberWorkspaces
          .bindingsOfTask(config.project.key, task.key)
          .some((binding) => binding.kind === 'work')
      )
        return null;
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
   * Makes the approved `commit` of a task readable in the repository the merge runs in (PM-739):
   * with member workspaces the developer's workspace hands it over, without them the task's
   * branch is in the repository already. A refusal stops the merge attempt.
   */
  async prepareMergeSource(config: ProjectConfig, task: Task, commit: string): Promise<void> {
    if (!effectiveRepo(config, task)) return;
    const workspaces = this.workspacesOf(this.cardEngineId(config.project.key, task));
    await workspaces?.prepareMergeSource(config, task, commit);
  }

  /**
   * Brings the default branch of the member's workspace for the task up to date before a message is
   * typed into the member's running session (PM-740). Nothing is started and the session's work is
   * left as it is. A no-op without a member workspace; a failed fetch throws.
   */
  async refreshWorkspaceBase(config: ProjectConfig, task: Task, member: string): Promise<void> {
    if (!effectiveRepo(config, task)) return;
    const session = this.ctx.repos.sessions.findByWorkItem(config.project.key, member, {
      type: 'task',
      taskKey: task.key,
    });
    const engineId = this.deps.engines.engineFor(config.project.key, member);
    const workspaces = session
      ? this.workspacesOfSession(session)
      : engineId
        ? this.workspacesOf(engineId)
        : null;
    await workspaces?.refreshBase(config, task, member);
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
      this.deps.startHolds?.assertFree(projectKey, handle);
      const task = workItem.type === 'task' ? this.deps.tasks.get(projectKey, workItem.taskKey) : null;
      assertIntegratorAccess(config, 'write');
      assertSuperMutation(config, { kind: 'runtime_start', providers: [member.provider ?? 'claude'] });
      const existing = this.ctx.repos.sessions.findByWorkItem(projectKey, handle, workItem);
      if (existing && this.cleanupFailures.hasSession(existing.id))
        throw conflict('workspace_busy', 'session process cleanup is unresolved', {
          sessionId: existing.id,
          member: handle,
          taskKey: task?.key ?? null,
        });
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
        this.live.stopReasons.set(existing.id, { kind: 'restart', restartFor: 'new_round' });
        await this.deps.runner.stop(existing.id);
        this.markEnded(existing.id, null);
        announce = false;
      }
      return this.launcher.start(
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
      this.live.stopReasons.set(session.id, { kind: 'restart', restartFor: 'description' });
      await this.deps.runner.stop(session.id);
      this.markEnded(session.id, null);
      await this.launcher.start(
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
      assertIntegratorAccess(config, 'write', actor);
      const refusal = sessionApproverChangeRefusal(member, req.approver);
      if (refusal) throw forbidden(refusal, 'the Operator approver is fixed to human');
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
        ...(req.approver !== undefined ? { approverOverride: isOperator(member) ? null : req.approver } : {}),
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

  /** Whether the session's process runs with another permission mode. */
  private modeNeedsRestart(sessionId: string, mode: string | undefined): boolean {
    if (!this.live.modes.has(sessionId)) return false;
    const current = this.live.modes.get(sessionId);
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
    this.live.stopReasons.set(session.id, { kind: 'restart', restartFor: 'permission' });
    await this.deps.runner.stop(session.id);
    this.markEnded(session.id, null);
    await this.launcher.start(
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
    const before = this.live.grants.get(session.id);
    return before !== undefined && this.sessionGrants(session) > before;
  }

  /** How many requests of the session a person allowed "for this session", ever. */
  private sessionGrants(session: Pick<Session, 'id' | 'projectKey'>): number {
    return this.ctx.repos.inbox
      .list(session.projectKey, { kind: 'permission', state: 'resolved' })
      .filter((item) => item.sessionId === session.id && item.resolution?.optionId === 'allow_session')
      .length;
  }

  /**
   * Types text into a running session (queued by the runner until the session is idle). Resolves once
   * the session took it; rejects when it did not (PM-571), so the caller leaves the message waiting.
   */
  typeInto(session: Session, text: string): Promise<void> {
    this.assertProviderCooldown(session.provider ?? DEFAULT_AGENT_PROVIDER);
    // The session is being closed (PM-288): the message stays waiting, and its wake-up resumes the session.
    if (this.closeStates.isClosing(session.id)) throw new Error(`session ${session.id} is closing`);
    return this.deps.runner.sendUserMessage(session.id, text);
  }

  async memory(projectKey: string, handle: string): Promise<string> {
    const member = requireAiMember(await this.deps.projects.config(projectKey), handle);
    return this.deps.memory.read(projectKey, memberStorageHandle(member));
  }

  /** Stops a session; `stop` is why (PM-288), recorded on the session and its `session_ended` event. */
  async stop(projectKey: string, sessionId: string, stop?: SessionStop): Promise<Session> {
    assertIntegratorAccess(await this.deps.projects.config(projectKey), 'write', stop?.by);
    const session = this.get(projectKey, sessionId);
    this.dropPause(session);
    // The runner's exit event may end the session before this call does: it takes the reason from here.
    if (stop) this.live.stopReasons.set(session.id, stop);
    if (this.isRunning(session.id)) await this.deps.runner.stop(session.id);
    return this.markEnded(session.id, null, null, stop) ?? this.get(projectKey, sessionId);
  }

  /**
   * The audited override of an unresolved process-scope cleanup (PM-935): the record is closed and the
   * workspaces it reserves are freed although the engine could not prove that every process stopped.
   * Who did it and why stays on the timeline; the Operator signal of the scope is closed by the event.
   */
  releaseCleanupScope(projectKey: string, scopeId: string, release: { actor: Actor; reason: string }): void {
    const record = this.cleanupFailures.find(projectKey, scopeId);
    if (!record) throw notFound('cleanup_scope', scopeId);
    this.ctx.repos.transaction(() => {
      const { memberWorkspaces } = this.cleanupFailures.release(record);
      this.deps.timeline.append({
        projectKey,
        taskKey: record.taskKey,
        sessionId: record.sessionId,
        actor: release.actor,
        type: 'workspace_released',
        data: {
          scopeId,
          sessionId: record.sessionId,
          workspaceIds: memberWorkspaces,
          reason: release.reason,
        },
      });
    });
    void this.ctx.events.emit('session_cleanup_released', {
      projectKey,
      sessionId: record.sessionId,
      scopeId,
    });
  }

  // ---------------------------------------------------------------- closing idle sessions (PM-288)

  /**
   * Marks the session to close at its next idle moment (`SessionCloser.sessionIdle`): the member that
   * moved the card finishes its round first.
   */
  closeWhenIdle(session: Session, stop: SessionStop): void {
    this.closeStates.mark(session.id, stop);
  }

  /** Why the session is marked to close; undefined: it is not. */
  pendingClose(sessionId: string): SessionStop | undefined {
    return this.closeStates.markOf(sessionId);
  }

  /**
   * The session is not to close after all (its member has a step on the card again). A compaction the
   * mark held back is looked at now: the session is idle, and it drops the compaction of a card that is
   * back in a stage its member works it in.
   */
  cancelClose(sessionId: string): void {
    if (!this.closeStates.cancel(sessionId)) return;
    const session = this.find(sessionId);
    if (session) this.compaction.whenIdle(session);
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
      this.closeStates.beginClose(session.id);
      this.live.stopReasons.set(session.id, stop);
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
    this.inputWaits.watch(current);
    this.wakeForNewRound(current);
    if (current.state !== 'idle') return;
    this.restartForMergeFix(current);
    if (current.permissionRestartPending) this.restartWhenIdle(current);
    this.compaction.whenIdle(current);
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
        if (stop) this.live.stopReasons.set(session.id, stop);
        if (this.isRunning(session.id)) await this.deps.runner.stop(session.id);
      } catch (err) {
        this.ctx.logger.warn({ err, sessionId: session.id }, 'could not stop a session');
      }
      this.markEnded(session.id, null, null, stop);
    }
  }

  /**
   * Whether the session's conversation was written: its transcript is a file with content (PM-340).
   * A file that cannot be checked counts as not written, as the CLI could hardly resume it.
   */
  async transcriptWritten(session: Session): Promise<boolean> {
    if (!session.transcriptPath) return false;
    try {
      return await this.deps.transcripts.hasContent(session.transcriptPath, {
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
    try {
      return await this.deps.transcripts.summary(session.transcriptPath, {
        provider: session.provider ?? DEFAULT_AGENT_PROVIDER,
        ...engineOption(engineIdOf(session)),
      });
    } catch (err) {
      this.ctx.logger.warn({ err, sessionId: session.id }, 'could not summarize the transcript');
      return null;
    }
  }

  /** The session with its chat, read from the transcript as its provider wrote it. */
  async detail(projectKey: string, sessionId: string): Promise<SessionDetail> {
    const session = this.get(projectKey, sessionId);
    let chat: ChatItem[] = [];
    if (session.transcriptPath) {
      try {
        chat = await this.deps.transcripts.read(session.transcriptPath, {
          provider: session.provider ?? DEFAULT_AGENT_PROVIDER,
          self: session.member,
          cwd: session.cwd,
          firstUserOrigin: openingTurnOrigin(session.workItem),
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
    this.cleanup.schedule(projectKey, taskKey, mover);
  }

  /** Stops a done task's sessions and removes its clean worktrees (see `DoneCleanup.cleanUp`). */
  cleanupDoneTask(projectKey: string, taskKey: string, opts: { mover?: string | null } = {}): Promise<void> {
    return this.cleanup.cleanUp(projectKey, taskKey, opts);
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

  /** Periodically ends live rows whose processes are gone, after consecutive missing rounds. */
  async sweepLive(): Promise<void> {
    this.liveSweep.sweep();
  }

  /** Startup: sessions do not survive a restart (their conversations do, via --resume). */
  async reconcileAfterRestart(): Promise<void> {
    for (const session of this.ctx.repos.sessions.listInStates(LIVE_SESSION_STATES)) {
      if (this.isRunning(session.id)) continue;
      this.markEnded(session.id, null, null, { kind: 'server_restart' });
    }
    await this.retryScopeCleanup();
    // Failed process scopes retain their folders until the owning engine confirms closure.
    for (const engineId of this.deps.engines.ids()) {
      const folders = this.deps.engines.get(engineId)?.sessionFolders;
      if (!folders) continue;
      try {
        const removed = await folders.sweep(
          (id) => this.isRunning(id) || this.cleanupFailures.hasSession(id),
        );
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
      await folders.sweep((id) => reported.has(id) || starting(id) || this.cleanupFailures.hasSession(id));
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

  /**
   * What a screenshot run of the session needs (PM-351): its worktree, its own folder and the limits of
   * its sandbox. Undefined when the session has no folder of its own or does not work in a worktree.
   */
  screenshotScope(sessionId: string): ScreenshotScope | undefined {
    return this.screenshotScopes.get(sessionId);
  }

  guide(sessionId: string): ContextPack['guide'] | undefined {
    return this.live.guides.get(sessionId);
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
   * Removes the session's folder (PM-268), on whichever engine holds it: a session's folder is on the
   * engine it ran on, and nothing elsewhere. The removal starts at once and is tracked
   * (`folderRemovals`): whoever makes the session's next folder (`prepareSessionFolder`) awaits it,
   * so a restart's new folder is made after the old one's removal. A failure is logged and never
   * stops the caller.
   */
  private removeSessionFolderOf(sessionId: string): void {
    if (this.cleanupFailures.hasSession(sessionId)) return;
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
    await this.lifecycle.settled();
    await Promise.all([...this.folderRemovals.values()]);
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
    this.limits.assertProviderCooldown(provider);
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
    cleanup?: SessionCleanup,
  ): Session | null {
    const session = this.ctx.repos.sessions.get(sessionId);
    if (session) this.cleanupFailures.observe(session, cleanup, this.workspacesOfSession(session));
    const failed = exitCode !== null && exitCode !== 0;
    const { stop: recordedStop, resuming } = this.live.ended(sessionId);
    // A session a pause held ends as paused, unless it failed; the other ends without a reason are PM-274's.
    const why =
      stop ??
      recordedStop ??
      (session && !failed && this.isPaused(session)
        ? ({ kind: 'pause' } as const)
        : ({ kind: failed ? (reason ? 'login_lost' : 'failed') : 'exited' } as const));
    // A resumed conversation whose CLI failed before it was ready cannot be resumed (PM-340): the next
    // start begins a new conversation, so it does not fail again and again with the same resume.
    const resumeFailed = failed && session?.state === 'starting' && resuming && !stop;
    this.limits.ended(sessionId);
    this.closeStates.ended(sessionId);
    if (cleanup?.outcome !== 'failed') this.removeSessionFolderOf(sessionId);
    this.turns.ended(sessionId);
    this.inputWaits.ended(sessionId);
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
          this.live.settleFirstInput(session.id, true);
          return;
        }
        case 'first_input_failed': {
          // The messages in it stay waiting (not delivered); the delivery retries them (PM-571).
          this.ctx.logger.warn(
            { sessionId: session.id, member: session.member },
            'the first input was typed but the session did not take it',
          );
          this.live.settleFirstInput(session.id, false);
          return;
        }
        case 'state': {
          if (ENDED.has(event.state)) {
            // The owning runner still holds the scope until exit carries its cleanup result.
            if (this.deps.runner.list().some((info) => info.sessionId === session.id && info.scopeId)) {
              this.endingStates.set(session.id, { state: event.state, activity: event.activity });
              return;
            }
            const lostLogin = this.limits.lostLogin(session.id);
            const ended = this.markEnded(session.id, event.state === 'failed' ? 1 : null, event.activity);
            if (ended && lostLogin && ended.lastStop?.kind === 'login_lost')
              void this.lifecycle
                .run(() => this.limits.resumeAfterLoginLost(ended, lostLogin))
                .catch((err: unknown) =>
                  this.ctx.logger.error({ err, sessionId: session.id }, 'provider login deferral failed'),
                );
            return;
          }
          // A state report never revives an ended row, running process or not: a new process starts only
          // after the launcher sets the row to `starting` and clears `endedAt`. A process that still runs
          // under an ended row (a late report after a server restart) is stopped by `reconcileEngine`.
          if (ENDED.has(session.state)) {
            this.ctx.logger.debug(
              { sessionId: session.id, state: event.state },
              'dropped a state report of an ended session',
            );
            return;
          }
          if (event.state !== 'starting' && event.state !== 'idle')
            this.live.awaitingFirstTurn.delete(session.id);
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
          this.inputWaits.watch(updated);
          this.recomputeMemberState(session.projectKey, session.member);
          this.wakeForNewRound(updated);
          if (updated.state === 'idle' && session.state !== 'idle') {
            void this.ctx.events.emit('session_idle', updated);
          }
          if (updated.state === 'idle') this.turns.ended(updated.id);
          if (updated.state === 'idle') this.restartForMergeFix(updated);
          if (updated.state === 'idle' && updated.permissionRestartPending) this.restartWhenIdle(updated);
          if (updated.state === 'idle') this.compaction.whenIdle(updated);
          return;
        }
        case 'transcript_path': {
          // The conversation at this path is the one the current process runs.
          const provider = this.live.providers.get(session.id) ?? session.provider;
          if (session.transcriptPath === event.path && session.provider === provider) return;
          this.publishSession(
            this.ctx.repos.sessions.update(session.id, { transcriptPath: event.path, provider })!,
          );
          return;
        }
        case 'chat': {
          const workMetadata = workMetadataAfterChat(session.workMetadata, event.items, {
            state: session.state,
            now: this.ctx.now().getTime(),
          });
          this.ctx.repos.sessions.update(session.id, {
            lastActivityAt: at,
            ...(workMetadata ? { workMetadata } : {}),
          });
          this.ctx.bus.publish({
            type: 'chat_appended',
            projectKey: session.projectKey,
            sessionId: session.id,
            items: event.items,
          });
          return;
        }
        case 'exit': {
          const pending = this.endingStates.get(session.id);
          this.endingStates.delete(session.id);
          const lostLogin = this.limits.lostLogin(session.id);
          const ended = this.markEnded(
            session.id,
            pending ? (pending.state === 'failed' ? 1 : null) : event.exitCode,
            pending?.activity ?? null,
            undefined,
            event.cleanup,
          );
          if (ended && lostLogin && ended.lastStop?.kind === 'login_lost')
            void this.lifecycle
              .run(() => this.limits.resumeAfterLoginLost(ended, lostLogin))
              .catch((err: unknown) =>
                this.ctx.logger.error({ err, sessionId: session.id }, 'provider login deferral failed'),
              );
          if (event.cleanup?.outcome === 'failed')
            void this.ctx.events.emit('session_cleanup_failed', {
              projectKey: session.projectKey,
              sessionId: session.id,
              scopeId: event.cleanup.scopeId,
              kind: event.cleanup.kind,
              survivors: event.cleanup.survivors,
            });
          if (event.cleanup?.outcome === 'failed')
            this.timers.arm('cleanup', 'process-scopes', 60_000, () => {
              void this.lifecycle.run(() => this.retryScopeCleanup());
            });
          return;
        }
        case 'scope_recovered': {
          this.cleanupFailures.observe(session, event.cleanup, this.workspacesOfSession(session));
          if (event.cleanup.outcome === 'failed')
            void this.ctx.events.emit('session_cleanup_failed', {
              projectKey: session.projectKey,
              sessionId: session.id,
              scopeId: event.cleanup.scopeId,
              kind: event.cleanup.kind,
              survivors: event.cleanup.survivors,
            });
          if (event.cleanup.outcome === 'failed')
            this.timers.arm('cleanup', 'process-scopes', 60_000, () => {
              void this.lifecycle.run(() => this.retryScopeCleanup());
            });
          if (event.cleanup.outcome === 'clean' && ENDED.has(session.state) && !this.isRunning(session.id))
            this.removeSessionFolderOf(session.id);
          if (event.cleanup.outcome === 'clean')
            void this.ctx.events.emit('session_cleanup_recovered', {
              projectKey: session.projectKey,
              sessionId: session.id,
              scopeId: event.cleanup.scopeId,
            });
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
          this.compaction.observe(session.id, event);
          return;
        }
        case 'usage': {
          this.limits.usage(session, event);
          return;
        }
        case 'auth_error': {
          this.limits.authError(session, event);
          return;
        }
        case 'rate_limited': {
          this.limits.rateLimited(session, event);
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
    this.lifecycle
      .run(() =>
        this.locks.run(sessionLockKey(session.projectKey, session.member, session.workItem), () =>
          this.restartForPermissions(session.projectKey, session.id),
        ),
      )
      .catch((err: unknown) =>
        this.ctx.logger.warn(
          { err, sessionId: session.id },
          'could not restart the session into its new mode',
        ),
      );
  }

  /** A conflict-fix request changes placement only after the tool's turn has ended. */
  private restartForMergeFix(session: Session): void {
    if (session.workItem.type !== 'task' || this.isPaused(session)) return;
    const work = async () => {
      const current = this.find(session.id);
      if (
        !current ||
        current.workItem.type !== 'task' ||
        current.state !== 'idle' ||
        !this.isRunning(current.id) ||
        this.isPaused(current)
      )
        return;
      const task = this.deps.tasks.find(current.projectKey, current.workItem.taskKey);
      if (!task) return;
      const placement = this.live.mergeFixes.get(current.id);
      if (!isMergeFixer(task.merge, current.member)) {
        if (placement) {
          // The resolution is in and the server runs the merge now: the same reason the closer gives (PM-552).
          const stop: SessionStop | undefined = isMergeRunningFor(task.merge, current.member)
            ? { kind: 'merge_running', taskKey: task.key }
            : undefined;
          await this.stop(current.projectKey, current.id, stop);
        }
        return;
      }
      if (placement?.branch === task.merge!.fix!.branch && placement.cwd === current.cwd) return;
      const config = await this.deps.projects.config(current.projectKey);
      const member = memberOf(config, current.member);
      if (!this.mayWorkNow(config, member)) return;
      this.live.stopReasons.set(current.id, { kind: 'restart', restartFor: 'description' });
      await this.deps.runner.stop(current.id);
      this.markEnded(current.id, null);
      await this.launcher.start(
        config,
        member,
        current.workItem,
        task,
        this.find(current.id),
        messagesForFirstInput([
          `Continue in the dedicated merge-fix worktree. Run git merge ${task.merge!.fix!.base}, resolve only mechanical conflicts, commit and call merge_task with resolution. Send behavioral conflicts back with update_task and a reason.`,
        ]),
        false,
        null,
        null,
        null,
      );
    };
    void this.lifecycle
      .run(() => this.locks.run(sessionLockKey(session.projectKey, session.member, session.workItem), work))
      .catch((err: unknown) =>
        this.ctx.logger.warn({ err, sessionId: session.id }, 'could not update merge-fix placement'),
      );
  }

  /**
   * The card left a stage (`task_stage_changed`): the round of every member's session on it ends,
   * so that conversation owes a compaction (see `RoundCompaction.roundEnded`).
   */
  roundEnded(task: Task): Promise<void> {
    return this.compaction.roundEnded(task);
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
    const selected = waiting ?? working;
    const activityTaskKey = selected?.workItem.type === 'task' ? selected.workItem.taskKey : null;
    this.deps.members.setState(projectKey, handle, status, activity, activityTaskKey);
  }
}
