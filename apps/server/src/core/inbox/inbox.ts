export function createInboxService(deps: ConstructorParameters<typeof InboxService>[0]): InboxService {
  return new InboxService(deps);
}

import {
  assertIntegratorAccess,
  assertOwnApproval,
  assertOwnOrSuperApproval,
  integratorExecution,
} from '../../kernel';
import {
  APPROVAL_PAYLOAD_KEYS,
  hasProtectedQuestionPayload,
  humanInboxAssignment,
  isIntegratorTodo,
  isIntegratorFixLimitDecision,
  isIntegratorInboxItem,
  wasIntegratorTodo,
  planIntegratorInboxEscalation,
  selectFixLimitRecipient,
  selectTodoRecipient,
  technicalDeciderOf,
  FixLimitOptionId,
  ResolveIntegratorFixLimitRequest as IntegratorFixLimitRequestSchema,
  ResolveIntegratorTodoRequest as IntegratorTodoRequestSchema,
  ScreeningTodo as ScreeningTodoSchema,
  approvalRefusal,
  canResolveInboxItem,
  canSeeInboxItem,
  DELEGATED_INPUT_LIMIT,
  PERMISSION_LEAD_CAP_MS,
  canDecidePermission,
  deliveredLeadDeadline,
  emailApprovalOf,
  externalQuestionAnswerRefusal,
  superDecisionRefusal,
  gateRequestOf,
  handOnRequestOf,
  hasBoundOrigin,
  hasConnectedOrigin,
  isPendingQuestion,
  isRelayableQuestionItem,
  machineTodoIssuerAllowed,
  machineTodoIssuerOf,
  memberOf,
  operatorApprovalOf,
  operatorKnowledgeApprovalOf,
  structuralReviewOf,
  OPERATOR_DISMISS_OPTION,
  permissionDelegationOf,
  permissionDelegationState,
  PENDING_INBOX_STATES,
  questionPayloadOf,
  CombineQuestionsRequest,
  coordinationMemberOf,
  questionGroupCompatible,
  questionGroupLiveItemIds,
  QUESTION_SCREENING_MS,
  TODO_CANNOT_OPTION,
  TODO_DONE_OPTION,
  withQuestionAttachmentGone,
} from '@projectman/shared';
import type {
  Actor,
  DelegatedPermissionDecision,
  FixLimitDecisionPayload,
  GateRequestPayload,
  HumanAccess,
  InboxItem,
  InboxKind,
  InboxOption,
  InboxResolutionRule,
  InboxState,
  ObligationRef,
  ProjectConfig,
  QuestionCloseRule,
  QuestionRecipient,
  QuestionRecipientRefusal,
  QuestionScreening,
  QuestionTodo,
  ResolveInboxRequest,
  ResolveIntegratorFixLimitRequest,
  ResolveIntegratorTodoRequest,
  ScreeningTodo,
  ScreenedQuestionsResponse,
  BoundActor,
  TimelineEventData,
  TodoRoute,
  TaskStartWaiting,
  WorkItemRef,
} from '@projectman/shared';
import {
  fixLimitDeciders,
  ownerHandles,
  RETIRED_OPERATOR_HANDLE,
  TEAM_SETTING_POLICY,
} from '@projectman/shared';
import { isoNow } from '../base';
import type { DomainContext } from '../base';
import { bodyForOwners, formatFixLimitItem } from './fix-limit-text';
import type { QuestionGroupAnswerer, IntegratorTodoAccess } from './ports';
import { conflict, forbidden, invalid, notFound } from '../../kernel';
import type { ProjectService } from '../projects';
import type { TimelineService } from '../timeline';
import { SYSTEM_ACTOR, aiActor, attributedActor, excerpt, humanActor, newId, KeyedMutex } from '../../kernel';

/** How many screened questions the screened-questions list returns (PM-558). */
const SCREENED_QUESTIONS_LIMIT = 20;

/** Built-in option ids; the web app translates them (labels repeat the id). */
export const DECISION_OPTIONS: InboxOption[] = [
  { id: 'approve', label: 'approve', style: 'primary' },
  { id: 'reject', label: 'reject', style: 'danger' },
];

const APPROVAL_REFUSALS = {
  not_an_assignee: 'the current gate does not authorize this approver',
  release_four_eyes: 'release approval requires an independent human',
  self_review_forbidden: 'the assignee and PR authors cannot set this label',
} as const;

/** Free-text answer to a question (the text is the resolution note). */
export const ANSWER_OPTION: InboxOption = { id: 'answer', label: 'answer', style: 'secondary' };

type QuestionGroup = NonNullable<ReturnType<DomainContext['repos']['inbox']['groupOf']>>;

interface CreateInboxItemInput {
  id?: string;
  projectKey: string;
  kind: InboxKind;
  assignees: string[];
  source: string;
  sessionId?: string | null;
  taskKey?: string | null;
  title: string;
  body?: string | null;
  payload: Record<string, unknown>;
  options: InboxOption[];
  /** `screening`: the Operator looks at an AI member's question first and no person sees it yet (PM-556). */
  state?: 'open' | 'screening';
}

/** A new fix round limit decision (PM-714): the counted rounds and the options that can be carried out now. */
interface CreateFixLimitDecisionInput {
  projectKey: string;
  taskKey: string;
  /** The people who decide when the item is for the owners (`fixLimitDeciders`). */
  assignees: string[];
  fixLimit: FixLimitDecisionPayload;
  /** Only the executable options; the item shows the rest as unavailable but never offers them. */
  options: InboxOption[];
}

/** What the Operator settled about a question it screens, with no person involved (PM-558). */
interface ScreeningSettlement {
  outcome: 'answered' | 'forwarded' | 'moot';
  by: string;
  /** The reason; the owner and the timeline see it. */
  note: string;
  /** Outcome `answered`: the answer the asking member gets. */
  answer?: string;
  /** Outcome `forwarded`: the member the question went to. */
  forwardedTo?: string;
}

/** What the Operator decided to send on to the people, or why the system did (PM-558). */
interface ScreeningRelease {
  /** The Operator's outcome; none when the system released the question (`fallback`). */
  outcome?: 'decision' | 'todo';
  by?: string;
  note?: string;
  todo?: ScreeningTodo;
  feedbackId?: string;
  fallback?: 'timeout' | 'unavailable';
}

/** What the `question_screened` timeline entry says about the Operator's outcome. */
type ScreenedEntry = Pick<ScreeningSettlement, 'by' | 'note' | 'answer' | 'forwardedTo'> & {
  outcome: TimelineEventData['question_screened']['outcome'];
  todo?: QuestionTodo;
  feedbackId?: string;
};

/** `payload` with the screening record changed by `patch`; the record starts at `at` when it had none. */
function withScreening(
  payload: Record<string, unknown>,
  patch: Partial<QuestionScreening>,
  at: string,
): Record<string, unknown> {
  // Whatever settles the screening ends its hold for a machine (PM-708).
  const { queue: _held, ...current } = (payload.screening ?? {}) as Partial<QuestionScreening>;
  return { ...payload, screening: { until: at, ...current, ...patch } };
}

/**
 * Runs inside the transaction that closes the owner's question about a super operation (PM-762): it checks the
 * answer against the operation and moves it, or throws to leave both unchanged.
 */
type SuperOperationAnswer = (item: InboxItem, optionId: string, at: string, handle: string) => void;

export interface Resolver {
  via?: 'integrator';
  /** The Operator's super origin of a step the owner's token made (PM-757); `handle` stays the owner. */
  superActor?: BoundActor;
  handle: string;
  access: HumanAccess;
}

/** Who decides an inbox item another module owns (PM-593). */
type InboxDeciderKey =
  'merge_request' | 'hand_on' | 'email' | 'operator_knowledge' | 'operator_structural_review';
/** Merge, release and hand-on handlers close their item in their transaction; refusals leave it open.
 * The inbox closes operator approvals after their handler returns. */
export type InboxDecider = (
  item: InboxItem,
  by: Resolver,
  optionId: string,
  note: string | null,
) => void | Promise<void>;
/** Answers an AI member's question. */
type QuestionAnswerer = (
  item: InboxItem,
  attachmentIds: readonly string[],
  close: () => InboxItem,
) => Promise<InboxItem | null>;
/** The start of an AI asker that the visible inbox shows. */
interface AskerStarts {
  answerWorkItem(item: InboxItem): Promise<WorkItemRef>;
  waitingReason(
    projectKey: string,
    handle: string,
    workItem: WorkItemRef,
  ): Promise<TaskStartWaiting['reason'] | null>;
}

/** Human assignees for requests raised by an AI member: its sponsor, else the owners. */
export function sponsorOrOwners(config: ProjectConfig, memberHandle: string): string[] {
  const member = memberOf(config, memberHandle);
  if (member?.kind === 'ai') {
    const sponsor = memberOf(config, member.sponsor);
    if (sponsor?.kind === 'human') return [sponsor.handle];
  }
  return ownerHandles(config);
}

/**
 * Everything waiting for a human ("Rád vár"): tool permissions, gate decisions, questions.
 * Owns inbox items and their lifecycle, including waiting for an item to close.
 */
export class InboxService {
  private readonly ctx: DomainContext;
  private readonly timeline: TimelineService;
  private readonly projects: ProjectService;
  private readonly integratorTodoAccess?: IntegratorTodoAccess;
  private readonly waiters = new Map<string, (item: InboxItem) => void>();
  private readonly deciders = new Map<InboxDeciderKey, InboxDecider>();
  private readonly resolvingGates = new Map<string, { projectKey: string; gate: GateRequestPayload }>();
  private questionAnswer?: QuestionAnswerer;
  private superOperationAnswer?: SuperOperationAnswer;

  registerQuestionAnswer(answer: QuestionAnswerer): void {
    this.questionAnswer = answer;
  }

  /** The super-mode handoff service takes the owner's yes or no to its question (PM-762). */
  registerSuperOperationAnswer(answer: SuperOperationAnswer): void {
    this.superOperationAnswer = answer;
  }

  private groupAnswer?: QuestionGroupAnswerer;
  registerQuestionGroupAnswer(answer: QuestionGroupAnswerer): void {
    this.groupAnswer = answer;
  }

  private askerStarts?: AskerStarts;

  registerAskerStarts(starts: AskerStarts): void {
    this.askerStarts = starts;
  }

