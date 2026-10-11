import type { ProviderLoginStatus } from '@projectman/shared';
import {
  CreateEngineRequest,
  StopOrphansRequest,
  StopSessionRequest,
  CreateIntegratorKeyRequest,
  InvolvementQuery,
  canManageInstancePause,
  canManageProviderKeys,
  SetProviderKeyRequest,
  AcceptInviteRequest,
  BOARD_RANK_STEP,
  BoardMoveRequest,
  boardColumnOf,
  compareBoardOrder,
  dropStageOfColumn,
  groupPlacement,
  isChronologicalColumn,
  planRanks,
  stagesOfColumn,
  subtasksMovingAlong,
  BoundaryRequest,
  DecideBoundaryRequest,
  boundaryOwners,
  boundaryWaitingState,
  canDecideBoundary,
  canReadBoundary,
  AddHumanMemberRequest,
  AgentProvider,
  CancelTaskRequest,
  CloseThemeRequest,
  ChangeTaskLabelsRequest,
  CreateInviteRequest,
  CreateProjectRequest,
  CreateTaskCommentRequest,
  CreateTaskRequest,
  CustomRoleRequest,
  DEFAULT_AGENT_PROVIDER,
  HANDOFF_TIMEOUT_MS,
  planHandoff,
  hasPlanUsage,
  pausesOnPlanUsage,
  HireMemberRequest,
  INLINE_MEDIA_TYPES,
  InvitationView,
  LoginRequest,
  MAX_ATTACHMENT_BYTES,
  OCTET_STREAM,
  PR_MERGED_LABEL,
  PatchConfigRequest,
  ReopenTaskRequest,
  ResolveInboxRequest,
  RetireMemberRequest,
  RevertConfigRequest,
  SendMessageRequest,
  ReadTeamMessagesRequest,
  SendTeamMessageRequest,
  SetupRequest,
  StartTaskRequest,
  UpdateMemberRequest,
  UpdateSessionRequest,
  UpdateTaskRequest,
  priorityRefusal,
  aiLimitReached,
  aiLabelSetters,
  applyConfigPatch,
  unknownPatchRepo,
  approvalRefusal,
  attachmentPreviewOf,
  canDeleteAttachment,
  canReadAttachments,
  canSeeTask,
  canSeeTeamMessage,
  isUnreadBy,
  threadPeersOf,
  canUploadAttachment,
  commentMentions,
  configSchemaIssues,
  coverAttachmentId,
  TaskCoverRequest,
  evaluateMove,
  evaluateStart,
  expiredLabels,
  gateRequestOf,
  handOnDecision,
  handOnRequestOf,
  holdersAllow,
  isBuiltInRole,
  isHandleOnLeave,
  isOnLeave,
  isRequiredOperator,
  isRequiredProjectManager,
  isOpenTask,
  openPrerequisites,
  projectRefines,
  isWorkingOnTask,
  labelDefinition,
  labelHolders,
  memberDuties,
  memberOf,
  memberRoles,
  modelForProvider,
  nextCronRun,
  projectManagerOf,
  noApproverReason,
  approverBlocker,
  ownerOnlyChanges,
  permissionView,
  effectiveSessionPermissions,
  duplicateMarkRefusal,
  planLabelChange,
  planRelations,
  pullRequestsMerged,
  reverseRelationKind,
  repoOf,
  repoRequired,
  resolvedStages,
  roleBundle,
  roleHolders,
  stageApprovers,
  stageIndex,
  stageOf,
  stageOwners,
  startBlock,
  subtaskParentRefusal,
  isTheme,
  themeRefusal,
  taskSeq,
  taskWorkOf,
  introducedErrors,
  mergeTokenUsage,
  ALERT_SEEN_OPTION,
  WorkOutageAlert,
  limitTokens,
  LOOP_LET_RUN_OPTION,
  LOOP_STOP_OPTION,
  countsForLoop,
  findLoop,
  isLoopWork,
  loopDecisionOf,
  loopDeciders,
  loopWatchers,
  loopWatchOf,
  usageTotal,
  closedCardsSince,
  countCardRounds,
  countFixRounds,
  fixLimitDecisionOf,
  fixLimitDeciders,
  fixLimitLead,
  fixLimitPlanner,
  fixLimitPlannerForOwner,
  fixLimitReached,
  maxFixRoundsOf,
  canSetDeveloperLevel,
  DEVELOPER_LEVEL_REASON_MAX,
  developerLevelOf,
  isSenior,
  pickDeveloper,
  seniorWaitDecisionOf,
  seniorWaitMinutesOf,
  seniorsOf,
  SENIOR_WAIT_OPTIONS,
  SENIOR_WAIT_OPTION_ANY,
  SENIOR_WAIT_OPTION_WAIT,
  FIX_ANOTHER_ROUND_OPTION,
  FIX_REASSIGN_OPTION,
  FIX_REPLAN_OPTION,
  DEFAULT_CLOSED_CARDS_DAYS,
  isClosedSince,
  measureClosedCard,
  taskWait,
  waitHolders,
  waitWorkers,
} from '@projectman/shared';
import type {
  EngineStatusView,
  EngineView,
  HandoffFallbackReason,
  HandoffStart,
  HandoffStep,
  TaskHandoff,
  TaskHandoffRecord,
  MachineView,
  Actor,
  FixRounds,
  TaskFixLimit,
  LoopDecisionPayload,
  LoopTalk,
  TaskLoop,
  BoundaryGrant,
  AiMemberConfig,
  ApprovalRequirement,
  Attachment,
  AttachmentViewer,
  TaskCoverChoice,
  BoardMoveResult,
  BoardGroupItem,
  BoardPlacement,
  BoardView,
  RankedCard,
  ChatItem,
  ClientCommand,
  ConfigVersionEntry,
  ErrorCode,
  GateEvaluation,
  HumanAccess,
  GateRequestPayload,
  InboxItem,
  InvitationView as Invitation,
  LabelChangeReason,
  LabelChangeRefusal,
  LabelClearTrigger,
  RelationStep,
  RelationsChange,
  MemberUsage,
  MemberView,
  PlanUsage,
  ProjectConfig,
  ScheduleRun,
  ServerEvent,
  Session,
  SessionStop,
  SessionTokensAlert,
  Stage,
  StartBlock,
  Task,
  TeamMessage,
  TeamMessageAnswer,
  TokenUsage,
  TimelineEvent,
  TimelineEventData,
  TimelineEventType,
  WorkOutage,
} from '@projectman/shared';
import {
  aiMemberDefaults,
  defaultMemberHandle,
  defaultMemberName,
  humanMemberHandle,
  roleViews,
} from '@projectman/templates';
import * as fixtures from './fixtures';
import { MockPauses } from './pauses';
import { mockId, mockUuid, nowIso } from './time';

export type MockAuthState = 'ready' | 'setup' | 'login';

export interface MockResponse {
  status: number;
  body?: unknown;
}

