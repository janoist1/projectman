import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { FastifyBaseLogger } from 'fastify';
import { DEFAULT_AGENT_PROVIDER, type AgentProvider } from '@projectman/shared';
import {
  PROVIDER_NOT_LOGGED_IN,
  type PauseOptions,
  type PauseOutcome,
  type ProviderStatus,
  type RunnerEvent,
  type RunnerModuleOptions,
  type RunningSessionInfo,
  type SessionLauncher,
  type SessionRunner,
  type StartSessionSpec,
} from '../contracts';
import { cliExists, runQuietly } from './cli';
import { buildChildEnv, buildSessionEnv } from './env';
import { hookUrlFor } from './hook-forwarder';
import {
  assertManagedVmPolicy,
  assertNoAmbientOverride,
  assertProviderVersion,
  ManagedVmUnavailableError,
  parseCliVersion,
} from './managed-vm';
import type { ProviderAdapter } from './providers/types';
import { createProviderAdapters, type ProviderAdapters } from './providers';
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
  private readonly opts: RunnerModuleOptions;
  private readonly log: FastifyBaseLogger;
  readonly adapters: ProviderAdapters;
  private readonly sessions = new Map<string, AgentSession>();
  private readonly finished = new Map<string, AgentSession>();
  private readonly byToken = new Map<string, AgentSession>();
  private readonly listeners = new Set<(event: RunnerEvent) => void>();
  /** By provider, or `provider:member` for a worker's own login (managed VM). */
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
    const launcher = this.opts.launcher;
    if (launcher) return this.startThroughLauncher(spec, provider, launcher);
    const dir = await stat(spec.cwd).catch(() => null);
    if (!dir?.isDirectory()) throw new Error(`working directory does not exist: ${spec.cwd}`);
    if (spec.policy) assertManagedVmPolicy(spec.policy);
    const managedVm = spec.policy?.execution?.profile === 'managed_vm';
    const env = buildSessionEnv(this.opts.env ?? process.env, spec.sessionId, { managedVm });
    if (!(await cliExists(adapter.bin, env.PATH))) {
      throw new Error(`${adapter.label} CLI not found: ${adapter.bin}`);
    }
    // The question-free profile starts only on a proven boundary, with a CLI it is proven for and
    // without configuration of the VM's own that would override the protected start (PM-141).
    if (managedVm) await this.assertManagedVm(spec, adapter, env);
    // A CLI without a subscription login can only sit at its login screen: do not spawn it.
    const status = await this.providerStatus(provider);
    if (status.loggedIn === false) throw new ProviderNotLoggedInError(adapter.label, status);

    const token = randomBytes(24).toString('base64url');
    const launch = await adapter.launch({
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
        logger: this.log,
        broker: this.opts.broker,
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
      session.spawn(launch.file, launch.args, env);
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

  /**
   * A session in the managed VM (PM-140): the launcher starts the provider's pinned CLI as the
   * member's worker account in a sandboxed unit and relays its terminal. Nothing runs locally;
   * workspace trust and the login check run as that worker too.
   */
  private async startThroughLauncher(
    spec: StartSessionSpec,
    provider: AgentProvider,
    launcher: SessionLauncher,
  ): Promise<RunningSessionInfo> {
    const adapter = this.adapters[provider];
    const layout = this.opts.workerLayout;
    if (!spec.member || !spec.egressToken || !layout)
      throw new Error('a session through the launcher needs its member, egress token and worker layout');
    const home = layout.home(spec.member);
    if (spec.policy) assertManagedVmPolicy(spec.policy);
    // The question-free profile's conditions hold behind the launcher too (PM-141): the boundary is
    // proven now, the CLI is a proven version, and the member's own configuration (its worker home)
    // does not override the protected start.
    if (spec.policy?.execution?.profile === 'managed_vm')
      await this.assertManagedVm(spec, adapter, buildChildEnv(this.opts.env ?? process.env), {
        home,
        confineTo: home,
      });
    const status = await this.providerStatus(provider, { member: spec.member });
    if (status.loggedIn === false) throw new ProviderNotLoggedInError(adapter.label, status);
    if (provider === 'claude') {
      const trust = await launcher
        .run({ member: spec.member, program: 'claude-trust', args: [spec.cwd], cwd: home, timeoutMs: 15_000 })
        .catch((err: unknown) => ({ exitCode: null, stderr: (err as Error).message }));
      if (trust.exitCode !== 0)
        this.log.warn(
          { sessionId: spec.sessionId, detail: trust.stderr.slice(0, 200) },
          'could not pre-accept workspace trust',
        );
    }
    const token = randomBytes(24).toString('base64url');
    const launch = await adapter.launch({
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
        logger: this.log,
        broker: this.opts.broker,
        permissionTimeoutMs: this.opts.permissionTimeoutMs,
        emit: (event) => this.emit(event),
        onExited: (exited) => this.retire(exited),
        onAuthError: () => this.statuses.delete(`${provider}:${spec.member}`),
        transcriptRoot: home,
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
      const proc = await launcher.start({
        sessionId: spec.sessionId,
        member: spec.member,
        provider,
        args: launch.cliArgs,
        cwd: spec.cwd,
        cols: session.screen.cols,
        rows: session.screen.rows,
        egressToken: spec.egressToken,
      });
      session.attach(proc);
    } catch (err) {
      this.sessions.delete(spec.sessionId);
      this.byToken.delete(token);
      session.dispose();
      this.emit({ type: 'state', sessionId: spec.sessionId, state: 'failed', activity: null });
      throw err;
    }
    this.log.info(
      { sessionId: spec.sessionId, provider, member: spec.member, resume: spec.resume, cwd: spec.cwd },
      'agent session started through the launcher',
    );
    return session.info();
  }

  /**
   * The managed VM profile's conditions, asked at every start, resume included: the boundary is
   * proven now (never from a flag), the policy is for that boundary's profile, the installed CLI
   * is a version the question-free settings are proven for, and no configuration of the VM's own
   * would override them. Any failure is `managed_vm_unavailable`; nothing is spawned.
   */
  private async assertManagedVm(
    spec: StartSessionSpec,
    adapter: ProviderAdapter,
    env: Record<string, string>,
    worker?: { home: string; confineTo: string },
  ): Promise<void> {
    const boundary = this.opts.managedVm;
    if (!boundary) {
      throw new ManagedVmUnavailableError(
        'no_boundary',
        'this installation has no verified managed VM boundary, so a managed VM session does not start',
      );
    }
    const attestation = await boundary.verify();
    const wanted = spec.policy!.execution!.boundary;
    if (wanted.name !== attestation.profile.name || wanted.version !== attestation.profile.version) {
      throw new ManagedVmUnavailableError(
        'profile_mismatch',
        `the session asks for ${wanted.name}@${wanted.version}, the verified boundary is ${attestation.profile.name}@${attestation.profile.version}`,
        { wanted, verified: attestation.profile },
      );
    }
    const version = await runQuietly(adapter.bin, ['--version'], env);
    assertProviderVersion(adapter.provider, parseCliVersion(version.stdout), attestation);
    await assertNoAmbientOverride({
      provider: adapter.provider,
      cwd: spec.cwd,
      // Behind the launcher the CLI runs as the worker: its user configuration is in the worker home,
      // which the worker controls (read without following a link or blocking on a FIFO).
      env: worker ? { HOME: worker.home } : env,
      locations: this.opts.ambientConfig,
      ...(worker ? { confineTo: worker.confineTo } : {}),
    });
  }

  /** Login state of a provider's CLI; checks are shared while running and cached briefly. */
  providerStatus(
    provider: AgentProvider,
    opts: { refresh?: boolean; member?: string } = {},
  ): Promise<ProviderStatus> {
    const adapter = this.adapters[provider];
    if (!adapter) return Promise.reject(new Error(`unknown agent provider: ${String(provider)}`));
    const launcher = this.opts.launcher;
    const layout = this.opts.workerLayout;
    // Through the launcher each worker has its own login; the server's is checked otherwise.
    const member = launcher && layout ? (opts.member ?? null) : null;
    const key = member ? `${provider}:${member}` : provider;
    const cached = this.statuses.get(key);
    if (cached && !opts.refresh) {
      const ttl = cached.status.loggedIn === true ? STATUS_TTL_OK_MS : STATUS_TTL_OTHER_MS;
      if (Date.now() - cached.at < ttl) return Promise.resolve(cached.status);
    }
    let pending = this.statusChecks.get(key);
    if (!pending) {
      pending = (async (): Promise<ProviderStatus> => {
        if (member && launcher && layout) {
          const out = await launcher
            .run({
              member,
              program: provider,
              args: adapter.loginCommand,
              cwd: layout.home(member),
              timeoutMs: 15_000,
            })
            .then((r) => ({
              code: r.exitCode,
              stdout: r.stdout,
              stderr: r.stderr,
              error: r.timedOut ? 'timed out' : null,
            }))
            .catch((err: unknown) => ({ code: null, stdout: '', stderr: '', error: (err as Error).message }));
          return adapter.parseLogin(out);
        }
        const env = buildChildEnv(this.opts.env ?? process.env);
        if (!(await cliExists(adapter.bin, env.PATH))) {
          return {
            provider,
            loggedIn: null,
            method: null,
            checkedAt: new Date().toISOString(),
            detail: `${adapter.label} CLI not found: ${adapter.bin}`,
          };
        }
        return adapter.checkLogin(env);
      })()
        .then((status) => {
          this.statuses.set(key, { status, at: Date.now() });
          if (status.loggedIn !== true) this.log.warn({ status, member }, 'agent CLI is not usable');
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
    return session.enqueue(text);
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
