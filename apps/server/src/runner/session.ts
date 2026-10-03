import { realpath } from 'node:fs/promises';
import os from 'node:os';
import { posix as posixPath } from 'node:path';
import * as pty from '@lydell/node-pty';
import type { FastifyBaseLogger } from 'fastify';
import { COMPACTING_PROVIDERS, MANAGED_VM_NO_LOCAL_APPROVAL } from '../contracts';
import type {
  PauseOptions,
  PauseOutcome,
  PermissionBroker,
  RunnerEvent,
  RunningSessionInfo,
  StartSessionSpec,
} from '../contracts';
import type { HookPayload } from './hook-payload';
import { InputQueue } from './input-queue';
import { PAUSED_AFTER_TOOL, PAUSED_BEFORE_TOOL, PauseState } from './pause';
import { PermissionGate } from './permission-gate';
import type { ProviderAdapter, SessionTiming, TranscriptLineParser } from './providers/types';
import { nextState, type SessionSignal, type StateSnapshot } from './state';
import { HeadlessScreen } from './terminal';
import { toolActivity } from './tools';
import { readTranscriptText } from './transcript/reader';
import { TranscriptTailer } from './transcript/tailer';

/** Dialogs replace the prompt box at the end of the screen content: only look there. */
const DIALOG_ROWS = 15;

/** What the agent is told when its terminal question was sent to the humans' inbox instead (PM-199). */
const QUESTION_FORWARDED =
  'Nobody reads this terminal, so the question was sent to the humans in the team inbox. The answer arrives later as a team message. Do not ask it again and do not wait here: carry on with what does not depend on the answer, or finish your turn. Next time ask with the ask_human tool.';

/** The key that interrupts a turn in both CLIs. */
const ESC = '\x1b';

/** What a pause reports for a session that is not running. */
const EXITED: PauseOutcome = { point: 'exited', tool: null };

/** A conversation id of the agent CLIs (both use UUIDs). */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A compaction asked for: queued behind the messages before it, typed (PreCompact awaited, at most
 * `compactStartTimeoutMs`), then started (PostCompact awaited, at most `compactTimeoutMs`).
 */
