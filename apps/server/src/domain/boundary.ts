import { createHash } from 'node:crypto';
import {
  BoundaryTarget,
  SubmitBoundaryRequest,
  DecideBoundaryRequest,
  boundaryCategory,
  boundaryLeads,
  boundaryOwners,
  boundaryWaitingState,
  canDecideBoundary,
  canReadBoundary,
  isOnLeave,
  memberOf,
} from '@projectman/shared';
import type {
  Actor,
  BoundaryAuditReason,
  BoundaryRequest,
  BoundaryGrant,
  ProjectConfig,
} from '@projectman/shared';
import type { BoundaryOperationAdapter, BoundaryRequester } from '../contracts';
import type { DomainContext } from './context';
import { conflict, forbidden, invalid, notFound } from './errors';
import type { InboxService } from './inbox';
import type { ProjectService, LoadedProject } from './projects';
import type { TimelineService } from './timeline';
import { newId, SYSTEM_ACTOR } from './util';

const pending = (r: BoundaryRequest) => r.state === 'pending_lead' || r.state === 'pending_owner';
const active = (r: BoundaryRequest) => pending(r) || (r.state === 'allowed' && !r.consumedAt);
const requesterOf = (r: BoundaryRequest): BoundaryRequester => ({
  projectKey: r.projectKey,
  member: r.member,
  sessionId: r.sessionId,
  taskKey: r.taskKey,
});

/** Durable asynchronous requests. No permission-hook waiter and no runner permission changes. */
export class BoundaryService {
  private readonly ctx: DomainContext;
  private readonly projects: ProjectService;
  private readonly inbox: InboxService;
  private readonly timeline: TimelineService;
  private readonly adapter: BoundaryOperationAdapter;
  private readonly notify: (request: BoundaryRequest, recipients: string[]) => void;

  constructor(deps: {
    ctx: DomainContext;
    projects: ProjectService;
    inbox: InboxService;
    timeline: TimelineService;
    adapter?: BoundaryOperationAdapter;
    notify: (request: BoundaryRequest, recipients: string[]) => void;
  }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.inbox = deps.inbox;
    this.timeline = deps.timeline;
    this.adapter = deps.adapter ?? { resolve: () => null };
    this.notify = deps.notify;
  }

  private get(projectKey: string, id: string): BoundaryRequest {
    const request = this.ctx.repos.boundary.get(id);
    if (!request || request.projectKey !== projectKey) throw notFound('boundary request', id);
    return request;
  }

  private consumed(id: string): boolean {
    const grant = this.ctx.repos.boundary.grant(id);
    return grant?.state === 'consumed' || !!grant?.consumedAt;
  }

  /** Bind the caller to the server's session and task records, never to MCP/HTTP text. */
  private validRequester(config: ProjectConfig, requester: BoundaryRequester): boolean {
    const member = memberOf(config, requester.member);
    const session = this.ctx.repos.sessions.get(requester.sessionId);
    if (
      member?.kind !== 'ai' ||
      isOnLeave(member) ||
      !session ||
      session.projectKey !== requester.projectKey ||
      session.member !== requester.member ||
      (session.workItem.type === 'task' ? session.workItem.taskKey : null) !== requester.taskKey
    )
      return false;
    if (!requester.taskKey) return true;
    const task = this.ctx.repos.tasks.get(requester.taskKey);
    return (
      !!task &&
      task.projectKey === requester.projectKey &&
      task.status !== 'done' &&
      task.status !== 'cancelled'
    );
  }

