import {
  applyConfigPatch,
  canonical,
  isOperator,
  memberOf,
  operatorApprovalOf,
  operatorConfigVerdict,
  OperatorOperation,
  OPERATOR_DISMISS_OPTION,
  unknownPatchRepo,
} from '@projectman/shared';
import type {
  ConfigChangeRow,
  InboxItem,
  OperatorAction,
  OperatorApprovalPayload,
  OperatorConsequence,
  ProjectConfig,
} from '@projectman/shared';
import type { OperatorRequestRecord } from '../db';
import { ownerHandles } from './access';
import { isoNow } from './context';
import type { DomainContext } from './context';
import { conflict, DomainError, forbidden, invalid, notFound } from './errors';
import { DECISION_OPTIONS } from './inbox';
import type { InboxService, Resolver } from './inbox';
import type { MemberService } from './members';
import type { MessageService } from './messaging';
import type { OperatorSteps } from './operator-requests';
import type { PauseService } from './pause';
import type { Author, ProjectService } from './projects';
import type { SessionOrchestrator } from './sessions';
import { aiActor, newId, SYSTEM_ACTOR } from './util';

interface Dependencies {
  ctx: DomainContext;
  projects: ProjectService;
  members: MemberService;
  inbox: InboxService;
  steps: OperatorSteps;
  sessions: SessionOrchestrator;
  pauses: PauseService;
  messages: MessageService;
}

const actionOf = (operation: OperatorOperation): OperatorAction =>
  operation.op === 'config_patch'
    ? 'config_change'
    : operation.op === 'member_update'
      ? 'member_change'
      : operation.op;

function consequenceOf(operation: OperatorOperation, changes: ConfigChangeRow[]): OperatorConsequence {
  if (
    ['member_hire', 'member_retire', 'session_stop', 'project_pause', 'project_resume'].includes(operation.op)
  )
    return operation.op as OperatorConsequence;
  if (changes.some((r) => r.field === 'outboundNetwork')) return 'network';
  if (changes.some((r) => ['permissionMode', 'approver'].includes(r.field))) return 'permission_mode';
  if (changes.some((r) => r.area === 'label')) return 'labels';
  if (changes.some((r) => ['stage', 'gate'].includes(r.area))) return 'pipeline';
  if (changes.some((r) => r.area === 'repos' || r.field === 'workspacePath')) return 'locations';
  if (changes.some((r) => r.field.toLowerCase().includes('fix'))) return 'fix_limit';
  if (changes.some((r) => r.area === 'member')) return 'member_other';
  return changes.some((r) => r.area === 'project') ? 'project' : 'other';
}

/** Executes only within an owner's request; previews and commits use the same member mutations. */
export class OperatorActions {
  constructor(privateDeps: Dependencies) {
    this.deps = privateDeps;
  }
  private readonly deps: Dependencies;

