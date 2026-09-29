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
import type { HookPayload, PermissionHookOutput, PermissionUpdate } from './hook-payload';
import { sessionPermissionUpdates } from './hook-payload';
import { nextState, type SessionSignal, type StateSnapshot } from './state';
import { HeadlessScreen } from './terminal';
import { INPUT_TOOLS, toolActivity } from './tools';
import { TranscriptParser } from './transcript/parser';
import { TranscriptTailer } from './transcript/tailer';
import { ENTER_KEY, messageKeystrokes } from './typing';

/** Timing of the interaction with the TUI. */
export const TIMING = {
  /** Pause after the first SessionStart before typing (the prompt box finishes mounting). */
  readySettleMs: 400,
  /** Typing waits this long at most for the TUI to enable bracketed paste. */
  pasteModeGraceMs: 3_000,
  /** Pause after Stop before typing the next queued message. */
  stopSettleMs: 150,
  /** Pause between the writes that make up one message. */
  stepDelayMs: 12,
  /** Pause between the last text and Enter (agent-office uses 120 ms). */
  enterDelayMs: 120,
  /** Enter is pressed again if Claude Code did not report the prompt (an autocomplete ate it). */
  enterRetryMs: 1_500,
  maxEnterRetries: 2,
  /** A typed message that never produced UserPromptSubmit stops blocking the queue after this. */
  submitTimeoutMs: 8_000,
  /** How often the screen is checked for blocking dialogs (while starting, or while one is up). */
  startupCheckMs: 1_000,
  /** Without SessionStart after this long, the session is flagged as needing a look. */
  startupTimeoutMs: 20_000,
  /** Graceful stop: SIGTERM, then SIGKILL after this long. */
  stopTimeoutMs: 5_000,
  /** Exit waits this long at most for the last transcript lines. */
  finalReadMs: 1_000,
};

/**
 * Dialogs that block a session: first-run screens before it can take input, and prompts that
 * can appear around start-up (approving a project's MCP servers). Texts as of Claude Code
 * 2.1.223; the first patterns follow agent-office (MIT, src/server/workers.ts).
 */
const BLOCKING_SCREENS: Array<[RegExp, string]> = [
  [
    /Quick safety check|trust this folder|Do you trust the files/i,
    'Workspace trust confirmation is waiting in the terminal',
  ],
  [
    /Select login method|Not logged in|Please run \/login/i,
    'Claude Code is not logged in; log in from the terminal',
  ],
  [/Choose the text style/i, 'Claude Code first-run setup is waiting in the terminal'],
  [/Bypass Permissions mode/i, 'Bypass permissions confirmation is waiting in the terminal'],
  [/MCP servers? found in this project/i, 'Approval of project MCP servers is waiting in the terminal'],
  [/Do you want to use this API key/i, 'API key confirmation is waiting in the terminal'],
  [/Press Enter to continue/i, 'Claude Code is waiting for Enter in the terminal'],
];

/** Dialogs replace the prompt box at the end of the screen content: only look there. */
const DIALOG_ROWS = 15;

export function detectBlockingScreen(text: string): string | null {
  for (const [pattern, description] of BLOCKING_SCREENS) if (pattern.test(text)) return description;
  return null;
}

const DENY_TIMEOUT =
  'No human answered this permission request in time, so it was denied. Continue without it, or ask a human for help.';
const DENY_FAILED = 'The permission request could not be processed, so it was denied.';
const DENY_DEFAULT = 'A human denied this permission request.';

export interface SessionDeps {
  logger: FastifyBaseLogger;
  broker: PermissionBroker;
  permissionTimeoutMs: number;
  emit(event: RunnerEvent): void;
  /** Called as soon as the process has exited, before the final chat, state and exit events. */
  onExited(session: ClaudeSession): void;
}

interface QueuedMessage {
  text: string;
  resolve(): void;
  reject(err: Error): void;
}

type PermissionEnd = 'timeout' | 'withdrawn' | 'session_exit';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One interactive Claude Code process in a pseudo-terminal. */
export class ClaudeSession {
  readonly id: string;
  readonly spec: StartSessionSpec;
  readonly hookToken: string;
  readonly screen: HeadlessScreen;
  /** Resolves once the process has exited and every event has been emitted. */
  readonly exited: Promise<void>;

  private readonly deps: SessionDeps;
  private readonly log: FastifyBaseLogger;
  private proc: pty.IPty | null = null;
  private current: StateSnapshot = { state: 'starting', activity: null };
  private resolveExited!: () => void;
  private hasExited = false;
  private stopRequested = false;
  private readonly startedAt = Date.now();

