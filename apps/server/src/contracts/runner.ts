import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type {
  AgentEffort,
  AgentProvider,
  ChatItem,
  EngineId,
  HandoffSummary,
  PausePoint,
  PlanUsage,
  ProviderProblem,
  SessionState,
  SessionReadBoundary,
  TokenUsage,
} from '@projectman/shared';
import type { SessionPolicy } from './session-policy';
import type { MachineProbe } from './machine';

export type ProcessScopeKind = 'cgroup' | 'process_group';
export type ProcessScopeGuarantee = 'contained' | 'best_effort';
export const PROCESS_SCOPE_GUARANTEE: Readonly<Record<ProcessScopeKind, ProcessScopeGuarantee>> = {
  cgroup: 'contained',
  process_group: 'best_effort',
};
export type ProcessScopeConfig = { kind: 'process_group' };
export type ScopeCloseReason = 'stop' | 'kill' | 'exit' | 'shutdown' | 'start_failed' | 'recovery';
export const SCOPE_TERM_GRACE_MS = 5_000;
export const SCOPE_SINCE_MARGIN_MS = 60_000;
export const SCOPE_KILL_WAIT_MS = 2_000;
export interface SessionCleanup {
  scopeId: string;
  kind: ProcessScopeKind;
  outcome: 'clean' | 'failed' | 'unverified';
  reason: ScopeCloseReason;
  killed: boolean;
  survivors: number;
  durationMs: number;
}
export type ScopeProcessSource = Pick<MachineProbe, 'processes' | 'envValues'>;

/**
 * Runs real, interactive agent CLI sessions (Claude Code or OpenAI Codex CLI) in
 * pseudo-terminals, on the logged-in user's subscription (never an API key). Owned by
 * src/runner.
 */

/**
 * An operating-system sandbox for the agent's shell commands and their child processes: they
 * may write only the working directory, the temp directory and `allowWrite`, and reach only
 * `allowedDomains`, so they run without asking. Claude Code applies it with its own sandbox;
 * Codex runs in its own sandbox regardless.
 */
export interface AgentSandbox {
  /** Paths outside the working directory commands may write, e.g. the npm cache. */
  allowWrite: string[];
  /** Hosts commands may reach; every other host is refused without asking. */
  allowedDomains: string[];
  /** Hosts refused even when `allowedDomains` is the open `*` (outbound network on, PM-355); omitted: none. */
  deniedDomains?: string[];
  /** Commands may listen on local ports (the test servers); they then reach every local port. */
  allowLocalBinding: boolean;
  /**
   * Paths commands never write, the working directory included (PM-167: a reader's working
   * directory and extra directories). Claude Code's built-in file tools are outside the sandbox:
   * the adapter denies their edits of these paths with permission rules.
   */
  denyWrite?: string[];
  /**
   * Paths commands never read: the credentials and the live instance's data (PM-167); for a
   * developer the whole user home and the app home (PM-153).
   */
  denyRead?: string[];
  /** Paths inside `denyRead` that commands may read after all; a narrower `denyRead` still wins. */
  allowRead?: string[];
  /** Environment variables commands never see (unset in the sandbox, PM-153): tokens, the SSH agent. */
  deniedEnvVars?: string[];
  /**
   * Environment variables set for the session and its commands (PM-193): the member's own npm cache
   * and development data, so nothing the host uses outside a sandbox needs to be writable.
   */
  env?: Record<string, string>;
  /**
   * Commands that run outside the sandbox with any arguments, through the usual permission path
   * (`gh pr view`): only as a command of their own, never inside a chain, a pipe or a substitution
   * (the provider adapter renders the pattern, PM-188).
   */
  excludedCommands?: string[];
  /**
   * What an agent CLI with a sandbox of its own (Codex) takes from this one too (PM-346): its commands
   * may also write `allowWrite` and see `env`. Every entry is in `allowWrite` / `env` above as well,
   * which Claude Code renders; Claude Code ignores this. Absent: nothing.
   */
  portable?: {
    allowWrite: string[];
    env: Record<string, string>;
    /**
     * The commands' own temporary directory (PM-339): writable and their TMPDIR, while the shared
     * ones (`/tmp`, the CLI's own TMPDIR) are no longer writable. Absent: the CLI's default.
     */
    tmpDir?: string;
    readBoundary?: SessionReadBoundary;
  };
}