  async run(projectKey: string, requestId: string, title: string, input: OperatorOperation) {
    const { ctx, projects, steps, inbox, sessions } = this.deps;
    const request = ctx.repos.operatorRequests.get(requestId);
    if (!request || request.projectKey !== projectKey)
      throw forbidden('operator_no_request', 'no owner request');
    const source = sessions.get(projectKey, request.sessionId).member;
    const config = await projects.config(projectKey);
    if (!isOperator(memberOf(config, source)))
      throw forbidden('operator_only', 'only the Operator may operate');
    const stepId = newId('ops');
    let changes: ConfigChangeRow[] = [];
    try {
      const operation = OperatorOperation.parse(input);
      if (!title.trim() || title.length > 120)
        throw invalid('invalid_request', 'title must have 1 to 120 characters');
      const preview = await this.preview(projectKey, source, request, operation);
      changes = preview.changes;
      if (preview.level === 'never')
        throw forbidden('operator_never', 'the Operator cannot make this change');
      if (preview.level === 'now') {
        const configVersion = await this.execute(projectKey, source, request, operation);
        const step = steps.record({
          requestId,
          action: actionOf(operation),
          status: 'done',
          changes,
          configVersion,
          member: 'handle' in operation ? operation.handle : null,
        });
        return { status: 'done' as const, step_id: step.id, changes, config_version: configVersion };
      }
      const payload: OperatorApprovalPayload = {
        requestId,
        stepId,
        quote: request.quote,
        action: actionOf(operation),
        operation: preview.operation,
        changes,
        consequence: consequenceOf(operation, changes),
        baseVersion: preview.baseVersion,
        session: preview.session,
        stale: null,
      };
      const item = inbox.create({
        projectKey,
        kind: 'approval',
        assignees: ownerHandles(config),
        source,
        title,
        taskKey: null,
        options: DECISION_OPTIONS,
        payload: { operator: payload },
      });
      steps.record({
        id: stepId,
        requestId,
        action: actionOf(operation),
        status: 'awaiting_approval',
        changes,
        inboxItemId: item.id,
        member: 'handle' in operation ? operation.handle : null,
      });
      // A commit or session end may have happened while the preview waited.
      await this.approvals?.recheck(projectKey).catch((err: unknown) => {
        ctx.logger.warn({ err, projectKey }, 'could not recheck the new Operator proposal');
      });
      return {
        status: 'awaiting_approval' as const,
        step_id: stepId,
        changes,
        config_version: preview.baseVersion,
        inbox_item_id: item.id,
      };
    } catch (err) {
      steps.record({
        requestId,
        action: actionOf(input),
        status: 'refused',
        changes,
        refusal:
          err instanceof DomainError
            ? { code: err.code, message: err.message }
            : { code: 'invalid_request', message: 'operation could not be completed' },
      });
      throw err;
    }
  }

  private approvals?: OperatorApprovals;
  useApprovals(approvals: OperatorApprovals): void {
    this.approvals = approvals;
  }

  async preview(
    projectKey: string,
    source: string,
    request: OperatorRequestRecord,
    operation: OperatorOperation,
  ) {
    const { projects, members, ctx, sessions } = this.deps;
    const loaded = await projects.load(projectKey);
    let next: ProjectConfig = structuredClone(loaded.config);
    if (
      (operation.op === 'member_update' || operation.op === 'member_retire') &&
      memberOf(next, operation.handle)?.kind === 'human'
    )
      throw forbidden('operator_never', 'the Operator cannot change human members');
    const session = operation.op === 'session_stop' ? sessions.get(projectKey, operation.sessionId) : null;
    if (session) {
      if (session.member === source)
        throw forbidden('operator_never', 'the Operator cannot stop its own session');
      return {
        level: 'approval' as const,
        changes: [] as ConfigChangeRow[],
        operation,
        baseVersion: null,
        session: { id: session.id, startedAt: session.startedAt },
      };
    }
    if (operation.op === 'project_pause' || operation.op === 'project_resume') {
      return {
        level: 'approval' as const,
        changes: this.pauseChanges(projectKey, operation.op),
        operation,
        baseVersion: null,
        session: null,
      };
    }
    switch (operation.op) {
      case 'config_patch': {
        const patch = { ...operation.patch, baseVersion: loaded.version };
        const unknown = unknownPatchRepo(next, patch);
        if (unknown) throw invalid('unknown_repo', `unknown repository: ${unknown}`);
        next = applyConfigPatch(next, patch);
        break;
      }
      case 'member_update':
        members.prepareUpdate(next, operation.handle, operation.changes);
        break;
      case 'member_hire': {
        const hired = members.prepareHire(projectKey, next, operation.request, request.fromHandle);
        operation = { ...operation, request: { ...operation.request, handle: hired.member.handle } };
        break;
      }
      case 'member_retire':
        members.prepareRetire(next, operation.handle);
        break;
      case 'config_revert':
        next = await projects.versionConfig(projectKey, operation.version);
        break;
    }
    if (!isOperator(memberOf(loaded.config, source)))
      throw forbidden('operator_only', 'only the Operator may operate');
    // Keep the provenance request bound to this project even for approval replay after its turn ended.
    if (request.projectKey !== projectKey || !ctx.repos.operatorRequests.get(request.id))
      throw notFound('request', request.id);
    return {
      ...operatorConfigVerdict(loaded.config, next, { operator: source }),
      operation,
      baseVersion: loaded.version,
      session: null,
    };
  }

