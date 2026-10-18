export function createInboxService(deps: ConstructorParameters<typeof InboxService>[0]): InboxService {
  return new InboxService(deps);
}

import { isAbsolute, resolve, sep } from 'node:path';
import { assertIntegratorAccess, assertOwnApproval, integratorExecution } from '../../kernel';
import {
  APPROVAL_PAYLOAD_KEYS,
  hasProtectedQuestionPayload,
  humanInboxAssignment,
  isIntegratorTodo,
  wasIntegratorTodo,
  planIntegratorTodoEscalation,
  selectTodoRecipient,
  ResolveIntegratorTodoRequest as IntegratorTodoRequestSchema,
  ScreeningTodo as ScreeningTodoSchema,
  approvalRefusal,
  canSeeInboxItem,
  DELEGATED_INPUT_LIMIT,
  canDecidePermission,
  effectiveSessionPermissions,
  externalQuestionAnswerRefusal,
  gateRequestOf,
  handOnRequestOf,
  hasSuperOrigin,
  isPendingQuestion,
  isLinkedQuestion,
  isRelayableQuestionItem,
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
  routePermissionRequest,
  TODO_CANNOT_OPTION,
  TODO_DONE_OPTION,
  withQuestionAttachmentGone,
} from '@projectman/shared';
import type {
  Actor,
  DelegatedPermissionDecision,
  GateRequestPayload,
  HumanAccess,
  InboxItem,
  InboxKind,
  InboxOption,
  InboxResolutionRule,
  InboxState,
  ProjectConfig,
  QuestionCloseRule,
  QuestionScreening,
  QuestionTodo,
  ResolveInboxRequest,
  ResolveIntegratorTodoRequest,
  ScreeningTodo,
  ScreenedQuestionsResponse,
  Session,
  SuperActor,
  TimelineEventData,
  TaskStartWaiting,
  WorkItemRef,
} from '@projectman/shared';
import { APPROVER_NONE_REFUSAL } from '../../contracts';
import type {
  EngineDirectory,
  PermissionBroker,
  PermissionDecision,
  PermissionRefusedInfo,
  PermissionRequestInfo,
} from '../../contracts';
import { ownerHandles } from '@projectman/shared';
import { isoNow } from '../base';
import type { DomainContext } from '../base';
import type { InboxPermissionPolicy, QuestionGroupAnswerer, IntegratorTodoAccess } from './ports';
import { conflict, forbidden, invalid, notFound } from '../../kernel';
import type { ProjectService } from '../projects';
import type { TimelineService } from '../timeline';
import { SYSTEM_ACTOR, aiActor, attributedActor, excerpt, humanActor, newId, KeyedMutex } from '../../kernel';

/** How many screened questions the screened-questions list returns (PM-558). */
const SCREENED_QUESTIONS_LIMIT = 20;

/** Built-in option ids; the web app translates them (labels repeat the id). */
const GUEST_CONVERSATION_REFUSAL =
  'This conversation has the team tools only: you read what the person can see and answer them. Nothing else is allowed, and nobody is asked.';

export const PERMISSION_OPTIONS: InboxOption[] = [
  { id: 'allow', label: 'allow', style: 'primary' },
  { id: 'allow_session', label: 'allow_session', style: 'secondary' },
  { id: 'deny', label: 'deny', style: 'danger' },
];

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

