import type { AgentProvider, ChatItem } from '@projectman/shared';
import type {
  PermissionDecision,
  PlanUsageProvider,
  ProviderStatus,
  StartSessionSpec,
} from '../../contracts';
import type { CommandOutput } from '../cli';
import type { HookPayload } from '../hook-payload';

/**
 * Provider adapters: what differs between the agent CLIs the runner drives (Claude Code,
 * OpenAI Codex CLI). The PTY session, message queue, state machine, permission broker and
 * transcript tailer are shared; an adapter supplies the command line, how hooks arrive and
 * are answered, how the screen and the transcript read, the login check and plan usage.
 */

/**
 * What differs in how the shared session drives a provider's CLI. (Everything else, such as
 * how hooks arrive or where plan usage comes from, is inside the adapter's own functions.)
 */
export interface ProviderCapabilities {
  /**
   * The CLI takes our conversation id at launch (Claude `--session-id`). Otherwise the id is
   * learned from the first hook and reported with a `provider_session_id` event (Codex).
   */
  presetSessionId: boolean;
  /**
   * The hook answer can make the CLI itself remember an "allow for this session" (Claude
   * `updatedPermissions`). Otherwise the runner remembers it and answers repeats itself.
   */
  sessionPermissionRules: boolean;
  /**
   * When a new process can take input: at its first SessionStart hook (Claude), or once the
   * screen shows the prompt (Codex fires SessionStart only with the first turn).
   */
  readiness: 'session_start' | 'screen';
}

/** Timing of the interaction with a TUI (CLAUDE_TIMING and CODEX_TIMING in the adapters). */
export interface SessionTiming {
  /** Pause after the first SessionStart before typing (the prompt box finishes mounting). */
  readySettleMs: number;
  /** Typing waits this long at most for the TUI to enable bracketed paste. */
  pasteModeGraceMs: number;
  /** Pause after Stop before typing the next queued message. */
  stopSettleMs: number;
  /** Pause between the writes that make up one message. */
  stepDelayMs: number;
  /** Pause between the last text and Enter. */
  enterDelayMs: number;
  /** Enter is pressed again if the CLI did not report the prompt (an autocomplete ate it). */
  enterRetryMs: number;
  maxEnterRetries: number;
  /** A typed message that never produced UserPromptSubmit stops blocking the queue after this. */
  submitTimeoutMs: number;
  /** The same for a first prompt passed on the command line (the CLI may take a while to start). */
  argumentSubmitTimeoutMs: number;
  /** How often the screen is checked for blocking dialogs (while starting, or while one is up). */
  startupCheckMs: number;
  /** Without readiness after this long, the session is flagged as needing a look. */
  startupTimeoutMs: number;
  /** Graceful stop: SIGTERM, then SIGKILL after this long. */
  stopTimeoutMs: number;
  /** Exit waits this long at most for the last transcript lines. */
  finalReadMs: number;
}

/** Result of parsing transcript lines. */
export interface TranscriptParseResult {
  items: ChatItem[];
  /** Timestamp of the latest interruption (Esc) the transcript recorded, if any. */
  interruptedAt: string | null;
  /** A login failure the transcript recorded, e.g. "Login expired · Please run /login". */
  authError?: string | null;
}

/** Incremental transcript parser of one conversation. */
export interface TranscriptLineParser {
  parseLines(lines: Iterable<string>): TranscriptParseResult;
}

export interface LaunchInput {
  spec: StartSessionSpec;
  /** POST target of the session's hooks, http://127.0.0.1:<port>/hooks/<token>. */
  hookUrl: string;
  permissionTimeoutMs: number;
}

export interface Launch {
  file: string;
  args: string[];
  /** The CLI's own arguments (`args` may start with a script for a fake CLI); the launcher gets these. */
  cliArgs: string[];
  /** The kick-off brief went on the command line: it must not be typed again. */
  initialMessageSent: boolean;
}

/** One agent CLI. */
export interface ProviderAdapter {
  readonly provider: AgentProvider;
  /** Product name for logs and messages, e.g. "Claude Code". */
  readonly label: string;
  /** The CLI to run: a path, a name on PATH, or a .mjs fake in tests. */
  readonly bin: string;
  readonly capabilities: ProviderCapabilities;
  readonly timing: SessionTiming;
  /** Tools that wait for an answer typed by a human in the terminal. */
  readonly inputTools: ReadonlySet<string>;
  /** Command line of a session (after any preparation, e.g. workspace trust). */
  launch(input: LaunchInput): Promise<Launch>;
  /** A hook body, validated; null when malformed. */
  parseHook(body: unknown): HookPayload | null;
  /** Whether a hook came from a subagent and must not change the session's state. */
  isSubagentHook(payload: HookPayload): boolean;
  /** The PermissionRequest hook answer for a broker decision. */
  permissionOutput(decision: PermissionDecision, payload: HookPayload): unknown;
  /** The PermissionRequest hook answer that denies with `message`. */
  denyOutput(message: string): unknown;
  /** A login failure a hook reports (e.g. Claude's StopFailure), or null. */
  hookAuthError(payload: HookPayload): string | null;
  /** A dialog that blocks the session (trust, login, ...) in the given screen text, or null. */
  detectBlockingScreen(text: string): string | null;
  /** Whether the screen shows the input prompt, i.e. no dialog covers it. */
  promptVisible(text: string): boolean;
  createTranscriptParser(opts: {
    self: string | null;
    cwd: string | null;
    firstUserOrigin?: 'brief' | 'human';
  }): TranscriptLineParser;
  /** Login state, from a check that spends no usage. */
  checkLogin(env: Record<string, string>): Promise<ProviderStatus>;
  /** The arguments of that check, for running it elsewhere (as a worker, through the launcher). */
  readonly loginCommand: string[];
  /** Reads that check's output. */
  parseLogin(out: CommandOutput): ProviderStatus;
  readonly planUsage: PlanUsageProvider;
  /** A transcript the provider's plan usage may read (Codex records rate limits there). */
  noteTranscript?(path: string): void;
}
