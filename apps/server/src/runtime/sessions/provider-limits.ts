import { ALERT_SEEN_OPTION } from '@projectman/shared';
import type { AgentProvider, PlanUsage, Session } from '@projectman/shared';
import type { RunnerEvent, SessionRunner } from '../../contracts';
import { ownerHandles } from '@projectman/shared';
import { conflict } from '../../kernel';
import type { DomainContext } from '../../core/base';
import type { InboxService } from '../../core/inbox';
import type { ProjectService } from '../../core/projects';
import { ProviderQuotaHolds } from '../usage';
import type { PlanUsageCache, UsageAlerts } from '../usage';
import { engineIdOf, engineOption } from './engines';
import type { SessionOrchestratorDeps } from './sessions';

interface ProviderLimitsDeps {
  ctx: DomainContext;
  projects: Pick<ProjectService, 'cachedConfig'>;
  runner: Pick<SessionRunner, 'providerStatus'>;
  /** The warning limit of a session's tokens (PM-187), checked whenever its usage grows. */
  usageAlerts?: Pick<UsageAlerts, 'check'>;
  /** Quota alerts are raised once per shared-provider hold (PM-377). */
  inbox?: Pick<InboxService, 'create'>;
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
  private quotaProbe: Promise<PlanUsage | null> | null = null;

  constructor(deps: ProviderLimitsDeps) {
    this.deps = deps;
    const reset = deps.ctx.repos.inbox.latestProviderQuota('gemini')?.payload.until;
    if (typeof reset === 'string') this.providerHolds.until('gemini', new Date(reset), deps.ctx.now());
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

  observeProviderUsage(provider: AgentProvider, usage: PlanUsage | null): void {
    if (provider === 'nanogpt' && !this.quotaProbe)
      this.providerHolds.observed(provider, usage, this.deps.ctx.now());
  }

  /** Persisted quota deferrals must check usage again before any restart-time inference. */
  restoreProviderQuota(): void {
    if (this.providerHolds.start('nanogpt', this.deps.ctx.now())) this.quotaUsage?.invalidate();
  }

  /** Unknown quota holds retry only the read-only usage probe, never inference. */
  async refreshProviderQuota(): Promise<void> {
    if (this.providerHolds.check('nanogpt', this.deps.ctx.now())?.kind !== 'unknown' || this.quotaProbe)
      return;
    const usage = (await this.quotaUsage?.get('nanogpt')) ?? null;
    this.providerHolds.observed('nanogpt', usage, this.deps.ctx.now());
  }

  assertProviderCooldown(provider: AgentProvider): void {
    const hold = this.providerHolds.check(provider, this.deps.ctx.now());
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
      alerted = usageAlerts?.check(session.id) != null;
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
      // Small reset differences between concurrent failures update the durable hold without
      // creating another owner alert. A material extension starts a new alert.
      const previous = ctx.repos.inbox.latestProviderQuota('gemini');
      const heldUntil = this.providerHolds.check('gemini', now)!.until!.toISOString();
      const previousReset =
        typeof previous?.payload.until === 'string' ? Date.parse(previous.payload.until) : NaN;
      if (
        started ||
        !previous ||
        !Number.isFinite(previousReset) ||
        Date.parse(heldUntil) - previousReset >= 60_000
      )
        this.quotaAlert(session, 'gemini', event.message, null);
      else if (previous.payload.until !== heldUntil) {
        const updated = ctx.repos.inbox.updatePayload(
          previous.id,
          { ...previous.payload, until: heldUntil },
          now.toISOString(),
        );
        if (updated)
          ctx.bus.publish({ type: 'inbox_upserted', projectKey: updated.projectKey, item: updated });
      }
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
    const started = this.providerHolds.start(event.provider, ctx.now());
    if (started) {
      this.quotaUsage?.invalidate();
      this.quotaProbe = Promise.resolve()
        .then(() => this.quotaUsage?.get('nanogpt') ?? null)
        .catch(() => null);
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
    void background(() => this.finishQuotaFailure(session, event.message, started, stageId)).catch(
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
    stageId?: string,
  ): Promise<void> {
    const { ctx } = this.deps;
    const usage = await this.quotaProbe;
    if (started) {
      this.providerHolds.settle('nanogpt', usage, ctx.now());
      this.quotaProbe = null;
      this.quotaAlert(session, 'nanogpt', message, usage);
    }
    if (session.workItem.type === 'task' && stageId) await this.quotaResume?.(session, stageId, 'quota');
  }

  private quotaAlert(
    session: Session,
    provider: AgentProvider,
    message: string,
    usage: PlanUsage | null,
  ): void {
    const { ctx } = this.deps;
    const hold = this.providerHolds.check(provider, ctx.now());
    const config = this.deps.projects.cachedConfig(session.projectKey);
    const owners = config ? ownerHandles(config) : [];
    if (owners.length > 0)
      this.deps.inbox?.create({
        projectKey: session.projectKey,
        kind: 'alert',
        assignees: owners,
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
        options: [ALERT_SEEN_OPTION],
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
