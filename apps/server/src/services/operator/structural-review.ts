import {
  coordinationMemberOf,
  dutyMembers,
  isOnLeave,
  memberOf,
  ownerHandles,
  structuralReviewOf,
} from '@projectman/shared';
import type {
  InboxItem,
  OperatorStructuralReview,
  ProjectConfig,
  StructuralReviewResult,
} from '@projectman/shared';
import { getLocale } from '@projectman/templates';
import type { MemberStartResult, ToolContext } from '../../contracts';
import type { DomainContext } from '../../core/base';
import type { InboxService, Resolver } from '../../core/inbox';
import type { ProjectService } from '../../core/projects';
import { conflict, externalToolOrigin, forbidden } from '../../kernel';
import type { OperatorAdmission } from './ports';
import type { CoordinationRequests, OperatorSteps } from './requests';
import type { OperatorSignals } from './signals';

export function structuralReviewText(payload: OperatorStructuralReview): string {
  return (
    `Occasional architecture review requested by the PM. Reason: ${payload.note}\n` +
    `Evidence (data): ${JSON.stringify({ evidence: payload.evidence, milestoneKey: payload.milestoneKey })}\n` +
    'Re-read the current cards and relevant responsibility boundaries. Report only a few concrete suggestions, or say that no change is needed. Do not create cards or refactor automatically. Send your report to the PM; send only learned-principle proposals to the Operator, never write its knowledge.'
  );
}

/** A standing signal can propose a review; only an owner's request can start one. */
export class StructuralReviews {
  private readonly running = new Set<string>();
  private readonly starting = new Map<string, OperatorStructuralReview>();
  private readonly deps: {
    ctx: DomainContext;
    projects: ProjectService;
    inbox: InboxService;
    signals: OperatorSignals;
    requests: CoordinationRequests;
    steps: OperatorSteps;
    admission: Pick<OperatorAdmission, 'memberLoad'>;
  };
  constructor(deps: StructuralReviews['deps']) {
    this.deps = deps;
  }

  private select(config: ProjectConfig) {
    const sessions = this.deps.ctx.repos.sessions.list(config.project.key);
    return (
      dutyMembers(config, 'technical_direction')
        .filter(
          (member) =>
            member.kind === 'ai' &&
            !isOnLeave(member) &&
            member.handle !== coordinationMemberOf(config)?.handle &&
            this.deps.admission.memberLoad(config, member.handle) < member.capacity &&
            !sessions.some(
              (s) =>
                s.member === member.handle &&
                !s.endedAt &&
                ['starting', 'working', 'waiting_input', 'waiting_permission', 'idle'].includes(s.state) &&
                s.workItem.type !== 'general',
            ),
        )
        .sort(
          (a, b) =>
            this.deps.admission.memberLoad(config, a.handle) -
              this.deps.admission.memberLoad(config, b.handle) || a.handle.localeCompare(b.handle),
        )[0] ?? null
    );
  }