  private target(requester: BoundaryRequester, operationId: string): BoundaryTarget | null {
    // Invalid adapter metadata fails closed without recording it or its parse error (which may
    // contain sensitive input). Adapters must expose only public resource identifiers.
    try {
      const parsed = BoundaryTarget.safeParse(this.adapter.resolve(requester, operationId));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private policy(project: LoadedProject, target: BoundaryTarget): string {
    // The configuration revision prevents remove/re-add and policy ABA from reviving a grant.
    return createHash('sha256')
      .update(JSON.stringify({ version: project.version, target }))
      .digest('hex');
  }

  private current(projectKey: string, project: LoadedProject): void {
    if (this.ctx.repos.projects.get(projectKey)?.configVersion !== project.version)
      throw conflict('config_conflict', 'configuration changed; retry the boundary operation');
  }

  async submit(requester: BoundaryRequester, input: SubmitBoundaryRequest): Promise<BoundaryRequest> {
    const args = SubmitBoundaryRequest.parse(input);
    const project = await this.projects.load(requester.projectKey);
    this.current(requester.projectKey, project);
    if (!this.validRequester(project.config, requester))
      throw forbidden('not_a_member', 'invalid boundary requester');
    // A retry key is caller input: persist only its digest, never arbitrary credential-like text.
    const deduplicationKey = createHash('sha256').update(args.deduplicationKey).digest('hex');
    const duplicate = this.ctx.repos.boundary.duplicate(
      requester.projectKey,
      requester.sessionId,
      deduplicationKey,
    );
    if (duplicate) {
      if (duplicate.member !== requester.member || duplicate.operationId !== args.operationId)
        throw conflict('invalid_request', 'deduplication key already belongs to another operation');
      return this.refresh(duplicate, project);
    }
    const target = this.target(requester, args.operationId);
    const now = this.ctx.now();
    if (
      !target ||
      Date.parse(target.expiresAt) <= now.getTime() ||
      Date.parse(target.expiresAt) > now.getTime() + 86_400_000
    )
      throw invalid('invalid_request', 'unknown, invalid or expired boundary operation');
    const category = boundaryCategory(target);
    const leads =
      category === 'delegable' && project.config.team.boundary?.enabled
        ? boundaryLeads(project.config, requester.member)
        : [];
    const request: BoundaryRequest = {
      ...requester,
      id: newId('bnd'),
      operationId: args.operationId,
      deduplicationKey,
      target,
      category,
      policyVersion: this.policy(project, target),
      state: leads.length ? 'pending_lead' : 'pending_owner',
      assignees: leads.length ? leads : boundaryOwners(project.config),
      leadDeadline: new Date(
        now.getTime() + (project.config.team.boundary?.leadTimeoutSeconds ?? 120) * 1000,
      ).toISOString(),
      expiresAt: target.expiresAt,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      decidedBy: null,
      reason: null,
    };
    this.ctx.unitOfWork(() => {
      this.ctx.repos.boundary.insert(request);
      this.inbox.create({
        id: request.id,
        projectKey: request.projectKey,
        kind: 'boundary',
        assignees: [...new Set([...request.assignees, ...boundaryOwners(project.config)])],
        source: request.member,
        sessionId: request.sessionId,
        taskKey: request.taskKey,
        title: target.resource,
        payload: { boundary: request },
        options: [
          { id: 'allow', label: 'allow', style: 'primary' },
          { id: 'deny', label: 'deny', style: 'danger' },
        ],
      });
      this.audit(request, { kind: 'ai', handle: requester.member });
    });
    this.notify(request, request.assignees);
    return request;
  }

  async read(
    projectKey: string,
    id: string,
    handle: string,
  ): Promise<{ request: BoundaryRequest; grant: BoundaryGrant | null }> {
    const project = await this.projects.load(projectKey);
    this.current(projectKey, project);
    const request = this.get(projectKey, id);
    if (!canReadBoundary(project.config, request, handle))
      throw forbidden('not_an_assignee', 'boundary request is private');
    const refreshed = this.refresh(request, project);
    return { request: refreshed, grant: this.ctx.repos.boundary.grant(id) };
  }

  async decide(
    projectKey: string,
    id: string,
    handle: string,
    input: DecideBoundaryRequest,
    opts: { delegatedOnly?: boolean } = {},
  ): Promise<BoundaryRequest> {
    const args = DecideBoundaryRequest.parse(input);
    const project = await this.projects.load(projectKey);
    this.current(projectKey, project);
    const request = this.refresh(this.get(projectKey, id), project);
    if (!pending(request)) throw conflict('inbox_item_closed', 'boundary request is closed');
    if (opts.delegatedOnly && (request.category !== 'delegable' || request.state !== 'pending_lead'))
      throw forbidden('owner_only', 'this boundary request requires an owner');
    if (!canDecideBoundary(project.config, request, handle))
      throw forbidden('not_an_assignee', 'not an independent live boundary approver');
    const member = memberOf(project.config, handle)!;
    const actor: Actor = { kind: member.kind, handle };
    const decided = this.transition(
      request,
      args.decision === 'allow' ? 'allowed' : 'denied',
      args.reason,
      actor,
      project.config,
    );
    return decided;
  }

  async revoke(projectKey: string, id: string, handle: string): Promise<BoundaryRequest> {
    const project = await this.projects.load(projectKey);
    this.current(projectKey, project);
    const member = memberOf(project.config, handle);
    if (member?.kind !== 'human' || member.access !== 'owner')
      throw forbidden('owner_only', 'only an owner may revoke boundary requests');
    const request = this.get(projectKey, id);
    if (!active(request) || this.consumed(id))
      throw conflict('inbox_item_closed', 'boundary request is closed');
    return this.transition(request, 'revoked', 'owner_revoked', { kind: 'human', handle }, project.config);
  }

  /**
   * A session changed execution profile (PM-141): what it asked or was granted under the old one does
   * not carry over. Every request of the session that is still waiting or granted and not yet consumed
   * is revoked (a consumed one is final, as everywhere). Returns how many were revoked.
   */
  async invalidateSession(projectKey: string, sessionId: string): Promise<number> {
    const project = await this.projects.load(projectKey);
    let revoked = 0;
    for (const stored of this.ctx.repos.boundary.listActive()) {
      if (stored.projectKey !== projectKey) continue;
      const request = this.get(projectKey, stored.id);
      if (request.sessionId !== sessionId || !active(request) || this.consumed(request.id)) continue;
      this.transition(request, 'revoked', 'policy_changed', SYSTEM_ACTOR, project.config);
      revoked += 1;
    }
    return revoked;
  }

  /** The protected executor consumes one exact grant before execution. This only returns
   * authorization metadata; it never performs a command or changes CLI permissions. */
  async consume(requester: BoundaryRequester, id: string, operationId: string): Promise<BoundaryGrant> {
    const project = await this.projects.load(requester.projectKey);
    this.current(requester.projectKey, project);
    const request = this.refresh(this.get(requester.projectKey, id), project);
    const grant = this.ctx.repos.boundary.grant(id);
    if (
      request.member !== requester.member ||
      request.sessionId !== requester.sessionId ||
      request.taskKey !== requester.taskKey ||
      request.operationId !== operationId ||
      request.state !== 'allowed' ||
      !grant ||
      grant.state !== 'active' ||
      grant.revokedAt ||
      grant.consumedAt
    )
      throw forbidden('insufficient_access', 'no valid single-operation boundary grant');
    return this.ctx.unitOfWork(() => {
      const at = this.ctx.now().toISOString();
      const consumed = this.ctx.repos.boundary.consume(id, at);
      if (!consumed) throw forbidden('insufficient_access', 'boundary grant was already consumed or revoked');
      const next = { ...request, consumedAt: at, updatedAt: at };
      this.ctx.repos.boundary.update(next);
      const item = this.ctx.repos.inbox.get(id)!;
      this.ctx.repos.inbox.updateBoundary(id, { boundary: next }, item.assignees, at);
      this.ctx.bus.publish({
        type: 'inbox_upserted',
        projectKey: request.projectKey,
        item: this.ctx.repos.inbox.get(id)!,
      });
      return consumed;
    });
  }

  /** Absolute timestamps survive restart. Missing/on-leave approvers escalate; busy wake-ups
   * wait at most the lead deadline. No failed wake-up or timeout ever means allow. */
  async sweep(): Promise<void> {
    for (const stored of this.ctx.repos.boundary.listActive()) {
      try {
        const project = await this.projects.load(stored.projectKey);
        this.current(stored.projectKey, project);
        this.refresh(this.get(stored.projectKey, stored.id), project);
      } catch {
        // The next sweep retries this request. Never log config/adapter input or grant permission
        // on failure, and never let one unavailable project block startup or another deadline.
        this.ctx.logger.warn(
          { projectKey: stored.projectKey, requestId: stored.id },
          'boundary request refresh failed',
        );
      }
    }
  }

  private refresh(request: BoundaryRequest, project: LoadedProject): BoundaryRequest {
    if (!active(request) || this.consumed(request.id)) return request;
    const now = this.ctx.now().getTime();
    if (boundaryWaitingState(project.config, request, now) === 'expired')
      return this.transition(request, 'expired', 'deadline_expired', SYSTEM_ACTOR, project.config);
    const target = this.target(requesterOf(request), request.operationId);
    if (
      !this.validRequester(project.config, requesterOf(request)) ||
      !target ||
      JSON.stringify(target) !== JSON.stringify(request.target)
    )
      return this.transition(request, 'revoked', 'policy_changed', SYSTEM_ACTOR, project.config);
    if (this.policy(project, target) !== request.policyVersion) {
      if (request.state === 'allowed')
        return this.transition(request, 'revoked', 'policy_changed', SYSTEM_ACTOR, project.config);
      const escalated = this.transition(
        { ...request, policyVersion: this.policy(project, target) },
        'pending_owner',
        'policy_changed',
        SYSTEM_ACTOR,
        project.config,
      );
      this.notify(escalated, escalated.assignees);
      return escalated;
    }
    if (
      request.state === 'pending_lead' &&
      boundaryWaitingState(project.config, request, now) === 'pending_owner'
    ) {
      const escalated = this.transition(
        request,
        'pending_owner',
        'lead_unavailable',
        SYSTEM_ACTOR,
        project.config,
      );
      this.notify(escalated, escalated.assignees);
      return escalated;
    }
    return request;
  }

  private transition(
    request: BoundaryRequest,
    state: BoundaryRequest['state'],
    reason: BoundaryAuditReason,
    actor: Actor,
    config: ProjectConfig,
  ): BoundaryRequest {
    const at = this.ctx.now().toISOString();
    const next: BoundaryRequest = {
      ...request,
      state,
      reason: request.decidedBy ? request.reason : reason,
      updatedAt: at,
      assignees: state === 'pending_owner' ? boundaryOwners(config) : request.assignees,
      decidedBy: state === 'allowed' || state === 'denied' ? actor : request.decidedBy,
      ...(state === 'revoked' || state === 'expired' ? { invalidation: { actor, reason, at } } : {}),
    };
    const result = this.ctx.unitOfWork(() => {
      this.ctx.repos.boundary.update(next);
      if (state === 'allowed')
        this.ctx.repos.boundary.insertGrant({
          state: 'active',
          id: newId('grt'),
          requestId: request.id,
          ...requesterOf(request),
          operationId: request.operationId,
          target: request.target,
          policyVersion: request.policyVersion,
          decidedBy: actor,
          reason: DecideBoundaryRequest.shape.reason.parse(reason),
          createdAt: at,
          expiresAt: request.expiresAt,
          revokedAt: null,
          consumedAt: null,
        });
      const grant = this.ctx.repos.boundary.grant(request.id);
      if (grant?.state === 'active' && (state === 'revoked' || state === 'expired'))
        this.ctx.repos.boundary.updateGrant({ ...grant, state, revokedAt: at });
      const item = this.ctx.repos.inbox.get(request.id)!;
      this.ctx.repos.inbox.updateBoundary(
        item.id,
        { boundary: next },
        [...new Set([...next.assignees, ...boundaryOwners(config)])],
        at,
      );
      if (state === 'pending_owner') {
        this.ctx.repos.inbox.updateAssignees(item.id, next.assignees, at);
      } else if (item.state === 'open') {
        this.ctx.repos.inbox.close(
          item.id,
          state === 'revoked' ? 'cancelled' : state === 'expired' ? 'expired' : 'resolved',
          {
            optionId: state === 'allowed' ? 'allow' : 'deny',
            by: actor.handle ?? 'system',
            at,
            note: reason,
          },
          at,
        );
      }
      this.ctx.bus.publish({
        type: 'inbox_upserted',
        projectKey: request.projectKey,
        item: this.ctx.repos.inbox.get(request.id)!,
      });
      this.audit(next, actor, reason);
      return next;
    });
    if (state !== 'pending_owner') this.notify(result, [request.member]);
    return result;
  }

  private audit(request: BoundaryRequest, actor: Actor, reason = request.reason): void {
    this.timeline.append({
      projectKey: request.projectKey,
      taskKey: request.taskKey,
      sessionId: request.sessionId,
      actor,
      type: 'boundary_changed',
      data: {
        requestId: request.id,
        operation: request.target.operation,
        resource: request.target.resource,
        category: request.category,
        state: request.state,
        reason,
        assignees: request.assignees,
        policyVersion: request.policyVersion,
      },
    });
  }
}
