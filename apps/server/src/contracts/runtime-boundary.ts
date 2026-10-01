import type { AgentProvider, RuntimeBoundaryMode, RuntimeBoundaryStatus } from '@projectman/shared';

/**
 * The VM boundary (PM-140), owned by src/runtime-boundary. In the managed VM profile the server
 * (the service account) starts nothing itself: a root-owned launcher starts each agent session and
 * each command a member's workspace needs as that member's worker account (`pmw-<handle>`), in a
 * sandboxed transient systemd unit, and relays the session's terminal back. The launcher accepts
 * only these narrow requests: a registered member, a pinned program, a working directory in that
 * member's home, never a shell, an environment or a uid from the caller.
 */

/**
 * Programs the launcher runs as a worker; each maps to a fixed path in its configuration.
 * `claude-trust` is the app's own helper that records Claude Code's workspace trust for one
 * directory in the worker's ~/.claude.json (its only argument is that directory);
 * `boundary-probe` is the app's measurement of the boundary from inside a worker unit (verify.sh).
 */
export const WORKER_PROGRAMS = [
  'git',
  'mkdir',
  'rm',
  'mv',
  'claude',
  'codex',
  'claude-trust',
  'boundary-probe',
] as const;
export type WorkerProgram = (typeof WORKER_PROGRAMS)[number];

export interface LaunchSessionRequest {
  /** Our session id ("ses_..."); also names the transient unit. */
  sessionId: string;
  /** The AI member; the launcher runs the session as its worker account. */
  member: string;
  /** The launcher runs this provider's pinned CLI; the caller never names a file. */
  provider: AgentProvider;
  /** Arguments of the CLI (no shell). */
  args: string[];
  /** The working directory, inside the member's worker home. */
  cwd: string;
  cols: number;
  rows: number;
  /** The session's egress proxy credentials (the proxy maps them back to this session). */
  egressToken: string;
}

/** A session's terminal, relayed by the launcher. Shaped like a node-pty process. */
export interface LaunchedSession {
  /** The pid of the session's process as the launcher sees it (for logs; not a local pid). */
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Stops the session's unit (its whole process tree). */
  kill(signal?: string): void;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
}

export interface WorkerRunRequest {
  member: string;
  program: WorkerProgram;
  args: string[];
  /** Inside the member's worker home. */
  cwd: string;
  /** Default 120 s, at most 10 minutes. */
  timeoutMs?: number;
}

export interface WorkerRunResult {
  /** Null when the command was killed (timeout) or could not start. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** The command was stopped at its timeout. */
  timedOut: boolean;
}

export interface SessionLauncher {
  /** Starts a session as the member's worker; rejects when the launcher refuses or is down. */
  start(request: LaunchSessionRequest): Promise<LaunchedSession>;
  /** Runs one pinned program as the member's worker and collects its output. */
  run(request: WorkerRunRequest): Promise<WorkerRunResult>;
  /** Whether the launcher answers. */
  ping(): Promise<boolean>;
}

/** Where a member's worker keeps its files (managed VM profile). */
export interface WorkerLayout {
  /** The worker home, e.g. /var/lib/projectman-work/<handle>. */
  home(member: string): string;
  /** The member's durable workspaces (PM-138) inside its home. */
  workspaces(member: string): string;
  /** Where sessions without a workspace (chats, meetings, readers) run. */
  sessions(member: string, projectKey: string): string;
  /** Bundles the service hands to the worker (service writes, worker reads). */
  spoolIn(member: string): string;
  /** Bundles the worker hands to the service (worker writes, service reads). */
  spoolOut(member: string): string;
}

/** The boundary as the rest of the server sees it. */
export interface RuntimeBoundary {
  readonly mode: RuntimeBoundaryMode;
  /** Current verdict; cached briefly unless `refresh`. Never throws. */
  status(opts?: { refresh?: boolean }): Promise<RuntimeBoundaryStatus>;
  /** The launcher client (managed mode only). */
  readonly launcher: SessionLauncher | null;
  /** Worker paths (managed mode only). */
  readonly layout: WorkerLayout | null;
}