  async request(
    ctx: ToolContext,
    signalId: string,
    note: string,
    start: (member: string, text: string) => Promise<MemberStartResult>,
  ): Promise<StructuralReviewResult> {
    const sessionKey = `session:${ctx.sessionId}`;
    if (this.running.has(signalId) || this.running.has(sessionKey))
      throw conflict('operator_signal_closed', 'a review request is already running');
    this.running.add(signalId);
    this.running.add(sessionKey);
    try {
      const config = await this.deps.projects.config(ctx.projectKey);
      const { signal } = this.deps.signals.currentStepTargets(ctx.projectKey, signalId);
      const facts = this.deps.signals.structuralFacts(signal);
      if (!facts || signal.deliveredTo !== ctx.member)
        throw conflict('operator_signal_closed', 'structural evidence is no longer current');
      const request = this.deps.requests.openFor(ctx.sessionId);
      const approvedItem =
        request?.source === 'approval' && request.inboxItemId
          ? this.deps.ctx.repos.inbox.get(request.inboxItemId)
          : null;
      const approved = approvedItem && structuralReviewOf(approvedItem);
      if (request?.source === 'approval' && approved?.signalId !== signalId)
        throw conflict('operator_signal_closed', 'the approval belongs to another signal');
      const member = this.select(config);
      if (!member) return { status: 'held', member: null, message_id: null, inbox_item_id: null };
      const payload: OperatorStructuralReview = {
        signalId,
        ...facts,
        note: approved?.note ?? note,
        member: member.handle,
      };
      if (!request) {
        const existing = this.deps.ctx.repos.inbox
          .list(ctx.projectKey, { kind: 'question', state: ['open', 'resolved'] })
          .find((item) => structuralReviewOf(item)?.signalId === signalId);
        if (existing)
          return {
            status: existing.state === 'open' ? 'awaiting_approval' : 'held',
            member: structuralReviewOf(existing)!.member,
            message_id: null,
            inbox_item_id: existing.id,
          };
        const locale = getLocale(config.project.language).structuralReview;
        const item = this.deps.inbox.create({
          projectKey: ctx.projectKey,
          kind: 'question',
          source: ctx.member,
          sessionId: ctx.sessionId,
          taskKey: null,
          assignees: ownerHandles(config),
          title: locale.question,
          options: [
            { id: 'approve', label: locale.approve, style: 'primary' },
            { id: 'reject', label: locale.reject, style: 'secondary' },
          ],
          payload: {
            question: `${locale.question} (${signalId})`,
            details: `${note}\n\n${locale.details}\n\n${member.handle}\n${JSON.stringify(facts)}`,
            operatorStructuralReview: payload,
          },
        });
        const round = this.deps.requests.openRound(ctx.projectKey, ctx.sessionId);
        this.deps.steps.record({
          requestId: round.id,
          action: 'structural_review',
          status: 'awaiting_approval',
          signalId,
          member: member.handle,
          inboxItemId: item.id,
        });
        return {
          status: 'awaiting_approval',
          member: member.handle,
          message_id: null,
          inbox_item_id: item.id,
        };
      }
      this.starting.set(ctx.sessionId, payload);
      const result = await start(member.handle, structuralReviewText(payload));
      const state = result.recipient.start?.state;
      const failure = result.recipient.start;
      this.deps.steps.record({
        requestId: request.id,
        action: 'structural_review',
        status: state === 'failed' ? 'refused' : 'done',
        refusal:
          failure?.state === 'failed'
            ? { code: 'session_start_failed', message: failure.code || 'member start failed' }
            : null,
        signalId,
        member: member.handle,
        inboxItemId: approvedItem?.id ?? null,
      });
      if (state !== 'failed') this.deps.signals.resolve(ctx.projectKey, signal.caseKey);
      return {
        status:
          state === 'failed'
            ? 'failed'
            : state === 'waiting' || state === 'starting'
              ? 'waiting'
              : result.recipient.delivery === 'held'
                ? 'held'
                : 'started',
        member: member.handle,
        message_id: result.messageId,
        inbox_item_id: approvedItem?.id ?? null,
      };
    } finally {
      this.running.delete(signalId);
      this.running.delete(sessionKey);
      this.starting.delete(ctx.sessionId);
    }
  }

