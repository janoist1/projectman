import { DEFAULT_AGENT_PROVIDER, routes } from '@projectman/shared';
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
  TeamMessage,
  WorkItemRef,
} from '@projectman/shared';
import { PROVIDER_NOT_LOGGED_IN } from '../contracts';
import type {
  ContextPackBuilder,
  MemberMemoryStore,
  RunnerEvent,
  SessionRunner,
  ToolContext,
  TranscriptReader,
  WorktreeManager,
} from '../contracts';
import { encodeWorkItem } from '../db';
import { isoNow } from './context';
import type { DomainContext } from './context';
import { conflict, DomainError, invalid, notFound } from './errors';
import type { MemberService } from './members';
import type { MessageService } from './messages';
import type { ConfigChange, ProjectService } from './projects';
import { allowedToolsFor, DONE_TASK_CLEANUP_DELAY_MS, usesWorktree } from './session-policy';
import { isOpenTask } from './tasks';
import type { TaskService } from './tasks';
import type { TimelineService } from './timeline';
import { aiActor, humanActor, KeyedMutex, newId, newToken, newUuid, SYSTEM_ACTOR } from './util';

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
  /** The Claude Code conversation was resumed (`--resume`). */
  resumed: boolean;
  /** A process was started (false when a running session was reused). */
  started: boolean;
}

