import { realpath } from 'node:fs/promises';
import os from 'node:os';
import { posix as posixPath } from 'node:path';
import * as pty from '@lydell/node-pty';
import type { FastifyBaseLogger } from 'fastify';
import { MANAGED_VM_NO_LOCAL_APPROVAL } from '../contracts';
import type { PermissionBroker, RunnerEvent, RunningSessionInfo, StartSessionSpec } from '../contracts';
import type { HookPayload } from './hook-payload';
import { InputQueue } from './input-queue';
import { PermissionGate } from './permission-gate';
import type { ProviderAdapter, SessionTiming, TranscriptLineParser } from './providers/types';
import { nextState, type SessionSignal, type StateSnapshot } from './state';
import { HeadlessScreen } from './terminal';
import { toolActivity } from './tools';
import { TranscriptTailer } from './transcript/tailer';

/** Dialogs replace the prompt box at the end of the screen content: only look there. */
const DIALOG_ROWS = 15;

/** A conversation id of the agent CLIs (both use UUIDs). */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The pseudo-terminal process of a session: node-pty's IPty, or a fake in tests. */
export interface PtyProcess {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
}

export interface PtySpawnOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
}

/** Starts a process in a pseudo-terminal (node-pty's `spawn` by default). */
export type SpawnPty = (file: string, args: string[], options: PtySpawnOptions) => PtyProcess;

export interface SessionDeps {
  logger: FastifyBaseLogger;
  broker: PermissionBroker;
  permissionTimeoutMs: number;
  emit(event: RunnerEvent): void;
  /** Called as soon as the process has exited, before the final chat, state and exit events. */
  onExited(session: AgentSession): void;
  /** The CLI lost its login mid-session (before the session is stopped). */
  onAuthError?(session: AgentSession, message: string): void;
  /** Starts the process (default: node-pty). */
  spawnPty?: SpawnPty;
  /**
   * The worker home of a session started through the launcher (PM-140): `~` in a hook's
   * transcript path means this home, and a transcript anywhere else is ignored, so a worker
   * cannot make the server read a file of the server's or of another worker's.
   */
  transcriptRoot?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  private proc: PtyProcess | null = null;
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

  /** Messages waiting to be typed into the prompt. */
  private readonly input: InputQueue;
  private lastPromptAt = 0;
  /** Permission requests waiting for a human. */
  private readonly permissions: PermissionGate;

  private transcriptPath: string | null = null;
  private tailer: TranscriptTailer | null = null;
  private parser: TranscriptLineParser | null = null;
  /** The CLI's own conversation id, when it chooses it (Codex). */
  private providerSessionId: string | null = null;
  private authFailure: string | null = null;

  private readonly timers = new Set<NodeJS.Timeout>();
  private watchTimer: NodeJS.Timeout | null = null;

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
    this.input = new InputQueue({
      sessionId: this.id,
      timing: this.timing,
      logger: this.log,
      isIdle: () => !this.hasExited && this.ready && this.current.state === 'idle',
      checkBeforeTyping: () => this.checkBeforeTyping(),
      write: (data) => this.write(data),
    });
    this.permissions = new PermissionGate({
      sessionId: this.id,
      broker: this.deps.broker,
      timeoutMs: this.deps.permissionTimeoutMs,
      logger: this.log,
      remembersSessionAllows: !this.adapter.capabilities.sessionPermissionRules,
      answer: (decision, payload) => this.adapter.permissionOutput(decision, payload),
      deny: (message) => this.adapter.denyOutput(message),
      onWaiting: (activity) => this.apply({ kind: 'permission_request', activity }),
      onSettled: (pending) => this.apply({ kind: 'permission_resolved', pending }),
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
    const spawnPty: SpawnPty = this.deps.spawnPty ?? pty.spawn;
    this.attach(
      spawnPty(file, args, {
        name: 'xterm-256color',
        cols: this.screen.cols,
        rows: this.screen.rows,
        cwd: this.spec.cwd,
        env,
      }),
    );
  }

  /** Drives a process started elsewhere (the launcher's relayed terminal, PM-140). */
  attach(proc: PtyProcess): void {
    this.proc = proc;
    proc.onData((data) => {
      this.screen.write(data);
      this.deps.emit({ type: 'terminal_data', sessionId: this.id, data });
    });
    proc.onExit(({ exitCode, signal }) => void this.onExit(exitCode, signal ?? null));
    if (this.initialMessageSent) {
      // The CLI submits the brief itself; nothing is typed before it reports the prompt.
      this.input.awaitCommandLinePrompt(this.timing.argumentSubmitTimeoutMs);
    }
    this.startWatch();
    this.emitState();
  }

  /** The transcript file a hook names, or null when it lies outside the worker home. */
  private transcriptFile(raw: string): string | null {
    const root = this.deps.transcriptRoot;
    if (!root) return expandHome(raw);
    const file = posixPath.resolve(root, expandHome(raw, root));
    return file.startsWith(`${root}/`) ? file : null;
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
    return this.input.enqueue(text);
  }

  /**
   * Checked by the input queue right before it types: the TUI may not have enabled bracketed
   * paste yet, and until a first prompt got through, a start-up dialog (e.g. approving the
   * project's MCP servers) may cover the prompt box; typing would answer the dialog instead.
   */
  private checkBeforeTyping(): number | null {
    if (!this.screen.bracketedPasteMode && Date.now() - this.readyAt < this.timing.pasteModeGraceMs) {
      return 100;
    }
    if (!this.promptSeen) {
      const dialog = this.adapter.detectBlockingScreen(this.screen.screenText(DIALOG_ROWS));
      if (dialog) {
        this.blockedReason = dialog;
        this.apply({ kind: 'setup_prompt', description: dialog });
        this.startWatch();
        return null;
      }
    }
    return 0;
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
        if (payload.source === 'clear') this.input.submitted();
        this.input.schedule(first ? this.timing.readySettleMs : this.timing.stopSettleMs);
        this.apply({ kind: 'session_start', source: payload.source ?? null, first });
        return null;
      }
      case 'UserPromptSubmit':
        this.markReady();
        this.promptSeen = true;
        this.lastPromptAt = Date.now();
        this.input.submitted();
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
        this.input.schedule(this.timing.stopSettleMs);
        this.apply({
          kind: 'notification',
          type: payload.notification_type ?? null,
          message: payload.message ?? null,
        });
        return null;
      case 'Stop':
        this.input.schedule(this.timing.stopSettleMs);
        this.apply({ kind: 'stop' });
        return null;
      case 'StopFailure':
        this.input.schedule(this.timing.stopSettleMs);
        this.apply({ kind: 'stop_failure', error: typeof payload.error === 'string' ? payload.error : null });
        return null;
      case 'Interrupt':
        // Codex reports Esc with its own hook (Claude Code only in the transcript).
        this.input.schedule(this.timing.stopSettleMs);
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
    // The managed VM profile has no local approvals (PM-141): the CLI is started so that it asks
    // nothing, and a request that comes anyway is neither shown to a human nor judged by the
    // command rules; it is refused with the way forward, and the session carries on.
    if (this.spec.policy?.execution?.profile === 'managed_vm') {
      this.log.warn({ sessionId: this.id, toolName }, 'managed VM session asked for a local approval');
      return this.adapter.denyOutput(MANAGED_VM_NO_LOCAL_APPROVAL);
    }
    return this.permissions.request(payload, activity, withdrawn);
  }

