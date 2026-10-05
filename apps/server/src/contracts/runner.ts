import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type {
  AgentEffort,
  AgentProvider,
  ChatItem,
  PausePoint,
  PlanUsage,
  ProviderProblem,
  SessionState,
  TokenUsage,
} from '@projectman/shared';
import type { SessionLauncher, WorkerLayout } from './runtime-boundary';
import type { SessionPolicy } from './session-policy';

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
  /**
   * The session's egress proxy credentials (managed VM, PM-140): the launcher puts them in the
   * proxy settings of the worker, and the proxy maps them back to this session. Required when the
   * runner starts sessions through the launcher.
   */
  egressToken?: string;
}

export type RunnerEvent =
  | { type: 'state'; sessionId: string; state: SessionState; activity: string | null }
  | { type: 'terminal_data'; sessionId: string; data: string }
  | { type: 'transcript_path'; sessionId: string; path: string }
  | { type: 'chat'; sessionId: string; items: ChatItem[] }
  | { type: 'exit'; sessionId: string; exitCode: number | null; signal: number | null }
  /**
   * The process got its first input (`StartSessionSpec.initialMessage`): Codex has it on its command
   * line as soon as it is started; Claude Code has it typed into the prompt once it reports
   * SessionStart. A process that ends before that never sends it, so the messages in that input
   * did not reach the agent.
   */
  | { type: 'first_input_sent'; sessionId: string }
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
 * Error code of a managed VM session start (PM-141) refused because the boundary is not proven
 * now, the installed CLI is not a version the question-free settings are proven for, or the VM's
 * own configuration would override the protected start. Its `reason` says which.
 */
export const MANAGED_VM_UNAVAILABLE = 'managed_vm_unavailable';

/**
 * The answer to a permission request that reaches a managed VM session anyway (read by the agent,
 * so English): the profile has no local approvals, and nothing is queued for a human.
 */
export const MANAGED_VM_NO_LOCAL_APPROVAL =
  'This installation runs without local approvals: the work you do in your workspace needs none, so this request is refused, not queued for a human. A step that leaves the machine is decided at the network gate; for a registered operation use submit_boundary_request. Continue with what you can do here.';

/**
 * The answer to a permission request of a member whose approver is nobody (PM-165): read by the
 * agent, so English. No inbox item exists; the refusal is final, and `ask_human` is the way forward.
 */
export const APPROVER_NONE_REFUSAL =
  'Not allowed: nobody approves questions for this session. Do not retry it in another form. If you really need it, ask a human with ask_human and say why.';

/** What a verified managed VM boundary says about itself, at the moment it was asked. */
export interface ManagedVmAttestation {
  /** The readiness profile the boundary was verified for. */
  profile: { name: string; version: number };
  /** When the proof was made (ISO time). */
  verifiedAt: string;
  /** The CLI versions the question-free settings are proven for, per provider. */
  providerVersions: Partial<Record<AgentProvider, readonly string[]>>;
}

/**
 * The proof that this installation is the owner's verified managed VM. It is asked at every start,
 * never answered from a flag: a repository file, the environment or a member's setting is not an
 * input. Implementations read the measured readiness report (`createReadinessBoundary`) or, later,
 * the protected launcher (PM-140). It rejects with an error whose `code` is `managed_vm_unavailable`.
 */
export interface ManagedVmBoundary {
  verify(): Promise<ManagedVmAttestation>;
}