/**
 * A subagent the session's agent may hand work to (PM-179: the cheap subagent). It gets no
 * permissions of its own: its tool calls go through the session's rules, sandbox and hooks.
 * Claude Code takes it in `--agents`; Codex ignores it.
 */
export interface SubagentDefinition {
  /** What the agent calls it by (`subagent_type`). */
  name: string;
  /** When to use it (English prompt text): the agent reads it when it picks a subagent. */
  description: string;
  /** The subagent's own system prompt (English prompt text). */
  prompt: string;
  /** The only tools it may use, e.g. `["Read", "Grep"]`. */
  tools: string[];
  /** Model alias, e.g. "haiku". */
  model: string;
}

export interface StartSessionSpec {
  /** Our session id ("ses_..."). */
  sessionId: string;
  /**
   * The engine the session runs on (PM-311); absent: `local`. The local runner ignores it; the
   * router of the hybrid mode (PM-315) sends the start to that engine.
   */
  engineId?: EngineId;
  /**
   * The project the session belongs to. The cloud's remote runner chooses the project's engine by it when
   * `engineId` is absent; it is not sent to the engine. The local runner ignores it.
   */
  projectKey?: string;
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
  /**
   * The size in tokens at which the agent CLI compacts the conversation (PM-212). Claude Code
   * only (`autoCompactWindow`, new and resumed sessions alike); Codex ignores it.
   */
  autoCompactWindowTokens?: number;
  permissionMode?: string;
  /**
   * Identity, team, rules and memory of the member (Claude Code: `--append-system-prompt`;
   * Codex: `developer_instructions`).
   */
  appendSystemPrompt: string;
  /** Subagents defined for the session (PM-179); absent or empty: none. */
  subagents?: SubagentDefinition[];
  /**
   * First user message of the process: the task brief of a new conversation; for a resumed one,
   * the message that caused the resume or else a continue message, so it does not sit at its
   * prompt. Codex gets it as the prompt on its command line (so it does not depend on the screen);
   * Claude Code has it typed once the session reports SessionStart.
   */
  initialMessage?: string | null;
  /**
   * A resumed conversation is compacted before anything else is typed (PM-213): the instruction
   * (English prompt text) the compaction command takes. The initial message follows once the
   * compaction is over, or given up. Only for providers in `COMPACTING_PROVIDERS`.
   */
  compactFirst?: string;
  /**
   * Who writes the first user turn of a new conversation (`openingTurnOrigin`); the chat labels
   * it. Default: "brief" when there is an initial message, else "human".
   */
  firstUserOrigin?: 'brief' | 'human';
  /** Team tools endpoint for this session, e.g. http://127.0.0.1:4700/mcp/<token>. */
  mcpUrl: string;
  /** Provider-neutral policy; domain starts always supply it, including resumes. */
  policy?: SessionPolicy;
  /** Legacy Claude inputs; when policy is present the adapter renders its semantic grants instead. */
  allowedTools: string[];
  /** Legacy Claude deny rules; superseded by policy.deniedOperations. */
  deniedTools?: string[];
  /** Extra directories the session may read and work in (Claude Code --add-dir). */
  additionalDirectories?: string[];
  /** Extra writable roots for sandboxed agents (none today: the shared git directory is not one, PM-131). */
  writableRoots?: string[];
  /** Runs the agent's shell commands in an OS sandbox (Claude Code); absent, they are not sandboxed. */
  sandbox?: AgentSandbox;
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
  | {
      type: 'rate_limited';
      sessionId: string;
      provider: AgentProvider;
      message: string;
      at: string;
      resetsAt?: string;
    }
  | { type: 'state'; sessionId: string; state: SessionState; activity: string | null }
  | { type: 'terminal_data'; sessionId: string; data: string }
  | { type: 'transcript_path'; sessionId: string; path: string }
  | { type: 'chat'; sessionId: string; items: ChatItem[] }
  | {
      type: 'exit';
      sessionId: string;
      exitCode: number | null;
      signal: number | null;
      cleanup?: SessionCleanup;
    }
  | { type: 'scope_recovered'; sessionId: string; cleanup: SessionCleanup }
  /**
   * The process got its first input (`StartSessionSpec.initialMessage`): Codex has it on its command
   * line as soon as it is started; Claude Code has it typed into the prompt once it reports
   * SessionStart. A process that ends before that never sends it, so the messages in that input
   * did not reach the agent.
   */
  | { type: 'first_input_sent'; sessionId: string }
  /**
   * The first input was typed but the CLI never took it (no prompt report in time, PM-571): the
   * process lives on, the text may still sit in its prompt box, and the messages in that input did
   * not reach the agent.
   */
  | { type: 'first_input_failed'; sessionId: string }
  /**
   * The agent CLI's own conversation id, when the runner learns it instead of choosing it
   * (Codex: from the first hook). Store it as the session's `claudeSessionId` to resume later.
   */
  | { type: 'provider_session_id'; sessionId: string; providerSessionId: string }
  /**
   * The CLI lost its login mid-session (e.g. "Login expired · Please run /login"). The
   * session is stopped and ends as `failed` with `message` as its activity.
   */
  | { type: 'auth_error'; sessionId: string; provider: AgentProvider; message: string }
  /**
   * Tokens the session used since the previous `usage` event (PM-178), per model and scope, read
   * from the transcript as it grows (a subagent's when it stops). Always an increment: add it up.
   */
  | {
      type: 'usage';
      sessionId: string;
      entries: TokenUsage[];
      /**
       * The context of the conversation's last step in these lines (PM-213): its input, cache read
       * and cache write tokens together. Absent when the lines held no step of the main conversation.
       */
      contextTokens?: number;
    }
  /**
   * The conversation's compaction (PM-213), as the CLI reports it with its PreCompact and
   * PostCompact hooks. `started` and `finished` come for every compaction, the agent's own
   * included (`trigger`: "manual" or "auto"; `requested`: the server asked for it). `abandoned`:
   * the compaction the server asked for did not start or finish in time, and the session carries on.
   */
  | {
      type: 'compaction';
      sessionId: string;
      phase: 'started' | 'finished' | 'abandoned';
      trigger: string | null;
      requested: boolean;
    }
  /**
   * A pause was asked for (`pause`, PM-218) and the session is stopping: its input is held, and it
   * stops at the next tool boundary. Comes again when a stopped session starts working again
   * (an approval answered, a human typing in the terminal). `waitingFor`: the main agent's running
   * tool, or null.
   */
  | { type: 'session_pausing'; sessionId: string; waitingFor: string | null }
  /** The paused session stopped (see `PauseOutcome`); a session that exits meanwhile reports `exited`. */
  | { type: 'session_paused'; sessionId: string; point: PausePoint; tool: string | null };

/** The providers whose CLI the server compacts with a typed command (PM-213); Codex's was not checked. */
export const COMPACTING_PROVIDERS: ReadonlySet<AgentProvider> = new Set<AgentProvider>(['claude']);

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
  /** Why the provider is not usable, with `loggedIn === false` (PM-324). */
  problem?: ProviderProblem;
  /** The installed CLI's version and the oldest one the adapter works with, when known. */
  cliVersion?: string;
  minCliVersion?: string;
}

