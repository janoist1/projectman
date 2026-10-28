import {
  coordinationMemberOf,
  isProjectManager,
  hasAccess,
  memberOf,
  operatorKnowledgeApprovalOf,
  OperatorKnowledgeDocument,
  ownerHandles,
  OPERATOR_DISMISS_OPTION,
  ProposeOperatorKnowledgeRequest,
} from '@projectman/shared';
import type {
  ConfigChangeRow,
  InboxItem,
  OperatorKnowledgeApprovalPayload,
  SessionStartCause,
  WorkItemRef,
} from '@projectman/shared';
import type { ContextPackInput, OperatorKnowledgeStore, ToolContext } from '../../contracts';
import { isoNow, type DomainContext } from '../../core/base';
import { DECISION_OPTIONS, type InboxService, type Resolver } from '../../core/inbox';
import type { ProjectService } from '../../core/projects';
import type { TimelineService } from '../../core/timeline';
import { conflict, forbidden, humanActor, invalid, newId } from '../../kernel';
import type { OperatorActions } from './actions';
import type { OperatorRequests, OperatorSteps } from './requests';

/** Owner-approved shared knowledge. File writes and configuration commits share one project lock. */
export class OperatorKnowledge {
  private readonly deps: {
    ctx: DomainContext;
    projects: ProjectService;
    store: OperatorKnowledgeStore;
    requests: OperatorRequests;
    steps: OperatorSteps;
    inbox: InboxService;
    timeline: TimelineService;
    preview: OperatorActions['preview'];
    approved: (item: InboxItem, payload: OperatorKnowledgeApprovalPayload) => void;
  };
  constructor(deps: OperatorKnowledge['deps']) {
    this.deps = deps;
  }

  read(projectKey: string): Promise<OperatorKnowledgeDocument> {
    return this.deps.store.readKnowledge(projectKey);
  }

  /** MCP reads require an actual internal general session of the Operator or project manager. */
  async get(ctx: ToolContext): Promise<OperatorKnowledgeDocument> {
    const config = await this.deps.projects.config(ctx.projectKey);
    const member = memberOf(config, ctx.member);
    if (!isProjectManager(member))
      throw forbidden('operator_only', 'only the project manager may read shared knowledge');
    this.session(ctx);
    const request = this.deps.requests.openFor(ctx.sessionId);
    if (request && !ownerHandles(config).includes(request.fromHandle))
      throw forbidden('operator_owner_only', 'a guest request cannot read shared knowledge');
    return this.read(ctx.projectKey);
  }

  async forConversation(
    projectKey: string,
    handle: string,
    workItem: WorkItemRef,
    cause: SessionStartCause | null,
  ): Promise<ContextPackInput['operatorKnowledge']> {
    if (workItem.type !== 'general' || workItem.with !== undefined) return undefined;
    const config = await this.deps.projects.config(projectKey);
    const member = memberOf(config, handle);
    if (!isProjectManager(member)) return undefined;
    const actor = cause?.by;
    const person = actor?.handle ? memberOf(config, actor.handle) : undefined;
    if (
      actor?.via ||
      (actor?.kind === 'human' && (person?.kind !== 'human' || !hasAccess(person.access, 'developer')))
    )
      return undefined;
    const { revision, agreement, principles } = await this.read(projectKey);
    return { revision, agreement, principles };
  }

  async propose(ctx: ToolContext, input: ProposeOperatorKnowledgeRequest) {
    const parsed = ProposeOperatorKnowledgeRequest.safeParse(input);
    if (!parsed.success) throw invalid('invalid_request', 'invalid knowledge proposal');
    const args = parsed.data;
    return this.deps.projects.withConfigurationLock(ctx.projectKey, async (loaded) => {
      if (coordinationMemberOf(loaded.config)?.handle !== ctx.member)
        throw forbidden('operator_only', 'only the project manager may propose shared knowledge');
      // The project manager cannot run operate, so its approval would have no continuation to carry them.
      if (args.operations.length)
        throw invalid('invalid_request', 'a project manager proposal carries no operations');
      this.session(ctx);
      const request = this.deps.requests.openFor(ctx.sessionId);
      if (
        !request ||
        request.projectKey !== ctx.projectKey ||
        !['message', 'answer'].includes(request.source) ||
        memberOf(loaded.config, request.fromHandle)?.kind !== 'human' ||
        !ownerHandles(loaded.config).includes(request.fromHandle)
      )
        throw forbidden('operator_no_request', 'a knowledge proposal needs an open owner message or answer');
      await this.recoverLocked(ctx.projectKey);
      const knowledge = await this.read(ctx.projectKey);
      if (knowledge.revision !== args.expected_revision)
        throw conflict('operator_knowledge_stale', 'shared knowledge changed');
      const change = structuredClone(args.change);
      if (change.kind === 'principle_put' && change.principle.id === null) change.principle.id = newId('olp');
      const changes: ConfigChangeRow[] = [];
      const operations = [];
      for (const operation of args.operations) {
        const preview = await this.deps.preview(ctx.projectKey, ctx.member, request, operation);
        if (preview.level === 'never')
          throw forbidden('operator_never', 'a forbidden operation cannot be proposed');
        changes.push(...preview.changes);
        operations.push(preview.operation);
      }
      const payload: OperatorKnowledgeApprovalPayload = {
        id: newId('okp'),
        requestId: request.id,
        stepId: newId('ops'),
        baseRevision: knowledge.revision,
        change,
        operations,
        changes,
        baseConfigVersion: operations.length ? loaded.version : null,
        proposedBy: ctx.member,
        stale: null,
        applying: null,
      };
      // Validate limits and removals before asking a person. This computes a draft only.
      this.next(knowledge, payload, request.fromHandle, isoNow(this.deps.ctx));
      const item = this.deps.ctx.unitOfWork(() => {
        const created = this.deps.inbox.create({
          projectKey: ctx.projectKey,
          kind: 'approval',
          source: ctx.member,
          assignees: ownerHandles(loaded.config),
          title: args.title,
          taskKey: null,
          options: [...DECISION_OPTIONS, OPERATOR_DISMISS_OPTION],
          payload: { operatorKnowledge: payload },
        });
        this.deps.steps.record({
          id: payload.stepId,
          requestId: request.id,
          action: 'knowledge_change',
          status: 'awaiting_approval',
          changes,
          inboxItemId: created.id,
        });
        return created;
      });
      return {
        status: 'awaiting_approval' as const,
        inbox_item_id: item.id,
        step_id: payload.stepId,
        base_revision: knowledge.revision,
      };
    });
  }