/** A test listener for the websocket events the backend publishes. */
export interface MockConnection {
  deliver(event: ServerEvent): void;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function newInviteToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

/** Like the GitHub integration: the system label "pr-merged" follows the linked pull requests. */
function withPrMergedLabel(task: Task, config: Pick<ProjectConfig, 'pipeline'>): Task {
  if (!labelDefinition(config, PR_MERGED_LABEL)) return task;
  const merged = pullRequestsMerged(task);
  if (merged === task.labels.includes(PR_MERGED_LABEL)) return task;
  return {
    ...task,
    labels: merged
      ? [...task.labels, PR_MERGED_LABEL]
      : task.labels.filter((label) => label !== PR_MERGED_LABEL),
  };
}

/** A task as the board's order rules read it. */
function rankedOf(task: Task): RankedCard {
  return { key: task.key, rank: task.boardRank, updatedAt: task.updatedAt };
}

function boardResult(
  task: Task,
  outcome: BoardMoveResult['outcome'],
  reranked: readonly string[],
): BoardMoveResult {
  return { task: clone(task), outcome, reranked: [...reranked] };
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** Like the server: a team message goes to each recipient once and never to its sender. */
function teamRecipients(from: string, to: readonly string[]): string[] {
  return unique(to).filter((handle) => handle !== from);
}

function error(status: number, code: ErrorCode, message: string, details?: unknown): MockResponse {
  return { status, body: { error: { code, message, ...(details === undefined ? {} : { details }) } } };
}

function ok(body?: unknown): MockResponse {
  return body === undefined ? { status: 204 } : { status: 200, body };
}

/** The server's answer to a refused label change. */
function labelChangeError(refusal: LabelChangeRefusal): MockResponse {
  switch (refusal.code) {
    case 'owner_approval_required':
      return error(403, refusal.code, 'Only the owner may give this approval', { label: refusal.label });
    case 'self_review_forbidden':
      return error(403, refusal.code, 'The assignee and PR authors cannot set this label', {
        label: refusal.label,
      });
    case 'label_not_allowed':
      return error(403, refusal.code, 'The label rules forbid this', {
        label: refusal.label,
        reason: refusal.reason,
      });
    case 'comment_required':
      return error(400, refusal.code, 'These labels need a comment', { labels: refusal.labels });
  }
}

/** What a refused move's error carries, as the group move reads it back (PM-121). */
type GateBlockedDetails = Pick<Extract<BoardGroupItem, { outcome: 'blocked' }>, 'unmet' | 'approvals'> & {
  inboxItemIds?: string[];
  /** The approval nobody may give (`noApproverError`). */
  stageId?: string;
  label?: string;
};

/** The refusals of an approval request nobody may give: that card stays, the others move on. */
const NO_APPROVER_CODES: ReadonlySet<string> = new Set([
  'self_review_forbidden',
  'release_four_eyes',
  'missing_duty_holder',
]);

function gateBlockedError(evaluation: GateEvaluation, block?: StartBlock): MockResponse {
  return error(409, 'gate_blocked', 'Gate conditions are not met', {
    unmet: evaluation.unmet,
    approvals: evaluation.approvals,
    ...(block ? { block } : {}),
  });
}

function approvalRequestedError(items: readonly InboxItem[]): MockResponse {
  return error(409, 'approval_requested', 'Approvers were asked', {
    inboxItemIds: items.map((item) => item.id),
    approvers: unique(items.flatMap((item) => item.assignees)),
  });
}

const SYSTEM_ACTOR: Actor = { kind: 'system', handle: null };

function parseBody<T>(
  schema: { safeParse(data: unknown): { success: true; data: T } | { success: false } },
  body: unknown,
): T | null {
  const result = schema.safeParse(body ?? {});
  return result.success ? result.data : null;
}

/**
 * In-memory stand-in for the projectman server, the fake behind the UI tests. It implements
 * the REST routes from the shared route table and publishes the same websocket events the
 * real server would, so the UI runs through its normal data path.
 */
export class MockBackend {
  auth: MockAuthState;
  /** Cloud mode before the first setup (PM-317): the setup asks for this code; null is single-machine mode. */
  setupCode: string | null = null;
  viewerHandle: string = fixtures.OWNER;
  user = { ...fixtures.mockUser };
  config: ProjectConfig = fixtures.buildConfig();
  configVersion = fixtures.projectSummary.configVersion;
  history: ConfigVersionEntry[] = clone(fixtures.configHistory);
  tasks: Task[] = clone(fixtures.tasks).map((task) => withPrMergedLabel(task, this.config));
  members: MemberView[] = clone(fixtures.members);
  timeline: TimelineEvent[] = clone(fixtures.timeline);
  integratorKey: import('@projectman/shared').IntegratorKeyInfo | null = null;
  private viewerAccess(): import('@projectman/shared').HumanAccess {
    const member = memberOf(this.config, this.viewerHandle);
    return member?.kind === 'human' ? member.access : 'viewer';
  }
  /** Where each card's fix rounds are counted from and the rounds people let it have (PM-262). */
  private fixLimitState = new Map<string, { countedFrom: string | null; extraRounds: number }>();
  /** The cards that wait for a Senior (PM-348): since when, the question asked and the answer given. */
  private seniorWaits = new Map<
    string,
    { since: string; itemId?: string; decision?: { decision: 'wait' | 'any'; by: string } }
  >();
  scheduleRuns: ScheduleRun[] = [];
  attachments: Attachment[] = [];
  /** A person's cover choice per task (PM-224); a task without one has the automatic cover. */
  covers = new Map<string, TaskCoverChoice>();
  providerLoggedIn = { claude: true, codex: true, gemini: true, nanogpt: true };
  /** Per-provider overrides of the /api/providers rows (PM-327, PM-330). */
  providerStatus: Partial<
    Record<
      AgentProvider,
      Partial<Pick<ProviderLoginStatus, 'loggedIn' | 'method' | 'problem' | 'cliVersion' | 'minCliVersion'>>
    >
  > = {};
  /** While set, GET /api/providers fails. */
  providersFail = false;
  canManageKeys: boolean | undefined;
  nanogptKeyStatus = { set: false, setAt: null as string | null };
  providerPlanUsage: Partial<Record<AgentProvider, PlanUsage>> = {};
  sessions: Session[] = clone(fixtures.sessions);
  /** The closed handoffs (PM-342) by id, served by the record endpoint; a test may add its own. */
  handoffRecords = new Map<string, TaskHandoffRecord & { taskKey: string }>();
  /** Whether the old assignee's conversation has a transcript to summarize (PM-342); a test may clear it. */
  handoffTranscript = true;
  chats: Record<string, ChatItem[]> = clone(fixtures.chats);
  /** The developer's starts that wait for labels an AI member sets (PM-236), by task key. */
  private readonly labelWaits = new Map<string, { input: StartTaskRequest; workStageId: string }>();
  /** The pauses of the team (PM-220); tests settle and release them through here. */
  readonly pauses: MockPauses = new MockPauses({
    projectKey: fixtures.PROJECT_KEY,
    // Read when used: a test may swap the viewer or the lists.
    sessions: () => this.sessions,
    tasks: () => this.tasks,
    viewer: () => ({
      name: this.user.name,
      handle: this.viewerHandle,
      role: this.findMember(this.viewerHandle)?.role ?? '',
    }),
    isLive: (session) => this.isLive(session),
    isAiMember: (handle) => this.findMember(handle)?.kind === 'ai',
    emit: (event) => this.emit(event),
    addTimeline: (taskKey, who, type, data) => void this.addTimeline(taskKey, who, type, data),
    updateSession: (id, patch) => this.updateSession(id, patch),
    updateTask: (key, patch) => this.updateTask(key, patch),
    flushHeldMessages: () => {
      for (const session of this.sessions) if (this.isLive(session)) this.flushTeamMessages(session);
    },
  });
  inbox: InboxItem[] = clone(fixtures.inbox);
  boundaryGrants = new Map<string, BoundaryGrant>();
  messages: TeamMessage[] = clone(fixtures.teamMessages);
  memories: Record<string, string> = {
    'fe-1': 'Acme checkout uses fictional fixtures. Keep the cart usable on small screens.',
  };
  planUsage = clone(fixtures.planUsage);
  /** A fixed sample can be supplied by UI tests; otherwise use the fixture sessions. */
  machine: MachineView | null = null;
  orphanStopOutcomes: Record<number, 'stopped' | 'gone' | 'refused' | 'failed'> = {};
  /** Hybrid mode (PM-316): `single` has no engine routes at all; a test switches to `cloud` and adds engines. */
  engineMode: 'single' | 'cloud' = 'single';
  engines: EngineView[] = [];
  /** Codes the machine display and the session detail answer with (`engine_offline`), by session id. */
  machineError: ErrorCode | null = null;
  sessionErrors = new Map<string, ErrorCode>();
  /** The machine key the last `POST /api/engines` returned (a test checks it is shown once). */
  lastEngineKey: string | null = null;
  /** While set, POST /api/engines (and the other changes) answer `owner_login_required` for `engines`. */
  engineLoginRequired = false;
  codexPlanUsage = { ...clone(fixtures.planUsage), fiveHourPercent: 24, weeklyPercent: 36 };
  extraProjects: { key: string; name: string; templateId: string }[] = [];
  invitations: Array<Invitation & { token: string }> = [];
  accounts = new Map<string, { userId: string; name: string; email: string; password: string }>([
    [fixtures.mockUser.email, { ...fixtures.mockUser, password: 'correct horse battery' }],
  ]);
  private inviteAttempts = { count: 0, resetAt: 0 };
  /** Connected listeners and the projects each subscribed to. */
  private readonly connections = new Map<MockConnection, Set<string>>();
  private lastTaskSeq = Math.max(0, ...fixtures.tasks.map((task) => taskSeq(task.key)));

  constructor(auth: MockAuthState = 'ready') {
    this.auth = auth;
    // The migration's first order: by the latest update, the highest number first (themes have none).
    this.tasks
      .filter((task) => !isTheme(task))
      .sort((a, b) => compareBoardOrder(rankedOf(a), rankedOf(b)))
      .forEach((task, index) => {
        task.boardRank = (index + 1) * BOARD_RANK_STEP;
      });
    for (const member of this.members) {
      const config = memberOf(this.config, member.handle);
      if (config?.kind === 'ai')
        Object.assign(member, {
          provider: config.provider ?? DEFAULT_AGENT_PROVIDER,
          model: config.model,
          effort: config.effort,
          ...(config.autoCompactWindowTokens
            ? { autoCompactWindowTokens: config.autoCompactWindowTokens }
            : {}),
          ...(config.cheapSubagent ? { cheapSubagent: config.cheapSubagent } : {}),
        });
    }
    this.syncPermissionViews();
    for (const message of this.messages) {
      message.receipts ??= message.to.map((handle) => ({
        handle,
        kind: this.findMember(handle)?.kind ?? 'human',
        deliveredAt: message.deliveredAt,
        readAt: null,
      }));
    }
  }

  /* ---------- plumbing ---------- */

  connect(connection: MockConnection): () => void {
    this.connections.set(connection, new Set());
    connection.deliver({ type: 'hello', serverTime: nowIso() });
    return () => {
      this.connections.delete(connection);
    };
  }

  /** Project subscriptions; terminal commands have no fake terminal behind them. */
  handleCommand(connection: MockConnection, command: ClientCommand): void {
    const projects = this.connections.get(connection);
    if (!projects) return;
    if (command.type === 'subscribe_project') projects.add(command.projectKey);
    else if (command.type === 'unsubscribe_project') projects.delete(command.projectKey);
  }

  /** Publishes a project event to every subscribed connection. */
  emit(event: ServerEvent): void {
    if (event.type === 'team_message' && !canSeeTeamMessage(this.taskViewer(), event.message)) return;
    const projectKey = 'projectKey' in event ? event.projectKey : null;
    for (const [connection, projects] of this.connections) {
      if (projectKey === null || projects.has(projectKey)) connection.deliver(event);
    }
  }

  /* ---------- domain helpers ---------- */

  get owner(): string {
    return this.viewerHandle;
  }

  findTask(key: string): Task | undefined {
    return this.tasks.find((task) => task.key === key);
  }

  findSession(id: string): Session | undefined {
    return this.sessions.find((session) => session.id === id);
  }

  findMember(handle: string): MemberView | undefined {
    return this.members.find((member) => member.handle === handle);
  }

  /** A copy of the member as the server serves it: with the work its live sessions do on cards. */
  private viewOf(member: MemberView): MemberView {
    if (member.kind !== 'ai') return clone(member);
    const open = new Set(this.tasks.filter(isOpenTask).map((task) => task.key));
    const taskWork = this.sessions
      .filter((session) => session.member === member.handle)
      .flatMap((session) => taskWorkOf(session) ?? [])
      .filter((work) => open.has(work.taskKey));
    return { ...clone(member), taskWork };
  }

  /** The viewer as the shared task rules know them. */
  private taskViewer(): AttachmentViewer {
    const viewer = this.findMember(this.viewerHandle);
    return {
      access: viewer?.kind === 'human' ? (viewer.role as HumanAccess) : 'ai',
      handle: this.viewerHandle,
    };
  }

  /** The viewer reads a message sent to them: their receipt, and the event the server pushes. */
  private markMessageRead(message: TeamMessage): void {
    message.receipts ??= message.to.map((handle) => ({
      handle,
      kind: this.findMember(handle)?.kind ?? 'human',
      deliveredAt: message.deliveredAt,
      readAt: null,
    }));
    const receipt = message.receipts.find((r) => r.handle === this.viewerHandle)!;
    receipt.readAt ??= nowIso();
    receipt.deliveredAt ??= nowIso();
    this.emit({ type: 'team_message', projectKey: fixtures.PROJECT_KEY, message: clone(message) });
  }

  /** The team messages the viewer may see, oldest first: the rule the server uses (`packages/shared`). */
  private visibleMessages(): TeamMessage[] {
    const viewer = this.taskViewer();
    return this.messages.filter((message) => canSeeTeamMessage(viewer, message));
  }

  /** Whether the viewer may see the task: the rule the server uses (`packages/shared`). */
  canSee(task: Task): boolean {
    return canSeeTask(this.taskViewer(), task);
  }

  /**
   * Adds a file to a task as the viewer, with its timeline event and change notice, as an upload
   * does (the fake trusts the declared type of the file; the server decides from the content).
   */
  addAttachment(
    taskKey: string,
    file: { name: string; size: number; type: string },
    uploadedBy: Actor = this.viewerActor(),
  ): Attachment {
    const mediaType = file.type in INLINE_MEDIA_TYPES ? file.type : OCTET_STREAM;
    const attachment: Attachment = {
      id: `${mockId('att')}0000`,
      projectKey: fixtures.PROJECT_KEY,
      taskKey,
      fileName: file.name || 'file',
      size: file.size,
      mediaType,
      preview: attachmentPreviewOf(mediaType),
      uploadedBy,
      createdAt: nowIso(),
    };
    this.attachments.push(attachment);
    this.addTimeline(taskKey, uploadedBy.handle, 'attachment_added', {
      attachmentId: attachment.id,
      fileName: attachment.fileName,
      size: attachment.size,
      mediaType,
    });
    this.emit({ type: 'task_attachments_changed', projectKey: fixtures.PROJECT_KEY, taskKey });
    this.syncCover(taskKey);
    return attachment;
  }

  /**
   * The card's cover follows the task's first image (the shared rule); a changed cover is pushed
   * as the changed task, as the server does, and the task's update time stays.
   */
  private syncCover(taskKey: string): void {
    const task = this.findTask(taskKey);
    if (!task) return;
    const cover = coverAttachmentId(
      this.attachments.filter((entry) => entry.taskKey === taskKey),
      this.covers.get(taskKey),
    );
    if ((task.coverAttachmentId ?? null) === cover) return;
    if (cover) task.coverAttachmentId = cover;
    else delete task.coverAttachmentId;
    this.emit({ type: 'task_upserted', projectKey: task.projectKey, task: clone(task) });
  }

  /** Removes a file, as the viewer: the timeline keeps the name. */
  removeAttachment(id: string, who = this.viewerHandle): void {
    const attachment = this.attachments.find((entry) => entry.id === id);
    if (!attachment) return;
    this.attachments = this.attachments.filter((entry) => entry.id !== id);
    const choice = this.covers.get(attachment.taskKey);
    if (choice?.mode === 'pinned' && choice.attachmentId === id) this.covers.delete(attachment.taskKey);
    this.addTimeline(attachment.taskKey, who, 'attachment_deleted', {
      attachmentId: id,
      fileName: attachment.fileName,
      size: attachment.size,
      mediaType: attachment.mediaType,
    });
    this.emit({
      type: 'task_attachments_changed',
      projectKey: fixtures.PROJECT_KEY,
      taskKey: attachment.taskKey,
    });
    this.syncCover(attachment.taskKey);
  }

  /** A session that has not exited or failed. */
  isLive(session: Session): boolean {
    return session.state !== 'exited' && session.state !== 'failed';
  }

  updateTask(key: string, patch: Partial<Task>, actor = this.viewerHandle): Task | undefined {
    const task = this.findTask(key);
    if (!task) return undefined;
    void actor;
    Object.assign(task, patch, { updatedAt: nowIso() });
    if (patch.links) Object.assign(task, withPrMergedLabel(task, this.config));
    this.emit({ type: 'task_upserted', projectKey: task.projectKey, task: clone(task) });
    return task;
  }

  addTimeline(
    taskKey: string | null,
    who: string | null,
    type: TimelineEventType,
    data: Record<string, unknown>,
    sessionId: string | null = null,
    createdAt = nowIso(),
  ): TimelineEvent {
    const member = who ? this.findMember(who) : undefined;
    const event: TimelineEvent = {
      id: mockId('evt'),
      projectKey: fixtures.PROJECT_KEY,
      taskKey,
      sessionId,
      actor: who ? { kind: member?.kind ?? 'system', handle: who } : { kind: 'system', handle: null },
      type,
      data,
      createdAt,
    };
    this.timeline.push(event);
    this.emit({ type: 'timeline_appended', projectKey: event.projectKey, event: clone(event) });
    if (taskKey && type === 'team_message') this.checkLoop(taskKey);
    if (taskKey && type === 'task_stage_changed') this.endLoop(taskKey, 'stage');
    if (taskKey && type === 'task_labels_changed') this.endLoop(taskKey, 'label');
    if (taskKey && isLoopWork(event)) this.endLoop(taskKey, 'work');
    if (taskKey && (type === 'task_labels_changed' || type === 'task_stage_changed')) {
      const task = this.findTask(taskKey);
      if (
        task?.status === 'done' ||
        task?.status === 'cancelled' ||
        stageOf(this.config, task?.stageId ?? '')?.kind === 'done'
      )
        this.endFixLimit(taskKey, 'closed');
      else this.checkFixLimit(taskKey);
    }
    if (taskKey && type === 'task_assigned' && (data.previous || this.findTask(taskKey)?.fixLimit)) {
      this.endFixLimit(taskKey, 'assignee_changed');
      this.fixLimitState.set(taskKey, { countedFrom: nowIso(), extraRounds: 0 });
    }
    return event;
  }

  /** The counted messages of a card for the loop watch (PM-261), by the shared rule the server uses. */
  private loopTalk(taskKey: string, ignore: readonly string[]): LoopTalk[] {
    return this.timeline.flatMap((event) => {
      const from = event.actor.handle;
      const to = Array.isArray(event.data.to) ? (event.data.to as string[]) : [];
      return event.taskKey === taskKey &&
        event.type === 'team_message' &&
        from &&
        countsForLoop(this.config, { from, to }, ignore)
        ? [{ at: event.createdAt, from, to }]
        : [];
    });
  }

  /** The last progress on a card: its creation, a stage or label change, the end of an earlier loop. */
  private loopProgressAt(task: Task): string {
    return this.timeline
      .filter(
        (event) =>
          event.taskKey === task.key &&
          (event.type === 'task_stage_changed' ||
            event.type === 'task_labels_changed' ||
            isLoopWork(event) ||
            (event.type === 'task_loop' && event.data.phase === 'ended')),
      )
      .reduce((latest, event) => (event.createdAt > latest ? event.createdAt : latest), task.createdAt);
  }

  /** The loop watch (PM-261) on a card's team messages: raise a loop, or escalate one that went on. */
  private checkLoop(taskKey: string): void {
    const task = this.findTask(taskKey);
    if (!task) return;
    const watch = loopWatchOf(this.config.team.limits);
    const now = nowIso();
    const open = task.loop;
    if (open) {
      if (open.phase !== 'notified') return;
      const raisedAt = this.timeline
        .filter(
          (event) => event.taskKey === taskKey && event.type === 'task_loop' && event.data.phase === 'raised',
        )
        .reduce((latest, event) => (event.createdAt > latest ? event.createdAt : latest), open.startedAt);
      const again = findLoop(
        this.loopTalk(taskKey, open.notified ? [open.notified] : []),
        raisedAt,
        now,
        watch,
      );
      if (again) this.escalateLoop(task, open, 'continued', watch.minutes);
      return;
    }
    const found = findLoop(this.loopTalk(taskKey, []), this.loopProgressAt(task), now, watch);
    if (!found) return;
    const watcher = loopWatchers(this.config, found.members)[0] ?? null;
    const loop: TaskLoop = {
      id: mockId('loop'),
      members: found.members,
      count: found.count,
      startedAt: found.startedAt,
      lastMessageAt: found.lastMessageAt,
      notified: watcher,
      phase: watcher ? 'notified' : 'owner',
      ownerReason: watcher ? null : 'no_watcher',
      deciders: watcher ? [] : loopDeciders(this.config, boundaryOwners(this.config)),
      letRunBy: null,
    };
    this.updateTask(taskKey, { loop });
    this.addTimeline(taskKey, null, 'task_loop', {
      loopId: loop.id,
      phase: 'raised',
      members: loop.members,
      count: loop.count,
      minutes: watch.minutes,
      notified: watcher,
      ...(watcher ? {} : { deciders: loop.deciders }),
    });
    if (!watcher) this.askLoopDecision(task, loop, 'no_watcher', watch.minutes);
  }

  /** The loop went on after the member was told: it goes to the people. */
  private escalateLoop(task: Task, loop: TaskLoop, reason: 'continued', minutes: number): void {
    const deciders = loopDeciders(this.config, boundaryOwners(this.config));
    const next: TaskLoop = { ...loop, phase: 'owner', ownerReason: reason, deciders };
    this.updateTask(task.key, { loop: next });
    this.addTimeline(task.key, null, 'task_loop', {
      loopId: loop.id,
      phase: 'escalated',
      members: loop.members,
      count: loop.count,
      minutes,
      deciders,
      reason,
    });
    this.askLoopDecision(task, next, reason, minutes);
  }

  private askLoopDecision(
    task: Task,
    loop: TaskLoop,
    reason: 'no_watcher' | 'continued',
    minutes: number,
  ): void {
    const payload: LoopDecisionPayload = {
      loopId: loop.id,
      taskKey: task.key,
      members: loop.members,
      count: loop.count,
      minutes,
      startedAt: loop.startedAt,
      reason,
      watcher: loop.notified,
    };
    this.upsertInbox({
      id: mockId('inb'),
      projectKey: fixtures.PROJECT_KEY,
      kind: 'decision',
      assignees: loop.deciders,
      source: 'system',
      sessionId: null,
      taskKey: task.key,
      title: `Loop on ${task.key}`,
      body: null,
      payload: { loop: payload },
      options: [LOOP_STOP_OPTION, LOOP_LET_RUN_OPTION],
      state: 'open',
      resolution: null,
      createdAt: nowIso(),
    });
  }

  /** The loop is over (progress, quiet, stopped): the mark goes, and the decision about it closes itself. */
  private endLoop(
    taskKey: string,
    endReason: NonNullable<TimelineEventData['task_loop']['endReason']>,
    by?: string,
  ): void {
    const task = this.findTask(taskKey);
    const loop = task?.loop;
    if (!task || !loop) return;
    this.updateTask(taskKey, { loop: undefined });
    for (const item of this.inbox) {
      if (item.state !== 'open' || loopDecisionOf(item)?.loopId !== loop.id) continue;
      this.upsertInbox({
        ...item,
        state: 'resolved',
        resolution: { optionId: 'ended', by: 'system', at: nowIso(), note: null, rule: 'loop_ended' },
      });
    }
    this.addTimeline(taskKey, null, 'task_loop', {
      loopId: loop.id,
      phase: 'ended',
      members: loop.members,
      count: loop.count,
      minutes: loopWatchOf(this.config.team.limits).minutes,
      endReason,
      ...(by ? { by } : {}),
    });
  }

  /** What a person decided about a loop: stop the card's work, or let it run. */
  private afterLoopDecision(item: InboxItem): void {
    const optionId = item.resolution?.optionId;
    const by = item.resolution?.by ?? this.viewerHandle;
    const task = item.taskKey ? this.findTask(item.taskKey) : undefined;
    if (!task?.loop) return;
    if (optionId === 'stop_work') {
      for (const session of this.sessions)
        if (session.workItem.type === 'task' && session.workItem.taskKey === task.key && this.isLive(session))
          this.updateSession(session.id, { state: 'exited', activity: null });
      this.endLoop(task.key, 'stopped', by);
      return;
    }
    // Let run: the mark goes at once, and a new one needs new talk with no progress (PM-431).
    this.endLoop(task.key, 'let_run', by);
  }

  // ---- The fix round limit (PM-262), by the shared rules the server uses.

  private fixState(taskKey: string): { countedFrom: string | null; extraRounds: number } {
    const state = this.fixLimitState.get(taskKey) ?? { countedFrom: null, extraRounds: 0 };
    this.fixLimitState.set(taskKey, state);
    return state;
  }

  private fixRoundsOf(taskKey: string): FixRounds {
    return countFixRounds(
      this.timeline.filter(
        (event) =>
          event.taskKey === taskKey &&
          (event.type === 'task_stage_changed' || event.type === 'task_labels_changed'),
      ),
      this.config,
      this.fixState(taskKey).countedFrom,
    );
  }

  /** The limit the card is held at: the configured one and the rounds people let it have. */
  private fixLimitOf(taskKey: string): number {
    return maxFixRoundsOf(this.config.team.limits) + this.fixState(taskKey).extraRounds;
  }

  private fixLimitData(taskKey: string, rounds: FixRounds) {
    return {
      rounds: rounds.rounds,
      limit: this.fixLimitOf(taskKey),
      changeRequests: rounds.changeRequests,
      designChangeRequests: rounds.designChangeRequests,
      sendBacks: rounds.sendBacks,
    };
  }

  /** A card whose rounds reached the limit is held: the lead decides, or the people when nobody can. */
  private checkFixLimit(taskKey: string): void {
    const task = this.findTask(taskKey);
    if (!task || task.fixLimit || task.status === 'done' || task.status === 'cancelled') return;
    if (!task.assignee || this.findMember(task.assignee)?.kind !== 'ai') return;
    const stage = stageOf(this.config, task.stageId);
    if (!stage || stage.kind === 'queue' || stage.kind === 'done') return;
    const rounds = this.fixRoundsOf(taskKey);
    const state = this.fixState(taskKey);
    if (!fixLimitReached(rounds.rounds, maxFixRoundsOf(this.config.team.limits), state.extraRounds)) return;
    const lead = fixLimitLead(this.config, [task.assignee]);
    if (!lead || state.extraRounds > 0) {
      this.holdForPeople(task, rounds, lead ? 'again' : 'no_ai_decider', null, null);
      return;
    }
    this.updateTask(taskKey, {
      fixLimit: {
        ...this.fixLimitData(taskKey, rounds),
        phase: 'lead',
        decider: lead,
        deciders: [],
        reason: null,
        heldAt: nowIso(),
      },
    });
    this.addTimeline(taskKey, null, 'task_fix_limit', {
      phase: 'reached',
      ...this.fixLimitData(taskKey, rounds),
      decider: lead,
    });
  }

  /** The card goes to the people: one decision item with the buttons that apply. */
  private holdForPeople(
    task: Task,
    rounds: FixRounds,
    reason: NonNullable<TaskFixLimit['reason']>,
    decider: string | null,
    note: string | null,
  ): void {
    const deciders = fixLimitDeciders(this.config, boundaryOwners(this.config));
    const workStage = this.config.pipeline.stages.find((stage) => stage.kind === 'work');
    const others = workStage
      ? stageOwners(this.config, workStage).filter(
          (handle) => handle !== task.assignee && this.findMember(handle)?.kind === 'ai',
        )
      : [];
    const options = [
      ...(fixLimitPlannerForOwner(this.config, task.assignee) ? [FIX_REPLAN_OPTION] : []),
      ...(others.length > 0 ? [FIX_REASSIGN_OPTION] : []),
      FIX_ANOTHER_ROUND_OPTION,
    ];
    const data = this.fixLimitData(task.key, rounds);
    const passedOn = task.fixLimit !== undefined;
    this.updateTask(task.key, {
      fixLimit: {
        ...data,
        phase: 'owner',
        decider: null,
        deciders,
        reason,
        heldAt: task.fixLimit?.heldAt ?? nowIso(),
      },
    });
    this.upsertInbox({
      id: mockId('inb'),
      projectKey: fixtures.PROJECT_KEY,
      kind: 'decision',
      assignees: deciders,
      source: 'system',
      sessionId: null,
      taskKey: task.key,
      title: `Fix round limit on ${task.key}: ${rounds.rounds} rounds`,
      body: null,
      payload: { fixLimit: { taskKey: task.key, ...data, reason, decider, note } },
      options,
      state: 'open',
      resolution: null,
      createdAt: nowIso(),
    });
    this.addTimeline(
      task.key,
      decider,
      'task_fix_limit',
      passedOn
        ? { phase: 'passed_on', ...data, decider, deciders, reason, ...(note ? { note } : {}) }
        : { phase: 'reached', ...data, deciders, reason },
    );
  }

  /** The hold is over: the card goes on, and the decision about it closes itself. */
  private endFixLimit(
    taskKey: string,
    endReason: NonNullable<TimelineEventData['task_fix_limit']['endReason']>,
  ): void {
    const task = this.findTask(taskKey);
    if (!task?.fixLimit) return;
    const data = this.fixLimitData(taskKey, this.fixRoundsOf(taskKey));
    this.updateTask(taskKey, { fixLimit: undefined });
    for (const item of this.inbox) {
      if (item.state !== 'open' || fixLimitDecisionOf(item)?.taskKey !== taskKey) continue;
      this.upsertInbox({
        ...item,
        state: 'resolved',
        resolution: { optionId: 'ended', by: 'system', at: nowIso(), note: null, rule: 'fix_limit_ended' },
      });
    }
    this.addTimeline(taskKey, null, 'task_fix_limit', { phase: 'ended', ...data, endReason });
  }

  /** The held card goes on: one more round, or a fresh count. */
  private releaseFixLimit(
    task: Task,
    by: string,
    decision: NonNullable<TimelineEventData['task_fix_limit']['decision']>,
    note: string | null,
    fresh: boolean,
  ): void {
    const state = this.fixState(task.key);
    this.addTimeline(task.key, by, 'task_fix_limit', {
      phase: 'decided',
      ...this.fixLimitData(task.key, this.fixRoundsOf(task.key)),
      decision,
      by,
      ...(note ? { note } : {}),
    });
    if (fresh) this.fixLimitState.set(task.key, { countedFrom: nowIso(), extraRounds: 0 });
    else state.extraRounds += 1;
    this.endFixLimit(task.key, 'decided');
  }

  /** What a person decided about a held card: a more exact plan, another implementer, or one more round. */
  private afterFixLimitDecision(item: InboxItem): void {
    const optionId = item.resolution?.optionId;
    const by = item.resolution?.by ?? this.viewerHandle;
    const note = item.resolution?.note ?? null;
    const task = item.taskKey ? this.findTask(item.taskKey) : undefined;
    if (!task?.fixLimit) return;
    if (optionId === 'another_round') {
      this.releaseFixLimit(task, by, 'another_round', note, false);
    } else if (optionId === 'replan') {
      const planner = fixLimitPlannerForOwner(this.config, task.assignee);
      if (!planner) {
        this.releaseFixLimit(task, by, 'another_round', note, false);
        return;
      }
      this.addTimeline(task.key, by, 'task_fix_limit', {
        phase: 'decided',
        ...this.fixLimitData(task.key, this.fixRoundsOf(task.key)),
        decision: 'replan',
        by,
      });
      this.updateTask(task.key, {
        fixLimit: { ...task.fixLimit, phase: 'replan', decider: planner, deciders: [] },
      });
    } else if (optionId === 'reassign') {
      const workStage = this.config.pipeline.stages.find((stage) => stage.kind === 'work');
      const next = workStage
        ? stageOwners(this.config, workStage).find(
            (handle) => handle !== task.assignee && this.findMember(handle)?.kind === 'ai',
          )
        : undefined;
      if (!next) return;
      this.releaseFixLimit(task, by, 'reassign', note, true);
      this.updateTask(task.key, { assignee: next });
      this.addTimeline(task.key, null, 'task_assigned', { assignee: next, previous: task.assignee });
    }
  }

  /**
   * The AI member who decides a held card (the tool `decide_fix_limit`): the lead lets it have one more
   * round, asks for a more exact plan or passes it on; the planner then lets it start anew.
   */
  decideFixLimit(taskKey: string, decision: 'continue' | 'replan' | 'to_owner', reason: string): void {
    const task = this.findTask(taskKey);
    const held = task?.fixLimit;
    if (!task || !held || held.phase === 'owner' || !held.decider) return;
    if (decision === 'continue') {
      this.releaseFixLimit(
        task,
        held.decider,
        held.phase === 'lead' ? 'another_round' : 'continue',
        reason,
        held.phase === 'replan',
      );
    } else if (decision === 'replan' && held.phase === 'lead') {
      const planner = fixLimitPlanner(this.config, [held.decider, ...(task.assignee ? [task.assignee] : [])]);
      if (!planner) return;
      this.addTimeline(task.key, held.decider, 'task_fix_limit', {
        phase: 'decided',
        ...this.fixLimitData(taskKey, this.fixRoundsOf(taskKey)),
        decision: 'replan',
        by: held.decider,
        note: reason,
      });
      this.updateTask(taskKey, { fixLimit: { ...held, phase: 'replan', decider: planner } });
    } else if (decision === 'to_owner') {
      this.holdForPeople(task, this.fixRoundsOf(taskKey), 'passed_on', held.decider, reason);
    }
  }

  setMemberState(handle: string, status: MemberView['status'], activity: string | null): void {
    const member = this.findMember(handle);
    if (!member) return;
    member.status = status;
    member.activity = activity;
    this.emit({ type: 'member_state', projectKey: fixtures.PROJECT_KEY, handle, status, activity });
  }

  updateSession(id: string, patch: Partial<Session>): Session | undefined {
    const session = this.findSession(id);
    if (!session) return undefined;
    const wasEnded = !this.isLive(session);
    const stateChanged = patch.state !== undefined && patch.state !== session.state;
    Object.assign(session, patch, {
      lastActivityAt: nowIso(),
      ...(stateChanged ? { stateSince: nowIso() } : {}),
    });
    // A session that runs again no longer rests: the reason of its last stop goes (PM-288).
    if (wasEnded && this.isLive(session)) delete session.lastStop;
    if (wasEnded || session.state === 'idle' || session.state === 'waiting_input')
      this.flushTeamMessages(session);
    if (session.workItem.type === 'schedule' && !this.isLive(session)) {
      const run = this.scheduleRuns.find((r) => r.sessionId === session.id);
      if (run) {
        run.status = session.state === 'failed' ? 'failed' : 'done';
        run.reason = session.state === 'failed' ? 'session_failed' : null;
      }
    }
    this.emit({ type: 'session_upserted', projectKey: session.projectKey, session: clone(session) });
    return session;
  }

  appendChat(sessionId: string, items: ChatItem[]): void {
    const list = (this.chats[sessionId] ??= []);
    list.push(...items);
    this.emit({ type: 'chat_appended', projectKey: fixtures.PROJECT_KEY, sessionId, items: clone(items) });
  }

  chatItem<K extends ChatItem['kind']>(
    kind: K,
    fields: Omit<Extract<ChatItem, { kind: K }>, 'id' | 'ts' | 'kind'>,
  ): Extract<ChatItem, { kind: K }> {
    return { id: mockId('chat'), ts: nowIso(), kind, ...fields } as unknown as Extract<ChatItem, { kind: K }>;
  }

  /**
   * Like the server's one send path (REST, label and @mention notices, answers to questions):
   * the text trimmed, the sender left out of the recipients. A message the server would refuse
   * (`teamMessageRefusal`) is a mistake of the caller.
   */
  sendTeamMessage(
    from: string,
    recipients: readonly string[],
    taskKey: string | null,
    text: string,
    sessionId?: string,
    /** What the message answers: the card thread shows it as a question and its answer (PM-249). */
    answer?: TeamMessageAnswer,
    relayed?: TeamMessage['relayed'],
  ): TeamMessage {
    const refusal = this.teamMessageRefusal(from, recipients, text);
    if (refusal) throw new Error(`The server refuses this team message: ${JSON.stringify(refusal.body)}`);
    const to = teamRecipients(from, recipients);
    const body = text.trim();
    const message: TeamMessage = {
      id: mockId('msg'),
      projectKey: fixtures.PROJECT_KEY,
      from,
      to,
      taskKey,
      body,
      createdAt: nowIso(),
      deliveredAt: to.every((h) => this.findMember(h)?.kind === 'human') ? nowIso() : null,
      receipts: to.map((handle) => ({
        handle,
        kind: this.findMember(handle)?.kind ?? 'human',
        deliveredAt: this.findMember(handle)?.kind === 'human' ? nowIso() : null,
        readAt: null,
      })),
      ...(answer ? { answer } : {}),
      ...(relayed ? { relayed } : {}),
    };
    this.messages.push(message);
    this.emit({ type: 'team_message', projectKey: message.projectKey, message: clone(message) });
    if (taskKey) {
      this.addTimeline(
        taskKey,
        from,
        'team_message',
        {
          messageId: message.id,
          from,
          to,
          excerpt: body.length > 80 ? `${body.slice(0, 77)}…` : body,
        },
        sessionId ?? null,
      );
    }
    if (sessionId)
      this.appendChat(sessionId, [this.chatItem('team_message', { direction: 'out', from, to, text: body })]);
    for (const handle of to) {
      const live = this.sessions.filter((s) => s.member === handle && this.isLive(s));
      const target =
        live.find((s) => s.workItem.type === 'task' && s.workItem.taskKey === taskKey) ?? live[0];
      if (target) this.flushTeamMessages(target);
    }
    return message;
  }

  /**
   * The server's refusal of a team message, or null: 400 invalid_request with `details.field`
   * "text" or "to" for an empty text or no recipient but the sender, 404 for unknown members.
   */
  private teamMessageRefusal(from: string, to: readonly string[], text: string): MockResponse | null {
    if (!text.trim()) return error(400, 'invalid_request', 'The message text is empty', { field: 'text' });
    const recipients = teamRecipients(from, to);
    if (!recipients.length)
      return error(400, 'invalid_request', 'The message names no recipient but its sender', { field: 'to' });
    const unknown = recipients.filter((handle) => !memberOf(this.config, handle));
    if (unknown.length)
      return error(404, 'not_found', `Unknown member: ${unknown.join(', ')}`, {
        what: 'member',
        id: unknown[0],
        ids: unknown,
      });
    return null;
  }

  upsertInbox(item: InboxItem): void {
    const index = this.inbox.findIndex((entry) => entry.id === item.id);
    if (index === -1) this.inbox.push(item);
    else this.inbox[index] = item;
    this.emit({ type: 'inbox_upserted', projectKey: item.projectKey, item: clone(item) });
  }

  /**
   * An outage (PM-468): the open `work_outage` alert for the owners, `outage` on the AI members and
   * on the cards that stand on it. Returns the alert. `endOutage` / a check that finds it healed
   * (`outageRecovers`) closes it the way the server does.
   */
  startOutage(outage: WorkOutage, members: readonly string[], tasks: readonly string[]): InboxItem {
    for (const handle of members) {
      const member = this.findMember(handle);
      if (member) member.outage = clone(outage);
      this.memberChanged(handle);
    }
    for (const key of tasks) this.updateTask(key, { outage: clone(outage) });
    const payload: WorkOutageAlert = {
      alert: 'work_outage',
      outage,
      members: [...members],
      tasks: [...tasks],
      checkedAt: nowIso(),
    };
    const item: InboxItem = {
      id: mockId('inb'),
      projectKey: fixtures.PROJECT_KEY,
      kind: 'alert',
      assignees: boundaryOwners(this.config),
      source: 'system',
      sessionId: null,
      taskKey: null,
      title: 'Work is stopped by an outage',
      body: null,
      payload,
      options: [ALERT_SEEN_OPTION],
      state: 'open',
      resolution: null,
      createdAt: nowIso(),
    };
    this.upsertInbox(item);
    return item;
  }

  /** The outage ends by itself: the markers go, the alert is resolved with the rule `outage_ended`. */
  endOutage(itemId: string): InboxItem | undefined {
    const item = this.inbox.find((entry) => entry.id === itemId);
    if (!item || item.state !== 'open') return undefined;
    const alert = WorkOutageAlert.safeParse(item.payload);
    if (alert.success) {
      for (const handle of alert.data.members) {
        const member = this.findMember(handle);
        if (member) delete member.outage;
        this.memberChanged(handle);
      }
      for (const key of alert.data.tasks) this.updateTask(key, { outage: undefined });
    }
    const resolved: InboxItem = {
      ...item,
      state: 'resolved',
      resolution: {
        optionId: ALERT_SEEN_OPTION.id,
        by: 'system',
        at: nowIso(),
        note: null,
        rule: 'outage_ended',
      },
    };
    this.upsertInbox(resolved);
    return resolved;
  }

  /** Whether the next "check now" finds the outage gone; off until a test or a scenario turns it on. */
  outageRecovers = false;

  private checkOutage(itemId: string): MockResponse {
    const item = this.inbox.find((entry) => entry.id === itemId);
    if (!item) return error(404, 'not_found', 'Unknown inbox item');
    // The server's order: a closed item first, then an item that is no outage alert.
    if (item.state !== 'open') return error(409, 'inbox_item_closed', 'Already closed');
    if (WorkOutageAlert.safeParse(item.payload).success === false)
      return error(409, 'not_an_outage_alert', 'The item is not an outage alert');
    const checkedAt = nowIso();
    if (this.outageRecovers) {
      const resolved = this.endOutage(itemId)!;
      return ok(clone({ item: resolved, stillFailing: false, checkedAt }));
    }
    const refreshed: InboxItem = { ...item, payload: { ...item.payload, checkedAt } };
    this.upsertInbox(refreshed);
    return ok(clone({ item: refreshed, stillFailing: true, checkedAt }));
  }

  /**
   * The roster's permission fields follow the configuration (a level, the delegation settings, the
   * deciders). Every commit does it; a test that edits `config` directly calls it itself.
   */
  syncPermissionViews(): void {
    for (const member of this.members) {
      const config = memberOf(this.config, member.handle);
      if (config?.kind !== 'ai') continue;
      delete member.permissionLegacy;
      delete member.aiApproverBlocker;
      Object.assign(member, permissionView(this.config, config));
    }
  }

  private commitConfig(message: string): void {
    this.syncPermissionViews();
    this.configVersion = Math.random().toString(16).slice(2, 9);
    this.history.unshift({ version: this.configVersion, message, author: this.user.name, at: nowIso() });
    this.emit({ type: 'config_changed', projectKey: fixtures.PROJECT_KEY, version: this.configVersion });
  }

  private memberChanged(handle: string): void {
    const member = this.findMember(handle);
    this.emit({
      type: 'member_changed',
      projectKey: fixtures.PROJECT_KEY,
      handle,
      member: member && member.status !== 'retired' ? this.viewOf(member) : null,
    });
  }

  private board(): BoardView {
    const stages = resolvedStages(this.config);
    return {
      project: {
        ...fixtures.projectSummary,
        name: this.config.project.name,
        configVersion: this.configVersion,
      },
      columns: this.config.pipeline.columns.map((column) => ({
        ...column,
        stageIds: stages.filter((stage) => stage.columnId === column.id).map((stage) => stage.id),
      })),
      stages: clone(stages),
      labels: this.config.pipeline.labels.map((label) => ({
        ...clone(label),
        holders: labelHolders(this.config, label),
      })),
      tasks: clone(this.tasks.filter((task) => this.canSee(task))),
      members: this.members.filter((member) => member.status !== 'retired').map((m) => this.viewOf(m)),
      openInboxCount: this.inbox.filter(
        (item) => item.state === 'open' && item.assignees.includes(this.owner),
      ).length,
      aiEnabled: this.config.team.limits.aiEnabled,
      // A client member does not see it (like the server).
      ...(this.findMember(this.viewerHandle)?.role === 'client' ? {} : { pause: this.pauses.projectView() }),
      planUsage: { ...this.planUsage, fetchedAt: nowIso() },
      planUsageByProvider: Object.fromEntries(
        [
          ...new Set(
            this.members
              .filter((member) => member.kind === 'ai' && member.status !== 'retired')
              .map((member) => member.provider ?? DEFAULT_AGENT_PROVIDER),
          ),
        ]
          .filter(hasPlanUsage)
          .map((provider) => [provider, this.planUsageFor(provider)]),
      ),
    };
  }

  /* ---------- REST ---------- */

  handle(method: string, path: string, body: unknown, query = new URLSearchParams()): MockResponse {
    const publicInvite = /^\/api\/invites\/([^/]+)(\/accept)?$/.exec(path);
    if (publicInvite) return this.handlePublicInvite(method, publicInvite[1]!, !!publicInvite[2], body);
    if (path === '/api/setup') {
      if (method === 'GET') {
        const needsSetup = this.auth === 'setup';
        return ok({ needsSetup, ...(needsSetup && this.setupCode !== null ? { needsSetupCode: true } : {}) });
      }
      const input = parseBody(SetupRequest, body);
      if (!input) return error(400, 'invalid_request', 'Invalid setup request');
      if (this.setupCode !== null && input.setupCode?.replace(/[\s-]/g, '').toUpperCase() !== this.setupCode)
        return error(403, 'setup_code_invalid', 'The setup code is missing or wrong');
      this.user = { ...this.user, name: input.name, email: input.email };
      this.accounts.set(input.email.trim().toLowerCase(), {
        ...this.user,
        email: input.email.trim().toLowerCase(),
        password: input.password,
      });
      this.auth = 'ready';
      return ok({ ...this.me() });
    }
    if (path === '/api/auth/login' && method === 'POST') {
      const input = parseBody(LoginRequest, body);
      if (!input || input.password.length < 3)
        return error(401, 'invalid_credentials', 'Invalid email or password');
      const account = this.accounts.get(input.email.trim().toLowerCase());
      if (account && account.userId !== fixtures.mockUser.userId) {
        if (input.password !== account.password)
          return error(401, 'invalid_credentials', 'Invalid email or password');
        this.user = { userId: account.userId, name: account.name, email: account.email };
        this.viewerHandle =
          this.config.team.members.find(
            (member) => member.kind === 'human' && member.email?.toLowerCase() === account.email,
          )?.handle ?? '';
      } else if (account) {
        this.user = { userId: account.userId, name: account.name, email: account.email };
        this.viewerHandle = fixtures.OWNER;
      } else return error(401, 'invalid_credentials', 'Invalid email or password');
      this.auth = 'ready';
      return ok(this.me());
    }
    if (path === '/api/auth/logout' && method === 'POST') {
      this.auth = 'login';
      return ok();
    }
    if (this.auth !== 'ready') return error(401, 'unauthorized', 'Login required');

    if (path === '/api/me') return ok(this.me());
    if (path === '/api/auth/integrator-key') {
      if (!this.me().hostOwner) return error(403, 'owner_only', 'Only the host owner may manage the key');
      if (method === 'POST') {
        const input = parseBody(CreateIntegratorKeyRequest, body ?? {});
        if (!input) return error(400, 'invalid_request', 'Invalid key request');
        this.integratorKey = {
          prefix: 'pmi_mock_key',
          state: 'active',
          createdAt: nowIso(),
          expiresAt:
            input.expiresInDays === null
              ? null
              : new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString(),
          lastUsedAt: null,
          revokedAt: null,
        };
        return {
          status: 201,
          body: { key: clone(this.integratorKey), secret: 'pmi_mock_key_for_ui_tests_only' },
        };
      }
      if (method === 'DELETE') {
        if (!this.integratorKey || this.integratorKey.state !== 'active')
          return error(404, 'not_found', 'No active key');
        this.integratorKey = { ...this.integratorKey, state: 'revoked', revokedAt: nowIso() };
      }
      return ok({ key: clone(this.integratorKey) });
    }
    if (path === '/api/engines' || path.startsWith('/api/engines/'))
      return this.engineRoutes(method, path, body);
    if (path === '/api/machine' || path === '/api/machine/orphans/stop') {
      if (!this.me().instanceOwner) return error(403, 'insufficient_access', 'Instance owner required');
      if (path === '/api/machine' && this.machineError)
        return error(409, this.machineError, 'The engine is not connected');
      if (path === '/api/machine' && method === 'GET') return ok(this.machine ?? this.machineView());
      if (path === '/api/machine/orphans/stop' && method === 'POST') {
        const input = parseBody(StopOrphansRequest, body);
        if (!input) return error(400, 'invalid_request', 'Invalid orphan identities');
        const results = input.orphans.map((identity) => {
          const exists = this.machine?.orphans?.some(
            (row) => row.pid === identity.pid && row.startedAt === identity.startedAt,
          );
          const outcome = this.orphanStopOutcomes[identity.pid] ?? (exists ? 'stopped' : 'gone');
          if ((outcome === 'stopped' || outcome === 'gone') && this.machine?.orphans)
            this.machine.orphans = this.machine.orphans.filter(
              (row) => row.pid !== identity.pid || row.startedAt !== identity.startedAt,
            );
          return { ...identity, outcome };
        });
        return ok({ results });
      }
    }
    if (/^\/api\/pause(\/resume|\/force)?$/.test(path)) return this.instancePause(method, path);
    if ((path === '/api/providers' && method === 'GET') || path === '/api/providers/nanogpt/key') {
      if (path === '/api/providers' && this.providersFail)
        return error(503, 'internal_error', 'Providers unavailable');
      const member = memberOf(this.config, this.viewerHandle);
      const canManageKeys =
        this.canManageKeys ?? canManageProviderKeys([member?.kind === 'human' ? member.access : null]);
      if (path === '/api/providers/nanogpt/key') {
        if (!canManageKeys)
          return error(403, 'insufficient_access', 'Only an owner of every project may manage provider keys');
        if (method === 'PUT') {
          const input = parseBody(SetProviderKeyRequest, body);
          if (!input) return error(400, 'invalid_request', 'Invalid key');
          if (input.key === 'rejected') return error(400, 'nanogpt_key_rejected', 'Provider rejected key');
          this.nanogptKeyStatus = { set: true, setAt: nowIso() };
          if (this.providerStatus.nanogpt?.problem === 'no_key') delete this.providerStatus.nanogpt;
        } else if (method === 'DELETE') {
          this.nanogptKeyStatus = { set: false, setAt: null };
          if (
            this.providerStatus.nanogpt?.loggedIn === true ||
            this.providerStatus.nanogpt?.problem === 'no_key'
          )
            delete this.providerStatus.nanogpt;
        } else return error(404, 'not_found', 'Unknown provider key route');
      }
      return ok({
        keys: { nanogpt: { ...this.nanogptKeyStatus } },
        canManageKeys,
        providers: AgentProvider.options.map((provider) => ({
          provider,
          loggedIn: provider === 'nanogpt' ? this.nanogptKeyStatus.set : this.providerLoggedIn[provider],
          method:
            provider === 'nanogpt'
              ? 'api_key'
              : this.providerLoggedIn[provider]
                ? provider === 'claude'
                  ? 'claude.ai'
                  : provider === 'gemini'
                    ? 'google'
                    : 'chatgpt'
                : 'none',
          checkedAt: nowIso(),
          problem:
            provider === 'nanogpt'
              ? this.nanogptKeyStatus.set
                ? undefined
                : 'no_key'
              : this.providerLoggedIn[provider]
                ? undefined
                : 'not_logged_in',
          ...this.providerStatus[provider],
        })),
      });
    }
    if (path === '/api/templates') return ok(clone(fixtures.templates));
    if (path === '/api/projects') {
      if (method === 'POST') {
        const input = parseBody(CreateProjectRequest, body);
        if (!input) return error(400, 'invalid_request', 'Invalid project');
        if (input.key === fixtures.PROJECT_KEY || this.extraProjects.some((p) => p.key === input.key)) {
          return error(409, 'project_exists', 'Project key already exists');
        }
        this.extraProjects.push({ key: input.key, name: input.name, templateId: input.templateId });
        return ok({
          key: input.key,
          name: input.name,
          templateId: input.templateId,
          configVersion: '0000000',
        });
      }
      return ok([
        { ...fixtures.projectSummary, name: this.config.project.name, configVersion: this.configVersion },
        ...this.extraProjects.map((p) => ({ ...p, configVersion: '0000000' })),
      ]);
    }

    const match = /^\/api\/projects\/([A-Z][A-Z0-9]{0,9})(\/.*)?$/.exec(path);
    if (!match) return error(404, 'not_found', `No route for ${method} ${path}`);
    const key = match[1]!;
    const rest = match[2] ?? '';
    if (key !== fixtures.PROJECT_KEY) return error(404, 'not_found', `Unknown project ${key}`);
    return this.handleProject(method, rest, body, query);
  }

  private me() {
    const member = memberOf(this.config, this.viewerHandle);
    return {
      ...this.user,
      hostOwner: this.user.userId === fixtures.mockUser.userId,
      instanceOwner: canManageInstancePause([member?.kind === 'human' ? member.access : null]),
      handles: this.viewerHandle ? { [fixtures.PROJECT_KEY]: this.owner } : {},
      projects:
        member?.kind === 'human'
          ? [
              {
                key: fixtures.PROJECT_KEY,
                name: this.config.project.name,
                access: member.access,
                roles: member.roles,
              },
            ]
          : [],
    };
  }

  /** Adds an engine to the fake registry; the first one ever created is the default (as on the server). */
  addEngine(input: Partial<EngineView> & { name: string }): EngineView {
    const seq = this.engines.length + 1;
    const engine: EngineView = {
      id: `eng_${String(seq).padStart(12, 'a')}`,
      isDefault: this.engines.length === 0,
      online: false,
      lastSeenAt: null,
      keyPrefix: `pme_${String(seq).padStart(4, '0')}`,
      createdAt: nowIso(),
      createdBy: fixtures.mockUser.userId,
      revokedAt: null,
      lastSeenIp: null,
      hostname: null,
      platform: null,
      version: null,
      versionMismatch: false,
      providers: [],
      runningSessions: 0,
      waitingStarts: 0,
      waitingMessages: 0,
      ...input,
    };
    this.engines.push(engine);
    return engine;
  }

  /** Connects or disconnects an engine and tells the browsers, as the server does. */
  setEngineOnline(id: string, online: boolean): void {
    const engine = this.engines.find((entry) => entry.id === id);
    if (!engine) return;
    engine.online = online;
    engine.lastSeenAt = nowIso();
    this.emit({ type: 'engine_changed', engine: this.engineStatus(engine) });
  }

  private engineStatus(engine: EngineView): EngineStatusView {
    return {
      id: engine.id,
      name: engine.name,
      isDefault: engine.isDefault,
      online: engine.online,
      lastSeenAt: engine.lastSeenAt,
    };
  }

  private engineRoutes(method: string, path: string, body: unknown): MockResponse {
    const me = this.me();
    if (path === '/api/engines/status' && method === 'GET') {
      if (this.engineMode === 'single') return ok({ mode: 'single', engines: [] });
      if (!me.hostOwner && this.viewerAccess() === 'client')
        return error(403, 'insufficient_access', 'Engine status requires internal membership');
      return ok({
        mode: 'cloud',
        engines: this.engines.filter((engine) => !engine.revokedAt).map((e) => this.engineStatus(e)),
      });
    }
    if (!me.hostOwner) return error(403, 'owner_only', 'Only the host owner may manage engines');
    if (this.engineMode === 'single') return error(404, 'not_found', 'Engines are not available');
    if (path === '/api/engines' && method === 'GET') return ok(clone(this.engines));
    if (this.engineLoginRequired)
      return error(403, 'owner_login_required', 'Log in again to manage engines', { category: 'engines' });
    if (path === '/api/engines' && method === 'POST') {
      const input = parseBody(CreateEngineRequest, body);
      if (!input) return error(400, 'invalid_request', 'Invalid engine name');
      const engine = this.addEngine({ name: input.name });
      this.lastEngineKey = `pme_mock_${engine.id}_for_ui_tests_only`;
      this.emit({ type: 'engine_changed', engine: this.engineStatus(engine) });
      return { status: 201, body: { engine: clone(engine), key: this.lastEngineKey } };
    }
    const m = /^\/api\/engines\/(local|eng_[a-z0-9]{12})\/(revoke|default)$/.exec(path);
    if (m && method === 'POST') {
      const engine = this.engines.find((entry) => entry.id === m[1]);
      if (!engine) return error(404, 'engine_not_found', 'Unknown engine');
      if (engine.revokedAt) return error(409, 'engine_revoked', 'The engine is revoked');
      if (m[2] === 'revoke') {
        engine.revokedAt = nowIso();
        engine.isDefault = false;
        engine.online = false;
        // Like the server, a revoked engine is announced with the ordinary change event.
        this.emit({ type: 'engine_changed', engine: this.engineStatus(engine) });
        return ok(clone(engine));
      }
      for (const entry of this.engines) {
        const isDefault = entry.id === engine.id;
        if (entry.isDefault === isDefault) continue;
        entry.isDefault = isDefault;
        this.emit({ type: 'engine_changed', engine: this.engineStatus(entry) });
      }
      return ok(clone(this.engines));
    }
    return error(404, 'not_found', `No route for ${method} ${path}`);
  }

  private machineView(): MachineView {
    const live = this.sessions.filter((session) => this.isLive(session));
    return {
      sampledAt: nowIso(),
      intervalMs: 15000,
      summary: {
        cpuPercent: 34,
        cores: 8,
        memoryUsedBytes: 6 * 1024 ** 3,
        memoryTotalBytes: 16 * 1024 ** 3,
        memoryPressure: 'normal',
        swapUsedBytes: 0,
        swapTotalBytes: 0,
        sessionsRunning: live.length,
        sessionsWorking: live.filter((session) => session.state === 'working' || session.state === 'starting')
          .length,
      },
      sessions: live.map((session, index) => ({
        sessionId: session.id,
        projectKey: session.projectKey,
        memberHandle: session.member,
        member: this.members.find((member) => member.handle === session.member) ?? null,
        workItem: session.workItem,
        taskTitle:
          session.workItem.type === 'task' ? (this.findTask(session.workItem.taskKey)?.title ?? null) : null,
        state: session.state,
        stateSince: session.stateSince ?? session.lastActivityAt,
        paused: !!session.pause,
        pid: 1000 + index,
        processStartedAt: session.startedAt,
        cpuPercent: 8,
        memoryBytes: (640 + index * 100) * 1024 ** 2,
        processCount: 1,
        top: [],
      })),
      orphans: [],
      others: [
        { kind: 'server', name: 'projectman', cpuPercent: 2, memoryBytes: 120 * 1024 ** 2, processCount: 1 },
      ],
      rest: { cpuPercent: 10, memoryBytes: 1024 ** 3 },
      closedSessions: this.sessions.filter((session) => !this.isLive(session)).length,
    };
  }

  private handleProject(method: string, rest: string, body: unknown, query: URLSearchParams): MockResponse {
    let m: RegExpExecArray | null;
    const restricted =
      rest.startsWith('/invites') ||
      (rest === '/roles' && method !== 'GET') ||
      (rest.startsWith('/roles/') && method !== 'GET') ||
      (rest.startsWith('/members') && method !== 'GET' && !rest.endsWith('/conversation')) ||
      /\/tasks\/[^/]+\/cancel$/.test(rest) ||
      // A theme is reopened from developer access, any other card by an admin (like the server).
      this.reopensNonTheme(rest) ||
      (rest.startsWith('/tasks/') &&
        method === 'PATCH' &&
        body !== null &&
        typeof body === 'object' &&
        'assignee' in body);
    const viewer = this.findMember(this.viewerHandle);
    if (!viewer) return error(403, 'not_a_member', 'Not a member');
    if (restricted && (viewer.kind !== 'human' || !['owner', 'admin'].includes(viewer.role)))
      return error(403, 'insufficient_access', 'Owner or admin required');
    if (
      (rest === '/tasks' && method === 'POST') ||
      (rest.startsWith('/tasks/') && method === 'PATCH') ||
      /\/tasks\/[^/]+\/(close-theme|reopen|board-move)$/.test(rest)
    ) {
      if (viewer.kind !== 'human' || !['owner', 'admin', 'developer'].includes(viewer.role))
        return error(403, 'insufficient_access', 'Developer access required');
    }
    if (rest.startsWith('/invites')) return this.handleInvitations(method, rest, body);
    if (rest === '' && method === 'GET')
      return ok({
        ...fixtures.projectSummary,
        name: this.config.project.name,
        configVersion: this.configVersion,
      });
    if (rest === '/schedules' && method === 'GET') return ok(this.schedulesView());
    const scheduleMatch = /^\/members\/([\w-]+)\/schedule\/run$/.exec(rest);
    if (scheduleMatch && method === 'POST') return this.runSchedule(scheduleMatch[1]!);
    if (rest === '/board') return ok(this.board());
    if (rest === '/project-manager' && method === 'GET') return this.projectManagerChannel();
    if (/^\/pause(\/resume|\/force)?$/.test(rest)) return this.projectPause(method, rest);
    if (rest === '/measure/closed-cards' && method === 'GET') {
      if (viewer.role === 'client') return error(403, 'insufficient_access', 'Internal access required');
      return ok(this.closedCardsMeasure(Number(query.get('days') ?? DEFAULT_CLOSED_CARDS_DAYS)));
    }

    if (rest === '/tasks') {
      if (method === 'POST') return this.createTask(body);
      return ok(clone(this.tasks));
    }
    if ((m = /^\/tasks\/([A-Z][A-Z0-9]*-\d+)$/.exec(rest))) {
      const task = this.findTask(m[1]!);
      if (!task) return error(404, 'not_found', 'Unknown task');
      if (method === 'PATCH') {
        const input = parseBody(UpdateTaskRequest, body);
        if (!input) return error(400, 'invalid_request', 'Invalid task update');
        return this.changeTask(task, input);
      }
      return ok(this.taskDetail(task));
    }
    if ((m = /^\/tasks\/([A-Z][A-Z0-9]*-\d+)\/handoffs\/([^/]+)$/.exec(rest)) && method === 'GET') {
      const record = this.handoffRecords.get(m[2]!);
      if (!record || record.taskKey !== m[1]) return error(404, 'not_found', 'Unknown handoff');
      const { taskKey: _taskKey, ...view } = record;
      return ok(clone(view));
    }
    if ((m = /^\/tasks\/([A-Z][A-Z0-9]*-\d+)\/comments$/.exec(rest)) && method === 'POST') {
      if (viewer.kind !== 'human' || !['owner', 'admin', 'developer'].includes(viewer.role))
        return error(403, 'insufficient_access', 'Developer access required');
      const input = parseBody(CreateTaskCommentRequest, body);
      if (!input) return error(400, 'invalid_request', 'Invalid comment');
      if ((input.importedAuthor !== undefined || input.importedAt !== undefined) && viewer.role !== 'owner')
        return error(403, 'insufficient_access', 'Owner access required');
      const task = this.findTask(m[1]!);
      if (!task) return error(404, 'not_found', 'Unknown task');
      const { text, ...importedFrom } = input;
      this.recordNote(task, text, this.viewerActor(), importedFrom);
      return { status: 201, body: this.taskDetail(task) };
    }
    if ((m = /^\/tasks\/([A-Z][A-Z0-9]*-\d+)\/labels$/.exec(rest)) && method === 'POST') {
      if (viewer.kind !== 'human' || !['owner', 'admin', 'developer'].includes(viewer.role))
        return error(403, 'insufficient_access', 'Developer access required');
      const input = parseBody(ChangeTaskLabelsRequest, body);
      if (!input) return error(400, 'invalid_request', 'Invalid label change');
      const task = this.findTask(m[1]!);
      if (!task) return error(404, 'not_found', 'Unknown task');
      const refused = this.applyLabels(task, input, this.viewerActor(), { comment: input.comment });
      return refused ?? ok(this.taskDetail(task));
    }
    if ((m = /^\/tasks\/([A-Z][A-Z0-9]*-\d+)\/attachments(?:\/(att_[a-z0-9]+))?$/.exec(rest))) {
      return this.handleAttachments(method, m[1]!, m[2], body);
    }
    if ((m = /^\/tasks\/([A-Z][A-Z0-9]*-\d+)\/cover$/.exec(rest)) && method === 'PUT') {
      return this.handleCover(m[1]!, body);
    }
    if ((m = /^\/tasks\/([A-Z][A-Z0-9]*-\d+)\/start$/.exec(rest)) && method === 'POST') {
      return this.startTask(m[1]!, body);
    }
    if ((m = /^\/tasks\/([A-Z][A-Z0-9]*-\d+)\/board-move$/.exec(rest)) && method === 'POST') {
      return this.boardMove(m[1]!, body);
    }

    if (
      (m = /^\/tasks\/([A-Z][A-Z0-9]*-\d+)\/(cancel|reopen|close-theme)$/.exec(rest)) &&
      method === 'POST'
    ) {
      return this.taskLifecycle(m[1]!, m[2]!, body);
    }
    if (rest === '/roles') {
      if (method === 'GET') return ok({ roles: roleViews(this.config) });
      if (method === 'POST') return this.saveRole(undefined, body);
    }
    if ((m = /^\/roles\/([a-z][a-z0-9_]+)$/.exec(rest))) {
      if (method === 'PUT') return this.saveRole(m[1]!, body);
      if (method === 'DELETE') return this.deleteRole(m[1]!);
    }
    if ((m = /^\/members\/([a-z0-9-]+)$/.exec(rest)) && method === 'PATCH')
      return this.editMember(m[1]!, body);

    if (rest === '/members/human' && method === 'POST') return this.addHuman(body);
    if (rest === '/members') {
      if (method === 'POST') return this.hire(body);
      return ok(this.members.filter((member) => member.status !== 'retired').map((m) => this.viewOf(m)));
    }
    if ((m = /^\/members\/([a-z0-9-]+)$/.exec(rest)) && method === 'DELETE') return this.retire(m[1]!, body);

    if ((m = /^\/sessions\/([\w-]+)$/.exec(rest)) && method === 'PATCH')
      return this.updateSessionPermissions(m[1]!, body);
    if ((m = /^\/sessions\/([\w-]+)$/.exec(rest))) {
      const session = this.findSession(m[1]!);
      if (!session) return error(404, 'not_found', 'Unknown session');
      const sessionError = this.sessionErrors.get(session.id);
      if (sessionError) return error(409, sessionError, 'The engine is not connected');
      const task = session.workItem.type === 'task' ? this.findTask(session.workItem.taskKey) : undefined;
      return ok({
        session: clone(session),
        chat: clone(this.chats[session.id] ?? []),
        task: task ? clone(task) : null,
      });
    }
    if ((m = /^\/sessions\/([\w-]+)\/messages$/.exec(rest)) && method === 'POST')
      return this.sessionMessage(m[1]!, body);
    if ((m = /^\/sessions\/([\w-]+)\/stop$/.exec(rest)) && method === 'POST')
      return this.stopSession(m[1]!, body);

    if (rest === '/involvements' && method === 'GET') {
      if (this.viewerAccess() === 'client') return error(403, 'insufficient_access', 'Internal only');
      const input = parseBody(InvolvementQuery, Object.fromEntries(query));
      if (!input) return error(400, 'invalid_request', 'Invalid involvement query');
      const events = this.timeline
        .filter((event) => {
          if (!['session_started', 'session_ended'].includes(event.type)) return false;
          const start = event.data.cause as import('@projectman/shared').SessionStartCause | undefined;
          const stop = event.data.stop as SessionStop | undefined;
          if (
            stop?.kind === 'restart' ||
            (input.member && event.data.member !== input.member) ||
            (input.task && event.taskKey !== input.task) ||
            (input.since && event.createdAt < input.since)
          )
            return false;
          if (input.kind && event.type !== (input.kind === 'started' ? 'session_started' : 'session_ended'))
            return false;
          if (!input.by) return true;
          if (!start && !stop) return false;
          const by = start?.by ?? stop?.by;
          return input.by === 'integrator'
            ? by?.via === 'integrator'
            : input.by === 'system'
              ? !by || by.kind === 'system'
              : by?.handle === input.by && !by.via;
        })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      const offset = input.before ? Number(input.before) : 0;
      const page = events.slice(offset, offset + input.limit);
      return ok({
        items: page.map((event) => {
          const cause = event.data.cause as import('@projectman/shared').SessionStartCause | undefined;
          const message = cause?.messageId
            ? this.messages.find((entry) => entry.id === cause.messageId)
            : null;
          let visible = event;
          if (
            cause?.quote &&
            cause.messageId &&
            (!message ||
              !canSeeTeamMessage({ handle: this.viewerHandle, access: this.viewerAccess() }, message))
          ) {
            const { quote: _quote, ...rest } = cause;
            visible = { ...event, data: { ...event.data, cause: rest } };
          }
          return {
            event: clone(visible),
            taskTitle: event.taskKey ? (this.findTask(event.taskKey)?.title ?? null) : null,
          };
        }),
        counts: {
          started: events.filter((event) => event.type === 'session_started').length,
          stopped: events.filter((event) => event.type === 'session_ended').length,
        },
        nextBefore: offset + input.limit < events.length ? String(offset + input.limit) : null,
      });
    }

    if (rest === '/messages') {
      if (method === 'POST') return this.humanTeamMessage(body);
      const peer = query.get('threadWith');
      const member = query.get('member');
      const taskKey = query.get('taskKey');
      const involves = (message: TeamMessage, handle: string) =>
        message.from === handle || message.to.includes(handle);
      const limit = Number(query.get('limit') ?? 200);
      // Like the server: the conversation of a card the viewer cannot see is not theirs to learn of.
      if (taskKey) {
        const card = this.findTask(taskKey);
        if (card && !this.canSee(card)) return error(404, 'not_found', 'Unknown task');
      }
      const listed = this.visibleMessages()
        .filter((message) => !peer || threadPeersOf(message, this.viewerHandle).includes(peer))
        .filter((message) => !member || involves(message, member))
        .filter((message) => !taskKey || message.taskKey === taskKey)
        .filter((message) => query.get('unreadOnly') !== 'true' || isUnreadBy(message, this.viewerHandle));
      return ok({
        messages: clone(listed.slice(-limit)),
        unreadCount: this.messages.filter((message) => isUnreadBy(message, this.viewerHandle)).length,
      });
    }
    if ((m = /^\/messages\/([\w-]+)\/read$/.exec(rest)) && method === 'POST') {
      const message = this.messages.find((entry) => entry.id === m![1]);
      if (!message) return error(404, 'not_found', 'Unknown message');
      if (!message.to.includes(this.viewerHandle))
        return error(403, 'not_a_recipient', 'Only recipients may mark read');
      this.markMessageRead(message);
      return ok(clone(message));
    }
    if (rest === '/messages/read' && method === 'POST') {
      const input = parseBody(ReadTeamMessagesRequest, body);
      if (!input) return error(400, 'invalid_request', 'Invalid read request');
      const changed = [...new Set(input.ids)]
        .map((id) => this.messages.find((entry) => entry.id === id))
        .filter((message): message is TeamMessage => !!message && isUnreadBy(message, this.viewerHandle));
      for (const message of changed) this.markMessageRead(message);
      return ok({
        messages: clone(changed),
        unreadCount: this.messages.filter((message) => isUnreadBy(message, this.viewerHandle)).length,
      });
    }
    if (rest === '/messages/threads' && method === 'GET') {
      // Like the server: over every message of the viewer, the latest conversation last, then reversed.
      const threads = new Map<string, { lastMessage: TeamMessage; unreadCount: number }>();
      for (const message of this.visibleMessages()) {
        for (const peer of threadPeersOf(message, this.viewerHandle)) {
          const unread = isUnreadBy(message, this.viewerHandle) ? 1 : 0;
          const before = threads.get(peer);
          threads.delete(peer);
          threads.set(peer, { lastMessage: message, unreadCount: (before?.unreadCount ?? 0) + unread });
        }
      }
      return ok({
        threads: clone([...threads].reverse().map(([peer, thread]) => ({ peer, ...thread }))),
        unreadCount: this.messages.filter((message) => isUnreadBy(message, this.viewerHandle)).length,
      });
    }
    if ((m = /^\/members\/([a-z0-9-]+)\/(profile|memories|conversation|remove)$/.exec(rest))) {
      const handle = m[1]!;
      const member = this.findMember(handle);
      const original = memberOf(this.config, handle);
      if (!member || !original || member.status === 'retired')
        return error(404, 'not_found', 'Unknown member');
      if (m[2] === 'conversation' && method === 'POST') return this.startConversation(handle);
      if (m[2] === 'memories' && method === 'GET') {
        if (viewer.role === 'client') return error(403, 'insufficient_access', 'Internal access required');
        if (member.kind !== 'ai') return error(400, 'not_ai_member', 'Only AI members have memory');
        return ok({ memory: this.memories[handle] ?? '' });
      }
      if (m[2] === 'remove' && method === 'DELETE') {
        if (handle === this.viewerHandle) return error(403, 'cannot_remove_self', 'Cannot remove yourself');
        if (original.kind !== 'human') return error(400, 'not_human_member', 'Only humans can be removed');
        const next = clone(this.config);
        next.team.members = next.team.members.filter((entry) => entry.handle !== handle);
        for (const stage of next.pipeline.stages)
          if (stage.owners) stage.owners = stage.owners.filter((h) => h !== handle);
        const failure = this.configChangeFailure(next);
        if (failure) return failure;
        this.config = next;
        for (const item of this.inbox.filter((i) => i.state === 'open' && i.assignees.includes(handle))) {
          const remaining = item.assignees.filter((h) => h !== handle);
          item.assignees = remaining.length
            ? remaining
            : next.team.members
                .filter((m) => m.kind === 'human' && m.access === 'owner')
                .map((m) => m.handle);
          this.emit({ type: 'inbox_upserted', projectKey: fixtures.PROJECT_KEY, item: clone(item) });
        }
        this.members = this.members.filter((entry) => entry.handle !== handle);
        for (const task of this.tasks.filter((t) => t.assignee === handle))
          this.updateTask(task.key, { assignee: null });
        this.commitConfig(`Remove human member ${handle}`);
        this.memberChanged(handle);
        return ok();
      }
      if (m[2] === 'profile' && method === 'GET') {
        const internal = viewer.role !== 'client';
        const visible = this.tasks.filter((t) => isOpenTask(t) && this.canSee(t));
        const awaiting = new Set(
          this.inbox.filter((i) => i.state === 'open' && i.assignees.includes(handle)).map((i) => i.taskKey),
        );
        const stages = this.config.pipeline.stages
          .filter((stage) => stageApprovers(this.config, stage).includes(handle))
          .map((stage) => stage.id);
        return ok({
          member: {
            ...this.viewOf(member),
            currentTaskKeys: member.currentTaskKeys.filter((k) => visible.some((t) => t.key === k)),
          },
          duties: memberDuties(this.config, original),
          tasks: clone(
            visible.filter(
              (t) =>
                t.assignee === handle ||
                member.currentTaskKeys.includes(t.key) ||
                stages.includes(t.stageId) ||
                awaiting.has(t.key),
            ),
          ),
          inbox: clone(
            this.inbox.filter(
              (i) =>
                i.state === 'open' &&
                i.assignees.includes(handle) &&
                (internal || handle === this.viewerHandle),
            ),
          ),
          timeline: internal
            ? clone(
                this.timeline
                  .filter(
                    (e) =>
                      e.actor.handle === handle ||
                      e.data.handle === handle ||
                      e.data.member === handle ||
                      e.data.assignee === handle ||
                      (Array.isArray(e.data.to) && e.data.to.includes(handle)),
                  )
                  .slice(-30),
              )
            : [],
          sessions: internal
            ? clone(
                this.sessions
                  .filter((s) => s.member === handle)
                  .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)),
              )
            : [],
          capacity: original.kind === 'ai' ? original.capacity : null,
          capacityUsed: original.kind === 'ai' && internal ? this.memberLoad(handle) : 0,
          ...(original.kind === 'ai' && internal ? { usage: this.memberUsage(handle) } : {}),
          ...(original.kind === 'human' && ['owner', 'admin'].includes(viewer.role) && original.email
            ? { email: original.email }
            : {}),
        });
      }
    }
    if (rest === '/inbox') {
      this.refreshBoundaryInbox();
      return ok({ items: clone(this.inbox) });
    }
    if ((m = /^\/boundary\/([\w-]+)$/.exec(rest)) && method === 'GET') {
      this.refreshBoundaryInbox();
      const item = this.inbox.find((i) => i.id === m![1] && i.kind === 'boundary');
      const parsed = BoundaryRequest.safeParse(item?.payload.boundary);
      if (!parsed.success) return error(404, 'not_found', 'Unknown boundary request');
      if (!canReadBoundary(this.config, parsed.data, this.viewerHandle))
        return error(403, 'not_an_assignee', 'Boundary request is private');
      return ok({
        request: clone(parsed.data),
        grant: clone(this.boundaryGrants.get(parsed.data.id) ?? null),
      });
    }
    if ((m = /^\/boundary\/([\w-]+)\/(decide|revoke)$/.exec(rest)) && method === 'POST')
      return this.decideBoundary(m[1]!, body, m[2] === 'revoke');
    if ((m = /^\/inbox\/([\w-]+)\/resolve$/.exec(rest)) && method === 'POST')
      return this.resolve(m[1]!, body);
    if ((m = /^\/inbox\/([\w-]+)\/check$/.exec(rest)) && method === 'POST') return this.checkOutage(m[1]!);

    if (rest === '/config') {
      if (method === 'PATCH') return this.patchConfig(body);
      // The server gives the configuration to every member but a client.
      const reader = memberOf(this.config, this.viewerHandle);
      if (reader?.kind === 'human' && reader.access === 'client')
        return error(403, 'insufficient_access', 'Requires internal access');
      return ok({ config: clone(this.config), version: this.configVersion, history: clone(this.history) });
    }
    if (rest === '/config/revert' && method === 'POST') {
      const input = parseBody(RevertConfigRequest, body);
      if (!input) return error(400, 'invalid_request', 'Invalid revert request');
      const target = this.history.find((entry) => entry.version === input.version);
      if (!target) return error(404, 'not_found', 'Unknown version');
      this.commitConfig(`Revert to ${target.version}`);
      return ok({ version: this.configVersion });
    }
    return error(404, 'not_found', `No route for ${method} ${rest}`);
  }