export interface CreateInboxItemInput {
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

/** What the Operator settled about a question it screens, with no person involved (PM-558). */
export interface ScreeningSettlement {
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
export interface ScreeningRelease {
  /** The Operator's outcome; none when the system released the question (`fallback`). */
  outcome?: 'decision' | 'todo';
  by?: string;
  note?: string;
  todo?: ScreeningTodo;
  fallback?: 'timeout' | 'unavailable';
}

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
export type SuperOperationAnswer = (item: InboxItem, optionId: string, at: string, handle: string) => void;

export interface Resolver {
  via?: 'integrator';
  /** The Operator's super origin of a step the owner's token made (PM-757); `handle` stays the owner. */
  superActor?: SuperActor;
  handle: string;
  access: HumanAccess;
}

/** Who decides an inbox item another module owns (PM-593). Operator approvals are recognized by operatorApprovalOf. */
export type InboxDeciderKey =
  | 'merge_request'
  | 'release'
  | 'hand_on'
  | 'operator_approval'
  | 'operator_knowledge'
  | 'operator_structural_review';
/** Merge, release and hand-on handlers close their item in their transaction; refusals leave it open.
 * The inbox closes operator approvals after their handler returns. */
export type InboxDecider = (
  item: InboxItem,
  by: Resolver,
  optionId: string,
  note: string | null,
) => void | Promise<void>;
/** Answers an AI member's question. */
export type QuestionAnswerer = (
  item: InboxItem,
  attachmentIds: readonly string[],
  close: () => InboxItem,
) => Promise<InboxItem | null>;
/** The start of an AI asker that the visible inbox shows. */
export interface AskerStarts {
  answerWorkItem(item: InboxItem): Promise<WorkItemRef>;
  waitingReason(
    projectKey: string,
    handle: string,
    workItem: WorkItemRef,
  ): Promise<TaskStartWaiting['reason'] | null>;
}

/** One-line summary of a tool call for humans, e.g. the Bash command or the edited file. */
function summarizeToolInput(input: unknown, sessionCwd?: string | null): string {
  const obj = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  for (const key of [
    'command',
    'file_path',
    'notebook_path',
    'path',
    'url',
    'pattern',
    'description',
    'prompt',
  ]) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) {
      const prefix =
        key === 'command' && typeof obj.cwd === 'string' && isAbsolute(obj.cwd) && obj.cwd !== sessionCwd
          ? `${obj.cwd}$ `
          : '';
      return excerpt(`${prefix}${value}`, 200);
    }
  }
  try {
    return excerpt(JSON.stringify(input) ?? '', 200);
  } catch {
    return '';
  }
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
 * Implements the runner's PermissionBroker: a permission request becomes an inbox item and
 * the hook waits until a human resolves it (or the request is aborted, then it expires).
 */
export class InboxService {
  readonly broker: PermissionBroker;
  private readonly ctx: DomainContext;
  private readonly timeline: TimelineService;
  private readonly projects: ProjectService;
  private readonly policy: InboxPermissionPolicy;
  private readonly integratorTodoAccess?: IntegratorTodoAccess;
  private readonly engines: EngineDirectory;
  private readonly attachmentDirectory?: (projectKey: string, taskKey: string) => Promise<string>;
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
    const item = this.ctx.repos.inbox.close(id, 'resolved', { optionId: 'merge', by, at, note: null }, at);
    if (item) this.publish(item);
  }

