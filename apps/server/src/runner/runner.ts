import { randomBytes } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import type { FastifyBaseLogger } from 'fastify';
import {
  cliVersionAtLeast,
  CODEX_PERMISSION_PROFILE_MIN_VERSION,
  DEFAULT_AGENT_PROVIDER,
  type AgentProvider,
} from '@projectman/shared';
import {
  PROVIDER_NOT_LOGGED_IN,
  type PauseOptions,
  type PauseOutcome,
  type ProviderStatus,
  type RunnerEvent,
  type RunnerModuleOptions,
  type RunningSessionInfo,
  type SessionRunner,
  type StartSessionSpec,
} from '../contracts';
import { cliExists, resolveCliPath, runQuietly } from './cli';
import { buildChildEnv, buildSessionEnv } from './env';
import { hookUrlFor } from './hook-forwarder';
import { assertCodexMemberWorkspace, parseCliVersion, inspectCodexSandboxConfig } from './ambient-config';
import type { ProviderAdapter } from './providers/types';
import { createProviderAdapters, type ProviderAdapters } from './providers';
import { NanogptStartError } from './providers/nanogpt';
import { CodexStartError, defaultCodexHome } from './providers/codex';
import { pipeSpawn } from './pipe-spawn';
import { AgentSession, UUID_RE } from './session';

/** What pausing a session that is not running reports (nothing to wait for, no event). */
const NOT_RUNNING: PauseOutcome = { point: 'exited', tool: null };

/** Exited sessions kept for a last look at their terminal. */
const MAX_FINISHED = 20;
/** A login check is reused this long when it said "logged in", and this long otherwise. */
const STATUS_TTL_OK_MS = 60_000;
const STATUS_TTL_OTHER_MS = 5_000;

/** A session start refused because the provider's CLI is not logged in with a subscription. */
export class ProviderNotLoggedInError extends Error {
  readonly code = PROVIDER_NOT_LOGGED_IN;
  readonly provider: AgentProvider;
  readonly status: ProviderStatus;

  constructor(label: string, status: ProviderStatus) {
    super(`${label} is not logged in with a subscription${status.detail ? `: ${status.detail}` : ''}`);
    this.name = 'ProviderNotLoggedInError';
    this.provider = status.provider;
    this.status = status;
  }
}

/**
 * Runs interactive agent CLI sessions (Claude Code, Codex), one pseudo-terminal each, through
 * the provider adapters. Sessions do not survive a server restart (v1); their conversations
 * do, and can be resumed.
 */
export class SessionManager implements SessionRunner {
  async assertWorkspaceConfig(input: { provider: AgentProvider; cwd: string }): Promise<void> {
    if (input.provider === 'codex') await assertCodexMemberWorkspace(input.cwd);
  }
  private readonly opts: RunnerModuleOptions;
  private readonly log: FastifyBaseLogger;
  readonly adapters: ProviderAdapters;
  private readonly sessions = new Map<string, AgentSession>();
  private readonly finished = new Map<string, AgentSession>();
  private readonly byToken = new Map<string, AgentSession>();
  private readonly listeners = new Set<(event: RunnerEvent) => void>();
  /** Cached login status by provider. */
  private readonly statuses = new Map<string, { status: ProviderStatus; at: number }>();
  private readonly statusChecks = new Map<string, Promise<ProviderStatus>>();

  constructor(opts: RunnerModuleOptions, adapters: ProviderAdapters = createProviderAdapters(opts)) {
    this.opts = opts;
    this.log = opts.logger;
    this.adapters = adapters;
    if (opts.terminal === 'pipe')
      this.log.warn(
        'sessions run without a terminal (PROJECTMAN_TERMINAL=pipe): only the fake CLIs work this way',
      );
  }

