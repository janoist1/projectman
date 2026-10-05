import type { AgentProvider, ChatItem, TokenUsage } from '@projectman/shared';
import type {
  PermissionDecision,
  PlanUsageProvider,
  ProviderStatus,
  StartSessionSpec,
} from '../../contracts';
import type { CommandOutput } from '../cli';
import type { HookPayload } from '../hook-payload';
import type { SessionPolicy } from '../../contracts';
import type { ToolDecision } from '../tool-decision';

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
  toolGate: 'permission_request' | 'pre_tool_use';
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
  /** A typed compaction command that never produced PreCompact is given up after this (PM-213). */
  compactStartTimeoutMs: number;
  /** A compaction that started and never produced PostCompact is given up after this (PM-213). */
  compactTimeoutMs: number;
  /** Esc must be confirmed (Interrupt hook, transcript, Stop) within this long, or the screen decides (PM-218). */
  interruptConfirmMs: number;
  /** After a halting hook answer the CLI should end the turn with a Stop within this long (PM-218). */
  haltStopMs: number;
  /**
   * A turn the transcript ended (`end_turn`) whose Stop hook did not follow is closed after this long,
   * when the screen shows the prompt (PM-343).
   */
  turnEndGraceMs: number;
}

/** Result of parsing transcript lines. */
export interface TranscriptParseResult {
  items: ChatItem[];
  /** Timestamp of the latest interruption (Esc) the transcript recorded, if any. */
  interruptedAt: string | null;
  /**
   * Whether the latest assistant entry of the main conversation in these lines ended the turn
   * (`true`, Claude Code's `end_turn`) or went on (`false`); absent when there was none (PM-343).
   */
  turnEnded?: boolean;
  /** The timestamp of that entry: one from before the latest prompt belongs to the turn before. */
  turnAt?: string;
  /** A login failure the transcript recorded, e.g. "Login expired · Please run /login". */
  authError?: string | null;
  /** Tokens these lines add to the session's usage (PM-178), per model and scope. */
  usage?: TokenUsage[];
  /** The context of the latest step of the main conversation in these lines (PM-213). */
  contextTokens?: number;
}

/** Incremental transcript parser of one conversation. */
export interface TranscriptLineParser {
  parseLines(lines: Iterable<string>): TranscriptParseResult;
  /**
   * The tokens in a subagent's own transcript, read whole when the subagent stops (Claude Code's
   * SubagentStop names it). Absent: the provider keeps no such file the runner knows of.
   */
  subagentUsage?(lines: Iterable<string>): TokenUsage[];
}

export interface LaunchInput {
  spec: StartSessionSpec;
  /** POST target of the session's hooks, http://127.0.0.1:<port>/hooks/<token>. */
  hookUrl: string;
  permissionTimeoutMs: number;
}

export interface Launch {
  conversationRoot?: string;
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
  parseHook(body: unknown, event?: string): HookPayload | null;
  decideToolCall?(policy: SessionPolicy, payload: HookPayload, conversationRoot: string | null): ToolDecision;
  turnStartOutput?(spec: StartSessionSpec): unknown;
  /** Whether a hook came from a subagent and must not change the session's state. */
  isSubagentHook(payload: HookPayload): boolean;
  /** The PermissionRequest hook answer for a broker decision. */
  permissionOutput(decision: PermissionDecision, payload: HookPayload): unknown;
  /** The PermissionRequest hook answer that denies with `message`. */
  denyOutput(message: string): unknown;
  /**
   * The hook answer that turns a question tool's call away with `message` (PM-199), for the
   * PreToolUse or PermissionRequest hook it came with. Absent: the CLI's questions stay at its terminal.
   */
  refuseQuestionOutput?(event: 'PreToolUse' | 'PermissionRequest', message: string): unknown;
  /**
   * The answer to a PreToolUse, PostToolUse or PostToolUseFailure hook that makes the CLI end the
   * turn there (PM-218), with `reason` as its message. Absent: the CLI has no such answer, and a
   * pause stops it with Esc instead.
   */
  haltOutput?(reason: string): unknown;
  /** A login failure a hook reports (e.g. Claude's StopFailure), or null. */
  hookAuthError(payload: HookPayload): string | null;
  /** A dialog that blocks the session (trust, login, ...) in the given screen text, or null. */
  detectBlockingScreen(text: string): string | null;
  /** Whether the screen shows the input prompt, i.e. no dialog covers it. */
  promptVisible(text: string): boolean;
  /**
   * Whether the screen shows that the agent is working (its "esc to interrupt" hint). The prompt is
   * on screen while it works too, so a pause takes "the prompt is up" as a stop only without this.
   */
  workingVisible(text: string): boolean;
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