  /** Enrich only visible HTTP results; previews are never stored or sent through websocket events. */
  async withAskerStart(projectKey: string, items: InboxItem[]): Promise<InboxItem[]> {
    const starts = this.askerStarts;
    if (!starts) return items;
    const checks = new Map<string, Promise<TaskStartWaiting['reason'] | null>>();
    return Promise.all(
      items.map(async (item) => {
        if (!isPendingQuestion(item)) return item;
        // The integrator's own question waits for no session (PM-784): it reads the answer back itself.
        if (questionPayloadOf(item)?.externalQuestion) return item;
        try {
          const config = await this.projects.config(projectKey);
          if (memberOf(config, item.source)?.kind !== 'ai') return item;
          const workItem = await starts.answerWorkItem(item);
          const key = JSON.stringify([item.source, workItem]);
          let check = checks.get(key);
          if (!check) {
            check = starts.waitingReason(projectKey, item.source, workItem).catch(() => null);
            checks.set(key, check);
          }
          const reason = await check;
          return reason ? { ...item, askerStart: { reason } } : item;
        } catch {
          return item;
        }
      }),
    );
  }

  /** A later registration for the same key replaces the earlier one. */
  registerDecider(key: InboxDeciderKey, decide: InboxDecider): void {
    this.deciders.set(key, decide);
  }

  resolveMergeRequest(id: string, by: string): void {
    const at = isoNow(this.ctx);
    const item = this.ctx.repos.inbox.close(
      id,
      'resolved',
      this.decisionResolution(id, by, 'merge', null, at),
      at,
    );
    if (item) this.publish(item);
  }

  private readonly resolutionLocks = new KeyedMutex();

  /** Recheck after acquiring: a combine may have changed an individual lock into a primary lock. */
  private questionLock<T>(id: string, action: () => Promise<T>): Promise<T> {
    const key = this.ctx.repos.inbox.groupOf(id)?.primaryItemId ?? id;
    return this.resolutionLocks.run(key, () => {
      const current = this.ctx.repos.inbox.groupOf(id)?.primaryItemId ?? id;
      return current === key ? action() : this.questionLock(id, action);
    });
  }

  async combineQuestions(
    projectKey: string,
    input: { itemIds: string[]; question: string; note: string },
    by: string,
  ) {
    const args = CombineQuestionsRequest.parse(input);
    const config = await this.projects.config(projectKey);
    if (coordinationMemberOf(config)?.handle !== by)
      throw forbidden('project_manager_only', 'only the selected PM combines questions');
    const ids = [...args.itemIds].sort();
    const locked = (index: number): Promise<{ primaryItemId: string; linkedItemIds: string[] }> => {
      const id = ids[index];
      if (id) {
        const row = this.ctx.repos.inbox.get(id);
        const group = this.ctx.repos.inbox.groupOf(id);
        if (
          !row ||
          row.projectKey !== projectKey ||
          row.state !== 'screening' ||
          (group && this.ctx.repos.inbox.get(group.primaryItemId)?.state !== 'screening')
        )
          throw conflict('question_not_screening', 'every question must still be in screening');
        if (group) throw conflict('question_group_incompatible', 'a question already belongs to a group');
        return this.questionLock(id, () => locked(index + 1));
      }
      return Promise.resolve(
        this.ctx.unitOfWork(() => {
          const items = ids.map((itemId) => this.ctx.repos.inbox.get(itemId));
          if (items.some((item) => !item || item.projectKey !== projectKey || item.state !== 'screening'))
            throw conflict('question_not_screening', 'every question must still be in screening');
          const questions = items
            .filter((item): item is InboxItem => item !== null)
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
          const primary = questions[0]!;
          if (
            questions.some((item) => {
              const payload = questionPayloadOf(item);
              return (
                item.kind !== 'question' ||
                !payload?.screening ||
                payload.approvalLabel ||
                payload.screening.todo ||
                isIntegratorTodo(item) ||
                wasIntegratorTodo(item) ||
                APPROVAL_PAYLOAD_KEYS.some((key) => key in item.payload) ||
                this.ctx.repos.inbox.groupOf(item.id) ||
                memberOf(config, item.source)?.kind !== 'ai' ||
                item.source === by ||
                item.assignees.some((handle) => !ownerHandles(config).includes(handle)) ||
                !questionGroupCompatible(primary, item)
              );
            })
          )
            throw conflict(
              'question_group_incompatible',
              'the questions do not ask the same owners for a compatible decision',
            );
          const at = isoNow(this.ctx);
          const itemIds = questions.map((item) => item.id);
          this.ctx.repos.inbox.createGroup({
            ...args,
            projectKey,
            primaryItemId: primary.id,
            itemIds,
            at,
            by,
          });
          const records = questions.map((item) => questionPayloadOf(item)!.screening!);
          const remainingMs = Math.min(
            ...records.map(
              (s) =>
                s.queue?.remainingMs ??
                (s.deliveredAt ? Math.max(0, Date.parse(s.until) - Date.parse(at)) : QUESTION_SCREENING_MS),
            ),
          );
          const deliveredAt = records
            .map((s) => s.deliveredAt)
            .filter((s): s is string => !!s)
            .sort()[0];
          const queue = records.find((s) => s.queue)?.queue;
          const screening = {
            ...questionPayloadOf(primary)!.screening!,
            by,
            until: new Date(Date.parse(at) + remainingMs).toISOString(),
            ...(deliveredAt ? { deliveredAt } : {}),
            ...(queue ? { queue: { ...queue, remainingMs } } : {}),
          };
          this.ctx.repos.inbox.updatePayload(primary.id, { ...primary.payload, screening }, at);
          const groupedTasks = new Set<string | null>();
          for (const item of questions) {
            this.publish(this.ctx.repos.inbox.get(item.id)!);
            if (groupedTasks.has(item.taskKey)) continue;
            groupedTasks.add(item.taskKey);
            this.timeline.append({
              projectKey,
              taskKey: item.taskKey,
              sessionId: item.sessionId,
              actor: aiActor(by),
              type: 'question_grouped',
              data: { primaryItemId: primary.id, itemIds, by },
            });
          }
          return { primaryItemId: primary.id, linkedItemIds: itemIds.slice(1) };
        }),
      );
    };
    return locked(0);
  }

  /** Read-time projection; original questions and the combination audit remain in their own rows. */
  withQuestionGroup(item: InboxItem, known?: QuestionGroup | null): InboxItem {
    const group = known === undefined ? this.ctx.repos.inbox.groupOf(item.id) : known;
    if (!group) return item;
    const primary = this.ctx.repos.inbox.get(group.primaryItemId);
    const originalQuestion = questionPayloadOf(item)?.question ?? item.title;
    const isPrimary = item.id === group.primaryItemId;
    const sources = isPrimary
      ? group.itemIds.flatMap((id) => {
          const source = this.ctx.repos.inbox.get(id);
          if (!source) return [];
          const task = source.taskKey ? this.ctx.repos.tasks.get(source.taskKey) : null;
          const deleted = source.taskKey !== null && !task;
          return [
            {
              itemId: id,
              taskKey: task?.key ?? null,
              taskTitle: task?.title ?? null,
              asker: source.source,
              question: deleted ? null : (questionPayloadOf(source)?.question ?? source.title),
              createdAt: source.createdAt,
              state: deleted
                ? ('deleted' as const)
                : source.state === 'cancelled' || source.payload.groupWithdrawn === true
                  ? ('withdrawn' as const)
                  : ('live' as const),
            },
          ];
        })
      : undefined;
    const { groupWithdrawn: _withdrawn, ...publicPayload } = item.payload;
    return {
      ...item,
      ...(isPrimary
        ? { title: group.question }
        : item.state === 'screening' && primary?.state === 'open'
          ? { state: 'open' as const }
          : {}),
      payload: {
        ...publicPayload,
        group: {
          primaryItemId: group.primaryItemId,
          primaryTaskKey: primary?.taskKey ?? null,
          itemIds: isPrimary ? group.itemIds : [],
          combinedQuestion: isPrimary ? group.question : '',
          originalQuestion,
          ...(isPrimary && item.state === 'resolved'
            ? { answeredCount: this.ctx.repos.inbox.groupAnsweredCount(group.primaryItemId) }
            : {}),
          ...(isPrimary ? { note: group.note, sources } : {}),
        },
      },
    };
  }

  staleOperator(id: string, payload: Record<string, unknown>): void {
    const updated = this.ctx.repos.inbox.updateOperator(
      id,
      payload,
      [OPERATOR_DISMISS_OPTION],
      isoNow(this.ctx),
    );
    if (updated) this.publish(updated);
  }

  /** Close a hand-on item as part of the transaction that actually moved its card. */
  resolveHandOn(id: string, by: string): void {
    // Resolving a human mover's pending request records their decision, even during an administrative move.
    assertOwnOrSuperApproval();
    const at = isoNow(this.ctx);
    const item = this.ctx.repos.inbox.close(
      id,
      'resolved',
      this.decisionResolution(id, by, 'move', null, at),
      at,
    );
    if (item) this.publish(item);
  }

  /** Domain-owned transactions keep the same principal and Operator attribution as inbox.resolve. */
  private decisionResolution(
    id: string,
    by: string,
    optionId: string,
    note: string | null,
    at: string,
  ): NonNullable<InboxItem['resolution']> {
    const scope = integratorExecution();
    if (scope?.principal.mode !== 'super') return { optionId, by, at, note };
    assertOwnOrSuperApproval();
    const item = this.ctx.repos.inbox.get(id)!;
    const config = this.projects.cachedConfig(item.projectKey)!;
    const owner = assertIntegratorAccess(config, 'write', scope.actor);
    if (!owner) throw forbidden('insufficient_access', 'a current project owner is required');
    // The connected Claude answers for its holder only on a direct instruction; a step on a member's
    // queue item does not lend the owner's authority (PM-1010, decision 66).
    if (!hasBoundOrigin(scope.actor) || (hasConnectedOrigin(scope.actor) && scope.actor.kind !== 'human'))
      throw forbidden('owner_approval_required', 'an Operator or connected-Claude origin is required');
    const refusal = this.reservedDecisionRefusal(item, scope.actor);
    if (refusal) throw forbidden(refusal, 'this item requires a person using their own login');
    return this.resolution(
      optionId,
      { handle: owner.handle, access: owner.access, via: 'integrator', superActor: scope.actor },
      at,
      note,
    );
  }