  async start(spec: StartSessionSpec): Promise<RunningSessionInfo> {
    if (!spec.sessionId) throw new Error('sessionId is required');
    const provider = spec.provider ?? DEFAULT_AGENT_PROVIDER;
    const adapter = this.adapters[provider];
    if (!adapter) throw new Error(`unknown agent provider: ${String(provider)}`);
    if (!UUID_RE.test(spec.claudeSessionId))
      throw new Error(
        `invalid ${provider === 'claude' ? 'Claude' : adapter.label} session id: ${spec.claudeSessionId}`,
      );
    if (this.sessions.has(spec.sessionId)) throw new Error(`session ${spec.sessionId} is already running`);
    await this.assertWorkspaceConfig({ provider, cwd: spec.cwd });
    const dir = await stat(spec.cwd).catch(() => null);
    if (!dir?.isDirectory()) throw new Error(`working directory does not exist: ${spec.cwd}`);
    const env = buildSessionEnv(this.opts.env ?? process.env, spec.sessionId, {
      instanceTag: this.opts.instanceTag,
    });
    if (provider !== 'nanogpt' && !(await cliExists(adapter.bin, env.PATH))) {
      if (provider === 'codex')
        throw new CodexStartError({
          problem: 'cli_missing',
          minCliVersion: CODEX_PERMISSION_PROFILE_MIN_VERSION,
        });
      throw new Error(`${adapter.label} CLI not found: ${adapter.bin}`);
    }
    if (provider === 'codex') {
      env.CODEX_HOME = this.opts.codexHome ?? defaultCodexHome(env);
      await this.assertCodexProfileStart(spec, adapter, env);
    }
    // A CLI without a subscription login can only sit at its login screen: do not spawn it.
    const status = await this.providerStatus(provider, { refresh: provider === 'nanogpt' });
    if (status.loggedIn === false) {
      if (provider === 'nanogpt')
        throw new NanogptStartError(
          status.problem === 'no_key' ? 'nanogpt_key_missing' : 'nanogpt_setup_incomplete',
          { problem: status.problem, cliVersion: status.cliVersion, minCliVersion: status.minCliVersion },
        );
      throw new ProviderNotLoggedInError(adapter.label, status);
    }

    const token = randomBytes(24).toString('base64url');
    const launch = await adapter.launch({
      ...(provider === 'codex' || provider === 'nanogpt'
        ? { cliPath: (await resolveCliPath(adapter.bin, env.PATH)) ?? undefined }
        : {}),
      spec,
      hookUrl: hookUrlFor(this.opts.publicBaseUrl, token),
      permissionTimeoutMs: this.opts.permissionTimeoutMs,
    });
    const session = new AgentSession({
      spec,
      hookToken: token,
      adapter,
      initialMessageSent: launch.initialMessageSent,
      deps: {
        ...(launch.conversationRoot ? { transcriptRoot: launch.conversationRoot } : {}),
        logger: this.log,
        broker: this.opts.broker,
        refreshDependencies: this.opts.refreshDependencies,
        permissionTimeoutMs: this.opts.permissionTimeoutMs,
        emit: (event) => this.emit(event),
        onExited: (exited) => this.retire(exited),
        onAuthError: () => this.statuses.delete(provider),
        ...(this.opts.terminal === 'pipe' ? { spawnPty: pipeSpawn } : {}),
      },
    });

    const previous = this.finished.get(spec.sessionId);
    if (previous) {
      this.finished.delete(spec.sessionId);
      previous.dispose();
    }
    this.sessions.set(spec.sessionId, session);
    this.byToken.set(token, session);
    try {
      session.spawn(launch.file, launch.args, { ...env, ...launch.env });
    } catch (err) {
      this.sessions.delete(spec.sessionId);
      this.byToken.delete(token);
      session.dispose();
      this.emit({ type: 'state', sessionId: spec.sessionId, state: 'failed', activity: null });
      throw err;
    }
    this.log.info(
      { sessionId: spec.sessionId, provider, pid: session.info().pid, resume: spec.resume, cwd: spec.cwd },
      'agent session started',
    );
    return session.info();
  }

  private async assertCodexProfileStart(
    spec: StartSessionSpec,
    adapter: ProviderAdapter,
    env: Record<string, string>,
  ): Promise<void> {
    const version = await runQuietly(adapter.bin, ['--version'], env);
    const cliVersion = parseCliVersion(version.stdout);
    const minCliVersion = CODEX_PERMISSION_PROFILE_MIN_VERSION;
    if (version.error || version.code !== 0 || cliVersion === null)
      throw new CodexStartError({ problem: 'cli_missing', minCliVersion });
    if (!cliVersionAtLeast(cliVersion, minCliVersion))
      throw new CodexStartError({ problem: 'cli_too_old', cliVersion, minCliVersion });
    const ambientConfig = await inspectCodexSandboxConfig({
      cwd: await realpath(spec.cwd),
      env,
      locations: this.opts.ambientConfig,
    });
    if (ambientConfig.length)
      throw new CodexStartError({ problem: 'sandbox_config', cliVersion, minCliVersion, ambientConfig });
  }

