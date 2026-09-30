import os from 'node:os';
import * as pty from '@lydell/node-pty';
import type { FastifyBaseLogger } from 'fastify';
import type {
  PermissionBroker,
  PermissionDecision,
  RunnerEvent,
  RunningSessionInfo,
  StartSessionSpec,
} from '../contracts';
import { sessionAllowScope, type HookPayload } from './hook-payload';
import { CLAUDE_TIMING } from './providers/claude';
import type { ProviderAdapter, SessionTiming, TranscriptLineParser } from './providers/types';
import { nextState, type SessionSignal, type StateSnapshot } from './state';
import { HeadlessScreen } from './terminal';
import { toolActivity } from './tools';
import { TranscriptTailer } from './transcript/tailer';
import { ENTER_KEY, messageKeystrokes } from './typing';

/** Timing of the interaction with Claude Code's TUI (other providers bring their own). */
export const TIMING: SessionTiming = CLAUDE_TIMING;

/** Dialogs replace the prompt box at the end of the screen content: only look there. */
const DIALOG_ROWS = 15;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const DENY_TIMEOUT =
  'No human answered this permission request in time, so it was denied. Continue without it, or ask a human for help.';
const DENY_FAILED = 'The permission request could not be processed, so it was denied.';

export interface SessionDeps {
  logger: FastifyBaseLogger;
  broker: PermissionBroker;
  permissionTimeoutMs: number;
  emit(event: RunnerEvent): void;
  /** Called as soon as the process has exited, before the final chat, state and exit events. */
  onExited(session: AgentSession): void;
  /** The CLI lost its login mid-session (before the session is stopped). */
  onAuthError?(session: AgentSession, message: string): void;
}

interface QueuedMessage {
  text: string;
  resolve(): void;
  reject(err: Error): void;
}

type PermissionEnd = 'timeout' | 'withdrawn' | 'session_exit';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * "Allow for this session" remembered by the runner, for CLIs that cannot be told to remember
 * it: the same Bash command again, or the same tool for other tools (see sessionAllowScope).
 */
function sessionAllowKey(payload: HookPayload): string | null {
  const scope = sessionAllowScope(payload);
  if (!scope) return null;
  return scope.command === undefined ? scope.toolName : `${scope.toolName}\u0000${scope.command}`;
}

/** One interactive agent CLI process (Claude Code or Codex) in a pseudo-terminal. */
export class AgentSession {
  readonly id: string;
  readonly spec: StartSessionSpec;
  readonly hookToken: string;
  readonly adapter: ProviderAdapter;
  readonly screen: HeadlessScreen;
  /** Resolves once the process has exited and every event has been emitted. */
  readonly exited: Promise<void>;

  private readonly deps: SessionDeps;
  private readonly log: FastifyBaseLogger;
  private readonly timing: SessionTiming;
  private proc: pty.IPty | null = null;
  private current: StateSnapshot = { state: 'starting', activity: null };
  private resolveExited!: () => void;
  private hasExited = false;
  private stopRequested = false;
  private readonly startedAt = Date.now();

  /** First SessionStart seen (or other proof that the prompt is up). */
  private ready = false;
  private readyAt = 0;
  /** A prompt reached the CLI (UserPromptSubmit): start-up dialogs are over. */
  private promptSeen = false;
  /** Why the session is flagged as blocked by a dialog in the terminal, if it is. */
  private blockedReason: string | null = null;
  /** The brief went on the command line: its submission is awaited before anything is typed. */
  private readonly initialMessageSent: boolean;

  private readonly queue: QueuedMessage[] = [];
  private typing = false;
  private notBefore = 0;
  private awaitingSubmit: { at: number; retries: number; command: boolean; timeoutMs: number } | null = null;
  private lastPromptAt = 0;

  private readonly pendingPermissions = new Map<AbortController, { end: PermissionEnd | null }>();
  /** Runner-side "allow for this session" answers (see sessionAllowKey). */
  private readonly sessionAllows = new Set<string>();

  private transcriptPath: string | null = null;
  private tailer: TranscriptTailer | null = null;
  private parser: TranscriptLineParser | null = null;
  /** The CLI's own conversation id, when it chooses it (Codex). */
  private providerSessionId: string | null = null;
  private authFailure: string | null = null;