  /**
   * Whether a decision stays reserved to the owner's own login. A connected step is the holder's in person, yet what
   * the connected Claude asked itself (the holder's name is its source) stays reserved, as it was for the old
   * super step.
   */
  private reservedDecisionRefusal(item: InboxItem, actor: Actor): 'owner_approval_required' | null {
    const sessionMember = item.sessionId ? this.ctx.repos.sessions.get(item.sessionId)?.member : null;
    // What the retired Operator asked stays the owner's too (decision 66): its member is gone, its items remain.
    if (item.source === RETIRED_OPERATOR_HANDLE || sessionMember === RETIRED_OPERATOR_HANDLE)
      return 'owner_approval_required';
    return superDecisionRefusal(item, { operatorHandle: actor.handle, sessionMember });
  }

  private resolution(
    optionId: string,
    by: Resolver,
    at: string,
    note: string | null,
    mode: 'decision' | 'relay' | 'todo' = 'decision',
  ): NonNullable<InboxItem['resolution']> {
    return {
      optionId,
      by: by.handle,
      at,
      note,
      ...(by.via || by.superActor ? { via: 'integrator' as const } : {}),
      ...(by.superActor ? { actor: by.superActor } : {}),
      ...(by.superActor && mode === 'decision' ? { superDecision: true as const } : {}),
      ...(mode === 'relay' ? { ownerAnswerRelayed: true as const } : {}),
      ...(mode === 'todo' ? { integratorTodo: true as const, via: 'integrator' as const } : {}),
    };
  }

  constructor(deps: {
    ctx: DomainContext;
    timeline: TimelineService;
    projects: ProjectService;
    integratorTodoAccess?: IntegratorTodoAccess;
  }) {
    this.ctx = deps.ctx;
    this.timeline = deps.timeline;
    this.projects = deps.projects;
    this.integratorTodoAccess = deps.integratorTodoAccess;
  }

  create(input: CreateInboxItemInput): InboxItem {
    if (input.assignees.length === 0)
      throw invalid('no_assignees', 'an inbox item needs at least one assignee');
    const item: InboxItem = {
      id: input.id ?? newId('inb'),
      projectKey: input.projectKey,
      kind: input.kind,
      assignees: [...new Set(input.assignees)],
      source: input.source,
      sessionId: input.sessionId ?? null,
      taskKey: input.taskKey ?? null,
      title: input.title,
      body: input.body ?? null,
      payload: input.payload,
      options: input.options,
      state: input.state ?? 'open',
      resolution: null,
      createdAt: isoNow(this.ctx),
    };
    this.ctx.repos.inbox.insert(item);
    this.publish(item);
    return item;
  }

  /**
   * A new fix round limit decision item (PM-714): addressed to the integrator when one is available (the
   * same `IntegratorTodoAccess` as the todos) and the shape is the narrow delegable one, else to the owners
   * with the reason on the payload. The title, body and options are written in the project's language here.
   * Only a new item is addressed this way; an item that exists is never rewritten. Call it inside the unit of
   * work that also records the hold, so the addressing and the hold stand or fall together.
   */
  createFixLimitDecision(config: ProjectConfig, input: CreateFixLimitDecisionInput): InboxItem {
    const available = input.options
      .map((option) => FixLimitOptionId.safeParse(option.id))
      .flatMap((parsed) => (parsed.success ? [parsed.data] : []));
    const selected = selectFixLimitRecipient(
      {
        kind: 'decision',
        source: 'system',
        taskKey: input.taskKey,
        payload: { fixLimit: input.fixLimit },
        options: input.options,
      },
      this.integratorTodoAccess?.available(config) ?? false,
    );
    const content = formatFixLimitItem(config, input.fixLimit, available, selected.recipient);
    return this.ctx.unitOfWork(() =>
      this.create({
        projectKey: input.projectKey,
        kind: 'decision',
        assignees: input.assignees,
        source: 'system',
        taskKey: input.taskKey,
        title: content.title,
        body: content.body,
        payload: {
          fixLimit: input.fixLimit,
          recipient: selected.recipient,
          ...(selected.recipient === 'integrator' ? { integratorOpenedAt: isoNow(this.ctx) } : {}),
          ...('recipientRefusal' in selected ? { recipientRefusal: selected.recipientRefusal } : {}),
        },
        options: content.options,
      }),
    );
  }

  get(projectKey: string, id: string): InboxItem {
    const item = this.ctx.repos.inbox.get(id);
    if (!item || item.projectKey !== projectKey) throw notFound('inbox item', id);
    return this.withQuestionGroup(item);
  }

  updateOpenPayload(id: string, payload: Record<string, unknown>): InboxItem | null {
    const item = this.ctx.repos.inbox.get(id);
    if (!item || item.state !== 'open') return null;
    const updated = this.ctx.repos.inbox.updateOpen(id, payload, item.assignees, isoNow(this.ctx));
    if (updated) this.publish(updated);
    return updated;
  }

  /**
   * A file was deleted (PM-498): every question that names it, open or answered, marks it gone and is
   * published again. Items that do not name it are not touched.
   */
  attachmentGone(projectKey: string, attachmentId: string, at: string): void {
    for (const item of this.ctx.repos.inbox.listQuestionsWithAttachment(projectKey, attachmentId)) {
      const payload = withQuestionAttachmentGone(item.payload, attachmentId, at);
      if (!payload) continue;
      const updated = this.ctx.repos.inbox.updatePayload(item.id, payload, at);
      if (updated) this.publish(updated);
    }
  }

  list(
    projectKey: string,
    filter: {
      state?: InboxState | readonly InboxState[];
      kind?: InboxKind;
      taskKey?: string;
      limit?: number;
    } = {},
  ) {
    return this.withQuestionGroups(this.ctx.repos.inbox.list(projectKey, filter));
  }

  /** `withQuestionGroup` of many items, the groups read together instead of one by one. */
  private withQuestionGroups(items: InboxItem[]): InboxItem[] {
    const groups = this.ctx.repos.inbox.groupsOf(items.map((item) => item.id));
    return items.map((item) => this.withQuestionGroup(item, groups.get(item.id) ?? null));
  }

  /**
   * The questions the Operator screens or settled without a person (PM-558): in screening now, or answered,
   * forwarded or found moot. Newest first by the Operator's decision (else the asking time), at most
   * `SCREENED_QUESTIONS_LIMIT`; `today` counts all of them asked at or after `since`.
   */
  screenedQuestions(projectKey: string, since: string): ScreenedQuestionsResponse {
    const screened = this.ctx.repos.inbox.screenedQuestions(projectKey, since, SCREENED_QUESTIONS_LIMIT);
    return { items: this.withQuestionGroups(screened.items), today: screened.today };
  }

  /** The decision items of one gate request of a task, oldest first. */
  gateRequestItems(projectKey: string, taskKey: string, requestId: string): InboxItem[] {
    return this.ctx.repos.inbox.listGateRequest(projectKey, taskKey, requestId);
  }

  /** Open decision items requesting to move a task from one stage to another. */
  openGateRequests(projectKey: string, taskKey: string, fromStageId: string, toStageId: string): InboxItem[] {
    return this.ctx.repos.inbox.listOpenGateRequests(projectKey, taskKey, fromStageId, toStageId);
  }

  /** A closed gate decision still owns its move until all resolution listeners have finished. */
  isResolvingGate(projectKey: string, taskKey: string, fromStageId: string, toStageId: string): boolean {
    for (const resolving of this.resolvingGates.values()) {
      const gate = resolving.gate;
      if (
        resolving.projectKey === projectKey &&
        gate.taskKey === taskKey &&
        gate.fromStageId === fromStageId &&
        gate.toStageId === toStageId
      )
        return true;
    }
    return false;
  }

  countOpenFor(projectKey: string, handle: string, viewer?: Parameters<typeof canSeeInboxItem>[0]): number {
    const member = this.projects
      .cachedConfig(projectKey)
      ?.team.members.find((entry) => entry.handle === handle);
    const reader = viewer ?? (member?.kind === 'human' ? { handle, access: member.access } : undefined);
    const mine = this.ctx.repos.inbox
      .listOpenAssigned(projectKey, handle)
      .filter((item) => humanInboxAssignment(item, handle) && (!reader || canSeeInboxItem(reader, item)));
    // A question combined into another one is counted with its primary.
    const groups = this.ctx.repos.inbox.groupsOf(
      mine.filter((item) => item.kind === 'question').map((item) => item.id),
    );
    return mine.filter((item) => (groups.get(item.id)?.primaryItemId ?? item.id) === item.id).length;
  }

  /**
   * Gives an open integrator item to the owners: the integrator's explicit pass-on (`how.actor` is its
   * authenticated super actor, `how.note` the reason). The same item stays open with its payload
   * and options; only the addressing changes. False when it stays.
   */
  private escalateIntegratorItem(
    item: InboxItem,
    config: ProjectConfig,
    how: {
      reason: 'integrator_passed_on' | 'integrator_unavailable';
      actor?: Actor;
      note?: string;
    },
  ): boolean {
    const at = isoNow(this.ctx);
    const reason = how.reason;
    // A fix limit decision goes to the people the card's hold names (the technical direction holders among the
    // owners and admins, else the owners), as it would have if no integrator had been asked.
    const people =
      item.kind === 'decision' ? fixLimitDeciders(config, ownerHandles(config)) : ownerHandles(config);
    const patch = planIntegratorInboxEscalation(item, at, people, reason);
    if (!patch) return false;
    const updated = this.ctx.unitOfWork(() => {
      const row = this.ctx.repos.inbox.updateOpen(
        item.id,
        patch.payload,
        patch.assignees,
        at,
        item.kind === 'decision' ? (bodyForOwners(config, item.body) ?? undefined) : undefined,
      );
      if (!row) return null;
      if (item.kind === 'decision') {
        this.timeline.append({
          projectKey: item.projectKey,
          taskKey: item.taskKey,
          actor: how.actor ?? SYSTEM_ACTOR,
          type: 'fix_limit_recipient_escalated',
          createdAt: at,
          data: {
            inboxItemId: item.id,
            from: 'integrator',
            to: 'owner',
            openedAt: item.payload.integratorOpenedAt as string,
            reason,
            ...(how.note ? { note: how.note } : {}),
          },
        });
        return row;
      }
      this.timeline.append({
        projectKey: item.projectKey,
        taskKey: item.taskKey,
        sessionId: item.sessionId,
        actor: how.actor ?? SYSTEM_ACTOR,
        type: 'question_recipient_escalated',
        createdAt: at,
        data: {
          inboxItemId: item.id,
          asker: item.source,
          from: 'integrator',
          to: 'owner',
          openedAt: questionPayloadOf(item)!.integratorOpenedAt!,
          reason,
          ...(how.note ? { note: how.note } : {}),
        },
      });
      return row;
    });
    if (updated) this.publish(updated);
    return !!updated;
  }