  pauseChanges(projectKey: string, op: 'project_pause' | 'project_resume'): ConfigChangeRow[] {
    const pauses = this.deps.ctx.repos.pauses;
    return [
      {
        area: 'project',
        target: null,
        field: 'pause',
        before: canonical({
          project: pauses.findOpen('project', projectKey)?.id ?? null,
          instance: pauses.findOpen('instance', null)?.id ?? null,
        }),
        after: op,
        level: 'approval',
      },
    ];
  }

  async execute(
    projectKey: string,
    source: string,
    request: OperatorRequestRecord,
    operation: OperatorOperation,
    approval?: { item: InboxItem; by: Resolver },
  ): Promise<string | null> {
    const { projects, members, sessions, pauses, ctx } = this.deps;
    const member = memberOf(await projects.config(projectKey), source);
    if (!isOperator(member)) throw forbidden('operator_only', 'only the Operator may operate');
    const author: Author = {
      name: member!.displayName,
      email: `${source}@projectman.local`,
      operator: source,
      request: request.quote,
      operatorRequestId: request.id,
      ...(approval ? { approvedBy: approval.by.handle, operatorApprovalId: approval.item.id } : {}),
    };
    const by = { actor: aiActor(source), author };
    switch (operation.op) {
      case 'config_patch':
        return (
          await projects.patch(
            projectKey,
            { ...operation.patch, baseVersion: (await projects.load(projectKey)).version },
            by,
          )
        ).version;
      case 'config_revert':
        return (await projects.revert(projectKey, operation.version, by)).version;
      case 'member_update':
        await members.update(projectKey, operation.handle, operation.changes, by);
        break;
      case 'member_hire':
        await members.hire(projectKey, operation.request, { ...by, sponsor: request.fromHandle });
        break;
      case 'member_retire':
        await members.retire(projectKey, operation.handle, {}, by);
        break;
      case 'session_stop':
        if (!approval) throw forbidden('owner_approval_required', 'stopping needs approval');
        this.approvals!.assertRuntimeFresh(approval.item);
        await sessions.stop(projectKey, operation.sessionId, { kind: 'manual', by: aiActor(source) });
        return null;
      case 'project_pause':
      case 'project_resume': {
        if (!approval) throw forbidden('owner_approval_required', 'pausing needs approval');
        const approver = memberOf(await projects.config(projectKey), approval.by.handle);
        const user =
          approver?.kind === 'human' && approver.email ? ctx.repos.users.findByEmail(approver.email) : null;
        const requester = {
          userId: user?.id ?? null,
          source: 'app' as const,
          check: () => this.approvals!.assertRuntimeFresh(approval.item),
        };
        await pauses[operation.op === 'project_pause' ? 'pause' : 'resume'](
          { scope: 'project', projectKey },
          requester,
        );
        return null;
      }
    }
    return (await projects.load(projectKey)).version;
  }
}

/** Owner decisions replay stored operations, keeping stale proposals open for dismissal only. */
export class OperatorApprovals {
  private readonly applying = new Set<string>();
  constructor(privateDeps: Dependencies & { actions: OperatorActions }) {
    this.deps = privateDeps;
  }
  private readonly deps: Dependencies & { actions: OperatorActions };

  assertRuntimeFresh(item: InboxItem): void {
    const payload = operatorApprovalOf(item)!;
    if (payload.operation.op === 'session_stop') {
      const session = this.deps.sessions.find(payload.operation.sessionId);
      if (
        !session ||
        session.projectKey !== item.projectKey ||
        !this.deps.sessions.isRunning(session.id) ||
        session.id !== payload.session?.id ||
        session.startedAt !== payload.session.startedAt
      )
        throw conflict('operator_approval_stale', 'session changed');
    } else if (payload.operation.op === 'project_pause' || payload.operation.op === 'project_resume') {
      if (
        canonical(payload.changes) !==
        canonical(this.deps.actions.pauseChanges(item.projectKey, payload.operation.op))
      )
        throw conflict('operator_approval_stale', 'pause changed');
    }
  }

