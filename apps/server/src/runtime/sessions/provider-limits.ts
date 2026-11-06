import type { AgentProvider, EngineId, PlanUsage, Session } from '@projectman/shared';
import type { EngineDirectory, RunnerEvent, SessionRunner } from '../../contracts';
import { conflict } from '../../kernel';
import type { DomainContext } from '../../core/base';
import type { InboxService } from '../../core/inbox';
import type { ProjectService } from '../../core/projects';
import { ProviderQuotaHolds } from '../usage';
import type { PlanUsageCache, QuotaScope, UsageAlerts } from '../usage';
import { engineIdOf, engineOption } from './engines';
import type { SessionOrchestratorDeps } from './sessions';

interface ProviderLimitsDeps {
  ctx: DomainContext;
  /** The host's engine, where the shared NanoGPT key is measured, and whose key an engine's sessions use. */
  engines: Pick<EngineDirectory, 'hostEngine' | 'nanogptKeyHolder'>;
  projects: Pick<ProjectService, 'cachedConfig'>;
  runner: Pick<SessionRunner, 'providerStatus'>;
  /** The warning limit of a session's tokens (PM-187), checked whenever its usage grows. */
  usageAlerts?: Pick<UsageAlerts, 'check'>;
  /** Quota alerts are raised once per shared-provider hold (PM-377). */
  inbox?: Pick<InboxService, 'raiseAlert'>;
  onAuthError?: SessionOrchestratorDeps['onAuthError'];
  publish: (session: Session) => void;
  /** Runs a job that the manager's shutdown does not wait for (`SessionLifecycle.run`). */
  background: <A>(job: () => Promise<A>) => Promise<A | undefined>;
}

type QuotaResume = (session: Session, stageId: string, after: 'quota' | 'login') => Promise<void>;
const GEMINI_QUOTA_FALLBACK_MS = 30 * 60_000;

/**
 * What a session's provider limits: the tokens it used and the warning limit (PM-187), the hold on a
 * shared provider's request quota (PM-377) and a lost login (PM-467). The last two continue a card
 * through the same `quotaResume`.
 */
export class ProviderLimits {
  private readonly deps: ProviderLimitsDeps;
  private readonly providerHolds = new ProviderQuotaHolds();
  private quotaUsage: Pick<PlanUsageCache, 'get' | 'invalidate'> | undefined;
  private quotaResume: QuotaResume | undefined;
  private quotaReassign: ((session: Session, stageId: string) => Promise<void>) | undefined;
  /** Sessions whose CLI reported a lost login, and of which provider, until they end (PM-467). */
  private readonly lostLogins = new Map<string, AgentProvider>();
  /** The usage measurement behind a fresh NanoGPT hold, per key. */
  private readonly quotaProbe = new Map<QuotaScope, Promise<PlanUsage | null>>();

  constructor(deps: ProviderLimitsDeps) {
    this.deps = deps;
    const reset = this.latestGeminiReset();
    if (reset) this.providerHolds.until('gemini', new Date(reset), deps.ctx.now());
  }

  /**
   * The reset time of the newest Gemini hold that was told to the owners: the durable copy of the hold. It is
   * the `system_notice` message of the hold (PM-1250), or an alert item that older versions stored.
   */
  private latestGeminiReset(): string | null {
    const { repos } = this.deps.ctx;
    const legacy = repos.inbox.latestProviderQuota('gemini')?.payload.until;
    const notice = repos.messages.latestSystemNotice('provider_rate_limited', {
      match: { key: 'provider', value: 'gemini' },
    })?.params.until;
    const times = [legacy, notice].filter((value): value is string => typeof value === 'string');
    return times.sort().at(-1) ?? null;
  }

  useQuotaRecovery(
    usage: Pick<PlanUsageCache, 'get' | 'invalidate'>,
    resume: QuotaResume,
    reassign?: (session: Session, stageId: string) => Promise<void>,
  ): void {
    this.quotaUsage = usage;
    this.quotaResume = resume;
    this.quotaReassign = reassign;
  }

  /** Whose NanoGPT key the engine's sessions use; without an engine or a directory answer, the cloud's. */
  private scopeOf(engineId: EngineId | null | undefined): QuotaScope {
    return (engineId ? this.deps.engines.nanogptKeyHolder?.(engineId) : undefined) ?? 'host';
  }

  /** The engine that measures a key: the host's engine for the cloud's key, else the engine owning it. */
  private probeEngine(scope: QuotaScope): EngineId | null {
    return scope === 'host' ? this.deps.engines.hostEngine() : scope;
  }