  /**
   * The integrator decides a fix round limit item addressed to it (PM-714), the one approval-free decision it
   * may make. It needs the explicit super credential of a current owner; the item must still be the narrow
   * fix limit shape, addressed to the integrator, and its card must still be held for exactly
   * this item. `replan`, `reassign` and `another_round` close the item in the integrator's name and run the same
   * application as an owner's choice (`inbox_resolved` -> `FixLimitWatch.decided`); `to_owner` gives the
   * same open item to the owners with the reason. Everything is decided under the item's lock, so an
   * owner, a sweep and a double click cannot each decide.
   */
  async resolveIntegratorFixLimit(
    projectKey: string,
    id: string,
    req: ResolveIntegratorFixLimitRequest,
    by: Resolver,
  ): Promise<InboxItem> {
    const parsed = IntegratorFixLimitRequestSchema.safeParse(req);
    if (!parsed.success) throw invalid('invalid_request', 'invalid integrator fix limit decision');
    return this.questionLock(id, async () => {
      const request = parsed.data;
      const item = this.get(projectKey, id);
      const config = await this.projects.config(projectKey);
      assertIntegratorAccess(config, 'write', by.superActor);
      if (integratorExecution()?.principal.mode !== 'super' || !by.superActor)
        throw forbidden(
          'integrator_not_allowed',
          'only an explicit super credential decides an integrator fix limit item',
        );
      if (by.access !== 'owner')
        throw forbidden('insufficient_access', 'a current project owner is required');
      if (item.state !== 'open') throw conflict('inbox_item_closed', `inbox item ${id} is ${item.state}`);
      if (!isIntegratorFixLimitDecision(item))
        throw forbidden('super_relay_refused', 'only a current integrator fix limit decision may be decided');
      const record = item.taskKey ? this.ctx.repos.taskFixLimits.get(item.taskKey) : null;
      if (!record || record.inboxItemId !== id || record.holdPhase !== 'owner')
        throw conflict('fix_limit_not_held', `${item.taskKey} is not held for this fix limit decision`);
      const note = request.note?.trim() ? request.note.trim() : null;
      if (request.optionId === 'to_owner') {
        if (!note) throw invalid('invalid_request', 'say why the owners must decide', { field: 'note' });
        const moved = this.escalateIntegratorItem(item, config, {
          reason: 'integrator_passed_on',
          actor: attributedActor(by),
          note,
        });
        if (!moved) throw forbidden('super_relay_refused', 'the item cannot be handed to the owners');
        return this.get(projectKey, id);
      }
      if (!item.options.some((option) => option.id === request.optionId))
        throw invalid('unknown_option', `unknown option: ${request.optionId}`);
      const at = isoNow(this.ctx);
      const resolved = this.ctx.unitOfWork(() =>
        this.ctx.repos.inbox.close(
          id,
          'resolved',
          {
            optionId: request.optionId,
            by: by.handle,
            at,
            note,
            via: 'integrator',
            actor: by.superActor,
            integratorFixLimit: true,
          },
          at,
        ),
      );
      if (!resolved) throw conflict('inbox_item_closed', `inbox item ${id} is no longer open`);
      this.publish(resolved);
      this.waiters.get(id)?.(resolved);
      await this.ctx.events.emit('inbox_resolved', resolved);
      return resolved;
    });
  }

  async resolveIntegratorTodo(
    projectKey: string,
    id: string,
    req: ResolveIntegratorTodoRequest,
    by: Resolver,
  ): Promise<InboxItem> {
    const parsed = IntegratorTodoRequestSchema.safeParse(req);
    if (!parsed.success) throw invalid('invalid_request', 'invalid integrator todo result');
    return this.questionLock(id, () => this.resolveLocked(projectKey, id, parsed.data, by, true));
  }

  /**
   * Gives every open integrator item (todos and the narrow fix limit decisions) to the owners when no owner
   * has a live super key (PM-1045): the owner's connected client works them, and without one nobody does.
   */
  async sweepIntegratorTodos(): Promise<void> {
    const open = [...this.ctx.repos.inbox.listOpen('question'), ...this.ctx.repos.inbox.listOpen('decision')];
    for (const candidate of open) {
      if (!isIntegratorInboxItem(candidate)) continue;
      try {
        await this.questionLock(candidate.id, async () => {
          const config = await this.projects.config(candidate.projectKey);
          if (this.integratorTodoAccess?.available(config) ?? false) return;
          const current = this.ctx.repos.inbox.get(candidate.id);
          if (current) this.escalateIntegratorItem(current, config, { reason: 'integrator_unavailable' });
        });
      } catch (error) {
        this.ctx.logger.warn({ error, itemId: candidate.id }, 'integrator_todo_sweep_failed');
      }
    }
  }

  openPermissionOf(projectKey: string, sessionId: string): InboxItem | null {
    return (
      this.ctx.repos.inbox
        .listOpen('permission')
        .filter((item) => item.projectKey === projectKey && item.sessionId === sessionId)
        .at(-1) ?? null
    );
  }

  /**
   * A human picks an option. Only assignees may resolve; owners may also answer permission
   * requests and questions, but gate decisions belong to the named approvers only.
   */
  async resolve(projectKey: string, id: string, req: ResolveInboxRequest, by: Resolver): Promise<InboxItem> {
    return this.questionLock(id, () => this.resolveLocked(projectKey, id, req, by));
  }