  /** Close a release approval item as part of the transaction that decided its release. */
  resolveRelease(id: string, by: string, optionId: string, note: string | null): void {
    assertOwnApproval();
    const at = isoNow(this.ctx);
    const item = this.ctx.repos.inbox.close(id, 'resolved', { optionId, by, at, note }, at);
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
  withQuestionGroup(item: InboxItem): InboxItem {
    const group = this.ctx.repos.inbox.groupOf(item.id);
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
    assertOwnApproval();
    const at = isoNow(this.ctx);
    const item = this.ctx.repos.inbox.close(id, 'resolved', { optionId: 'move', by, at, note: null }, at);
    if (item) this.publish(item);
  }

  constructor(deps: {
    ctx: DomainContext;
    timeline: TimelineService;
    projects: ProjectService;
    policy: InboxPermissionPolicy;
    integratorTodoAccess?: IntegratorTodoAccess;
    /**
     * The engines (PM-311): a session's worktrees root, and where its member workspaces live (PM-138:
     * routine steps there run without asking, as in a worktree), are its engine's.
     */
    engines: EngineDirectory;
    /** The attachment directory of a task: read-only commands there are allowed for its sessions. */
    attachmentDirectory?: (projectKey: string, taskKey: string) => Promise<string>;
  }) {
    this.ctx = deps.ctx;
    this.timeline = deps.timeline;
    this.projects = deps.projects;
    this.policy = deps.policy;
    this.integratorTodoAccess = deps.integratorTodoAccess;
    this.engines = deps.engines;
    this.attachmentDirectory = deps.attachmentDirectory;
    this.broker = {
      decide: (request, signal) => this.decide(request, signal),
      refused: (request) => this.classifierRefused(request),
    };
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
    return this.ctx.repos.inbox.list(projectKey, filter).map((item) => this.withQuestionGroup(item));
  }

  /**
   * The questions the Operator screens or settled without a person (PM-558): in screening now, or answered,
   * forwarded or found moot. Newest first by the Operator's decision (else the asking time), at most
   * `SCREENED_QUESTIONS_LIMIT`; `today` counts all of them asked at or after `since`.
   */
  screenedQuestions(projectKey: string, since: string): ScreenedQuestionsResponse {
    const screened = this.ctx.repos.inbox
      .list(projectKey, { kind: 'question', limit: 100_000 })
      .filter((item) => {
        const group = this.ctx.repos.inbox.groupOf(item.id);
        return !group || group.primaryItemId === item.id;
      })
      .map((item) => ({ item: this.withQuestionGroup(item), screening: questionPayloadOf(item)?.screening }))
      .filter(
        ({ item, screening }) =>
          screening &&
          (item.state === 'screening' ||
            screening.outcome === 'answered' ||
            screening.outcome === 'forwarded' ||
            screening.outcome === 'moot'),
      )
      .map(({ item, screening }) => ({ item, at: screening?.at ?? item.createdAt }));
    screened.sort((a, b) => b.at.localeCompare(a.at));
    return {
      items: screened.slice(0, SCREENED_QUESTIONS_LIMIT).map(({ item }) => item),
      today: screened.filter(({ item }) => item.createdAt >= since).length,
    };
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
    return this.ctx.repos.inbox
      .listOpen()
      .map((item) => this.withQuestionGroup(item))
      .filter(
        (item) =>
          item.projectKey === projectKey &&
          !isLinkedQuestion(item) &&
          humanInboxAssignment(item, handle) &&
          (!reader || canSeeInboxItem(reader, item)),
      ).length;
  }

  async sweepIntegratorTodos(): Promise<void> {
    for (const candidate of this.ctx.repos.inbox.listOpen('question')) {
      if (!isIntegratorTodo(candidate)) continue;
      try {
        await this.questionLock(candidate.id, async () => {
          const config = await this.projects.config(candidate.projectKey);
          const current = this.ctx.repos.inbox.get(candidate.id);
          if (current) this.escalateIntegratorTodo(current, config);
        });
      } catch (error) {
        this.ctx.logger.warn({ error, itemId: candidate.id }, 'integrator_todo_sweep_failed');
      }
    }
  }

  private escalateIntegratorTodo(item: InboxItem, config: ProjectConfig): boolean {
    const at = isoNow(this.ctx);
    const patch = planIntegratorTodoEscalation(item, at, ownerHandles(config));
    if (!patch) return false;
    const updated = this.ctx.unitOfWork(() => {
      const row = this.ctx.repos.inbox.updateOpen(item.id, patch.payload, patch.assignees, at);
      if (!row) return null;
      this.timeline.append({
        projectKey: item.projectKey,
        taskKey: item.taskKey,
        sessionId: item.sessionId,
        actor: SYSTEM_ACTOR,
        type: 'question_recipient_escalated',
        createdAt: at,
        data: {
          inboxItemId: item.id,
          asker: item.source,
          from: 'integrator',
          to: 'owner',
          openedAt: questionPayloadOf(item)!.integratorOpenedAt!,
          reason: 'integrator_timeout',
        },
      });
      return row;
    });
    if (updated) this.publish(updated);
    return !!updated;
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
    const initialConfig = await this.projects.config(projectKey);
    assertIntegratorAccess(initialConfig, 'write', by.superActor);
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
      if (this.escalateIntegratorTodo(item, initialConfig) || !isIntegratorTodo(item))
        throw forbidden('super_relay_refused', 'only a current integrator todo may be resolved');
      if (req.optionId !== 'todo_done' && req.optionId !== 'todo_cannot')
        throw invalid('invalid_request', 'only todo result options are accepted');
    } else if (
      isIntegratorTodo(item) &&
      (by.via || by.superActor || integratorExecution() || by.access !== 'owner')
    ) {
      throw forbidden(
        'super_relay_refused',
        'an integrator todo needs the dedicated super endpoint or the owner login',
      );
    }
    if (!['question', 'alert'].includes(item.kind)) assertOwnApproval(by);
    if (req.attachmentIds !== undefined && item.kind !== 'question')
      throw invalid('invalid_request', 'only questions accept attachments', { field: 'attachmentIds' });
    if (by.via && !['question', 'alert'].includes(item.kind))
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
    const asked = item.kind === 'question' ? questionPayloadOf(item) : null;
    const askedRefusal = asked
      ? externalQuestionAnswerRefusal(asked, {
          via: by.via ?? (integratorExecution() ? 'integrator' : undefined),
          superActor: by.superActor,
        })
      : null;
    if (askedRefusal)
      throw forbidden(
        askedRefusal,
        askedRefusal === 'super_relay_refused'
          ? 'The integrator cannot answer its own question'
          : 'Only the owner may decide this, using their own login',
      );
    // A super-mode step on any other question only relays an answer to a plain information question.
    let relayed = false;
    if (by.superActor && item.kind === 'question' && !integratorTodo) {
      const refuse = () =>
        forbidden(
          'super_relay_refused',
          'The integrator may relay an answer only to a question that asks for information',
        );
      if (!isRelayableQuestionItem(item)) throw refuse();
      // An answer to a question group closes every pending member, so each one must be relayable as well.
      const relayGroup = this.ctx.repos.inbox.groupOf(id);
      for (const memberId of relayGroup?.itemIds ?? []) {
        const member = this.ctx.repos.inbox.get(memberId);
        if (member && isPendingQuestion(member) && !isRelayableQuestionItem(member)) throw refuse();
      }
      relayed = true;
    }
    const operator = operatorApprovalOf(item);
    if (operatorKnowledgeApprovalOf(item)?.stale && req.optionId !== 'dismiss')
      throw conflict('operator_knowledge_stale', 'the knowledge proposal is stale; dismiss it');
    if (operator?.stale && req.optionId !== 'dismiss')
      throw conflict('operator_approval_stale', 'the proposal is stale; dismiss it');
    if (!item.options.some((o) => o.id === req.optionId)) {
      throw invalid('unknown_option', `unknown option: ${req.optionId}`);
    }
    const config = await this.projects.config(projectKey);
    if (memberOf(config, by.handle)?.kind !== 'human')
      throw forbidden('ai_approval_forbidden', 'only human members may resolve inbox items');
    if (item.kind === 'boundary')
      throw forbidden('insufficient_access', 'use the boundary decision endpoint');
    const gate = item.kind === 'decision' && req.optionId === 'approve' ? gateRequestOf(item) : null;
    if (gate?.label) {
      // Approving puts the label on in the approver's name: the label rules apply up front.
      const task = item.taskKey ? this.ctx.repos.tasks.get(item.taskKey) : null;
      const refusal = approvalRefusal(config, gate.label, by.handle, task);
      if (refusal) throw forbidden(refusal, APPROVAL_REFUSALS[refusal]);
    }
    const isAssignee = item.assignees.includes(by.handle);
    if (!isAssignee && !(item.kind !== 'decision' && item.kind !== 'release' && by.access === 'owner')) {
      throw forbidden('not_an_assignee', 'only the assignees may resolve this item');
    }
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
    if (item.kind === 'release') {
      const decide = this.deciders.get('release');
      if (!decide) throw conflict('inbox_item_closed', 'the release approval is no longer available');
      // The decision closes the item in its own transaction; a refused one leaves it open.
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
    if (operator) {
      const decide = this.deciders.get('operator_approval');
      if (!decide) throw forbidden('operator_never', 'Operator decisions are unavailable');
      await decide(item, by, req.optionId, note);
    }
    if (structuralReviewOf(item)) {
      const decide = this.deciders.get('operator_structural_review');
      if (!decide) throw forbidden('owner_approval_required', 'structural review decisions are unavailable');
      await decide(item, by, req.optionId, note);
    }
    const at = isoNow(this.ctx);
    const resolution = {
      optionId: req.optionId,
      by: by.handle,
      at,
      note,
      ...(by.via ? { via: by.via } : {}),
      ...(by.superActor ? { actor: by.superActor } : {}),
      ...(relayed ? { ownerAnswerRelayed: true as const } : {}),
      ...(integratorTodo ? { integratorTodo: true as const, via: 'integrator' as const } : {}),
    };
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
    return this.escalateDelegated(item, config, { actor: SYSTEM_ACTOR, cause: 'timeout' });
  }

  private escalateDelegated(
    item: InboxItem,
    config: ProjectConfig,
    by: { actor: Actor; cause: 'lead' | 'timeout'; reason?: string },
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
   * told by the `inbox_cancelled` listener (`MessagingService.closedNotice`).
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
          ...(close.actor && hasSuperOrigin(close.actor) ? { actor: close.actor } : {}),
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
   * The question leaves the Operator's screening for the people (PM-558): it opens, with the Operator's
   * outcome (`decision`: a person decides; `todo`: a person does something, the options become Done and
   * Cannot do it) or, with no outcome, because the system gave up waiting (`fallback`). Null when the item
   * is not in screening any more (closed or released meanwhile). The timeline records `question_screened`,
   * or `question_screening_skipped` for a fallback.
   */
  releaseScreened(id: string, release: ScreeningRelease): Promise<InboxItem | null> {
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
      const selected =
        outcome === 'todo'
          ? selectTodoRecipient(
              current,
              release.todo!.recipient,
              this.integratorTodoAccess?.available(config) ?? false,
            )
          : { recipient: 'owner' as const };
      const todo = release.todo ? { ...release.todo, recipient: selected.recipient } : undefined;
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
          ...('recipientRefusal' in selected ? { recipientRefusal: selected.recipientRefusal } : {}),
          ...(fallback ? { fallback } : {}),
        },
        at,
      );
      const options = outcome === 'todo' ? [TODO_DONE_OPTION, TODO_CANNOT_OPTION] : current.options;
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
      const close = (): InboxItem => {
        const resolved = this.ctx.repos.inbox.close(id, 'resolved', resolution, at);
        if (!resolved) throw conflict('inbox_item_closed', `inbox item ${id} is no longer waiting`);
        const withRecord =
          this.ctx.repos.inbox.updatePayload(
            id,
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
            at,
          ) ?? resolved;
        this.publish(withRecord);
        this.appendScreened(withRecord, settlement);
        return withRecord;
      };
      const delivered = deliver ? await deliver({ ...item, state: 'resolved', resolution }, close) : null;
      const resolved = delivered ?? this.ctx.unitOfWork(close);
      this.waiters.get(id)?.(resolved);
      await this.ctx.events.emit('inbox_resolved', resolved);
      return resolved;
    });
  }

  /** The timeline entry of what the Operator decided about a question (PM-558). */
  private appendScreened(
    item: InboxItem,
    outcome: Pick<ScreeningSettlement, 'by' | 'note' | 'answer' | 'forwardedTo'> & {
      outcome: TimelineEventData['question_screened']['outcome'];
      todo?: QuestionTodo;
    },
  ): void {
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
        ...(outcome.outcome === 'todo'
          ? {
              recipient: questionPayloadOf(item)?.recipient ?? 'owner',
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
      .list(projectKey, { state: PENDING_INBOX_STATES, limit: 100_000 })
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
   * The agent's own auto mode refused a tool call (Claude Code's PermissionDenied hook): there is
   * nothing to decide, the timeline shows it (PM-165).
   */
  private classifierRefused(request: PermissionRefusedInfo): void {
    const session = this.ctx.repos.sessions.get(request.sessionId);
    if (!session) return;
    this.refused(session, {
      toolName: request.toolName,
      summary: summarizeToolInput(request.toolInput) || request.toolName,
      by: 'classifier',
      ...(request.reason ? { reason: excerpt(request.reason, 500) } : {}),
    });
  }

  private refused(session: Session, data: TimelineEventData['permission_refused']): void {
    this.timeline.append({
      projectKey: session.projectKey,
      taskKey: session.workItem.type === 'task' ? session.workItem.taskKey : null,
      sessionId: session.id,
      actor: SYSTEM_ACTOR,
      type: 'permission_refused',
      data,
    });
  }

  private async decide(request: PermissionRequestInfo, signal: AbortSignal): Promise<PermissionDecision> {
    const session = this.ctx.repos.sessions.get(request.sessionId);
    if (!session) return { behavior: 'deny', message: 'Unknown session.' };
    // The Operator's conversation with someone who is not an owner has the team tools alone (PM-475):
    // anything else is refused at once, and never becomes an item for the owner to approve.
    if (session.workItem.type === 'general' && session.workItem.with !== undefined) {
      this.refused(session, {
        toolName: request.toolName,
        summary: summarizeToolInput(request.toolInput, session.cwd) || request.toolName,
        by: 'approver_none',
      });
      return { behavior: 'deny', message: GUEST_CONVERSATION_REFUSAL };
    }
    const config = await this.projects.config(session.projectKey);
    const summary = summarizeToolInput(request.toolInput, session.cwd);
    const taskKey = session.workItem.type === 'task' ? session.workItem.taskKey : null;
    const member = memberOf(config, session.member);
    const task = taskKey ? this.ctx.repos.tasks.get(taskKey) : null;
    const attachmentsDir =
      task && task.projectKey === session.projectKey
        ? await this.attachmentDirectory?.(session.projectKey, task.key).catch(() => null)
        : null;
    const parentAttachmentsDir =
      task?.parentKey && task.projectKey === session.projectKey
        ? await this.attachmentDirectory?.(session.projectKey, task.parentKey).catch(() => null)
        : null;
    // The places of the engine the session runs on (an engine that is gone has none).
    const engine = this.engines.get(this.policy.engineIdOf(session));
    const worktreesRootDir = engine?.paths().worktreesRoot ?? undefined;
    const workspacesRootDir = (engine?.memberWorkspaces ? engine.paths().workspacesRoot : null) ?? undefined;
    const readableRoots = this.policy.readableRootsFor({
      config,
      cwd: session.cwd,
      projectKey: session.projectKey,
      task,
      worktreesRootDir,
      attachmentsDir,
      parentAttachmentsDir,
    });
    const input = request.toolInput;
    const toolCwd = input && typeof input === 'object' && 'cwd' in input ? input.cwd : undefined;
    let validToolCwd = toolCwd === undefined;
    if (typeof toolCwd === 'string' && isAbsolute(toolCwd) && session.cwd) {
      const under = (p: string, root: string) => p === root || p.startsWith(`${root}${sep}`);
      // The canonical paths are the engine's (the directories are on its disk); a path that is not
      // there, or an engine that is gone, makes the directory invalid.
      try {
        const real = engine
          ? await Promise.all([engine.realpath(toolCwd), engine.realpath(session.cwd)])
          : null;
        validToolCwd =
          under(resolve(toolCwd), resolve(session.cwd)) &&
          real !== null &&
          real[0] !== null &&
          real[1] !== null &&
          under(real[0], real[1]);
      } catch {
        validToolCwd = false;
      }
    }
    const verdict =
      member?.kind === 'ai' && validToolCwd
        ? this.policy.commandVerdict({
            config,
            session: {
              cwd: typeof toolCwd === 'string' ? toolCwd : session.cwd,
              role: member.role,
              provider: session.provider,
              member: session.member,
              branch: session.branch,
            },
            task,
            toolName: request.toolName,
            toolInput: request.toolInput,
            worktreesRootDir,
            workspacesRootDir,
            readableRoots,
          })
        : null;
    // Nobody approves this member's questions (PM-165): refused at once, without an inbox item. The
    // command rules above still come first (a routine step is allowed, publishing is denied); only a
    // request they leave open is refused here. The approver is the one that applies to the session:
    // its own, set by an owner, from the next question on (PM-170), else the member's.
    const approver = member?.kind === 'ai' ? effectiveSessionPermissions(member, session).approver : null;
    if (!verdict && approver === 'none') {
      this.refused(session, { toolName: request.toolName, summary, by: 'approver_none' });
      return { behavior: 'deny', message: APPROVER_NONE_REFUSAL };
    }
    // The approver `ai` (PM-169): the member's AI decider answers, unless the request is one of the
    // owner's categories or there is no decider at work, and then a person does, as for `human`.
    // The session's own directories, not the read-only attachments, are where it may write.
    const route =
      !verdict && member?.kind === 'ai' && approver
        ? routePermissionRequest(config, session.member, {
            toolName: request.toolName,
            toolInput: request.toolInput,
            roots: readableRoots.filter((root) => root !== attachmentsDir && root !== parentAttachmentsDir),
            approver,
          })
        : null;
    const delegation =
      route?.to === 'ai'
        ? {
            state: 'pending_lead' as const,
            leads: route.leads,
            leadDeadline: new Date(
              this.ctx.now().getTime() + (config.team.boundary?.leadTimeoutSeconds ?? 120) * 1000,
            ).toISOString(),
          }
        : null;
    const item = this.create({
      projectKey: session.projectKey,
      kind: 'permission',
      assignees: delegation ? delegation.leads : sponsorOrOwners(config, session.member),
      source: session.member,
      sessionId: session.id,
      taskKey,
      title: summary ? `${request.toolName}: ${summary}` : request.toolName,
      payload: {
        toolName: request.toolName,
        toolInput: request.toolInput ?? null,
        summary,
        ...(delegation ? { delegation } : {}),
        ...(route?.to === 'human' && route.category ? { ownerCategory: route.category } : {}),
      },
      options: PERMISSION_OPTIONS,
    });
    this.timeline.append({
      projectKey: session.projectKey,
      taskKey,
      sessionId: session.id,
      actor: aiActor(session.member),
      type: 'permission_requested',
      data: { inboxItemId: item.id, toolName: request.toolName, summary },
    });

    if (verdict) {
      const at = isoNow(this.ctx);
      const resolved = this.ctx.repos.inbox.close(
        item.id,
        'resolved',
        {
          optionId: verdict.behavior,
          by: 'system',
          at,
          note: null,
          rule: 'command_policy',
        },
        at,
      )!;
      this.publish(resolved);
      this.timeline.append({
        projectKey: session.projectKey,
        taskKey,
        sessionId: session.id,
        actor: SYSTEM_ACTOR,
        type: 'permission_resolved',
        data: { inboxItemId: item.id, decision: verdict.behavior, optionId: verdict.behavior },
      });
      return verdict;
    }

    // Wakes the AI decider; the hook below waits for its answer like for a person's.
    if (delegation) await this.ctx.events.emit('permission_delegated', item);

    return new Promise<PermissionDecision>((resolve) => {
      const onAbort = () => {
        this.waiters.delete(item.id);
        this.expire(item.id);
        resolve({ behavior: 'deny', message: 'No human decided in time; the request expired.' });
      };
      this.waiters.set(item.id, (closed) => {
        signal.removeEventListener('abort', onAbort);
        this.waiters.delete(item.id);
        resolve(toPermissionDecision(closed));
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
export function delegatedPermissionPrompt(item: InboxItem): string {
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
    `Decide it with decide_permission_request (request_id ${item.id}; allow, deny or escalate, always with a reason)${delegation ? ` before ${delegation.leadDeadline}` : ''}; later a person decides it and the answer is refused. Follow your boundary_authorization duty: always escalate what belongs to the owner or what you doubt.`,
  ]
    .filter(Boolean)
    .join('\n');
}

function toPermissionDecision(item: InboxItem): PermissionDecision {
  const resolution = item.resolution;
  if (item.state === 'resolved' && resolution) {
    if (resolution.optionId === 'allow') return { behavior: 'allow' };
    if (resolution.optionId === 'allow_session') return { behavior: 'allow', rememberForSession: true };
    const reason = resolution.note ? `: ${resolution.note}` : '.';
    return { behavior: 'deny', message: `Denied by ${resolution.by}${reason}` };
  }
  return { behavior: 'deny', message: `The permission request was ${item.state}.` };
}

/** The answer text of a resolved question: the chosen option's label and/or the note. */
export function answerText(item: InboxItem): string {
  const resolution = item.resolution;
  if (!resolution) return '';
  if (resolution.optionId === ANSWER_OPTION.id) return resolution.note ?? '';
  const label = item.options.find((o) => o.id === resolution.optionId)?.label ?? resolution.optionId;
  return resolution.note ? `${label}\n\n${resolution.note}` : label;
}