interface Compaction {
  phase: 'queued' | 'typed' | 'started';
  timer: NodeJS.Timeout | null;
}

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
  /** The compaction the server asked for, until PostCompact or until it is given up (PM-213). */
  private compaction: Compaction | null = null;
  /** Tool calls whose questions went to the inbox already (see forwardQuestion). */
  private readonly forwardedQuestions = new Set<string>();
  private watchTimer: NodeJS.Timeout | null = null;

  /** The pause asked for, until it is released (PM-218). */
  private pauseState: PauseState | null = null;
  /** The main agent's running tools, by call id: what a pause waits for. */
  private readonly runningTools = new Map<string, string>();
  private toolSeq = 0;
  /** The main agent's tool the session last waited for an approval or an answer on. */
  private waitingTool: string | null = null;
  /** Callers of `interrupt` awaiting the confirmation of the Esc. */
  private readonly interruptWaiters = new Set<(confirmed: boolean) => void>();

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
      // A typed compaction command that has not started yet holds the queue back: a message typed
      // behind a swallowed command would start a turn the give-up must not mistake for idleness.
      isIdle: () =>
        !this.hasExited && this.ready && this.current.state === 'idle' && this.compaction?.phase !== 'typed',
      checkBeforeTyping: () => this.checkBeforeTyping(),
      write: (data) => this.write(data),
      onChange: () => this.evaluatePause(),
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
    // A resumed conversation that owes a compaction gets it before the message that woke it (PM-213).
    if (args.spec.compactFirst) void this.compact(args.spec.compactFirst);
    if (args.spec.initialMessage?.trim() && !this.initialMessageSent) {
      this.enqueue(args.spec.initialMessage).then(
        () => this.deps.emit({ type: 'first_input_sent', sessionId: this.id }),
        () => undefined,
      );
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
      this.deps.emit({ type: 'first_input_sent', sessionId: this.id });
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

  /** A message is still on its way to the agent (queued, being typed, or not yet submitted). */
  get hasPendingInput(): boolean {
    return this.input.hasPending;
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

  // ---------------------------------------------------------------- compaction

  /**
   * Compacts the conversation (PM-213): types `/compact <instruction>` once the session is idle,
   * after the messages already queued. Typed, the session is working until PostCompact, so nothing
   * is typed over it. If the CLI does not report the start (a dialog, an autocomplete) or the end
   * in time, the compaction is given up: logged, announced, and the session takes messages again.
   * False when the provider has no such command or a compaction is on its way already.
   */
  async compact(instruction: string): Promise<boolean> {
    if (this.hasExited || this.compaction || !COMPACTING_PROVIDERS.has(this.adapter.provider)) return false;
    const compaction: Compaction = { phase: 'queued', timer: null };
    this.compaction = compaction;
    try {
      await this.input.enqueue(`/compact ${instruction.replace(/\s+/g, ' ').trim()}`);
    } catch {
      // The process ended before the command was typed: nothing to give up.
      if (this.compaction === compaction) this.compaction = null;
      return false;
    }
    // A PreCompact hook that came before this resolved is the start already.
    if (this.compaction === compaction && compaction.phase === 'queued') {
      compaction.phase = 'typed';
      this.watchCompaction(compaction, this.timing.compactStartTimeoutMs);
    }
    return true;
  }

  private watchCompaction(compaction: Compaction, ms: number): void {
    if (compaction.timer) clearTimeout(compaction.timer);
    compaction.timer = this.timer(() => this.abandonCompaction(compaction), ms);
  }

  /**
   * PreCompact is the start of the compaction asked for only once its command was typed and the
   * agent's own (auto) compaction is not what reports it; a compaction still queued is not it.
   */
  private compactionStarted(trigger: string | null): void {
    const compaction = this.compaction;
    const asked = compaction?.phase === 'typed' && trigger !== 'auto';
    if (asked) {
      compaction.phase = 'started';
      this.watchCompaction(compaction, this.timing.compactTimeoutMs);
    }
    this.deps.emit({ type: 'compaction', sessionId: this.id, phase: 'started', trigger, requested: asked });
  }

  private compactionFinished(trigger: string | null): void {
    const compaction = this.compaction;
    const asked = compaction?.phase === 'started' && trigger !== 'auto';
    if (asked) {
      if (compaction.timer) clearTimeout(compaction.timer);
      this.compaction = null;
    }
    this.deps.emit({ type: 'compaction', sessionId: this.id, phase: 'finished', trigger, requested: asked });
  }

  private abandonCompaction(compaction: Compaction): void {
    if (this.compaction !== compaction || this.hasExited) return;
    this.compaction = null;
    this.log.warn(
      { sessionId: this.id, phase: compaction.phase },
      compaction.phase === 'started'
        ? 'the compaction did not finish in time; giving it up'
        : 'the compaction did not start in time; giving it up',
    );
    this.deps.emit({
      type: 'compaction',
      sessionId: this.id,
      phase: 'abandoned',
      trigger: null,
      requested: true,
    });
    // A compaction that never started changed no state (a message that got through meanwhile may
    // be working: it stays so); one that did start leaves the session working until it is given up.
    if (compaction.phase === 'started') {
      this.input.schedule(this.timing.stopSettleMs);
      this.apply({ kind: 'compact_end', idle: true });
    }
    this.input.pump();
    this.evaluatePause();
  }

  // ---------------------------------------------------------------- pausing

  /**
   * Pauses the session (PM-218): its input is held back at once, and it stops at the next safe
   * point (see `pause.ts` and docs/PROVIDERS.md). Resolves with where it stopped, or null when the
   * pause was released first. A repeated call gets the same answer.
   */
  async pause(opts: PauseOptions = {}): Promise<PauseOutcome | null> {
    if (this.hasExited) return EXITED;
    const p = this.pauseState ?? this.startPause(opts);
    this.evaluatePause();
    return p.result();
  }

  /** Pauses the session and forces it to stop now: one Esc, then the confirmation of it. */
  async forcePause(): Promise<PauseOutcome | null> {
    if (this.hasExited) return EXITED;
    const p = this.pauseState ?? this.startPause({});
    if (p.phase === 'stopped') return p.result();
    p.forceRequested = true;
    this.evaluatePause();
    return p.result();
  }

  /**
   * Ends the pause: the held input flows again, `nudge` (if any) first. A pause that has not
   * stopped the session yet is taken back: the hooks stop answering with a halt, the pending
   * `pause` calls resolve with null. If a halting answer or an Esc went out already the turn is
   * ending anyway, so the nudge stays. False when there is no pause.
   */
  release(opts: { nudge?: string } = {}): boolean {
    const p = this.pauseState;
    if (!p) return false;
    this.pauseState = null;
    this.clearPauseTimers(p);
    if (p.phase === 'stopping') p.cancel();
    this.input.unhold(p.phase === 'stopped' || p.turnEnding ? opts.nudge : undefined);
    return true;
  }

  /**
   * Sends one Esc and waits for the CLI to confirm the interruption (Codex: its Interrupt hook; Claude
   * Code: the transcript's `interruptedAt`; a Stop closes it as well). `prompt`: no confirmation came
   * in `interruptConfirmMs`, but the prompt is on screen, so the session is taken as interrupted;
   * `unconfirmed`: neither. No second Esc is ever sent.
   */
  async interrupt(): Promise<'confirmed' | 'prompt' | 'unconfirmed'> {
    if (this.hasExited) return 'unconfirmed';
    const confirmed = await new Promise<boolean>((resolve) => {
      const t = this.timer(() => waiter(false), this.timing.interruptConfirmMs);
      const waiter = (value: boolean) => {
        clearTimeout(t);
        this.timers.delete(t);
        this.interruptWaiters.delete(waiter);
        resolve(value);
      };
      this.interruptWaiters.add(waiter);
      this.write(ESC);
    });
    if (confirmed) return 'confirmed';
    if (this.hasExited) return 'unconfirmed';
    if (this.adapter.promptVisible(this.screen.screenText(DIALOG_ROWS))) {
      this.log.warn(
        { sessionId: this.id },
        'the Esc was not confirmed, but the prompt is up: taken as interrupted',
      );
      this.input.schedule(this.timing.stopSettleMs);
      this.apply({ kind: 'interrupted' });
      return 'prompt';
    }
    this.log.warn({ sessionId: this.id }, 'the Esc was not confirmed and the prompt is not up');
    return 'unconfirmed';
  }

  private startPause({ forceAfterMs }: PauseOptions): PauseState {
    const p = new PauseState();
    this.pauseState = p;
    this.input.hold();
    this.deps.emit({ type: 'session_pausing', sessionId: this.id, waitingFor: this.runningToolName() });
    if (forceAfterMs === 0) p.forceRequested = true;
    else if (forceAfterMs !== undefined && forceAfterMs > 0) {
      p.deadline = this.timer(() => {
        p.deadline = null;
        p.forceRequested = true;
        this.evaluatePause();
      }, forceAfterMs);
    }
    return p;
  }

  private runningToolName(): string | null {
    return [...this.runningTools.values()].at(-1) ?? null;
  }

  private noteToolStart(payload: HookPayload, name: string): void {
    this.runningTools.set(payload.tool_use_id ?? `call-${++this.toolSeq}`, name);
  }

  /** Forgets the finished tool; returns its name. */
  private noteToolEnd(payload: HookPayload): string {
    const id = payload.tool_use_id;
    let name = payload.tool_name ?? 'tool';
    if (id && this.runningTools.has(id)) {
      name = this.runningTools.get(id)!;
      this.runningTools.delete(id);
    } else if (!id) {
      const key = [...this.runningTools].find(([, running]) => running === name)?.[0];
      if (key) this.runningTools.delete(key);
    }
    return name;
  }

  /**
   * The answer that ends the main agent's turn at a tool hook while a pause is stopping the session
   * (Claude Code); undefined when the hook is answered the usual way. The first such answer is where
   * the session stopped.
   */
  private haltingAnswer(payload: HookPayload, point: 'before_tool' | 'after_tool', tool: string): unknown {
    const p = this.pauseState;
    if (!p || p.phase !== 'stopping' || !this.adapter.haltOutput || payload.agent_id) return undefined;
    p.noteHalt({ point, tool });
    p.turnEnding = true;
    p.stopCheck ??= this.timer(() => this.checkHaltedTurnEnded(p), this.timing.haltStopMs);
    return this.adapter.haltOutput(point === 'before_tool' ? PAUSED_BEFORE_TOOL : PAUSED_AFTER_TOOL);
  }

  /** The Stop hook should have followed the halting answer; if it did not but the prompt is up, close the turn. */
  private checkHaltedTurnEnded(p: PauseState): void {
    p.stopCheck = null;
    if (this.pauseState !== p || p.phase !== 'stopping' || this.hasExited) return;
    if (this.current.state === 'idle') return;
    if (this.adapter.promptVisible(this.screen.screenText(DIALOG_ROWS))) {
      this.log.warn(
        { sessionId: this.id },
        'no Stop hook followed the halting answer: the prompt is up, closing the turn',
      );
      this.input.schedule(this.timing.stopSettleMs);
      this.apply({ kind: 'stop' });
    } else {
      this.log.warn(
        { sessionId: this.id },
        'no Stop hook followed the halting answer; waiting for the session to stop',
      );
    }
  }

  /** Whether the session has stopped: it waits (or idles) with nothing typed, awaiting submission or compacting. */
  private isStopped(): boolean {
    const { state } = this.current;
    if (state !== 'idle' && state !== 'waiting_permission' && state !== 'waiting_input') return false;
    if (this.input.isTyping || this.input.isAwaitingSubmit) return false;
    return this.compaction?.phase !== 'typed' && this.compaction?.phase !== 'started';
  }

  /** Re-checks the pause; called after every state change and when typing or a submission ends. */
  private evaluatePause(): void {
    const p = this.pauseState;
    if (!p || this.hasExited) return;
    const stopped = this.isStopped();
    if (p.phase === 'stopped') {
      // The stopped session works again (an approval was answered, someone typed): stop once more.
      if (stopped || this.current.state !== 'working') return;
      p.restart();
      this.deps.emit({ type: 'session_pausing', sessionId: this.id, waitingFor: this.runningToolName() });
    } else if (stopped) {
      this.settlePause(p);
      return;
    }
    this.driveStop(p);
  }

  private settlePause(p: PauseState): void {
    const { state } = this.current;
    const outcome: PauseOutcome =
      state === 'waiting_permission' || state === 'waiting_input'
        ? { point: state, tool: this.waitingTool }
        : (p.halt ?? { point: 'idle', tool: null });
    this.clearPauseTimers(p);
    this.deps.emit({ type: 'session_paused', sessionId: this.id, point: outcome.point, tool: outcome.tool });
    p.settle(outcome);
  }

  private clearPauseTimers(p: PauseState): void {
    for (const t of [p.deadline, p.stopCheck]) {
      if (!t) continue;
      clearTimeout(t);
      this.timers.delete(t);
    }
    p.deadline = null;
    p.stopCheck = null;
  }

  /** A working session is being stopped: sends the Esc where the way needs one. */
  private driveStop(p: PauseState): void {
    if (this.current.state !== 'working' || this.input.isTyping) return;
    if (this.compaction && this.compaction.phase !== 'queued') return;
    if (p.forceRequested && !p.forced) {
      p.forced = true;
      p.turnEnding = true;
      p.halt = { point: 'interrupted', tool: this.runningToolName() };
      void this.interrupt();
      return;
    }
    // Codex has no halting answer: Esc once nothing runs (after the tool, or before the next one).
    if (!this.adapter.haltOutput && !p.regularEsc && !p.forced && this.runningTools.size === 0) {
      p.regularEsc = true;
      p.turnEnding = true;
      p.noteHalt({ point: 'before_tool', tool: null });
      // After the hook's response went out, which the hook that brought us here still has to give.
      this.timer(() => {
        if (this.pauseState === p && this.current.state === 'working') void this.interrupt();
      }, 0);
    }
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
    if (payload.hook_event_name === 'SubagentStop' && payload.agent_transcript_path) {
      void this.readSubagentUsage(payload.agent_transcript_path);
    }
    if (!subagent) this.noteProviderSessionId(payload);
    const authError = this.adapter.hookAuthError(payload);
    if (authError) {
      this.authFailed(authError);
      return null;
    }
    // A subagent's approval still needs an answer; its other hooks say nothing about the session.
    if (subagent && !['PermissionRequest', 'PermissionDenied'].includes(payload.hook_event_name)) return null;
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
        // A pause stopping the session turns the call away before anything else looks at it.
        const halted = this.haltingAnswer(payload, 'before_tool', name);
        if (halted !== undefined) return halted;
        const needsInput = this.adapter.inputTools.has(name);
        if (needsInput) {
          const refusal = await this.forwardQuestion(payload, 'PreToolUse');
          if (refusal !== undefined) return refusal;
          this.noteInputWait(payload);
          if (!payload.agent_id) this.waitingTool = name;
        }
        if (!payload.agent_id) {
          this.noteToolStart(payload, name);
          // Codex: the Esc went out before this call, which now runs; it is where the Esc stopped it.
          const p = this.pauseState;
          if (p?.phase === 'stopping' && p.regularEsc) p.halt = { point: 'interrupted', tool: name };
        }
        this.apply({
          kind: 'pre_tool',
          activity: toolActivity(name, payload.tool_input, this.spec.cwd),
          needsInput,
        });
        return null;
      }
      case 'PostToolUse':
      case 'PostToolUseFailure': {
        const main = !payload.agent_id;
        const name = main ? this.noteToolEnd(payload) : (payload.tool_name ?? 'tool');
        const halted = this.haltingAnswer(payload, 'after_tool', name);
        const p = this.pauseState;
        if (halted === undefined && main && p?.phase === 'stopping' && this.runningTools.size === 0) {
          // No halting answer (Codex): the Esc follows once the last tool has finished.
          if (!this.adapter.haltOutput) p.noteHalt({ point: 'after_tool', tool: name });
        }
        this.apply({ kind: 'post_tool' });
        return halted ?? null;
      }
      case 'PermissionRequest':
        return this.permissionRequest(payload, withdrawn);
      case 'PermissionDenied':
        // The agent's auto mode refused a tool call on its own: recorded, nothing to answer.
        this.deps.broker.refused?.({
          sessionId: this.id,
          toolName: payload.tool_name ?? 'unknown',
          toolInput: payload.tool_input ?? null,
          ...(payload.denial_reason ? { reason: payload.denial_reason } : {}),
        });
        return null;
      case 'Notification':
        this.input.schedule(this.timing.stopSettleMs);
        this.apply({
          kind: 'notification',
          type: payload.notification_type ?? null,
          message: payload.message ?? null,
        });
        return null;
      case 'PreCompact':
        // The compaction command is a slash command: no UserPromptSubmit reports it, this does.
        this.input.submitted();
        this.compactionStarted(payload.trigger ?? null);
        this.apply({ kind: 'compact_start' });
        return null;
      case 'PostCompact':
        this.input.schedule(this.timing.stopSettleMs);
        this.compactionFinished(payload.trigger ?? null);
        this.apply({ kind: 'compact_end', idle: payload.trigger !== 'auto' });
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

  /**
   * A question tool's call (Claude Code's AskUserQuestion, PM-199) shows its dialog in a terminal that
   * nobody reads, so the session would wait unseen and hold its messages back. A member's call is
   * turned away instead, and its questions go to the humans' inbox; the answer returns as a team
   * message. Returns the hook answer, or undefined when the call is left to the terminal: the CLI
   * has no such answer, the session has no member, or the broker could not take the questions.
   */
  private async forwardQuestion(
    payload: HookPayload,
    event: 'PreToolUse' | 'PermissionRequest',
  ): Promise<unknown> {
    const { broker } = this.deps;
    if (!this.adapter.refuseQuestionOutput || !broker.forwardQuestion || !this.spec.member) return undefined;
    const toolName = payload.tool_name ?? 'unknown';
    const refuse = (): unknown => this.adapter.refuseQuestionOutput!(event, QUESTION_FORWARDED);
    // The CLI may report one call twice (PreToolUse, then PermissionRequest): it is asked once.
    const callId = payload.tool_use_id;
    if (callId && this.forwardedQuestions.has(callId)) return refuse();
    let forwarded = false;
    const startedAt = Date.now();
    try {
      forwarded = await broker.forwardQuestion({
        sessionId: this.id,
        toolName,
        toolInput: payload.tool_input ?? null,
      });
    } catch (err) {
      this.log.warn({ err, sessionId: this.id, toolName }, 'could not forward the agent question');
    }
    if (!forwarded) return undefined;
    if (callId) this.forwardedQuestions.add(callId);
    this.log.info(
      {
        sessionId: this.id,
        toolName,
        event,
        toolUseId: callId,
        agentId: payload.agent_id,
        tookMs: Date.now() - startedAt,
      },
      'forwarded the agent question to the inbox',
    );
    return refuse();
  }

  /**
   * Logs why the session is about to wait for input at its terminal: which conversation and agent the
   * hook came from, and whether a dialog shows on the screen (PM-199: a wait nobody saw has no
   * explanation yet, and these fields tell a stray hook from a real dialog).
   */
  private noteInputWait(payload: HookPayload): void {
    this.log.warn(
      {
        sessionId: this.id,
        event: payload.hook_event_name,
        toolName: payload.tool_name,
        toolUseId: payload.tool_use_id,
        conversationId: payload.session_id,
        agentId: payload.agent_id,
        agentType: payload.agent_type,
        transcriptPath: payload.transcript_path,
        promptVisible: this.adapter.promptVisible(this.screen.screenText(DIALOG_ROWS)),
      },
      'session waits for input at its terminal',
    );
  }

  private async permissionRequest(payload: HookPayload, withdrawn: AbortSignal): Promise<unknown> {
    const toolName = payload.tool_name ?? 'unknown';
    const activity = toolActivity(toolName, payload.tool_input, this.spec.cwd);
    if (this.adapter.inputTools.has(toolName)) {
      const refusal = await this.forwardQuestion(payload, 'PermissionRequest');
      if (refusal !== undefined) return refusal;
      // A question for whoever is at the terminal: the CLI shows its own dialog.
      this.noteInputWait(payload);
      if (!payload.agent_id) this.waitingTool = toolName;
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
    if (!payload.agent_id) this.waitingTool = toolName;
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
    const { items, interruptedAt, authError, usage, contextTokens } = parser.parseLines(lines);
    if (items.length > 0) this.deps.emit({ type: 'chat', sessionId: this.id, items });
    if (usage?.length || contextTokens !== undefined) {
      this.deps.emit({
        type: 'usage',
        sessionId: this.id,
        entries: usage ?? [],
        ...(contextTokens !== undefined ? { contextTokens } : {}),
      });
    }
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

  /**
   * A subagent stopped (PM-178): its own transcript, which its SubagentStop hook names, is read
   * whole once and its token usage reported. Like the main transcript, a worker's file is read
   * only inside the worker home. A subagent still running when the session ends is not counted.
   */
  private async readSubagentUsage(raw: string): Promise<void> {
    const parser = this.parser;
    if (!parser?.subagentUsage) return;
    const path = this.transcriptFile(raw);
    if (path === null) {
      this.log.warn({ sessionId: this.id }, 'ignored a subagent transcript outside the worker home');
      return;
    }
    try {
      const text = await readTranscriptText(path, this.deps.transcriptRoot);
      const entries = parser.subagentUsage(text.split('\n'));
      if (entries.length > 0) this.deps.emit({ type: 'usage', sessionId: this.id, entries });
    } catch (err) {
      this.log.warn({ err, sessionId: this.id }, 'subagent transcript read failed');
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
    this.compaction = null;

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
    // A pause still stopping the session ends with it.
    const p = this.pauseState;
    if (p?.phase === 'stopping') {
      this.deps.emit({ type: 'session_paused', sessionId: this.id, point: 'exited', tool: null });
      p.settle(EXITED);
    }
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
    this.notePauseSignal(signal);
    const next = nextState(this.current, signal);
    if (next.state !== 'waiting_permission' && next.state !== 'waiting_input') this.waitingTool = null;
    if (next.state !== this.current.state || next.activity !== this.current.activity) {
      this.current = next;
      this.emitState();
      if (next.state === 'idle') this.input.pump();
    }
    this.evaluatePause();
  }

  /** What a signal means for the running tools, the Esc awaited and the pause stopping the session. */
  private notePauseSignal(signal: SessionSignal): void {
    switch (signal.kind) {
      case 'stop':
      case 'stop_failure':
      case 'interrupted': {
        const p = this.pauseState;
        const { state } = this.current;
        if (p?.phase === 'stopping' && state !== 'idle' && state !== 'starting') {
          p.noteHalt(
            signal.kind === 'interrupted'
              ? { point: 'interrupted', tool: this.runningToolName() }
              : { point: 'turn_end', tool: null },
          );
        }
        this.runningTools.clear();
        for (const confirmed of [...this.interruptWaiters]) confirmed(true);
        return;
      }
      case 'prompt_submit':
        this.runningTools.clear();
        return;
      case 'exit':
        this.runningTools.clear();
        for (const confirmed of [...this.interruptWaiters]) confirmed(false);
        return;
      default:
    }
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