  private async resolveLocked(
    projectKey: string,
    id: string,
    req: ResolveInboxRequest,
    by: Resolver,
    integratorTodo = false,
  ): Promise<InboxItem> {
    const item = this.get(projectKey, id);
    const initialConfig = await this.projects.config(projectKey);
    const principalOwner = assertIntegratorAccess(initialConfig, 'write', by.superActor);
    const superScope = integratorExecution()?.principal.mode === 'super';
    if (superScope) {
      assertOwnOrSuperApproval(by);
      if (!principalOwner || principalOwner.handle !== by.handle)
        throw forbidden('insufficient_access', 'the resolver must be the authenticated owner');
      by = { ...by, handle: principalOwner.handle, access: principalOwner.access, via: 'integrator' };
    }
    if (integratorTodo) {
      if (integratorExecution()?.principal.mode !== 'super' || !by.superActor)
        throw forbidden(
          'integrator_not_allowed',
          'only an explicit super credential resolves an integrator todo',
        );
      if (by.access !== 'owner')
        throw forbidden('insufficient_access', 'a current project owner is required');
      if (item.state !== 'open') throw conflict('inbox_item_closed', 'the inbox item is closed');
      if (hasProtectedQuestionPayload(item))
        throw forbidden('owner_approval_required', 'only a person may approve');
      if (!isIntegratorTodo(item))
        throw forbidden('super_relay_refused', 'only a current integrator todo may be resolved');
      if (req.optionId !== 'todo_done' && req.optionId !== 'todo_cannot')
        throw invalid('invalid_request', 'only todo result options are accepted');
    } else if (
      isIntegratorInboxItem(item) &&
      (by.via || by.superActor || integratorExecution() || by.access !== 'owner')
    ) {
      throw forbidden(
        'super_relay_refused',
        'an integrator item needs the dedicated super endpoint or the owner login',
      );
    }
    if (item.kind === 'permission') assertOwnApproval(by);
    else if (!['question', 'alert'].includes(item.kind)) assertOwnOrSuperApproval(by);
    if (req.attachmentIds !== undefined && item.kind !== 'question')
      throw invalid('invalid_request', 'only questions accept attachments', { field: 'attachmentIds' });
    if (
      by.via &&
      !['question', 'alert'].includes(item.kind) &&
      (!by.superActor || item.kind === 'permission')
    )
      throw forbidden(
        'owner_approval_required',
        'Only the owner may give this approval using their own login',
        { kind: item.kind },
      );
    if (item.state !== 'open')
      throw conflict('inbox_item_closed', `inbox item ${id} is ${item.state}`, { id, state: item.state });
    // The owner's question about a super operation (PM-762) is answered by their own login only: neither a
    // token, nor the integrator's relay, nor anyone but an owner closes it.
    const superOperation = item.kind === 'question' ? questionPayloadOf(item)?.superOperation : undefined;
    if (superOperation && (by.via || by.superActor || by.access !== 'owner'))
      throw forbidden('owner_approval_required', 'Only the owner may decide this, using their own login', {
        kind: item.kind,
      });
    // A question the integrator asked itself (PM-784) is answered by an owner's own login: neither a token nor
    // the integrator, in any mode, closes it, including by a direct core call.
    const asked = item.kind === 'question' ? item.payload : null;
    const askedRefusal = asked
      ? externalQuestionAnswerRefusal(asked, {
          via: by.via ?? (integratorExecution() ? 'integrator' : undefined),
          superActor: by.superActor,
        })
      : null;
    if (askedRefusal)
      throw forbidden(
        superScope ? 'owner_approval_required' : askedRefusal,
        askedRefusal === 'super_relay_refused'
          ? 'The integrator cannot answer its own question'
          : 'Only the owner may decide this, using their own login',
      );
    // Every pending group member must be decidable; only an entirely relayable group is an information relay.
    let relayed = false;
    if (superScope) {
      // A connected step on a member's queue item is named for the issuer, so it relays nothing for the holder.
      if (hasConnectedOrigin(by.superActor) && by.superActor!.kind !== 'human')
        throw forbidden('owner_approval_required', 'this item requires a person using their own login');
      const group = this.ctx.repos.inbox.groupOf(id);
      const members = [
        item,
        ...(group?.itemIds ?? []).flatMap((memberId) => {
          const row = this.ctx.repos.inbox.get(memberId);
          return row && row.id !== id && isPendingQuestion(row) ? [row] : [];
        }),
      ];
      for (const member of members) {
        const refusal = this.reservedDecisionRefusal(member, by.superActor!);
        const question = member.kind === 'question' ? member.payload : null;
        if (refusal || (question && externalQuestionAnswerRefusal(question, by)))
          throw forbidden('owner_approval_required', 'this item requires a person using their own login');
      }
      relayed = !integratorTodo && members.every(isRelayableQuestionItem);
    }
    if (operatorApprovalOf(item)) throw conflict('inbox_item_closed', 'Operator approvals have been retired');
    if (operatorKnowledgeApprovalOf(item)?.stale && req.optionId !== 'dismiss')
      throw conflict('operator_knowledge_stale', 'the knowledge proposal is stale; dismiss it');
    if (!item.options.some((o) => o.id === req.optionId)) {
      throw invalid('unknown_option', `unknown option: ${req.optionId}`);
    }
    const config = await this.projects.config(projectKey);
    if (memberOf(config, by.handle)?.kind !== 'human')
      throw forbidden('ai_approval_forbidden', 'only human members may resolve inbox items');
    const gate = item.kind === 'decision' && req.optionId === 'approve' ? gateRequestOf(item) : null;
    if (gate?.label) {
      // Approving puts the label on in the approver's name: the label rules apply up front.
      const task = item.taskKey ? this.ctx.repos.tasks.get(item.taskKey) : null;
      const refusal = approvalRefusal(config, gate.label, by.handle, task);
      if (refusal) throw forbidden(refusal, APPROVAL_REFUSALS[refusal]);
    }
    if (!canResolveInboxItem(by, item))
      throw forbidden('not_an_assignee', 'only the assignees may resolve this item');
    const note = req.note?.trim() ? req.note.trim() : null;
    if (
      item.kind === 'question' &&
      req.optionId === ANSWER_OPTION.id &&
      !note &&
      !req.attachmentIds?.length
    ) {
      throw invalid('answer_required', 'a free-text answer needs a note');
    }
    if (item.kind === 'question' && req.optionId === TODO_CANNOT_OPTION.id && !note)
      throw invalid('todo_reason_required', 'say why the task cannot be done');
    if (item.kind === 'merge_request') {
      const decide = this.deciders.get('merge_request');
      if (!decide) throw conflict('inbox_item_closed', 'the merge request is no longer available');
      await decide(item, by, req.optionId, note);
      const resolved = this.get(projectKey, id);
      await this.ctx.events.emit('inbox_resolved', resolved);
      return resolved;
    }
    if (item.kind === 'release') throw conflict('inbox_item_closed', 'release approvals have been retired');
    if (item.kind === 'hand_on') {
      const decide = this.deciders.get('hand_on');
      if (!handOnRequestOf(item) || !decide)
        throw conflict('inbox_item_closed', 'the hand-on request is no longer available');
      // The move closes the item in its own transaction; a refused move leaves it open.
      await decide(item, by, req.optionId, note);
      const resolved = this.get(projectKey, id);
      await this.ctx.events.emit('inbox_resolved', resolved);
      return resolved;
    }
    if (operatorKnowledgeApprovalOf(item)) {
      const decide = this.deciders.get('operator_knowledge');
      if (!decide) throw forbidden('operator_owner_only', 'Operator knowledge decisions are unavailable');
      await decide(item, by, req.optionId, note);
      const resolved = this.get(projectKey, id);
      await this.ctx.events.emit('inbox_resolved', resolved);
      return resolved;
    }
    if (emailApprovalOf(item)) {
      const decide = this.deciders.get('email');
      if (!decide) throw conflict('inbox_item_closed', 'e-mail decisions are unavailable');
      await decide(item, by, req.optionId, note);
      const resolved = this.get(projectKey, id);
      await this.ctx.events.emit('inbox_resolved', resolved);
      return resolved;
    }
    if (structuralReviewOf(item)) {
      const decide = this.deciders.get('operator_structural_review');
      if (!decide) throw forbidden('owner_approval_required', 'structural review decisions are unavailable');
      await decide(item, by, req.optionId, note);
    }
    const at = isoNow(this.ctx);
    const resolution = this.resolution(
      req.optionId,
      by,
      at,
      note,
      integratorTodo ? 'todo' : relayed ? 'relay' : 'decision',
    );
    const group = this.ctx.repos.inbox.groupOf(id);
    if (group) {
      if (id !== group.primaryItemId || !this.groupAnswer)
        throw conflict('question_group_incompatible', 'answer the primary question');
      const members = group.itemIds.flatMap((memberId) => {
        const row = this.ctx.repos.inbox.get(memberId);
        return row && isPendingQuestion(row) ? [row] : [];
      });
      const answered: InboxItem[] = [];
      const closeGroup = () => {
        assertIntegratorAccess(this.projects.cachedConfig(projectKey) ?? config, 'write', by.superActor);
        for (const row of members) {
          const resolved = this.ctx.repos.inbox.close(row.id, 'resolved', resolution, at);
          if (!resolved) throw conflict('inbox_item_closed', 'a group member is no longer pending');
          answered.push(resolved);
          this.publish(resolved);
          this.timeline.append({
            projectKey,
            taskKey: row.taskKey,
            sessionId: row.sessionId,
            actor: attributedActor(by),
            type: 'question_answered',
            data: { inboxItemId: row.id, answer: answerText(resolved), groupPrimaryItemId: id },
          });
        }
        if (!members.some((member) => member.id === id)) {
          const representative = this.ctx.repos.inbox.close(id, 'resolved', resolution, at);
          if (representative) this.publish(representative);
        }
      };
      let committed = false;
      const recipients = new Set(questionGroupLiveItemIds(questionPayloadOf(item)!.group!));
      await this.groupAnswer(
        members
          .filter((row) => recipients.has(row.id))
          .map((row) => ({ ...row, state: 'resolved', resolution })),
        req.attachmentIds ?? [],
        () => {
          closeGroup();
          committed = true;
        },
      ).finally(async () => {
        // A failed transaction rolls back the rows too; dispatch failures must still release the labels.
        if (committed && this.ctx.repos.inbox.get(id)?.state === 'resolved') {
          this.publish(this.ctx.repos.inbox.get(id)!);
          for (const row of answered) await this.ctx.events.emit('inbox_resolved', row);
        }
      });
      return this.get(projectKey, id);
    }
    const close = (): InboxItem => {
      assertIntegratorAccess(this.projects.cachedConfig(projectKey) ?? config, 'write', by.superActor);
      if (superOperation) {
        if (!this.superOperationAnswer)
          throw conflict('inbox_item_closed', 'the super operation is no longer available');
        this.superOperationAnswer(item, req.optionId, at, by.handle);
      }
      const resolved = this.ctx.repos.inbox.close(id, 'resolved', resolution, at);
      if (!resolved) throw conflict('inbox_item_closed', `inbox item ${id} is no longer open`);
      this.publish(resolved);

      if (resolved.kind === 'permission') {
        this.timeline.append({
          projectKey,
          taskKey: resolved.taskKey,
          sessionId: resolved.sessionId,
          actor: attributedActor(by),
          type: 'permission_resolved',
          data: {
            inboxItemId: id,
            decision: req.optionId === 'deny' ? 'deny' : 'allow',
            optionId: req.optionId,
          },
        });
      } else if (resolved.kind === 'question') {
        this.timeline.append({
          projectKey,
          taskKey: resolved.taskKey,
          sessionId: resolved.sessionId,
          actor: by.superActor ? attributedActor(by) : humanActor(by.handle),
          type: 'question_answered',
          data: {
            inboxItemId: id,
            answer: answerText(resolved),
            ...(integratorTodo
              ? { integratorTodo: { optionId: req.optionId as 'todo_done' | 'todo_cannot', note } }
              : {}),
          },
        });
      }
      return resolved;
    };
    const answered =
      item.kind === 'question' && this.questionAnswer && !superOperation
        ? await this.questionAnswer(
            { ...item, state: 'resolved', resolution },
            req.attachmentIds ?? [],
            close,
          )
        : null;
    if (!answered && req.attachmentIds?.length)
      throw invalid('invalid_request', 'only AI questions accept attachments', { field: 'attachmentIds' });
    const resolvingGate = item.kind === 'decision' ? gateRequestOf(item) : null;
    if (resolvingGate) this.resolvingGates.set(id, { projectKey, gate: resolvingGate });
    try {
      const resolved = answered ?? this.ctx.unitOfWork(close);

      this.waiters.get(id)?.(resolved);
      await this.ctx.events.emit('inbox_resolved', resolved);
      return resolved;
    } finally {
      if (resolvingGate) this.resolvingGates.delete(id);
    }
  }

  /**
   * An AI decider answers a question delegated to it (PM-169). The one way an AI member decides an
   * inbox item, and only a permission item whose delegation still waits for it (see
   * `canDecidePermission`): never a gate decision, never a question of a person's. `allow` and `deny`
   * close the item in the decider's name, with its reason, and answer the waiting CLI; `escalate` hands
   * the item to the sponsor or the owners, still open. A late answer is refused.
   */
  async resolveDelegated(
    projectKey: string,
    id: string,
    handle: string,
    req: { decision: DelegatedPermissionDecision; reason: string },
  ): Promise<InboxItem> {
    assertOwnApproval();
    const reason = req.reason.trim();
    if (!reason) throw invalid('invalid_request', 'a decision about a delegated request needs a reason');
    const config = await this.projects.config(projectKey);
    let item = this.get(projectKey, id);
    const delegation = item.kind === 'permission' ? permissionDelegationOf(item) : null;
    if (!delegation)
      throw forbidden(
        'ai_approval_forbidden',
        'an AI member decides only a request delegated to it as the decider',
      );
    if (item.state !== 'open')
      throw conflict('inbox_item_closed', `inbox item ${id} is ${item.state}`, { id, state: item.state });
    item = this.refreshDelegation(item, config);
    const current = permissionDelegationOf(item)!;
    if (!canDecidePermission(config, item.source, current, handle, this.ctx.now().getTime()))
      throw forbidden(
        'not_an_assignee',
        'not a live decider of this request, or its deadline has passed: a person decides it now',
      );
    const actor = aiActor(handle);
    const { decision } = req;
    if (decision === 'escalate')
      return this.escalateDelegated(item, config, { actor, cause: 'lead', reason });

    const at = isoNow(this.ctx);
    // The sponsor and the owners also see what was decided, in their list of recent items.
    const assignees = [...new Set([...item.assignees, ...sponsorOrOwners(config, item.source)])];
    const resolved = this.ctx.unitOfWork(() => {
      this.ctx.repos.inbox.updateOpen(id, item.payload, assignees, at);
      const closed = this.ctx.repos.inbox.close(
        id,
        'resolved',
        { optionId: decision, by: handle, at, note: reason },
        at,
      );
      if (!closed) throw conflict('inbox_item_closed', `inbox item ${id} is no longer open`);
      this.publish(closed);
      this.timeline.append({
        projectKey,
        taskKey: closed.taskKey,
        sessionId: closed.sessionId,
        actor,
        type: 'permission_resolved',
        data: {
          inboxItemId: id,
          decision,
          optionId: decision,
          delegated: true,
          reason: excerpt(reason, 500),
        },
      });
      return closed;
    });
    this.waiters.get(id)?.(resolved);
    await this.ctx.events.emit('inbox_resolved', resolved);
    return resolved;
  }

