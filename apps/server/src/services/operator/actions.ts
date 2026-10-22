import type { OperatorPauses, OperatorSessions } from './ports';
import {
  applyConfigPatch,
  prepareOperatorConfigPatch,
  canWaiveOperatorApproval,
  hasOperatorWaiverField,
  operatorWaiverChanged,
  canonical,
  isOperator,
  memberOf,
  operatorApprovalOf,
  hasPendingOperatorAgreement,
  operatorKnowledgeOperationIncluded,
  operatorAutonomousLevel,
  operatorConfigVerdict,
  operatorCriticalOp,
  OperatorOperation,
  OperatorPlan,
  unknownPatchRepo,
} from '@projectman/shared';
import type {
  ConfigChangeRow,
  InboxItem,
  OperatorAction,
  OperatorApprovalPayload,
  OperatorConfigVerdict,
  OperatorConsequence,
  ProjectConfig,
} from '@projectman/shared';
import type { OperatorRequestRecord } from '../../db';
import { ownerHandles } from '@projectman/shared';
import { isoNow } from '../../core/base';
import type { DomainContext } from '../../core/base';
import { conflict, DomainError, forbidden, invalid, notFound } from '../../kernel';
import { DECISION_OPTIONS } from '../../core/inbox';
import type { InboxService, Resolver } from '../../core/inbox';
import type { MemberService } from '../../core/members';
import type { MessageService, Messaging } from '../../core/messages';
import type { OperatorRequests, OperatorSteps } from './requests';
import type { Author, ProjectService } from '../../core/projects';
import type { OperatorConfigAuthorization, OperatorKnowledgeStore } from '../../contracts';
import { aiActor, newId, SYSTEM_ACTOR } from '../../kernel';

interface Dependencies {
  ctx: DomainContext;
  projects: ProjectService;
  members: MemberService;
  inbox: InboxService;
  steps: OperatorSteps;
  requests: OperatorRequests;
  sessions: OperatorSessions;
  pauses: OperatorPauses;
  messages: MessageService;
  messaging: Pick<Messaging, 'send'>;
  knowledge: OperatorKnowledgeStore;
}

const OPERATOR_CRITICAL_TTL_MS = 24 * 60 * 60_000;

const actionOf = (operation: OperatorOperation): OperatorAction =>
  operation.op === 'message_send'
    ? 'message'
    : operation.op === 'config_patch'
      ? 'config_change'
      : operation.op === 'member_update'
        ? 'member_change'
        : operation.op;

function consequenceOf(operation: OperatorOperation, changes: ConfigChangeRow[]): OperatorConsequence {
  if (
    [
      'member_hire',
      'member_retire',
      'session_stop',
      'message_send',
      'project_pause',
      'project_resume',
    ].includes(operation.op)
  )
    return operation.op as OperatorConsequence;
  if (changes.some((r) => r.field === 'outboundNetwork')) return 'network';
  if (changes.some((r) => ['permissionMode', 'approver'].includes(r.field))) return 'permission_mode';
  if (changes.some((r) => r.area === 'label')) return 'labels';
  if (changes.some((r) => ['stage', 'gate'].includes(r.area))) return 'pipeline';
  if (changes.some((r) => r.area === 'repos' && (r.field === 'reviewTest' || r.field === 'fullTestAtMerge')))
    return 'review_test';
  if (changes.some((r) => r.area === 'repos' || r.field === 'workspacePath')) return 'locations';
  if (changes.some((r) => r.field.toLowerCase().includes('fix'))) return 'fix_limit';
  if (changes.some((r) => r.field === 'operatorWatch')) return 'operator_watch';
  if (changes.some((r) => r.area === 'member')) return 'member_other';
  return changes.some((r) => r.area === 'project') ? 'project' : 'other';
}

/** Executes only within an owner's request; previews and commits use the same member mutations. */
export class OperatorActions implements OperatorConfigAuthorization {
  constructor(privateDeps: Dependencies) {
    this.deps = privateDeps;
  }
  private readonly deps: Dependencies;