export interface SessionOrchestratorDeps {
  ctx: DomainContext;
  projects: ProjectService;
  tasks: TaskService;
  members: MemberService;
  messages: MessageService;
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

/** Codex keeps conversations in rollout files; any other transcript is Claude Code's. */
function transcriptProvider(path: string): AgentProvider {
  return /(?:^|\/)rollout-[^/]*\.jsonl(?:\.zst)?$/.test(path) ? 'codex' : 'claude';
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
 * One Claude Code session per (AI member x work item). Starts, reuses and resumes
 * sessions through the runner, maps MCP tokens to tool contexts, and mirrors runner
 * events into the database and the event bus.
 */
export class SessionOrchestrator {
  private readonly deps: SessionOrchestratorDeps;
  private readonly ctx: DomainContext;
  private readonly locks = new KeyedMutex();
  private readonly tokens = new Map<string, ToolContext>();
  private readonly tokenBySession = new Map<string, string>();
  private readonly cleanupTimers = new Set<NodeJS.Timeout>();
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

  get(projectKey: string, sessionId: string): Session {
    const session = this.ctx.repos.sessions.get(sessionId);
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
   * Running -> reuse; exited -> resume the same Claude conversation; none -> create
   * (worktree or workspace cwd, context pack, MCP token, runner.start).
   */
  async ensureSession(
    projectKey: string,
    handle: string,
    workItem: WorkItemRef,
  ): Promise<EnsureSessionResult> {
    const wi = encodeWorkItem(workItem);
    return this.locks.run(`${projectKey}:${handle}:${wi.type}:${wi.ref}`, async () => {
      const config = await this.deps.projects.config(projectKey);
      const member = config.team.members.find((m) => m.handle === handle);
      if (!member) throw notFound('member', handle);
      if (member.kind !== 'ai') throw invalid('not_ai_member', `${handle} is not an AI member`);
      const task = workItem.type === 'task' ? this.deps.tasks.get(projectKey, workItem.taskKey) : null;
      const existing = this.ctx.repos.sessions.findByWorkItem(projectKey, handle, workItem);
      if (existing && this.isRunning(existing.id)) {
        return { session: existing, created: false, resumed: false, started: false };
      }
      return this.start(config, member, workItem, task, existing);
    });
  }

  /** Types a message into the session (queued by the runner until the session is idle). */
  deliver(session: Session, text: string, onDelivered?: () => void): void {
    Promise.resolve()
      .then(() => this.deps.runner.sendUserMessage(session.id, text))
      .then(
        () => onDelivered?.(),
        (err: unknown) => this.ctx.logger.warn({ err, sessionId: session.id }, 'could not deliver a message'),
      );
  }

  /** Delivers a message to a member's session for the work item, starting or resuming it. */
  async sendToMember(
    projectKey: string,
    handle: string,
    workItem: WorkItemRef,
    text: string,
    onDelivered?: () => void,
  ): Promise<Session> {
    const { session } = await this.ensureSession(projectKey, handle, workItem);
    this.deliver(session, text, onDelivered);
    return session;
  }

  /** A human writes into an AI session (plain text); recorded as a team message. */
  async sendHumanMessage(
    projectKey: string,
    sessionId: string,
    text: string,
    from: string,
  ): Promise<TeamMessage> {
    const session = this.get(projectKey, sessionId);
    const taskKey = session.workItem.type === 'task' ? session.workItem.taskKey : null;
    const target = this.isRunning(session.id)
      ? session
      : (await this.ensureSession(projectKey, session.member, session.workItem)).session;
    const message = this.deps.messages.record({
      projectKey,
      from,
      to: [session.member],
      taskKey,
      body: text,
      actor: humanActor(from),
      sessionId: session.id,
    });
    this.deliver(target, text, () => this.deps.messages.markDelivered(message.id));
    return message;
  }

  async stop(projectKey: string, sessionId: string): Promise<Session> {
    const session = this.get(projectKey, sessionId);
    if (this.isRunning(session.id)) await this.deps.runner.stop(session.id);
    return this.markEnded(session.id, null) ?? this.get(projectKey, sessionId);
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

  async detail(projectKey: string, sessionId: string): Promise<SessionDetail> {
    const session = this.get(projectKey, sessionId);
    let chat: ChatItem[] = [];
    if (session.transcriptPath) {
      try {
        chat = await this.deps.transcripts.read(session.transcriptPath, { self: session.member });
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
    if (!task || task.projectKey !== projectKey || isOpenTask(task)) return; // reopened meanwhile
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

  /** Config change listener: sessions of removed members are stopped. */
  async handleConfigChange(change: ConfigChange): Promise<void> {
    if (!change.previous) return;
    const remaining = new Set(change.next.team.members.map((m) => m.handle));
    for (const m of change.previous.team.members) {
      if (m.kind === 'ai' && !remaining.has(m.handle)) await this.stopMember(change.projectKey, m.handle);
    }
  }

  /** Startup: sessions do not survive a restart (their conversations do, via --resume). */
  reconcileAfterRestart(): void {
    const at = isoNow(this.ctx);
    for (const session of this.ctx.repos.sessions.listInStates(LIVE_SESSION_STATES)) {
      if (this.isRunning(session.id)) continue;
      this.ctx.repos.sessions.update(session.id, { state: 'exited', activity: null, endedAt: at });
    }
    for (const project of this.ctx.repos.projects.list()) {
      for (const state of this.ctx.repos.memberState.list(project.key)) {
        if (state.status !== 'retired' && state.status !== 'idle') {
          this.ctx.repos.memberState.upsert({ ...state, status: 'idle', activity: null, updatedAt: at });
        }
      }
    }
  }

  private async start(
    config: ProjectConfig,
    member: AiMemberConfig,
    workItem: WorkItemRef,
    task: Task | null,
    existing: Session | null,
  ): Promise<EnsureSessionResult> {
    const projectKey = config.project.key;
    const provider = member.provider ?? DEFAULT_AGENT_PROVIDER;
    // A CLI that is not logged in could only sit at its login screen: refuse before any work.
    await this.assertProviderReady(provider);
    let cwd = config.project.workspacePath;
    let branch: string | null = null;
    if (task?.repo && usesWorktree(member.role)) {
      // Code-changing roles work in the task's own worktree and branch; others in the workspace.
      try {
        const worktree = await this.deps.worktrees.ensureForTask({
          project: config,
          repoName: task.repo,
          taskKey: task.key,
          title: task.title,
        });
        cwd = worktree.path;
        branch = worktree.branch;
      } catch (err) {
        throw new DomainError(
          'session_start_failed',
          `could not prepare the worktree: ${(err as Error).message}`,
          { status: 502, details: { stage: 'worktree', reason: errorCode(err) } },
        );
      }
      const github = config.project.repos.find((r) => r.name === task.repo)?.github;
      this.deps.tasks.addLink(
        projectKey,
        task.key,
        { kind: 'branch', ref: branch, ...(github ? { repo: github } : {}) },
        SYSTEM_ACTOR,
      );
    }
    if (existing) {
      // Claude Code keeps conversations per working directory: resume where it started.
      cwd = existing.cwd;
      branch = existing.branch ?? branch;
    }

    const stage = task ? (config.pipeline.stages.find((s) => s.id === task.stageId) ?? null) : null;
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

    const at = isoNow(this.ctx);
    // Resume only a conversation that exists (the runner reported its transcript) and that
    // belongs to the member's current provider.
    const resume = Boolean(
      existing?.transcriptPath && transcriptProvider(existing.transcriptPath) === provider,
    );
    let session: Session;
    if (existing) {
      session = this.ctx.repos.sessions.update(existing.id, {
        state: 'starting',
        activity: null,
        cwd,
        branch,
        lastActivityAt: at,
        endedAt: null,
      })!;
    } else {
      session = {
        id: newId('ses'),
        projectKey,
        member: member.handle,
        workItem,
        claudeSessionId: newUuid(),
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

    try {
      const info = await this.deps.runner.start({
        sessionId: session.id,
        claudeSessionId: session.claudeSessionId,
        resume,
        cwd,
        member: member.handle,
        displayName: `${member.displayName} · ${workItemLabel(workItem, member)}`,
        model: member.model,
        permissionMode: member.permissionMode,
        appendSystemPrompt: pack.appendSystemPrompt,
        initialMessage: resume ? null : pack.initialMessage,
        mcpUrl: `${this.deps.publicBaseUrl}${routes.mcp(token)}`,
        allowedTools: allowedToolsFor(member.role),
        provider,
      });
      const current = this.ctx.repos.sessions.get(session.id);
      if (current?.state === 'starting' && info.state !== 'starting') {
        this.ctx.repos.sessions.update(session.id, { state: info.state });
      }
    } catch (err) {
      this.revokeToken(session.id);
      const failed = this.ctx.repos.sessions.update(session.id, {
        state: 'failed',
        endedAt: isoNow(this.ctx),
      });
      if (failed) this.publishSession(failed);
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
    return { session: fresh, created: !existing, resumed: resume, started: true };
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
          if (session.transcriptPath === event.path) return;
          this.publishSession(this.ctx.repos.sessions.update(session.id, { transcriptPath: event.path })!);
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
