import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { ChatItem, PlanUsage, SessionState } from '@projectman/shared';

/**
 * Runs real, interactive Claude Code sessions in pseudo-terminals, on the logged-in
 * user's Claude subscription (never an API key). Owned by src/runner.
 */

export interface StartSessionSpec {
  /** Our session id ("ses_..."). */
  sessionId: string;
  /** Claude Code session UUID. New sessions: `--session-id`; resumed ones: `--resume`. */
  claudeSessionId: string;
  resume: boolean;
  cwd: string;
  /** Shown as the session name (`-n`). */
  displayName: string;
  model?: string;
  permissionMode?: string;
  /** Identity, team, rules and memory of the member (`--append-system-prompt`). */
  appendSystemPrompt: string;
  /** First user message typed once the session is ready (e.g. the task brief). */
  initialMessage?: string | null;
  /** Team tools endpoint for this session, e.g. http://127.0.0.1:4700/mcp/<token>. */
  mcpUrl: string;
  /** Tools pre-approved for this session, e.g. ["mcp__team__*"]. */
  allowedTools: string[];
  cols?: number;
  rows?: number;
  /**
   * Handle of the AI member running the session. Chat items use it as the sender of
   * outgoing team messages and the recipient of incoming ones.
   */
  member?: string;
}

export type RunnerEvent =
  | { type: 'state'; sessionId: string; state: SessionState; activity: string | null }
  | { type: 'terminal_data'; sessionId: string; data: string }
  | { type: 'transcript_path'; sessionId: string; path: string }
  | { type: 'chat'; sessionId: string; items: ChatItem[] }
  | { type: 'exit'; sessionId: string; exitCode: number | null; signal: number | null };

export interface RunningSessionInfo {
  sessionId: string;
  pid: number;
  state: SessionState;
  cols: number;
  rows: number;
}

export interface SessionRunner {
  start(spec: StartSessionSpec): Promise<RunningSessionInfo>;
  /** Types a user message into the session once it is idle (queued otherwise); resolves when typed. */
  sendUserMessage(sessionId: string, text: string): Promise<void>;
  /** Raw keyboard input from an attached browser terminal. */
  writeTerminal(sessionId: string, data: string): void;
  resize(sessionId: string, cols: number, rows: number): void;
  /** Serialized screen and scrollback for newly attached viewers. */
  snapshot(sessionId: string): { data: string; cols: number; rows: number } | null;
  stop(sessionId: string, opts?: { force?: boolean }): Promise<void>;
  isRunning(sessionId: string): boolean;
  list(): RunningSessionInfo[];
  onEvent(listener: (event: RunnerEvent) => void): () => void;
  /** Stops every session (server shutdown). */
  shutdown(): Promise<void>;
}

/** Tool permission request coming from Claude Code's PermissionRequest hook. */
export interface PermissionRequestInfo {
  sessionId: string;
  toolName: string;
  toolInput: unknown;
  /** Raw hook payload for anything else the broker may need. */
  raw: unknown;
}

export type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: unknown; rememberForSession?: boolean }
  | { behavior: 'deny'; message?: string };

/**
 * Decides tool permission requests. Implemented by the domain (it creates a "Rád vár"
 * inbox item and waits for a human). The runner answers the hook with the decision.
 * When `signal` aborts (timeout or session exit) the broker must stop waiting.
 */
export interface PermissionBroker {
  decide(request: PermissionRequestInfo, signal: AbortSignal): Promise<PermissionDecision>;
}

export interface TranscriptReader {
  /**
   * Parses a whole Claude Code transcript (JSONL) into chat items. `self` is the handle of
   * the session's member (sender of outgoing team messages; "unknown" when omitted).
   */
  read(path: string, opts?: { self?: string }): Promise<ChatItem[]>;
}

export interface PlanUsageProvider {
  /** Current plan usage of the logged-in Claude account, or null if unavailable. */
  get(): Promise<PlanUsage | null>;
}

export interface RunnerModuleOptions {
  /** Path or name of the Claude Code CLI (default "claude"). Tests pass a fake CLI. */
  claudeBin: string;
  /** Base URL the CLI calls for HTTP hooks, e.g. http://127.0.0.1:4700 (the runner adds /hooks/<token>). */
  publicBaseUrl: string;
  broker: PermissionBroker;
  /** How long a permission request may wait for a human before it is denied. */
  permissionTimeoutMs: number;
  logger: FastifyBaseLogger;
  /**
   * Claude Code's global config file, where workspace trust is recorded
   * (`projects[<path>].hasTrustDialogAccepted`). Default: `$CLAUDE_CONFIG_DIR/.claude.json`,
   * else `~/.claude.json`. Tests pass a temporary file.
   */
  claudeConfigPath?: string;
  /**
   * Pre-accept Claude Code's workspace trust dialog for a session's directory (default true).
   * When false, a new directory shows the dialog in the terminal and the session waits there.
   */
  trustWorkspaces?: boolean;
}

export interface RunnerModule {
  runner: SessionRunner;
  transcripts: TranscriptReader;
  planUsage: PlanUsageProvider;
  /** Registers POST /hooks/:token (localhost only). */
  registerHookRoutes(app: FastifyInstance): void;
}
