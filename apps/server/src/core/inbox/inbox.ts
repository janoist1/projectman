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
  ALERT_SEEN_OPTION,
  alertPayloadOf,
  systemNoticeOf,
  waitingDigestNotice,
  APPROVAL_OWNER_TOPIC,
  APPROVAL_PAYLOAD_KEYS,
  ownerTopicRefusal,
  ownerTopicRefusalMessage,
  hasProtectedQuestionPayload,
  humanInboxAssignment,
  isIntegratorTodo,
  isIntegratorFixLimitDecision,
  isIntegratorInboxItem,
  wasIntegratorInboxItem,
  wasIntegratorTodo,
  planIntegratorPassOn,
  isUndelegableQuestion,
  isDelegableFixLimitDecision,
  fixLimitRoutePayload,
  fixLimitRouteTopic,
  fallbackIntegratorTodo,
  technicalDeciderOf,
  FixLimitOptionId,
  inboxResolveRefusal,
  reservedSuperDecisionRefusal,
  ResolveIntegratorFixLimitRequest as IntegratorFixLimitRequestSchema,
  ResolveIntegratorTodoRequest as IntegratorTodoRequestSchema,
  ScreeningTodo as ScreeningTodoSchema,
  canSeeInboxItem,
  DELEGATED_INPUT_LIMIT,
  PERMISSION_LEAD_CAP_MS,
  canDecidePermission,
  deliveredLeadDeadline,
  emailApprovalOf,
  gateRequestOf,
  handOnRequestOf,
  hasBoundOrigin,
  hasConnectedOrigin,
  isPendingQuestion,
  isRelayableQuestionItem,
  machineTodoIssuerAllowed,
  machineTodoIssuerOf,
  memberOf,
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
  AlertPayload,
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
  ScreeningWaitReason,
  ScreenedQuestionsResponse,
  OwnerQuestionsQuery,
  OwnerQuestionsReport,
  BoundActor,
  TimelineEventData,
  TaskStartWaiting,
  WorkItemRef,
} from '@projectman/shared';
import {
  fixLimitDeciders,
  ownerHandles,
  ownerQuestionsSince,
  weeklyOwnerQuestions,
  TEAM_SETTING_POLICY,
} from '@projectman/shared';
import { isoNow } from '../base';
import type { DomainContext } from '../base';
import { applyRoute } from './apply-route';
import type { AppliedRoute } from './apply-route';
import { DelegationDeadlineTimer } from './delegation-deadline';
import { bodyForOwners, formatFixLimitItem } from './fix-limit-text';
import { InboxMentions } from './mentions';
import type { CloseMentionsInput, OpenMentionsInput } from './mentions';
import type { QuestionGroupAnswerer, IntegratorTodoAccess, AlertNoticeSink, AlertPmSignals } from './ports';
import {
  alertMarkerOf,
  alertMarkerOfItem,
  alertMarkerPayload,
  alertTodoOf,
  isMachineAlert,
  isProjectAlert,
} from './alert-todo';
import { DomainError, conflict, forbidden, invalid, notFound } from '../../kernel';
import type { ProjectService } from '../projects';
import type { TimelineService } from '../timeline';
import { SYSTEM_ACTOR, aiActor, attributedActor, excerpt, humanActor, newId, KeyedMutex } from '../../kernel';

/** How many screened questions the screened-questions list returns (PM-558). */
const SCREENED_QUESTIONS_LIMIT = 20;
/** What waits longer than this (an integrator todo, a question in screening) goes into the owners' digest. */
const WAITING_DIGEST_AFTER_MS = 24 * 3_600_000;
/** The owners get at most one digest in this time. */
const WAITING_DIGEST_EVERY_MS = 24 * 3_600_000;

/** Built-in option ids; the web app translates them (labels repeat the id). */
export const DECISION_OPTIONS: InboxOption[] = [
  { id: 'approve', label: 'approve', style: 'primary' },
  { id: 'reject', label: 'reject', style: 'danger' },
];

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
  /** How the route rule placed the item: stored on it and written to the timeline as `item_routed` (PM-1246). */
  routed?: AppliedRoute;
}

/** What happened, as the creator of an alert tells it: the route rule decides who it goes to (PM-1250). */
export interface RaiseAlertInput {
  projectKey: string;
  payload: AlertPayload;
  /** Computed by the outage watcher from the project manager's provider and engine. */
  outageAffectsPm?: boolean;
  /** The English title of the item (or of the todo) the alert becomes. */
  title: string;
  /** Who raised it: the member whose session it is about, else `system`. */
  source?: string;
  sessionId?: string | null;
  taskKey?: string | null;
  /**
   * For the alert items of people (a `refinement` approval, a `merge_blocked`): who holds the duty. For a notice:
   * the concerned people when they are not the owners (a `refinement` done goes to who prioritises).
   */
  assignees?: string[];
  /** The owner who caused the alert and needs no message about it. */
  exceptRecipient?: string | null;
  /** A machine alert raised once for a stretch of time: not again if one of its kind and card exists since then. */
  onceSince?: string;
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
  /** A skipped screening that has to wait for the project manager (PM-1249): why (`unavailable` only). */
  waitReason?: ScreeningWaitReason;
  /** The owner topic of a decision (PM-1190); `releaseOwnerTopic` checks it. */
  ownerTopic?: string;
}