  private ownerRequest(config: ProjectConfig, request: OperatorRequestRecord, operator: string): boolean {
    if (
      !['message', 'answer', 'approval'].includes(request.source) ||
      this.deps.requests.openFor(request.sessionId)?.id !== request.id
    )
      return false;
    const owner = memberOf(config, request.fromHandle);
    const message = request.messageId ? this.deps.ctx.repos.messages.get(request.messageId) : null;
    if (
      owner?.kind !== 'human' ||
      owner.access !== 'owner' ||
      !message ||
      message.via ||
      message.projectKey !== request.projectKey ||
      message.from !== request.fromHandle ||
      !message.to.includes(operator)
    )
      return false;
    if (request.source === 'approval') return !!this.deps.requests.approvalFor(config, request, operator);
    return request.source === 'answer'
      ? message.answer?.inboxItemId === request.inboxItemId
      : !message.answer && !message.origin;
  }

  async authorize(input: Parameters<OperatorConfigAuthorization['authorize']>[0]) {
    const { previous, next, projectKey, operator, requestId, expectedAgreementVersion } = input;
    const request = this.deps.ctx.repos.operatorRequests.get(requestId);
    const verdict = operatorConfigVerdict(previous, next, { operator });
    if (!request || request.projectKey !== projectKey || !this.ownerRequest(previous, request, operator))
      throw forbidden('operator_no_request', 'waiver needs the same open own-login owner request');
    if (
      !canWaiveOperatorApproval(verdict, {
        enabled: previous.team.operatorApprovalWaiver ?? false,
        agreementVersion: expectedAgreementVersion,
        ownerRequest: true,
      })
    )
      throw forbidden('owner_approval_required', 'this change requires a human click');
    const knowledge = await this.deps.knowledge.readKnowledge(projectKey);
    if (!knowledge.agreement || knowledge.agreement.version !== expectedAgreementVersion)
      throw conflict('operator_knowledge_stale', 'the approved agreement changed or is missing');
    if (!this.ownerRequest(previous, request, operator))
      throw forbidden('operator_no_request', 'the owner request closed before execution');
    return { mode: 'waived' as const, agreementVersion: knowledge.agreement.version };
  }

  /** Reconcile durable intents from server-authored config attribution; never replay a mutation. */
  async recover(projectKey?: string): Promise<void> {
    for (const project of this.deps.projects
      .summaries()
      .filter((project) => !projectKey || project.key === projectKey)) {
      if (
        !this.deps.ctx.repos.operatorRequests
          .executions(project.key)
          .some((entry) => entry.status === 'prepared')
      ) {
        if (!projectKey) this.reportCommitted(project.key);
        continue;
      }
      await this.deps.projects.withConfigurationLock(project.key, async () => {
        const intents = this.deps.ctx.repos.operatorRequests
          .executions(project.key)
          .filter((entry) => entry.status === 'prepared');
        if (!intents.length) return;
        const history = [];
        for (let offset = 0; ; offset += 500) {
          const page = await this.deps.projects.history(project.key, 500, offset);
          history.push(...page);
          if (page.length < 500) break;
        }
        for (const intent of intents) {
          const commit = history.find(
            (entry) =>
              entry.operator &&
              entry.operatorStepId === intent.id &&
              entry.operatorRequestId === intent.requestId &&
              (entry.operatorAgreementVersion ?? null) === intent.agreementVersion &&
              entry.operatorApprovalMode === intent.approvalMode,
          );
          if (commit) {
            await this.deps.projects.recoverOperatorExecution(
              project.key,
              intent.id,
              commit.version,
              aiActor(commit.operator!),
            );
          } else {
            this.deps.ctx.unitOfWork(() =>
              this.deps.ctx.repos.operatorRequests.finishExecution(
                intent.id,
                'failed',
                isoNow(this.deps.ctx),
                null,
                {
                  code: 'operator_no_request',
                  message: 'execution did not commit and was not replayed',
                },
              ),
            );
          }
        }
      });
      this.reportCommitted(project.key);
    }
  }