  /**
   * Hands the delegated questions whose time is up to a person: the deadline passed, delegation was
   * switched off, or no chosen decider is at work any more. Run on a timer and when the configuration
   * changes. Never an allowance: the hook keeps waiting for the person.
   */
  async sweepDelegations(): Promise<void> {
    for (const item of this.ctx.repos.inbox.listOpen('permission')) {
      const delegation = permissionDelegationOf(item);
      if (delegation?.state !== 'pending_lead') continue;
      try {
        this.refreshDelegation(item, await this.projects.config(item.projectKey));
      } catch {
        // The next sweep retries; one unavailable project never holds up another's deadline.
        this.ctx.logger.warn({ itemId: item.id }, 'permission delegation refresh failed');
      }
    }
  }

  /** The item after a due delegation was handed to a person (unchanged when it is not due). */
  private refreshDelegation(item: InboxItem, config: ProjectConfig): InboxItem {
    const delegation = permissionDelegationOf(item);
    if (item.state !== 'open' || delegation?.state !== 'pending_lead') return item;
    if (
      permissionDelegationState(config, item.source, delegation, this.ctx.now().getTime()) === 'pending_lead'
    )
      return item;
    // Before the deadline no decider is at work any more; after it, a question no decider ever got ran out of
    // delivery time and one a decider had ran out of its own.
    const overdue = this.ctx.now().getTime() >= Date.parse(delegation.leadDeadline);
    return this.escalateDelegated(item, config, {
      actor: SYSTEM_ACTOR,
      cause: !overdue ? 'unavailable' : delegation.deliveredAt ? 'timeout' : 'undelivered',
    });
  }

  /**
   * The first time the question reached a decider's session (PM-926): from now on the decider has its own
   * time (`leadTimeoutSeconds`), at most until `PERMISSION_LEAD_CAP_MS` after the question came, so a person
   * still has time before the requester's hook gives up. Runs in the delivering transaction; later
   * deliveries change nothing.
   */
  recordDelegationDelivered(id: string, at: string): void {
    const item = this.ctx.repos.inbox.get(id);
    const delegation = item ? permissionDelegationOf(item) : null;
    if (!item || item.state !== 'open' || delegation?.state !== 'pending_lead' || delegation.deliveredAt)
      return;
    const updated = this.ctx.repos.inbox.updateOpen(
      id,
      {
        ...item.payload,
        delegation: {
          ...delegation,
          deliveredAt: at,
          leadDeadline: this.deliveredDeadline(item, at),
        },
      },
      item.assignees,
      at,
    );
    if (updated) this.publish(updated);
  }

  private deliveredDeadline(item: InboxItem, deliveredAt: string): string {
    return deliveredLeadDeadline({
      deliveredAt,
      leadTimeoutSeconds: (
        this.projects.cachedConfig(item.projectKey)?.team.boundary ?? TEAM_SETTING_POLICY.boundary.default
      ).leadTimeoutSeconds,
      capAt: new Date(Date.parse(item.createdAt) + PERMISSION_LEAD_CAP_MS).toISOString(),
    });
  }

  /** Whether the delegated question still waits for `handle` to decide it (the member queue's item is owed). */
  delegationWaitsFor(id: string, handle: string): boolean {
    const item = this.ctx.repos.inbox.get(id);
    const delegation = item ? permissionDelegationOf(item) : null;
    return (
      item?.state === 'open' && delegation?.state === 'pending_lead' && delegation.leads.includes(handle)
    );
  }

  /**
   * The text that wakes an AI decider of the question. The deadline in it is the one the decider will have
   * once it has the text, not the delivery limit that holds until then.
   */
  delegatedPromptOf(id: string): string | null {
    const item = this.ctx.repos.inbox.get(id);
    const delegation = item ? permissionDelegationOf(item) : null;
    if (!item || item.kind !== 'permission' || !delegation) return null;
    return delegatedPermissionPrompt(
      item,
      delegation.deliveredAt ? delegation.leadDeadline : this.deliveredDeadline(item, isoNow(this.ctx)),
    );
  }

  /**
   * Hands a question to a person because its decider cannot be reached (`unavailable`: it can never be
   * started) or never answered (`timeout`: it was started in vain). No-op when it is not waiting for one.
   */
  async escalateUnreached(projectKey: string, id: string, cause: 'unavailable' | 'timeout'): Promise<void> {
    const item = this.ctx.repos.inbox.get(id);
    if (!item || item.projectKey !== projectKey || item.state !== 'open') return;
    if (permissionDelegationOf(item)?.state !== 'pending_lead') return;
    this.escalateDelegated(item, await this.projects.config(projectKey), { actor: SYSTEM_ACTOR, cause });
  }

  private escalateDelegated(
    item: InboxItem,
    config: ProjectConfig,
    by: { actor: Actor; cause: 'lead' | 'timeout' | 'undelivered' | 'unavailable'; reason?: string },
  ): InboxItem {
    const delegation = permissionDelegationOf(item)!;
    const assignees = sponsorOrOwners(config, item.source);
    return this.ctx.unitOfWork(() => {
      const updated = this.ctx.repos.inbox.updateOpen(
        item.id,
        {
          ...item.payload,
          delegation: {
            ...delegation,
            state: 'pending_owner',
            escalation: {
              cause: by.cause,
              by: by.actor.handle ?? 'system',
              ...(by.reason ? { reason: excerpt(by.reason, 500) } : {}),
            },
          },
        },
        assignees,
        isoNow(this.ctx),
      );
      if (!updated) return item;
      this.publish(updated);
      this.timeline.append({
        projectKey: item.projectKey,
        taskKey: item.taskKey,
        sessionId: item.sessionId,
        actor: by.actor,
        type: 'permission_escalated',
        data: {
          inboxItemId: item.id,
          cause: by.cause,
          assignees,
          ...(by.reason ? { reason: excerpt(by.reason, 500) } : {}),
        },
      });
      return updated;
    });
  }

  /**
   * The system resolves an open item by a rule, because what it asked about is over (`loop_ended`);
   * null when it is not open. No decision was made, so `inbox_resolved` is not emitted.
   */
  resolveByRule(id: string, optionId: string, rule: InboxResolutionRule): InboxItem | null {
    const at = isoNow(this.ctx);
    const resolved = this.ctx.repos.inbox.close(
      id,
      'resolved',
      { optionId, by: 'system', at, note: null, rule },
      at,
    );
    if (!resolved) return null;
    this.publish(resolved);
    this.waiters.get(id)?.(resolved);
    return resolved;
  }

  /**
   * Closes a question that still waits for its answer (open, or with the Operator for screening) because
   * nothing is left to answer (PM-556): `cancelled`, resolved by `by` with the rule. Null when the item is
   * not a pending question. The timeline records `question_closed`; the asking member's running session is
   * told by the `inbox_cancelled` listener (`SessionMessages.closedNotice`).
   */
  closeQuestion(
    id: string,
    close: {
      rule: QuestionCloseRule;
      by: string;
      note: string | null;
      /** The Operator found the question moot (PM-558): the screening record keeps the outcome too. */
      screened?: ScreeningSettlement;
      /**
       * The full actor when the question is closed through the integrator (PM-784): the resolution keeps its
       * `via` and origin, and the timeline records it; `by` stays the handle.
       */
      actor?: Actor;
    },
  ): Promise<InboxItem | null> {
    return this.questionLock(id, async () => {
      const current = this.ctx.repos.inbox.get(id);
      if (!current || !isPendingQuestion(current)) return null;
      const group = this.ctx.repos.inbox.groupOf(id);
      const otherLive =
        group?.itemIds.some((otherId) => {
          const other = otherId !== id ? this.ctx.repos.inbox.get(otherId) : null;
          return !!other && isPendingQuestion(other);
        }) ?? false;
      const primaryWithdrawal = group?.primaryItemId === id;
      const at = isoNow(this.ctx);
      const closed = this.ctx.unitOfWork(() => {
        const resolution = {
          optionId: 'closed',
          by: close.by,
          at,
          note: close.note,
          rule: close.rule,
          ...(close.actor?.via ? { via: close.actor.via } : {}),
          ...(close.actor && hasBoundOrigin(close.actor) ? { actor: close.actor } : {}),
        };
        if (primaryWithdrawal)
          this.ctx.repos.inbox.updatePayload(id, { ...current.payload, groupWithdrawn: true }, at);
        let item =
          primaryWithdrawal && otherLive
            ? { ...current, state: 'cancelled' as const, resolution }
            : this.ctx.repos.inbox.close(
                id,
                'cancelled',
                { ...resolution, ...(primaryWithdrawal ? { rule: 'group_withdrawn' as const } : {}) },
                at,
              );
        if (!item) return null;
        if (close.screened) {
          if (!primaryWithdrawal)
            item =
              this.ctx.repos.inbox.updatePayload(
                id,
                withScreening(
                  current.payload,
                  { outcome: close.screened.outcome, by: close.screened.by, at, note: close.screened.note },
                  at,
                ),
                at,
              ) ?? item;
          this.appendScreened(item, close.screened);
        }
        this.publish(primaryWithdrawal ? this.ctx.repos.inbox.get(id)! : item);
        if (group && !primaryWithdrawal) {
          if (!otherLive) {
            const representative = this.ctx.repos.inbox.close(
              group.primaryItemId,
              'cancelled',
              { optionId: 'closed', by: 'system', at, note: null, rule: 'group_withdrawn' },
              at,
            );
            if (representative) this.publish(representative);
          } else this.publish(this.ctx.repos.inbox.get(group.primaryItemId)!);
        }
        this.timeline.append({
          projectKey: item.projectKey,
          taskKey: item.taskKey,
          sessionId: item.sessionId,
          actor: close.actor ?? (close.by === 'system' ? SYSTEM_ACTOR : aiActor(close.by)),
          type: 'question_closed',
          data: { inboxItemId: item.id, asker: item.source, rule: close.rule, note: close.note },
        });
        return item;
      });
      if (!closed) return null;
      this.waiters.get(id)?.(closed);
      await this.ctx.events.emit('inbox_cancelled', closed);
      return closed;
    });
  }