  /** First SessionStart seen (or other proof that the prompt is up). */
  private ready = false;
  private readyAt = 0;
  /** A prompt reached Claude (UserPromptSubmit): start-up dialogs are over. */
  private promptSeen = false;
  /** Why the session is flagged as blocked by a dialog in the terminal, if it is. */
  private blockedReason: string | null = null;

  private readonly queue: QueuedMessage[] = [];
  private typing = false;
  private notBefore = 0;
  private awaitingSubmit: { at: number; retries: number; command: boolean } | null = null;
  private lastPromptAt = 0;

  private readonly pendingPermissions = new Map<AbortController, { end: PermissionEnd | null }>();

  private transcriptPath: string | null = null;
  private tailer: TranscriptTailer | null = null;
  private parser: TranscriptParser | null = null;

  private readonly timers = new Set<NodeJS.Timeout>();
  private watchTimer: NodeJS.Timeout | null = null;
  private pumpTimer: NodeJS.Timeout | null = null;

  constructor(args: { spec: StartSessionSpec; hookToken: string; deps: SessionDeps }) {
    this.spec = args.spec;
    this.id = args.spec.sessionId;
    this.hookToken = args.hookToken;
    this.deps = args.deps;
    this.log = args.deps.logger;
    this.screen = new HeadlessScreen(args.spec.cols ?? 120, args.spec.rows ?? 40);
    this.exited = new Promise((resolve) => {
      this.resolveExited = resolve;
    });
    if (args.spec.initialMessage?.trim()) this.enqueue(args.spec.initialMessage).catch(() => undefined);
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
    this.startWatch();
    this.emitState();
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
    if (!this.screen.bracketedPasteMode && now - this.readyAt < TIMING.pasteModeGraceMs) {
      return this.schedulePump(100);
    }
    // Until a first prompt got through, a start-up dialog (e.g. approving the project's MCP
    // servers) may cover the prompt box; typing would answer the dialog instead.
    if (!this.promptSeen) {
      const dialog = detectBlockingScreen(this.screen.screenText(DIALOG_ROWS));
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
        await sleep(TIMING.stepDelayMs);
      }
      await sleep(TIMING.enterDelayMs);
      if (this.hasExited) throw new Error(`Session ${this.id} exited before the message was typed`);
      this.write(ENTER_KEY);
      this.awaitingSubmit = { at: Date.now(), retries: 0, command: message.text.trim().startsWith('/') };
      this.timer(() => this.checkSubmitted(), TIMING.enterRetryMs);
      message.resolve();
    } catch (err) {
      message.reject(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.typing = false;
    }
  }

  /** Claude Code did not report the prompt yet: press Enter again, or stop waiting for it. */
  private checkSubmitted(): void {
    const pending = this.awaitingSubmit;
    if (!pending || this.hasExited) return;
    if (Date.now() - pending.at >= TIMING.submitTimeoutMs) {
      this.log.warn({ sessionId: this.id }, 'typed message was not reported as submitted');
      this.awaitingSubmit = null;
      this.pump();
      return;
    }
    // A slash command reports no UserPromptSubmit and may open a dialog: never press Enter blindly.
    if (!pending.command && pending.retries < TIMING.maxEnterRetries && this.current.state === 'idle') {
      pending.retries += 1;
      this.write(ENTER_KEY);
    }
    this.timer(() => this.checkSubmitted(), TIMING.enterRetryMs);
  }

  // ---------------------------------------------------------------- hooks

