import path from 'node:path';
import {
  DEFAULT_AGENT_PROVIDER,
  effectiveRepo,
  isOnLeave,
  memberOf,
  repoOf,
  routes,
  stageOf,
} from '@projectman/shared';
import type {
  AgentProvider,
  AiMemberConfig,
  ChatItem,
  MemberStatus,
  ProjectConfig,
  Session,
  SessionDetail,
  SessionState,
  Task,
  WorkItemRef,
} from '@projectman/shared';
import { openingTurnOrigin, PROVIDER_NOT_LOGGED_IN } from '../contracts';
import type {
  ContextPackBuilder,
  MemberMemoryStore,
  RunnerEvent,
  SessionRunner,
  ToolContext,
  TranscriptReader,
  WorktreeInfo,
  WorktreeManager,
} from '../contracts';
import { encodeWorkItem } from '../db';
import { requireAiMember } from './access';
import { assertAiEnabled, assertNotOnLeave, assertRepoChosen } from './admission/rules';
import { isoNow } from './context';
import type { DomainContext } from './context';
import { conflict, DomainError, notFound } from './errors';
import type { MemberService } from './members';
import type { ConfigChange, ProjectService } from './projects';
import {
  allowedToolsFor,
  deniedToolsFor,
  sessionPolicyFor,
  DONE_TASK_CLEANUP_DELAY_MS,
  usesWorktree,
} from './session-policy';
import type { TaskService } from './tasks';
import type { TimelineService } from './timeline';
import { aiActor, KeyedMutex, newId, newToken, newUuid, SYSTEM_ACTOR } from './util';

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

export interface EnsureSessionResult {
  session: Session;
  /** A new row was created (first session for this member x work item). */
  created: boolean;
  /** The agent's conversation was resumed (`--resume`, `codex resume`). */
  resumed: boolean;
  /** A process was started (false when a running session was reused). */
  started: boolean;
  /** The message passed in `EnsureSessionOptions` became the first input of the resumed session. */
  messageSent: boolean;
}

export interface EnsureSessionOptions {
  /**
   * The message that causes this start (a person writing to a stopped session, a waiting team
   * message), as it is typed in. A session that resumes its conversation takes it as its first
   * input, in place of the continue message; `messageSent` tells the caller. A session that
   * starts a new conversation begins with its brief, and the caller types the message after, as
   * it does with a message longer than `MAX_FIRST_INPUT_CHARS`.
   */
  message?: string;
}

/**
 * The longest message a resumed session takes as its first input: it may go on a command line
 * (Codex), which the system limits (about 128 KB for one argument). A longer one is typed in after
 * the session started, as it is for a session that runs. A team message (at most 20 000
 * characters) with its prefix fits.
 */
export const MAX_FIRST_INPUT_CHARS = 24_000;

export interface SessionOrchestratorDeps {
  ctx: DomainContext;
  projects: ProjectService;
  tasks: TaskService;
  members: MemberService;
  timeline: TimelineService;
  runner: SessionRunner;
  transcripts: TranscriptReader;
  contextBuilder: ContextPackBuilder;
  memory: MemberMemoryStore;
  worktrees: WorktreeManager;
  /** Base URL the claude CLI reaches this server at, e.g. http://127.0.0.1:4700. */
  publicBaseUrl: string;
  /** Delay before a done task's sessions are stopped and its worktrees removed. */
  doneCleanupDelayMs?: number;
}

/** Worktree removals that are refused on purpose (the worktree module's error codes). */
const KEPT_WORKTREE_CODES = new Set(['dirty', 'outside_root', 'not_a_worktree', 'main_worktree']);

/** The `code` of module errors (e.g. WorktreeError), without depending on their classes. */
function errorCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