export interface RunningSessionInfo {
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
  start(spec: StartSessionSpec): Promise<RunningSessionInfo>;
  /** Types a user message into the session once it is idle (queued otherwise); resolves when typed. */
  sendUserMessage(sessionId: string, text: string): Promise<void>;
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
   * With the launcher (managed VM) every member's worker has its own login: `member` names whose
   * login to check (without it, the server's own login is checked).
   */
  providerStatus?(
    provider: AgentProvider,
    opts?: { refresh?: boolean; member?: string },
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
 * Decides tool permission requests. Implemented by the domain (it creates a "Rád vár"
 * inbox item and waits for a human). The runner answers the hook with the decision.
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
}

export interface TranscriptReader {
  /**
   * Whether the transcript exists and is not empty (PM-340): only such a conversation can be
   * resumed, the CLI writes the file after its first message. `confineTo` as in `read`. Rejects
   * when the file cannot be checked (not a regular file in the worker home, no access).
   */
  hasContent(path: string, opts?: { confineTo?: string }): Promise<boolean>;
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
       * A worker home (PM-140): the transcript is read only as a regular file whose real path lies
       * in it, without following a final symlink or blocking on a FIFO.
       */
      confineTo?: string;
    },
  ): Promise<ChatItem[]>;
}

export interface PlanUsageProvider {
  /** Current plan usage of the logged-in account (Claude, or ChatGPT for Codex), or null if unavailable. */
  get(): Promise<PlanUsage | null>;
}

/** How the runner starts the agent CLI's process: in a pseudo-terminal, or with plain pipes. */
export type TerminalMode = 'pty' | 'pipe';

export interface RunnerModuleOptions {
  /**
   * `pipe` starts the CLI with pipes instead of a pseudo-terminal (PM-267): for the fake CLIs in a
   * development instance that has no PTY (a member's sandbox). Default `pty`. It has no effect on
   * sessions that start through the launcher.
   */
  terminal?: TerminalMode;
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
  geminiBin?: string;
  geminiConfigDir?: string;
  /** Codex's home, where it keeps transcripts (default: $CODEX_HOME, else ~/.codex). Read only. */
  codexHome?: string;
  nanogptCodexHome?: string;
  nanogptKey?: () => Promise<string | null>;
  /**
   * The environment the runner reads its defaults from ($CODEX_BIN, $CODEX_HOME,
   * $CLAUDE_CONFIG_DIR, PATH) and starts the CLIs with, after removing billing and host-session
   * variables. Explicit options above take precedence. Default: `process.env`.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * The tag of this instance (PM-320): set as `PROJECTMAN_INSTANCE` in the environment of every
   * local session, so a process that outlives its session can be recognised as this instance's.
   * The launcher's sessions run as another user and do not get it.
   */
  instanceTag?: string;
  /**
   * The protected launcher of the managed VM (PM-140). When set, every session starts through it
   * as its member's worker account, in a sandboxed unit, with the provider's pinned CLI; nothing
   * is spawned locally, and a session without a member or egress token is refused. Workspace
   * trust and login checks run as the worker too.
   */
  launcher?: SessionLauncher;
  /** Worker paths (with `launcher`): a session's transcript must lie in its worker's home. */
  workerLayout?: WorkerLayout;
  /**
   * The managed VM boundary (PM-141). Without it the runner refuses every session whose policy
   * asks for the managed VM profile; with it, each such start is verified first.
   */
  managedVm?: ManagedVmBoundary;
  /**
   * Where the VM's own configuration is looked at for settings that would override the protected
   * start (managed policy, the provider's user configuration): defaults are the providers' real
   * locations. Tests pass temporary directories.
   */
  ambientConfig?: AmbientConfigLocations;
}

/** Locations of the provider configuration a managed VM start inspects (see `inspectAmbientConfig`). */
export interface AmbientConfigLocations {
  /** Claude Code's managed policy files, in precedence order (default: the Linux and macOS paths). */
  claudeManaged?: string[];
  /** The user's Claude Code settings (default: `$CLAUDE_CONFIG_DIR/settings.json`, else `~/.claude/settings.json`). */
  claudeUser?: string;
  /** Codex's administrator files (default: `/etc/codex/*`). */
  codexManaged?: string[];
  /** Codex's user configuration (default: `$CODEX_HOME/config.toml`, else `~/.codex/config.toml`). */
  codexUser?: string;
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