  /**
   * The payload, options and recipient a question has when it goes to the people (PM-558): the one rule of
   * `releaseScreened` and of the todo the system opens itself (`openIntegratorTodo`). The machine access that
   * counts is the one of `machineTodoIssuerOf`: the screening member, or the opener of its own todo.
   * With a `decider` (PM-1139), a todo no integrator can take is not opened: the result has `forwardTo` and a
   * payload that records the forward (the item stays the owners' by assignment and `recipient`).
   */
  private releaseFields(
    current: InboxItem,
    release: ScreeningRelease,
    config: ProjectConfig,
    at: string,
    decider: string | null,
  ) {
    const { outcome, fallback } = release;
    const route: TodoRoute =
      outcome === 'todo'
        ? selectTodoRecipient(current, release.todo!.recipient, {
            integratorAvailable: this.integratorTodoAccess?.available(config) ?? false,
            issuerAllowed: machineTodoIssuerAllowed(config, machineTodoIssuerOf(current.source, release.by)),
            decider,
          })
        : { recipient: 'owner' };
    const forwardTo = route.recipient === 'decider' ? route.decider : null;
    const selected = route.recipient === 'decider' ? { recipient: 'owner' as const } : route;
    const todo = release.todo
      ? { ...release.todo, recipient: forwardTo ? release.todo.recipient : selected.recipient }
      : undefined;
    const payload = withScreening(
      {
        ...current.payload,
        recipient: selected.recipient,
        ...(selected.recipient === 'integrator' ? { integratorOpenedAt: at } : {}),
      },
      {
        at,
        ...(outcome ? { outcome } : {}),
        ...(release.by ? { by: release.by } : {}),
        ...(release.note ? { note: release.note } : {}),
        ...(todo ? { todo } : {}),
        ...(forwardTo ? { forwardedTo: forwardTo } : {}),
        ...(release.feedbackId !== undefined ? { feedbackId: release.feedbackId } : {}),
        ...('recipientRefusal' in route ? { recipientRefusal: route.recipientRefusal } : {}),
        ...(fallback ? { fallback } : {}),
      },
      at,
    );
    const options = outcome === 'todo' ? [TODO_DONE_OPTION, TODO_CANNOT_OPTION] : current.options;
    return { selected, forwardTo, todo, payload, options };
  }

  /**
   * The system opens a todo for the integrator itself (PM-806): nobody asked it, so `askedBy` (`system`, or the
   * project manager's handle) is the item's source and no answer is delivered to anyone. It takes the screening's
   * todo path (`releaseFields`), but opens at once, without the Operator. When the integrator cannot take it
   * (`recipientRefusal`), the owners get it. It sets no waiting label. The obligation's id is on the payload, so
   * a todo whose row was not written (a crash) is found again.
   */
  async openIntegratorTodo(input: {
    projectKey: string;
    taskKey: string | null;
    askedBy: string;
    question: string;
    todo: QuestionTodo;
    obligation?: ObligationRef;
  }): Promise<{
    itemId: string;
    recipient: QuestionRecipient;
    recipientRefusal: QuestionRecipientRefusal | null;
  }> {
    const config = await this.projects.config(input.projectKey);
    const owners = ownerHandles(config);
    if (owners.length === 0) throw invalid('no_assignees', 'the project has no owner to give a todo to');
    const at = isoNow(this.ctx);
    const draft: InboxItem = {
      id: newId('inb'),
      projectKey: input.projectKey,
      kind: 'question',
      assignees: owners,
      source: input.askedBy,
      sessionId: null,
      taskKey: input.taskKey,
      title: input.question,
      body: null,
      payload: {
        question: input.question,
        requestedRecipient: 'integrator',
        recipient: 'owner',
        ...(input.obligation ? { obligation: input.obligation } : {}),
      },
      options: [],
      state: 'open',
      resolution: null,
      createdAt: at,
    };
    const { selected, payload, options } = this.releaseFields(
      draft,
      { outcome: 'todo', by: 'system', todo: { ...input.todo, recipient: 'integrator' } },
      config,
      at,
      // Nobody asked: the owners keep a todo the system opened itself (PM-1139).
      null,
    );
    const item = this.create({
      id: draft.id,
      projectKey: draft.projectKey,
      kind: 'question',
      assignees: owners,
      source: draft.source,
      taskKey: draft.taskKey,
      title: draft.title,
      payload,
      options,
    });
    return {
      itemId: item.id,
      recipient: selected.recipient,
      recipientRefusal: 'recipientRefusal' in selected ? (selected.recipientRefusal ?? null) : null,
    };
  }

  /**
   * The obligation an integrator todo handed over was fulfilled or cancelled (PM-806): the todo closes with the
   * rule `obligation_closed`, as the one `closeQuestion` branch of every question closed by the system. Nothing
   * happens when it is closed already.
   */
  async closeObligationTodo(itemId: string, _at: string): Promise<void> {
    await this.closeQuestion(itemId, { rule: 'obligation_closed', by: 'system', note: null });
  }

  /**
   * The case of a system signal ended (PM-455): the pending questions asked about it (`payload.signalId`) close
   * with the rule `signal_resolved`, nothing is left to answer. Works for any signal kind.
   */
  async closeQuestionsOfSignal(projectKey: string, signalId: string): Promise<void> {
    for (const item of this.ctx.repos.inbox.list(projectKey, {
      state: PENDING_INBOX_STATES,
      kind: 'question',
    }))
      if ((item.payload as { signalId?: string }).signalId === signalId)
        await this.closeQuestion(item.id, { rule: 'signal_resolved', by: 'system', note: null });
  }

  /**
   * The question leaves the Operator's screening for the people (PM-558): it opens, with the Operator's
   * outcome (`decision`: a person decides; `todo`: a person does something, the options become Done and
   * Cannot do it) or, with no outcome, because the system gave up waiting (`fallback`). Null when the item
   * is not in screening any more (closed or released meanwhile). The timeline records `question_screened`,
   * or `question_screening_skipped` for a fallback. A todo no integrator can take goes to the project's
   * technical decider when `forward` is given (PM-1139): the item does not open, it closes as forwarded in the
   * transaction of the message `forward` sends (`inbox_resolved` follows, as for `settleScreened`). Without
   * `forward`, or without a decider, it opens for the owners with the `recipientRefusal`.
   */
  releaseScreened(
    id: string,
    release: ScreeningRelease,
    forward?: (item: InboxItem, to: string, close: () => InboxItem) => Promise<InboxItem | null>,
  ): Promise<InboxItem | null> {
    if (release.outcome === 'todo' && !ScreeningTodoSchema.safeParse(release.todo).success)
      throw invalid('invalid_outcome_fields', 'todo needs valid what, where, expected and recipient fields');
    const primaryId = this.ctx.repos.inbox.groupOf(id)?.primaryItemId ?? id;
    if (primaryId !== id && release.outcome === 'decision') return this.releaseScreened(primaryId, release);
    return this.questionLock(id, async () => {
      const group = this.ctx.repos.inbox.groupOf(id);
      if (group && release.outcome === 'todo')
        throw conflict('question_group_incompatible', 'a combined decision cannot become a todo');
      if (group && group.primaryItemId !== id) return null;
      const current = this.ctx.repos.inbox.get(id);
      if (!current || current.kind !== 'question' || current.state !== 'screening') return null;
      const { outcome, fallback } = release;
      const config = await this.projects.config(current.projectKey);
      const at = isoNow(this.ctx);
      const { selected, forwardTo, todo, payload, options } = this.releaseFields(
        current,
        release,
        config,
        at,
        forward && release.by ? technicalDeciderOf(config, current.source) : null,
      );
      if (forward && forwardTo && release.by) {
        const resolution = {
          optionId: 'forward',
          by: release.by,
          at,
          note: release.note ?? '',
          rule: 'operator_forwarded' as const,
        };
        const close = (): InboxItem =>
          this.recordScreenedClose(current, resolution, payload, {
            outcome: 'todo',
            by: release.by!,
            note: release.note ?? '',
            forwardedTo: forwardTo,
            ...(todo ? { todo } : {}),
            ...(release.feedbackId !== undefined ? { feedbackId: release.feedbackId } : {}),
          });
        return this.finishScreenedClose(
          id,
          // The item carries the screening record, so the message can name the todo.
          await forward({ ...current, payload, state: 'resolved', resolution }, forwardTo, close),
          close,
        );
      }
      const released = this.ctx.unitOfWork(() => {
        if (!this.ctx.repos.inbox.release(id, { payload, options, at })) return null;
        if (selected.recipient === 'integrator')
          this.ctx.repos.inbox.updateOpen(id, payload, ownerHandles(config), at);
        const item = this.ctx.repos.inbox.get(id)!;
        if (outcome && release.by) {
          this.appendScreened(item, {
            outcome,
            by: release.by,
            note: release.note ?? '',
            ...(todo ? { todo } : {}),
            ...(release.feedbackId !== undefined ? { feedbackId: release.feedbackId } : {}),
          });
        } else if (fallback) {
          this.timeline.append({
            projectKey: item.projectKey,
            taskKey: item.taskKey,
            sessionId: item.sessionId,
            actor: SYSTEM_ACTOR,
            type: 'question_screening_skipped',
            data: { inboxItemId: item.id, asker: item.source, reason: fallback },
          });
        }
        return item;
      });
      if (!released) return null;
      this.publish(released);
      if (group)
        for (const memberId of group.itemIds) {
          if (memberId === id) continue;
          const linked = this.ctx.repos.inbox.get(memberId);
          if (linked) this.publish(linked);
        }
      return released;
    });
  }