  /* ---------- mutations ---------- */

  /** The server's checks on every configuration change: access, owner-only changes, invariants. */
  private configChangeFailure(next: ProjectConfig): MockResponse | null {
    const viewer = memberOf(this.config, this.viewerHandle);
    if (viewer?.kind !== 'human' || !['owner', 'admin'].includes(viewer.access))
      return error(403, 'insufficient_access', 'Requires admin access');
    const [ownerOnly] = viewer.access === 'owner' ? [] : ownerOnlyChanges(this.config, next);
    if (ownerOnly) return error(403, 'owner_only', `Only an owner may make this change (${ownerOnly})`);
    const stageIds = new Set(next.pipeline.stages.map((stage) => stage.id));
    for (const stage of this.config.pipeline.stages.filter((stage) => !stageIds.has(stage.id))) {
      const count = this.tasks.filter((task) => task.stageId === stage.id).length;
      if (count)
        return error(409, 'stage_in_use', 'Tasks still occupy the removed stage', {
          stageId: stage.id,
          tasks: count,
        });
    }
    const issues = introducedErrors(this.config, next);
    return issues.length > 0 ? error(400, 'config_invalid', 'Invalid configuration', { issues }) : null;
  }

  private patchConfig(body: unknown): MockResponse {
    const member = memberOf(this.config, this.viewerHandle);
    if (member?.kind !== 'human' || !['owner', 'admin'].includes(member.access)) {
      return error(403, 'insufficient_access', 'Requires admin access');
    }
    const parsed = PatchConfigRequest.safeParse(body);
    if (!parsed.success) {
      return error(400, 'config_invalid', 'Invalid configuration', {
        issues: configSchemaIssues(parsed.error.issues),
      });
    }
    const input = parsed.data;
    if (input.baseVersion !== this.configVersion) {
      return error(409, 'config_conflict', 'Configuration changed', { currentVersion: this.configVersion });
    }
    if (unknownPatchRepo(this.config, input) !== null)
      return error(400, 'unknown_repo', 'Unknown repository');
    const next = applyConfigPatch(this.config, input);
    const failure = this.configChangeFailure(next);
    if (failure) return failure;
    if (JSON.stringify(next) !== JSON.stringify(this.config)) {
      this.config = next;
      const message =
        input.message ??
        (input.pipeline ? 'Update pipeline' : input.limits ? 'Update limits' : 'Update project');
      this.commitConfig(message);
      this.addTimeline(null, this.viewerHandle, 'config_changed', { version: this.configVersion, message });
    }
    return ok({ config: clone(this.config), version: this.configVersion, history: clone(this.history) });
  }