/** The route kinds an integrator todo comes from (`todoRoute`). */
type TodoRouteKind =
  'screened_todo' | 'screening_fallback' | 'member_todo' | 'system_todo' | 'unscreened_question';

/** What the `question_screened` timeline entry says about the Operator's outcome. */
type ScreenedEntry = Pick<ScreeningSettlement, 'by' | 'note' | 'answer' | 'forwardedTo'> & {
  outcome: TimelineEventData['question_screened']['outcome'];
  todo?: QuestionTodo;
  feedbackId?: string;
  ownerTopic?: string;
};

/**
 * The owner topic a screened question goes to the owner under (PM-1190), or undefined when it needs none:
 * a release by the system (`fallback`) or a todo (PM-1243: a todo is the integrator's work, not a decision of
 * the owner, so an `ownerTopic` given with it is ignored). An approval question records `approval`; any other
 * decision needs one of the project's topics, else it is refused and stays in screening.
 */
function releaseOwnerTopic(
  current: InboxItem,
  release: ScreeningRelease,
  config: ProjectConfig,
): string | undefined {
  if (!release.by || release.outcome !== 'decision') return undefined;
  if (hasProtectedQuestionPayload(current)) return APPROVAL_OWNER_TOPIC;
  const refusal = ownerTopicRefusal(config, release.ownerTopic);
  if (refusal) throw invalid(refusal, ownerTopicRefusalMessage(config, refusal));
  return release.ownerTopic;
}