  /**
   * Handles one hook call. Returns the JSON body to answer with, or null for an empty 200.
   * `withdrawn` aborts when the caller stops waiting (the HTTP request closed).
   */
  async handleHook(payload: HookPayload, withdrawn: AbortSignal): Promise<PermissionHookOutput | null> {
    if (this.hasExited) return null;
    this.noteTranscript(payload);
    // The typing delay is set before any transition to idle, which starts the queue.
    switch (payload.hook_event_name) {
      case 'SessionStart': {
        const first = !this.ready;
        this.markReady();
        if (payload.source === 'clear') this.awaitingSubmit = null;
        this.schedulePump(first ? TIMING.readySettleMs : TIMING.stopSettleMs);
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
          needsInput: INPUT_TOOLS.has(name),
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
        this.schedulePump(TIMING.stopSettleMs);
        this.apply({
          kind: 'notification',
          type: payload.notification_type ?? null,
          message: payload.message ?? null,
        });
        return null;
      case 'Stop':
        this.schedulePump(TIMING.stopSettleMs);
        this.apply({ kind: 'stop' });
        return null;
      case 'StopFailure':
        this.schedulePump(TIMING.stopSettleMs);
        this.apply({ kind: 'stop_failure', error: typeof payload.error === 'string' ? payload.error : null });
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

  private async permissionRequest(
    payload: HookPayload,
    withdrawn: AbortSignal,
  ): Promise<PermissionHookOutput | null> {
    const toolName = payload.tool_name ?? 'unknown';
    const activity = toolActivity(toolName, payload.tool_input, this.spec.cwd);
    if (INPUT_TOOLS.has(toolName)) {
      // A question for whoever is at the terminal: Claude Code shows its own dialog.
      this.apply({ kind: 'pre_tool', activity, needsInput: true });
      return null;
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
      return permissionOutput(decision, payload);
    } catch (err) {
      if (entry.end === 'timeout') return denyOutput(DENY_TIMEOUT);
      if (entry.end) return null; // nobody is waiting for the answer any more
      this.log.error({ err, sessionId: this.id, toolName }, 'permission broker failed');
      return denyOutput(DENY_FAILED);
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
    this.tailer?.stop();
    const parser = new TranscriptParser({ self: this.spec.member ?? null, cwd: this.spec.cwd });
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

  private onTranscriptLines(parser: TranscriptParser, lines: string[]): void {
    if (parser !== this.parser) return;
    const { items, interruptedAt } = parser.parseLines(lines);
    if (items.length > 0) this.deps.emit({ type: 'chat', sessionId: this.id, items });
    // Esc during a turn ends it without a Stop hook; the transcript records the interruption.
    if (interruptedAt && Date.parse(interruptedAt) >= this.lastPromptAt && !this.hasExited) {
      this.schedulePump(TIMING.stopSettleMs);
      this.apply({ kind: 'interrupted' });
    }
  }

  // ---------------------------------------------------------------- blocking dialogs

  private startWatch(): void {
    if (this.watchTimer || this.hasExited) return;
    this.watchTimer = setInterval(() => this.checkScreen(), TIMING.startupCheckMs);
  }

  private stopWatch(): void {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
  }

  /**
   * Runs while starting (first-run screens, or no SessionStart for too long) and while a
   * start-up dialog blocks the first message: flags the session as waiting for input in the
   * terminal, and lets it continue once the dialog is gone.
   */
  private checkScreen(): void {
    if (this.hasExited) return this.stopWatch();
    const dialog = detectBlockingScreen(
      this.ready ? this.screen.screenText(DIALOG_ROWS) : this.screen.screenText(),
    );
    const stalled = !this.ready && Date.now() - this.startedAt > TIMING.startupTimeoutMs;
    const reason = dialog ?? (stalled ? 'Claude Code has not become ready; check the terminal' : null);
    if (reason) {
      if (reason !== this.blockedReason) {
        this.blockedReason = reason;
        this.apply({ kind: 'setup_prompt', description: reason });
      }
      return;
    }
    if (this.blockedReason) {
      this.blockedReason = null;
      if (this.ready) this.schedulePump(TIMING.readySettleMs);
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
    if (!force) this.timer(() => this.kill('SIGKILL'), TIMING.stopTimeoutMs);
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
      await Promise.race([tailer.poll(), sleep(TIMING.finalReadMs)]);
      tailer.stop();
    }

    const failed = !this.stopRequested && (exitCode !== 0 || (signal ?? 0) !== 0);
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

function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? `${os.homedir()}${path.slice(1)}` : path;
}

function denyOutput(message: string): PermissionHookOutput {
  return {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message } },
  };
}

/** The documented PermissionRequest decision JSON for a broker decision. */
export function permissionOutput(decision: PermissionDecision, payload: HookPayload): PermissionHookOutput {
  if (decision.behavior === 'deny') return denyOutput(decision.message?.trim() || DENY_DEFAULT);
  const allow: { behavior: 'allow'; updatedInput?: unknown; updatedPermissions?: PermissionUpdate[] } = {
    behavior: 'allow',
  };
  // Claude Code only accepts an object here; anything else would void the whole decision.
  const input = decision.updatedInput;
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) allow.updatedInput = input;
  if (decision.rememberForSession) {
    const updates = sessionPermissionUpdates(payload);
    if (updates.length > 0) allow.updatedPermissions = updates;
  }
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: allow } };
}