  /**
   * The Operator settles a question it screens with no person involved (PM-558): `answered` and `forwarded`
   * resolve it (`operator_answered`, `operator_forwarded`), `moot` closes it (`operator_moot`). `deliver`
   * carries the answer or the forward to the asking member or to the recipient: it calls `close` inside the
   * message transaction, so the item closes only when the message is recorded. Null when the question is not
   * waiting for it any more. `inbox_resolved` follows an answer and a forward (the label comes off); a moot
   * question raises `inbox_cancelled`, as every closed question does.
   */
  settleScreened(
    id: string,
    settlement: ScreeningSettlement,
    deliver?: (item: InboxItem, close: () => InboxItem) => Promise<InboxItem | null>,
  ): Promise<InboxItem | null> {
    if (settlement.outcome === 'moot')
      return this.closeQuestion(id, {
        rule: 'operator_moot',
        by: settlement.by,
        note: settlement.note,
        screened: settlement,
      });
    return this.questionLock(id, async () => {
      const item = this.ctx.repos.inbox.get(id);
      if (!item || item.kind !== 'question' || item.state !== 'screening') return null;
      if (this.ctx.repos.inbox.groupOf(id))
        throw conflict('question_group_incompatible', 'a combined decision must be answered by its owners');
      const at = isoNow(this.ctx);
      const answered = settlement.outcome === 'answered';
      const resolution = {
        optionId: answered ? ANSWER_OPTION.id : 'forward',
        by: settlement.by,
        at,
        note: answered ? (settlement.answer ?? '') : settlement.note,
        rule: answered ? ('operator_answered' as const) : ('operator_forwarded' as const),
      };
      const close = (): InboxItem =>
        this.recordScreenedClose(
          item,
          resolution,
          withScreening(
            item.payload,
            {
              outcome: settlement.outcome,
              by: settlement.by,
              at,
              note: settlement.note,
              ...(settlement.forwardedTo ? { forwardedTo: settlement.forwardedTo } : {}),
            },
            at,
          ),
          settlement,
        );
      return this.finishScreenedClose(
        id,
        deliver ? await deliver({ ...item, state: 'resolved', resolution }, close) : null,
        close,
      );
    });
  }

  /**
   * Closes a screened question as resolved with the screening record in its payload, publishes it and
   * appends the `question_screened` entry (the part of `settleScreened` and of a forwarded todo, PM-1139).
   * Runs in a transaction.
   */
  private recordScreenedClose(
    item: InboxItem,
    resolution: NonNullable<InboxItem['resolution']>,
    payload: Record<string, unknown>,
    entry: ScreenedEntry,
  ): InboxItem {
    const resolved = this.ctx.repos.inbox.close(item.id, 'resolved', resolution, resolution.at);
    if (!resolved) throw conflict('inbox_item_closed', `inbox item ${item.id} is no longer waiting`);
    const withRecord = this.ctx.repos.inbox.updatePayload(item.id, payload, resolution.at) ?? resolved;
    this.publish(withRecord);
    this.appendScreened(withRecord, entry);
    return withRecord;
  }

  /** The item closed by `close` (inside the delivery's transaction, or on its own), then `inbox_resolved`. */
  private async finishScreenedClose(
    id: string,
    delivered: InboxItem | null,
    close: () => InboxItem,
  ): Promise<InboxItem> {
    const resolved = delivered ?? this.ctx.unitOfWork(close);
    this.waiters.get(id)?.(resolved);
    await this.ctx.events.emit('inbox_resolved', resolved);
    return resolved;
  }

  /** The timeline entry of what the Operator decided about a question (PM-558). */
  private appendScreened(item: InboxItem, outcome: ScreenedEntry): void {
    this.timeline.append({
      projectKey: item.projectKey,
      taskKey: item.taskKey,
      sessionId: item.sessionId,
      actor: aiActor(outcome.by),
      type: 'question_screened',
      data: {
        inboxItemId: item.id,
        asker: item.source,
        outcome: outcome.outcome,
        note: outcome.note,
        ...(outcome.forwardedTo ? { forwardedTo: outcome.forwardedTo } : {}),
        ...(outcome.answer ? { answer: outcome.answer } : {}),
        ...(outcome.todo ? { todo: outcome.todo } : {}),
        ...(outcome.feedbackId !== undefined ? { feedbackId: outcome.feedbackId } : {}),
        ...(outcome.outcome === 'todo'
          ? {
              // A todo forwarded to the decider has no recipient: it is nobody's inbox item (PM-1139).
              ...(outcome.forwardedTo ? {} : { recipient: questionPayloadOf(item)?.recipient ?? 'owner' }),
              ...(questionPayloadOf(item)?.screening?.recipientRefusal
                ? { recipientRefusal: questionPayloadOf(item)!.screening!.recipientRefusal }
                : {}),
            }
          : {}),
      },
    });
  }

  /** Closes an open item without a decision (e.g. a stale gate request); returns null if not open. */
  cancel(id: string): InboxItem | null {
    return this.close(id, 'cancelled');
  }

  expire(id: string): InboxItem | null {
    return this.close(id, 'expired');
  }

  /** Startup: permission requests cannot survive a restart (their hook call is gone). */
  expireOpenPermissions(): void {
    for (const item of this.ctx.repos.inbox.listOpen('permission')) this.close(item.id, 'expired', false);
  }

  reassignRemovedHuman(projectKey: string, handle: string, owners: string[]): void {
    // A question the Operator still screens (PM-556) has its assignees too: it goes to them when released.
    for (const item of this.ctx.repos.inbox
      .list(projectKey, { state: PENDING_INBOX_STATES })
      .filter((i) => i.assignees.includes(handle))) {
      const remaining = item.assignees.filter((h) => h !== handle);
      const updated = this.ctx.repos.inbox.updateAssignees(
        item.id,
        remaining.length ? remaining : owners,
        isoNow(this.ctx),
      );
      if (updated) this.publish(updated);
    }
  }

  /**
   * Cancels open questions and permission requests raised by a member (e.g. when it is retired).
   * A decision and a release approval outlive their proposer: the release record stays `proposed`
   * until a human resolves the item, so cancelling it would leave the open release stuck.
   */
  async cancelOpenFromSource(projectKey: string, handle: string): Promise<void> {
    for (const item of this.ctx.repos.inbox.list(projectKey, { state: PENDING_INBOX_STATES })) {
      if (item.source !== handle || item.kind === 'decision' || item.kind === 'release') continue;
      if (item.kind === 'question' && this.ctx.repos.inbox.groupOf(item.id)) {
        await this.closeQuestion(item.id, {
          rule: 'withdrawn',
          by: 'system',
          note: 'The asking member was retired.',
        });
        continue;
      }
      const closed = this.cancel(item.id);
      if (closed) await this.ctx.events.emit('inbox_cancelled', closed);
    }
  }

  private close(id: string, state: 'cancelled' | 'expired', publish = true): InboxItem | null {
    const closed = this.ctx.repos.inbox.close(id, state, null, isoNow(this.ctx));
    if (!closed) return null;
    if (publish) this.publish(closed);
    this.waiters.get(id)?.(closed);
    return closed;
  }

  private publish(item: InboxItem): void {
    this.ctx.bus.publish({
      type: 'inbox_upserted',
      projectKey: item.projectKey,
      item: this.withQuestionGroup(item),
    });
  }

  /**
   * Waits until the item closes and resolves with it. When `signal` aborts first, it drops the waiter,
   * expires the item and resolves null.
   */
  waitForClose(id: string, signal: AbortSignal): Promise<InboxItem | null> {
    return new Promise<InboxItem | null>((resolve) => {
      const onAbort = () => {
        this.waiters.delete(id);
        this.expire(id);
        resolve(null);
      };
      this.waiters.set(id, (closed) => {
        signal.removeEventListener('abort', onAbort);
        this.waiters.delete(id);
        resolve(closed);
      });
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

/** The routing never delegates an input longer than `DELEGATED_INPUT_LIMIT`; the cut below is a safeguard. */
const MAX_DELEGATED_INPUT_CHARS = DELEGATED_INPUT_LIMIT;

/**
 * The agent prompt that wakes an AI decider (PM-169): who asks, the exact input of the tool call and how
 * to answer. English, like every prompt for AI members; the decider writes to people in their language.
 */
function delegatedPermissionPrompt(item: InboxItem, deadline?: string): string {
  const delegation = permissionDelegationOf(item);
  const toolName = typeof item.payload.toolName === 'string' ? item.payload.toolName : 'unknown';
  let input: string;
  try {
    input = JSON.stringify(item.payload.toolInput ?? null) ?? 'null';
  } catch {
    input = '"(unreadable)"';
  }
  const cutOff = input.length > MAX_DELEGATED_INPUT_CHARS;
  return [
    `Permission request ${item.id}: ${item.source}'s CLI asks to use the tool ${toolName}${item.taskKey ? ` (task ${item.taskKey})` : ''}.`,
    `Exact input: ${cutOff ? input.slice(0, MAX_DELEGATED_INPUT_CHARS) : input}`,
    cutOff ? 'The input is cut off here: you cannot see all of it, so never allow it; escalate.' : '',
    `Decide it with decide_permission_request (request_id ${item.id}; allow, deny or escalate, always with a reason)${delegation ? ` before ${deadline ?? delegation.leadDeadline}` : ''}; later a person decides it and the answer is refused. Follow your boundary_authorization duty: always escalate what belongs to the owner or what you doubt.`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** The answer text of a resolved question: the chosen option's label and/or the note. */
export function answerText(item: InboxItem): string {
  const resolution = item.resolution;
  if (!resolution) return '';
  if (resolution.optionId === ANSWER_OPTION.id) return resolution.note ?? '';
  const label = item.options.find((o) => o.id === resolution.optionId)?.label ?? resolution.optionId;
  return resolution.note ? `${label}\n\n${resolution.note}` : label;
}