  // ---------------------------------------------------------------- transcript

  /**
   * Follows the conversation's transcript. The path comes with every hook; it only changes
   * on a SessionStart (after /clear, /resume or a fork). Hooks fired inside a subagent are
   * ignored here, in case they ever carry the subagent's own transcript.
   */
  private noteTranscript(payload: HookPayload): void {
    if (!payload.transcript_path || payload.agent_id) return;
    const path = this.transcriptFile(payload.transcript_path);
    if (path === null) {
      this.log.warn({ sessionId: this.id }, 'ignored a transcript path outside the worker home');
      return;
    }
    if (path === this.transcriptPath) return;
    if (this.transcriptPath !== null && payload.hook_event_name !== 'SessionStart') return;
    const first = this.transcriptPath === null;
    const previous = this.transcriptPath;
    this.transcriptPath = path;
    const root = this.deps.transcriptRoot;
    if (root) {
      // A symlinked directory in the worker home must not lead the server elsewhere: the real
      // directory of the transcript (the file itself may not exist yet) must be in the real home.
      void Promise.all([realpath(posixPath.dirname(path)), realpath(root)])
        .then(([real, realRoot]) => {
          if (this.transcriptPath !== path || this.hasExited) return;
          if (real === realRoot || real.startsWith(`${realRoot}/`)) this.followTranscript(path, first);
          else this.log.warn({ sessionId: this.id }, 'ignored a transcript outside the worker home');
        })
        .catch(() => {
          // Its directory is not there yet: the next hook tries again.
          if (this.transcriptPath === path) this.transcriptPath = previous;
        });
      return;
    }
    this.followTranscript(path, first);
  }

  private followTranscript(path: string, first: boolean): void {
    this.deps.emit({ type: 'transcript_path', sessionId: this.id, path });
    // A worker's file is read only through the confined tailer (Codex plan usage reads it plainly).
    if (!this.deps.transcriptRoot) this.adapter.noteTranscript?.(path);
    this.tailer?.stop();
    const parser = this.adapter.createTranscriptParser({
      self: this.spec.member ?? null,
      cwd: this.spec.cwd,
      firstUserOrigin:
        first && this.spec.resume
          ? 'human'
          : (this.spec.firstUserOrigin ?? (this.spec.initialMessage ? 'brief' : 'human')),
    });
    this.parser = parser;
    // A resumed conversation's history is known already: follow only what comes next.
    const tailer = new TranscriptTailer({
      path,
      from: first && this.spec.resume ? 'end' : 'start',
      onLines: (lines) => this.onTranscriptLines(parser, lines),
      onError: (err) => this.log.warn({ err, sessionId: this.id }, 'transcript read failed'),
      ...(this.deps.transcriptRoot ? { confineTo: this.deps.transcriptRoot } : {}),
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
      this.input.schedule(this.timing.stopSettleMs);
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
      this.input.schedule(this.timing.readySettleMs);
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
      if (this.ready) this.input.schedule(this.timing.readySettleMs);
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
    this.permissions.close();
    this.input.close();

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
    if (next.state === 'idle') this.input.pump();
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

function expandHome(path: string, home: string = os.homedir()): string {
  return path === '~' || path.startsWith('~/') ? `${home}${path.slice(1)}` : path;
}