/** Error code of a session start refused because the provider is not logged in. */
export const PROVIDER_NOT_LOGGED_IN = 'provider_not_logged_in';

/**
 * Codex start refused because a project `.codex/` layer contains more than a `config.toml`
 * of allowed roots (PM-357). Details: `{ provider: 'codex', issues: Array<{ file: string;
 * keys: string[] }> }`; names only, never values.
 */
export const WORKSPACE_CODEX_CONFIG = 'workspace_codex_config';

/**
 * The answer to a permission request of a member whose approver is nobody (PM-165): read by the
 * agent, so English. No inbox item exists; the refusal is final, and `ask_human` is the way forward.
 */
export const APPROVER_NONE_REFUSAL =
  'Not allowed: nobody approves questions for this session. Do not retry it in another form. If you really need it, ask a human with ask_human and say why.';

export interface RunningSessionInfo {
  scopeId?: string;
  sessionId: string;
  pid: number;
  state: SessionState;
  cols: number;
  rows: number;
}

/** Where a paused session stopped (PM-218). */
export interface PauseOutcome {
  point: PausePoint;
  /** The main agent's tool the session stopped after, before or in; null when none. */
  tool: string | null;
}

export interface PauseOptions {
  /** After this many ms `forcePause` runs by itself; 0: at once; absent: no deadline. */
  forceAfterMs?: number;
}