  /** Login state of a provider's CLI; checks are shared while running and cached briefly. */
  providerStatus(
    provider: AgentProvider,
    opts: { refresh?: boolean; member?: string } = {},
  ): Promise<ProviderStatus> {
    const adapter = this.adapters[provider];
    if (!adapter) return Promise.reject(new Error(`unknown agent provider: ${String(provider)}`));
    const key = provider;
    const cached = this.statuses.get(key);
    if (cached && !opts.refresh) {
      const ttl = cached.status.loggedIn === true ? STATUS_TTL_OK_MS : STATUS_TTL_OTHER_MS;
      if (Date.now() - cached.at < ttl) return Promise.resolve(cached.status);
    }
    let pending = this.statusChecks.get(key);
    if (!pending) {
      pending = (async (): Promise<ProviderStatus> => {
        if (provider === 'nanogpt') return adapter.checkLogin(buildChildEnv(this.opts.env ?? process.env));
        const env = buildChildEnv(this.opts.env ?? process.env);
        if (provider === 'gemini') return adapter.checkLogin(env);
        if (!(await cliExists(adapter.bin, env.PATH))) {
          return {
            provider,
            loggedIn: false,
            problem: 'cli_missing',
            method: null,
            checkedAt: new Date().toISOString(),
            detail: `${adapter.label} CLI not found: ${adapter.bin}`,
          };
        }
        return adapter.checkLogin(env);
      })()
        .then((status) => {
          this.statuses.set(key, { status, at: Date.now() });
          if (status.loggedIn !== true) this.log.warn({ status }, 'agent CLI is not usable');
          return status;
        })
        .finally(() => this.statusChecks.delete(key));
      this.statusChecks.set(key, pending);
    }
    return pending;
  }

  sendUserMessage(sessionId: string, text: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return Promise.reject(new Error(`session ${sessionId} is not running`));
    return session.send(text);
  }

  async compact(sessionId: string, instruction: string): Promise<boolean> {
    return (await this.sessions.get(sessionId)?.compact(instruction)) ?? false;
  }

  /** A session that is not running has already stopped: it reports `exited`. */
  async pause(sessionId: string, opts?: PauseOptions): Promise<PauseOutcome | null> {
    return (await this.sessions.get(sessionId)?.pause(opts)) ?? NOT_RUNNING;
  }

  async forcePause(sessionId: string): Promise<PauseOutcome | null> {
    return (await this.sessions.get(sessionId)?.forcePause()) ?? NOT_RUNNING;
  }

  release(sessionId: string, opts?: { nudge?: string }): boolean {
    return this.sessions.get(sessionId)?.release(opts) ?? false;
  }

  hasPendingInput(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.hasPendingInput ?? false;
  }

  writeTerminal(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.sessions.get(sessionId)?.resize(cols, rows);
  }

  snapshot(sessionId: string): { data: string; cols: number; rows: number } | null {
    const session = this.sessions.get(sessionId) ?? this.finished.get(sessionId);
    return session ? session.snapshot() : null;
  }

  async stop(sessionId: string, opts?: { force?: boolean }): Promise<void> {
    await this.sessions.get(sessionId)?.stop(opts?.force ?? false);
  }

  isRunning(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  list(): RunningSessionInfo[] {
    return [...this.sessions.values()].map((s) => s.info());
  }

  onEvent(listener: (event: RunnerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => s.stop(false)));
    for (const session of this.finished.values()) session.dispose();
    this.finished.clear();
  }

  /** The live session a hook token belongs to. */
  sessionForToken(token: string): AgentSession | undefined {
    return this.byToken.get(token);
  }

  private retire(session: AgentSession): void {
    if (this.sessions.get(session.id) === session) this.sessions.delete(session.id);
    this.byToken.delete(session.hookToken);
    this.finished.set(session.id, session);
    while (this.finished.size > MAX_FINISHED) {
      const [oldestId, oldest] = this.finished.entries().next().value as [string, AgentSession];
      this.finished.delete(oldestId);
      oldest.dispose();
    }
  }

  private emit(event: RunnerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        this.log.error({ err, type: event.type }, 'runner event listener failed');
      }
    }
  }
}