  private async fresh(item: InboxItem): Promise<boolean> {
    const payload = operatorApprovalOf(item)!;
    if (payload.stale) return false;
    try {
      this.assertRuntimeFresh(item);
      const request = this.deps.ctx.repos.operatorRequests.get(payload.requestId);
      if (!request || request.projectKey !== item.projectKey) return false;
      const preview = await this.deps.actions.preview(
        item.projectKey,
        item.source,
        request,
        payload.operation,
      );
      return preview.level !== 'never' && canonical(preview.changes) === canonical(payload.changes);
    } catch (err) {
      if (err instanceof DomainError) return false;
      throw err;
    }
  }

  async apply(item: InboxItem, by: Resolver, optionId: string): Promise<void> {
    const config = await this.deps.projects.config(item.projectKey);
    const owner = memberOf(config, by.handle);
    if (by.via || owner?.kind !== 'human' || owner.access !== 'owner')
      throw forbidden('owner_approval_required', 'only an owner using their own login may decide');
    const payload = operatorApprovalOf(item)!;
    if (payload.stale) {
      if (optionId !== 'dismiss') throw conflict('operator_approval_stale', 'the proposal is stale');
      return;
    }
    if (optionId === 'reject') {
      this.deps.ctx.repos.operatorRequests.updateStep(payload.stepId, 'rejected');
      this.notify(item, 'rejected');
      return;
    }
    if (!(await this.fresh(item))) {
      this.stale(item);
      throw conflict('operator_approval_stale', 'the proposal no longer matches');
    }
    this.applying.add(item.id);
    try {
      const request = this.deps.ctx.repos.operatorRequests.get(payload.requestId)!;
      const version = await this.deps.actions.execute(
        item.projectKey,
        item.source,
        request,
        payload.operation,
        { item, by },
      );
      this.deps.ctx.repos.operatorRequests.updateStep(payload.stepId, 'approved', version);
      this.notify(item, `approved by ${by.handle}`);
    } catch (err) {
      if (
        err instanceof DomainError &&
        (err.code === 'operator_approval_stale' || err.code === 'config_conflict')
      ) {
        this.stale(item);
        throw conflict('operator_approval_stale', 'the proposal changed before execution');
      }
      throw err;
    } finally {
      this.applying.delete(item.id);
    }
  }

  async recheck(projectKey: string): Promise<void> {
    for (const item of this.deps.ctx.repos.inbox.listOpen('approval')) {
      if (
        item.projectKey !== projectKey ||
        this.applying.has(item.id) ||
        !operatorApprovalOf(item) ||
        operatorApprovalOf(item)!.stale
      )
        continue;
      if (!(await this.fresh(item))) this.stale(item);
    }
  }

  private stale(item: InboxItem): void {
    const current = this.deps.ctx.repos.inbox.get(item.id);
    const payload = current ? operatorApprovalOf(current) : null;
    if (!current || current.state !== 'open' || !payload || payload.stale) return;
    const step = this.deps.ctx.repos.operatorRequests
      .steps(payload.requestId)
      .find((s) => s.id === payload.stepId);
    if (step?.status !== 'awaiting_approval') return;
    const reason =
      payload.operation.op === 'session_stop'
        ? 'session_changed'
        : payload.operation.op === 'project_pause' || payload.operation.op === 'project_resume'
          ? 'pause_changed'
          : 'config_changed';
    this.deps.inbox.staleOperator(current.id, {
      ...current.payload,
      operator: { ...payload, stale: { reason, at: isoNow(this.deps.ctx) } },
    });
    this.deps.ctx.repos.operatorRequests.updateStep(payload.stepId, 'stale');
    this.notify(current, 'stale');
  }

  private notify(item: InboxItem, status: string): void {
    this.deps.messages.record({
      projectKey: item.projectKey,
      from: 'system',
      to: [item.source],
      taskKey: null,
      body: `Operator proposal ${item.id} (${item.title}): ${status}.`,
      actor: SYSTEM_ACTOR,
    });
  }
}