  async apply(item: InboxItem, by: Resolver, option: string, note: string | null): Promise<void> {
    return this.deps.projects.withConfigurationLock(item.projectKey, async (loaded) => {
      const owner = memberOf(loaded.config, by.handle);
      if (by.via || owner?.kind !== 'human' || owner.access !== 'owner')
        throw forbidden('operator_owner_only', 'only an owner using their own login may decide');
      await this.recoverLocked(item.projectKey);
      const current = this.deps.ctx.repos.inbox.get(item.id);
      const payload = current && operatorKnowledgeApprovalOf(current);
      if (!current || !payload) throw invalid('invalid_request', 'unknown knowledge proposal');
      if (current.state !== 'open') return;
      if (option === 'dismiss' || option === 'reject') {
        this.deps.ctx.unitOfWork(() => {
          this.deps.ctx.repos.operatorRequests.updateStep(payload.stepId, 'rejected');
          this.close(current, by.handle, option, isoNow(this.deps.ctx), note);
        });
        return;
      }
      if (option !== 'approve') throw invalid('invalid_request', 'unknown knowledge decision');
      const knowledge = await this.read(item.projectKey);
      const reason =
        payload.stale?.reason ??
        (knowledge.revision !== payload.baseRevision
          ? 'knowledge_changed'
          : payload.baseConfigVersion !== null && payload.baseConfigVersion !== loaded.version
            ? 'config_changed'
            : null);
      if (reason) {
        this.stale(current, payload, reason);
        throw conflict('operator_knowledge_stale', 'the knowledge proposal is stale; dismiss it');
      }
      // This identity is durable BEFORE any file write. Only this human resolver path sets it.
      payload.applying = { by: by.handle, at: isoNow(this.deps.ctx) };
      this.update(current, payload);
      const next = this.next(knowledge, payload, by.handle, payload.applying.at);
      const written = await this.deps.store.compareAndSwapKnowledge(
        item.projectKey,
        knowledge.revision,
        next,
      );
      this.finish(current, payload, written, note);
      await this.recheckLocked(item.projectKey, loaded.version);
    });
  }

  async recover(): Promise<void> {
    for (const project of this.deps.projects.summaries()) {
      try {
        await this.recheck(project.key);
      } catch (err) {
        this.deps.ctx.logger.warn({ err, projectKey: project.key }, 'could not recover operator knowledge');
      }
    }
  }

  async recheck(projectKey: string): Promise<void> {
    if (!this.pending(projectKey).length) return;
    await this.deps.projects.withConfigurationLock(projectKey, async (loaded) => {
      await this.recoverLocked(projectKey);
      await this.recheckLocked(projectKey, loaded.version);
    });
  }

  private session(ctx: ToolContext): void {
    const session = this.deps.ctx.repos.sessions.get(ctx.sessionId);
    if (
      !session ||
      session.projectKey !== ctx.projectKey ||
      session.member !== ctx.member ||
      session.workItem.type !== 'general' ||
      session.workItem.with !== undefined
    )
      throw forbidden(
        'operator_owner_only',
        'shared knowledge requires the current internal general session',
      );
    const actor = session.startCause?.by;
    const config = this.deps.projects.cachedConfig(ctx.projectKey)!;
    const person = actor?.handle ? memberOf(config, actor.handle) : undefined;
    if (
      actor?.via ||
      (actor?.kind === 'human' && (person?.kind !== 'human' || !hasAccess(person.access, 'developer')))
    )
      throw forbidden('operator_owner_only', 'shared knowledge is unavailable to a customer conversation');
  }