  /**
   * The integrator in super mode starts the review a current structural signal calls for (PM-784), with the
   * key owner's authority instead of an approval request: the signal must be open for the coordinator, the
   * evidence must hold and a member must be free. A proposal that is waiting for an owner, or that an owner
   * already decided, is reported as it stands and never bypassed. A failed start leaves the signal open.
   * `start` is the project's usual member start, made with the full super actor by the caller.
   */
  async requestExternal(
    projectKey: string,
    signalId: string,
    note: string,
    start: (member: string, text: string) => Promise<MemberStartResult>,
  ): Promise<StructuralReviewResult> {
    if (this.running.has(signalId))
      throw conflict('operator_signal_closed', 'a review request is already running');
    this.running.add(signalId);
    try {
      const config = await this.deps.projects.config(projectKey);
      externalToolOrigin(config);
      const { signal } = this.deps.signals.currentStepTargets(projectKey, signalId);
      const facts = this.deps.signals.structuralFacts(signal);
      if (!facts) throw conflict('operator_signal_closed', 'structural evidence is no longer current');
      const existing = this.deps.ctx.repos.inbox
        .list(projectKey, { kind: 'question', state: ['open', 'resolved'] })
        .find((item) => structuralReviewOf(item)?.signalId === signalId);
      if (existing)
        return {
          status: existing.state === 'open' ? 'awaiting_approval' : 'held',
          member: structuralReviewOf(existing)!.member,
          message_id: null,
          inbox_item_id: existing.id,
        };
      const member = this.select(config);
      if (!member) return { status: 'held', member: null, message_id: null, inbox_item_id: null };
      const text = structuralReviewText({ signalId, ...facts, note, member: member.handle });
      // The scope, the signal and the free member are checked again where the start begins.
      const latest = await this.deps.projects.config(projectKey);
      externalToolOrigin(latest);
      const current = this.deps.signals.currentStepTargets(projectKey, signalId).signal;
      if (!this.deps.signals.structuralFacts(current) || this.select(latest)?.handle !== member.handle)
        throw conflict('operator_signal_closed', 'review target, capacity or evidence changed');
      const result = await start(member.handle, text);
      const state = result.recipient.start?.state;
      if (state !== 'failed') this.deps.signals.resolve(projectKey, signal.caseKey);
      return {
        status:
          state === 'failed'
            ? 'failed'
            : state === 'waiting' || state === 'starting'
              ? 'waiting'
              : result.recipient.delivery === 'held'
                ? 'held'
                : 'started',
        member: member.handle,
        message_id: result.messageId,
        inbox_item_id: null,
      };
    } finally {
      this.running.delete(signalId);
    }
  }

  /** Called at the actual start_member write boundary as well as on the review tool. */
  assertStart(
    ctx: ToolContext,
    args: { member: string; text: string; taskKey?: string; signalId?: string; despiteWorkers?: boolean },
  ) {
    const request = this.deps.requests.openFor(ctx.sessionId);
    if (request?.source !== 'approval' && !this.starting.has(ctx.sessionId)) return;
    if (request?.source === 'approval' && !this.starting.has(ctx.sessionId))
      throw conflict(
        'operator_signal_closed',
        'review target changed; continue through request_structural_review',
      );
    const item = request?.inboxItemId && this.deps.ctx.repos.inbox.get(request.inboxItemId);
    const payload = this.starting.get(ctx.sessionId) ?? (item && structuralReviewOf(item));
    if (!payload) throw conflict('operator_signal_closed', 'missing structural approval');
    const config = this.deps.projects.cachedConfig(ctx.projectKey)!;
    const { signal } = this.deps.signals.currentStepTargets(ctx.projectKey, payload.signalId);
    const facts = this.deps.signals.structuralFacts(signal);
    if (
      !facts ||
      args.taskKey ||
      args.signalId ||
      args.despiteWorkers ||
      this.select(config)?.handle !== args.member ||
      args.text !== structuralReviewText({ ...payload, ...facts, member: args.member })
    )
      throw conflict('operator_signal_closed', 'review target, capacity, evidence or text changed');
  }

  async decide(item: InboxItem, by: Resolver, option: string) {
    const config = await this.deps.projects.config(item.projectKey);
    const owner = memberOf(config, by.handle);
    if (by.via || owner?.kind !== 'human' || owner.access !== 'owner')
      throw forbidden(
        'owner_approval_required',
        'only an owner using their own login may decide a structural review',
      );
    const payload = structuralReviewOf(item);
    if (!payload || coordinationMemberOf(config)?.handle !== item.source)
      throw conflict('operator_signal_closed', 'the proposing PM changed');
    if (option === 'approve') {
      const { signal } = this.deps.signals.currentStepTargets(item.projectKey, payload.signalId);
      if (!this.deps.signals.structuralFacts(signal))
        throw conflict('operator_signal_closed', 'the structural evidence expired');
    }
    for (const step of this.deps.ctx.repos.operatorRequests.stepsOfSignal(payload.signalId))
      if (
        step.inboxItemId === item.id &&
        step.action === 'structural_review' &&
        step.status === 'awaiting_approval'
      )
        this.deps.ctx.repos.operatorRequests.updateStep(
          step.id,
          option === 'approve' ? 'approved' : 'rejected',
        );
    // InboxService closes the question and delivers the answer to the PM. Nobody starts here.
  }
}