export interface SessionRunner {
  closeScopes?(
    scopes: Array<{ sessionId: string; scopeId: string; sinceAgeMs?: number }>,
  ): Promise<Array<{ sessionId: string; cleanup: SessionCleanup }>>;
  /**
   * Reads only, spawns nothing. Rejects with code `workspace_codex_config` when the session's
   * own project configuration could run or allow commands outside the sandbox; resolves for
   * other providers and a clean directory.
   */
  assertWorkspaceConfig?(input: { provider: AgentProvider; cwd: string; engineId?: EngineId }): Promise<void>;
  start(spec: StartSessionSpec): Promise<RunningSessionInfo>;
  /**
   * Types a user message into the session once it is idle (queued otherwise); resolves once the CLI
   * took it (reported the prompt). Rejects when the process ended first, or when the message was
   * typed but the CLI did not take it in time (PM-571): it did not reach the agent, so the caller
   * must not count it as delivered. A slash command reports no prompt, so it resolves once typed.
   *
   * With a `deliveryId` (the sender's key for this message) the call is idempotent per process (PM-1205): a
   * repeat joins the message still awaited, and one the CLI already took (confirmed or not) is not typed
   * again. A call that did not take the message (rejected as not taken) may be repeated with the same id.
   * A message the CLI showed it was busy for after the timeout resolves as taken, unconfirmed.
   */
  sendUserMessage(sessionId: string, text: string, options?: { deliveryId?: string }): Promise<void>;
  /**
   * Compacts the session's conversation (PM-213): types the CLI's compaction command with
   * `instruction` once the session is idle, and holds every later message back until the CLI is
   * idle again. Resolves when the command is typed, false when the provider has no such command
   * (`COMPACTING_PROVIDERS`) or a compaction is on its way already. If the CLI does not start or
   * finish within the time limit, the runner gives up (`compaction` event, `abandoned`) and the
   * session takes messages again. Absent: no compaction.
   */
  compact?(sessionId: string, instruction: string): Promise<boolean>;
  /**
   * A message is still on its way into the session: queued, being typed, or typed but not yet
   * submitted (a first message included). A restart waits until it got through. Absent: nothing waits.
   */
  hasPendingInput?(sessionId: string): boolean;
  /** Raw keyboard input from an attached browser terminal. */
  writeTerminal(sessionId: string, data: string): void;
  resize(sessionId: string, cols: number, rows: number): void;
  /** Serialized screen and scrollback for newly attached viewers. */
  snapshot(sessionId: string): { data: string; cols: number; rows: number } | null;
  /**
   * A viewer attaches the terminal (PM-312): the runner may need to ask the engine that runs the
   * session to stream it first, so the screen comes asynchronously. Called for every attach; absent
   * (the local runner, whose screen is in memory): the hub uses `snapshot`. `null`: no screen.
   */
  attachTerminal?(sessionId: string): Promise<{ data: string; cols: number; rows: number } | null>;
  /**
   * The last viewer of the session's terminal has left (detached, disconnected or lost access), so a
   * remote engine can stop streaming it. Safe to call again for a session that has no viewer.
   * Absent: nothing to stop.
   */
  detachTerminal?(sessionId: string): void;
  stop(sessionId: string, opts?: { force?: boolean }): Promise<void>;
  isRunning(sessionId: string): boolean;
  list(): RunningSessionInfo[];
  onEvent(listener: (event: RunnerEvent) => void): () => void;
  /** Stops every session (server shutdown). */
  shutdown(): Promise<void>;
  /**
   * Pauses the session at its next tool boundary (PM-218): the running tool is waited for, no new
   * one starts, and the session's input is held back (`sendUserMessage` still queues; `writeTerminal`
   * is not held). Resolves with where it stopped; `{ point: 'exited' }` without an event for a
   * session that is not running. A second call returns the same promise, or the latest outcome of a
   * stopped session; the deadline stays the first call's. `null`: `release` took the pause back
   * before the session stopped. Events: `session_pausing` at once, `session_paused` when stopped.
   * A stopped session that starts working again stops again at the next boundary, with new events.
   */
  pause(sessionId: string, opts?: PauseOptions): Promise<PauseOutcome | null>;
  /**
   * Stops the session at once with one Esc (PM-218): starts the pause when there is none, and
   * forces a pause that is still stopping; a stopped one is left alone and its outcome returned.
   * A compaction asked for that is running is not waited for: the Esc cancels it and it is given up.
   */
  forcePause(sessionId: string): Promise<PauseOutcome | null>;
  /**
   * Ends the pause: a stopped session's input is let through, with a non-empty `nudge` typed first;
   * a session still stopping has its pause taken back (pending `pause` promises resolve to null).
   * A session still stopping whose turn is already ending (a halting answer or an Esc went out)
   * keeps the nudge too, typed once the turn has ended; otherwise the turn goes on and the nudge is
   * dropped. False, and nothing done, when there is no pause. No event: the caller knows.
   */
  release(sessionId: string, opts?: { nudge?: string }): boolean;
  /**
   * Login state of a provider's CLI (cached briefly). `start` refuses to spawn a session of a
   * provider that is not logged in, with an error whose `code` is `provider_not_logged_in`.
   */
  providerStatus?(
    provider: AgentProvider,
    opts?: { refresh?: boolean; member?: string; engineId?: EngineId },
  ): Promise<ProviderStatus>;
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
 * Decides tool permission requests. Implemented by runtime/sessions (it creates a "Rád vár"
 * inbox item through core/inbox and waits for a decision). The runner answers the hook with it.
 * When `signal` aborts (timeout or session exit) the broker must stop waiting.
 */
export interface PermissionBroker {
  decide(request: PermissionRequestInfo, signal: AbortSignal): Promise<PermissionDecision>;
  /**
   * The agent's own auto mode refused a tool call without asking (Claude Code's PermissionDenied
   * hook, PM-165): nothing to answer, only to record. `reason` is the agent's explanation.
   */
  refused?(request: PermissionRefusedInfo): void;
  /**
   * The agent asked a question at its terminal (Claude Code's AskUserQuestion, PM-199), where
   * nobody reads it: the questions go to the humans' inbox, the answer returns as a team message.
   * Resolves true when they did; false (or a rejection) leaves the question to the terminal.
   */
  forwardQuestion?(request: QuestionForwardInfo): Promise<boolean>;
}

export interface QuestionForwardInfo {
  sessionId: string;
  toolName: string;
  toolInput: unknown;
}

export interface PermissionRefusedInfo {
  sessionId: string;
  toolName: string;
  toolInput: unknown;
  reason?: string;
  /** Who refused: the engine's own guard (PM-1176); absent: the agent's own classifier (PM-165). */
  by?: 'engine_guard';
}

export type EngineGuardCode =
  'outside_writable_roots' | 'denied_path' | 'updated_input' | 'escalation_refused';

/** Engine mode only (PM-1176): the engine itself refused a tool call; one audit line, no path or input. */
export interface EngineGuard {
  refused(entry: { sessionId: string; member?: string; code: EngineGuardCode }): void;
}

export interface TranscriptReader {
  /**
   * Whether the transcript exists and is not empty (PM-340): only such a conversation can be
   * resumed, the CLI writes the file after its first message. `confineTo` as in `read`. Rejects
   * when the file cannot be checked (not a regular file in the conversation root, no access).
   */
  hasContent(path: string, opts?: { confineTo?: string; engineId?: EngineId }): Promise<boolean>;
  /**
   * Parses a whole transcript (Claude Code JSONL or Codex rollout JSONL) into chat items.
   * `provider` is the agent CLI that wrote it (default: guessed from the file name, Codex
   * rollouts are rollout-*.jsonl). `self` is the handle of the session's member (sender of
   * outgoing team messages; "unknown" when omitted). `firstUserOrigin` labels the first user
   * turn (`openingTurnOrigin`; default "brief"). `cwd` is the session's working directory: file
   * paths inside it are shown relative to it, as in the live chat (absolute when omitted).
   */
  read(
    path: string,
    opts?: {
      provider?: AgentProvider;
      self?: string;
      firstUserOrigin?: 'brief' | 'human';
      cwd?: string | null;
      /**
       * A conversation root: the transcript is read only as a regular file whose real path lies
       * in it, without following a final symlink or blocking on a FIFO.
       */
      confineTo?: string;
      /** The engine the transcript is on (PM-311); absent: `local`. The local reader ignores it. */
      engineId?: EngineId;
      /**
       * Only the last `limit` items (PM-1116), oldest first; all of them when absent. With `before`
       * (an item id) the last `limit` items before that item; an unknown id is an empty page.
       * A caller asks for one item more than it shows to learn whether older ones remain.
       */
      limit?: number;
      before?: string;
    },
  ): Promise<ChatItem[]>;
  /**
   * What the transcript says about where its conversation stood (PM-342), for a member who takes
   * the card over without the conversation: the CLI's compaction summary and up to 4 replies after
   * it (`compact`), else the last 6 replies (`last_replies`), at most `HANDOFF_SUMMARY_MAX`
   * characters. Null when there is no reply and no compaction, or the file is missing or cannot be
   * read; never rejects. `provider` is the CLI that wrote the transcript, `confineTo` as in `read`.
   */
  summary(
    path: string,
    opts: { provider: AgentProvider; confineTo?: string; engineId?: EngineId },
  ): Promise<HandoffSummary | null>;
}

/** PM-743: the tool call must not run now; `refuse` is the English message for the agent. */
export interface DependencyGate {
  refuse: string;
}

export interface PlanUsageProvider {
  /** Current plan usage of the logged-in account (Claude, or ChatGPT for Codex), or null if unavailable. */
  get(engineId?: EngineId): Promise<PlanUsage | null>;
}

/** How the runner starts the agent CLI's process: in a pseudo-terminal, or with plain pipes. */
export type TerminalMode = 'pty' | 'pipe';

export interface RunnerModuleOptions {
  processScope?: ProcessScopeConfig;
  scopeProcesses?: ScopeProcessSource;
  /**
   * Awaited before the PreToolUse answer of every tool that runs code, including subagents; failures
   * only log. A `DependencyGate` result holds the tool call back (PM-743).
   */
  refreshDependencies?: (cwd: string) => Promise<void | DependencyGate>;
  /**
   * `pipe` starts the CLI with pipes instead of a pseudo-terminal (PM-267): for the fake CLIs in a
   * development instance that has no PTY (a member's sandbox). Default `pty`.
   */
  terminal?: TerminalMode;
  /**
   * Where the runner keeps each session's private launch files (PM-156): an absolute path on the
   * machine the CLIs run on (the app home's `run` folder; tests pass a temporary root). The runner
   * creates it with mode 0700 and refuses to start a session when it cannot keep it private.
   */
  sessionConfigRoot: string;
  /** Path or name of the Claude Code CLI (default "claude"). Tests pass a fake CLI. */
  claudeBin: string;
  /** Base URL the CLI calls for HTTP hooks, e.g. http://127.0.0.1:4700 (the runner adds /hooks/<token>). */
  publicBaseUrl: string;
  broker: PermissionBroker;
  /**
   * Engine mode only (PM-1176): the runner itself keeps file tool calls inside the session's write
   * zone and drops a broker answer that changes the tool input, whatever the cloud decided; every
   * refusal is reported here. Absent (single mode): no such guard.
   */
  engineGuard?: EngineGuard;
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
  geminiBin?: string;
  geminiConfigDir?: string;
  /** Codex's home, where it keeps transcripts (default: $CODEX_HOME, else ~/.codex). Read only. */
  codexHome?: string;
  nanogptCodexHome?: string;
  nanogptKey?: () => Promise<string | null>;
  /**
   * On a remote engine the cloud holds the key and adds its presence to the status (PM-736): the
   * login check never asks for it. Default: false.
   */
  nanogptKeyInCloud?: boolean;
  /**
   * The environment the runner reads its defaults from ($CODEX_BIN, $CODEX_HOME,
   * $CLAUDE_CONFIG_DIR, PATH) and starts the CLIs with, after removing billing and host-session
   * variables. Explicit options above take precedence. Default: `process.env`.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * The tag of this instance (PM-320): set as `PROJECTMAN_INSTANCE` in the environment of every
   * local session, so a process that outlives its session can be recognised as this instance's.
   */
  instanceTag?: string;
  /**
   * Where the provider's configuration is looked at for settings that would override the protected
   * start (managed policy, the provider's user configuration): defaults are the providers' real
   * locations. Tests pass temporary directories.
   */
  ambientConfig?: AmbientConfigLocations;
}

/** Locations of the provider configuration a start inspects (see `inspectAmbientConfig`). */
export interface AmbientConfigLocations {
  /** Claude Code's managed policy files, in precedence order (default: the Linux and macOS paths). */
  claudeManaged?: string[];
  /** The user's Claude Code settings (default: `$CLAUDE_CONFIG_DIR/settings.json`, else `~/.claude/settings.json`). */
  claudeUser?: string;
  /** Codex's administrator files (default: `/etc/codex/*`). */
  codexManaged?: string[];
  /** Codex's user configuration (default: `$CODEX_HOME/config.toml`, else `~/.codex/config.toml`). */
  codexUser?: string;
  /**
   * Files whose mere presence refuses a Codex start (PM-1169): they are never read (default:
   * `/etc/codex/hooks.json`, and on macOS the two `com.openai.codex.plist` MDM preference files).
   * The user's `hooks.json` beside `codexUser` is checked as well.
   */
  codexPresenceRefused?: string[];
}

/**
 * Whether a provider's CLI hands an MCP tool result's `image` content to the model (PM-518); the
 * provider adapters' `capabilities.mcpImageResults` come from here, and so does the server when it
 * decides whether `read_message_attachment` sends an image or puts the file in the session folder.
 *
 * - claude: Claude Code passes MCP image blocks on (the point of PM-516).
 * - codex: openai/codex renders MCP tool result images to the model (PR #5600, October 2025).
 * - gemini: not established. The Gemini CLI documents image blocks in MCP results, but its feature
 *   request for passing them to the model as `inlineData` was open when this was checked.
 * - nanogpt: Codex against a custom provider; whether a result image reaches the model depends on
 *   the chosen model's input modalities, which projectman does not know.
 * A provider not known to pass images on gets `false`: the image then comes as a file.
 */
export const PROVIDER_MCP_IMAGE_RESULTS: Readonly<Record<AgentProvider, boolean>> = {
  claude: true,
  codex: true,
  gemini: false,
  nanogpt: false,
};

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