function providerNotLoggedIn(provider: AgentProvider, details: Record<string, unknown>, detail?: string) {
  return conflict(
    PROVIDER_NOT_LOGGED_IN,
    `${provider} is not logged in with a subscription${detail ? `: ${detail}` : ''}`,
    { provider, ...details },
  );
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
  private readonly ctx: DomainContext;
  private readonly locks = new KeyedMutex();
  private readonly tokens = new Map<string, ToolContext>();
  private readonly tokenBySession = new Map<string, string>();
  private readonly cleanupTimers = new Set<NodeJS.Timeout>();
  /** The provider each session's current process runs, for the transcript it reports. */
  private readonly processProviders = new Map<string, AgentProvider>();
  private readonly unsubscribe: () => void;

  constructor(deps: SessionOrchestratorDeps) {
    this.deps = deps;
    this.ctx = deps.ctx;
    this.unsubscribe = deps.runner.onEvent((event) => this.handleRunnerEvent(event));
  }

  dispose(): void {
    this.unsubscribe();
    for (const timer of this.cleanupTimers) clearTimeout(timer);
    this.cleanupTimers.clear();
  }

  /** MCP: maps /mcp/:token to the calling session; null rejects the call. */
  resolveToken(token: string): ToolContext | null {
    return this.tokens.get(token) ?? null;
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

  /** Running AI sessions with a turn in progress, across all projects. */
  busyCount(): number {
    return this.ctx.repos.sessions.listInStates(BUSY_SESSION_STATES).filter((s) => this.isRunning(s.id))
      .length;
  }

  findRunning(projectKey: string, member: string, workItem: WorkItemRef): Session | null {
    const session = this.ctx.repos.sessions.findByWorkItem(projectKey, member, workItem);
    return session && this.isRunning(session.id) ? session : null;
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
    const wi = encodeWorkItem(workItem);
    return this.locks.run(`${projectKey}:${handle}:${wi.type}:${wi.ref}`, async () => {
      const config = await this.deps.projects.config(projectKey);
      const member = requireAiMember(config, handle);
      const task = workItem.type === 'task' ? this.deps.tasks.get(projectKey, workItem.taskKey) : null;
      const existing = this.ctx.repos.sessions.findByWorkItem(projectKey, handle, workItem);
      if (existing && this.isRunning(existing.id)) {
        return { session: existing, created: false, resumed: false, started: false, messageSent: false };
      }
      const message =
        opts.message?.trim() && opts.message.length <= MAX_FIRST_INPUT_CHARS ? opts.message : null;
      return this.start(config, member, workItem, task, existing, message);
    });
  }

  /** Types text into a running session (queued by the runner until the session is idle). */
  typeInto(session: Session, text: string): Promise<void> {
    return this.deps.runner.sendUserMessage(session.id, text);
  }

  async memory(projectKey: string, handle: string): Promise<string> {
    requireAiMember(await this.deps.projects.config(projectKey), handle);
    return this.deps.memory.read(projectKey, handle);
  }

  async stop(projectKey: string, sessionId: string): Promise<Session> {
    const session = this.get(projectKey, sessionId);
    if (this.isRunning(session.id)) await this.deps.runner.stop(session.id);
    return this.markEnded(session.id, null) ?? this.get(projectKey, sessionId);
  }

  /** Stops all live sessions for a cancelled task without cleaning up its worktrees. */
  async stopTask(projectKey: string, taskKey: string): Promise<void> {
    for (const session of this.list(projectKey, { taskKey })) {
      if (LIVE_SESSION_STATES.includes(session.state) || this.isRunning(session.id)) {
        await this.stop(projectKey, session.id);
      }
    }
  }

  async stopMember(projectKey: string, handle: string): Promise<void> {
    for (const session of this.ctx.repos.sessions.list(projectKey, { member: handle })) {
      try {
        if (this.isRunning(session.id)) await this.deps.runner.stop(session.id);
      } catch (err) {
        this.ctx.logger.warn({ err, sessionId: session.id }, 'could not stop a session');
      }
      this.markEnded(session.id, null);
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
   */
  scheduleDoneCleanup(projectKey: string, taskKey: string): void {
    const timer = setTimeout(() => {
      this.cleanupTimers.delete(timer);
      this.cleanupDoneTask(projectKey, taskKey).catch((err: unknown) =>
        this.ctx.logger.warn({ err, taskKey }, 'cleanup of a done task failed'),
      );
    }, this.deps.doneCleanupDelayMs ?? DONE_TASK_CLEANUP_DELAY_MS);
    timer.unref();
    this.cleanupTimers.add(timer);
  }

  /** Stops a done task's sessions and removes its worktrees unless they hold uncommitted or unpushed work. */
  async cleanupDoneTask(projectKey: string, taskKey: string): Promise<void> {
    const task = this.ctx.repos.tasks.get(taskKey);
    if (!task || task.projectKey !== projectKey || task.status !== 'done') return; // reopened meanwhile
    const sessions = this.ctx.repos.sessions.list(projectKey, { taskKey });
    for (const session of sessions) {
      if (!this.isRunning(session.id)) continue;
      try {
        await this.deps.runner.stop(session.id);
      } catch (err) {
        this.ctx.logger.warn({ err, sessionId: session.id }, 'could not stop a session');
      }
      this.markEnded(session.id, null);
    }
    const worktreePaths = [...new Set(sessions.filter((s) => s.branch !== null).map((s) => s.cwd))];
    for (const path of worktreePaths) {
      try {
        const status = await this.deps.worktrees.status(path);
        if (status.dirty || status.unpushedCommits > 0) {
          this.ctx.logger.info({ path, taskKey, ...status }, 'keeping a worktree with local work');
          continue;
        }
        await this.deps.worktrees.remove({ path });
      } catch (err) {
        // Expected refusals (WorktreeError codes): local changes, a checkout we do not own.
        const code = errorCode(err);
        const expected = code !== null && KEPT_WORKTREE_CODES.has(code);
        this.ctx.logger[expected ? 'info' : 'warn']({ err, path, taskKey, code }, 'worktree not removed');
      }
    }
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
      if (!stays || (isOnLeave(stays) && !isOnLeave(m))) await this.stopMember(change.projectKey, m.handle);
    }
  }

  /** Startup: sessions do not survive a restart (their conversations do, via --resume). */
  reconcileAfterRestart(): void {
    const at = isoNow(this.ctx);
    for (const session of this.ctx.repos.sessions.listInStates(LIVE_SESSION_STATES)) {
      if (this.isRunning(session.id)) continue;
      this.ctx.repos.sessions.update(session.id, { state: 'exited', activity: null, endedAt: at });
    }
  }

  private async start(
    config: ProjectConfig,
    member: AiMemberConfig,
    workItem: WorkItemRef,
    task: Task | null,
    existing: Session | null,
    message: string | null,
  ): Promise<EnsureSessionResult> {
    assertAiEnabled(config);
    assertNotOnLeave(member);
    // A role that changes files works in the task's worktree: without a repository to make it in, it
    // would run in the workspace root, so the start is refused until a person chooses one.
    assertRepoChosen(config, member.role, task);
    const projectKey = config.project.key;
    const provider = member.provider ?? DEFAULT_AGENT_PROVIDER;
    // A CLI that is not logged in could only sit at its login screen: refuse before any work.
    await this.assertProviderReady(provider);
    let cwd = config.project.workspacePath;
    let branch: string | null = null;
    let writableRoots: string[] | undefined;
    let additionalDirectories: string[] | undefined;
    // The repository the task's work happens in: its own, else the project's only one (see
    // `effectiveRepo`). Without one the session runs in the workspace root: a project without
    // repositories, or a role that only reads (the ones that change files were refused above).
    const repoName = effectiveRepo(config, task);
    let placed: WorktreeInfo | null = null;
    if (task && repoName && usesWorktree(member.role, config)) {
      // Code-changing roles work in the task's own worktree and branch; others in the workspace.
      try {
        placed = await this.deps.worktrees.ensureForTask({
          project: config,
          repoName,
          taskKey: task.key,
          title: task.title,
        });
        cwd = placed.path;
        branch = placed.branch;
        if (placed.gitDir) writableRoots = [placed.gitDir];
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
    if (
      task &&
      repoName &&
      !usesWorktree(member.role, config) &&
      sessionPolicyFor(member.role, config).readOnlyTools
    ) {
      try {
        const found = await this.deps.worktrees.find({
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
    const relocated = Boolean(existing && placed && path.resolve(existing.cwd) !== path.resolve(placed.path));
    if (existing && !relocated) {
      // Claude Code keeps conversations per working directory: resume where it started.
      cwd = existing.cwd;
      branch = existing.branch ?? branch;
    }

    const stage = task ? (stageOf(config, task.stageId) ?? null) : null;
    const memory = await this.deps.memory.read(projectKey, member.handle).catch((err: unknown) => {
      this.ctx.logger.warn({ err, member: member.handle }, 'could not read member memory');
      return '';
    });
    const pack = this.deps.contextBuilder.build({
      project: config,
      member,
      workItem,
      task,
      stage,
      timeline: task ? this.deps.timeline.list(projectKey, { taskKey: task.key, limit: 30 }) : [],
      team: this.deps.members.rosterFor(config),
      memory,
    });

    // Configuration may change while login, worktree and memory preparation await I/O. So may the
    // task's repository: no live session holds it in place before the session is recorded below.
    const latestConfig = await this.deps.projects.config(projectKey);
    assertAiEnabled(latestConfig);
    assertNotOnLeave(memberOf(latestConfig, member.handle));
    if (task) {
      const latestTask = this.deps.tasks.get(projectKey, task.key);
      assertRepoChosen(latestConfig, member.role, latestTask);
      if (placed && effectiveRepo(latestConfig, latestTask) !== repoName) {
        throw conflict(
          'session_start_failed',
          `the repository of task ${task.key} changed while the session was starting: start it again`,
          { taskKey: task.key },
        );
      }
    }
    const at = isoNow(this.ctx);
    // Resume only a conversation that exists (the runner reported its transcript), that belongs to
    // the member's current provider and that ran where the session runs now.
    const resume =
      !relocated &&
      Boolean(existing?.transcriptPath && (existing.provider ?? DEFAULT_AGENT_PROVIDER) === provider);
    let session: Session;
    if (existing) {
      session = this.ctx.repos.sessions.update(existing.id, {
        state: 'starting',
        activity: null,
        cwd,
        branch,
        lastActivityAt: at,
        endedAt: null,
        ...(relocated ? { claudeSessionId: newUuid(), transcriptPath: null } : {}),
      })!;
    } else {
      session = {
        id: newId('ses'),
        projectKey,
        member: member.handle,
        workItem,
        claudeSessionId: newUuid(),
        provider,
        cwd,
        branch,
        transcriptPath: null,
        state: 'starting',
        activity: null,
        startedAt: at,
        lastActivityAt: at,
        endedAt: null,
      };
      this.ctx.repos.sessions.insert(session);
    }
    const token = this.issueToken(session);
    this.processProviders.set(session.id, provider);

    try {
      const info = await this.deps.runner.start({
        sessionId: session.id,
        claudeSessionId: session.claudeSessionId,
        resume,
        cwd,
        member: member.handle,
        displayName: `${member.displayName} · ${workItemLabel(workItem, member)}`,
        model: member.model,
        effort: member.effort,
        permissionMode: member.permissionMode,
        appendSystemPrompt: pack.appendSystemPrompt,
        // A resumed conversation has its brief already; it needs to know why it was woken.
        initialMessage: resume ? (message ?? pack.continueMessage) : pack.initialMessage,
        firstUserOrigin: openingTurnOrigin(workItem),
        mcpUrl: `${this.deps.publicBaseUrl}${routes.mcp(token)}`,
        allowedTools: allowedToolsFor(member.role, config),
        deniedTools: deniedToolsFor(config, task),
        writableRoots,
        additionalDirectories,
        provider,
      });
      const current = this.ctx.repos.sessions.get(session.id);
      if (current?.state === 'starting' && info.state !== 'starting') {
        this.ctx.repos.sessions.update(session.id, { state: info.state });
      }
    } catch (err) {
      this.revokeToken(session.id);
      this.processProviders.delete(session.id);
      const failed = this.ctx.repos.sessions.update(session.id, {
        state: 'failed',
        endedAt: isoNow(this.ctx),
      });
      if (failed) {
        this.publishSession(failed);
        void this.ctx.events.emit('session_ended', failed);
      }
      this.recomputeMemberState(projectKey, member.handle);
      if (errorCode(err) === PROVIDER_NOT_LOGGED_IN) {
        throw providerNotLoggedIn(provider, { sessionId: session.id }, (err as Error).message);
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
      data: { member: member.handle, resumed: resume },
    });
    const fresh = this.ctx.repos.sessions.get(session.id)!;
    this.publishSession(fresh);
    this.recomputeMemberState(projectKey, member.handle);
    void this.ctx.events.emit('session_started', fresh);
    return {
      session: fresh,
      created: !existing,
      resumed: resume,
      started: true,
      messageSent: resume && message !== null,
    };
  }

  /** Throws `provider_not_logged_in` when the runner knows the provider's CLI is not logged in. */
  private async assertProviderReady(provider: AgentProvider): Promise<void> {
    let status;
    try {
      status = await this.deps.runner.providerStatus?.(provider);
    } catch (err) {
      this.ctx.logger.warn({ err, provider }, 'could not check the provider login');
      return;
    }
    if (status?.loggedIn === false) {
      throw providerNotLoggedIn(provider, { method: status.method }, status.detail);
    }
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
  }

  /**
   * Marks a live session as ended (exit, stop, retire); returns the updated row or null if it
   * had ended. `reason` (e.g. a lost login) stays as the session's activity.
   */
  private markEnded(
    sessionId: string,
    exitCode: number | null,
    reason: string | null = null,
  ): Session | null {
    const session = this.ctx.repos.sessions.get(sessionId);
    this.revokeToken(sessionId);
    this.processProviders.delete(sessionId);
    if (!session || ENDED.has(session.state)) return null;
    const at = isoNow(this.ctx);
    const state: SessionState = exitCode !== null && exitCode !== 0 ? 'failed' : 'exited';
    const ended = this.ctx.repos.sessions.update(sessionId, {
      state,
      activity: reason,
      endedAt: at,
      lastActivityAt: at,
    })!;
    this.deps.timeline.append({
      projectKey: ended.projectKey,
      taskKey: ended.workItem.type === 'task' ? ended.workItem.taskKey : null,
      sessionId,
      actor: aiActor(ended.member),
      type: 'session_ended',
      data: { member: ended.member, exitCode, ...(reason ? { reason } : {}) },
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
        case 'state': {
          if (ENDED.has(event.state)) {
            this.markEnded(session.id, event.state === 'failed' ? 1 : null, event.activity);
            return;
          }
          // A late event from a process that already ended must not revive the session.
          if (ENDED.has(session.state) && !this.isRunning(session.id)) return;
          const updated = this.ctx.repos.sessions.update(session.id, {
            state: event.state,
            activity: event.activity,
            lastActivityAt: at,
          })!;
          this.publishSession(updated);
          this.recomputeMemberState(session.projectKey, session.member);
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
        case 'auth_error': {
          // The runner stops the session; its final state carries the message.
          this.ctx.logger.warn(
            { sessionId: session.id, provider: event.provider, message: event.message },
            'agent CLI lost its login',
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