/** `payload` with the screening record changed by `patch`; the record starts at `at` when it had none. */
function withScreening(
  payload: Record<string, unknown>,
  patch: Partial<QuestionScreening>,
  at: string,
): Record<string, unknown> {
  // Whatever settles the screening ends its hold for a machine (PM-708).
  const {
    queue: _held,
    waiting: _waiting,
    ...current
  } = (payload.screening ?? {}) as Partial<QuestionScreening>;
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
  private readonly mentions: InboxMentions;
  private readonly delegationTimer: DelegationDeadlineTimer;
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
    const refusal = reservedSuperDecisionRefusal(item, scope.actor.handle, this.sessionMemberOf(item));
    if (refusal) throw forbidden(refusal, 'this item requires a person using their own login');
    return this.resolution(
      optionId,
      { handle: owner.handle, access: owner.access, via: 'integrator', superActor: scope.actor },
      at,
      note,
    );
  }

  /** The member whose session asked the item. */
  private sessionMemberOf(item: InboxItem): string | null {
    return (item.sessionId ? this.ctx.repos.sessions.get(item.sessionId)?.member : null) ?? null;
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
    this.delegationTimer = new DelegationDeadlineTimer({
      now: () => this.ctx.now().getTime(),
      sweep: () => this.sweepDelegations(),
    });
    this.mentions = new InboxMentions({
      ctx: this.ctx,
      create: (input) => this.create(input),
      publish: (item) => this.publish(item),
    });
  }

  /** Opens the `mention` items of a note, in the unit of work that records it (PM-1307). */
  openMentions(input: OpenMentionsInput): InboxItem[] {
    return this.mentions.open(input);
  }

  /** Closes the replying author's own `mention` items of the thread, in the unit of work of the reply (PM-1307). */
  closeMentionsByReply(input: CloseMentionsInput): InboxItem[] {
    return this.mentions.closeByReply(input);
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
      ...(input.routed ? { route: input.routed.record } : {}),
    };
    this.ctx.unitOfWork(() => {
      this.ctx.repos.inbox.insert(item);
      if (input.routed) this.traceRoute(item, input.routed);
    });
    this.publish(item);
    return item;
  }

  /**
   * The trace of a route (PM-1246): `item_routed` on the card (or the project) with the kind, the recipient the
   * asker named, the target and the reason. The record on the item itself is written with it.
   */
  private recordRoute(item: InboxItem, applied: AppliedRoute): void {
    this.ctx.repos.inbox.setRoute(item.id, applied.record);
    this.traceRoute(item, applied);
  }

  private traceRoute(item: InboxItem, applied: AppliedRoute): void {
    this.timeline.append({
      projectKey: item.projectKey,
      taskKey: item.taskKey,
      sessionId: item.sessionId,
      actor: SYSTEM_ACTOR,
      type: 'item_routed',
      data: {
        itemId: item.id,
        kind: applied.record.kind,
        requested: applied.record.requested,
        to: applied.record.to,
        reason: applied.record.reason,
      },
    });
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
    const delegable = isDelegableFixLimitDecision({
      kind: 'decision',
      source: 'system',
      taskKey: input.taskKey,
      payload: { fixLimit: input.fixLimit },
      options: input.options,
    });
    const selected = this.applyRoute(config, { kind: 'fix_limit', topic: fixLimitRouteTopic(delegable) });
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
          ...fixLimitRoutePayload(selected.route, delegable, isoNow(this.ctx)),
        },
        options: content.options,
        routed: selected,
      }),
    );
  }

  /** Where an item goes (PM-1246): `routeItem` with the facts of this project; a refusal is thrown. */
  applyRoute(config: ProjectConfig, request: Parameters<typeof applyRoute>[2]): AppliedRoute {
    return applyRoute(config, this.integratorTodoAccess?.available(config) ?? false, request);
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

  /**
   * What the integrator is the recipient of that the viewer may read, newest first: the open items, or with `all`
   * every item that was ever opened to it (PM-714). One read for the integrator inbox tool and the work queues.
   */
  integratorQueue(
    projectKey: string,
    state: 'open' | 'all',
    viewer: Parameters<typeof canSeeInboxItem>[0],
    limit: number,
  ): InboxItem[] {
    return this.list(projectKey, state === 'open' ? { state: 'open', limit } : { limit }).filter(
      (item) =>
        canSeeInboxItem(viewer, item) &&
        (state === 'open' ? isIntegratorInboxItem(item) : wasIntegratorInboxItem(item)),
    );
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

  /**
   * The weekly owner question measure of the last `weeks` weeks (PM-1192): `weeklyOwnerQuestions` over the
   * project's questions, cut in the project's time zone.
   */
  async ownerQuestions(projectKey: string, query: OwnerQuestionsQuery): Promise<OwnerQuestionsReport> {
    const config = await this.projects.config(projectKey);
    const input = { timezone: config.project.timezone, now: this.ctx.now(), weeks: query.weeks };
    const items = this.ctx.repos.inbox.questionsSince(projectKey, ownerQuestionsSince(input));
    return weeklyOwnerQuestions(items, {
      ...input,
      coordinatorHandle: coordinationMemberOf(config)?.handle ?? null,
    });
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
   * authenticated super actor, `how.note` the reason), the `integrator_pass_on` route (PM-1246). The same item
   * stays open with its payload and options; only the addressing changes. False when it stays.
   */
  private escalateIntegratorItem(
    item: InboxItem,
    config: ProjectConfig,
    how: {
      actor?: Actor;
      note?: string;
    },
  ): boolean {
    const at = isoNow(this.ctx);
    const reason = 'integrator_passed_on';
    // A fix limit decision goes to the people the card's hold names (the technical direction holders among the
    // owners and admins, else the owners), as it would have if no integrator had been asked.
    const people =
      item.kind === 'decision' ? fixLimitDeciders(config, ownerHandles(config)) : ownerHandles(config);
    const patch = planIntegratorPassOn(item, at, people);
    if (!patch) return false;
    const routed = this.applyRoute(config, { kind: 'integrator_pass_on' });
    const updated = this.ctx.unitOfWork(() => {
      const row = this.ctx.repos.inbox.updateOpen(
        item.id,
        patch.payload,
        patch.assignees,
        at,
        item.kind === 'decision' ? (bodyForOwners(config, item.body) ?? undefined) : undefined,
      );
      if (!row) return null;
      this.recordRoute(row, routed);
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
    const config = await this.projects.config(projectKey);
    const principalOwner = assertIntegratorAccess(config, 'write', by.superActor);
    const scope = integratorExecution();
    const superScope = scope?.principal.mode === 'super';
    if (superScope) {
      if (!principalOwner || principalOwner.handle !== by.handle)
        throw forbidden('insufficient_access', 'the resolver must be the authenticated owner');
      by = { ...by, handle: principalOwner.handle, access: principalOwner.access, via: 'integrator' };
    }
    const group = this.ctx.repos.inbox.groupOf(id);
    const groupMembers = (group?.itemIds ?? []).flatMap((memberId) => {
      const row = this.ctx.repos.inbox.get(memberId);
      return row && row.id !== id && isPendingQuestion(row) ? [row] : [];
    });
    const refusal = inboxResolveRefusal(item, req, by, {
      config,
      credential: scope ? { mode: scope.principal.mode, boundOrigin: hasBoundOrigin(scope.actor) } : null,
      integratorTodo,
      groupMembers,
      sessionMemberOf: (row) => this.sessionMemberOf(row),
      task: item.taskKey ? this.ctx.repos.tasks.get(item.taskKey) : null,
    });
    if (refusal)
      throw new DomainError(refusal.code, refusal.message, {
        status: refusal.status,
        details: refusal.details,
      });
    // Only an entirely relayable group is an information relay.
    const relayed = superScope && !integratorTodo && [item, ...groupMembers].every(isRelayableQuestionItem);
    const superOperation = item.kind === 'question' ? questionPayloadOf(item)?.superOperation : undefined;
    const note = req.note?.trim() ? req.note.trim() : null;
    if (item.kind === 'merge_request') {
      const decide = this.deciders.get('merge_request');
      if (!decide) throw conflict('inbox_item_closed', 'the merge request is no longer available');
      await decide(item, by, req.optionId, note);
      const resolved = this.get(projectKey, id);
      await this.ctx.events.emit('inbox_resolved', resolved);
      return resolved;
    }
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
    // The shared rule refused files nobody takes; this guards an answerer that took none (or is missing).
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
        this.noteDelegation(this.refreshDelegation(item, await this.projects.config(item.projectKey)));
      } catch {
        // The next sweep retries; one unavailable project never holds up another's deadline.
        this.ctx.logger.warn({ itemId: item.id }, 'permission delegation refresh failed');
        this.delegationTimer.retrySoon();
      }
    }
  }

  /**
   * Starts the deadline timer (PM-1374): one sweep now, then one at each earliest deadline, in place of a sweep
   * every second. A change of the configuration also sweeps (`sweepDelegations`).
   */
  startDelegationTimer(): void {
    this.delegationTimer.start();
  }

  stopDelegationTimer(): void {
    this.delegationTimer.stop();
  }

  /** Tells the timer when the delegation of an open item runs out. */
  private noteDelegation(item: InboxItem): void {
    const delegation =
      item.state === 'open' && item.kind === 'permission' ? permissionDelegationOf(item) : null;
    if (delegation?.state === 'pending_lead') this.delegationTimer.note(Date.parse(delegation.leadDeadline));
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
    kind: TodoRouteKind = 'screened_todo',
  ) {
    const { outcome, fallback } = release;
    // A question that cannot become a todo (protected, a group) stays an approval of the owners (PM-1246).
    const route = outcome === 'todo' ? this.todoRoute(current, release, config, decider, kind) : null;
    const forwardTo = route?.forwardTo ?? null;
    const selected = { recipient: route?.recipient ?? ('owner' as QuestionRecipient) };
    const todo = release.todo
      ? { ...release.todo, recipient: forwardTo ? release.todo.recipient : selected.recipient }
      : undefined;
    const payload = withScreening(
      {
        ...current.payload,
        recipient: selected.recipient,
        ...(selected.recipient === 'integrator' ? { integratorOpenedAt: at } : {}),
        ...(release.ownerTopic ? { ownerTopic: release.ownerTopic } : {}),
      },
      {
        at,
        ...(outcome ? { outcome } : {}),
        ...(release.by ? { by: release.by } : {}),
        ...(release.note ? { note: release.note } : {}),
        ...(todo ? { todo } : {}),
        ...(forwardTo ? { forwardedTo: forwardTo } : {}),
        ...(release.feedbackId !== undefined ? { feedbackId: release.feedbackId } : {}),
        ...(route?.protectedQuestion ? { recipientRefusal: 'protected_question' as const } : {}),
        // The only reason a todo is forwarded to the decider: the issuer has no machine access.
        ...(forwardTo ? { recipientRefusal: 'no_machine_access' as const } : {}),
        ...(fallback ? { fallback } : {}),
      },
      at,
    );
    const options = outcome === 'todo' ? [TODO_DONE_OPTION, TODO_CANNOT_OPTION] : current.options;
    return { selected, forwardTo, todo, payload, options, route };
  }

  /**
   * The route of a todo (PM-1246): machine work goes to the integrator's queue (where it waits when nobody is
   * connected), a member without machine access cannot put it there (to the technical `decider` when the project has
   * one, else refused), and a protected question is the owners' approval. The machine access that counts is the
   * one of `machineTodoIssuerOf`; a skipped screening is the system's own step (PM-1243).
   */
  private todoRoute(
    current: InboxItem,
    release: ScreeningRelease,
    config: ProjectConfig,
    decider: string | null,
    kind: TodoRouteKind,
  ): AppliedRoute & { protectedQuestion: boolean } {
    const protectedQuestion = isUndelegableQuestion(current);
    // A skipped screening (a fallback, or a question that was never screened) is the system's own step (PM-1243).
    const issuer =
      kind === 'screening_fallback' || kind === 'unscreened_question'
        ? 'system'
        : machineTodoIssuerOf(current.source, release.by);
    const applied = this.applyRoute(config, {
      kind,
      topic: protectedQuestion ? 'approval' : null,
      requested: questionPayloadOf(current)?.requestedRecipient ?? null,
      issuerMachineAccess: machineTodoIssuerAllowed(config, issuer),
      decider,
    });
    return { ...applied, protectedQuestion };
  }

  /**
   * Where a skipped screening sends the question (PM-1249): an approval is the owners', a requested integrator
   * gets it as a todo, anything else waits for the project manager (`wait_pm`). A combined group never takes the
   * integrator: it is not a todo.
   */
  private fallbackRoute(current: InboxItem, config: ProjectConfig): AppliedRoute {
    const payload = questionPayloadOf(current);
    const approval = hasProtectedQuestionPayload(current) || !payload;
    return this.applyRoute(config, {
      kind: 'screening_fallback',
      topic: approval ? 'approval' : null,
      requested: 'group' in current.payload ? null : (payload?.requestedRecipient ?? null),
    });
  }

  /**
   * The question stays in screening and waits for the project manager (PM-1249): `payload.screening.waiting`
   * says since when and why. A `timeout` also takes the delivery receipt away, so the queue gives the question to
   * the project manager once more, marked `overdue`. Returns the question (still in screening); null when it is
   * gone. The route is written once, when the wait begins.
   */
  private waitForPm(
    current: InboxItem,
    release: ScreeningRelease,
    applied: AppliedRoute,
    at: string,
  ): InboxItem | null {
    const prior = questionPayloadOf(current)?.screening?.waiting;
    const timeout = release.fallback === 'timeout';
    const reason: ScreeningWaitReason = timeout ? 'timeout' : (release.waitReason ?? 'start_refused');
    const overdue = timeout || !!prior?.overdue;
    if (prior && prior.reason === reason && !!prior.overdue === overdue) return current;
    const screening = { ...((current.payload.screening ?? {}) as Record<string, unknown>) };
    if (timeout) delete screening.deliveredAt;
    const saved = this.ctx.unitOfWork(() => {
      const item = this.ctx.repos.inbox.updatePayload(
        current.id,
        {
          ...current.payload,
          screening: {
            ...screening,
            waiting: { since: prior?.since ?? at, reason, ...(overdue ? { overdue } : {}) },
          },
        },
        at,
      );
      if (item && !prior) this.recordRoute(item, applied);
      return item;
    });
    if (saved) this.publish(saved);
    return saved;
  }

  /**
   * The fields of an AI member's question that skips the screening and asks for the integrator (PM-1249): the
   * integrator's todo, built on the path of a skipped screening (`releaseFields`) with the route
   * `unscreened_question`. Null when the question is not the integrator's to take.
   */
  unscreenedTodo(
    draft: InboxItem,
    config: ProjectConfig,
  ): { payload: Record<string, unknown>; options: InboxOption[]; route: AppliedRoute } | null {
    const todo = fallbackIntegratorTodo(draft);
    if (!todo) return null;
    const { payload, options, route } = this.releaseFields(
      draft,
      { outcome: 'todo', by: 'system', todo },
      config,
      isoNow(this.ctx),
      null,
      'unscreened_question',
    );
    return route?.route.to === 'integrator_queue' ? { payload, options, route } : null;
  }

  /**
   * The system opens a todo for the integrator itself (PM-806): nobody asked it, so `askedBy` (`system`, or the
   * project manager's handle) is the item's source and no answer is delivered to anyone. It takes the screening's
   * todo path (`releaseFields`), but opens at once, without the Operator. It always waits in the integrator's
   * queue, connected or not (PM-1246); a member without machine access gets a refusal, not the owners. It sets no
   * waiting label. The obligation's id is on the payload, so
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
    const item = this.openTodoItem(config, input);
    // The integrator's queue takes every machine todo, so there is no refusal to report any more (PM-1246).
    return { itemId: item.id, recipient: 'integrator', recipientRefusal: null };
  }

  /**
   * The synchronous core of `openIntegratorTodo`, for a caller that already holds the project's config
   * (`raiseAlert`). `sessionId` and `extraPayload` (the alert marker) are only for the alerts the system raises.
   */
  private openTodoItem(
    config: ProjectConfig,
    input: {
      projectKey: string;
      taskKey: string | null;
      askedBy: string;
      question: string;
      todo: QuestionTodo;
      obligation?: ObligationRef;
      sessionId?: string | null;
      extraPayload?: Record<string, unknown>;
      routed?: AppliedRoute;
    },
  ): InboxItem {
    const owners = ownerHandles(config);
    if (owners.length === 0) throw invalid('no_assignees', 'the project has no owner to give a todo to');
    const at = isoNow(this.ctx);
    const draft: InboxItem = {
      id: newId('inb'),
      projectKey: input.projectKey,
      kind: 'question',
      assignees: owners,
      source: input.askedBy,
      sessionId: input.sessionId ?? null,
      taskKey: input.taskKey,
      title: input.question,
      body: null,
      payload: {
        question: input.question,
        requestedRecipient: 'integrator',
        recipient: 'owner',
        ...(input.obligation ? { obligation: input.obligation } : {}),
        ...input.extraPayload,
      },
      options: [],
      state: 'open',
      resolution: null,
      createdAt: at,
    };
    const { payload, options, route } = this.releaseFields(
      draft,
      { outcome: 'todo', by: 'system', todo: { ...input.todo, recipient: 'integrator' } },
      config,
      at,
      // Nobody asked a person to decide: a member without machine access gets a refusal, not the owners.
      null,
      input.askedBy === 'system' && !memberOf(config, 'system') ? 'system_todo' : 'member_todo',
    );
    const routed = input.routed ?? route;
    return this.create({
      id: draft.id,
      projectKey: draft.projectKey,
      kind: 'question',
      assignees: owners,
      source: draft.source,
      sessionId: draft.sessionId,
      taskKey: draft.taskKey,
      title: draft.title,
      payload,
      options,
      ...(routed ? { routed } : {}),
    });
  }

  private alertNotices?: AlertNoticeSink;
  private alertPmSignals?: AlertPmSignals;

  /** The sink of the alerts that become a message to the owners (`core/messages` registers it). */
  registerAlertNotices(sink: AlertNoticeSink): void {
    this.alertNotices = sink;
  }

  /** The port of the alerts that become a signal of the project manager. */
  registerAlertPmSignals(signals: AlertPmSignals): void {
    this.alertPmSignals = signals;
  }

  /**
   * The one place an alert is raised (PM-1250): the creator names what happened, the route rule
   * (`ALERT_ROUTE_CLASS`) decides who it goes to, and the creator never picks a recipient. Machine alerts become
   * a todo of the integrator (one open for each kind and card), `pm` alerts the project manager's signal,
   * information a `system_notice` message, and only a `refinement` approval and a `merge_blocked` for a human
   * merger stay alert items of people (`assignees`). A retired kind is refused. Returns the item it created, or
   * null when the alert became a notice or a signal, or one of its kind is open already.
   */
  raiseAlert(input: RaiseAlertInput): InboxItem | null {
    const config = this.projects.cachedConfig(input.projectKey);
    if (!config) return null;
    const { payload } = input;
    const applied = this.applyRoute(config, {
      kind: `alert:${payload.alert}`,
      ...(payload.alert === 'refinement' ? { alertReason: payload.reason } : {}),
      ...(input.outageAffectsPm ? { outageAffectsPm: true } : {}),
    });
    const owners = ownerHandles(config);
    const taskKey = input.taskKey ?? null;
    const sessionId = input.sessionId ?? null;
    const source = input.source ?? 'system';
    switch (applied.route.to) {
      case 'integrator_queue': {
        if (!isMachineAlert(payload) || owners.length === 0) return null;
        const marker = alertMarkerOf(payload, { taskKey, sessionId });
        if (this.alertTodos(input.projectKey, marker, taskKey, input.onceSince).length > 0) return null;
        if (
          input.onceSince &&
          this.legacyAlertSince(input.projectKey, payload.alert, taskKey, input.onceSince)
        )
          return null;
        const item = this.openTodoItem(config, {
          projectKey: input.projectKey,
          taskKey,
          askedBy: 'system',
          question: input.title,
          todo: alertTodoOf(payload, { member: source, sessionId }),
          sessionId,
          extraPayload: {
            ...alertMarkerPayload(marker),
            ...(payload.alert === 'work_outage' ? { workOutage: payload } : {}),
          },
          ...(payload.alert === 'work_outage' ? { routed: applied } : {}),
        });
        if (payload.alert === 'work_outage') {
          const notice = systemNoticeOf(payload);
          if (notice)
            void this.alertNotices?.send({ projectKey: input.projectKey, recipients: owners, notice });
        }
        return item;
      }
      case 'pm':
        if (payload.alert === 'relation_check' || payload.alert === 'work_outage')
          this.alertPmSignals?.raise(input.projectKey, payload);
        return null;
      case 'owner_messages': {
        const notice = systemNoticeOf(payload);
        // The people the alert went to before it became a message: a parked e-mail also reaches the admins, and a
        // creator that names who is concerned (refinement: who prioritises) keeps them.
        const concerned = input.assignees?.length
          ? input.assignees
          : payload.alert === 'email_parked'
            ? config.team.members
                .filter((member) => member.kind === 'human' && ['owner', 'admin'].includes(member.access))
                .map((member) => member.handle)
            : owners;
        const recipients = concerned.filter((handle) => handle !== input.exceptRecipient);
        if (notice && recipients.length > 0)
          void this.alertNotices?.send({ projectKey: input.projectKey, recipients, notice });
        return null;
      }
      case 'owner_inbox':
      case 'duty_holder': {
        const assignees = input.assignees?.length ? input.assignees : owners;
        if (assignees.length === 0) return null;
        return this.create({
          projectKey: input.projectKey,
          kind: 'alert',
          assignees,
          source,
          sessionId,
          taskKey,
          title: input.title,
          payload,
          options: [ALERT_SEEN_OPTION],
          routed: applied,
        });
      }
      default:
        return null;
    }
  }

  /**
   * The todos of one machine alert kind and card that stop a new one: the open ones, or with `since` (the card's
   * closing) the open ones and the ones of any state created at or after it. A legacy alert item of the kind is not one.
   */
  private alertTodos(
    projectKey: string,
    marker: { alert: string; key: string },
    taskKey: string | null,
    since?: string,
  ): InboxItem[] {
    return this.ctx.repos.inbox
      .list(projectKey, {
        kind: 'question',
        ...(since ? {} : { state: 'open' as const }),
        ...(taskKey ? { taskKey } : {}),
      })
      .filter((item) => {
        const found = alertMarkerOfItem(item);
        return (
          found?.alert === marker.alert &&
          found.key === marker.key &&
          (!since || item.state === 'open' || item.createdAt >= since)
        );
      });
  }

  /** Whether an alert item of an older version, in any state, was raised for the card at or after `since`. */
  private legacyAlertSince(
    projectKey: string,
    alert: string,
    taskKey: string | null,
    since: string,
  ): boolean {
    return this.ctx.repos.inbox
      .list(projectKey, { kind: 'alert', ...(taskKey ? { taskKey } : {}) })
      .some((item) => alertPayloadOf(item)?.alert === alert && item.createdAt >= since);
  }

  /**
   * The cause of a machine alert is gone (the disk has room again): its open todo and its open legacy alert
   * items close, and the next occurrence raises a new todo. `scope.taskKey` and `scope.sessionId` pick the card or
   * session; with neither, every open item of the kind in the project closes. `scope.keep` lists the marker keys
   * that stay open (`release_due`: the repositories and bases that still wait for a release).
   */
  settleAlert(
    projectKey: string,
    alert: 'disk_low' | 'machine_busy' | 'worktree_kept' | 'session_input' | 'release_due',
    scope: { taskKey?: string | null; sessionId?: string | null; keep?: readonly string[] } = {},
  ): number {
    const key = isProjectAlert(alert) ? '' : (scope.taskKey ?? scope.sessionId ?? null);
    const todos = this.ctx.repos.inbox
      .list(projectKey, { state: 'open', kind: 'question' })
      .filter((item) => {
        const found = alertMarkerOfItem(item);
        return (
          found?.alert === alert && (key === null || found.key === key) && !scope.keep?.includes(found.key)
        );
      });
    const legacy = this.ctx.repos.inbox
      .list(projectKey, { state: 'open', kind: 'alert' })
      .filter(
        (item) =>
          alertPayloadOf(item)?.alert === alert &&
          (scope.sessionId
            ? item.sessionId === scope.sessionId
            : !scope.taskKey || item.taskKey === scope.taskKey),
      );
    let closed = 0;
    for (const item of [...todos, ...legacy]) if (this.cancel(item.id)) closed += 1;
    return closed;
  }

  /**
   * Tells the owners, at most once a day, that an open integrator todo or a question in screening has waited
   * more than a day (PM-1250). The moment of the last digest is the newest `waiting_digest` notice message, so
   * a restart does not repeat it.
   */
  async sweepWaitingDigests(): Promise<void> {
    for (const { key } of this.projects.summaries()) await this.sendWaitingDigest(key);
  }

  /** One project's digest (see `sweepWaitingDigests`). Returns whether a digest was sent. */

  async sendWaitingDigest(projectKey: string): Promise<boolean> {
    const config = this.projects.cachedConfig(projectKey);
    if (!config || !this.alertNotices) return false;
    const recipients = ownerHandles(config);
    if (recipients.length === 0) return false;
    const now = this.ctx.now().getTime();
    const last = this.ctx.repos.messages.latestSystemNotice('waiting_digest', { projectKey });
    if (last && now - Date.parse(last.createdAt) < WAITING_DIGEST_EVERY_MS) return false;
    const waitingSince: number[] = [];
    let todos = 0;
    let questions = 0;
    for (const item of this.ctx.repos.inbox.list(projectKey, {
      kind: 'question',
      state: ['open', 'screening'],
    })) {
      if (item.state === 'screening') {
        questions += 1;
        waitingSince.push(Date.parse(item.createdAt));
      } else if (isIntegratorTodo(item)) {
        todos += 1;
        waitingSince.push(Date.parse(questionPayloadOf(item)!.integratorOpenedAt!));
      }
    }
    if (waitingSince.length === 0) return false;
    const oldestMs = now - Math.min(...waitingSince);
    if (oldestMs <= WAITING_DIGEST_AFTER_MS) return false;
    await this.alertNotices.send({
      projectKey,
      recipients,
      notice: waitingDigestNotice({ todos, questions, oldestHours: Math.floor(oldestMs / 3_600_000) }),
    });
    return true;
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
   * or `question_screening_skipped` for a fallback. A todo of a member without machine access goes to the
   * project's technical decider when `forward` is given (PM-1139): the item does not open, it closes as forwarded
   * in the transaction of the message `forward` sends (`inbox_resolved` follows, as for `settleScreened`). Without
   * `forward`, or without a decider, the route refuses it (`issuer_without_machine_access`, PM-1246). Every other
   * todo waits in the integrator's queue. The route is stored on the item and written as `item_routed`.
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
      const config = await this.projects.config(current.projectKey);
      const at = isoNow(this.ctx);
      const { fallback } = release;
      // A skipped screening never gives the question to the owners, unless it is an approval (PM-1249): it keeps
      // a requested integrator (PM-1243), and any other question waits for the project manager.
      if (fallback && !release.outcome) {
        const waits = this.fallbackRoute(current, config);
        if (waits.route.to === 'wait_pm') return this.waitForPm(current, release, waits, at);
      }
      // A skipped screening keeps a requested integrator (PM-1243): the question becomes the integrator's todo,
      // which waits in its queue whether or not one is connected (PM-1246); an approval opens for the owners.
      const fallbackTodo = fallback && !release.outcome && !group ? fallbackIntegratorTodo(current) : null;
      const taken =
        !!fallbackTodo &&
        this.todoRoute(current, { fallback }, config, null, 'screening_fallback').route.to ===
          'integrator_queue';
      const effective: ScreeningRelease =
        fallbackTodo && taken ? { outcome: 'todo', by: 'system', todo: fallbackTodo, fallback } : release;
      const { outcome } = effective;
      const { ownerTopic: _asked, ...rest } = effective;
      const ownerTopic = releaseOwnerTopic(current, effective, config);
      const { selected, forwardTo, todo, payload, options, route } = this.releaseFields(
        current,
        ownerTopic ? { ...rest, ownerTopic } : rest,
        config,
        at,
        forward && effective.by ? technicalDeciderOf(config, current.source) : null,
        fallbackTodo && taken ? 'screening_fallback' : 'screened_todo',
      );
      if (forward && forwardTo && release.by) {
        const resolution = {
          optionId: 'forward',
          by: release.by,
          at,
          note: release.note ?? '',
          rule: 'operator_forwarded' as const,
        };
        const close = (): InboxItem => {
          const closed = this.recordScreenedClose(current, resolution, payload, {
            outcome: 'todo',
            by: release.by!,
            note: release.note ?? '',
            forwardedTo: forwardTo,
            ...(todo ? { todo } : {}),
            ...(release.feedbackId !== undefined ? { feedbackId: release.feedbackId } : {}),
          });
          if (route) this.recordRoute(closed, route);
          return closed;
        };
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
        if (route) this.recordRoute(this.ctx.repos.inbox.get(id)!, route);
        const item = this.ctx.repos.inbox.get(id)!;
        // The fallback decides first: a skipped screening that became an integrator todo is still a skipped one.
        if (fallback) {
          this.timeline.append({
            projectKey: item.projectKey,
            taskKey: item.taskKey,
            sessionId: item.sessionId,
            actor: SYSTEM_ACTOR,
            type: 'question_screening_skipped',
            data: { inboxItemId: item.id, asker: item.source, reason: fallback },
          });
        } else if (outcome && release.by) {
          this.appendScreened(item, {
            outcome,
            by: release.by,
            note: release.note ?? '',
            ...(todo ? { todo } : {}),
            ...(release.feedbackId !== undefined ? { feedbackId: release.feedbackId } : {}),
            ...(ownerTopic ? { ownerTopic } : {}),
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
   * An owner takes a question that waits for the project manager (PM-1252, the `owner_pulled` route): it opens
   * for the owners as their own decision, without waiting for the screening. Refused (`question_not_screening`)
   * when the question does not wait any more: it was screened, answered or closed meanwhile.
   */
  pullWaiting(id: string, by: string): Promise<InboxItem> {
    return this.questionLock(id, async () => {
      const current = this.ctx.repos.inbox.get(id);
      const waiting =
        current?.kind === 'question' && current.state === 'screening'
          ? questionPayloadOf(current)?.screening?.waiting
          : null;
      if (!current || !waiting)
        throw conflict('question_not_screening', 'the question does not wait for the project manager');
      const config = await this.projects.config(current.projectKey);
      const at = isoNow(this.ctx);
      const applied = this.applyRoute(config, { kind: 'owner_pulled' });
      const payload = withScreening(
        { ...current.payload, recipient: 'owner' satisfies QuestionRecipient },
        { at, outcome: 'decision', by },
        at,
      );
      const released = this.ctx.unitOfWork(() => {
        if (!this.ctx.repos.inbox.release(id, { payload, options: current.options, at })) return null;
        this.recordRoute(current, applied);
        return this.ctx.repos.inbox.get(id);
      });
      if (!released)
        throw conflict('question_not_screening', 'the question does not wait for the project manager');
      this.publish(released);
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
        ...(outcome.ownerTopic ? { ownerTopic: outcome.ownerTopic } : {}),
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
      // A mention was for this person only: nobody else is asked to see it (PM-1307).
      if (item.kind === 'mention') {
        this.close(item.id, 'cancelled');
        continue;
      }
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
   * until a human resolves the item, so cancelling it would leave the open release stuck. A mention outlives
   * its author too: the note it points at stays on the card (PM-1307).
   */
  async cancelOpenFromSource(projectKey: string, handle: string): Promise<void> {
    for (const item of this.ctx.repos.inbox.list(projectKey, { state: PENDING_INBOX_STATES })) {
      if (item.source !== handle || ['decision', 'release', 'mention'].includes(item.kind)) continue;
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
    this.noteDelegation(item);
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