  private next(
    previous: OperatorKnowledgeDocument,
    payload: OperatorKnowledgeApprovalPayload,
    by: string,
    at: string,
  ) {
    const next = structuredClone(previous);
    const change = payload.change;
    if (change.kind === 'agreement_replace')
      next.agreement = {
        version: (previous.agreement?.version ?? 0) + 1,
        data: change.agreement,
        approvedBy: by,
        approvedAt: at,
      };
    else if (change.kind === 'principle_put') {
      if (change.principle.id === null) throw invalid('invalid_request', 'a principle needs a server id');
      const principle = { ...change.principle, id: change.principle.id, approvedBy: by, approvedAt: at };
      const index = next.principles.findIndex((entry) => entry.id === principle.id);
      if (index < 0) next.principles.push(principle);
      else next.principles[index] = principle;
    } else {
      if (!next.principles.some((entry) => entry.id === change.id))
        throw invalid('invalid_request', 'unknown principle');
      next.principles = next.principles.filter((entry) => entry.id !== change.id);
    }
    next.revision++;
    next.appliedProposalIds.push(payload.id);
    const parsed = OperatorKnowledgeDocument.safeParse(next);
    if (!parsed.success) throw invalid('invalid_request', 'knowledge document limit exceeded');
    return parsed.data;
  }

  private pending(projectKey: string) {
    return this.deps.ctx.repos.inbox
      .listOpen('approval')
      .filter((item) => item.projectKey === projectKey && operatorKnowledgeApprovalOf(item));
  }

  private async recoverLocked(projectKey: string): Promise<void> {
    const items = this.pending(projectKey);
    if (!items.length) return;
    const document = await this.read(projectKey);
    for (const item of items) {
      const payload = operatorKnowledgeApprovalOf(item)!;
      if (!payload.applying) continue;
      if (document.appliedProposalIds.includes(payload.id)) this.finish(item, payload, document, null);
      else {
        // No marker means no committed change. A new human click is required.
        payload.applying = null;
        this.update(item, payload);
      }
    }
  }

  private finish(
    item: InboxItem,
    payload: OperatorKnowledgeApprovalPayload,
    document: OperatorKnowledgeDocument,
    note: string | null,
  ): void {
    const applying = payload.applying!;
    this.deps.ctx.unitOfWork(() => {
      this.deps.ctx.repos.operatorRequests.updateStep(payload.stepId, 'approved');
      this.deps.timeline.append({
        projectKey: item.projectKey,
        actor: humanActor(applying.by),
        type: 'operator_knowledge_changed',
        data: {
          proposalId: payload.id,
          kind: payload.change.kind,
          revision: payload.baseRevision + 1,
          agreementVersion: payload.change.kind === 'agreement_replace' ? document.agreement!.version : null,
        },
      });
      const closed = this.close(item, applying.by, 'approve', applying.at, note);
      this.deps.approved(closed, payload);
    });
  }

  private close(item: InboxItem, by: string, optionId: string, at: string, note: string | null): InboxItem {
    const closed = this.deps.ctx.repos.inbox.close(item.id, 'resolved', { optionId, by, at, note }, at);
    if (!closed) throw conflict('inbox_item_closed', 'the knowledge proposal is already closed');
    this.deps.ctx.bus.publish({ type: 'inbox_upserted', projectKey: item.projectKey, item: closed });
    return closed;
  }

  private update(item: InboxItem, payload: OperatorKnowledgeApprovalPayload): void {
    const updated = this.deps.ctx.repos.inbox.updateOperator(
      item.id,
      { ...item.payload, operatorKnowledge: payload },
      item.options,
      isoNow(this.deps.ctx),
    );
    if (updated)
      this.deps.ctx.bus.publish({ type: 'inbox_upserted', projectKey: item.projectKey, item: updated });
  }

  private stale(
    item: InboxItem,
    payload: OperatorKnowledgeApprovalPayload,
    reason: 'knowledge_changed' | 'config_changed',
  ): void {
    this.deps.ctx.unitOfWork(() => {
      this.deps.inbox.staleOperator(item.id, {
        ...item.payload,
        operatorKnowledge: { ...payload, stale: { reason, at: isoNow(this.deps.ctx) } },
      });
      this.deps.ctx.repos.operatorRequests.updateStep(payload.stepId, 'stale');
    });
  }

  private async recheckLocked(projectKey: string, version: string): Promise<void> {
    const items = this.pending(projectKey);
    if (!items.length) return;
    const knowledge = await this.read(projectKey);
    for (const item of items) {
      const payload = operatorKnowledgeApprovalOf(item)!;
      if (payload.stale || payload.applying) continue;
      if (knowledge.revision !== payload.baseRevision) this.stale(item, payload, 'knowledge_changed');
      else if (payload.baseConfigVersion !== null && payload.baseConfigVersion !== version)
        this.stale(item, payload, 'config_changed');
    }
  }
}
