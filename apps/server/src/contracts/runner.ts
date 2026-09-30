import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { AgentEffort, AgentProvider, ChatItem, PlanUsage, SessionState } from '@projectman/shared';

/**
 * Runs real, interactive agent CLI sessions (Claude Code or OpenAI Codex CLI) in
 * pseudo-terminals, on the logged-in user's subscription (never an API key). Owned by
 * src/runner.
 */

export interface StartSessionSpec {
  /** Our session id ("ses_..."). */
  sessionId: string;
  /**
   * Conversation id of the agent CLI. Claude Code: the session UUID (`--session-id` for new
   * sessions, `--resume` for resumed ones). Codex: ignored for new sessions (Codex picks its
   * own id, reported with a `provider_session_id` event); resumed ones use `codex resume <id>`.
   */
  claudeSessionId: string;
  resume: boolean;
  cwd: string;
  /** Shown as the session name (`-n`). */
  displayName: string;
  model?: string;
  effort?: AgentEffort;
  permissionMode?: string;
  /**
   * Identity, team, rules and memory of the member (Claude Code: `--append-system-prompt`;
   * Codex: `developer_instructions`).
   */
  appendSystemPrompt: string;
  /** First user message typed once the session is ready (e.g. the task brief). */
  initialMessage?: string | null;
  /** Team tools endpoint for this session, e.g. http://127.0.0.1:4700/mcp/<token>. */
  mcpUrl: string;
  /** Tools pre-approved for this session, e.g. ["mcp__team__*"]. */
  allowedTools: string[];
  /** Claude Code tool rules refused without asking. */
  deniedTools?: string[];
  /** Extra directories the session may read and work in (Claude Code --add-dir). */
  additionalDirectories?: string[];
  /** Extra writable roots for sandboxed agents, such as the shared git directory. */
  writableRoots?: string[];
  cols?: number;
  rows?: number;
  /**
   * Handle of the AI member running the session. Chat items use it as the sender of
   * outgoing team messages and the recipient of incoming ones.
   */
  member?: string;
  /** The agent CLI to run (default "claude"). */
  provider?: AgentProvider;
}

export type RunnerEvent =
  | { type: 'state'; sessionId: string; state: SessionState; activity: string | null }
  | { type: 'terminal_data'; sessionId: string; data: string }
  | { type: 'transcript_path'; sessionId: string; path: string }
  | { type: 'chat'; sessionId: string; items: ChatItem[] }
  | { type: 'exit'; sessionId: string; exitCode: number | null; signal: number | null }
  /**
   * The agent CLI's own conversation id, when the runner learns it instead of choosing it
   * (Codex: from the first hook). Store it as the session's `claudeSessionId` to resume later.
   */
  | { type: 'provider_session_id'; sessionId: string; providerSessionId: string }
  /**
   * The CLI lost its login mid-session (e.g. "Login expired · Please run /login"). The
   * session is stopped and ends as `failed` with `message` as its activity.
   */
  | { type: 'auth_error'; sessionId: string; provider: AgentProvider; message: string };

/** Login state of an agent CLI, from a check that spends no usage. */
export interface ProviderStatus {
  provider: AgentProvider;
  /**
   * Logged in with a subscription (Claude plan, ChatGPT plan). False also for an API-key
   * login, which would bill the API. Null when the check could not tell.
   */
  loggedIn: boolean | null;
  /** How the CLI is logged in, e.g. "claude.ai", "chatgpt", "api_key", "none"; null if unknown. */
  method: string | null;
  /** When the check ran (ISO time). */
  checkedAt: string;
  /** Why the provider is not usable (English), when `loggedIn` is not true. */
  detail?: string;
}

/** Error code of a session start refused because the provider is not logged in. */
export const PROVIDER_NOT_LOGGED_IN = 'provider_not_logged_in';

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
  /**
   * Login state of a provider's CLI (cached briefly). `start` refuses to spawn a session of a
   * provider that is not logged in, with an error whose `code` is `provider_not_logged_in`.
   */
  providerStatus?(provider: AgentProvider, opts?: { refresh?: boolean }): Promise<ProviderStatus>;
}

/** Tool permission request coming from the CLI's PermissionRequest hook. */
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
   * Parses a whole transcript (Claude Code JSONL or Codex rollout JSONL) into chat items.
   * `self` is the handle of the session's member (sender of outgoing team messages;
   * "unknown" when omitted). General chats have no brief: their first user turn is human.
   * `cwd` is the session's working directory: file paths inside it are shown relative to it,
   * as in the live chat (absolute when omitted).
   */
  read(
    path: string,
    opts?: { self?: string; firstUserOrigin?: 'brief' | 'human'; cwd?: string | null },
  ): Promise<ChatItem[]>;
}

export interface PlanUsageProvider {
  /** Current plan usage of the logged-in account (Claude, or ChatGPT for Codex), or null if unavailable. */
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
   * Codex sessions always trust their directory for that one process (a `-c` override).
   */
  trustWorkspaces?: boolean;
  /** Path or name of the OpenAI Codex CLI (default: $CODEX_BIN, else "codex"). Tests pass a fake CLI. */
  codexBin?: string;
  /** Codex's home, where it keeps transcripts (default: $CODEX_HOME, else ~/.codex). Read only. */
  codexHome?: string;
}

export interface RunnerModule {
  runner: SessionRunner;
  transcripts: TranscriptReader;
  /** Plan usage of the Claude account. */
  planUsage: PlanUsageProvider;
  /** Plan usage per provider (`planUsage` for "claude"). */
  planUsageFor?(provider: AgentProvider): PlanUsageProvider;
  /** Registers POST /hooks/:token (localhost only). */
  registerHookRoutes(app: FastifyInstance): void;
}