  /**
   * A NanoGPT hold is per key (PM-1091): the cloud's key is shared by the whole instance (PM-377), an
   * engine's own key (PM-1068) holds only that engine's sessions. Only a measurement on the engine that
   * owns the key lifts or moves its hold: the host's engine for the cloud's, the engine itself for its own.
   */
  observeProviderUsage(provider: AgentProvider, engineId: EngineId, usage: PlanUsage | null): void {
    if (provider !== 'nanogpt') return;
    const scope = this.scopeOf(engineId);
    if (!this.quotaProbe.has(scope) && engineId === this.probeEngine(scope))
      this.providerHolds.observed(provider, usage, this.deps.ctx.now(), scope);
  }

  /**
   * Persisted quota deferrals must check usage again before any restart-time inference, on the key of
   * the engine each deferred start runs on (null: its engine is gone, which is the cloud's key).
   */
  restoreProviderQuota(engineIds: Array<EngineId | null>): void {
    for (const scope of new Set(engineIds.map((id) => this.scopeOf(id))))
      if (this.providerHolds.start('nanogpt', this.deps.ctx.now(), scope)) this.invalidateQuotaUsage(scope);
  }

  private invalidateQuotaUsage(scope: QuotaScope): void {
    const engine = this.probeEngine(scope);
    if (engine) this.quotaUsage?.invalidate(engine);
  }

  /** Unknown quota holds retry only the read-only usage probe, never inference. */
  async refreshProviderQuota(): Promise<void> {
    const now = this.deps.ctx.now();
    await Promise.all(
      this.providerHolds.unknownScopes('nanogpt', now).map(async (scope) => {
        if (this.quotaProbe.has(scope)) return;
        const usage = (await this.quotaUsage?.get('nanogpt', this.probeEngine(scope))) ?? null;
        this.providerHolds.observed('nanogpt', usage, this.deps.ctx.now(), scope);
      }),
    );
  }

  /** The hold on the provider's key that the engine's sessions use (null/undefined: the cloud's). */
  assertProviderCooldown(provider: AgentProvider, engineId: EngineId | null | undefined): void {
    const hold = this.providerHolds.check(provider, this.deps.ctx.now(), this.scopeOf(engineId));
    if (hold)
      throw conflict('provider_rate_limited', 'Provider request limit reached', {
        provider,
        until: hold.until?.toISOString() ?? null,
        kind: hold.kind,
      });
  }

  /** The runner reported token usage of the session. */
  usage(session: Session, event: Extract<RunnerEvent, { type: 'usage' }>): void {
    const { ctx, usageAlerts } = this.deps;
    if (event.contextTokens !== undefined)
      ctx.repos.sessions.setContextTokens(session.id, event.contextTokens);
    if (event.entries.length === 0) return;
    // Counted at once (PM-178). During a turn the session's state changes carry the new sum to
    // the screens; once the turn is over (its last lines may come after the Stop), this does.
    ctx.repos.tokenUsage.add(
      {
        sessionId: session.id,
        projectKey: session.projectKey,
        member: session.member,
        taskKey: session.workItem.type === 'task' ? session.workItem.taskKey : null,
      },
      ctx.now(),
      event.entries,
    );
    // The warning limit (PM-187) only marks the session and tells the owners: it keeps running.
    let alerted = false;
    try {
      alerted = usageAlerts?.check(session.id) ?? false;
    } catch (err) {
      ctx.logger.warn({ err, sessionId: session.id }, 'usage alert check failed');
    }
    if (session.state !== 'working' || alerted) this.deps.publish(ctx.repos.sessions.get(session.id)!);
  }

  /** A shared-provider request limit holds admission until recovery or the reported reset. */
  rateLimited(session: Session, event: Extract<RunnerEvent, { type: 'rate_limited' }>): void {
    const { background, ctx } = this.deps;
    if (event.provider === 'gemini') {
      const now = ctx.now();
      const reported = event.resetsAt ? new Date(event.resetsAt) : null;
      const until =
        reported && Number.isFinite(reported.getTime()) && reported > now
          ? reported
          : new Date(now.getTime() + GEMINI_QUOTA_FALLBACK_MS);
      const started = this.providerHolds.until('gemini', until, now);
      // Small reset differences between concurrent failures do not tell the owners again. A material
      // extension starts a new notice.
      const heldUntil = this.providerHolds.check('gemini', now)!.until!.toISOString();
      const previousReset = Date.parse(this.latestGeminiReset() ?? '');
      if (started || !Number.isFinite(previousReset) || Date.parse(heldUntil) - previousReset >= 60_000)
        this.quotaAlert(session, 'gemini', event.message, null);
      const stageId =
        session.workItem.type === 'task' ? ctx.repos.tasks.get(session.workItem.taskKey)?.stageId : undefined;
      if (stageId)
        void background(() => this.quotaReassign?.(session, stageId) ?? Promise.resolve()).catch(
          (err: unknown) =>
            ctx.logger.error({ err, sessionId: session.id }, 'provider quota reassignment failed'),
        );
      return;
    }
    if (event.provider !== 'nanogpt') return;
    const scope = this.scopeOf(engineIdOf(session));
    const started = this.providerHolds.start(event.provider, ctx.now(), scope);
    if (started) {
      this.invalidateQuotaUsage(scope);
      this.quotaProbe.set(
        scope,
        Promise.resolve()
          .then(() => this.quotaUsage?.get('nanogpt', this.probeEngine(scope)) ?? null)
          .catch(() => null),
      );
    }
    const stageId =
      session.workItem.type === 'task' ? ctx.repos.tasks.get(session.workItem.taskKey)?.stageId : undefined;
    // Persist the continuation while the usage request is still pending: a restart
    // during its timeout must not lose the affected task's wake-up.
    const resume = this.quotaResume;
    if (stageId && resume)
      void background(() => resume(session, stageId, 'quota')).catch((err: unknown) =>
        ctx.logger.error({ err, sessionId: session.id }, 'provider quota deferral failed'),
      );
    void background(() => this.finishQuotaFailure(session, event.message, started, scope, stageId)).catch(
      (err: unknown) => ctx.logger.error({ err, sessionId: session.id }, 'provider quota recovery failed'),
    );
  }