  /** Handles in use now or in the past (the configuration, retired members, sessions): never reused. */
  private takenHandles(config: ProjectConfig = this.config): Set<string> {
    return new Set([
      ...config.team.members.map((member) => member.handle),
      ...this.members.map((member) => member.handle),
      ...this.sessions.map((session) => session.member),
    ]);
  }

  private addHuman(body: unknown): MockResponse {
    const input = parseBody(AddHumanMemberRequest, body);
    if (!input) return error(400, 'invalid_request', 'Invalid human member');
    for (const role of input.roles) {
      const failure = this.validateRole(role, 'human');
      if (failure) return failure;
    }
    const taken = this.takenHandles();
    if (input.handle && taken.has(input.handle)) return error(409, 'handle_taken', 'Handle taken');
    const handle = input.handle ?? humanMemberHandle(input.displayName, taken);
    const roles = unique(input.roles);
    const next = clone(this.config);
    next.team.members.push({
      kind: 'human',
      handle,
      displayName: input.displayName,
      access: input.access,
      roles,
    });
    const failure = this.configChangeFailure(next);
    if (failure) return failure;
    this.config = next;
    const member: MemberView = {
      kind: 'human',
      handle,
      displayName: input.displayName,
      role: input.access,
      roles,
      status: 'no_account',
      activity: null,
      currentTaskKeys: [],
      specialty: null,
      sponsor: null,
      temp: false,
    };
    this.members.push(member);
    this.commitConfig(`Add human member ${handle} without account`);
    this.memberChanged(handle);
    return { status: 201, body: clone(member) };
  }

