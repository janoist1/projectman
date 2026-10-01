import {
  EGRESS_MAX_GRANT_HOURS,
  EGRESS_POLICY_VERSION,
  EgressDestination,
  egressResource,
  egressTarget,
  isOnLeave,
  memberOf,
  sameDestination,
} from '@projectman/shared';
import type {
  BoundaryTarget,
  EgressAllowance,
  EgressDenial,
  EgressOperation,
  ProjectConfig,
} from '@projectman/shared';
import type { BoundaryRequester } from '../contracts';
import type { BoundaryService } from './boundary';
import type { DomainContext } from './context';
import { conflict, forbidden, notFound } from './errors';
import type { ProjectService } from './projects';
import type { TimelineService } from './timeline';
import { newId } from './util';

/** The session a proxied connection belongs to (from its proxy credentials). */
export interface EgressSession {
  sessionId: string;
  projectKey: string;
  member: string;
  taskKey: string | null;
}

/** Who opened a proxied connection: the worker account (kernel truth) and its session, if any. */
export interface EgressIdentity {
  /** The member whose worker account owns the connecting socket. */
  member: string;
  session: EgressSession | null;
}

export type EgressDecision =
  | { allowed: true; via: 'base' | 'allowance'; allowanceId?: string }
  | { allowed: false; denial: EgressDenial; operationId: string | null };

export interface EgressSettings {
  /** Destinations every worker may reach (the subscription CLIs, npm, GitHub). */
  base: EgressDestination[];
  /** How long an egress request may wait and its allowance lasts (1..24, default 8). */
  grantHours?: number;
}

/** Operations a session may register: a bound on the rows a misbehaving program can cause. */
const MAX_OPERATIONS_PER_SESSION = 200;

/**
 * The network gate's decisions (PM-140). The protected egress proxy asks `authorize` for each
 * connection; this service never opens a socket. A refused destination becomes an *operation*
 * (once per session and destination, never a request): the session may ask for it with
 * `submit_boundary_request`, and a lead or an owner decides it as any other boundary request.
 * The proxy consumes an allowed grant on the first matching connection, which turns it into an
 * allowance for that member, project, host and port until the operation's expiry; an owner can
 * revoke an allowance. Base destinations need no session and open nothing else.
 */
export class EgressService {
  private readonly ctx: DomainContext;
  private readonly projects: ProjectService;
  private readonly timeline: TimelineService;
  private readonly base: EgressDestination[];
  private readonly grantMs: number;
  private boundary: BoundaryService | null = null;

  constructor(deps: {
    ctx: DomainContext;
    projects: ProjectService;
    timeline: TimelineService;
    settings?: EgressSettings;
  }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.timeline = deps.timeline;
    this.base = (deps.settings?.base ?? []).map((d) => EgressDestination.parse(d));
    const hours = deps.settings?.grantHours ?? 8;
    if (!Number.isInteger(hours) || hours < 1 || hours > EGRESS_MAX_GRANT_HOURS)
      throw new Error(`egress grant hours must be 1..${EGRESS_MAX_GRANT_HOURS}`);
    // A little under the boundary service's 24 h limit, so a request made now is still valid.
    this.grantMs = Math.min(hours * 3_600_000, EGRESS_MAX_GRANT_HOURS * 3_600_000 - 60_000);
  }

  /** The boundary service consumes grants; it is built after this service (it uses `resolve`). */
  attach(boundary: BoundaryService): void {
    this.boundary = boundary;
  }

  /**
   * The protected registry lookup of the boundary adapter: an egress operation, bound to exactly
   * the session that was refused, as a development read of one destination.
   */
  resolve(requester: BoundaryRequester, operationId: string): BoundaryTarget | null {
    if (!operationId.startsWith('egr_')) return null;
    const operation = this.ctx.repos.egress.operation(operationId);
    if (
      !operation ||
      operation.projectKey !== requester.projectKey ||
      operation.member !== requester.member ||
      operation.sessionId !== requester.sessionId ||
      operation.taskKey !== requester.taskKey
    )
      return null;
    return egressTarget(operation);
  }

  /** Decides one connection. Never throws for a refusal; a failure is a refusal too. */
  async authorize(identity: EgressIdentity, destination: EgressDestination): Promise<EgressDecision> {
    if (this.base.some((d) => sameDestination(d, destination))) return { allowed: true, via: 'base' };
    const session = identity.session;
    if (!session) return { allowed: false, denial: 'no_session', operationId: null };
    if (session.member !== identity.member)
      return { allowed: false, denial: 'identity_mismatch', operationId: null };
    const config = await this.projects.config(session.projectKey).catch(() => null);
    if (!config || !this.memberActive(config, session.member))
      return { allowed: false, denial: 'member_inactive', operationId: null };
    const now = this.ctx.now();
    const at = now.toISOString();
    const allowance = this.ctx.repos.egress.activeAllowance(
      session.projectKey,
      session.member,
      destination,
      at,
    );
    if (allowance) return { allowed: true, via: 'allowance', allowanceId: allowance.id };
    const consumed = await this.consumeGrant(session, destination, at);
    if (consumed) return { allowed: true, via: 'allowance', allowanceId: consumed.id };
    return this.refuse(session, destination, now);
  }

  /** The session's refused destinations that can still be asked for, newest first (team tool). */
  recentDenials(session: EgressSession, limit = 20): EgressOperation[] {
    return this.ctx.repos.egress.recentForSession(
      session.sessionId,
      this.ctx.now().toISOString(),
      Math.max(1, Math.min(limit, 50)),
    );
  }