  /** The session's CLI lost its login; the runner stops the session, and its final state carries the message. */
  authError(session: Session, event: Extract<RunnerEvent, { type: 'auth_error' }>): void {
    this.lostLogins.set(session.id, event.provider);
    this.deps.onAuthError?.(session.projectKey, session.member, event.provider, engineIdOf(session));
    this.deps.ctx.logger.warn(
      { sessionId: session.id, provider: event.provider, message: event.message },
      'agent CLI lost its login',
    );
  }

  /** The provider whose login the session lost, if it did; read before the session is marked ended. */
  lostLogin(sessionId: string): AgentProvider | undefined {
    return this.lostLogins.get(sessionId);
  }

  /** The session ended: it no longer carries a lost login. */
  ended(sessionId: string): void {
    this.lostLogins.delete(sessionId);
  }

  private async finishQuotaFailure(
    session: Session,
    message: string,
    started: boolean,
    scope: QuotaScope,
    stageId?: string,
  ): Promise<void> {
    const { ctx } = this.deps;
    const usage = (await this.quotaProbe.get(scope)) ?? null;
    if (started) {
      this.providerHolds.settle('nanogpt', usage, ctx.now(), scope);
      this.quotaProbe.delete(scope);
      this.quotaAlert(session, 'nanogpt', message, usage, scope);
    }
    if (session.workItem.type === 'task' && stageId) await this.quotaResume?.(session, stageId, 'quota');
  }

  private quotaAlert(
    session: Session,
    provider: AgentProvider,
    message: string,
    usage: PlanUsage | null,
    scope: QuotaScope = 'host',
  ): void {
    const { ctx } = this.deps;
    const hold = this.providerHolds.check(provider, ctx.now(), scope);
    this.deps.inbox?.raiseAlert({
      projectKey: session.projectKey,
      source: session.member,
      sessionId: session.id,
      taskKey: session.workItem.type === 'task' ? session.workItem.taskKey : null,
      title: `${provider === 'gemini' ? 'Gemini' : 'NanoGPT'} request limit reached`,
      payload: {
        alert: 'provider_rate_limited',
        provider,
        until: hold?.until?.toISOString() ?? null,
        weeklyPercent: usage?.weeklyPercent ?? null,
        message,
        workItem: session.workItem,
      },
    });
  }

  /**
   * A task's session ended because its CLI lost the provider login (PM-467). The login is checked
   * afresh: only a confirmed logout parks the task until the login is back (then admission resumes
   * it). A login the check still finds, or cannot judge, is not a reason to start again: the
   * server may refuse a login the CLI believes in, and every restart would fail the same way.
   */
  async resumeAfterLoginLost(session: Session, provider: AgentProvider): Promise<void> {
    const { ctx } = this.deps;
    if (session.workItem.type !== 'task') return;
    const stageId = ctx.repos.tasks.get(session.workItem.taskKey)?.stageId;
    if (!stageId) return;
    let status;
    try {
      status = await this.deps.runner.providerStatus?.(provider, {
        member: session.member,
        refresh: true,
        ...engineOption(engineIdOf(session)),
      });
    } catch (err) {
      ctx.logger.warn({ err, sessionId: session.id, provider }, 'could not check the provider login');
    }
    if (status?.loggedIn !== false) {
      ctx.logger.warn(
        { sessionId: session.id, provider, loggedIn: status?.loggedIn ?? null },
        'the session lost its login but the provider is not confirmed logged out: no automatic resume',
      );
      return;
    }
    await this.quotaResume?.(session, stageId, 'login');
  }
}