  async run(
    projectKey: string,
    requestId: string,
    title: string,
    input: OperatorOperation,
    plan?: OperatorPlan,
  ) {
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
      if (hasPendingOperatorAgreement(ctx.repos.inbox.listOpen('approval'), projectKey, requestId))
        throw conflict('operator_agreement_pending', 'approve or dismiss the pending agreement first');
      if (hasOperatorWaiverField(input))
        throw forbidden('owner_approval_required', 'use the dedicated owner waiver endpoint');
      const operation = OperatorOperation.parse(input);
      await this.recover(projectKey);
      if (request.source === 'approval') {
        if (this.deps.requests.openFor(request.sessionId)?.id !== request.id)
          throw forbidden('operator_no_request', 'the approved continuation is no longer open');
        const proposal = this.deps.requests.approvalFor(config, request, source);
        if (!proposal || !operatorKnowledgeOperationIncluded(proposal, operation))
          throw forbidden('operator_no_request', 'this operation is outside the approved continuation');
      }
      const currentVersion = (await projects.load(projectKey)).version;
      const completed = ctx.repos.operatorRequests
        .executions(projectKey)
        .find(
          (intent) =>
            intent.requestId === requestId &&
            intent.status === 'committed' &&
            intent.configVersion === currentVersion &&
            canonical(intent.operation) === canonical(operation),
        );
      if (completed) {
        if (completed.approvalMode === 'waived') this.report(projectKey, requestId, source);
        return {
          status: 'done' as const,
          step_id: completed.id,
          changes: completed.changes,
          config_version: completed.configVersion,
        };
      }
      if (operatorCriticalOp(operation.op) && !plan)
        throw invalid('operator_plan_required', 'critical operations require a plan');
      const parsedPlan = plan ? OperatorPlan.parse(plan) : null;
      if (!title.trim() || title.length > 120)
        throw invalid('invalid_request', 'title must have 1 to 120 characters');
      const preview = await this.preview(projectKey, source, request, operation);
      changes = preview.changes;
      if (hasPendingOperatorAgreement(ctx.repos.inbox.listOpen('approval'), projectKey, requestId))
        throw conflict('operator_agreement_pending', 'approve or dismiss the pending agreement first');
      if (preview.level === 'never')
        throw forbidden('operator_never', 'the Operator cannot make this change');
      const autonomous = 'autonomous' in preview && preview.autonomous;
      const knowledge =
        'waiverEligible' in preview && preview.level === 'approval' && !autonomous
          ? await this.deps.knowledge.readKnowledge(projectKey)
          : null;
      const agreement =
        'waiverEligible' in preview &&
        !autonomous &&
        canWaiveOperatorApproval(preview, {
          enabled: config.team.operatorApprovalWaiver ?? false,
          agreementVersion: knowledge?.agreement?.version ?? null,
          ownerRequest: this.ownerRequest(config, request, source),
        })
          ? knowledge!.agreement
          : null;
      if (preview.level === 'now' || autonomous || agreement) {
        steps.record({
          id: stepId,
          requestId,
          action: actionOf(operation),
          status: 'queued',
          changes,
          member: 'handle' in operation ? operation.handle : null,
        });
        const configVersion = await this.execute(projectKey, source, request, preview.operation, undefined, {
          stepId,
          agreementVersion: agreement?.version,
          mode: agreement ? 'waived' : 'click',
          operation,
        });
        ctx.repos.operatorRequests.updateStep(stepId, 'done', configVersion);
        changes = ctx.repos.operatorRequests.steps(requestId).find((step) => step.id === stepId)!.changes;
        if (agreement) this.report(projectKey, requestId, source);
        return { status: 'done' as const, step_id: stepId, changes, config_version: configVersion };
      }
      // No await between the persisted lookup and insertion: concurrent submissions share one proposal.
      const existing = ctx.repos.inbox.listOpen('approval').find((item) => {
        const payload = operatorApprovalOf(item);
        return (
          item.projectKey === projectKey &&
          item.source === source &&
          payload &&
          !payload.stale &&
          (!payload.expiresAt || Date.parse(payload.expiresAt) > ctx.now().getTime()) &&
          canonical(payload.operation) === canonical(preview.operation)
        );
      });
      if (existing) {
        const payload = operatorApprovalOf(existing)!;
        return {
          status: 'awaiting_approval' as const,
          step_id: payload.stepId,
          changes: payload.changes,
          config_version: payload.baseVersion,
          inbox_item_id: existing.id,
          deduplicated: true as const,
        };
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
        plan: parsedPlan,
        expiresAt: operatorCriticalOp(operation.op)
          ? new Date(ctx.now().getTime() + OPERATOR_CRITICAL_TTL_MS).toISOString()
          : null,
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
        member:
          preview.operation.op === 'message_send'
            ? preview.operation.to[0]!
            : 'handle' in operation
              ? operation.handle
              : null,
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
      const existingStep = ctx.repos.operatorRequests.steps(requestId).find((step) => step.id === stepId);
      if (
        existingStep &&
        !ctx.repos.operatorRequests.executions(projectKey).some((intent) => intent.id === stepId)
      )
        ctx.repos.operatorRequests.updateStep(
          stepId,
          'refused',
          null,
          err instanceof DomainError
            ? { code: err.code, message: err.message }
            : { code: 'invalid_request', message: 'operation could not be completed' },
        );
      if (!existingStep)
        steps.record({
          id: stepId,
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

  private report(projectKey: string, requestId: string, source: string): void {
    const entries = this.deps.ctx.repos.operatorRequests
      .steps(requestId)
      .filter((step) => step.approvalMode === 'waived' && step.status === 'done');
    if (!entries.length) return;
    const marker = `[operator-waiver-report:${requestId}:${entries
      .map((step) => step.id)
      .sort()
      .join(',')}]`;
    if (this.deps.ctx.repos.messages.hasNote(projectKey, 'system', source, marker)) return;
    this.deps.messages.record({
      projectKey,
      from: 'system',
      to: [source],
      taskKey: null,
      actor: SYSTEM_ACTOR,
      body: `${marker}\nOperator waived changes for request ${requestId}:\n${entries
        .flatMap((step) =>
          step.changes.map(
            (row) =>
              `${step.id}: ${row.area}/${row.target ?? ''}/${row.field}: ${row.before} -> ${row.after}`,
          ),
        )
        .join('\n')}`,
    });
  }

  private reportCommitted(projectKey: string): void {
    const requests = new Set(
      this.deps.ctx.repos.operatorRequests
        .executions(projectKey)
        .filter((intent) => intent.status === 'committed' && intent.approvalMode === 'waived')
        .map((intent) => intent.requestId),
    );
    for (const requestId of requests) {
      const request = this.deps.ctx.repos.operatorRequests.get(requestId);
      const session = request && this.deps.ctx.repos.sessions.get(request.sessionId);
      if (session) this.report(projectKey, requestId, session.member);
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
    if (!isOperator(memberOf(next, source)))
      throw forbidden('operator_only', 'only the Operator may operate');
    if (operation.op === 'message_send') {
      for (const handle of operation.to) {
        const recipient = memberOf(next, handle);
        if (handle === source || recipient?.kind !== 'human' || recipient.access === 'owner')
          throw invalid('operator_message_recipient', `invalid message recipient: ${handle}`);
      }
      if (operation.taskKey) {
        const task = ctx.repos.tasks.get(operation.taskKey);
        if (!task || task.projectKey !== projectKey) throw notFound('task', operation.taskKey);
      }
      return {
        level: 'approval' as const,
        changes: [] as ConfigChangeRow[],
        operation: { ...operation, to: [...new Set(operation.to)].sort() },
        baseVersion: loaded.version,
        session: null,
      };
    }
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
        const patch = prepareOperatorConfigPatch(loaded.config, loaded.version, operation.patch);
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
    if (operatorWaiverChanged(loaded.config, next))
      throw forbidden('owner_approval_required', 'use the dedicated owner waiver endpoint');
    const verdict = operatorConfigVerdict(loaded.config, next, { operator: source });
    return {
      ...verdict,
      operation,
      baseVersion: loaded.version,
      session: null,
      autonomous: this.autonomous(loaded.config, next, verdict, request, source),
    };
  }

  /** The owner's own-login request in the app is the approval of what `operatorAutonomousLevel` lets through. */
  private autonomous(
    previous: ProjectConfig,
    next: ProjectConfig,
    verdict: OperatorConfigVerdict,
    request: OperatorRequestRecord,
    operator: string,
  ): boolean {
    return (
      verdict.level === 'approval' &&
      (request.source === 'message' || request.source === 'answer') &&
      this.ownerRequest(previous, request, operator) &&
      operatorAutonomousLevel(previous, next, verdict, operator) === 'now'
    );
  }

  /** Called inside the configuration lock: does this commit stand on the owner's request alone? */
  autonomousCommit(input: Parameters<OperatorConfigAuthorization['autonomousCommit']>[0]): boolean {
    const request = this.deps.ctx.repos.operatorRequests.get(input.requestId);
    return (
      !!request &&
      request.projectKey === input.projectKey &&
      this.autonomous(
        input.previous,
        input.next,
        operatorConfigVerdict(input.previous, input.next, { operator: input.operator }),
        request,
        input.operator,
      )
    );
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
    execution?: {
      stepId: string;
      agreementVersion?: number;
      mode: 'click' | 'waived';
      operation?: OperatorOperation;
    },
  ): Promise<string | null> {
    const { projects, members, sessions, pauses, ctx } = this.deps;
    if (hasPendingOperatorAgreement(ctx.repos.inbox.listOpen('approval'), projectKey, request.id))
      throw conflict('operator_agreement_pending', 'approve or dismiss the pending agreement first');
    const member = memberOf(await projects.config(projectKey), source);
    if (!isOperator(member)) throw forbidden('operator_only', 'only the Operator may operate');
    const author: Author = {
      name: member!.displayName,
      email: `${source}@projectman.local`,
      operator: source,
      request: request.quote,
      operatorRequestId: request.id,
      operatorStepId: execution?.stepId ?? (approval ? operatorApprovalOf(approval.item)!.stepId : undefined),
      operatorOperation: execution?.operation ?? operation,
      operatorAgreementVersion: execution?.agreementVersion,
      operatorApprovalMode: execution?.mode ?? (approval ? 'click' : undefined),
      ...(approval ? { approvedBy: approval.by.handle, operatorApprovalId: approval.item.id } : {}),
    };
    const by = { actor: aiActor(source), author };
    switch (operation.op) {
      case 'config_patch': {
        const loaded = await projects.load(projectKey);
        return (
          await projects.patch(
            projectKey,
            prepareOperatorConfigPatch(loaded.config, loaded.version, operation.patch),
            by,
          )
        ).version;
      }
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
      case 'message_send':
        if (!approval) throw forbidden('owner_approval_required', 'sending needs approval');
        await this.deps.messaging.send(projectKey, source, operation, {
          actor: aiActor(source),
          kind: 'info',
        });
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
        const target = { scope: 'project' as const, projectKey };
        if (operation.op === 'project_pause')
          await pauses.pause(
            target,
            requester,
            operation.reason === undefined ? {} : { reason: operation.reason },
          );
        else await pauses.resume(target, requester);
        return null;
      }
    }
    return (
      ctx.repos.operatorRequests.executions(projectKey).find((intent) => intent.id === author.operatorStepId)
        ?.configVersion ?? (await projects.load(projectKey)).version
    );
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
      return (
        preview.level !== 'never' &&
        canonical(preview.changes) === canonical(payload.changes) &&
        (payload.operation.op !== 'message_send' || preview.baseVersion === payload.baseVersion)
      );
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
    if (this.applying.has(item.id))
      throw conflict('operator_approval_used', 'the proposal has already been consumed');
    if (payload.stale) {
      if (optionId !== 'dismiss') throw conflict('operator_approval_stale', 'the proposal is stale');
      return;
    }
    if (optionId !== 'approve' && optionId !== 'reject')
      throw invalid('unknown_option', `unknown option: ${optionId}`);
    if (this.expired(payload)) {
      this.stale(item, 'expired');
      throw conflict('operator_approval_stale', 'the proposal expired');
    }
    if (optionId === 'reject') {
      if (!this.deps.ctx.repos.operatorRequests.claimStep(payload.stepId))
        throw conflict('operator_approval_used', 'the proposal has already been consumed');
      this.deps.ctx.repos.operatorRequests.updateStep(payload.stepId, 'rejected');
      this.notify(item, 'rejected');
      return;
    }
    if (!(await this.fresh(item))) {
      this.stale(item);
      throw conflict('operator_approval_stale', 'the proposal no longer matches');
    }
    if (this.expired(payload)) {
      this.stale(item, 'expired');
      throw conflict('operator_approval_stale', 'the proposal expired');
    }
    if (!this.deps.ctx.repos.operatorRequests.claimStep(payload.stepId))
      throw conflict('operator_approval_used', 'the proposal has already been consumed');
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
      this.deps.ctx.repos.operatorRequests.updateStep(
        payload.stepId,
        'stale',
        null,
        err instanceof DomainError
          ? { code: err.code, message: err.message }
          : { code: 'operator_approval_stale', message: 'execution was interrupted' },
      );
      if (
        err instanceof DomainError &&
        (err.code === 'operator_approval_stale' || err.code === 'config_conflict')
      ) {
        this.stale(item);
        throw conflict('operator_approval_stale', 'the proposal changed before execution');
      }
      this.stale(item, 'interrupted');
      throw err;
    } finally {
      this.applying.delete(item.id);
    }
  }

  private pending(projectKey: string): InboxItem[] {
    return this.deps.ctx.repos.inbox.listOpen('approval').filter((item) => {
      const payload = operatorApprovalOf(item);
      return item.projectKey === projectKey && !this.applying.has(item.id) && payload && !payload.stale;
    });
  }

  hasPending(projectKey: string): boolean {
    return this.pending(projectKey).length > 0;
  }

  async recheck(projectKey: string): Promise<void> {
    for (const item of this.pending(projectKey)) {
      if (this.expired(operatorApprovalOf(item)!)) this.stale(item, 'expired');
      else if (!(await this.fresh(item))) this.stale(item);
    }
  }

  private expired(payload: OperatorApprovalPayload): boolean {
    return !!payload.expiresAt && Date.parse(payload.expiresAt) <= this.deps.ctx.now().getTime();
  }

  /** Recover consumed but unfinished proposals without replaying a possibly completed side effect. */
  sweep(): void {
    for (const item of this.deps.ctx.repos.inbox.listOpen('approval')) {
      const payload = operatorApprovalOf(item);
      if (!payload || payload.stale || this.applying.has(item.id)) continue;
      const step = this.deps.ctx.repos.operatorRequests
        .steps(payload.requestId)
        .find((s) => s.id === payload.stepId);
      if (step?.status !== 'awaiting_approval') this.stale(item, 'interrupted');
      else if (this.expired(payload)) this.stale(item, 'expired');
    }
  }

  private stale(
    item: InboxItem,
    explicitReason?: NonNullable<OperatorApprovalPayload['stale']>['reason'],
  ): void {
    const current = this.deps.ctx.repos.inbox.get(item.id);
    const payload = current ? operatorApprovalOf(current) : null;
    if (!current || current.state !== 'open' || !payload || payload.stale) return;
    const step = this.deps.ctx.repos.operatorRequests
      .steps(payload.requestId)
      .find((s) => s.id === payload.stepId);
    if (step?.status !== 'awaiting_approval' && step?.status !== 'stale' && explicitReason !== 'interrupted')
      return;
    const reason =
      explicitReason ??
      (payload.operation.op === 'session_stop'
        ? 'session_changed'
        : payload.operation.op === 'project_pause' || payload.operation.op === 'project_resume'
          ? 'pause_changed'
          : 'config_changed');
    this.deps.inbox.staleOperator(current.id, {
      ...current.payload,
      operator: { ...payload, stale: { reason, at: isoNow(this.deps.ctx) } },
    });
    this.deps.ctx.repos.operatorRequests.updateStep(payload.stepId, 'stale');
    this.notify(current, `stale (${reason})`);
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