  private readonly timers = new Set<NodeJS.Timeout>();
  private watchTimer: NodeJS.Timeout | null = null;
  private pumpTimer: NodeJS.Timeout | null = null;

  constructor(args: {
    spec: StartSessionSpec;
    hookToken: string;
    adapter: ProviderAdapter;
    deps: SessionDeps;
    /** The launch put the initial message on the command line. */
    initialMessageSent?: boolean;
  }) {
    this.spec = args.spec;
    this.id = args.spec.sessionId;
    this.hookToken = args.hookToken;
    this.adapter = args.adapter;
    this.timing = args.adapter.timing;
    this.deps = args.deps;
    this.log = args.deps.logger;
    this.initialMessageSent = args.initialMessageSent ?? false;
    // Known up front when we chose it (Claude) or resume it (both).
    if (this.adapter.capabilities.presetSessionId || args.spec.resume) {
      this.providerSessionId = args.spec.claudeSessionId.toLowerCase();
    }
    this.screen = new HeadlessScreen(args.spec.cols ?? 120, args.spec.rows ?? 40);
    this.exited = new Promise((resolve) => {
      this.resolveExited = resolve;
    });
    if (args.spec.initialMessage?.trim() && !this.initialMessageSent) {
      this.enqueue(args.spec.initialMessage).catch(() => undefined);
    }
  }

  get state(): StateSnapshot {
    return this.current;
  }

  get isRunning(): boolean {
    return !this.hasExited;
  }

  info(): RunningSessionInfo {
    return {
      sessionId: this.id,
      pid: this.proc?.pid ?? -1,
      state: this.current.state,
      cols: this.screen.cols,
      rows: this.screen.rows,
    };
  }