  /** Open allowances of a project (owners). */
  async listAllowances(projectKey: string, handle: string): Promise<EgressAllowance[]> {
    this.requireOwner(await this.projects.config(projectKey), handle);
    return this.ctx.repos.egress.listAllowances(projectKey, this.ctx.now().toISOString());
  }

  /** Closes an allowance before it expires (owners); the proxy refuses the next connection. */
  async revokeAllowance(projectKey: string, id: string, handle: string): Promise<EgressAllowance> {
    this.requireOwner(await this.projects.config(projectKey), handle);
    const current = this.ctx.repos.egress.allowance(id);
    if (!current || current.projectKey !== projectKey) throw notFound('egress allowance', id);
    const closed = this.ctx.unitOfWork(() => {
      const at = this.ctx.now().toISOString();
      const revoked = this.ctx.repos.egress.revokeAllowance(id, at, handle);
      if (!revoked) throw conflict('inbox_item_closed', 'the allowance is already closed');
      const request = this.ctx.repos.boundary.get(revoked.requestId);
      this.timeline.append({
        projectKey,
        taskKey: request?.taskKey ?? null,
        sessionId: request?.sessionId ?? null,
        actor: { kind: 'human', handle },
        type: 'boundary_changed',
        data: {
          requestId: revoked.requestId,
          operation: 'read_external',
          resource: egressResource(revoked),
          category: 'delegable',
          state: 'revoked',
          reason: 'owner_revoked',
          assignees: [],
          policyVersion: request?.policyVersion ?? EGRESS_POLICY_VERSION,
        },
      });
      return revoked;
    });
    // The proxy ends the tunnels the allowance opened (after the commit, so nothing reopens them).
    void this.ctx.events.emit('egress_allowance_revoked', closed);
    return closed;
  }

  private memberActive(config: ProjectConfig, handle: string): boolean {
    const member = memberOf(config, handle);
    return member?.kind === 'ai' && !isOnLeave(member) && config.team.limits.aiEnabled;
  }

  private requireOwner(config: ProjectConfig, handle: string): void {
    const member = memberOf(config, handle);
    if (member?.kind !== 'human' || member.access !== 'owner')
      throw forbidden('owner_only', 'only an owner may manage network allowances');
  }

  /**
   * An allowed, unused grant of the member for this destination in this project, consumed through
   * the boundary service (which checks it again) and recorded as an allowance in one step.
   */
  private async consumeGrant(
    session: EgressSession,
    destination: EgressDestination,
    at: string,
  ): Promise<EgressAllowance | null> {
    if (!this.boundary) return null;
    const operations = this.ctx.repos.egress.memberOperations(
      session.projectKey,
      session.member,
      destination,
      at,
    );
    for (const operation of operations) {
      for (const request of this.ctx.repos.boundary.byOperation(session.projectKey, operation.id)) {
        if (request.state !== 'allowed' || request.consumedAt) continue;
        const allowance: EgressAllowance = {
          id: newId('egw'),
          projectKey: operation.projectKey,
          member: operation.member,
          host: operation.host,
          port: operation.port,
          requestId: request.id,
          operationId: operation.id,
          grantedAt: at,
          expiresAt: operation.expiresAt,
          revokedAt: null,
          revokedBy: null,
        };
        try {
          // The grant belongs to the session that asked; the allowance to the member and project.
          await this.boundary.consume(
            {
              projectKey: request.projectKey,
              member: request.member,
              sessionId: request.sessionId,
              taskKey: request.taskKey,
            },
            request.id,
            operation.id,
            () => this.ctx.repos.egress.insertAllowance(allowance),
          );
        } catch (err) {
          this.ctx.logger.info({ requestId: request.id, err }, 'egress grant not consumed');
          continue;
        }
        this.ctx.logger.info(
          {
            projectKey: allowance.projectKey,
            member: allowance.member,
            host: allowance.host,
            port: allowance.port,
            requestId: request.id,
          },
          'egress allowance opened',
        );
        return allowance;
      }
    }
    return null;
  }

  /** The refusal, with the operation the session can ask for (registered once per destination). */
  private refuse(session: EgressSession, destination: EgressDestination, now: Date): EgressDecision {
    const at = now.toISOString();
    const existing = this.ctx.repos.egress.sessionOperation(session.sessionId, destination, at);
    if (existing) return { allowed: false, denial: 'not_allowed', operationId: existing.id };
    const stored = this.ctx.repos.sessions.get(session.sessionId);
    if (!stored || stored.projectKey !== session.projectKey || stored.member !== session.member)
      return { allowed: false, denial: 'no_session', operationId: null };
    if (this.ctx.repos.egress.countForSession(session.sessionId) >= MAX_OPERATIONS_PER_SESSION)
      return { allowed: false, denial: 'too_many_requests', operationId: null };
    const operation: EgressOperation = {
      id: newId('egr'),
      projectKey: session.projectKey,
      member: session.member,
      sessionId: session.sessionId,
      taskKey: session.taskKey,
      host: destination.host,
      port: destination.port,
      createdAt: at,
      expiresAt: new Date(now.getTime() + this.grantMs).toISOString(),
    };
    this.ctx.repos.egress.insertOperation(operation);
    this.ctx.logger.info(
      {
        projectKey: session.projectKey,
        member: session.member,
        host: destination.host,
        port: destination.port,
      },
      'egress destination refused',
    );
    return { allowed: false, denial: 'not_allowed', operationId: operation.id };
  }
}
