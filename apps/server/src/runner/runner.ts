import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { FastifyBaseLogger } from 'fastify';
import type {
  RunnerEvent,
  RunnerModuleOptions,
  RunningSessionInfo,
  SessionRunner,
  StartSessionSpec,
} from '../contracts';
import { buildClaudeArgs, buildSettings, hookUrlFor, resolveCommand } from './claude-args';
import { buildSessionEnv } from './env';
import { ClaudeSession } from './session';
import { defaultClaudeConfigPath, ensureWorkspaceTrusted } from './trust';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Exited sessions kept for a last look at their terminal. */
const MAX_FINISHED = 20;

/**
 * Runs interactive Claude Code sessions, one pseudo-terminal each. Sessions do not survive
 * a server restart (v1); their conversations do, and can be resumed.
 */
export class SessionManager implements SessionRunner {
  private readonly opts: RunnerModuleOptions;
  private readonly log: FastifyBaseLogger;
  private readonly sessions = new Map<string, ClaudeSession>();
  private readonly finished = new Map<string, ClaudeSession>();
  private readonly byToken = new Map<string, ClaudeSession>();
  private readonly listeners = new Set<(event: RunnerEvent) => void>();

  constructor(opts: RunnerModuleOptions) {
    this.opts = opts;
    this.log = opts.logger;
  }

  async start(spec: StartSessionSpec): Promise<RunningSessionInfo> {
    if (!spec.sessionId) throw new Error('sessionId is required');
    if (!UUID_RE.test(spec.claudeSessionId))
      throw new Error(`invalid Claude session id: ${spec.claudeSessionId}`);
    if (this.sessions.has(spec.sessionId)) throw new Error(`session ${spec.sessionId} is already running`);
    const dir = await stat(spec.cwd).catch(() => null);
    if (!dir?.isDirectory()) throw new Error(`working directory does not exist: ${spec.cwd}`);

    await this.trust(spec.cwd);

    const token = randomBytes(24).toString('base64url');
    const settings = buildSettings({
      hookUrl: hookUrlFor(this.opts.publicBaseUrl, token),
      allowedTools: spec.allowedTools,
      permissionTimeoutMs: this.opts.permissionTimeoutMs,
    });
    const command = resolveCommand(this.opts.claudeBin, buildClaudeArgs(spec, settings));
    const session = new ClaudeSession({
      spec,
      hookToken: token,
      deps: {
        logger: this.log,
        broker: this.opts.broker,
        permissionTimeoutMs: this.opts.permissionTimeoutMs,
        emit: (event) => this.emit(event),
        onExited: (exited) => this.retire(exited),
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
      session.spawn(command.file, command.args, buildSessionEnv(process.env, spec.sessionId));
    } catch (err) {
      this.sessions.delete(spec.sessionId);
      this.byToken.delete(token);
      session.dispose();
      this.emit({ type: 'state', sessionId: spec.sessionId, state: 'failed', activity: null });
      throw err;
    }
    this.log.info(
      { sessionId: spec.sessionId, pid: session.info().pid, resume: spec.resume, cwd: spec.cwd },
      'claude session started',
    );
    return session.info();
  }

  sendUserMessage(sessionId: string, text: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return Promise.reject(new Error(`session ${sessionId} is not running`));
    return session.enqueue(text);
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
  sessionForToken(token: string): ClaudeSession | undefined {
    return this.byToken.get(token);
  }

  private async trust(cwd: string): Promise<void> {
    if (this.opts.trustWorkspaces === false) return;
    const configPath = this.opts.claudeConfigPath ?? defaultClaudeConfigPath();
    try {
      const outcome = await ensureWorkspaceTrusted(configPath, cwd);
      if (outcome.result === 'trusted')
        this.log.info({ key: outcome.key }, 'pre-accepted Claude Code workspace trust');
      else if (outcome.result === 'skipped') {
        this.log.warn({ key: outcome.key, reason: outcome.reason }, 'could not pre-accept workspace trust');
      }
    } catch (err) {
      this.log.warn({ err, cwd }, 'could not pre-accept workspace trust');
    }
  }

  private retire(session: ClaudeSession): void {
    if (this.sessions.get(session.id) === session) this.sessions.delete(session.id);
    this.byToken.delete(session.hookToken);
    this.finished.set(session.id, session);
    while (this.finished.size > MAX_FINISHED) {
      const [oldestId, oldest] = this.finished.entries().next().value as [string, ClaudeSession];
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