  /** Starts the process. Throws when it cannot be started. */
  spawn(file: string, args: string[], env: Record<string, string>): void {
    const proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: this.screen.cols,
      rows: this.screen.rows,
      cwd: this.spec.cwd,
      env,
    });
    this.proc = proc;
    proc.onData((data) => {
      this.screen.write(data);
      this.deps.emit({ type: 'terminal_data', sessionId: this.id, data });
    });
    proc.onExit(({ exitCode, signal }) => void this.onExit(exitCode, signal ?? null));
    if (this.initialMessageSent) {
      // The CLI submits the brief itself; nothing is typed before it reports the prompt.
      this.awaitingSubmit = {
        at: Date.now(),
        retries: 0,
        command: true,
        timeoutMs: this.timing.argumentSubmitTimeoutMs,
      };
      this.timer(() => this.checkSubmitted(), this.timing.enterRetryMs);
    }
    this.startWatch();
    this.emitState();
  }

  /** Parses a hook body for this session's CLI; null when malformed. */
  parseHook(body: unknown): HookPayload | null {
    return this.adapter.parseHook(body);
  }

  // ---------------------------------------------------------------- terminal

  write(data: string): void {
    this.proc?.write(data);
  }

  resize(cols: number, rows: number): void {
    const c = Math.max(20, Math.min(500, Math.floor(cols)));
    const r = Math.max(5, Math.min(300, Math.floor(rows)));
    if (c === this.screen.cols && r === this.screen.rows) return;
    try {
      this.proc?.resize(c, r);
    } catch {
      // the process may have exited in the meantime
    }
    this.screen.resize(c, r);
  }

  snapshot(): { data: string; cols: number; rows: number } {
    return { data: this.screen.snapshot(), cols: this.screen.cols, rows: this.screen.rows };
  }

  // ---------------------------------------------------------------- messages

  /** Queues a user message; it is typed when the session is idle. Resolves once typed. */
  enqueue(text: string): Promise<void> {
    if (this.hasExited) return Promise.reject(new Error(`Session ${this.id} is not running`));
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ text, resolve, reject });
      this.pump();
    });
  }

  private schedulePump(delayMs: number): void {
    this.notBefore = Math.max(this.notBefore, Date.now() + delayMs);
    if (this.pumpTimer) {
      clearTimeout(this.pumpTimer);
      this.timers.delete(this.pumpTimer);
    }
    this.pumpTimer = this.timer(() => {
      this.pumpTimer = null;
      this.pump();
    }, delayMs);
  }

  private pump(): void {
    if (this.hasExited || this.typing || this.queue.length === 0) return;
    if (!this.ready || this.current.state !== 'idle' || this.awaitingSubmit) return;
    const now = Date.now();
    if (now < this.notBefore) return this.schedulePump(this.notBefore - now);
    if (!this.screen.bracketedPasteMode && now - this.readyAt < this.timing.pasteModeGraceMs) {
      return this.schedulePump(100);
    }
    // Until a first prompt got through, a start-up dialog (e.g. approving the project's MCP
    // servers) may cover the prompt box; typing would answer the dialog instead.
    if (!this.promptSeen) {
      const dialog = this.adapter.detectBlockingScreen(this.screen.screenText(DIALOG_ROWS));
      if (dialog) {
        this.blockedReason = dialog;
        this.apply({ kind: 'setup_prompt', description: dialog });
        this.startWatch();
        return;
      }
    }
    const message = this.queue.shift()!;
    void this.type(message);
  }

  private async type(message: QueuedMessage): Promise<void> {
    this.typing = true;
    try {
      const steps = messageKeystrokes(message.text);
      if (steps.length === 0) {
        message.resolve();
        return;
      }
      for (const step of steps) {
        if (this.hasExited) throw new Error(`Session ${this.id} exited before the message was typed`);
        this.write(step);
        await sleep(this.timing.stepDelayMs);
      }
      await sleep(this.timing.enterDelayMs);
      if (this.hasExited) throw new Error(`Session ${this.id} exited before the message was typed`);
      this.write(ENTER_KEY);
      this.awaitingSubmit = {
        at: Date.now(),
        retries: 0,
        command: message.text.trim().startsWith('/'),
        timeoutMs: this.timing.submitTimeoutMs,
      };
      this.timer(() => this.checkSubmitted(), this.timing.enterRetryMs);
      message.resolve();
    } catch (err) {
      message.reject(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.typing = false;
    }
  }

  /** The CLI did not report the prompt yet: press Enter again, or stop waiting for it. */
  private checkSubmitted(): void {
    const pending = this.awaitingSubmit;
    if (!pending || this.hasExited) return;
    if (Date.now() - pending.at >= pending.timeoutMs) {
      this.log.warn({ sessionId: this.id }, 'typed message was not reported as submitted');
      this.awaitingSubmit = null;
      this.pump();
      return;
    }
    // A slash command reports no UserPromptSubmit and may open a dialog: never press Enter blindly.
    if (!pending.command && pending.retries < this.timing.maxEnterRetries && this.current.state === 'idle') {
      pending.retries += 1;
      this.write(ENTER_KEY);
    }
    this.timer(() => this.checkSubmitted(), this.timing.enterRetryMs);
  }

  // ---------------------------------------------------------------- hooks

  /**
   * Handles one hook call. Returns the JSON body to answer with, or null for an empty 200.
   * `withdrawn` aborts when the caller stops waiting (the HTTP request closed).
   */
  async handleHook(payload: HookPayload, withdrawn: AbortSignal): Promise<unknown> {
    if (this.hasExited) return null;
    const subagent = this.adapter.isSubagentHook(payload);
    this.noteTranscript(payload);
    if (!subagent) this.noteProviderSessionId(payload);
    const authError = this.adapter.hookAuthError(payload);
    if (authError) {
      this.authFailed(authError);
      return null;
    }
    // A subagent's approval still needs an answer; its other hooks say nothing about the session.
    if (subagent && payload.hook_event_name !== 'PermissionRequest') return null;
    // The typing delay is set before any transition to idle, which starts the queue.
    switch (payload.hook_event_name) {
      case 'SessionStart': {
        const first = !this.ready;
        this.markReady();
        if (payload.source === 'clear') this.awaitingSubmit = null;
        this.schedulePump(first ? this.timing.readySettleMs : this.timing.stopSettleMs);
        this.apply({ kind: 'session_start', source: payload.source ?? null, first });
        return null;
      }
      case 'UserPromptSubmit':
        this.markReady();
        this.promptSeen = true;
        this.lastPromptAt = Date.now();
        this.awaitingSubmit = null;
        this.apply({ kind: 'prompt_submit' });
        return null;
      case 'PreToolUse': {
        const name = payload.tool_name ?? 'tool';
        this.apply({
          kind: 'pre_tool',
          activity: toolActivity(name, payload.tool_input, this.spec.cwd),
          needsInput: this.adapter.inputTools.has(name),
        });
        return null;
      }
      case 'PostToolUse':
      case 'PostToolUseFailure':
        this.apply({ kind: 'post_tool' });
        return null;
      case 'PermissionRequest':
        return this.permissionRequest(payload, withdrawn);
      case 'Notification':
        this.schedulePump(this.timing.stopSettleMs);
        this.apply({
          kind: 'notification',
          type: payload.notification_type ?? null,
          message: payload.message ?? null,
        });
        return null;
      case 'Stop':
        this.schedulePump(this.timing.stopSettleMs);
        this.apply({ kind: 'stop' });
        return null;
      case 'StopFailure':
        this.schedulePump(this.timing.stopSettleMs);
        this.apply({ kind: 'stop_failure', error: typeof payload.error === 'string' ? payload.error : null });
        return null;
      case 'Interrupt':
        // Codex reports Esc with its own hook (Claude Code only in the transcript).
        this.schedulePump(this.timing.stopSettleMs);
        this.apply({ kind: 'interrupted' });
        return null;
      default:
        return null;
    }
  }

  private markReady(): void {
    if (this.ready) return;
    this.ready = true;
    this.readyAt = Date.now();
    this.blockedReason = null;
    this.stopWatch();
  }

  /** A CLI that picks its own conversation id reports it with every hook (Codex). */
  private noteProviderSessionId(payload: HookPayload): void {
    if (this.adapter.capabilities.presetSessionId) return;
    const id = payload.session_id?.toLowerCase();
    if (!id || id === this.providerSessionId) return;
    if (!UUID_RE.test(id)) {
      this.log.warn({ sessionId: this.id, providerSessionId: id }, 'unexpected conversation id from a hook');
      return;
    }
    this.providerSessionId = id;
    this.deps.emit({ type: 'provider_session_id', sessionId: this.id, providerSessionId: id });
  }

  private async permissionRequest(payload: HookPayload, withdrawn: AbortSignal): Promise<unknown> {
    const toolName = payload.tool_name ?? 'unknown';
    const activity = toolActivity(toolName, payload.tool_input, this.spec.cwd);
    if (this.adapter.inputTools.has(toolName)) {
      // A question for whoever is at the terminal: the CLI shows its own dialog.
      this.apply({ kind: 'pre_tool', activity, needsInput: true });
      return null;
    }
    const allowKey = this.adapter.capabilities.sessionPermissionRules ? null : sessionAllowKey(payload);
    if (allowKey && this.sessionAllows.has(allowKey)) {
      return this.adapter.permissionOutput({ behavior: 'allow' }, payload);
    }

    const controller = new AbortController();
    const entry: { end: PermissionEnd | null } = { end: null };
    this.pendingPermissions.set(controller, entry);
    const end = (reason: PermissionEnd) => {
      if (entry.end) return;
      entry.end = reason;
      controller.abort(new Error(`permission request ended: ${reason}`));
    };
    const timeout = setTimeout(() => end('timeout'), this.deps.permissionTimeoutMs);
    const onWithdrawn = () => end('withdrawn');
    if (withdrawn.aborted) onWithdrawn();
    else withdrawn.addEventListener('abort', onWithdrawn, { once: true });
    this.apply({ kind: 'permission_request', activity });

    try {
      const decision = await new Promise<PermissionDecision>((resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
        this.deps.broker
          .decide(
            { sessionId: this.id, toolName, toolInput: payload.tool_input ?? null, raw: payload },
            controller.signal,
          )
          .then(resolve, reject);
      });
      if (controller.signal.aborted || this.hasExited) return null;
      if (allowKey && decision.behavior === 'allow' && decision.rememberForSession) {
        this.sessionAllows.add(allowKey);
      }
      return this.adapter.permissionOutput(decision, payload);
    } catch (err) {
      if (entry.end === 'timeout') return this.adapter.denyOutput(DENY_TIMEOUT);
      if (entry.end) return null; // nobody is waiting for the answer any more
      this.log.error({ err, sessionId: this.id, toolName }, 'permission broker failed');
      return this.adapter.denyOutput(DENY_FAILED);
    } finally {
      clearTimeout(timeout);
      withdrawn.removeEventListener('abort', onWithdrawn);
      this.pendingPermissions.delete(controller);
      this.apply({ kind: 'permission_resolved', pending: this.pendingPermissions.size });
    }
  }

  // ---------------------------------------------------------------- transcript

  /**
   * Follows the conversation's transcript. The path comes with every hook; it only changes
   * on a SessionStart (after /clear, /resume or a fork). Hooks fired inside a subagent are
   * ignored here, in case they ever carry the subagent's own transcript.
   */
  private noteTranscript(payload: HookPayload): void {
    if (!payload.transcript_path || payload.agent_id) return;
    const path = expandHome(payload.transcript_path);
    if (path === this.transcriptPath) return;
    if (this.transcriptPath !== null && payload.hook_event_name !== 'SessionStart') return;
    const first = this.transcriptPath === null;
    this.transcriptPath = path;
    this.deps.emit({ type: 'transcript_path', sessionId: this.id, path });
    this.adapter.noteTranscript?.(path);
    this.tailer?.stop();
    const parser = this.adapter.createTranscriptParser({
      self: this.spec.member ?? null,
      cwd: this.spec.cwd,
      firstUserOrigin: first && this.spec.resume ? 'human' : this.spec.initialMessage ? 'brief' : 'human',
    });
    this.parser = parser;
    // A resumed conversation's history is known already: follow only what comes next.
    const tailer = new TranscriptTailer({
      path,
      from: first && this.spec.resume ? 'end' : 'start',
      onLines: (lines) => this.onTranscriptLines(parser, lines),
      onError: (err) => this.log.warn({ err, sessionId: this.id }, 'transcript read failed'),
    });
    this.tailer = tailer;
    void tailer.start();
  }

  private onTranscriptLines(parser: TranscriptLineParser, lines: string[]): void {
    if (parser !== this.parser) return;
    const { items, interruptedAt, authError } = parser.parseLines(lines);
    if (items.length > 0) this.deps.emit({ type: 'chat', sessionId: this.id, items });
    if (authError) {
      this.authFailed(authError);
      return;
    }
    // Esc during a turn ends it without a Stop hook; the transcript records the interruption.
    if (interruptedAt && Date.parse(interruptedAt) >= this.lastPromptAt && !this.hasExited) {
      this.schedulePump(this.timing.stopSettleMs);
      this.apply({ kind: 'interrupted' });
    }
  }

  // ---------------------------------------------------------------- login failures

  /**
   * The CLI lost its login mid-session: it can only sit idle now. The session is reported,
   * marked failed with the CLI's message and stopped; a later message resumes the
   * conversation once the owner has logged in again.
   */
  private authFailed(message: string): void {
    if (this.authFailure !== null || this.hasExited) return;
    this.authFailure = message;
    this.log.warn(
      { sessionId: this.id, provider: this.adapter.provider, message },
      'agent CLI lost its login',
    );
    this.deps.onAuthError?.(this, message);
    this.deps.emit({ type: 'auth_error', sessionId: this.id, provider: this.adapter.provider, message });
    this.apply({ kind: 'auth_failed', message });
    void this.stop(false);
  }

  // ---------------------------------------------------------------- blocking dialogs

  private startWatch(): void {
    if (this.watchTimer || this.hasExited) return;
    this.watchTimer = setInterval(() => this.checkScreen(), this.timing.startupCheckMs);
  }

  private stopWatch(): void {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
  }

  /**
   * Runs while starting (first-run screens, no readiness for too long, or, for CLIs whose
   * readiness shows on screen, the prompt appearing) and while a start-up dialog blocks the
   * first message: flags the session as waiting for input in the terminal, and lets it
   * continue once the dialog is gone.
   */
  private checkScreen(): void {
    if (this.hasExited) return this.stopWatch();
    if (
      !this.ready &&
      this.adapter.capabilities.readiness === 'screen' &&
      this.adapter.promptVisible(this.screen.screenText(DIALOG_ROWS))
    ) {
      this.markReady();
      this.schedulePump(this.timing.readySettleMs);
      this.apply({ kind: 'session_start', source: null, first: true });
      return;
    }
    const dialog = this.adapter.detectBlockingScreen(
      this.ready ? this.screen.screenText(DIALOG_ROWS) : this.screen.screenText(),
    );
    const stalled = !this.ready && Date.now() - this.startedAt > this.timing.startupTimeoutMs;
    const reason =
      dialog ?? (stalled ? `${this.adapter.label} has not become ready; check the terminal` : null);
    if (reason) {
      if (reason !== this.blockedReason) {
        this.blockedReason = reason;
        this.apply({ kind: 'setup_prompt', description: reason });
      }
      return;
    }
    if (this.blockedReason) {
      this.blockedReason = null;
      if (this.ready) this.schedulePump(this.timing.readySettleMs);
      this.apply({ kind: 'setup_cleared', ready: this.ready });
    }
    if (this.ready) this.stopWatch();
  }

  // ---------------------------------------------------------------- stop / exit

  /** Graceful stop (SIGTERM, then SIGKILL after a timeout), or an immediate kill. */
  async stop(force = false): Promise<void> {
    if (this.hasExited) return this.exited;
    this.stopRequested = true;
    this.kill(force ? 'SIGKILL' : 'SIGTERM');
    if (!force) this.timer(() => this.kill('SIGKILL'), this.timing.stopTimeoutMs);
    return this.exited;
  }

  private kill(signal: 'SIGTERM' | 'SIGKILL'): void {
    if (this.hasExited || !this.proc) return;
    try {
      this.proc.kill(signal);
    } catch {
      // already gone
    }
  }

  private async onExit(exitCode: number, signal: number | null): Promise<void> {
    if (this.hasExited) return;
    this.hasExited = true;
    this.deps.onExited(this);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.stopWatch();

    for (const [controller, entry] of this.pendingPermissions) {
      if (!entry.end) {
        entry.end = 'session_exit';
        controller.abort(new Error('session exited'));
      }
    }
    for (const message of this.queue.splice(0)) {
      message.reject(new Error(`Session ${this.id} exited before the message was typed`));
    }

    // Pick up the last transcript lines before announcing the exit.
    const tailer = this.tailer;
    if (tailer) {
      await Promise.race([tailer.poll(), sleep(this.timing.finalReadMs)]);
      tailer.stop();
    }

    const failed = !this.stopRequested && (exitCode !== 0 || (signal ?? 0) !== 0);
    // Leave a trace in the terminal, so its snapshot shows why the session is gone.
    const note = `\r\n\x1b[2m[session ended: exit code ${exitCode}${signal ? `, signal ${signal}` : ''}]\x1b[0m\r\n`;
    this.screen.write(note);
    this.deps.emit({ type: 'terminal_data', sessionId: this.id, data: note });
    if (!this.ready)
      this.log.warn(
        { sessionId: this.id, exitCode, signal, provider: this.adapter.provider },
        'agent CLI exited before it was ready',
      );
    this.apply({ kind: 'exit', failed });
    this.deps.emit({ type: 'exit', sessionId: this.id, exitCode, signal: signal || null });
    this.proc = null;
    this.resolveExited();
  }

  /** Frees the headless terminal (after the session is no longer needed for snapshots). */
  dispose(): void {
    this.screen.dispose();
  }

  // ---------------------------------------------------------------- helpers

  private apply(signal: SessionSignal): void {
    // Once the process is gone only the final exit transition may change the state.
    if (this.hasExited && signal.kind !== 'exit') return;
    const next = nextState(this.current, signal);
    if (next.state === this.current.state && next.activity === this.current.activity) return;
    this.current = next;
    this.emitState();
    if (next.state === 'idle') this.pump();
  }

  private emitState(): void {
    this.deps.emit({
      type: 'state',
      sessionId: this.id,
      state: this.current.state,
      activity: this.current.activity,
    });
  }

  private timer(fn: () => void, ms: number): NodeJS.Timeout {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
    return t;
  }
}

/** The session class under its original name (Claude Code was the first provider). */
export type ClaudeSession = AgentSession;

function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? `${os.homedir()}${path.slice(1)}` : path;
}