  private handleInvitations(method: string, rest: string, body: unknown): MockResponse {
    if (rest === '/invites' && method === 'GET') {
      const recent = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
      return ok({
        invitations: this.invitations
          .filter(
            (invite) =>
              (!invite.acceptedAt && !invite.revokedAt && invite.expiresAt > nowIso()) ||
              invite.createdAt >= recent ||
              (invite.acceptedAt ?? '') >= recent ||
              (invite.revokedAt ?? '') >= recent,
          )
          .map((invite) => InvitationView.parse(invite))
          .reverse(),
      });
    }
    if (rest === '/invites' && method === 'POST') {
      const input = parseBody(CreateInviteRequest, body);
      if (!input) return error(400, 'invalid_request', 'Invalid invitation');
      if (input.access === 'admin' && this.findMember(this.viewerHandle)?.role !== 'owner')
        return error(403, 'owner_only', 'Only an owner may invite an admin');
      const member = input.memberHandle ? memberOf(this.config, input.memberHandle) : undefined;
      if (input.memberHandle) {
        if (!member) return error(404, 'invite_member_not_found', 'Unknown member');
        if (member.kind !== 'human') return error(400, 'invite_member_not_human', 'Human required');
        if (member.email) return error(409, 'member_has_account', 'Member has email');
        if (
          this.invitations.some(
            (invite) =>
              invite.memberHandle === member.handle &&
              !invite.acceptedAt &&
              !invite.revokedAt &&
              invite.expiresAt > nowIso(),
          )
        )
          return error(409, 'member_invite_pending', 'Invitation pending');
      }
      if (
        this.config.team.members.some(
          (member) => member.kind === 'human' && member.email?.trim().toLowerCase() === input.email,
        )
      )
        return error(409, 'already_member', 'Already a human member');
      for (const id of input.roles) {
        const role = roleViews(this.config).find((role) => role.id === id);
        if (!role) return error(400, 'unknown_role', 'Unknown role');
        if (
          !input.memberHandle &&
          this.findMember(this.viewerHandle)?.role !== 'owner' &&
          roleBundle(this.config, id).duties.includes('release_approval')
        )
          return error(403, 'owner_only', 'Only owners may grant release approval');
        if (!holdersAllow(role.holders, 'human')) return error(400, 'role_not_for_human', 'AI-only role');
      }
      const token = newInviteToken();
      const invite = {
        ...input,
        displayName: member?.displayName ?? input.displayName ?? null,
        roles: member?.kind === 'human' ? member.roles : [...new Set(input.roles)],
        id: mockId('inv'),
        projectKey: fixtures.PROJECT_KEY,
        invitedBy: this.user.userId,
        createdAt: nowIso(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
        acceptedAt: null,
        revokedAt: null,
        token,
      };
      this.invitations.push(invite);
      return { status: 201, body: { ...InvitationView.parse(invite), path: `/invite/${token}` } };
    }
    const match = /^\/invites\/([^/]+)$/.exec(rest);
    if (match && method === 'DELETE') {
      const invite = this.invitations.find((invite) => invite.id === match[1]);
      if (!invite) return error(404, 'not_found', 'Unknown invitation');
      if (invite.acceptedAt) return error(409, 'invite_used', 'Invitation already used');
      invite.revokedAt ??= nowIso();
      return ok();
    }
    return error(404, 'not_found', 'Unknown invitation route');
  }

  private handlePublicInvite(method: string, token: string, accepting: boolean, body: unknown): MockResponse {
    if (!(method === 'GET' && !accepting) && !(method === 'POST' && accepting))
      return error(404, 'not_found', 'Unknown invitation route');
    if (this.inviteAttempts.resetAt <= Date.now())
      this.inviteAttempts = { count: 0, resetAt: Date.now() + 15 * 60_000 };
    if (this.inviteAttempts.count++ >= 10)
      return error(429, 'too_many_attempts', 'Too many invitation attempts');
    const invite = this.invitations.find((invite) => invite.token === token);
    if (!invite || invite.acceptedAt || invite.revokedAt || invite.expiresAt <= nowIso())
      return error(404, 'invite_invalid', 'Invalid invitation');
    const account = this.accounts.get(invite.email);
    if (!accepting)
      return ok({
        projectKey: invite.projectKey,
        projectName: this.config.project.name,
        inviterName:
          [...this.accounts.values()].find((user) => user.userId === invite.invitedBy)?.name ??
          fixtures.mockUser.name,
        displayName: invite.displayName,
        access: invite.access,
        roles: invite.roles,
        roleNames: invite.roles.map(
          (id) => roleViews(this.config).find((role) => role.id === id)?.name ?? id,
        ),
        expiresAt: invite.expiresAt,
        requiresLogin: !!account,
      });
    if (account && (this.auth !== 'ready' || this.user.userId !== account.userId))
      return error(409, 'login_required', 'Log in as the invited account');
    if (account && !parseBody(AcceptInviteRequest, body))
      return error(400, 'invalid_request', 'Invalid invitation acceptance body');
    const input = account ? null : parseBody(AcceptInviteRequest.required(), body);
    if (!account && !input)
      return error(400, 'invalid_request', 'Name and eight-character password required');
    if (
      this.config.team.members.some(
        (member) => member.kind === 'human' && member.email?.toLowerCase() === invite.email,
      )
    )
      return error(409, 'already_member', 'Already a human member');
    for (const id of invite.roles) {
      const failure = this.validateRole(id, 'human');
      if (failure) return failure;
    }
    const user = account ?? {
      userId: mockId('usr'),
      name: input!.name,
      email: invite.email,
      password: input!.password,
    };
    const seat = invite.memberHandle ? memberOf(this.config, invite.memberHandle) : undefined;
    if (invite.memberHandle) {
      if (!seat) return error(404, 'invite_member_not_found', 'Unknown member');
      if (seat.kind !== 'human') return error(400, 'invite_member_not_human', 'Human required');
      if (seat.email) return error(409, 'member_has_account', 'Member has email');
    }
    let handle = humanMemberHandle(user.name, this.takenHandles());
    if (seat?.kind === 'human') {
      handle = seat.handle;
      seat.email = user.email;
      seat.access = invite.access;
      const view = this.findMember(handle)!;
      view.role = invite.access;
      view.status = 'online';
    } else {
      this.config.team.members.push({
        kind: 'human',
        handle,
        displayName: user.name,
        email: user.email,
        access: invite.access,
        roles: invite.roles,
      });
      this.members.push({
        kind: 'human',
        handle,
        displayName: user.name,
        role: invite.access,
        roles: invite.roles,
        status: 'online',
        activity: null,
        currentTaskKeys: [],
        specialty: null,
        sponsor: null,
        temp: false,
      });
    }
    this.accounts.set(user.email, user);
    this.user = { userId: user.userId, name: user.name, email: user.email };
    this.viewerHandle = handle;
    this.auth = 'ready';
    this.commitConfig(`Invite accepted: ${user.name}`);
    this.memberChanged(handle);
    invite.acceptedAt = nowIso();
    return ok(this.me());
  }

  private validateRole(id: string, kind: 'human' | 'ai'): MockResponse | null {
    const role = roleViews(this.config).find((entry) => entry.id === id);
    if (!role) return error(400, 'unknown_role', 'Unknown role');
    if (!holdersAllow(role.holders, kind))
      return error(
        400,
        kind === 'ai' ? 'role_not_for_ai' : 'role_not_for_human',
        'Role does not allow this member kind',
      );
    return null;
  }

  private roleUsage(id: string, holders?: 'human' | 'ai' | 'both') {
    return {
      members: this.config.team.members
        .filter(
          (member) => memberRoles(member).includes(id) && (!holders || !holdersAllow(holders, member.kind)),
        )
        .map((member) => member.handle),
      tempWorkers:
        this.config.team.limits.tempWorkers.role === id && (!holders || !holdersAllow(holders, 'ai')),
    };
  }

  private saveRole(id: string | undefined, body: unknown): MockResponse {
    const input = parseBody(CustomRoleRequest, body);
    if (!input) return error(400, 'invalid_request', 'Invalid role');
    if (id && input.id !== id) return error(400, 'role_id_mismatch', 'Role id differs');
    if (isBuiltInRole(input.id))
      return error(id ? 400 : 409, id ? 'builtin_role' : 'custom_role_shadows_builtin', 'Built-in role');
    const index = this.config.team.roles.findIndex((role) => role.id === input.id);
    if (id && index < 0) return error(404, 'not_found', 'Unknown role');
    if (!id && index >= 0) return error(409, 'duplicate_role', 'Duplicate role');
    const usage = this.roleUsage(input.id, roleHolders(input.id, [input])!);
    if (usage.members.length || usage.tempWorkers) return error(409, 'role_in_use', 'Role is in use', usage);
    const next = clone(this.config);
    if (id) next.team.roles[index] = input;
    else next.team.roles.push(input);
    const failure = this.configChangeFailure(next);
    if (failure) return failure;
    if (id) this.config.team.roles[index] = input;
    else this.config.team.roles.push(input);
    this.commitConfig(`${id ? 'Update' : 'Add'} role ${input.id}`);
    return { status: id ? 200 : 201, body: roleViews(this.config).find((role) => role.id === input.id) };
  }

  private deleteRole(id: string): MockResponse {
    if (isBuiltInRole(id)) return error(400, 'builtin_role', 'Built-in role');
    if (!this.config.team.roles.some((role) => role.id === id))
      return error(404, 'not_found', 'Unknown role');
    const usage = this.roleUsage(id);
    if (usage.members.length || usage.tempWorkers) return error(409, 'role_in_use', 'Role is in use', usage);
    const next = clone(this.config);
    next.team.roles = next.team.roles.filter((role) => role.id !== id);
    const failure = this.configChangeFailure(next);
    if (failure) return failure;
    this.config.team.roles = next.team.roles;
    this.commitConfig(`Remove role ${id}`);
    return ok();
  }

  private editMember(handle: string, body: unknown): MockResponse {
    const input = parseBody(UpdateMemberRequest, body);
    if (!input) return error(400, 'invalid_request', 'Invalid member update');
    const member = this.findMember(handle);
    const config = memberOf(this.config, handle);
    if (!member || !config) return error(404, 'not_found', 'Unknown member');
    // Like the server: only an AI member that is no stand-in can be the Senior (PM-347).
    if (input.senior !== undefined && (config.kind === 'human' || config.temp))
      return error(400, 'senior_not_allowed', 'Only a permanent AI member can be the Senior');
    if (input.roles !== undefined) {
      if (config.kind !== 'human') return error(400, 'not_human_member', 'Not a human member');
      for (const role of input.roles) {
        const failure = this.validateRole(role, 'human');
        if (failure) return failure;
      }
    }
    if (
      config.kind !== 'ai' &&
      (input.specialty !== undefined ||
        input.model !== undefined ||
        input.schedule !== undefined ||
        input.provider !== undefined ||
        input.effort !== undefined ||
        input.autoCompactWindowTokens !== undefined ||
        input.cheapSubagent !== undefined ||
        input.onLeave !== undefined ||
        input.instructions !== undefined ||
        input.permissionMode !== undefined ||
        input.outboundNetwork !== undefined ||
        input.approver !== undefined)
    )
      return error(400, 'not_ai_member', 'Not an AI member');
    if (input.approver !== undefined) {
      // Who may change the settings is `ownerOnlyChanges`, run by `configChangeFailure` below, as on the server.
      const blocker = approverBlocker(this.config, handle, input.approver);
      if (blocker) return error(422, 'approver_unavailable', 'This approver is not available', { blocker });
    }
    const next = clone(this.config);
    const nextMember = memberOf(next, handle)!;
    if (nextMember.kind === 'ai') {
      if (input.permissionMode !== undefined) nextMember.permissionMode = input.permissionMode;
      if (input.approver !== undefined) nextMember.approver = input.approver;
      if (input.outboundNetwork !== undefined) nextMember.outboundNetwork = input.outboundNetwork;
    }
    if (input.access !== undefined && nextMember.kind !== 'human')
      return error(400, 'not_human_member', 'Access is for humans');
    if (nextMember.kind === 'human' && input.access !== undefined) nextMember.access = input.access;
    if (nextMember.kind === 'human' && input.roles !== undefined) nextMember.roles = input.roles;
    const failure = this.configChangeFailure(next);
    if (failure) return failure;
    if (input.displayName !== undefined) member.displayName = config.displayName = input.displayName;
    if (config.kind === 'human' && input.access !== undefined) member.role = config.access = input.access;
    if (config.kind === 'human' && input.roles !== undefined)
      member.roles = config.roles = [...new Set(input.roles)];
    if (config.kind === 'ai') {
      if (input.specialty !== undefined) {
        config.specialty = input.specialty.trim() || undefined;
        member.specialty = config.specialty ?? null;
      }
      if (input.model !== undefined) member.model = config.model = input.model;
      if (input.provider !== undefined && input.provider !== (config.provider ?? DEFAULT_AGENT_PROVIDER)) {
        member.provider = config.provider = input.provider;
        member.model = config.model = modelForProvider(input.provider, input.model);
      }
      if (input.effort !== undefined) {
        if (input.effort === null) {
          delete member.effort;
          delete config.effort;
        } else member.effort = config.effort = input.effort;
      }
      if (input.autoCompactWindowTokens !== undefined) {
        if (input.autoCompactWindowTokens === null) {
          delete member.autoCompactWindowTokens;
          delete config.autoCompactWindowTokens;
        } else
          member.autoCompactWindowTokens = config.autoCompactWindowTokens = input.autoCompactWindowTokens;
      }
      if (input.cheapSubagent !== undefined) {
        if (input.cheapSubagent === null) {
          delete member.cheapSubagent;
          delete config.cheapSubagent;
        } else member.cheapSubagent = config.cheapSubagent = input.cheapSubagent;
      }
      if (input.senior !== undefined) {
        if (input.senior) member.senior = config.senior = true;
        else {
          delete member.senior;
          delete config.senior;
        }
      }
      if (input.schedule !== undefined) config.schedule = input.schedule ?? undefined;
      if (input.instructions !== undefined) config.instructions = input.instructions.trim();
      if (input.permissionMode !== undefined) config.permissionMode = input.permissionMode;
      if (input.approver !== undefined) config.approver = input.approver;
      if (input.outboundNetwork !== undefined) config.outboundNetwork = input.outboundNetwork;
      if (input.onLeave !== undefined) {
        if (input.onLeave) {
          config.onLeave = member.onLeave = true;
          // Like the server: the running sessions of a member sent on leave stop.
          for (const session of this.sessions.filter((s) => s.member === handle && this.isLive(s)))
            this.updateSession(session.id, { state: 'exited', activity: null, endedAt: nowIso() });
          this.setMemberState(handle, 'idle', null);
        } else {
          delete config.onLeave;
          delete member.onLeave;
        }
      }
    }
    this.commitConfig(`Update member ${handle}`);
    this.memberChanged(handle);
    this.settleSeniorWaits();
    return ok(clone(member));
  }

  private taskPullRequests(task: Task) {
    return task.links
      .filter((link) => link.kind === 'pull_request' && link.repo)
      .map((link) => ({
        repo: link.repo!,
        number: Number(link.ref),
        url: `https://github.com/${link.repo}/pull/${link.ref}`,
        title: link.title ?? null,
        state: link.state ?? null,
        checks: 'passing',
        reviewDecision: 'approved',
        additions: 42,
        deletions: 8,
      }));
  }

  private taskSessions(taskKey: string): Session[] {
    return this.sessions.filter(
      (session) => session.workItem.type === 'task' && session.workItem.taskKey === taskKey,
    );
  }

  /** Whether the path reopens a card that is not a theme (an admin does that; a theme, a developer). */
  private reopensNonTheme(rest: string): boolean {
    const match = /^\/tasks\/([^/]+)\/reopen$/.exec(rest);
    const task = match ? this.findTask(match[1]!) : undefined;
    return !!match && !(task && isTheme(task));
  }

  private taskLifecycle(taskKey: string, action: string, body: unknown): MockResponse {
    const input =
      action === 'cancel'
        ? parseBody(CancelTaskRequest, body)
        : action === 'close-theme'
          ? parseBody(CloseThemeRequest, body)
          : parseBody(ReopenTaskRequest, body);
    if (!input) return error(400, 'invalid_request', 'Invalid lifecycle request');
    const task = this.findTask(taskKey);
    if (!task) return error(404, 'not_found', 'Unknown task');
    if (action === 'close-theme') {
      // A theme closes like a cancelled card, with its own timeline wording; its cards stay as they are.
      if (!isTheme(task)) return error(409, 'task_not_theme', 'Not a theme');
      if (!isOpenTask(task)) return error(409, 'task_closed', 'Theme is closed');
      this.updateTask(taskKey, { status: 'cancelled', closedAt: nowIso() });
      this.addTimeline(taskKey, this.viewerHandle, 'task_updated', {
        action: 'closed',
        previousStatus: task.status,
        fields: ['status', 'closedAt'],
      });
      return ok(clone(task));
    }
    if (action === 'cancel') {
      if (isTheme(task)) return error(409, 'task_is_theme', 'A theme is closed, not cancelled');
      if (!isOpenTask(task)) return error(409, 'task_closed', 'Task is closed');
      const reason = 'reason' in input ? input.reason : undefined;
      this.cancelTask(taskKey, reason === undefined ? {} : { reason });
    } else {
      if (task.status !== 'cancelled') return error(409, 'task_not_cancelled', 'Task is not cancelled');
      const previousAssignee = task.assignee;
      this.updateTask(taskKey, { status: 'active', closedAt: null, assignee: null });
      this.addTimeline(taskKey, this.owner, 'task_updated', {
        action: 'reopened',
        previousAssignee,
        fields: ['status', 'closedAt', 'assignee'],
      });
    }
    return ok(clone(task));
  }

  /** Cancels an open task: the timeline says why (a duplicate names its original), its sessions stop and its questions close. */
  private cancelTask(taskKey: string, why: { reason?: string; duplicateOf?: string }): void {
    const task = this.findTask(taskKey)!;
    const previousStatus = task.status;
    this.updateTask(taskKey, { status: 'cancelled', closedAt: nowIso() });
    this.addTimeline(taskKey, this.owner, 'task_updated', {
      action: 'cancelled',
      previousStatus,
      fields: ['status', 'closedAt'],
      ...why,
    });
    for (const session of this.taskSessions(taskKey)) if (this.isLive(session)) this.stopSession(session.id);
    for (const item of this.inbox.filter((entry) => entry.taskKey === taskKey && entry.state === 'open'))
      this.upsertInbox({ ...item, state: 'cancelled' });
    for (const member of this.members)
      member.currentTaskKeys = member.currentTaskKeys.filter((key) => key !== taskKey);
  }

  private viewerActor(): Actor {
    return { kind: 'human', handle: this.viewerHandle };
  }

  /**
   * The task's attachments, with the server's answers: a task the viewer may not see is unknown,
   * and the shared rules decide who uploads and who deletes. The bytes are not served (the UI
   * points the browser at the content routes, not at fetch).
   */
  private handleAttachments(
    method: string,
    taskKey: string,
    id: string | undefined,
    body: unknown,
  ): MockResponse {
    const viewer = this.taskViewer();
    const task = this.findTask(taskKey);
    if (!task || !canReadAttachments(viewer, task)) return error(404, 'not_found', 'Unknown task');
    if (!id && method === 'GET') {
      return ok({ attachments: clone(this.attachments.filter((entry) => entry.taskKey === taskKey)) });
    }
    if (!id && method === 'POST') {
      if (!canUploadAttachment(viewer, task))
        return error(403, 'insufficient_access', 'Viewers cannot attach files');
      const file = body instanceof FormData ? body.get('file') : null;
      if (!(file instanceof File)) return error(400, 'invalid_request', 'The request carries no file');
      if (file.size > MAX_ATTACHMENT_BYTES) {
        return error(413, 'attachment_too_large', 'Too large', { maxBytes: MAX_ATTACHMENT_BYTES });
      }
      return { status: 201, body: { attachment: clone(this.addAttachment(taskKey, file)) } };
    }
    if (id && method === 'DELETE') {
      const attachment = this.attachments.find((entry) => entry.id === id && entry.taskKey === taskKey);
      if (!attachment) return error(404, 'not_found', 'Unknown attachment');
      if (!canDeleteAttachment(viewer, task, attachment))
        return error(403, 'insufficient_access', 'Only the uploader, an owner or an admin may delete this');
      this.removeAttachment(id);
      return ok({ id, deleted: true });
    }
    return error(404, 'not_found', `No route for ${method}`);
  }

  /** The cover choice, with the server's answers: the upload access, and a cover must be a ready image of the card. */
  private handleCover(taskKey: string, body: unknown): MockResponse {
    const viewer = this.taskViewer();
    const task = this.findTask(taskKey);
    if (!task || !canReadAttachments(viewer, task)) return error(404, 'not_found', 'Unknown task');
    if (!canUploadAttachment(viewer, task))
      return error(403, 'insufficient_access', 'Viewers cannot attach files');
    const choice = parseBody(TaskCoverRequest, body);
    if (!choice) return error(400, 'invalid_request', 'Invalid cover choice');
    if (choice.mode === 'pinned') {
      const image = this.attachments.find(
        (entry) => entry.id === choice.attachmentId && entry.taskKey === taskKey,
      );
      if (image?.preview !== 'image') {
        return error(422, 'cover_not_an_image', 'The cover must be an image of this card');
      }
    }
    this.covers.set(taskKey, choice);
    this.syncCover(taskKey);
    return ok({ task: clone(task) });
  }

  /** Why the card stands still, by the shared rule (PM-460), as the server serves it to the team. */
  private taskWaitOf(task: Task) {
    const roster = this.members.map((member) => this.viewOf(member));
    const linked = task.links.flatMap((link) => {
      const other = link.kind === 'prerequisite' ? this.findTask(link.ref) : undefined;
      return other ? [other] : [];
    });
    return taskWait({
      task,
      config: this.config,
      openItems: this.inbox.filter((item) => item.taskKey === task.key && item.state === 'open'),
      workers: waitWorkers(task, this.config, roster),
      holders: waitHolders(task, roster),
      openPrerequisites: openPrerequisites(task, linked).map((card) => card.key),
      viewer: this.viewerHandle,
    });
  }

  private taskDetail(task: Task) {
    const wait = this.findMember(this.viewerHandle)?.role === 'client' ? null : this.taskWaitOf(task);
    return {
      ...(wait ? { wait } : {}),
      task: clone(task),
      parent: task.parentKey ? clone(this.findTask(task.parentKey) ?? null) : null,
      subtasks: clone(this.tasks.filter((child) => child.parentKey === task.key)),
      pullRequests: this.taskPullRequests(task),
      timeline: clone(this.timeline.filter((event) => event.taskKey === task.key)),
      sessions: clone(this.taskSessions(task.key)),
      ...(this.findMember(this.viewerHandle)?.role === 'client'
        ? {}
        : {
            rounds: this.cardRounds(task.key),
            fixRounds: { rounds: this.fixRoundsOf(task.key).rounds, limit: this.fixLimitOf(task.key) },
          }),
    };
  }

  /** The card's review rounds and send-backs, by the shared rule (PM-222). */
  private cardRounds(taskKey: string) {
    return countCardRounds(
      this.timeline.filter((event) => event.taskKey === taskKey),
      this.config,
    );
  }

  /** The cards closed lately, measured by the shared rules from the fake's sessions and timeline (PM-222). */
  private closedCardsMeasure(days: number) {
    const since = closedCardsSince(new Date(), days);
    const cards = this.tasks
      .filter((task) => isClosedSince(task, since))
      .sort((a, b) => (a.closedAt! < b.closedAt! ? 1 : -1))
      .map((task) => measureClosedCard(task, this.taskSessions(task.key), this.cardRounds(task.key)));
    return { since, days, cards: clone(cards) };
  }

  /**
   * Like the server's all-or-nothing task update: the whole change is validated first (label
   * rules, then the gates against the labels the task will have, and whether someone may give
   * the approvals the move needs); fields, assignee and labels are applied before the move, and
   * a move that needs an approval requests it with the rest applied.
   */
  private changeTask(task: Task, input: UpdateTaskRequest): MockResponse {
    const actor = this.viewerActor();
    const patch: Partial<Task> = {};
    const fields: string[] = [];
    // A theme does not move, have an assignee or a repository.
    if (
      isTheme(task) &&
      ((input.stageId !== undefined && input.stageId !== task.stageId) ||
        (input.assignee !== undefined && input.assignee !== null) ||
        (input.repo !== undefined && input.repo !== null) ||
        (input.priority !== undefined && input.priority !== null))
    )
      return error(409, 'task_is_theme', 'A theme has no stage, assignee or repository');
    // Like the server (`planDeveloperLevel`): who may, theme, closed, then the reason; the same level and reason is no change.
    let levelEvent: TimelineEventData['task_level_changed'] | null = null;
    if (input.developerLevel) {
      if (!canSetDeveloperLevel(this.config, this.viewerHandle))
        return error(403, 'developer_level_forbidden', 'Not allowed to set the recommended developer');
      if (isTheme(task)) return error(409, 'task_is_theme', 'A theme has no recommended developer');
      if (!isOpenTask(task)) return error(409, 'task_closed', `Task ${task.key} is ${task.status}`);
      const reason = input.developerLevel.reason?.trim() || null;
      if (reason && reason.length > DEVELOPER_LEVEL_REASON_MAX)
        return error(400, 'invalid_request', 'The reason is too long');
      if (input.developerLevel.level === 'senior' && !reason)
        return error(400, 'developer_level_reason_required', 'A Senior task needs a reason');
      const before = task.developerLevel
        ? { level: task.developerLevel.level, reason: task.developerLevel.reason }
        : null;
      if (!(before && before.level === input.developerLevel.level && before.reason === reason)) {
        patch.developerLevel = {
          level: input.developerLevel.level,
          reason,
          setBy: this.viewerHandle,
          setAt: nowIso(),
        };
        levelEvent = { level: input.developerLevel.level, reason, previous: before };
      }
    }
    if (input.priority !== undefined) {
      const refusal = priorityRefusal(actor, this.config);
      if (refusal)
        return error(403, refusal, 'The priority of a card is set by people and the project manager only');
      if (input.priority !== task.priority) {
        patch.priority = input.priority;
        fields.push('priority');
      }
    }
    if (input.title !== undefined && input.title.trim() !== task.title) {
      patch.title = input.title.trim();
      if (!patch.title) return error(400, 'invalid_request', 'Empty title');
      fields.push('title');
    }
    if (input.description !== undefined && input.description !== task.description) {
      patch.description = input.description;
      fields.push('description');
    }
    if (input.visibility !== undefined && input.visibility !== task.visibility) {
      patch.visibility = input.visibility;
      fields.push('visibility');
    }
    if (input.relations && input.parentKey !== undefined)
      return error(400, 'invalid_request', 'Give the parent in parentKey or in relations, not both');
    const relationPlan = input.relations ? this.planRelationChange(task, input.relations) : null;
    if (relationPlan && 'status' in relationPlan) return relationPlan;
    if (relationPlan?.closes && input.stageId !== undefined && input.stageId !== task.stageId)
      return error(400, 'invalid_request', 'A card marked as a duplicate cannot move in the same call');
    if (input.parentKey) {
      const refusal = this.validateParent(task.key, input.parentKey, task.kind);
      if (refusal) return refusal;
    }
    if (input.parentKey !== undefined && input.parentKey !== (task.parentKey ?? null)) {
      patch.parentKey = input.parentKey;
      fields.push('parentKey');
    }
    // Like the server: the theme the card stores (a subtask stores none), the rule, and the loss of the
    // card's own theme when it becomes a subtask.
    const ownTheme = task.parentKey ? null : (task.themeKey ?? null);
    let themeAfter = ownTheme;
    let parentAfter = input.parentKey !== undefined ? input.parentKey : (task.parentKey ?? null);
    for (const step of relationPlan?.steps ?? [])
      if (step.type === 'parent' && step.child === task.key) parentAfter = step.parent;
    if (input.themeKey !== undefined && input.themeKey !== ownTheme) {
      if (input.themeKey !== null) {
        const refusal = this.themeError(input.themeKey, task, parentAfter);
        if (refusal) return refusal;
      }
      themeAfter = input.themeKey;
    }
    if (parentAfter) themeAfter = null;
    if (themeAfter !== ownTheme) patch.themeKey = themeAfter;
    // Like the server: a repository of the project, and not while a session of the task runs.
    if (input.repo !== undefined && input.repo !== task.repo) {
      if (input.repo !== null && !repoOf(this.config, input.repo))
        return error(400, 'unknown_repo', 'Unknown repository');
      const live = this.taskSessions(task.key).find((session) => this.isLive(session));
      if (live) return error(409, 'task_session_live', 'A session is still live', { sessionId: live.id });
      patch.repo = input.repo;
      fields.push('repo');
    }
    if (input.assignee !== undefined) {
      if (input.assignee !== null && !memberOf(this.config, input.assignee))
        return error(400, 'unknown_member', 'Unknown member');
      // A live session of the old assignee is no obstacle (PM-342): the server asks it for a handoff note.
      if (input.assignee !== task.assignee) {
        if (isHandleOnLeave(this.config, input.assignee))
          return error(409, 'member_on_leave', `${input.assignee} is on leave`);
        patch.assignee = input.assignee;
      }
    }
    const wanted = input.labels && unique(input.labels.map((label) => label.trim()).filter(Boolean));
    const labels = planLabelChange(
      this.config,
      { ...task, ...patch },
      wanted
        ? {
            add: wanted.filter((label) => !task.labels.includes(label)),
            remove: task.labels.filter((label) => !wanted.includes(label)),
          }
        : {},
      actor,
    );
    if (!labels.ok) return labelChangeError(labels.refusal);
    const moving = input.stageId !== undefined && input.stageId !== task.stageId;
    if (moving) {
      if (task.status === 'cancelled') return error(409, 'task_closed', 'Task is cancelled');
      const target = stageOf(this.config, input.stageId!);
      if (!target) return error(400, 'unknown_stage', 'Unknown stage');
      const evaluation = evaluateMove(
        { ...task, ...patch, labels: labels.labels },
        this.config,
        task.stageId,
        target.id,
      );
      if (evaluation.unmet.length) return gateBlockedError(evaluation);
      const nobody = this.noApproverError(
        { ...task, ...patch, labels: labels.labels },
        target,
        evaluation.approvals,
      );
      if (nobody) return nobody;
    }

    const previous = {
      assignee: task.assignee,
      parentKey: task.parentKey ?? null,
      repo: task.repo,
      priority: task.priority,
    };
    const labelsChanged = labels.added.length > 0 || labels.removed.length > 0;
    let handoffStart: HandoffStart | undefined;
    if (
      fields.length ||
      patch.assignee !== undefined ||
      patch.themeKey !== undefined ||
      labelsChanged ||
      levelEvent
    ) {
      this.updateTask(task.key, { ...patch, ...(labelsChanged ? { labels: labels.labels } : {}) });
      if (levelEvent) this.addTimeline(task.key, actor.handle, 'task_level_changed', { ...levelEvent });
      if (fields.length)
        this.addTimeline(task.key, actor.handle, 'task_updated', {
          fields,
          ...(patch.repo !== undefined ? { repo: patch.repo, previousRepo: previous.repo } : {}),
          ...(patch.priority !== undefined
            ? { priority: patch.priority, previousPriority: previous.priority }
            : {}),
        });
      if (labelsChanged) this.recordLabels(task, labels, actor, {});
      if (patch.assignee !== undefined)
        this.addTimeline(task.key, actor.handle, 'task_assigned', {
          assignee: task.assignee,
          previous: previous.assignee,
        });
      if (patch.assignee !== undefined)
        handoffStart = this.handOver(task, previous.assignee, patch.assignee, actor.handle);
      if (patch.parentKey !== undefined)
        this.recordParentChange(task.key, previous.parentKey, task.parentKey ?? null);
      if (patch.themeKey !== undefined) this.recordThemeChange(task.key, ownTheme, themeAfter);
      this.settleSeniorWaits();
    }
    if (relationPlan) this.applyRelationPlan(relationPlan.steps, task, actor);
    this.syncSubtaskThemes();
    return moving
      ? this.move(task, input.stageId!, actor)
      : ok({ ...clone(task), ...(handoffStart ? { handoffStart } : {}) });
  }

  /**
   * What a change of the assignee starts (PM-342), by the shared `planHandoff` rule the server uses: the
   * old session is asked for a note (`live`, the card carries `handoff`), or the transcript summary stands
   * in at once (`fallback`, the card carries `lastHandoff`). Giving the card back to the old assignee
   * cancels the open handoff, a third member takes it over as the receiver.
   */
  private handOver(
    task: Task,
    previous: string | null,
    next: string | null,
    by: string | null,
  ): HandoffStart | undefined {
    const open = task.handoff;
    if (open) {
      if (next === open.from) {
        this.updateTask(task.key, { handoff: undefined });
        this.addTimeline(task.key, by, 'task_handoff', this.handoffEventData('cancelled', open));
        return undefined;
      }
      const toProvider = next ? this.providerOf(next) : null;
      this.updateTask(task.key, { handoff: { ...open, to: next, toProvider } });
      this.addTimeline(
        task.key,
        by,
        'task_handoff',
        this.handoffEventData('retargeted', { ...open, to: next, toProvider }),
      );
      return undefined;
    }
    if (!previous) return undefined;
    const from = memberOf(this.config, previous);
    const conversation = this.taskSessions(task.key)
      .filter((session) => session.member === previous)
      .at(-1);
    const plan = planHandoff({
      from: from
        ? {
            kind: from.kind,
            provider: this.providerOf(previous),
            onLeave: isHandleOnLeave(this.config, previous),
          }
        : null,
      conversation: conversation
        ? { provider: conversation.provider ?? this.providerOf(previous), transcript: this.handoffTranscript }
        : null,
    });
    if (!plan) return undefined;
    const fromProvider = this.providerOf(previous);
    const base: TaskHandoff = {
      id: mockId('hnd'),
      from: previous,
      to: next,
      fromProvider,
      toProvider: next ? this.providerOf(next) : null,
      reason: 'manual',
      step: plan.mode === 'live' ? 'waiting_point' : 'closing',
      startedAt: nowIso(),
      deadlineAt: plan.mode === 'live' ? new Date(Date.now() + HANDOFF_TIMEOUT_MS).toISOString() : null,
    };
    this.addTimeline(task.key, by, 'task_handoff', {
      ...this.handoffEventData('started', base),
      mode: plan.mode,
      reason: base.reason,
    });
    if (plan.mode === 'live') {
      this.updateTask(task.key, { handoff: base });
      return { mode: 'live', from: previous };
    }
    this.closeHandoff(task, base, { fallbackReason: plan.reason, summary: 'Where the work stood.' }, false);
    return { mode: 'fallback', from: previous, reason: plan.reason };
  }

  private handoffEventData(phase: TimelineEventData['task_handoff']['phase'], handoff: TaskHandoff) {
    return {
      phase,
      handoffId: handoff.id,
      from: handoff.from,
      to: handoff.to,
      fromProvider: handoff.fromProvider,
      toProvider: handoff.toProvider,
    };
  }

  private lastHandoffOf(record: TaskHandoffRecord): NonNullable<Task['lastHandoff']> {
    return {
      id: record.id,
      from: record.from,
      to: record.to,
      fromProvider: record.fromProvider,
      toProvider: record.toProvider,
      outcome: record.outcome,
      ...(record.fallbackReason ? { fallbackReason: record.fallbackReason } : {}),
      endedAt: record.endedAt,
    };
  }

  /** Records the note, or the summary standing in, in the handoff record and the timeline. */
  private closeHandoff(
    task: Task,
    handoff: TaskHandoff,
    outcome: { note: string } | { fallbackReason: HandoffFallbackReason; summary?: string | null },
    closing: boolean,
  ): void {
    const endedAt = nowIso();
    const note = 'note' in outcome ? outcome.note : null;
    const fallbackReason = 'fallbackReason' in outcome ? outcome.fallbackReason : undefined;
    const summaryText = 'fallbackReason' in outcome ? (outcome.summary ?? null) : null;
    const record: TaskHandoffRecord = {
      id: handoff.id,
      from: handoff.from,
      to: handoff.to,
      fromProvider: handoff.fromProvider,
      toProvider: handoff.toProvider,
      outcome: note !== null ? 'note' : 'fallback',
      ...(fallbackReason ? { fallbackReason } : {}),
      endedAt,
      reason: handoff.reason,
      startedAt: handoff.startedAt,
      note,
      branch: note !== null ? `${task.key}-work` : null,
      lastCommit: note !== null ? 'a1b2c3d' : null,
      uncommitted: note !== null ? false : null,
      summary:
        note === null && this.handoffTranscript && summaryText !== null
          ? { source: 'compact', text: summaryText, at: endedAt }
          : null,
    };
    this.handoffRecords.set(record.id, { ...record, taskKey: task.key });
    // Closing: the old session still closes, so the box stays; otherwise the card has its last handoff at once.
    if (closing)
      this.updateTask(task.key, {
        handoff: {
          ...handoff,
          step: 'closing',
          deadlineAt: null,
          ...(fallbackReason ? { fallbackReason } : {}),
        },
      });
    else this.updateTask(task.key, { handoff: undefined, lastHandoff: this.lastHandoffOf(record) });
    if (note !== null)
      this.addTimeline(task.key, handoff.from, 'task_handoff', {
        ...this.handoffEventData('note', handoff),
        note,
        lastCommit: record.lastCommit,
        uncommitted: record.uncommitted,
      });
    else
      this.addTimeline(task.key, null, 'task_handoff', {
        ...this.handoffEventData('fallback', handoff),
        fallbackReason,
        summary: record.summary !== null,
      });
  }

  /**
   * Test switch (PM-342): moves the open handoff of a card on. `writing` the old session was told to
   * write its note, `closing` the note is recorded (with `note`) or the summary stands in (`fallback`),
   * `paused` the team is paused, `done` the receiver took the card over. Returns the card.
   */
  advanceHandoff(
    taskKey: string,
    step: HandoffStep | 'done',
    options: { note?: string; fallbackReason?: HandoffFallbackReason; summary?: string | null } = {},
  ): Task | undefined {
    const task = this.findTask(taskKey);
    const open = task?.handoff;
    if (!task || !open) return task;
    if (step === 'done') {
      this.addTimeline(task.key, open.to, 'task_handoff', this.handoffEventData('taken_over', open));
      const record = this.handoffRecords.get(open.id);
      this.updateTask(task.key, {
        handoff: undefined,
        ...(record ? { lastHandoff: this.lastHandoffOf(record) } : {}),
      });
      return task;
    }
    if (step === 'closing') {
      if (options.note !== undefined) this.closeHandoff(task, open, { note: options.note }, true);
      else
        this.closeHandoff(
          task,
          open,
          { fallbackReason: options.fallbackReason ?? 'timeout', summary: options.summary },
          true,
        );
      return task;
    }
    this.updateTask(task.key, {
      handoff: { ...open, step, deadlineAt: step === 'paused' ? null : open.deadlineAt },
    });
    return task;
  }

  /** Adds a comment; the members it mentions get it as a team message (imported ones do not). */
  private recordNote(
    task: Task,
    text: string,
    actor: Actor,
    imported: Pick<CreateTaskCommentRequest, 'importedAuthor' | 'importedAt'> = {},
  ): void {
    const mentions = commentMentions(
      text,
      this.config.team.members.map((member) => member.handle),
      actor.handle,
    );
    this.addTimeline(task.key, actor.handle, 'task_note', { text, mentions, ...imported });
    const isImported = imported.importedAuthor !== undefined || imported.importedAt !== undefined;
    if (!isImported && mentions.length && actor.handle)
      this.sendTeamMessage(actor.handle, mentions, task.key, text);
  }

  /** Records a label change already written to the task: the event, the comment, the assignee's notice. */
  private recordLabels(
    task: Task,
    plan: { added: string[]; removed: string[]; notify: string[] },
    actor: Actor,
    opts: { comment?: string; reason?: LabelChangeReason },
  ): void {
    const data: TimelineEventData['task_labels_changed'] = { added: plan.added, removed: plan.removed };
    if (opts.reason) data.reason = opts.reason;
    this.addTimeline(task.key, actor.handle, 'task_labels_changed', { ...data });
    const comment = opts.comment?.trim();
    if (comment) this.recordNote(task, comment, actor);
    if (plan.notify.length && task.assignee && actor.handle && task.assignee !== actor.handle) {
      const names = plan.notify.map((id) => labelDefinition(this.config, id)?.name ?? id);
      this.sendTeamMessage(
        actor.handle,
        [task.assignee],
        task.key,
        [names.join(', '), comment].filter(Boolean).join('\n\n'),
      );
    }
  }

  /** Adds and removes labels under the project's label rules; a refusal changes nothing. */
  private applyLabels(
    task: Task,
    change: { add?: string[]; remove?: string[] },
    actor: Actor,
    opts: { comment?: string; reason?: LabelChangeReason },
  ): MockResponse | null {
    const plan = planLabelChange(this.config, task, change, actor, opts.comment);
    if (!plan.ok) return labelChangeError(plan.refusal);
    if (!plan.added.length && !plan.removed.length) return null;
    this.updateTask(task.key, { labels: plan.labels });
    this.recordLabels(task, plan, actor, opts);
    this.continueLabelWait(task);
    return null;
  }

  /** Takes off the labels that expire on an event (the task moving back, its PR changing). */
  private expireLabels(task: Task, trigger: LabelClearTrigger): void {
    const expired = expiredLabels(this.config, task, trigger);
    if (expired.length) this.applyLabels(task, { remove: expired }, SYSTEM_ACTOR, { reason: trigger });
  }

  /** A stage move under the gates: blocked, an approval request in the inbox, or the move itself. */
  private move(task: Task, stageId: string, actor: Actor, placement?: BoardPlacement): MockResponse {
    if (isTheme(task)) return error(409, 'task_is_theme', 'A theme does not move between stages');
    if (task.status === 'cancelled') return error(409, 'task_closed', 'Task is cancelled');
    const target = stageOf(this.config, stageId);
    if (!target) return error(400, 'unknown_stage', 'Unknown stage');
    if (task.stageId === target.id) return ok(clone(task));
    const evaluation = evaluateMove(task, this.config, task.stageId, target.id);
    if (evaluation.unmet.length) return gateBlockedError(evaluation);
    if (evaluation.approvals.length)
      return this.requestApproval(task, target, evaluation.approvals, actor, placement);
    // An AI member finishing a step in front of a human-owned stage asks the card mover to take the card on.
    const decision = handOnDecision(this.config, actor, task.stageId, target.id);
    if (decision.kind === 'request') return this.requestHandOn(task, target, decision.mover, actor);
    this.applyMove(task, target, actor, {}, placement);
    return ok(clone(task));
  }

  /** Moves a card in the name of a member (a test or a scenario seeds an AI member's move this way). */
  moveAs(taskKey: string, stageId: string, handle: string): MockResponse {
    const task = this.findTask(taskKey);
    if (!task) return error(404, 'not_found', 'Unknown task');
    const member = memberOf(this.config, handle);
    return this.move(task, stageId, { kind: member?.kind ?? 'human', handle });
  }

  /** The card mover is asked to take the card on: a "Vidd tovább" item for a person, a note for the card. */
  private requestHandOn(task: Task, target: Stage, mover: string, actor: Actor): MockResponse {
    const requestedBy = actor.handle ?? 'system';
    const previous = task.handOn;
    if (
      previous?.fromStageId === task.stageId &&
      previous.toStageId === target.id &&
      previous.mover === mover
    )
      return ok(clone(task));
    this.clearHandOn(task);
    let inboxItemId: string | null = null;
    if (memberOf(this.config, mover)?.kind === 'human') {
      const item: InboxItem = {
        id: mockId('inb'),
        projectKey: task.projectKey,
        kind: 'hand_on',
        assignees: [mover],
        source: requestedBy,
        sessionId: null,
        taskKey: task.key,
        title: task.title,
        body: null,
        payload: {
          handOn: { taskKey: task.key, fromStageId: task.stageId, toStageId: target.id, requestedBy },
        },
        options: [{ id: 'move', label: 'move', style: 'primary' }],
        state: 'open',
        resolution: null,
        createdAt: nowIso(),
      };
      this.upsertInbox(item);
      inboxItemId = item.id;
    }
    this.updateTask(task.key, {
      handOn: {
        fromStageId: task.stageId,
        toStageId: target.id,
        mover,
        requestedBy,
        requestedAt: nowIso(),
        inboxItemId,
      },
    });
    this.addTimeline(task.key, null, 'task_hand_on_requested', {
      fromStageId: task.stageId,
      toStageId: target.id,
      mover,
      requestedBy,
    });
    return ok(clone(task));
  }

  /** The request ends: an item still open (the card moved another way) is cancelled. */
  private clearHandOn(task: Task): void {
    const request = task.handOn;
    if (!request) return;
    const item = request.inboxItemId
      ? this.inbox.find((entry) => entry.id === request.inboxItemId)
      : undefined;
    if (item?.state === 'open') this.upsertInbox({ ...item, state: 'cancelled' });
    delete task.handOn;
    this.emit({ type: 'task_upserted', projectKey: task.projectKey, task: clone(task) });
  }

  /** The open cards of a board column (themes and closed cards stand outside the order). */
  private boardCards(columnId: string): RankedCard[] {
    const stageIds = new Set(stagesOfColumn(this.config.pipeline.stages, columnId).map((stage) => stage.id));
    return this.tasks
      .filter(
        (task) =>
          !isTheme(task) &&
          task.status !== 'done' &&
          task.status !== 'cancelled' &&
          stageIds.has(task.stageId),
      )
      .map(rankedOf);
  }

  /** Writes ranks and nothing else: the update time of a card stays; each card written is announced. */
  private writeRanks(ranks: ReadonlyArray<{ key: string; rank: number }>): void {
    for (const { key, rank } of ranks) {
      const task = this.findTask(key);
      if (!task) continue;
      task.boardRank = rank;
      this.emit({ type: 'task_upserted', projectKey: task.projectKey, task: clone(task) });
    }
  }

  /**
   * A card that has come into a column takes its place there: the top unless told, the top as well when
   * the anchor is gone. A column of finished work has no order of its own.
   */
  private enterColumn(task: Task, placement: BoardPlacement = { at: 'top' }): void {
    const columnId = boardColumnOf(stageOf(this.config, task.stageId));
    if (!columnId || isChronologicalColumn(this.config.pipeline.stages, columnId)) return;
    const column = this.boardCards(columnId).filter((card) => card.key !== task.key);
    let plan = planRanks(column, rankedOf(task), placement);
    if (plan.status !== 'planned') plan = planRanks(column, rankedOf(task), { at: 'top' });
    if (plan.status === 'planned') this.writeRanks(plan.ranks);
  }

  /** A card dropped on the board: a place in a column (PM-118), like the server's route. */
  private boardMove(taskKey: string, body: unknown): MockResponse {
    const input = parseBody(BoardMoveRequest, body);
    if (!input) return error(400, 'invalid_request', 'Invalid board move');
    const target = dropStageOfColumn(this.config.pipeline.stages, input.columnId);
    if (!target) return error(400, 'unknown_column', `The board has no column ${input.columnId}`);
    const task = this.findTask(taskKey);
    if (!task) return error(404, 'not_found', 'Unknown task');
    if (isTheme(task)) return error(409, 'task_is_theme', 'A theme does not move on the board');
    if (task.status === 'cancelled') return error(409, 'task_closed', 'Task is cancelled');
    if (task.stageId !== input.fromStageId)
      return error(409, 'board_stale', 'The card is not in that stage any more', {
        reason: 'source',
        stageId: task.stageId,
      });
    const chronological = isChronologicalColumn(this.config.pipeline.stages, input.columnId);
    const own = boardColumnOf(stageOf(this.config, task.stageId)) === input.columnId;
    const column = this.boardCards(input.columnId);
    const stale = () =>
      error(409, 'board_stale', 'The board changed: the anchor is not a card of the column any more', {
        reason: 'anchor',
        columnId: input.columnId,
      });
    if (own) {
      if (chronological || task.status === 'done')
        return error(409, 'board_column_chronological', 'A column of finished work is ordered by time');
      const plan = planRanks(column, rankedOf(task), input.placement);
      if (plan.status === 'stale') return stale();
      if (plan.status === 'unchanged') return ok(boardResult(task, 'unchanged', []));
      this.writeRanks(plan.ranks);
      return ok(
        boardResult(
          task,
          'reordered',
          plan.ranks.map((entry) => entry.key),
        ),
      );
    }
    const placement = input.placement;
    if (
      !chronological &&
      (placement.at === 'before' || placement.at === 'after') &&
      !column.some((card) => card.key === placement.anchor)
    )
      return stale();
    const along = input.withSubtasks
      ? subtasksMovingAlong(
          this.config.pipeline.stages,
          task,
          this.tasks.filter((other) => other.parentKey === task.key),
        )
      : [];
    if (along.length > 0) return this.boardGroupMove(task, along, target, placement);
    const before = new Map(this.tasks.map((other) => [other.key, other.boardRank]));
    const response = this.move(task, target.id, this.viewerActor(), placement);
    if (response.status >= 400) return response;
    const moved = task.stageId !== input.fromStageId;
    const reranked = this.tasks
      .filter((other) => other.key !== task.key && other.boardRank !== before.get(other.key))
      .map((other) => other.key);
    return ok(boardResult(task, moved ? 'moved' : 'unchanged', moved ? reranked : []));
  }

  /**
   * A collecting card with the subtasks of its column (PM-121), like the server's group move: each card
   * goes through its own gates and approval request, a refusal of one leaves the others moving, and the
   * ones that moved stand together at the dropped place, the collecting card first.
   */
  private boardGroupMove(
    parent: Task,
    along: readonly Task[],
    target: Stage,
    placement: BoardPlacement,
  ): MockResponse {
    const before = new Map(this.tasks.map((other) => [other.key, other.boardRank]));
    const items: BoardGroupItem[] = [];
    let previous: string | null = null;
    for (const card of [parent, ...along]) {
      const response = this.move(card, target.id, this.viewerActor(), groupPlacement(placement, previous));
      if (response.status < 400) {
        items.push({ taskKey: card.key, outcome: 'moved' });
        previous = card.key;
        continue;
      }
      const failure = (response.body as { error: { code: string; details?: GateBlockedDetails } }).error;
      if (failure.code === 'gate_blocked')
        items.push({
          taskKey: card.key,
          outcome: 'blocked',
          code: 'gate_blocked',
          message: 'Gate conditions are not met',
          unmet: failure.details?.unmet ?? [],
          approvals: failure.details?.approvals ?? [],
        });
      else if (failure.code === 'approval_requested')
        items.push({
          taskKey: card.key,
          outcome: 'approval_pending',
          inboxItemIds: failure.details?.inboxItemIds ?? [],
        });
      else if (failure.code === 'task_closed')
        items.push({ taskKey: card.key, outcome: 'skipped', reason: 'closed' });
      else if (NO_APPROVER_CODES.has(failure.code))
        items.push({
          taskKey: card.key,
          outcome: 'blocked',
          code: 'no_approver',
          message: 'Nobody may approve this card',
          unmet: [],
          approvals:
            failure.details?.stageId && failure.details.label
              ? [{ stageId: failure.details.stageId, label: failure.details.label, approvers: [] }]
              : [],
        });
      else return response;
    }
    const reranked = this.tasks
      .filter((other) => other.key !== parent.key && other.boardRank !== before.get(other.key))
      .map((other) => other.key);
    const result = boardResult(parent, parent.stageId === target.id ? 'moved' : 'unchanged', reranked);
    return ok({ ...result, group: items });
  }

  private openDecisions(task: Task): InboxItem[] {
    return this.inbox.filter(
      (item) => item.state === 'open' && item.kind === 'decision' && item.taskKey === task.key,
    );
  }

  /** The open approval request for this move (one decision per missing approval). */
  private openGateRequests(task: Task, target: Stage): InboxItem[] {
    return this.openDecisions(task).filter((item) => {
      const gate = gateRequestOf(item);
      return gate?.fromStageId === task.stageId && gate.toStageId === target.id;
    });
  }

  /**
   * Like the server: a move needs an approval nobody may give (every holder authored the task,
   * or nobody holds the label) and no request for it is open yet.
   */
  private noApproverError(task: Task, target: Stage, approvals: ApprovalRequirement[]): MockResponse | null {
    if (this.openGateRequests(task, target).length) return null;
    const missing = approvals.find((approval) => !approval.approvers.length);
    if (!missing) return null;
    return error(
      409,
      noApproverReason(this.config, missing.label, task) ?? 'missing_duty_holder',
      `Nobody may approve the label ${missing.label} on this task`,
      { stageId: missing.stageId, label: missing.label },
    );
  }

  /** One decision per missing approval (or the request already open); the task waits. */
  private requestApproval(
    task: Task,
    target: Stage,
    approvals: ApprovalRequirement[],
    actor: Actor,
    placement?: BoardPlacement,
  ): MockResponse {
    const open = this.openGateRequests(task, target);
    if (open.length) return approvalRequestedError(open);
    const nobody = this.noApproverError(task, target, approvals);
    if (nobody) return nobody;
    const requestId = mockId('gat');
    const items = approvals.map((approval): InboxItem => {
      const gate: GateRequestPayload = {
        requestId,
        taskKey: task.key,
        fromStageId: task.stageId,
        toStageId: target.id,
        stageId: approval.stageId,
        label: approval.label,
        requestedBy: actor,
        ...(placement ? { placement } : {}),
      };
      const item: InboxItem = {
        id: mockId('inb'),
        projectKey: task.projectKey,
        kind: 'decision',
        assignees: approval.approvers,
        source: actor.handle ?? 'system',
        sessionId: null,
        taskKey: task.key,
        title: task.title,
        body: null,
        payload: { gate },
        options: fixtures.DECISION_OPTIONS,
        state: 'open',
        resolution: null,
        createdAt: nowIso(),
      };
      this.upsertInbox(item);
      return item;
    });
    const waiting = task.status === 'active';
    if (waiting) this.updateTask(task.key, { status: 'waiting' });
    this.addTimeline(task.key, actor.handle, 'task_updated', {
      fields: waiting ? ['status'] : [],
      gateRequest: {
        requestId,
        from: task.stageId,
        to: target.id,
        inboxItemIds: items.map((item) => item.id),
      },
    });
    return approvalRequestedError(items);
  }

  private applyMove(
    task: Task,
    target: Stage,
    actor: Actor,
    extra: Pick<TimelineEventData['task_stage_changed'], 'approvedBy' | 'inboxItemIds'>,
    placement?: BoardPlacement,
  ): void {
    const from = task.stageId;
    const patch: Partial<Task> = { stageId: target.id };
    if (from !== target.id) patch.stageEnteredAt = nowIso();
    if (target.kind === 'done') Object.assign(patch, { status: 'done', closedAt: nowIso() });
    else if (task.status === 'done' || task.status === 'waiting')
      Object.assign(patch, { status: 'active', closedAt: null });
    this.updateTask(task.key, patch);
    // Into another column the card takes a place (the top unless the drop said where).
    if (boardColumnOf(stageOf(this.config, from)) !== boardColumnOf(target))
      this.enterColumn(task, placement);
    this.addTimeline(task.key, actor.handle, 'task_stage_changed', { from, to: target.id, ...extra });
    if (stageIndex(this.config.pipeline, target.id) < stageIndex(this.config.pipeline, from))
      this.expireLabels(task, 'moved_back');
    // Requests made from the previous stage are stale now.
    for (const item of this.openDecisions(task)) this.upsertInbox({ ...item, state: 'cancelled' });
    this.clearHandOn(task);
  }

  /** Ends the "waiting for approval" status after a rejected or dropped request. */
  private settleWaiting(
    task: Task,
    by: string,
    data: Pick<TimelineEventData['task_updated'], 'gateRejected' | 'gateBlocked'>,
  ): void {
    const waiting = task.status === 'waiting';
    if (waiting) this.updateTask(task.key, { status: 'active' });
    this.addTimeline(task.key, by, 'task_updated', { fields: waiting ? ['status'] : [], ...data });
  }

  /** Completes (or drops) the stage move an approver decided on, like the server. */
  private decideGate(item: InboxItem, gate: GateRequestPayload): void {
    const task = this.findTask(gate.taskKey);
    const by = item.resolution?.by;
    if (!task || !by) return;
    const siblings = this.inbox.filter(
      (entry) => entry.taskKey === task.key && gateRequestOf(entry)?.requestId === gate.requestId,
    );
    if (item.resolution?.optionId !== 'approve') {
      for (const sibling of siblings)
        if (sibling.state === 'open') this.upsertInbox({ ...sibling, state: 'cancelled' });
      this.settleWaiting(task, by, {
        gateRejected: { requestId: gate.requestId, to: gate.toStageId, inboxItemId: item.id },
      });
      return;
    }
    if (siblings.some((sibling) => sibling.state === 'open')) return;
    if (!siblings.every((s) => s.state === 'resolved' && s.resolution?.optionId === 'approve')) return;
    if (task.stageId !== gate.fromStageId || task.status === 'cancelled') return;
    const target = stageOf(this.config, gate.toStageId);
    if (!target) {
      this.settleWaiting(task, by, { gateBlocked: { to: gate.toStageId, reason: 'unknown_stage' } });
      return;
    }
    // Approving puts each requested human-only label on the task in the approver's name.
    for (const sibling of siblings) {
      const label = gateRequestOf(sibling)?.label;
      if (!label) {
        // A request from before approvals were labels names no label to put on.
        this.settleWaiting(task, by, { gateBlocked: { to: target.id } });
        return;
      }
      const approver: Actor = { kind: 'human', handle: sibling.resolution!.by };
      const refused = this.applyLabels(task, { add: [label] }, approver, { reason: 'approval' });
      if (refused) {
        const code = (refused.body as { error: { code: string } }).error.code;
        this.settleWaiting(task, by, { gateBlocked: { to: target.id, label, reason: code } });
        return;
      }
    }
    const evaluation = evaluateMove(task, this.config, task.stageId, target.id);
    if (evaluation.unmet.length || evaluation.approvals.length) {
      this.settleWaiting(task, by, {
        gateBlocked: { to: target.id, unmet: evaluation.unmet, approvals: evaluation.approvals },
      });
      return;
    }
    this.applyMove(
      task,
      target,
      { kind: 'human', handle: by },
      {
        approvedBy: unique(siblings.map((sibling) => sibling.resolution!.by)),
        inboxItemIds: siblings.map((sibling) => sibling.id),
      },
      gate.placement,
    );
  }

  private validateParent(
    taskKey: string | null,
    parentKey: string,
    kind?: Task['kind'],
  ): MockResponse | null {
    const refusal = subtaskParentRefusal(parentKey, this.findTask(parentKey), {
      key: taskKey,
      projectKey: fixtures.PROJECT_KEY,
      hasSubtasks: taskKey !== null && this.tasks.some((child) => child.parentKey === taskKey),
      kind,
    });
    return refusal ? error(400, refusal, `The task cannot become a subtask of ${parentKey}`) : null;
  }

  /** The theme rule of the server (`themeRefusal`) for a card that is not a subtask by the time the change is done. */
  private themeError(
    themeKey: string,
    card: Pick<Task, 'kind'>,
    parentKey: string | null,
  ): MockResponse | null {
    const code = themeRefusal(this.findTask(themeKey), {
      projectKey: fixtures.PROJECT_KEY,
      kind: card.kind,
      parentKey,
    });
    return code ? error(400, code, `The card cannot be put into the theme ${themeKey}: ${code}`) : null;
  }

  /** Records that a card went from one theme to another on its own timeline and on both themes'. */
  private recordThemeChange(taskKey: string, previous: string | null, themeKey: string | null): void {
    if (previous === themeKey) return;
    for (const key of new Set([taskKey, previous, themeKey]))
      if (key) this.addTimeline(key, this.viewerHandle, 'task_theme_changed', { themeKey, previous });
  }

  /** A subtask reads its parent's theme, like the server: the mock keeps them equal and announces a change. */
  private syncSubtaskThemes(): void {
    for (const task of this.tasks) {
      if (!task.parentKey) continue;
      const next = this.findTask(task.parentKey)?.themeKey ?? null;
      if ((task.themeKey ?? null) !== next) this.updateTask(task.key, { themeKey: next });
    }
  }

  private recordParentChange(subtaskKey: string, previous: string | null, next: string | null): void {
    for (const [parentKey, type] of [
      [previous, 'task_subtask_removed'],
      [next, 'task_subtask_added'],
    ] as const) {
      if (!parentKey) continue;
      for (const taskKey of [parentKey, subtaskKey])
        this.addTimeline(taskKey, this.owner, type, { parentKey, subtaskKey });
    }
  }

  /**
   * Plans a change of relations with the shared rules (the server's too): what to write, or the
   * refusal as the server answers it. Nothing is written.
   */
  private planRelationChange(
    task: Task,
    change: RelationsChange,
    cards: readonly Task[] = this.tasks,
  ): { steps: RelationStep[]; closes: boolean } | MockResponse {
    const viewer = this.findMember(this.viewerHandle);
    const plan = planRelations({
      task,
      cards,
      elsewhere: () => undefined,
      change,
      markDuplicate: () =>
        duplicateMarkRefusal({
          task,
          stageKind: stageOf(this.config, task.stageId)?.kind,
          hasLiveSession: this.taskSessions(task.key).some((session) => this.isLive(session)),
          mayCancel: viewer?.kind === 'human' && (viewer.role === 'admin' || viewer.role === 'owner'),
        }),
    });
    if (plan.ok) return plan;
    const { refusal } = plan;
    return error(
      refusal.code === 'duplicate_not_allowed' ? 403 : 400,
      refusal.code,
      `The relation with ${plan.key} is refused: ${refusal.code}`,
      refusal,
    );
  }

  /** Writes a planned relation change: the links, the parents, both timelines, and the close of a duplicate. */
  private applyRelationPlan(steps: readonly RelationStep[], task: Task, actor: Actor): void {
    for (const step of steps) {
      if (step.type === 'link_add' || step.type === 'link_remove') {
        const owner = this.findTask(step.owner)!;
        const links =
          step.type === 'link_add'
            ? [...owner.links, { kind: step.kind, ref: step.ref }]
            : owner.links.filter((l) => !(l.kind === step.kind && l.ref === step.ref));
        this.updateTask(owner.key, { links });
        const type = step.type === 'link_add' ? 'task_relation_added' : 'task_relation_removed';
        this.addTimeline(step.owner, actor.handle, type, { kind: step.kind, ref: step.ref });
        this.addTimeline(step.ref, actor.handle, type, {
          kind: reverseRelationKind(step.kind),
          ref: step.owner,
        });
      } else if (step.type === 'parent') {
        const child = this.findTask(step.child)!;
        const previous = child.parentKey ?? null;
        // A card that becomes a subtask loses the theme it had: it reads its parent's from now on.
        const ownTheme = !previous && step.parent ? (child.themeKey ?? null) : null;
        this.updateTask(child.key, { parentKey: step.parent, ...(ownTheme ? { themeKey: null } : {}) });
        this.recordParentChange(child.key, previous, step.parent);
        if (ownTheme) this.recordThemeChange(child.key, ownTheme, null);
      } else if (isOpenTask(this.findTask(task.key)!)) {
        this.cancelTask(task.key, {
          reason: `duplicate of ${step.original}`,
          duplicateOf: step.original,
        });
      }
    }
  }

  /** Like the server: a new task may start in any stage its gates let it enter (imports skip them). */
  private createTask(body: unknown): MockResponse {
    const input = parseBody(CreateTaskRequest, body);
    if (!input) return error(400, 'invalid_request', 'Invalid task');
    const actor = this.viewerActor();
    if (input.importedAt !== undefined && this.findMember(this.viewerHandle)?.role !== 'owner')
      return error(403, 'owner_only', 'Only an owner may import tasks');
    const first = this.config.pipeline.stages[0]!;
    const kind = input.kind ?? 'task';
    if (kind === 'theme' && (input.stageId !== undefined || input.repo))
      return error(400, 'task_is_theme', 'A theme has no stage and no repository');
    const target = input.stageId ? stageOf(this.config, input.stageId) : first;
    if (!target) return error(400, 'unknown_stage', 'Unknown stage');
    const title = input.title.trim();
    if (!title) return error(400, 'invalid_request', 'Empty title');
    const repo = input.repo ?? null;
    if (repo && !repoOf(this.config, repo)) return error(400, 'unknown_repo', 'Unknown repository');
    if (input.parentKey) {
      const refusal = this.validateParent(null, input.parentKey, kind);
      if (refusal) return refusal;
    }
    if (input.themeKey) {
      const refusal = this.themeError(
        input.themeKey,
        { kind },
        input.parentKey ?? (input.relations?.some((r) => r.kind === 'part_of') ? '-' : null),
      );
      if (refusal) return refusal;
    }
    const at = input.importedAt ?? nowIso();
    const task: Task = {
      ...(kind === 'theme' ? { kind } : {}),
      ...(input.themeKey ? { themeKey: input.themeKey } : {}),
      parentKey: input.parentKey ?? null,
      id: mockId('tsk'),
      projectKey: fixtures.PROJECT_KEY,
      key: `${fixtures.PROJECT_KEY}-0`,
      title,
      description: input.description ?? '',
      stageId: first.id,
      status: 'active',
      assignee: null,
      repo,
      priority: null,
      labels: unique((input.labels ?? []).map((label) => label.trim()).filter(Boolean)),
      links: [],
      visibility: input.visibility ?? 'internal',
      createdBy: this.viewerHandle,
      createdAt: at,
      stageEnteredAt: at,
      updatedAt: at,
      closedAt: null,
    };
    if (target.id !== first.id) {
      if (input.importedAt === undefined) {
        const evaluation = evaluateMove(task, this.config, first.id, target.id);
        if (evaluation.unmet.length || evaluation.approvals.length) return gateBlockedError(evaluation);
      }
      task.stageId = target.id;
    }
    if (target.kind === 'done') Object.assign(task, { status: 'done', closedAt: at });
    if (input.importedAt === undefined) {
      const plan = planLabelChange(this.config, { ...task, labels: [] }, { add: task.labels }, actor);
      if (!plan.ok) return labelChangeError(plan.refusal);
    }
    // Relations are planned with the new card among the project's: a refused one refuses the creation.
    const nextKey = `${fixtures.PROJECT_KEY}-${this.lastTaskSeq + 1}`;
    const relationPlan = input.relations?.length
      ? this.planRelationChange({ ...task, key: nextKey }, { add: input.relations }, [
          ...this.tasks,
          { ...task, key: nextKey },
        ])
      : null;
    if (relationPlan && 'status' in relationPlan) return relationPlan;
    this.lastTaskSeq += 1;
    task.key = nextKey;
    this.tasks.push(task);
    // A new card goes to the top of its column (no rank for a theme, nor in a column of finished work).
    if (!isTheme(task)) this.enterColumn(task);
    this.emit({ type: 'task_upserted', projectKey: task.projectKey, task: clone(task) });
    this.addTimeline(
      task.key,
      actor.handle,
      'task_created',
      { title, ...(input.importedAt !== undefined ? { imported: true } : {}) },
      null,
      at,
    );
    if (task.parentKey) this.recordParentChange(task.key, null, task.parentKey);
    if (task.themeKey) this.recordThemeChange(task.key, null, task.themeKey);
    if (relationPlan) this.applyRelationPlan(relationPlan.steps, task, actor);
    this.syncSubtaskThemes();
    return { status: 201, body: clone(this.findTask(task.key)!) };
  }

  private startTask(taskKey: string, body: unknown): MockResponse {
    const input = parseBody(StartTaskRequest, body);
    const task = this.findTask(taskKey);
    if (!task || !input) return error(404, 'not_found', 'Unknown task');
    if (isTheme(task)) return error(409, 'task_is_theme', 'A theme is not started');
    if (!isOpenTask(task)) return error(409, 'task_closed', 'Task is closed');
    const workStage = this.config.pipeline.stages.find((stage) => stage.kind === 'work');
    // Like the server: a person's Start of a card that is not ready to start is refused first (PM-291).
    const block = workStage ? startBlock(task, this.config) : null;
    if (workStage && block) return gateBlockedError(evaluateStart(task, this.config, workStage.id), block);
    // A person's start of a card with an open prerequisite needs the warning accepted (PM-204).
    const open = openPrerequisites(task, this.tasks).map((card) => card.key);
    if (open.length > 0 && !input.despitePrerequisites)
      return error(409, 'prerequisite_open', `Task ${task.key} waits for ${open.join(', ')}`, {
        prerequisites: open,
      });
    // Like the server: a gate that lacks only labels AI members set starts them, and the developer waits (PM-236).
    if (
      workStage &&
      stageIndex(this.config.pipeline, task.stageId) < stageIndex(this.config.pipeline, workStage.id)
    ) {
      const evaluation = evaluateStart(task, this.config, workStage.id);
      // A project with refinement (decision 31) does not start the setters from the Start button.
      const setters = projectRefines(this.config)
        ? null
        : aiLabelSetters(this.config, evaluation.unmet, (handle) =>
            this.sessions.some(
              (s) => s.member === handle && s.workItem.type === 'task' && s.workItem.taskKey === task.key,
            ),
          );
      if (setters) {
        for (const member of setters.members) this.openTaskSession(task, member.handle);
        this.labelWaits.set(task.key, { input, workStageId: workStage.id });
        this.updateTask(task.key, {
          startWaiting: {
            reason: 'label_missing',
            labels: setters.labels,
            member: setters.members[0]!.handle,
            since: nowIso(),
          },
        });
        return ok(this.taskDetail(task));
      }
      // Like the server: a gate no AI member can open refuses the Start.
      if (evaluation.unmet.length > 0) return gateBlockedError(evaluation);
    }
    return this.startDeveloper(task, input);
  }

  /** The developer's start of a card (the part of the Start button after the gate). */
  private startDeveloper(task: Task, input: StartTaskRequest): MockResponse {
    const workStage = this.config.pipeline.stages.find((stage) => stage.kind === 'work');
    const eligible = workStage ? stageOwners(this.config, workStage) : [];
    const developers = this.members.filter(
      (member) => eligible.includes(member.handle) && member.status !== 'retired' && !member.onLeave,
    );
    let assignee: string | null = input.assignee ?? null;
    if (!assignee && workStage) {
      // The automatic choice is the shared rule (PM-348): a Senior card goes to a free Senior or waits for one.
      const pick = this.pickAutomatic(task, workStage, developers);
      if (pick.kind === 'senior_busy') return this.waitForSenior(task, workStage, pick.seniors);
      if (pick.kind === 'member') assignee = pick.handle;
    }
    assignee ??=
      [...developers].sort((a, b) => a.currentTaskKeys.length - b.currentTaskKeys.length)[0]?.handle ?? null;
    if (!assignee) return error(409, 'no_free_member', 'No developer available');
    if (!eligible.includes(assignee))
      return error(400, 'not_stage_owner', 'Assignee must own the work stage');
    // Like admission: a role that changes files needs the task's repository, and nothing has happened yet.
    const chosen = memberOf(this.config, assignee);
    if (isOnLeave(chosen)) return error(409, 'member_on_leave', `${assignee} is on leave`);
    if (chosen?.kind === 'ai' && repoRequired(this.config, chosen.role, task))
      return error(409, 'repo_required', 'The task needs a repository before a developer starts on it', {
        taskKey: task.key,
      });
    const running = this.sessions.find(
      (s) =>
        s.member === assignee &&
        s.workItem.type === 'task' &&
        s.workItem.taskKey === task.key &&
        this.isLive(s),
    );
    if (this.findMember(assignee)?.kind === 'ai' && !running && !this.config.team.limits.aiEnabled)
      return error(409, 'ai_disabled', 'AI work is switched off in this project');
    if (this.findMember(assignee)?.kind === 'ai' && !running && this.pauses.isPaused())
      return error(409, 'team_paused', 'The team is paused');
    const from = task.stageId;
    this.updateTask(task.key, {
      assignee,
      stageId: workStage?.id ?? task.stageId,
      status: 'active',
      startWaiting: undefined,
    });
    this.addTimeline(task.key, null, 'task_assigned', { assignee });
    if (workStage && from !== workStage.id)
      this.addTimeline(task.key, null, 'task_stage_changed', { from, to: workStage.id });
    this.settleSeniorWaits();
    if (this.findMember(assignee)?.kind === 'human' || running) return ok(this.taskDetail(task));
    this.openTaskSession(task, assignee);
    return ok(this.taskDetail(task));
  }

  /** The automatic choice of the developer (the shared rule, PM-348) among the free AI owners of the work stage. */
  private pickAutomatic(task: Task, workStage: Stage, developers: readonly MemberView[]) {
    const eligible = new Set(developers.map((member) => member.handle));
    const free = this.config.team.members.flatMap((member, index) =>
      member.kind === 'ai' && eligible.has(member.handle) && this.memberLoad(member.handle) < member.capacity
        ? [
            {
              handle: member.handle,
              senior: isSenior(member),
              temp: !!member.temp,
              load: this.memberLoad(member.handle),
              index,
            },
          ]
        : [],
    );
    return pickDeveloper({
      level: developerLevelOf(task),
      anyDecided: this.seniorWaits.get(task.key)?.decision?.decision === 'any',
      seniors: seniorsOf(this.config, workStage)
        .map((member) => member.handle)
        .filter((handle) => stageOwners(this.config, workStage).includes(handle)),
      free,
    });
  }

  /** A card recommended for the Senior while every Senior is busy: it moves into the work stage and waits, with no assignee. */
  private waitForSenior(task: Task, workStage: Stage, seniors: string[]): MockResponse {
    const from = task.stageId;
    const wait = this.seniorWaits.get(task.key) ?? { since: nowIso() };
    this.seniorWaits.set(task.key, wait);
    this.updateTask(task.key, {
      stageId: workStage.id,
      status: 'active',
      startWaiting: {
        reason: 'senior_busy',
        seniors,
        ...(wait.decision?.decision === 'wait' ? { waitDecidedBy: wait.decision.by } : {}),
        since: wait.since,
      },
    });
    if (from !== workStage.id)
      this.addTimeline(task.key, null, 'task_stage_changed', { from, to: workStage.id });
    return ok(this.taskDetail(this.findTask(task.key)!));
  }

  /**
   * The wait limit has passed: the owners get one question about the card (the server asks from its timer, after
   * `seniorWaitMinutes`). Asks once per wait; a decided or already asked wait is left alone.
   */
  askSeniorWait(taskKey: string): void {
    const task = this.findTask(taskKey);
    const wait = this.seniorWaits.get(taskKey);
    if (!task || !wait || wait.itemId || wait.decision || task.startWaiting?.reason !== 'senior_busy') return;
    const deciders = this.config.team.members
      .filter((member) => member.kind === 'human' && member.access === 'owner')
      .map((member) => member.handle);
    const minutes = seniorWaitMinutesOf(this.config.team.limits);
    const seniors = task.startWaiting.seniors ?? [];
    const item: InboxItem = {
      id: mockId('inb'),
      projectKey: fixtures.PROJECT_KEY,
      kind: 'decision',
      assignees: deciders,
      source: 'system',
      sessionId: null,
      taskKey,
      title: `${taskKey} waits for the Senior`,
      body: null,
      payload: {
        seniorWait: {
          taskKey,
          since: wait.since,
          minutes,
          seniors,
          reason: task.developerLevel?.reason ?? null,
        },
      },
      options: clone(SENIOR_WAIT_OPTIONS),
      state: 'open',
      resolution: null,
      createdAt: nowIso(),
    };
    wait.itemId = item.id;
    this.upsertInbox(item);
    this.addTimeline(taskKey, null, 'task_senior_wait', { phase: 'asked', minutes, seniors, deciders });
  }

  /** What a person answered about a card that waits for the Senior: kept for the start, which tries again. */
  private afterSeniorWaitDecision(item: InboxItem): void {
    const wait = item.taskKey ? this.seniorWaits.get(item.taskKey) : undefined;
    const optionId = item.resolution?.optionId;
    const decision =
      optionId === SENIOR_WAIT_OPTION_WAIT ? 'wait' : optionId === SENIOR_WAIT_OPTION_ANY ? 'any' : null;
    if (!item.taskKey || !wait || !decision || !item.resolution) return;
    wait.decision = { decision, by: item.resolution.by };
    this.addTimeline(item.taskKey, null, 'task_senior_wait', {
      phase: 'decided',
      decision,
      by: item.resolution.by,
    });
    const task = this.findTask(item.taskKey);
    if (task?.startWaiting?.reason === 'senior_busy')
      this.updateTask(task.key, {
        startWaiting: {
          ...task.startWaiting,
          ...(decision === 'wait' ? { waitDecidedBy: item.resolution.by } : {}),
        },
      });
    this.settleSeniorWaits();
  }

  /**
   * The cards that wait for a Senior are looked at again, as the server does when a session ends, a card or the
   * roster changes: a free Senior (or a free developer after the "any" answer) starts the card, and a wait whose
   * card went another way ends, closing its open question by itself.
   */
  private settleSeniorWaits(): void {
    for (const [taskKey, wait] of [...this.seniorWaits]) {
      const task = this.findTask(taskKey);
      const stage = task ? stageOf(this.config, task.stageId) : undefined;
      let ended: 'senior' | 'ended' | null = null;
      if (!task || !isOpenTask(task) || stage?.kind !== 'work') ended = 'ended';
      else if (task.assignee) ended = isSenior(memberOf(this.config, task.assignee)) ? 'senior' : 'ended';
      else if (developerLevelOf(task) !== 'senior') ended = 'ended';
      else if (seniorsOf(this.config, stage).length === 0) ended = 'ended';
      if (ended) {
        this.endSeniorWait(taskKey, wait, ended === 'senior');
        // A card that lost its Senior wait goes to any developer; the start tries again.
        if (task && !task.assignee && task.startWaiting?.reason === 'senior_busy' && stage?.kind === 'work') {
          if (seniorsOf(this.config, stage).length === 0)
            this.addTimeline(taskKey, null, 'task_senior_wait', { phase: 'no_senior' });
          this.startDeveloper(task, {});
        }
        continue;
      }
      if (task?.startWaiting?.reason === 'senior_busy' && stage) {
        const developers = this.members.filter(
          (member) =>
            stageOwners(this.config, stage).includes(member.handle) &&
            member.status !== 'retired' &&
            !member.onLeave,
        );
        if (this.pickAutomatic(task, stage, developers).kind === 'member') this.startDeveloper(task, {});
      }
    }
  }

  /** The wait is over: the card no longer waits, and its open question closes by itself. */
  private endSeniorWait(taskKey: string, wait: { itemId?: string }, senior: boolean): void {
    this.seniorWaits.delete(taskKey);
    if (this.findTask(taskKey)?.startWaiting?.reason === 'senior_busy')
      this.updateTask(taskKey, { startWaiting: undefined });
    const item = this.inbox.find((entry) => entry.id === wait.itemId && entry.state === 'open');
    if (!item) return;
    this.upsertInbox({
      ...item,
      state: 'resolved',
      resolution: {
        optionId: 'ended',
        by: 'system',
        at: nowIso(),
        note: null,
        rule: senior ? 'senior_took' : 'senior_wait_ended',
      },
    });
    if (senior) this.addTimeline(taskKey, null, 'task_senior_wait', { phase: 'senior_took' });
  }

  /** Starts the member's session on the card, unless one is live. */
  private openTaskSession(task: Task, handle: string): void {
    const live = this.sessions.some(
      (s) =>
        s.member === handle &&
        s.workItem.type === 'task' &&
        s.workItem.taskKey === task.key &&
        this.isLive(s),
    );
    if (live) return;
    const session: Session = {
      id: mockId('ses'),
      projectKey: fixtures.PROJECT_KEY,
      member: handle,
      workItem: { type: 'task', taskKey: task.key },
      claudeSessionId: mockUuid(Math.floor(Math.random() * 1e9)),
      provider: this.providerOf(handle),
      cwd: `/Users/owner/.projectman/worktrees/${fixtures.PROJECT_KEY}/${task.key}`,
      branch: `${taskSeq(task.key)}-work`,
      transcriptPath: null,
      state: 'starting',
      activity: null,
      startedAt: nowIso(),
      lastActivityAt: nowIso(),
      endedAt: null,
      usage: { since: nowIso(), rows: [] },
    };
    this.sessions.push(session);
    this.chats[session.id] = [];
    this.flushTeamMessages(session);
    this.emit({ type: 'session_upserted', projectKey: session.projectKey, session: clone(session) });
    this.addTimeline(task.key, handle, 'session_started', { member: handle, resumed: false }, session.id);
    const member = this.findMember(handle);
    if (member) member.currentTaskKeys = [...member.currentTaskKeys, task.key];
    this.setMemberState(handle, 'working', `Indul: ${task.key}`);
  }

  /** A card waiting for labels starts its developer once the gate lets it through (the server's retry). */
  private continueLabelWait(task: Task): void {
    const wait = this.labelWaits.get(task.key);
    if (!wait || task.startWaiting?.reason !== 'label_missing') return;
    if (evaluateStart(task, this.config, wait.workStageId).unmet.length > 0) return;
    this.labelWaits.delete(task.key);
    this.updateTask(task.key, { startWaiting: undefined });
    this.startDeveloper(task, wait.input);
  }

  /** Hires an AI member with the role's defaults, named and handled like the server does. */
  private hire(body: unknown): MockResponse {
    const input = parseBody(HireMemberRequest, body);
    if (!input) return error(400, 'invalid_request', 'Invalid hire request');
    const failure = this.validateRole(input.role, 'ai');
    if (failure) return failure;
    const defaults = aiMemberDefaults(input.role, this.config.team.roles, this.config.team.roleOverrides);
    if (!defaults) return error(400, 'role_not_for_ai', 'No AI member can hold this role');
    const taken = this.takenHandles();
    if (input.handle && taken.has(input.handle)) return error(409, 'handle_taken', 'Handle already taken');
    const handle = input.handle ?? defaultMemberHandle(input.role, taken, input.specialty);
    const specialty = input.specialty?.trim() ?? '';
    const index =
      this.config.team.members.filter(
        (m) => m.kind === 'ai' && m.role === input.role && (m.specialty ?? '').trim() === specialty,
      ).length + 1;
    const config: AiMemberConfig = {
      kind: 'ai',
      handle,
      displayName:
        input.displayName?.trim() ||
        defaultMemberName(input.role, this.config.project.language, index, {
          specialty: specialty || undefined,
          customRoles: this.config.team.roles,
        }),
      role: input.role,
      ...(input.specialty ? { specialty: input.specialty } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      model:
        input.provider && input.provider !== 'claude'
          ? modelForProvider(input.provider, input.model)
          : (input.model ?? defaults.model),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.cheapSubagent ? { cheapSubagent: input.cheapSubagent } : {}),
      permissionMode: defaults.permissionMode,
      approver: defaults.approver,
      outboundNetwork: input.outboundNetwork ?? defaults.outboundNetwork,
      capacity: defaults.capacity,
      instructions: defaults.instructions,
      sponsor: this.sponsor(),
      temp: false,
      ...(input.schedule ? { schedule: input.schedule } : {}),
    };
    const next = clone(this.config);
    next.team.members.push(config);
    const refused = this.configChangeFailure(next);
    if (refused) return refused;
    this.config = next;
    const member: MemberView = {
      handle,
      displayName: config.displayName,
      kind: 'ai',
      provider: config.provider ?? DEFAULT_AGENT_PROVIDER,
      model: config.model,
      effort: config.effort,
      ...(config.cheapSubagent ? { cheapSubagent: config.cheapSubagent } : {}),
      ...permissionView(this.config, config),
      role: config.role,
      roles: memberRoles(config),
      specialty: config.specialty ?? null,
      status: 'idle',
      activity: null,
      currentTaskKeys: [],
      sponsor: config.sponsor,
      temp: false,
    };
    this.members.push(member);
    this.commitConfig(`Hire ${input.role} ${handle}`);
    this.addTimeline(null, this.viewerHandle, 'member_hired', {
      handle,
      role: config.role,
      temp: false,
      sponsor: config.sponsor,
    });
    this.memberChanged(handle);
    return { status: 201, body: clone(member) };
  }

  /** The sponsor of an AI member a human hires: the requester when an owner, else the first owner. */
  private sponsor(): string {
    const viewer = memberOf(this.config, this.viewerHandle);
    if (viewer?.kind === 'human' && viewer.access === 'owner') return viewer.handle;
    return (
      this.config.team.members.find((m) => m.kind === 'human' && m.access === 'owner')?.handle ??
      this.viewerHandle
    );
  }

  private retire(handle: string, body: unknown): MockResponse {
    const input = parseBody(RetireMemberRequest, body) ?? {};
    const member = this.findMember(handle);
    if (!member || member.kind !== 'ai') return error(404, 'not_found', 'Unknown AI member');
    if (isRequiredProjectManager(this.config, handle))
      return error(
        409,
        'project_manager_required',
        'the only AI project manager cannot be retired; hire another one first',
      );
    if (isRequiredOperator(this.config, handle))
      return error(409, 'operator_required', 'the Operator cannot be retired');
    const target = input.handoverTo ? this.findMember(input.handoverTo) : undefined;
    const next = clone(this.config);
    next.team.members = next.team.members.filter((m) => m.handle !== handle);
    for (const stage of next.pipeline.stages) {
      if (stage.owners)
        stage.owners = [
          ...new Set(stage.owners.flatMap((h) => (h === handle ? (target ? [target.handle] : []) : [h]))),
        ];
    }
    const failure = this.configChangeFailure(next);
    if (failure) return failure;

    for (const taskKey of member.currentTaskKeys) {
      const task = this.findTask(taskKey);
      if (task?.assignee === handle) this.updateTask(taskKey, { assignee: target?.handle ?? null });
      if (target) target.currentTaskKeys = [...target.currentTaskKeys, taskKey];
    }
    for (const stage of this.config.pipeline.stages) {
      if ((stage.owners ?? []).includes(handle)) {
        stage.owners = (stage.owners ?? []).filter((owner) => owner !== handle);
        if (target && !(stage.owners ?? []).includes(target.handle)) stage.owners.push(target.handle);
      }
    }
    member.status = 'retired';
    member.currentTaskKeys = [];
    this.config.team.members = this.config.team.members.filter((entry) => entry.handle !== handle);
    this.addTimeline(null, this.owner, 'member_retired', { handle, handoverTo: target?.handle ?? null });
    this.commitConfig(`Retire ${handle}${target ? ` (handover to ${target.handle})` : ''}`);
    this.memberChanged(handle);
    return ok();
  }

  /** A human writes into an AI session's chat: like the server, the text trimmed and not empty. */
  private sessionMessage(sessionId: string, body: unknown): MockResponse {
    const input = parseBody(SendMessageRequest, body);
    if (!input) return error(400, 'invalid_request', 'Invalid message');
    const session = this.findSession(sessionId);
    if (!session) return error(404, 'not_found', 'Unknown session');
    const text = input.text.trim();
    if (!text) return error(400, 'invalid_request', 'The message text is empty', { field: 'text' });
    const taskKey = session.workItem.type === 'task' ? session.workItem.taskKey : null;
    if (!this.isLive(session) && !this.config.team.limits.aiEnabled)
      return error(409, 'ai_disabled', 'AI work is switched off in this project');
    // A stopped session is not started while the team is paused; a live one takes the message and holds it.
    if (!this.isLive(session) && this.pauses.isPaused())
      return error(409, 'team_paused', 'The team is paused');
    if (taskKey && this.findTask(taskKey) && !isOpenTask(this.findTask(taskKey)!))
      return error(409, 'task_closed', 'Task is closed');
    this.appendChat(sessionId, [this.chatItem('user_text', { origin: 'human', text })]);
    // A paused session holds the message: it goes through, and the session works on, after the resume.
    if (!this.pauses.isPaused())
      this.updateSession(sessionId, { state: 'working', activity: null, endedAt: null });
    return { status: 202 };
  }

  /**
   * A running session reports usage (the runner's `usage` event, PM-178): it is added to the
   * session, and, as on the server, once the session's `limitTokens` reach the project's warning
   * limit (PM-187) the session is marked and the owners get one alert. The session keeps running.
   */
  reportUsage(sessionId: string, entries: readonly TokenUsage[]): void {
    const session = this.findSession(sessionId);
    if (!session) return;
    const usage = session.usage ?? { since: nowIso(), rows: [] };
    const rows = mergeTokenUsage([...usage.rows, ...entries]);
    const limit = this.config.team.limits.warnAboveSessionTokens;
    const counted = limitTokens(usageTotal(rows));
    const alerted = !session.usageAlert && limit !== undefined && counted >= limit;
    this.updateSession(sessionId, {
      usage: { ...usage, rows },
      ...(alerted ? { usageAlert: { at: nowIso(), countedTokens: counted, limitTokens: limit } } : {}),
    });
    if (!alerted) return;
    const payload: SessionTokensAlert = {
      alert: 'session_tokens',
      countedTokens: counted,
      limitTokens: limit,
      workItem: session.workItem,
      sessionStartedAt: session.startedAt,
    };
    this.upsertInbox({
      id: mockId('inb'),
      projectKey: session.projectKey,
      kind: 'alert',
      assignees: boundaryOwners(this.config),
      source: session.member,
      sessionId: session.id,
      taskKey: session.workItem.type === 'task' ? session.workItem.taskKey : null,
      title: `Session used ${counted} tokens, above the warning limit of ${limit}`,
      body: null,
      payload,
      options: [ALERT_SEEN_OPTION],
      state: 'open',
      resolution: null,
      createdAt: nowIso(),
    });
  }

  /**
   * What the member's sessions used lately (PM-178). The fake keeps no hourly rows: a measured
   * session counts whole in a window its last activity falls in.
   */
  private memberUsage(handle: string): MemberUsage {
    const within = (hours: number) =>
      mergeTokenUsage(
        this.sessions
          .filter(
            (s) =>
              s.member === handle &&
              s.usage &&
              Date.now() - Date.parse(s.lastActivityAt) <= hours * 3_600_000,
          )
          .flatMap((s) => s.usage!.rows),
      );
    return { lastDay: within(24), lastWeek: within(24 * 7) };
  }

  /** What the member is working on now (see `isWorkingOnTask`), plus its live other chats. */
  private memberLoad(handle: string): number {
    const live = this.sessions.filter((s) => s.member === handle && this.isLive(s));
    const keys = new Set(
      live.flatMap((s) => {
        if (s.workItem.type !== 'task') return [];
        const task = this.findTask(s.workItem.taskKey);
        return task && isOpenTask(task) && isWorkingOnTask(this.config, task, handle, s.state)
          ? [task.key]
          : [];
      }),
    );
    return keys.size + live.filter((s) => s.workItem.type !== 'task').length;
  }

  /** Like the server, a session records the agent CLI it runs: the member's provider. */
  private providerOf(handle: string): AgentProvider {
    const member = memberOf(this.config, handle);
    return (member?.kind === 'ai' ? member.provider : undefined) ?? DEFAULT_AGENT_PROVIDER;
  }

  private planUsageFor(provider: AgentProvider): PlanUsage | null {
    return (
      this.providerPlanUsage[provider] ??
      (provider === 'claude' ? this.planUsage : provider === 'codex' ? this.codexPlanUsage : null)
    );
  }

  /**
   * Why an automatic start of the member's AI work must wait, or null: the project's AI switch, a
   * live previous schedule run (schedule runs only), the member's capacity, the concurrency
   * limit, the provider's plan usage and its login.
   */
  private admissionRefusal(member: AiMemberConfig, opts: { scheduleRun?: boolean } = {}): ErrorCode | null {
    const limits = this.config.team.limits;
    const live = this.sessions.filter((s) => this.isLive(s));
    const provider = member.provider ?? DEFAULT_AGENT_PROVIDER;
    const plan = this.planUsageFor(provider);
    if (!limits.aiEnabled) return 'ai_disabled';
    if (this.pauses.isPaused()) return 'team_paused';
    if (isOnLeave(member)) return 'member_on_leave';
    if (opts.scheduleRun && live.some((s) => s.member === member.handle && s.workItem.type === 'schedule'))
      return 'previous_run_live';
    if (this.memberLoad(member.handle) >= member.capacity) return 'member_at_capacity';
    if (
      aiLimitReached(
        this.config,
        live.filter((s) => ['starting', 'working', 'waiting_permission'].includes(s.state)).length,
      )
    )
      return 'ai_limit_reached';
    // Like the server: after the AI limit, before the plan usage (PM-324).
    if (provider === 'nanogpt') {
      const status = this.providerStatus.nanogpt;
      if (status?.loggedIn === false && status.problem !== 'no_key') return 'nanogpt_setup_incomplete';
      if (!this.nanogptKeyStatus.set) return 'nanogpt_key_missing';
    }
    if (!this.providerLoggedIn[provider]) return 'provider_not_logged_in';
    if (
      pausesOnPlanUsage(provider) &&
      Math.max(plan?.fiveHourPercent ?? 0, plan?.weeklyPercent ?? 0) > limits.pauseAbovePlanUsagePercent
    )
      return 'plan_usage_paused';
    return null;
  }

  private humanTeamMessage(body: unknown): MockResponse {
    const viewer = this.findMember(this.viewerHandle);
    if (!viewer || !['owner', 'admin', 'developer', 'client'].includes(viewer.role))
      return error(403, 'insufficient_access', 'Developer or client required');
    const input = parseBody(SendTeamMessageRequest, body);
    if (!input) return error(400, 'invalid_request', 'Invalid message');
    if (input.taskKey) {
      const task = this.findTask(input.taskKey);
      if (!task || !this.canSee(task)) return error(404, 'not_found', 'Unknown task');
    }
    const refusal = this.teamMessageRefusal(this.viewerHandle, input.to, input.text);
    if (refusal) return refusal;
    const message = this.sendTeamMessage(this.viewerHandle, input.to, input.taskKey ?? null, input.text);
    return { status: 202, body: clone(message) };
  }

  private flushTeamMessages(session: Session): void {
    if (!['idle', 'waiting_input'].includes(session.state)) return;
    // Held while the team is paused; the resume flushes them.
    if (this.pauses.isPaused()) return;
    for (const message of this.messages) {
      const receipt = message.receipts?.find(
        (r) => r.handle === session.member && r.kind === 'ai' && !r.deliveredAt,
      );
      if (!receipt) continue;
      this.appendChat(session.id, [
        this.chatItem('team_message', {
          direction: 'in',
          from: message.from,
          to: [session.member],
          text: message.body,
        }),
      ]);
      receipt.deliveredAt = nowIso();
      if (message.receipts!.every((r) => r.deliveredAt)) message.deliveredAt = nowIso();
      this.emit({ type: 'team_message', projectKey: fixtures.PROJECT_KEY, message: clone(message) });
    }
  }

  /** The project manager's channel (PM-434): the same order of conditions as the server's. */
  private projectManagerChannel(): MockResponse {
    const viewer = this.findMember(this.viewerHandle);
    if (!viewer || viewer.kind !== 'human' || !['owner', 'admin', 'developer'].includes(viewer.role))
      return error(403, 'insufficient_access', 'Developer access required');
    const pm = projectManagerOf(this.config);
    const session = pm
      ? this.sessions.find((s) => s.member === pm.handle && s.workItem.type === 'general')
      : undefined;
    const sessionId = session?.id ?? null;
    if (!pm) return ok({ member: null, state: 'missing', sessionId });
    const member = { handle: pm.handle, displayName: pm.displayName, onLeave: isOnLeave(pm) };
    if (member.onLeave) return ok({ member, state: 'on_leave', sessionId });
    if (this.pauses.isPaused())
      return ok({ member, state: 'waiting', waiting: { reason: 'team_paused', since: nowIso() }, sessionId });
    if (session?.state === 'starting') return ok({ member, state: 'starting', sessionId });
    if (session?.state === 'working' || session?.state === 'waiting_permission')
      return ok({ member, state: 'working', sessionId });
    return ok({ member, state: 'available', sessionId });
  }

  private startConversation(handle: string): MockResponse {
    if (!['owner', 'admin', 'developer'].includes(this.findMember(this.viewerHandle)?.role ?? ''))
      return error(403, 'insufficient_access', 'Developer access required');
    const member = memberOf(this.config, handle);
    if (!member) return error(404, 'not_found', 'Unknown member');
    if (member.kind !== 'ai') return error(400, 'not_ai_member', 'Only AI conversations');
    const existing = this.sessions.find((s) => s.member === handle && s.workItem.type === 'general');
    if (existing && this.isLive(existing)) return { status: 202, body: clone(existing) };
    const refusal = this.admissionRefusal(member);
    if (refusal) return error(409, refusal, 'The conversation cannot start now');
    const at = nowIso();
    const session: Session = existing ?? {
      id: mockId('ses'),
      projectKey: fixtures.PROJECT_KEY,
      member: handle,
      workItem: { type: 'general' },
      claudeSessionId: mockUuid(this.sessions.length + 1),
      provider: this.providerOf(handle),
      cwd: this.config.project.workspacePath,
      branch: null,
      transcriptPath: null,
      state: 'idle',
      activity: null,
      startedAt: at,
      lastActivityAt: at,
      endedAt: null,
      usage: { since: at, rows: [] },
    };
    if (!existing) this.sessions.push(session);
    this.chats[session.id] ??= [];
    this.updateSession(session.id, { state: 'idle', endedAt: null, provider: this.providerOf(handle) });
    this.addTimeline(
      null,
      handle,
      'session_started',
      { member: handle, resumed: Boolean(existing) },
      session.id,
    );
    this.flushTeamMessages(session);
    return { status: 202, body: clone(session) };
  }

  private schedulesView() {
    return {
      timezone: this.config.project.timezone,
      members: this.config.team.members.flatMap((member) => {
        if (member.kind !== 'ai' || !member.schedule) return [];
        let nextRun: string | null = null;
        try {
          nextRun = nextCronRun(member.schedule.cron, new Date(), this.config.project.timezone);
        } catch {
          /* Invalid legacy schedule. */
        }
        return [
          {
            member: member.handle,
            cron: member.schedule.cron,
            promptSummary: member.schedule.prompt.replace(/\s+/g, ' ').slice(0, 140),
            nextRun,
          },
        ];
      }),
      runs: clone(this.scheduleRuns.slice(-20).reverse()),
    };
  }

  private runSchedule(handle: string): MockResponse {
    const member = memberOf(this.config, handle);
    if (!member) return error(404, 'not_found', 'Unknown member');
    if (member.kind !== 'ai' || !member.schedule)
      return error(400, 'member_not_scheduled', 'Member has no AI schedule');
    const reason = this.admissionRefusal(member, { scheduleRun: true });
    const at = nowIso();
    const run: ScheduleRun = {
      id: mockId('run'),
      projectKey: fixtures.PROJECT_KEY,
      member: handle,
      scheduledFor: at,
      startedAt: reason ? null : at,
      sessionId: null,
      status: reason ? 'skipped' : 'started',
      reason,
    };
    this.scheduleRuns.push(run);
    if (reason) {
      this.addTimeline(null, null, 'schedule_skipped', {
        runId: run.id,
        member: handle,
        scheduledFor: at,
        reason,
      });
      return error(409, reason, 'Scheduled run refused', { reason, run: clone(run) });
    }
    const session: Session = {
      id: mockId('ses'),
      projectKey: fixtures.PROJECT_KEY,
      member: handle,
      workItem: { type: 'schedule', runId: run.id },
      claudeSessionId: mockUuid(this.sessions.length + 1),
      provider: this.providerOf(handle),
      cwd: this.config.project.workspacePath,
      branch: null,
      transcriptPath: null,
      state: 'working',
      activity: null,
      startedAt: at,
      lastActivityAt: at,
      endedAt: null,
      usage: { since: at, rows: [] },
    };
    run.sessionId = session.id;
    this.sessions.push(session);
    this.chats[session.id] = [this.chatItem('user_text', { text: member.schedule.prompt, origin: 'brief' })];
    this.flushTeamMessages(session);
    this.emit({ type: 'session_upserted', projectKey: fixtures.PROJECT_KEY, session: clone(session) });
    this.addTimeline(
      null,
      null,
      'schedule_started',
      { runId: run.id, member: handle, scheduledFor: at },
      session.id,
    );
    return { status: 201, body: clone(run) };
  }

  /**
   * An owner sets a session's own permission settings (PM-170), as the server does: only an owner,
   * the AI approver only while it can be chosen, `null` back to the member's. A new mode of a
   * session in a turn waits for its restart; an idle one restarts at once (nothing to show here).
   */
  private updateSessionPermissions(sessionId: string, body: unknown): MockResponse {
    if (this.findMember(this.viewerHandle)?.role !== 'owner')
      return error(403, 'insufficient_access', 'requires owner access');
    const input = parseBody(UpdateSessionRequest, body);
    if (!input) return error(400, 'invalid_request', 'Invalid session update');
    const session = this.findSession(sessionId);
    if (!session) return error(404, 'not_found', 'Unknown session');
    const member = memberOf(this.config, session.member);
    if (member?.kind !== 'ai') return error(404, 'not_found', 'Unknown member');
    if (input.approver) {
      const blocker = approverBlocker(this.config, member.handle, input.approver);
      if (blocker) return error(422, 'approver_unavailable', 'This approver is not available', { blocker });
    }
    const from = effectiveSessionPermissions(member, session);
    const next: Session = clone(session);
    if (input.permissionMode !== undefined) {
      if (input.permissionMode === null) delete next.permissionModeOverride;
      else next.permissionModeOverride = input.permissionMode;
    }
    if (input.approver !== undefined) {
      if (input.approver === null) delete next.approverOverride;
      else next.approverOverride = input.approver;
    }
    const to = effectiveSessionPermissions(member, next);
    const restart =
      this.isLive(session) && session.state !== 'idle' && from.permissionMode !== to.permissionMode;
    const taskKey = session.workItem.type === 'task' ? session.workItem.taskKey : null;
    const record = (field: 'mode' | 'approver', values: [unknown, unknown], sources: [string, string]) => {
      if (values[0] === values[1] && sources[0] === sources[1]) return;
      this.addTimeline(
        taskKey,
        this.viewerHandle,
        'session_permission_changed',
        {
          member: session.member,
          field,
          from: values[0] ?? null,
          to: values[1] ?? null,
          ...(sources[1] === 'member' ? { reset: true } : {}),
          ...(field === 'mode' && restart ? { restart: true } : {}),
        },
        session.id,
      );
    };
    if (input.permissionMode !== undefined)
      record('mode', [from.permissionMode, to.permissionMode], [from.source.mode, to.source.mode]);
    if (input.approver !== undefined)
      record('approver', [from.approver, to.approver], [from.source.approver, to.source.approver]);
    delete session.permissionModeOverride;
    delete session.approverOverride;
    delete session.permissionRestartPending;
    const updated = this.updateSession(sessionId, {
      ...(next.permissionModeOverride ? { permissionModeOverride: next.permissionModeOverride } : {}),
      ...(next.approverOverride ? { approverOverride: next.approverOverride } : {}),
      ...(restart ? { permissionRestartPending: true as const } : {}),
    })!;
    return ok(clone(updated));
  }

  /** The project's pause routes (PM-219): anyone internal reads it, an owner or an admin changes it. */
  private projectPause(method: string, rest: string): MockResponse {
    const viewer = this.findMember(this.viewerHandle);
    if (viewer?.role === 'client') return error(403, 'insufficient_access', 'Internal access required');
    if (method === 'GET') return ok(this.pauses.projectView());
    if (!this.pauses.mayManageProject()) return error(403, 'insufficient_access', 'Admin access required');
    if (rest === '/pause/resume') this.pauses.resume('project');
    else if (rest === '/pause/force') this.pauses.force('project');
    else this.pauses.pauseProject();
    return ok(this.pauses.projectView());
  }

  /** The instance's pause routes: an owner of every project changes it. */
  private instancePause(method: string, path: string): MockResponse {
    const viewer = this.findMember(this.viewerHandle);
    if (!viewer || viewer.role === 'client')
      return error(403, 'insufficient_access', 'Internal access required');
    if (method === 'POST') {
      if (!this.pauses.instanceView().canManage)
        return error(403, 'insufficient_access', 'Only an owner of every project may pause the instance');
      if (path === '/api/pause/resume') this.pauses.resume('instance');
      else if (path === '/api/pause/force') this.pauses.force('instance');
      else this.pauses.pauseInstance({ source: 'app', requestedBy: this.user.name });
    }
    return ok(this.pauses.instanceView());
  }

  private stopSession(sessionId: string, body?: unknown): MockResponse {
    const input = parseBody(StopSessionRequest, body ?? {});
    if (!input) return error(400, 'invalid_request', 'Invalid stop request');
    const session = this.findSession(sessionId);
    if (!session) return error(404, 'not_found', 'Unknown session');
    this.closeSession(sessionId, {
      kind: input.purpose ?? 'manual',
      by: this.viewerActor(),
      ...(input.note ? { note: input.note } : {}),
    });
    if (this.machine?.sessions.some((row) => row.sessionId === sessionId)) {
      const row = this.machine.sessions.find((row) => row.sessionId === sessionId)!;
      this.machine.sessions = this.machine.sessions.filter((row) => row.sessionId !== sessionId);
      this.machine.summary.sessionsRunning--;
      if (row.state === 'working' || row.state === 'starting') this.machine.summary.sessionsWorking--;
      this.machine.closedSessions++;
    }
    return ok();
  }

  /**
   * Ends a session the way the server does (PM-288, PM-295): the reason is on the session
   * (`lastStop`) and in the `session_ended` event of its card. The next message continues it.
   */
  closeSession(sessionId: string, stop: SessionStop): void {
    const session = this.findSession(sessionId);
    if (!session) return;
    this.updateSession(sessionId, { state: 'exited', activity: null, endedAt: nowIso(), lastStop: stop });
    this.appendChat(sessionId, [this.chatItem('system_note', { text: 'A session leállt.' })]);
    if (session.workItem.type === 'task') {
      this.addTimeline(
        session.workItem.taskKey,
        session.member,
        'session_ended',
        { member: session.member, exitCode: 0, stop },
        sessionId,
      );
    }
    this.setMemberState(session.member, 'idle', null);
    // A Senior who has finished takes the card that waited for one.
    this.settleSeniorWaits();
  }

  private resolve(itemId: string, body: unknown): MockResponse {
    const input = parseBody(ResolveInboxRequest, body);
    const item = this.inbox.find((entry) => entry.id === itemId);
    if (!item || !input) return error(404, 'not_found', 'Unknown inbox item');
    if (item.state !== 'open') return error(409, 'inbox_item_closed', 'Already resolved');
    if (!item.options.some((option) => option.id === input.optionId)) {
      return error(400, 'unknown_option', `Unknown option ${input.optionId}`);
    }
    const viewer = memberOf(this.config, this.viewerHandle);
    if (viewer?.kind !== 'human') return error(403, 'ai_approval_forbidden', 'Only humans may approve');
    if (item.kind === 'boundary') return error(403, 'insufficient_access', 'Use the boundary endpoint');
    const gate = item.kind === 'decision' && input.optionId === 'approve' ? gateRequestOf(item) : null;
    if (gate?.label) {
      // Approving puts the label on in the approver's name: the label rules apply up front.
      const task = item.taskKey ? (this.findTask(item.taskKey) ?? null) : null;
      const refusal = approvalRefusal(this.config, gate.label, viewer.handle, task);
      if (refusal) return error(403, refusal, 'The approval is not allowed');
    }
    if (!item.assignees.includes(viewer.handle) && !(item.kind !== 'decision' && viewer.access === 'owner'))
      return error(403, 'not_an_assignee', 'Only assignees may decide');
    const note = input.note?.trim() || null;
    if (item.kind === 'question' && input.optionId === 'answer' && !note) {
      return error(400, 'answer_required', 'A free-text answer needs a note');
    }
    if (item.kind === 'hand_on') {
      // Taking the card on is a move under the gates: refused, the item stays open.
      const request = handOnRequestOf(item);
      const task = item.taskKey ? this.findTask(item.taskKey) : undefined;
      if (!request || !task) return error(404, 'not_found', 'Unknown task');
      const evaluation = evaluateMove(task, this.config, task.stageId, request.toStageId);
      if (evaluation.unmet.length || evaluation.approvals.length) return gateBlockedError(evaluation);
    }
    const resolved: InboxItem = {
      ...item,
      state: 'resolved',
      resolution: { optionId: input.optionId, by: viewer.handle, at: nowIso(), note },
    };
    this.upsertInbox(resolved);
    this.afterResolve(resolved);
    return ok(clone(resolved));
  }

  private refreshBoundaryInbox(): void {
    for (const item of this.inbox.filter((entry) => entry.kind === 'boundary')) {
      const parsed = BoundaryRequest.safeParse(item.payload.boundary);
      if (!parsed.success) continue;
      const request = parsed.data;
      const grant = this.boundaryGrants.get(request.id);
      if (request.consumedAt || grant?.state === 'consumed' || grant?.consumedAt) continue;
      const state = boundaryWaitingState(this.config, request, Date.now());
      if (state === request.state) continue;
      if (grant?.state === 'active' && state === 'expired')
        this.boundaryGrants.set(request.id, { ...grant, state: 'expired', revokedAt: nowIso() });
      const next = {
        ...request,
        state,
        updatedAt: nowIso(),
        assignees: state === 'pending_owner' ? boundaryOwners(this.config) : request.assignees,
        ...(state === 'expired'
          ? {
              invalidation: {
                actor: { kind: 'system', handle: null },
                reason: 'deadline_expired',
                at: nowIso(),
              },
            }
          : {}),
      };
      this.upsertInbox({
        ...item,
        payload: { boundary: next },
        assignees: [...new Set([...next.assignees, ...boundaryOwners(this.config)])],
        state: state === 'expired' && item.state === 'open' ? 'expired' : item.state,
      });
    }
  }

  private decideBoundary(id: string, body: unknown, revoke: boolean): MockResponse {
    this.refreshBoundaryInbox();
    const item = this.inbox.find((entry) => entry.id === id && entry.kind === 'boundary');
    const parsed = BoundaryRequest.safeParse(item?.payload.boundary);
    if (!item || !parsed.success) return error(404, 'not_found', 'Unknown boundary request');
    const request = parsed.data;
    const viewer = memberOf(this.config, this.viewerHandle);
    if (revoke && (viewer?.kind !== 'human' || viewer.access !== 'owner'))
      return error(403, 'owner_only', 'Only owners may revoke');
    const storedGrant = this.boundaryGrants.get(id);
    if (revoke && (request.consumedAt || storedGrant?.state === 'consumed' || storedGrant?.consumedAt))
      return error(409, 'inbox_item_closed', 'Boundary grant was already consumed');
    if (
      revoke ? !['pending_lead', 'pending_owner', 'allowed'].includes(request.state) : item.state !== 'open'
    )
      return error(409, 'inbox_item_closed', 'Boundary request closed');
    const input = revoke ? null : parseBody(DecideBoundaryRequest, body);
    if (!revoke && !input) return error(400, 'invalid_request', 'Invalid decision');
    if (!revoke && !canDecideBoundary(this.config, request, this.viewerHandle))
      return error(403, 'not_an_assignee', 'No live authorization duty');
    const state = revoke ? 'revoked' : input!.decision === 'allow' ? 'allowed' : 'denied';
    const reason = revoke ? 'owner_revoked' : input!.reason;
    const next: BoundaryRequest = {
      ...request,
      state,
      reason: revoke && request.decidedBy ? request.reason : reason,
      updatedAt: nowIso(),
      decidedBy: revoke ? request.decidedBy : { kind: viewer!.kind, handle: viewer!.handle },
      ...(revoke
        ? {
            invalidation: {
              actor: { kind: viewer!.kind, handle: viewer!.handle },
              reason: 'owner_revoked' as const,
              at: nowIso(),
            },
          }
        : {}),
    };
    if (state === 'allowed')
      this.boundaryGrants.set(id, {
        id: `grt_${id.slice(-100)}`,
        requestId: id,
        projectKey: request.projectKey,
        member: request.member,
        sessionId: request.sessionId,
        taskKey: request.taskKey,
        operationId: request.operationId,
        target: request.target,
        policyVersion: request.policyVersion,
        state: 'active',
        decidedBy: next.decidedBy!,
        reason: input!.reason,
        createdAt: nowIso(),
        expiresAt: request.expiresAt,
        revokedAt: null,
        consumedAt: null,
      });
    const grant = this.boundaryGrants.get(id);
    if (revoke && grant?.state === 'active')
      this.boundaryGrants.set(id, { ...grant, state: 'revoked', revokedAt: nowIso() });
    this.upsertInbox({
      ...item,
      state: revoke && item.state === 'open' ? 'cancelled' : 'resolved',
      payload: { boundary: next },
      resolution:
        revoke && item.resolution
          ? item.resolution
          : {
              optionId: state === 'allowed' ? 'allow' : 'deny',
              by: this.viewerHandle,
              at: nowIso(),
              note: reason,
            },
    });
    this.addTimeline(
      item.taskKey,
      this.viewerHandle,
      'boundary_changed',
      {
        requestId: id,
        state,
        reason,
        operation: request.target.operation,
        resource: request.target.resource,
        category: request.category,
        assignees: request.assignees,
        policyVersion: request.policyVersion,
      },
      item.sessionId,
    );
    return ok(clone(next));
  }

  /** What the server does with a decision: record it, answer the asker, apply a gate decision. */
  private afterResolve(item: InboxItem): void {
    const resolution = item.resolution!;
    const sessionId = item.sessionId;
    if (loopDecisionOf(item)) {
      this.afterLoopDecision(item);
      return;
    }
    if (fixLimitDecisionOf(item)) {
      this.afterFixLimitDecision(item);
      return;
    }
    if (seniorWaitDecisionOf(item)) {
      this.afterSeniorWaitDecision(item);
      return;
    }
    if (item.kind === 'permission') {
      const allowed = resolution.optionId !== 'deny';
      this.addTimeline(
        item.taskKey,
        resolution.by,
        'permission_resolved',
        { inboxItemId: item.id, decision: allowed ? 'allow' : 'deny', optionId: resolution.optionId },
        sessionId,
      );
      const session = sessionId ? this.findSession(sessionId) : undefined;
      if (session && this.isLive(session))
        this.updateSession(session.id, { state: allowed ? 'working' : 'idle', activity: null });
      return;
    }
    if (item.kind === 'question') {
      const answer =
        resolution.note ??
        item.options.find((option) => option.id === resolution.optionId)?.label ??
        resolution.optionId;
      this.addTimeline(
        item.taskKey,
        resolution.by,
        'question_answered',
        { inboxItemId: item.id, answer },
        sessionId,
      );
      const question = typeof item.payload.question === 'string' ? item.payload.question : item.title;
      this.sendTeamMessage(resolution.by, [item.source], item.taskKey, answer, undefined, {
        inboxItemId: item.id,
        question,
        answer,
      });
      return;
    }
    if (item.kind === 'hand_on') {
      const request = handOnRequestOf(item);
      const task = item.taskKey ? this.findTask(item.taskKey) : undefined;
      const target = request ? stageOf(this.config, request.toStageId) : undefined;
      if (task && target && task.stageId !== target.id)
        this.applyMove(task, target, { kind: 'human', handle: resolution.by }, {});
      return;
    }
    const gate = item.kind === 'decision' ? gateRequestOf(item) : null;
    if (gate) this.decideGate(item, gate);
  }
}
