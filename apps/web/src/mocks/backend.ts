import type { MemberContextPreview, ProviderLoginStatus, ServerVersionView } from '@projectman/shared';
import {
  chatWindow,
  checklistConditionHolds,
  checklistProgress,
  SESSION_CHAT_WINDOW,
  SetChecklistItemStateRequest,
  type ProjectChecklist,
  applyMemberEmailChange,
  emailMailboxTaken,
  CreateOperatorGrantRequest,
  superAccessVerdict,
  superDecisionRefusal,
  externalQuestionAnswerRefusal,
  isRelayableQuestionItem,
  isCoordinatorOnlySignal,
  humanInboxAssignment,
  isIntegratorTodo,
  planIntegratorInboxEscalation,
  integratorSideAvailable,
  ownerHandles,
  connectedActorOf,
  ownerReservedEffect,
  canonical,
  canReadOperatorKnowledge,
  DEFAULT_OPERATOR_PREFERENCE,
  OperatorApprovalWaiverRequest,
  OperatorKnowledgeDocument,
  OperatorPreferenceDocument,
  operatorKnowledgeApprovalOf,
  maskEmail,
  BindProjectEngineRequest,
  canBindEngine,
  canUnbindEngine,
  CreateEngineRequest,
  RenameEngineRequest,
  projectEngineOf,
  StopOrphansRequest,
  StopSessionRequest,
  CreateIntegratorAccessKeyRequest,
  IntegratorKeyAuditQuery,
  SuperAuditQuery,
  ListSuperHandoffsQuery,
  SUPER_OPEN_STATES,
  InvolvementQuery,
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
  boundaryOwners,
  AddHumanMemberRequest,
  AgentProvider,
  CancelTaskRequest,
  CloseThemeRequest,
  CreateInviteRequest,
  CreateProjectRequest,
  CreateTaskRequest,
  CustomRoleRequest,
  DEFAULT_AGENT_PROVIDER,
  hasPlanUsage,
  planUsagePause,
  HireMemberRequest,
  INLINE_MEDIA_TYPES,
  InvitationView,
  LoginRequest,
  MAX_ATTACHMENT_BYTES,
  MAX_UNSENT_MESSAGE_ATTACHMENTS,
  canDeleteMessageAttachment,
  OCTET_STREAM,
  PR_MERGED_LABEL,
  PatchConfigRequest,
  ReopenTaskRequest,
  ResolveInboxRequest,
  RenameMemberRequest,
  RetireMemberRequest,
  RevertConfigRequest,
  SendMessageRequest,
  ReadTeamMessagesRequest,
  SendTeamMessageRequest,
  SetupRequest,
  StartTaskRequest,
  StartMergeRequest,
  PrioritizeMergeRequest,
  OrderMergeQueueRequest,
  mergeQueueOrderRefusal,
  UpdateMemberRequest,
  UpdateSessionRequest,
  aiLimitReached,
  aiLabelSetters,
  applyConfigPatch,
  hasOperatorWaiverField,
  operatorWaiverChanged,
  unknownPatchRepo,
  approvalRefusal,
  attachmentPreviewOf,
  withQuestionAttachmentGone,
  canDeleteAttachment,
  canSeeInboxItem,
  visibleQuestionItem,
  isPendingQuestion,
  questionGroupLiveItemIds,
  canSeeTeamMessage,
  isUnreadBy,
  threadPeersOf,
  canUploadAttachment,
  contactHandles,
  recipientRefusalForAccess,
  accessOfHandle,
  commentMentions,
  configSchemaIssues,
  coverAttachmentId,
  TaskCoverRequest,
  evaluateMove,
  partsClosedWaiver,
  evaluateStart,
  expiredLabels,
  gateRequestOf,
  questionPayloadOf,
  handOnDecision,
  handOnRequestOf,
  holdersAllow,
  isBuiltInRole,
  isOnLeave,
  isRequiredProjectManager,
  isOpenTask,
  isProjectManager,
  RETIRED_OPERATOR_HANDLE,
  cardBusyGroups,
  cardWorkerSessions,
  openPrerequisites,
  projectRefines,
  isWorkingOnTask,
  isSessionAtWork,
  labelDefinition,
  labelHolders,
  memberDuties,
  MEMBER_QUEUE_CLOSED_LIMIT,
  memberOf,
  memberRoles,
  renameMemberInConfig,
  modelForProvider,
  nextCronRun,
  OPERATOR_DISMISS_OPTION,
  operatorApprovalOf,
  projectManagerOf,
  noApproverReason,
  approverBlocker,
  ownerOnlyChanges,
  permissionView,
  machineAccessOf,
  effectiveSessionPermissions,
  duplicateMarkRefusal,
  lifecycleAllowed,
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
  validateProjectConfig,
  DEFAULT_PROJECT_LANGUAGE,
  ProjectConfig,
  mergeTokenUsage,
  alertPayloadOf,
  cardMerger,
  hasAccess,
  mergeReadiness,
  moveMerge,
  mergeRequestOf,
  releaseApprovalOf,
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
  fixRoundHistory,
  remainingFixExtraRounds,
  MAX_FIX_EXTRA_ROUNDS,
  FixLimitAssessment,
  selectFixLimitRecipient,
  fixLimitDeciders,
  fixLimitLead,
  fixLimitPlanner,
  fixLimitPlannerForOwner,
  fixLimitReached,
  maxFixRoundsOf,
  complexityOf,
  complexityLimitOf,
  tempMaxPointsOf,
  isDeveloper,
  canSetComplexity,
  isComplexityPoints,
  chooseDeveloper,
  humanStageOwner,
  reachingDevelopers,
  stageDevelopers,
  seniorWaitDecisionOf,
  seniorWaitMinutesOf,
  SENIOR_WAIT_OPTIONS,
  SENIOR_WAIT_OPTION_ANY,
  SENIOR_WAIT_OPTION_WAIT,
  FIX_ANOTHER_ROUND_OPTION,
  FIX_REASSIGN_OPTION,
  FIX_REPLAN_OPTION,
  DEFAULT_CLOSED_CARDS_DAYS,
  isClosedSince,
  measureClosedCard,
  canCreateTasks,
  createsInFirstStageOnly,
  taskCreateAccessOf,
  taskWait,
  waitHolders,
  waitWorkers,
} from '@projectman/shared';
import type {
  CardBusyDetails,
  EmailApprovalPayload,
  EmailParkedAlert,
  MemberQueueItem,
  OperatorGrantState,
  TaskDetail,
  PartsClosed,
  MessageAttachment,
  MessageAttachmentRef,
  CapacityHolder,
  EngineStatusView,
  EngineView,
  ProjectEngineView,
  HandoffFallbackReason,
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
  OperatorApprovalPayload,
  OperatorRequestView,
  OperatorSignal,
  InvitationView as Invitation,
  LabelChangeReason,
  LabelChangeRefusal,
  LabelClearTrigger,
  RelationStep,
  RelationsChange,
  MemberUsage,
  MemberView,
  MergeBlockReason,
  MergeFailure,
  TaskMergeState,
  TaskMerged,
  PlanUsage,
  ReleaseStep,
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
  getTemplate,
  humanMemberHandle,
  roleViews,
} from '@projectman/templates';
import * as fixtures from './fixtures';
import { t } from '../i18n/t';
import { MockEmailLogin } from './email-login';
import { MockEmail } from './email';
import { MockFeedback } from './feedback';
import { MockPauses } from './pauses';
import { MockPush } from './push';
import { MockOwners } from './owners';
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

/** How a merge the fake runs ends: it lands, hits a conflict, fails its check, or is blocked at the push. */
export type MockMergeOutcome = 'merged' | 'conflict' | 'check_failed' | 'blocked';

/** The steps a running merge goes through, one `advanceMerge` each. */
const MERGE_STEPS = ['merging', 'check_waiting', 'checking', 'pushing', 'finishing'] as const;

/** A stable, commit-looking id for a card's mock work. */
function mockCommit(task: Pick<Task, 'key'>, salt: string): string {
  const digits = task.key.replace(/\D/g, '').padStart(4, '0');
  return `${salt}${digits}c0ffee1234567890abcdef1234567890ab`.slice(0, 40);
}

/**
 * In-memory stand-in for the projectman server, the fake behind the UI tests. It implements
 * the REST routes from the shared route table and publishes the same websocket events the
 * real server would, so the UI runs through its normal data path.
 */
export class MockBackend {
  serverVersion: ServerVersionView = { version: 'dev', commit: null, tag: null };
  operatorGrantAudits: import('@projectman/shared').OperatorGrantAuditEntry[] = [];
  auth: MockAuthState;
  /** Cloud mode before the first setup (PM-317): the setup asks for this code; null is single-machine mode. */
  setupCode: string | null = null;
  viewerHandle: string = fixtures.OWNER;
  /** Tests can exercise the same credential policy as REST without an HTTP bearer secret. */
  integratorMode: 'super' | 'read' | null = null;
  /** Whether some owner has a live super key (PM-1045); the integrator's todos go to the owners without one. */
  liveSuperKey = true;
  private readonly mergeOrders = new Map<string, { revision: number; taskKeys: string[] }>();
  /** A release decision is refused with `owner_approval_required`, like an integrator key's (PM-491). */
  refuseReleaseApproval = false;
  user = { ...fixtures.mockUser };
  config: ProjectConfig = fixtures.buildConfig();
  structure = clone(fixtures.structureFixture);
  configVersion = fixtures.projectSummary.configVersion;
  history: ConfigVersionEntry[] = clone(fixtures.configHistory);
  tasks: Task[] = clone(fixtures.tasks).map((task) => withPrMergedLabel(task, this.config));
  members: MemberView[] = clone(fixtures.members);
  timeline: TimelineEvent[] = clone(fixtures.timeline);
  integratorKeys: import('@projectman/shared').IntegratorAccessKeyInfo[] = [];
  integratorKeyAudits: import('@projectman/shared').IntegratorKeyAuditEntry[] = [];
  superAudits: import('@projectman/shared').SuperOperationAudit[] = [];
  superHandoffs: import('@projectman/shared').SuperHandoff[] = [];
  superOperations: import('@projectman/shared').SuperOperation[] = [];
  superResults = new Map<string, import('@projectman/shared').SuperAdministrationResult>();
  private viewerAccess(): import('@projectman/shared').HumanAccess {
    const member = memberOf(this.config, this.viewerHandle);
    return member?.kind === 'human' ? member.access : 'viewer';
  }
  /** Where each card's fix rounds are counted from and the rounds people let it have (PM-262). */
  private fixLimitState = new Map<string, { countedFrom: string | null; extraRounds: number }>();
  /** The stage a card stood in when its merge was requested (the server keeps it on the merge row). */
  private mergeFrom = new Map<string, string>();
  /** How a card's merge ends once `advanceMerge` has run it through its steps; absent: it merges. */
  private mergeOutcomes = new Map<string, MockMergeOutcome>();
  private mergeFixNotes = new Map<string, string>();
  private mergeFixErrors = new Map<string, 'uncommitted' | 'missing_commit' | 'missing_base'>();

  setMergeFixError(taskKey: string, reason?: 'uncommitted' | 'missing_commit' | 'missing_base'): void {
    if (reason) this.mergeFixErrors.set(taskKey, reason);
    else this.mergeFixErrors.delete(taskKey);
  }
  /** Why a move into the target is refused while the work is not merged; absent: `not_merged`. */
  private mergeRefusals = new Map<string, 'not_merged' | 'not_on_remote' | 'engine_unavailable'>();
  /** The cards that wait for a Senior (PM-348): since when, the question asked and the answer given. */
  private seniorWaits = new Map<
    string,
    { since: string; itemId?: string; decision?: { decision: 'wait' | 'any'; by: string } }
  >();
  scheduleRuns: ScheduleRun[] = [];
  attachments: Attachment[] = [];
  messageAttachments: MessageAttachment[] = [];
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
    isHostOwner: () => this.isHostOwner(),
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
  messages: TeamMessage[] = clone(fixtures.teamMessages);
  /** The feedback marks (PM-511); a project starts without surfaces and marks, a test or scenario fills it. */
  readonly feedback: MockFeedback = new MockFeedback({
    config: () => this.config,
    viewerHandle: () => this.viewerHandle,
    findTask: (key) => this.findTask(key),
    createCard: (input) => this.createTask(input),
    addTimeline: (taskKey, who, type, data) => void this.addTimeline(taskKey, who, type, data),
    emit: (event) => this.emit(event),
  });
  /** The e-mail channel (PM-942): its contacts' choices and its log; a test or a scenario fills the log. */
  readonly email: MockEmail = new MockEmail({
    config: () => this.config,
    viewerHandle: () => this.viewerHandle,
    emit: (event) => this.emit(event),
  });
  /** The viewer's web push devices and settings (PM-815); a test fills the device list. */
  readonly push = new MockPush();
  readonly owners = new MockOwners();
  /** What the owner asked the Operator for, with its steps (PM-447); a test or a scenario fills it. */
  operatorRequests: OperatorRequestView[] = [];
  checklist: ProjectChecklist | null = null;
  operatorKnowledge: OperatorKnowledgeDocument = {
    schemaVersion: 1,
    revision: 0,
    agreement: null,
    principles: [],
    appliedProposalIds: [],
  };
  operatorPreferences: Record<string, OperatorPreferenceDocument> = {};
  /** The Operator's proactive signals (PM-476); the owner's channel returns them, a guest's does not. */
  operatorSignals: OperatorSignal[] = [];
  /** The member queues (PM-894), every AI member's items in one list; a test fills it, the views are computed from it. */
  queueItems: MemberQueueItem[] = [];
  /** The grant of machine operations the Operator works with (PM-890): off, and the viewer can manage it. */
  operatorGrant: OperatorGrantState = {
    active: false,
    grantId: null,
    grantedAt: null,
    grantedBy: null,
    expiresAt: null,
    lastUsedAt: null,
    canManage: true,
  };
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
  /** The project–engine bindings (PM-1060) by project key; the engine's owner is `EngineView.createdBy` (a user id here). */
  projectEngineBindings = new Map<string, Array<{ engineId: string; isDefault: boolean }>>();
  /** The engines whose hello lists the project (`holdsProject`), as `<projectKey>/<engineId>`. */
  engineHolds = new Set<string>();
  /** Codes the machine display and the session detail answer with (`engine_offline`), by session id. */
  machineError: ErrorCode | null = null;
  sessionErrors = new Map<string, ErrorCode>();
  /** The machine key the last `POST /api/engines` returned (a test checks it is shown once). */
  lastEngineKey: string | null = null;
  /** While set, POST /api/engines (and the other changes) answer `owner_login_required` for `engines`. */
  engineLoginRequired = false;
  /** The provider logins each engine's machine reports (PM-1077), by engine id; absent: nobody is logged in. */
  engineProviderLogins = new Map<string, Partial<Record<AgentProvider, boolean>>>();
  /** The users with an owner account (PM-1062); they own projects and engines of their own and see no one else's. */
  ownerAccountIds = new Set<string>();
  /** The owner invitations the host handed out (PM-1062): the token is the path's last segment. */
  ownerInvites: Array<{ token: string; email: string; inviterName: string; used: boolean }> = [];
  /** Folders the engine says do not exist (`workspace_not_found`); anything else is accepted, as `not_held` is. */
  missingWorkspaces = new Set<string>();
  codexPlanUsage = { ...clone(fixtures.planUsage), fiveHourPercent: 24, weeklyPercent: 36 };
  extraProjects: { key: string; name: string; templateId: string }[] = [];
  invitations: Array<Invitation & { token: string }> = [];
  /** A password of `null` is an account made by an e-mail code: it logs in with a code only. */
  accounts = new Map<string, { userId: string; name: string; email: string; password: string | null }>([
    [fixtures.mockUser.email, { ...fixtures.mockUser, password: 'correct horse battery' }],
  ]);
  /** The e-mail code login (PM-670, PM-671); off until a test or a scenario enables it. */
  readonly emailLogin: MockEmailLogin = new MockEmailLogin({
    inviteEmail: (token) => this.openClientInvite(token)?.email ?? null,
    eligible: (email) => this.emailLoginEligible(email),
    hasAccount: (email) => this.accounts.has(email),
    inviteDisplayName: (email) =>
      this.openInvitesOf(email).find((invite) => invite.displayName)?.displayName ?? null,
    startSession: (email, name) => this.startEmailSession(email, name),
  });
  /** Further projects the viewer belongs to, so a test can log in a client of several projects. */
  extraMeProjects: Array<{ key: string; name: string; access: HumanAccess; roles: string[] }> = [];
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
    if (event.type === 'inbox_upserted' && !canSeeInboxItem(this.taskViewer(), event.item)) return;
    if (
      (event.type === 'team_message' || event.type === 'team_message_updated') &&
      !canSeeTeamMessage(this.taskViewer(), event.message)
    )
      return;
    const projectKey = 'projectKey' in event ? (event.projectKey ?? null) : null;
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
    const config = memberOf(this.config, member.handle);
    const result = { ...clone(member), taskWork };
    if (config?.kind === 'ai' && isDeveloper(this.config, config))
      result.complexityLimit = complexityLimitOf(this.config, config);
    else delete result.complexityLimit;
    return result;
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
    this.markQuestionAttachmentGone(id);
  }

  /** Every item that names the deleted file, open or answered, marks it gone and is published again (as the server does). */
  private markQuestionAttachmentGone(attachmentId: string): void {
    const at = nowIso();
    this.inbox = this.inbox.map((item) => {
      const payload = withQuestionAttachmentGone(item.payload, attachmentId, at);
      if (!payload) return item;
      const updated = { ...item, payload };
      this.emit({ type: 'inbox_upserted', projectKey: item.projectKey, item: clone(updated) });
      return updated;
    });
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
    // What decides whether a card is ready to merge, and by whom, changed: the request follows.
    if ('stageId' in patch || 'labels' in patch || 'assignee' in patch || 'repo' in patch)
      this.reconcileMerge(task);
    return task;
  }

  setTaskComplexity(taskKey: string, value: { points: number | null; reason?: string | null }): MockResponse {
    const task = this.findTask(taskKey);
    if (!task) return error(404, 'not_found', 'Unknown task');
    if (!canSetComplexity(this.config, this.viewerHandle))
      return error(403, 'complexity_forbidden', 'Cannot set complexity');
    if (isTheme(task)) return error(400, 'task_is_theme', 'A theme has no complexity');
    if (!isOpenTask(task)) return error(409, 'task_closed', 'The task is closed');
    if (value.points !== null && !isComplexityPoints(value.points))
      return error(422, 'complexity_points_invalid', 'Invalid points');
    const previous = task.complexity ?? null;
    const complexity = isComplexityPoints(value.points)
      ? {
          points: value.points,
          reason: value.reason?.trim() || null,
          setBy: this.viewerHandle,
          setAt: nowIso(),
        }
      : null;
    if (
      (previous?.points ?? null) === value.points &&
      (previous?.reason ?? null) === (complexity?.reason ?? null)
    )
      return ok(this.taskDetail(task));
    this.updateTask(taskKey, { complexity: complexity ?? undefined });
    this.addTimeline(taskKey, this.viewerHandle, 'task_complexity_changed', {
      points: complexity?.points ?? null,
      reason: complexity?.reason ?? null,
      previous: previous ? { points: previous.points, reason: previous.reason } : null,
    });
    this.settleSeniorWaits();
    return ok(this.taskDetail(task));
  }

  addTimeline(
    taskKey: string | null,
    who: string | null,
    type: TimelineEventType,
    data: Record<string, unknown>,
    sessionId: string | null = null,
    createdAt = nowIso(),
    actor?: Actor,
  ): TimelineEvent {
    const member = who ? this.findMember(who) : undefined;
    const event: TimelineEvent = {
      id: mockId('evt'),
      projectKey: fixtures.PROJECT_KEY,
      taskKey,
      sessionId,
      actor:
        actor ?? (who ? { kind: member?.kind ?? 'system', handle: who } : { kind: 'system', handle: null }),
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
      testsFailed: rounds.testsFailed,
      extraRounds: this.fixState(taskKey).extraRounds,
      remainingExtraRounds: remainingFixExtraRounds(this.fixState(taskKey).extraRounds),
      extraRoundLimit: MAX_FIX_EXTRA_ROUNDS as 3,
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
    if (!lead || remainingFixExtraRounds(state.extraRounds) === 0) {
      this.holdForPeople(
        task,
        rounds,
        remainingFixExtraRounds(state.extraRounds) === 0 ? 'extra_exhausted' : 'no_ai_decider',
        null,
        null,
      );
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

  /** Simulate an expired AI decision without running the server's obligation clock. */
  timeOutFixLimit(taskKey: string, decider: string): string | null {
    const task = this.findTask(taskKey);
    const held = task?.fixLimit;
    if (!task || !held || (held.phase !== 'lead' && held.phase !== 'replan') || held.decider !== decider)
      return null;
    this.holdForPeople(task, this.fixRoundsOf(taskKey), 'decider_timeout', decider, null);
    return (
      this.inbox.find((item) => item.taskKey === taskKey && item.state === 'open' && fixLimitDecisionOf(item))
        ?.id ?? null
    );
  }

  /** The card goes to the people: one decision item with the buttons that apply. */
  private holdForPeople(
    task: Task,
    rounds: FixRounds,
    reason: NonNullable<TaskFixLimit['reason']>,
    decider: string | null,
    note: string | null,
    assessment?: FixLimitAssessment,
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
    const data = { ...this.fixLimitData(task.key, rounds), ...(assessment ? { assessment } : {}) };
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
    const item: InboxItem = {
      id: mockId('inb'),
      projectKey: fixtures.PROJECT_KEY,
      kind: 'decision',
      assignees: deciders,
      source: 'system',
      sessionId: null,
      taskKey: task.key,
      title: t('inbox.fixLimit.subject', { key: task.key }),
      body: null,
      payload: {
        fixLimit: {
          taskKey: task.key,
          ...data,
          reason,
          decider,
          note,
          history: fixRoundHistory(
            this.timeline.filter((event) => event.taskKey === task.key),
            this.config,
            this.fixState(task.key).countedFrom,
          ),
        },
      },
      options,
      state: 'open',
      resolution: null,
      createdAt: nowIso(),
    };
    const recipient = selectFixLimitRecipient(
      item,
      this.integratorKeys.some((key) => key.mode === 'super' && key.state === 'active'),
    );
    item.payload = {
      ...item.payload,
      ...recipient,
      ...(recipient.recipient === 'integrator' ? { integratorOpenedAt: nowIso() } : {}),
    };
    this.updateTask(task.key, { fixLimit: { ...task.fixLimit!, recipient: recipient.recipient } });
    this.upsertInbox(item);
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
    if (!fresh) state.extraRounds += 1;
    this.addTimeline(task.key, by, 'task_fix_limit', {
      phase: 'decided',
      ...this.fixLimitData(task.key, this.fixRoundsOf(task.key)),
      decision,
      by,
      ...(note ? { note } : {}),
    });
    if (fresh) this.fixLimitState.set(task.key, { countedFrom: nowIso(), extraRounds: 0 });
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
  decideFixLimit(
    taskKey: string,
    decision: 'continue' | 'replan' | 'to_owner',
    reason: string,
    assessment?: FixLimitAssessment,
  ): void {
    if (decision === 'to_owner') assessment = FixLimitAssessment.parse(assessment);
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
      this.holdForPeople(task, this.fixRoundsOf(taskKey), 'passed_on', held.decider, reason, assessment);
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
    attachments?: MessageAttachmentRef[],
    /** Where the sender was (a person's message) and the places offered (the project manager's), PM-1071. */
    where?: Pick<TeamMessage, 'location' | 'places'>,
  ): TeamMessage {
    const refusal = this.teamMessageRefusal(from, recipients, text, Boolean(attachments?.length));
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
      ...(attachments?.length ? { attachments: clone(attachments) } : {}),
      ...(where?.location ? { location: clone(where.location) } : {}),
      ...(where?.places?.length ? { places: clone(where.places) } : {}),
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
  private teamMessageRefusal(
    from: string,
    to: readonly string[],
    text: string,
    hasAttachments = false,
  ): MockResponse | null {
    if (!text.trim() && !hasAttachments)
      return error(400, 'invalid_request', 'The message text is empty', { field: 'text' });
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

  /**
   * The Devops proposes a release (PM-491, PM-492): the release card (a theme), the approval item for
   * the owners and the first `release_changed` row. Returns the item. The cards of the release are
   * listed with their titles from the board; a key the board does not know keeps its key as title.
   */
  proposeRelease(input: {
    commit: string;
    baseCommit?: string | null;
    summary: string;
    taskKeys: readonly string[];
    title?: string;
    proposedBy?: string;
  }): InboxItem {
    const title = input.title ?? `Release ${input.commit.slice(0, 8)}`;
    const card = this.createTask({ title, kind: 'theme' }).body as Task;
    const proposedBy = input.proposedBy ?? 'fe-1';
    const releaseId = mockId('rel');
    const item: InboxItem = {
      id: mockId('inb'),
      projectKey: fixtures.PROJECT_KEY,
      kind: 'release',
      assignees: boundaryOwners(this.config),
      source: proposedBy,
      sessionId: null,
      taskKey: card.key,
      title,
      body: input.summary,
      payload: {
        release: {
          releaseId,
          commit: input.commit,
          baseCommit: input.baseCommit ?? null,
          tasks: input.taskKeys.map((key) => ({ key, title: this.findTask(key)?.title ?? key })),
          summary: input.summary,
        },
      },
      options: [
        { id: 'approve', label: 'approve', style: 'primary' },
        { id: 'reject', label: 'reject', style: 'danger' },
      ],
      state: 'open',
      resolution: null,
      createdAt: nowIso(),
    };
    this.addTimeline(card.key, proposedBy, 'release_changed', {
      releaseId,
      state: 'proposed',
      previousState: null,
      commit: input.commit,
    });
    this.upsertInbox(item);
    return item;
  }

  /** A mail of an AI member waiting for the owners' approval (PM-942): the `approval` item for the owners. */
  proposeEmail(input: Partial<EmailApprovalPayload> = {}): InboxItem {
    const email: EmailApprovalPayload = {
      emailId: mockId('mail'),
      member: 'fe-1',
      contact: 'kata',
      contactName: 'Kata',
      taskKey: null,
      subject: 'Weekly summary',
      text: 'Hi Kata,\n\nThe login is done this week.',
      ...input,
    };
    const item: InboxItem = {
      id: mockId('inb'),
      projectKey: fixtures.PROJECT_KEY,
      kind: 'approval',
      assignees: boundaryOwners(this.config),
      source: email.member,
      sessionId: null,
      taskKey: email.taskKey,
      title: email.subject,
      body: null,
      payload: { email },
      options: [
        { id: 'approve', label: 'approve', style: 'primary' },
        { id: 'reject', label: 'reject', style: 'danger' },
      ],
      state: 'open',
      resolution: null,
      createdAt: nowIso(),
    };
    this.upsertInbox(item);
    return item;
  }

  /** A mail set aside by the inbound check (PM-942): the `email_parked` alert for the owners. */
  parkEmail(input: Partial<EmailParkedAlert> = {}): InboxItem {
    const payload: EmailParkedAlert = {
      alert: 'email_parked',
      emailId: mockId('mail'),
      reason: 'unknown_sender',
      fromAddress: 'someone@example.org',
      subject: 'Re: offer',
      excerpt: 'Thanks for the offer. <b>Look here</b> https://example.org/x',
      attachmentNames: [],
      ...input,
    };
    const item: InboxItem = {
      id: mockId('inb'),
      projectKey: fixtures.PROJECT_KEY,
      kind: 'alert',
      assignees: boundaryOwners(this.config),
      source: 'system',
      sessionId: null,
      taskKey: null,
      title: payload.subject,
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

  /** The release watcher reports a state of the release on its card (a deploy step, `live`, `published`). */
  releaseChanged(
    taskKey: string,
    data: { state: string; commit: string } & Record<string, unknown>,
  ): TimelineEvent {
    return this.addTimeline(taskKey, null, 'release_changed', {
      releaseId: 'rel_mock',
      previousState: null,
      ...data,
    });
  }

  /** A deploy failed (PM-491): the `release_failed` alert for the owners and the `failed` row on the card. */
  failRelease(input: {
    taskKey: string;
    commit: string;
    step: ReleaseStep;
    message: string;
    rolledBack: boolean;
  }): InboxItem {
    const failure = { step: input.step, message: input.message, rolledBack: input.rolledBack };
    this.releaseChanged(input.taskKey, { state: 'failed', commit: input.commit, failure });
    const item: InboxItem = {
      id: mockId('inb'),
      projectKey: fixtures.PROJECT_KEY,
      kind: 'alert',
      assignees: boundaryOwners(this.config),
      source: 'system',
      sessionId: null,
      taskKey: input.taskKey,
      title: `Release ${input.commit.slice(0, 8)} failed in ${input.step}`,
      body: input.message,
      payload: {
        alert: 'release_failed',
        releaseId: 'rel_mock',
        taskKey: input.taskKey,
        commit: input.commit,
        step: input.step,
        message: input.message,
        rolledBack: input.rolledBack,
      },
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
      member.machineAccess = machineAccessOf(config);
    }
  }

  sweepIntegratorTodos(now: string): void {
    // Like the server: the integrator's items go to the owners only when no owner has a live super key (no clock).
    if (integratorSideAvailable(this.config, () => this.liveSuperKey)) return;
    for (const item of this.inbox) {
      const patch = planIntegratorInboxEscalation(
        item,
        now,
        ownerHandles(this.config),
        'integrator_unavailable',
      );
      if (!patch) continue;
      this.upsertInbox({ ...item, ...patch });
      if (fixLimitDecisionOf(item)) {
        const task = item.taskKey ? this.findTask(item.taskKey) : undefined;
        if (task?.fixLimit)
          this.updateTask(task.key, {
            fixLimit: { ...task.fixLimit, recipient: 'owner', deciders: patch.assignees },
          });
        this.addTimeline(
          item.taskKey,
          null,
          'fix_limit_recipient_escalated',
          {
            inboxItemId: item.id,
            from: 'integrator',
            to: 'owner',
            reason: 'integrator_unavailable',
            openedAt: item.payload.integratorOpenedAt as string,
          },
          null,
          now,
        );
        continue;
      }
      this.addTimeline(
        item.taskKey,
        null,
        'question_recipient_escalated',
        {
          inboxItemId: item.id,
          asker: item.source,
          from: 'integrator',
          to: 'owner',
          openedAt: questionPayloadOf(item)!.integratorOpenedAt!,
          reason: 'integrator_unavailable',
        },
        item.sessionId,
        now,
      );
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
    this.sweepIntegratorTodos(nowIso());
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
      tasks: clone(this.tasks),
      members: this.members.filter((member) => member.status !== 'retired').map((m) => this.viewOf(m)),
      openInboxCount: this.inbox.filter(
        (item) =>
          item.state === 'open' &&
          humanInboxAssignment(item, this.owner) &&
          canSeeInboxItem(this.taskViewer(), item),
      ).length,
      aiEnabled: this.config.team.limits.aiEnabled,
      pause: this.pauses.projectView(),
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
    const ownerResponse = this.owners.handle(method, path, body, query, {
      hostOwner: this.me().hostOwner === true,
      ownLogin: !this.integratorMode,
    });
    if (ownerResponse) return ownerResponse;
    const publicInvite = /^\/api\/invites\/([^/]+)(\/accept)?$/.exec(path);
    if (publicInvite) return this.handlePublicInvite(method, publicInvite[1]!, !!publicInvite[2], body);
    const ownerInvite = /^\/api\/owner-invites\/([^/]+)(\/accept)?$/.exec(path);
    if (ownerInvite) return this.handleOwnerInvite(method, ownerInvite[1]!, !!ownerInvite[2], body);
    if (path === '/api/setup') {
      if (method === 'GET') {
        const needsSetup = this.auth === 'setup';
        return ok({
          needsSetup,
          ...(needsSetup && this.setupCode !== null ? { needsSetupCode: true } : {}),
          ...(this.emailLogin.enabled ? { emailLoginEnabled: true } : {}),
        });
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
        if (account.password === null || input.password !== account.password)
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
    if (path === '/api/auth/email/request' && method === 'POST') return this.emailLogin.request(body);
    if (path === '/api/auth/email/verify' && method === 'POST') return this.emailLogin.verify(body);
    if (path === '/api/auth/logout' && method === 'POST') {
      this.auth = 'login';
      return ok();
    }
    if (this.auth !== 'ready') return error(401, 'unauthorized', 'Login required');

    if (path === '/api/me') return ok(this.me());
    if (method === 'GET' && path === '/api/version') return ok(this.serverVersion);
    if (path === '/api/auth/operator-grant' || path === '/api/auth/operator-grant/audit') {
      const canManage = this.operatorGrant.canManage && this.me().hostOwner === true && !this.integratorMode;
      const at = nowIso();
      const grant = this.operatorGrant;
      const record = (action: import('@projectman/shared').OperatorGrantAuditEntry['action']) => {
        this.operatorGrantAudits.unshift({
          grantId: grant.grantId!,
          action,
          at,
          expiresAt: grant.expiresAt,
          by: this.user.name,
        });
      };
      if (grant.active && grant.expiresAt && grant.expiresAt <= at) {
        record('expired');
        grant.active = false;
      }
      if (path.endsWith('/audit')) {
        if (!canManage) return error(403, 'operator_grant_owner_only', 'Own owner login required');
        return ok({ entries: clone(this.operatorGrantAudits) });
      }
      if (method !== 'GET' && !canManage)
        return error(403, 'operator_grant_owner_only', 'Own owner login required');
      if (method === 'POST') {
        const input = CreateOperatorGrantRequest.safeParse(body);
        if (!input.success) return error(400, 'invalid_request', 'Invalid grant duration');
        if (grant.active) record('replaced');
        Object.assign(grant, {
          active: true,
          grantId: `grant-${this.operatorGrantAudits.length + 1}`,
          grantedAt: at,
          grantedBy: this.user.name,
          lastUsedAt: null,
          expiresAt:
            input.data.duration === 'until_revoked'
              ? null
              : new Date(
                  Date.parse(at) + (input.data.duration === '12h' ? 43_200_000 : 604_800_000),
                ).toISOString(),
        });
        record('granted');
      }
      if (method === 'DELETE') {
        if (!grant.active) return error(404, 'not_found', 'Grant inactive');
        record('revoked');
        grant.active = false;
      }
      return ok({ grant: { ...clone(grant), canManage } });
    }
    if (path === '/api/me/push' || path.startsWith('/api/me/push/'))
      return (
        this.push.handle(method, path.slice('/api/me/push'.length), body) ??
        error(404, 'not_found', 'Unknown route')
      );
    if (path === '/api/auth/integrator-keys' || path.startsWith('/api/auth/integrator-keys/')) {
      if (this.integratorMode) {
        const verdict = superAccessVerdict(this.config, {
          mode: this.integratorMode,
          operation: 'key_management',
          ownerMembership: this.viewerAccess() === 'owner',
        });
        if (!verdict.allowed) return error(403, verdict.code, 'Credential management refused');
      }
      // The host owner and an owner account hold a key (PM-1063).
      if (!this.me().hostOwner && !this.me().ownerAccount)
        return error(403, 'owner_only', 'Own owner login required');
      this.integratorKeys = this.integratorKeys.map((key) =>
        key.state === 'active' && key.expiresAt && key.expiresAt <= nowIso()
          ? { ...key, state: 'expired' }
          : key,
      );
      if (path.endsWith('/audit')) {
        const input = IntegratorKeyAuditQuery.safeParse(Object.fromEntries(query));
        if (!input.success) return error(400, 'invalid_request', 'Invalid audit query');
        const entries = this.integratorKeyAudits
          .filter((entry) => input.data.before === undefined || entry.seq < input.data.before)
          .sort((a, b) => b.seq - a.seq);
        const page = entries.slice(0, input.data.limit);
        return ok({
          entries: clone(page),
          nextBefore: entries.length > page.length ? page.at(-1)!.seq : null,
        });
      }
      if (method === 'POST' && path === '/api/auth/integrator-keys') {
        const input = CreateIntegratorAccessKeyRequest.safeParse(body);
        if (!input.success) return error(400, 'invalid_request', 'Invalid key request');
        const at = nowIso();
        this.integratorKeys = this.integratorKeys.map((key) =>
          key.mode === input.data.mode && key.state === 'active'
            ? { ...key, state: 'revoked', revokedAt: at }
            : key,
        );
        const key: import('@projectman/shared').IntegratorAccessKeyInfo = {
          id: `mock_key_${this.integratorKeys.length + 1}`,
          mode: input.data.mode,
          prefix: `pmi_mock_${this.integratorKeys.length + 1}`,
          state: 'active',
          createdAt: at,
          expiresAt:
            input.data.expiresInDays === null
              ? null
              : new Date(Date.parse(at) + input.data.expiresInDays * 86_400_000).toISOString(),
          lastUsedAt: null,
          lastUsedChannel: null,
          revokedAt: null,
        };
        this.integratorKeys.push(key);
        this.integratorKeyAudits.push({
          seq: this.integratorKeyAudits.length + 1,
          keyId: key.id,
          action: 'created',
          prefix: key.prefix,
          mode: key.mode,
          at,
        });
        return { status: 201, body: { key: clone(key), secret: 'pmi_mock_key_for_ui_tests_only' } };
      }
      if (method === 'DELETE') {
        const key = this.integratorKeys.find((entry) => entry.id === path.split('/').at(-1));
        if (!key) return error(404, 'not_found', 'Key not found');
        key.state = 'revoked';
        key.revokedAt = nowIso();
        this.integratorKeyAudits.push({
          seq: this.integratorKeyAudits.length + 1,
          keyId: key.id,
          action: 'revoked',
          prefix: key.prefix,
          mode: key.mode,
          at: key.revokedAt,
        });
        return ok({ key: clone(key) });
      }
      return ok({ keys: clone(this.integratorKeys) });
    }
    if (path === '/api/engines' || path.startsWith('/api/engines/'))
      return this.engineRoutes(method, path, body);
    const projectEngines = /^\/api\/projects\/([^/]+)\/engines(?:\/([^/]+))?$/.exec(path);
    if (projectEngines) return this.projectEngineRoutes(method, projectEngines[1]!, projectEngines[2], body);
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
      const canManageKeys =
        this.canManageKeys ?? canManageProviderKeys({ hostOwner: this.me().hostOwner === true });
      if (path === '/api/providers/nanogpt/key') {
        if (!canManageKeys)
          return error(403, 'insufficient_access', 'Only the host owner may manage provider keys');
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
    if (path === '/api/projects') {
      if (method === 'POST') {
        const input = parseBody(CreateProjectRequest, body);
        if (!input) return error(400, 'invalid_request', 'Invalid project');
        if (input.key === fixtures.PROJECT_KEY || this.extraProjects.some((p) => p.key === input.key)) {
          return error(409, 'project_exists', 'Project key already exists');
        }
        const ownerAccount = this.ownerAccountIds.has(this.user.userId);
        // An owner account creates its project on an engine of its own; the folder is checked on that engine.
        if (ownerAccount && !input.engineId) return error(400, 'invalid_request', 'An engine is required');
        const engine = input.engineId ? this.engines.find((entry) => entry.id === input.engineId) : undefined;
        if (input.engineId) {
          if (!engine || (!this.isHostOwner() && engine.createdBy !== this.user.userId))
            return error(404, 'engine_not_found', 'Engine not found');
          if (engine.revokedAt) return error(409, 'engine_revoked', 'The engine is revoked');
          if (!engine.online) return error(409, 'engine_offline', 'The engine is not connected');
          if (this.missingWorkspaces.has(input.workspacePath))
            return error(422, 'workspace_not_found', 'workspace directory not found');
        }
        // Like the server: a configuration that does not work is refused, with the issues.
        const draft = this.projectDraft(input);
        if ('status' in draft) return draft;
        const blocking = validateProjectConfig(draft).filter((issue) => issue.severity !== 'warning');
        if (blocking.length > 0)
          return error(422, 'invalid_config', 'configuration violates the team invariants', {
            issues: blocking,
          });
        this.extraProjects.push({
          key: input.key,
          name: input.name,
          templateId: input.templateId ?? 'starter',
        });
        if (engine) this.projectEngineBindings.set(input.key, [{ engineId: engine.id, isDefault: true }]);
        if (ownerAccount)
          this.extraMeProjects.push({ key: input.key, name: input.name, access: 'owner', roles: [] });
        return ok({
          key: input.key,
          name: input.name,
          templateId: input.templateId ?? 'starter',
          configVersion: '0000000',
        });
      }
      return ok([
        // An owner account sees the projects it created, never the seeded one of the host.
        ...(this.ownerAccountIds.has(this.user.userId)
          ? []
          : [
              {
                ...fixtures.projectSummary,
                name: this.config.project.name,
                configVersion: this.configVersion,
              },
            ]),
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

  /** The one fact behind `me().hostOwner`, `me().instanceOwner` and the instance's pause rights. */
  private isHostOwner(): boolean {
    return this.user.userId === fixtures.mockUser.userId;
  }

  private me() {
    const member = memberOf(this.config, this.viewerHandle);
    return {
      ...this.user,
      hostOwner: this.isHostOwner(),
      ...(this.ownerAccountIds.has(this.user.userId) ? { ownerAccount: true } : {}),
      instanceOwner: this.isHostOwner(),
      handles: this.viewerHandle ? { [fixtures.PROJECT_KEY]: this.owner } : {},
      projects: [
        ...(member?.kind === 'human'
          ? [
              {
                key: fixtures.PROJECT_KEY,
                name: this.config.project.name,
                access: member.access,
                roles: member.roles,
              },
            ]
          : []),
        // A client of several projects, or an owner account with the projects it created.
        ...(member?.kind === 'human' || this.ownerAccountIds.has(this.user.userId)
          ? this.extraMeProjects
          : []),
      ],
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
      return ok({
        mode: 'cloud',
        engines: this.engines.filter((engine) => !engine.revokedAt).map((e) => this.engineStatus(e)),
      });
    }
    // The host owner manages every engine, an owner account (PM-1062) their own.
    if (!me.hostOwner && !me.ownerAccount)
      return error(403, 'owner_only', 'Only the host owner may manage engines');
    if (this.engineMode === 'single') return error(404, 'not_found', 'Engines are not available');
    const userId = this.user.userId;
    const asSeen = (engine: EngineView): EngineView => ({
      ...clone(engine),
      ownedByMe: engine.createdBy === userId,
    });
    if (path === '/api/engines' && method === 'GET')
      return ok(this.engines.filter((engine) => me.hostOwner || engine.createdBy === userId).map(asSeen));
    if (this.engineLoginRequired)
      return error(403, 'owner_login_required', 'Log in again to manage engines', { category: 'engines' });
    if (path === '/api/engines' && method === 'POST') {
      const input = parseBody(CreateEngineRequest, body);
      if (!input) return error(400, 'invalid_request', 'Invalid engine name');
      // The machine-wide default is the host's alone: an owner account's engine is never it.
      const engine = this.addEngine({
        name: input.name,
        createdBy: userId,
        ...(me.hostOwner ? {} : { isDefault: false }),
      });
      this.lastEngineKey = `pme_mock_${engine.id}_for_ui_tests_only`;
      this.emit({ type: 'engine_changed', engine: this.engineStatus(engine) });
      return { status: 201, body: { engine: asSeen(engine), key: this.lastEngineKey } };
    }
    const providers = /^\/api\/engines\/(eng_[a-z0-9]{12})\/providers$/.exec(path);
    if (providers && method === 'GET') {
      const engine = this.engines.find((entry) => entry.id === providers[1]);
      if (!engine || (!me.hostOwner && engine.createdBy !== userId))
        return error(404, 'engine_not_found', 'Engine not found');
      if (engine.revokedAt) return error(409, 'engine_revoked', 'Engine revoked');
      const logins = this.engineProviderLogins.get(engine.id) ?? {};
      return ok({
        providers: AgentProvider.options
          .filter((provider) => provider !== 'nanogpt')
          .map((provider) => ({
            provider,
            loggedIn: engine.online ? (logins[provider] ?? false) : null,
            method: logins[provider] ? 'subscription' : null,
            checkedAt: nowIso(),
            ...(engine.online && !logins[provider] ? { problem: 'not_logged_in' as const } : {}),
          })),
      });
    }
    const renamed = /^\/api\/engines\/(eng_[a-z0-9]{12})$/.exec(path);
    if (renamed && method === 'PATCH') {
      const engine = this.engines.find((entry) => entry.id === renamed[1]);
      // Another owner's engine is not there for the caller (404, like the lists).
      if (!engine || (!me.hostOwner && engine.createdBy !== userId))
        return error(404, 'engine_not_found', 'Engine not found');
      const input = parseBody(RenameEngineRequest, body);
      if (!input) return error(400, 'invalid_request', 'Invalid engine name');
      if (engine.revokedAt) return error(409, 'engine_revoked', 'The engine is revoked');
      engine.name = input.name;
      this.emit({ type: 'engine_changed', engine: this.engineStatus(engine) });
      return ok(asSeen(engine));
    }
    const m = /^\/api\/engines\/(local|eng_[a-z0-9]{12})\/(revoke|default)$/.exec(path);
    if (m && method === 'POST') {
      const engine = this.engines.find((entry) => entry.id === m[1]);
      if (!engine) return error(404, 'engine_not_found', 'Unknown engine');
      if (engine.revokedAt) return error(409, 'engine_revoked', 'The engine is revoked');
      if (m[2] === 'default' && !me.hostOwner)
        return error(403, 'owner_only', 'Only the host owner may choose the default engine');
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

  /** The checklist's `engine_connected` fact (PM-1069): the single-machine engine holds all; in a cloud, the default binding's engine must list the project. */
  private projectEngineHolds(projectKey: string): boolean {
    if (this.engineMode === 'single') return true;
    const bound = (this.projectEngineBindings.get(projectKey) ?? []).find((binding) => binding.isDefault);
    return bound !== undefined && this.engineHolds.has(`${projectKey}/${bound.engineId}`);
  }

  /** The server's project engine endpoints (PM-1060), with the shared rules; the fake has one viewer. */
  private projectEngineRoutes(
    method: string,
    projectKey: string,
    engineId: string | undefined,
    body: unknown,
  ): MockResponse {
    // An owner account's own project (created through the wizard) has its engines here too; it is its owner.
    const ownProject =
      this.ownerAccountIds.has(this.user.userId) && this.extraProjects.some((p) => p.key === projectKey);
    if (projectKey !== fixtures.PROJECT_KEY && !ownProject) return error(404, 'not_found', 'Unknown project');
    const userId = this.user.userId;
    const access = ownProject ? 'owner' : this.viewerAccess();
    const bindings = this.projectEngineBindings.get(projectKey) ?? [];
    const engineOf = (id: string) => this.engines.find((entry) => entry.id === id);
    const viewOf = (engine: EngineView, isDefault: boolean): ProjectEngineView => ({
      id: engine.id,
      name: engine.name,
      online: !engine.revokedAt && engine.online,
      isDefault,
      holdsProject: this.engineHolds.has(`${projectKey}/${engine.id}`),
      ownedByMe: engine.createdBy === userId,
    });
    if (engineId === undefined) {
      if (method !== 'GET') return error(404, 'not_found', `No route for ${method} ${projectKey}`);
      if (this.engineMode === 'single')
        return ok({
          engines: [
            {
              id: 'local',
              name: 'local',
              online: true,
              isDefault: true,
              holdsProject: true,
              ownedByMe: true,
            },
          ],
        });
      if (bindings.length > 0)
        return ok({
          engines: bindings.flatMap((b) =>
            engineOf(b.engineId) ? [viewOf(engineOf(b.engineId)!, b.isDefault)] : [],
          ),
        });
      const fallback = this.engines.find((entry) => entry.isDefault && !entry.revokedAt);
      const chosen = projectEngineOf({
        bindings: [],
        globalDefault: fallback ? { id: fallback.id, ownerUserId: fallback.createdBy } : null,
        projectOwnerUserIds: access === 'owner' ? [userId] : [],
        // The engine routes of the fake serve the seeded project only, which the host owner registered.
        projectCreatedBy: null,
      });
      const engine = chosen ? engineOf(chosen) : undefined;
      return ok({ engines: engine ? [viewOf(engine, true)] : [] });
    }
    const engine = this.engineMode === 'cloud' ? engineOf(engineId) : undefined;
    if (method === 'PUT') {
      if (access !== 'owner') return error(403, 'insufficient_access', 'requires owner access');
      const input = parseBody(BindProjectEngineRequest, body);
      if (!input) return error(400, 'invalid_request', 'Invalid request');
      if (!engine) return error(404, 'engine_not_found', 'Unknown engine');
      const bound = bindings.find((b) => b.engineId === engineId);
      if (
        !bound &&
        !canBindEngine({
          actorUserId: userId,
          engineOwnerUserId: engine.createdBy,
          actorIsProjectOwner: true,
        })
      )
        return error(403, 'engine_not_owned', 'Only the engine owner may bind it to a project');
      if (engine.revokedAt) return error(409, 'engine_revoked', 'The engine is revoked');
      const makeDefault = input.default === true || bindings.length === 0;
      const next = bound ?? { engineId, isDefault: false };
      if (!bound) this.projectEngineBindings.set(projectKey, [...bindings, next]);
      if (makeDefault) for (const b of this.projectEngineBindings.get(projectKey)!) b.isDefault = b === next;
      this.emit({ type: 'engine_changed', engine: this.engineStatus(engine), projectKey });
      return ok(viewOf(engine, next.isDefault));
    }
    if (method === 'DELETE') {
      if (!engine) return error(404, 'engine_not_found', 'Unknown engine');
      if (
        !canUnbindEngine({
          actorUserId: userId,
          engineOwnerUserId: engine.createdBy,
          actorIsProjectOwner: access === 'owner',
        })
      )
        return error(403, 'insufficient_access', 'Only the engine owner or the project owner may unbind it');
      const bound = bindings.find((b) => b.engineId === engineId);
      if (!bound) return error(404, 'engine_not_found', 'The engine is not bound');
      if (
        this.sessions.some(
          (session) =>
            session.engineId === engineId && session.state !== 'exited' && session.state !== 'failed',
        )
      )
        return error(409, 'engine_in_use', 'The project has a session on this engine');
      if (bound.isDefault && bindings.length > 1)
        return error(409, 'engine_is_default', 'Make another engine the default first');
      this.projectEngineBindings.set(
        projectKey,
        bindings.filter((b) => b !== bound),
      );
      this.emit({ type: 'engine_changed', engine: this.engineStatus(engine), projectKey });
      return ok();
    }
    return error(404, 'not_found', `No route for ${method} ${projectKey}`);
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
    if (this.integratorMode) {
      const verdict = superAccessVerdict(this.config, {
        mode: this.integratorMode,
        operation: method === 'GET' || method === 'HEAD' ? 'read' : 'write',
        ownerMembership: this.viewerAccess() === 'owner',
      });
      if (!verdict.allowed) return error(403, verdict.code, 'Credential access refused');
    }
    let m: RegExpExecArray | null;
    if (rest === '/operator-super/audit') {
      if (this.viewerAccess() !== 'owner' || this.integratorMode)
        return error(403, 'owner_only', 'Own owner login required');
      const input = SuperAuditQuery.safeParse(Object.fromEntries(query));
      if (!input.success) return error(400, 'invalid_request', 'Invalid audit query');
      const all = this.superAudits.filter(
        (entry) => !input.data.prefix || entry.prefix === input.data.prefix,
      );
      const start = input.data.before ? all.findIndex((entry) => entry.id === input.data.before) + 1 : 0;
      const entries = all.slice(start, start + input.data.limit);
      return ok({
        entries: clone(entries),
        nextBefore: start + entries.length < all.length ? entries.at(-1)!.id : null,
      });
    }
    if (rest === '/operator-super/handoffs') {
      if (this.viewerAccess() !== 'owner') return error(403, 'owner_only', 'Owner access required');
      const input = ListSuperHandoffsQuery.safeParse(Object.fromEntries(query));
      if (!input.success) return error(400, 'invalid_request', 'Invalid handoff query');
      return ok({
        handoffs: clone(
          this.superHandoffs
            .filter((entry) =>
              input.data.state ? entry.state === input.data.state : SUPER_OPEN_STATES.includes(entry.state),
            )
            .slice(0, input.data.limit),
        ),
      });
    }
    if ((m = /^\/operator-super\/handoffs\/([^/]+)$/.exec(rest))) {
      if (this.viewerAccess() !== 'owner') return error(403, 'insufficient_access', 'Owner access required');
      const handoff = this.superHandoffs.find(
        (entry) => entry.id === decodeURIComponent(m![1]!) && entry.projectKey === this.config.project.key,
      );
      return handoff ? ok({ handoff: clone(handoff) }) : error(404, 'not_found', 'Handoff not found');
    }
    if ((m = /^\/operator-super\/operations\/([^/]+)$/.exec(rest))) {
      if (this.viewerAccess() !== 'owner') return error(403, 'owner_only', 'Owner access required');
      const operation = this.superOperations.find((entry) => entry.id === m![1]);
      return operation
        ? ok({ operation: clone(operation), result: clone(this.superResults.get(operation.id) ?? null) })
        : error(404, 'not_found', 'Operation not found');
    }
    if (rest === '/merge-queue/order') {
      if (method === 'GET') return ok(clone(this.mergeQueueOrder(query.get('repo') ?? '')));
      const parsed = OrderMergeQueueRequest.safeParse(body);
      if (!parsed.success) return error(400, 'invalid_request', 'Invalid queue order');
      if (this.viewerAccess() !== 'owner') return error(403, 'insufficient_access', 'Owner access required');
      const current = this.mergeQueueOrder(parsed.data.repo);
      if (mergeQueueOrderRefusal(current, parsed.data))
        return error(409, 'merge_queue_conflict', 'The merge queue changed');
      const changed = current.taskKeys.some((key, index) => parsed.data.taskKeys[index] !== key);
      const ordered = { revision: current.revision + Number(changed), taskKeys: [...parsed.data.taskKeys] };
      this.mergeOrders.set(parsed.data.repo, ordered);
      return ok(clone(ordered));
    }
    const restricted =
      rest.startsWith('/invites') ||
      (rest === '/roles' && method !== 'GET') ||
      (rest.startsWith('/roles/') && method !== 'GET') ||
      (rest.startsWith('/members') && method !== 'GET' && !rest.endsWith('/conversation')) ||
      /\/tasks\/[^/]+\/cancel$/.test(rest) ||
      // A theme is reopened from developer access, any other card by an admin (like the server).
      this.reopensNonTheme(rest);
    const viewer = this.findMember(this.viewerHandle);
    if (!viewer) return error(403, 'not_a_member', 'Not a member');
    if (restricted && (viewer.kind !== 'human' || !['owner', 'admin'].includes(viewer.role)))
      return error(403, 'insufficient_access', 'Owner or admin required');
    if (/\/tasks\/[^/]+\/(close-theme|reopen|board-move)$/.test(rest)) {
      if (viewer.kind !== 'human' || !['owner', 'admin', 'developer'].includes(viewer.role))
        return error(403, 'insufficient_access', 'Developer access required');
    }
    if (rest === '/tasks' && method === 'POST') {
      const access = this.viewerAccess();
      if (!canCreateTasks(this.config, access))
        return error(403, 'insufficient_access', `Requires ${taskCreateAccessOf(this.config)} access`);
      const stageId = (body as { stageId?: unknown } | undefined)?.stageId;
      if (
        createsInFirstStageOnly(access) &&
        stageId !== undefined &&
        stageId !== this.config.pipeline.stages[0]?.id
      )
        return error(403, 'insufficient_access', 'A client opens cards in the first stage only');
    }
    if (rest.startsWith('/invites')) return this.handleInvitations(method, rest, body);
    if (rest === '/email' || rest.startsWith('/email/'))
      return (
        this.email.handle(method, rest.slice('/email'.length), body, query) ??
        error(404, 'not_found', 'Unknown route')
      );
    if (rest === '/feedback' || rest.startsWith('/feedback/'))
      return (
        this.feedback.handle(method, rest.slice('/feedback'.length), body, query) ??
        error(404, 'not_found', 'Unknown route')
      );
    if (rest === '/schedules' && method === 'GET') return ok(this.schedulesView());
    const scheduleMatch = /^\/members\/([\w-]+)\/schedule\/run$/.exec(rest);
    if (scheduleMatch && method === 'POST') return this.runSchedule(scheduleMatch[1]!);
    if (rest === '/board') return ok(this.board());
    if (rest === '/structure' && method === 'GET') return ok(clone(this.structure));
    if (rest === '/project-manager' && method === 'GET') return this.projectManagerChannel();
    const checklistState = /^\/checklist\/items\/([a-z][a-z0-9_]{0,39})\/state$/.exec(rest);
    if ((rest === '/checklist' && method === 'GET') || (checklistState && method === 'POST')) {
      const access = this.viewerAccess();
      if (access !== 'owner' && (access !== 'admin' || method !== 'GET'))
        return error(403, 'insufficient_access', 'Checklist access required');
      if (checklistState) {
        const parsed = SetChecklistItemStateRequest.safeParse(body);
        if (!parsed.success) return error(400, 'invalid_request', 'Invalid checklist state');
        if (!this.checklist) return error(404, 'checklist_missing', 'Checklist does not exist');
        const item = this.checklist.items.find((item) => item.id === checklistState[1]);
        if (!item) return error(404, 'checklist_item_not_found', 'Checklist item does not exist');
        if (!(parsed.data.state === 'open' && item.state === 'open')) {
          item.state = parsed.data.state;
          item.reason = parsed.data.state === 'not_needed' ? parsed.data.reason : null;
          item.reopened = parsed.data.state === 'open' ? 'owner' : null;
          item.updatedBy = this.viewerHandle;
          item.updatedAt = nowIso();
          this.emit({ type: 'project_checklist_changed', projectKey: this.config.project.key });
        }
      }
      if (this.checklist) {
        for (const item of this.checklist.items)
          item.conditionHolds = item.condition
            ? checklistConditionHolds(item.condition, this.config, {
                agreementApproved: this.operatorKnowledge.agreement !== null,
                taskCount: this.tasks.filter((task) => task.status !== 'cancelled').length,
                engineConnected: this.projectEngineHolds(this.config.project.key),
              })
            : null;
        this.checklist.progress = checklistProgress(this.checklist.items);
      }
      return ok({ checklist: clone(this.checklist), canEdit: access === 'owner' });
    }
    if (rest === '/project-manager/queue' && method === 'GET')
      return this.memberQueue(projectManagerOf(this.config)?.handle ?? 'pm', query);
    if (rest === '/operator/preferences/me' && method === 'GET')
      return ok(
        clone(
          this.operatorPreferences[this.viewerHandle] ?? {
            schemaVersion: 1,
            revision: 0,
            data: DEFAULT_OPERATOR_PREFERENCE,
            updatedAt: null,
          },
        ),
      );
    if ((rest === '/operator/knowledge' || rest === '/operator/preferences') && method === 'GET') {
      if (!canReadOperatorKnowledge({ access: this.viewerAccess() }))
        return error(403, 'operator_owner_only', 'Owner or admin access required');
      return rest === '/operator/knowledge'
        ? ok(clone(this.operatorKnowledge))
        : ok({
            items: this.config.team.members
              .filter((member) => member.kind === 'human')
              .map(({ handle }) => ({
                handle,
                preference: clone(
                  this.operatorPreferences[handle] ?? {
                    schemaVersion: 1,
                    revision: 0,
                    data: DEFAULT_OPERATOR_PREFERENCE,
                    updatedAt: null,
                  },
                ),
              })),
          });
    }
    if (rest === '/operator/approval-waiver' && method === 'PUT') {
      if (this.viewerAccess() !== 'owner')
        return error(403, 'owner_approval_required', 'Owner login required');
      const input = parseBody(OperatorApprovalWaiverRequest, body);
      if (!input) return error(400, 'invalid_request', 'Invalid waiver request');
      if (input.baseVersion !== this.configVersion)
        return error(409, 'config_conflict', 'Configuration changed');
      if (input.agreementVersion !== this.operatorKnowledge.agreement?.version)
        return error(409, 'operator_knowledge_stale', 'Agreement changed');
      this.config.team.operatorApprovalWaiver = input.enabled;
      this.configVersion = mockId('config');
      return ok({
        version: this.configVersion,
        enabled: input.enabled,
        agreementVersion: input.agreementVersion,
      });
    }
    const signalMatch = /^\/operator\/signals\/([\w-]+)\/dismiss$/.exec(rest);
    if (signalMatch && method === 'POST') return this.dismissOperatorSignal(signalMatch[1]!);
    if (/^\/pause(\/resume|\/force)?$/.test(rest)) return this.projectPause(method, rest);
    if (rest === '/measure/closed-cards' && method === 'GET')
      return ok(this.closedCardsMeasure(Number(query.get('days') ?? DEFAULT_CLOSED_CARDS_DAYS)));

    if (rest === '/tasks') {
      if (method === 'POST') return this.createTask(body);
      return ok(clone(this.tasks));
    }
    if ((m = /^\/tasks\/([A-Z][A-Z0-9]*-\d+)\/handoffs\/([^/]+)$/.exec(rest)) && method === 'GET') {
      const record = this.handoffRecords.get(m[2]!);
      if (!record || record.taskKey !== m[1]) return error(404, 'not_found', 'Unknown handoff');
      const { taskKey: _taskKey, ...view } = record;
      return ok(clone(view));
    }
    if ((m = /^\/message-attachments(?:\/(msa_[a-z0-9]+)(?:\/(content|download|thumbnail))?)?$/.exec(rest))) {
      return this.handleMessageAttachments(method, m[1], m[2], body);
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
    if ((m = /^\/tasks\/([A-Z][A-Z0-9]*-\d+)\/merge$/.exec(rest)) && method === 'POST') {
      return this.startMerge(m[1]!, body);
    }
    if ((m = /^\/tasks\/([A-Z][A-Z0-9]*-\d+)\/merge\/prioritize$/.exec(rest)) && method === 'POST') {
      return this.prioritizeMerge(m[1]!, body);
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
      const window = chatWindow(this.chats[session.id] ?? [], {
        limit: Number(query.get('limit') ?? SESSION_CHAT_WINDOW),
        before: query.get('before') ?? undefined,
      });
      return ok({
        session: clone(session),
        chat: clone(window.items),
        task: task ? clone(task) : null,
        ...(window.truncated ? { truncated: true } : {}),
      });
    }
    if ((m = /^\/sessions\/([\w-]+)\/messages$/.exec(rest)) && method === 'POST')
      return this.sessionMessage(m[1]!, body);
    if ((m = /^\/sessions\/([\w-]+)\/stop$/.exec(rest)) && method === 'POST')
      return this.stopSession(m[1]!, body);

    if (rest === '/involvements' && method === 'GET') {
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
    if ((m = /^\/members\/([a-z0-9-]+)\/rename$/.exec(rest)) && method === 'POST')
      return this.renameMember(m[1]!, body);
    if ((m = /^\/members\/([a-z0-9-]+)\/(profile|memories|conversation|remove|context)$/.exec(rest))) {
      const handle = m[1]!;
      if (m[2] === 'context' && (this.viewerAccess() !== 'owner' || this.integratorMode))
        return error(403, 'insufficient_access', 'Owner login required');
      const member = this.findMember(handle);
      const original = memberOf(this.config, handle);
      if (!member || !original || member.status === 'retired')
        return error(404, 'not_found', 'Unknown member');
      if (m[2] === 'context' && method === 'GET') {
        if (original.kind !== 'ai') return error(400, 'not_ai_member', 'Only AI members have context');
        const taskKey = query.get('task');
        const task = taskKey === null ? undefined : this.tasks.find((entry) => entry.key === taskKey);
        if (taskKey !== null && !task) return error(404, 'task_not_found', 'Unknown task');
        if (task && isTheme(task)) return error(400, 'task_is_theme', 'A theme has no work context');
        // Fixed UI sample: prompt construction and tool visibility are tested at the server boundary.
        const text = 'You are an AI member of the team.\nWork with the current project rules.';
        const initial = task ? `Work on ${task.key}: ${task.title}` : 'Help the owner with the project.';
        const preview: MemberContextPreview = {
          generatedAt: new Date().toISOString(),
          member: {
            handle,
            role: original.role,
            duties: memberDuties(this.config, original),
            onLeave: original.onLeave ?? false,
          },
          situation: task ? { kind: 'task', taskKey: task.key, stageId: task.stageId } : { kind: 'general' },
          prompt: {
            text,
            chars: [...text].length,
            sections: [{ id: 'identity', title: 'Who you are', text, chars: [...text].length }],
          },
          initialMessage: { text: initial, chars: [...initial].length },
          guides: [{ topic: 'rules', title: 'Team rules', text: 'Follow the task gates.', chars: 22 }],
          tools: [
            {
              name: 'get_task',
              title: 'Read a task',
              description: 'Read the current task and its timeline.',
            },
            { name: 'get_guide', title: 'Read a guide', description: 'Read the guide for a topic.' },
          ],
        };
        return ok(preview);
      }
      if (m[2] === 'conversation' && method === 'POST') return this.startConversation(handle);
      if (m[2] === 'memories' && method === 'GET') {
        if (member.kind !== 'ai') return error(400, 'not_ai_member', 'Only AI members have memory');
        return ok({ memory: this.memories[handle] ?? '' });
      }
      if (m[2] === 'remove' && method === 'DELETE') {
        if (handle === this.viewerHandle) return error(403, 'cannot_remove_self', 'Cannot remove yourself');
        if (original.kind !== 'human') return error(400, 'not_human_member', 'Only humans can be removed');
        const next = clone(this.config);
        next.team.members = next.team.members.filter((entry) => entry.handle !== handle);
        const wasContact = (next.team.contacts ?? []).includes(handle);
        next.team.contacts = (next.team.contacts ?? []).filter((contact) => contact !== handle);
        for (const stage of next.pipeline.stages)
          if (stage.owners) stage.owners = stage.owners.filter((h) => h !== handle);
        const failure = this.configChangeFailure(next);
        if (failure) return failure;
        this.config = next;
        if (wasContact)
          this.addTimeline(null, this.viewerHandle, 'team_contact_changed', {
            handle,
            contact: false,
            version: this.configVersion,
          });
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
        const visible = this.tasks.filter((t) => isOpenTask(t));
        const awaiting = new Set(
          this.inbox.filter((i) => i.state === 'open' && i.assignees.includes(handle)).map((i) => i.taskKey),
        );
        const stages = this.config.pipeline.stages
          .filter((stage) => stageApprovers(this.config, stage).includes(handle))
          .map((stage) => stage.id);
        return ok({
          member: this.viewOf(member),
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
          inbox: clone(this.inbox.filter((i) => i.state === 'open' && i.assignees.includes(handle))),
          timeline: clone(
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
          ),
          sessions: clone(
            this.sessions
              .filter((s) => s.member === handle)
              .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)),
          ),
          capacity: original.kind === 'ai' ? original.capacity : null,
          capacityUsed: original.kind === 'ai' ? this.memberLoad(handle) : 0,
          ...(original.kind === 'ai' ? { capacityHolders: this.memberHolders(handle) } : {}),
          ...(original.kind === 'ai' ? { usage: this.memberUsage(handle) } : {}),
          ...(original.kind === 'human' && ['owner', 'admin'].includes(viewer.role) && original.email
            ? { email: original.email }
            : {}),
        });
      }
    }
    if (rest === '/inbox') {
      this.sweepIntegratorTodos(nowIso());
      // Like the server: open items by default and never cut off; any other state is a history, the newest N.
      const wanted = query.get('state') ?? 'open';
      const limit = Number(query.get('limit')) || (wanted === 'open' || wanted === 'active' ? Infinity : 500);
      const inState = (item: InboxItem) =>
        wanted === 'all' ||
        (wanted === 'closed'
          ? ['resolved', 'expired', 'cancelled'].includes(item.state)
          : wanted === 'active'
            ? ['open', 'screening'].includes(item.state)
            : item.state === wanted);
      // Use the shared privacy rule, including private knowledge approvals.
      return ok({
        items: clone(
          this.inbox
            .filter(
              (item) =>
                inState(item) &&
                canSeeInboxItem(this.taskViewer(), item) &&
                (query.get('mine') !== 'true' || humanInboxAssignment(item, this.viewerHandle)) &&
                (!operatorApprovalOf(item) || item.assignees.includes(this.viewerHandle)),
            )
            .slice(-limit)
            .map((item) => visibleQuestionItem(this.taskViewer(), item, (key) => !!this.findTask(key))),
        ),
      });
    }
    if (rest === '/inbox/screened' && method === 'GET') return this.screenedQuestions(query);
    if ((m = /^\/inbox\/([\w-]+)\/resolve$/.exec(rest)) && method === 'POST')
      return this.resolve(m[1]!, body);
    if ((m = /^\/inbox\/([\w-]+)\/check$/.exec(rest)) && method === 'POST') return this.checkOutage(m[1]!);

    if (rest === '/config') {
      if (method === 'PATCH') return this.patchConfig(body);
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
    if (this.integratorMode === 'super') {
      const effect = ownerReservedEffect(this.config, { kind: 'config_change', next });
      if (effect)
        return error(403, 'owner_approval_required', 'A specific owner authorization is required', {
          effect,
        });
    }
    if (operatorWaiverChanged(this.config, next))
      return error(403, 'owner_approval_required', 'Use the dedicated owner waiver endpoint');
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

  /** The configuration a create would save: the template's, with the request's name, workspace, repos and mover. */
  private projectDraft(input: CreateProjectRequest): ProjectConfig | MockResponse {
    const template = getTemplate(input.templateId ?? 'starter');
    if (!template) return error(400, 'unknown_template', `unknown template: ${input.templateId}`);
    const built = template.build({
      key: input.key,
      name: input.name,
      workspacePath: input.workspacePath,
      language: input.language ?? DEFAULT_PROJECT_LANGUAGE,
      provider: input.provider,
      owner: { handle: 'owner', displayName: 'Owner', email: 'owner@example.com' },
      cardMover:
        input.cardMover === 'creator'
          ? { kind: 'human', handle: 'owner' }
          : { kind: input.cardMover ?? 'worker' },
    });
    const parsed = ProjectConfig.safeParse({
      ...built,
      project: {
        ...built.project,
        key: input.key,
        name: input.name,
        workspacePath: input.workspacePath,
        templateId: input.templateId ?? 'starter',
        ...(input.repos ? { repos: input.repos } : {}),
      },
    });
    return parsed.success
      ? parsed.data
      : error(422, 'invalid_config', 'template produced an invalid configuration', {
          schemaIssues: parsed.error.issues,
        });
  }

  private patchConfig(body: unknown): MockResponse {
    if (hasOperatorWaiverField(body))
      return error(403, 'owner_approval_required', 'Use the dedicated owner waiver endpoint');
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
    if (input.email?.enabled && !this.email.configured)
      return error(409, 'email_not_configured', 'E-mail sending is not configured');
    const next = applyConfigPatch(this.config, input);
    const failure = this.configChangeFailure(next);
    if (failure) return failure;
    if (JSON.stringify(next) !== JSON.stringify(this.config)) {
      const before = new Set(contactHandles(this.config));
      const after = new Set(contactHandles(next));
      this.config = next;
      if (input.email) this.emit({ type: 'email_changed', projectKey: next.project.key });
      const message =
        input.message ??
        (input.pipeline ? 'Update pipeline' : input.limits ? 'Update limits' : 'Update project');
      this.commitConfig(message);
      this.addTimeline(null, this.viewerHandle, 'config_changed', { version: this.configVersion, message });
      // Who became a contact and who stopped being one is its own line on the timeline (PM-985).
      for (const handle of [...before, ...after].filter((handle) => before.has(handle) !== after.has(handle)))
        this.addTimeline(null, this.viewerHandle, 'team_contact_changed', {
          handle,
          contact: after.has(handle),
          version: this.configVersion,
        });
      // Who merges, and which repositories need a merge, decide the cards' merge requests.
      if (input.merger || input.repoMerge) this.reconcileMerges();
    }
    return ok({ config: clone(this.config), version: this.configVersion, history: clone(this.history) });
  }

  /** Handles in use now or in the past (the configuration, retired members, sessions): never reused. */
  private takenHandles(config: ProjectConfig = this.config): Set<string> {
    return new Set([
      RETIRED_OPERATOR_HANDLE,
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
        ...(invite.access === 'client' && this.emailLogin.enabled
          ? { emailHint: maskEmail(invite.email) }
          : {}),
      });
    if (account && (this.auth !== 'ready' || this.user.userId !== account.userId))
      return error(409, 'login_required', 'Log in as the invited account');
    if (account && !parseBody(AcceptInviteRequest, body))
      return error(400, 'invalid_request', 'Invalid invitation acceptance body');
    const input = account ? null : parseBody(AcceptInviteRequest.required(), body);
    if (!account && !input)
      return error(400, 'invalid_request', 'Name and eight-character password required');
    return this.acceptInvite(invite, account ?? { name: input!.name, password: input!.password });
  }

  /** The owner invitation (PM-1062): the same account rules as a project invitation, then an owner account. */
  private handleOwnerInvite(method: string, token: string, accepting: boolean, body: unknown): MockResponse {
    if (!(method === 'GET' && !accepting) && !(method === 'POST' && accepting))
      return error(404, 'not_found', 'Unknown invitation route');
    const invite = this.ownerInvites.find((entry) => entry.token === token);
    if (!invite || invite.used) return error(404, 'invite_invalid', 'Invalid invitation');
    const account = this.accounts.get(invite.email);
    if (!accepting)
      return ok({
        inviterName: invite.inviterName,
        expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        requiresLogin: !!account,
      });
    if (account && (this.auth !== 'ready' || this.user.userId !== account.userId))
      return error(409, 'login_required', 'Log in as the invited account');
    const input = account ? null : parseBody(AcceptInviteRequest.required(), body);
    if (!account && !input)
      return error(400, 'invalid_request', 'Name and eight-character password required');
    const user = account ?? {
      userId: `usr_${this.accounts.size + 1}`,
      name: input!.name,
      email: invite.email,
      password: input!.password,
    };
    this.accounts.set(invite.email, user);
    this.ownerAccountIds.add(user.userId);
    invite.used = true;
    this.user = { userId: user.userId, name: user.name, email: user.email };
    this.viewerHandle = '';
    this.auth = 'ready';
    return ok(this.me());
  }

  /** The open invitation behind a token, whatever its access. */
  private openInvite(token: string): (typeof this.invitations)[number] | undefined {
    return this.invitations.find(
      (invite) =>
        invite.token === token && !invite.acceptedAt && !invite.revokedAt && invite.expiresAt > nowIso(),
    );
  }

  /** The open client invitation behind a token (the only kind a code can accept). */
  private openClientInvite(token: string): (typeof this.invitations)[number] | undefined {
    const invite = this.openInvite(token);
    return invite?.access === 'client' ? invite : undefined;
  }

  private openInvitesOf(email: string): Array<(typeof this.invitations)[number]> {
    return this.invitations.filter(
      (invite) =>
        invite.email === email && !invite.acceptedAt && !invite.revokedAt && invite.expiresAt > nowIso(),
    );
  }

  /**
   * The server's client-standing rule: the address has a client account or open client invitations, is
   * not the host owner, belongs to no one but a client and has no open invitation of any other access.
   */
  private emailLoginEligible(email: string): boolean {
    const account = this.accounts.get(email);
    if (account?.userId === fixtures.mockUser.userId) return false;
    const open = this.openInvitesOf(email);
    if (open.some((invite) => invite.access !== 'client')) return false;
    const memberships = this.config.team.members.filter(
      (member) => member.kind === 'human' && member.email?.toLowerCase() === email,
    );
    if (memberships.some((member) => member.kind !== 'human' || member.access !== 'client')) return false;
    return memberships.length > 0 || open.length > 0;
  }

  /** A right code: accepts the open client invitations, makes the passwordless account and starts the session. */
  private startEmailSession(email: string, name: string | null): unknown {
    // The fake has one project: an invitation to a seat the person holds already stays open, as it fails.
    for (const invite of this.openInvitesOf(email))
      this.acceptInvite(invite, this.accounts.get(email) ?? { name: name ?? '', password: null });
    const account = this.accounts.get(email);
    if (account) {
      this.user = { userId: account.userId, name: account.name, email: account.email };
      this.viewerHandle =
        this.config.team.members.find(
          (member) => member.kind === 'human' && member.email?.toLowerCase() === email,
        )?.handle ?? '';
      this.auth = 'ready';
    }
    return this.me();
  }

  private acceptInvite(
    invite: (typeof this.invitations)[number],
    who:
      | { userId: string; name: string; email: string; password: string | null }
      | { name: string; password: string | null },
  ): MockResponse {
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
    const user =
      'userId' in who
        ? who
        : { userId: mockId('usr'), name: who.name, email: invite.email, password: who.password };
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
    // The shared rule restricts configurable limits to permanent AI developers.
    if (
      input.complexityLimit !== undefined &&
      (config.kind !== 'ai' || config.temp || !isDeveloper(this.config, config))
    )
      return error(422, 'complexity_limit_not_developer', 'Only a permanent developer can have a limit');
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
        input.machineAccess !== undefined ||
        input.email !== undefined ||
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
      if (input.machineAccess !== undefined) nextMember.machineAccess = input.machineAccess;
      if (input.email !== undefined) nextMember.email = applyMemberEmailChange(nextMember.email, input.email);
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
      if (input.complexityLimit !== undefined) {
        if (input.complexityLimit === null) delete config.complexityLimit;
        else config.complexityLimit = input.complexityLimit;
      }
      if (isDeveloper(this.config, config)) member.complexityLimit = complexityLimitOf(this.config, config);
      else delete member.complexityLimit;
      if (input.schedule !== undefined) config.schedule = input.schedule ?? undefined;
      if (input.instructions !== undefined) config.instructions = input.instructions.trim();
      if (input.permissionMode !== undefined) config.permissionMode = input.permissionMode;
      if (input.approver !== undefined) config.approver = input.approver;
      if (input.outboundNetwork !== undefined) config.outboundNetwork = input.outboundNetwork;
      if (input.machineAccess !== undefined) config.machineAccess = input.machineAccess;
      if (input.email !== undefined) {
        config.email = applyMemberEmailChange(config.email, input.email);
        member.email = {
          enabled: config.email.enabled,
          sendWithoutApproval: config.email.sendWithoutApproval ?? false,
        };
        this.emit({ type: 'email_changed', projectKey: this.config.project.key });
      }
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

  private taskPullRequests(task: Task): TaskDetail['pullRequests'] {
    return task.links
      .filter((link) => link.kind === 'pull_request' && link.repo)
      .map((link) => ({
        repo: link.repo!,
        number: Number(link.ref),
        url: `https://github.com/${link.repo}/pull/${link.ref}`,
        title: link.title ?? null,
        state: (link.state as TaskDetail['pullRequests'][number]['state']) ?? null,
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
    // The connected Claude acts as its holder in person (decision 66), the same shape the server binds.
    if (this.integratorMode === 'super')
      return connectedActorOf(this.viewerHandle, { id: 'mock_integrator', prefix: 'pmi_mock' });
    if (this.integratorMode) return { kind: 'human', handle: this.viewerHandle, via: 'integrator' };
    return { kind: 'human', handle: this.viewerHandle };
  }

  /** Message files have no card association; visibility follows the message or the unsent uploader. */
  private handleMessageAttachments(
    method: string,
    id: string | undefined,
    content: string | undefined,
    body: unknown,
  ): MockResponse {
    const viewer = this.taskViewer();
    if (!id && method === 'POST') {
      const file = body instanceof FormData ? body.get('file') : null;
      if (!(file instanceof File)) return error(400, 'invalid_request', 'Missing file');
      if (file.size > MAX_ATTACHMENT_BYTES) return error(413, 'attachment_too_large', 'Too large');
      if (
        this.messageAttachments.filter(
          (item) => !item.messageId && item.uploadedBy.handle === this.viewerHandle,
        ).length >= MAX_UNSENT_MESSAGE_ATTACHMENTS
      )
        return error(409, 'message_attachment_limit', 'Too many unsent files');
      const attachment: MessageAttachment = {
        id: `${mockId('msa')}0000`,
        projectKey: fixtures.PROJECT_KEY,
        fileName: file.name,
        size: file.size,
        mediaType: file.type in INLINE_MEDIA_TYPES ? file.type : OCTET_STREAM,
        preview: attachmentPreviewOf(file.type),
        uploadedBy: this.viewerActor(),
        createdAt: nowIso(),
      };
      this.messageAttachments.push(attachment);
      return { status: 201, body: { attachment: clone(attachment) } };
    }
    const attachment = this.messageAttachments.find((file) => file.id === id);
    const message = attachment?.messageId
      ? this.messages.find((entry) => entry.id === attachment.messageId)
      : undefined;
    if (
      !attachment ||
      (attachment.messageId
        ? !message || !canSeeTeamMessage(viewer, message)
        : attachment.uploadedBy.kind !== 'human' || attachment.uploadedBy.handle !== this.viewerHandle)
    )
      return error(404, 'not_found', 'Unknown attachment');
    if ((method === 'GET' || method === 'HEAD') && content) return ok(clone(attachment));
    if (method === 'DELETE' && !content) {
      if (!canDeleteMessageAttachment(viewer, attachment))
        return error(403, 'insufficient_access', 'Cannot delete attachment');
      this.messageAttachments = this.messageAttachments.filter((file) => file.id !== id);
      if (message) {
        message.attachments = message.attachments?.map((file) =>
          file.id === id ? { ...file, goneAt: nowIso(), goneBy: this.viewerActor() } : file,
        );
        this.emit({
          type: 'team_message_updated',
          projectKey: fixtures.PROJECT_KEY,
          message: clone(message),
        });
      }
      return ok({ id, deleted: true });
    }
    return error(404, 'not_found', 'Unknown route');
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
    if (!task) return error(404, 'not_found', 'Unknown task');
    if (!id && method === 'GET') {
      return ok({ attachments: clone(this.attachments.filter((entry) => entry.taskKey === taskKey)) });
    }
    if (!id && method === 'POST') {
      if (!canUploadAttachment(viewer))
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
      if (!canDeleteAttachment(viewer, attachment))
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
    if (!task) return error(404, 'not_found', 'Unknown task');
    if (!canUploadAttachment(viewer)) return error(403, 'insufficient_access', 'Viewers cannot attach files');
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

  taskDetail(task: Task): TaskDetail {
    const wait = this.taskWaitOf(task);
    return {
      ...(wait ? { wait } : {}),
      task: clone(task),
      parent: task.parentKey ? clone(this.findTask(task.parentKey) ?? null) : null,
      subtasks: clone(this.tasks.filter((child) => child.parentKey === task.key)),
      pullRequests: this.taskPullRequests(task),
      timeline: clone(this.timeline.filter((event) => event.taskKey === task.key)),
      sessions: clone(this.taskSessions(task.key)),
      rounds: this.cardRounds(task.key),
      fixRounds: { rounds: this.fixRoundsOf(task.key).rounds, limit: this.fixLimitOf(task.key) },
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

  /** Adds the comment of a label change and notifies the mentioned members. */
  private recordNote(task: Task, text: string, actor: Actor): void {
    const mentions = commentMentions(
      text,
      this.config.team.members.map((member) => member.handle),
      actor.handle,
    );
    this.addTimeline(task.key, actor.handle, 'task_note', { text, mentions });
    if (mentions.length && actor.handle) this.sendTeamMessage(actor.handle, mentions, task.key, text);
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
    this.closeApprovalQuestions(task, plan.added);
    this.continueLabelWait(task);
    return null;
  }

  /** The card's open questions that ask for a label just put on close by themselves (PM-486, rule approval_given). */
  private closeApprovalQuestions(task: Task, added: readonly string[]): void {
    for (const item of [...this.inbox]) {
      if (item.state !== 'open' || item.kind !== 'question' || item.taskKey !== task.key) continue;
      const label = questionPayloadOf(item)?.approvalLabel;
      if (!label || !added.includes(label)) continue;
      this.upsertInbox({
        ...item,
        state: 'resolved',
        resolution: { optionId: 'ended', by: 'system', at: nowIso(), note: null, rule: 'approval_given' },
      });
    }
  }

  /** Takes off the labels that expire on an event (the task moving back, its PR changing). */
  private expireLabels(task: Task, trigger: LabelClearTrigger): void {
    const expired = expiredLabels(this.config, task, trigger);
    if (expired.length) this.applyLabels(task, { remove: expired }, SYSTEM_ACTOR, { reason: trigger });
  }

  /** The waiver of a move into the done stage (PM-647): the rule is the server's, the subtasks are the mock's own. */
  private partsClosedOf(task: Task, targetId: string): PartsClosed | null {
    return partsClosedWaiver(
      this.config,
      task,
      this.tasks.filter((child) => child.parentKey === task.key),
      targetId,
    );
  }

  /** A stage move under the gates: blocked, an approval request in the inbox, or the move itself. */
  private move(task: Task, stageId: string, actor: Actor, placement?: BoardPlacement): MockResponse {
    if (isTheme(task)) return error(409, 'task_is_theme', 'A theme does not move between stages');
    if (task.status === 'cancelled') return error(409, 'task_closed', 'Task is cancelled');
    const target = stageOf(this.config, stageId);
    if (!target) return error(400, 'unknown_stage', 'Unknown stage');
    if (task.stageId === target.id) return ok(clone(task));
    const unmerged = this.mergeGate(task, target.id);
    if (unmerged) return unmerged;
    const partsClosed = this.partsClosedOf(task, target.id);
    const evaluation = partsClosed
      ? { unmet: [], approvals: [] }
      : evaluateMove(task, this.config, task.stageId, target.id);
    if (evaluation.unmet.length) return gateBlockedError(evaluation);
    if (evaluation.approvals.length)
      return this.requestApproval(task, target, evaluation.approvals, actor, placement);
    // An AI member finishing a step in front of a human-owned stage asks the card mover to take the card on.
    const decision = handOnDecision(this.config, actor, task.stageId, target.id);
    if (decision.kind === 'request') return this.requestHandOn(task, target, decision.mover, actor);
    this.applyMove(task, target, actor, partsClosed ? { partsClosed } : {}, placement);
    return ok(clone(task));
  }

  /** Writes a card's merge state and its merged result, and announces the card. */
  private writeMerge(task: Task, merge: TaskMergeState | undefined, merged?: TaskMerged): void {
    const repo = merge?.repo ?? task.merge?.repo;
    if (repo) this.mergeQueueOrder(repo);
    if (merge) task.merge = merge;
    else delete task.merge;
    if (merged) task.merged = merged;
    if (repo) this.mergeQueueOrder(repo);
    task.updatedAt = nowIso();
    this.emit({ type: 'task_upserted', projectKey: task.projectKey, task: clone(task) });
  }

  /** The open request items of a merge end: resolved by the one who started it, else cancelled. */
  private closeMergeItems(task: Task, mergeId: string, by?: string): void {
    for (const item of this.inbox) {
      if (item.state !== 'open' || item.taskKey !== task.key) continue;
      const request = mergeRequestOf(item);
      const alert = alertPayloadOf(item);
      if (request?.mergeId === mergeId && by)
        this.upsertInbox({
          ...item,
          state: 'resolved',
          resolution: { optionId: 'merge', by, at: nowIso(), note: null },
        });
      else if (
        request?.mergeId === mergeId ||
        (alert?.alert === 'merge_blocked' && alert.mergeId === mergeId)
      )
        this.upsertInbox({ ...item, state: 'cancelled' });
    }
  }

  /** A human merger gets a "merge" item for a requested or failed merge; an AI merger reads the card. */
  private notifyMerge(task: Task): void {
    const merge = task.merge;
    if (!merge || (merge.state !== 'requested' && merge.state !== 'failed')) return;
    if (memberOf(this.config, merge.merger)?.kind !== 'human') return;
    if (this.inbox.some((item) => item.state === 'open' && mergeRequestOf(item)?.mergeId === merge.id))
      return;
    this.upsertInbox({
      id: mockId('inb'),
      projectKey: task.projectKey,
      kind: 'merge_request',
      assignees: [merge.merger],
      source: 'system',
      sessionId: null,
      taskKey: task.key,
      title: `Merge ${task.key} into ${merge.base}`,
      body: null,
      payload: {
        mergeRequest: {
          taskKey: task.key,
          mergeId: merge.id,
          repo: merge.repo,
          base: merge.base,
          ...(merge.failure ? { failure: merge.failure } : {}),
        },
      },
      options: [{ id: 'merge', label: 'Merge', style: 'primary' }],
      state: 'open',
      resolution: null,
      createdAt: nowIso(),
    });
  }

  /**
   * Opens, keeps or cancels the card's merge request the way the server's reconcile does: a request
   * stands while the card is ready to merge and its merger is the one the configuration names.
   */
  private reconcileMerge(task: Task): void {
    const open = task.status !== 'done' && task.status !== 'cancelled';
    const ready = open ? mergeReadiness(this.config, task) : null;
    const merger = cardMerger(this.config, task, null);
    const existing = task.merge;
    if (existing) {
      if (existing.state === 'queued' || existing.state === 'running') return;
      const stays =
        existing.state === 'blocked' &&
        open &&
        task.stageId === this.mergeFrom.get(task.key) &&
        !ready?.ready;
      if (existing.merger === merger && (ready?.ready || stays)) {
        this.notifyMerge(task);
        return;
      }
      this.closeMergeItems(task, existing.id);
      this.writeMerge(task, undefined);
    }
    if (!ready?.ready || !merger || task.merged?.repo === ready.repo.name) return;
    const merge: TaskMergeState = {
      id: mockId('merge'),
      repo: ready.repo.name,
      base: ready.repo.defaultBranch,
      toStageId: ready.target.id,
      merger,
      requestedAt: nowIso(),
      state: 'requested',
      landed: 'nowhere',
      commit: mockCommit(task, 'a1'),
      branch: `${task.key}-work`,
    };
    this.mergeFrom.set(task.key, task.stageId);
    this.writeMerge(task, merge);
    this.addTimeline(task.key, null, 'task_merge_requested', {
      mergeId: merge.id,
      merger,
      repo: merge.repo,
      base: merge.base,
      toStageId: merge.toStageId,
    });
    this.notifyMerge(task);
  }

  /** Reconciles every card (a test or a scenario seeds the requests this way, once the cards are in place). */
  reconcileMerges(): void {
    for (const task of this.tasks) this.reconcileMerge(task);
  }

  /** Chooses how the card's merge ends once it has run its steps (`advanceMerge`). */
  setMergeOutcome(taskKey: string, outcome: MockMergeOutcome): void {
    this.mergeOutcomes.set(taskKey, outcome);
  }

  /** Chooses why a move into the target is refused while the card's work is not merged. */
  setMergeRefusal(taskKey: string, reason: 'not_merged' | 'not_on_remote' | 'engine_unavailable'): void {
    this.mergeRefusals.set(taskKey, reason);
  }

  /** The merge route: only the card's merger starts it; a started merge waits in the queue. */
  private startMerge(taskKey: string, body?: unknown): MockResponse {
    const parsed = StartMergeRequest.safeParse(body ?? {});
    if (!parsed.success) return error(400, 'invalid_request', 'Invalid merge request');
    const options = parsed.data;
    const task = this.findTask(taskKey);
    if (!task) return error(404, 'not_found', 'Unknown task');
    const viewer = memberOf(this.config, this.viewerHandle);
    if (viewer?.kind === 'human' && !hasAccess(viewer.access, 'developer'))
      return error(403, 'insufficient_access', 'Requires developer access');
    this.reconcileMerge(task);
    const merge = task.merge;
    if (options.fixConflict || options.resolution !== undefined) {
      if (!merge || merge.merger !== this.viewerHandle)
        return error(409, 'merge_fix_not_allowed', 'Only the merger may fix conflicts', {
          reason: 'not_merger',
        });
      if (
        (options.fixConflict && options.resolution !== undefined) ||
        (options.fixConflict
          ? merge.state !== 'failed' || merge.failure?.reason !== 'conflict'
          : merge.state !== 'fixing' || !merge.fix)
      )
        return error(409, 'merge_fix_not_allowed', 'The merge is not in the required conflict state', {
          reason: 'not_conflict',
        });
      const ready = mergeReadiness(this.config, task);
      if (!ready.ready)
        return error(409, 'merge_not_ready', 'The card is not ready', { reason: ready.reason });
      if (options.fixConflict) {
        this.mergeFixNotes.delete(taskKey);
        this.writeMerge(task, {
          ...merge,
          state: 'fixing',
          fix: {
            by: this.viewerHandle,
            base: merge.failure!.base,
            branch: `merge-fix/${taskKey}`,
            path: `/mock/worktrees/${this.config.project.key}/_merge-fix/${taskKey}-${merge.repo}`,
            startedAt: nowIso(),
          },
        });
        return ok({ task: clone(task) });
      }
      const reason = this.mergeFixErrors.get(taskKey);
      if (reason) return error(409, 'merge_fix_invalid', 'Invalid committed fix', { reason });
      this.mergeFixNotes.set(taskKey, options.resolution!);
      this.addTimeline(taskKey, this.viewerHandle, 'task_note', { text: options.resolution!, mentions: [] });
    }
    // The fix of a conflict is the merger's tool, not the button (PM-471): the server refuses a start meanwhile.
    if (merge?.state === 'fixing' && options.resolution === undefined)
      return error(409, 'merge_fix_not_allowed', 'Submit the committed fix with resolution', {
        reason: 'not_conflict',
      });
    const merger = merge?.merger ?? cardMerger(this.config, task, null);
    if (!merger || merger !== this.viewerHandle)
      return error(403, 'merge_not_merger', 'Only the card merger may start the merge');
    const ready = mergeReadiness(this.config, task);
    if (!ready.ready)
      return error(409, 'merge_not_ready', 'The card is not ready to merge', { reason: ready.reason });
    if (merge?.state === 'queued' || merge?.state === 'running') return ok({ task: clone(task) });
    if (!merge) return error(409, 'merge_not_ready', 'The card has no work to merge', { reason: 'no_merge' });
    const { block: _block, failure: _failure, ...kept } = merge;
    this.writeMerge(task, {
      ...kept,
      state: 'queued',
      step: 'queued',
      ...(options.resolution !== undefined
        ? { commit: mockCommit(task, 'd4'), branch: merge.fix!.branch }
        : {}),
      startedBy: this.viewerHandle,
      startedAt: nowIso(),
    });
    this.closeMergeItems(task, merge.id, this.viewerHandle);
    return ok({ task: clone(task) });
  }

  private mergeQueueOrder(repo: string): { revision: number; taskKeys: string[] } {
    const keys = this.tasks
      .filter((task) => task.merge?.repo === repo && task.merge.state === 'queued')
      .map((task) => task.key);
    const previous = this.mergeOrders.get(repo);
    if (!previous) {
      const initial = { revision: 0, taskKeys: keys };
      this.mergeOrders.set(repo, initial);
      return initial;
    }
    const taskKeys = [
      ...previous.taskKeys.filter((key) => keys.includes(key)),
      ...keys.filter((key) => !previous.taskKeys.includes(key)),
    ];
    if (canonical(previous.taskKeys) !== canonical(taskKeys)) {
      const updated = { revision: previous.revision + 1, taskKeys };
      this.mergeOrders.set(repo, updated);
      return updated;
    }
    return previous;
  }

  /** The old prioritize operation and the complete permutation use the same order and revision. */
  private prioritizeMerge(taskKey: string, body?: unknown): MockResponse {
    const parsed = PrioritizeMergeRequest.safeParse(body ?? {});
    if (!parsed.success) return error(400, 'invalid_request', 'Invalid prioritize request');
    const task = this.findTask(taskKey);
    if (!task) return error(404, 'not_found', 'Unknown task');
    const viewer = memberOf(this.config, this.viewerHandle);
    if (viewer?.kind === 'human' && !hasAccess(viewer.access, 'developer'))
      return error(403, 'insufficient_access', 'Requires developer access');
    const merge = task.merge;
    const owner = viewer?.kind === 'human' && viewer.access === 'owner';
    if (merge && merge.merger !== this.viewerHandle && !owner)
      return error(403, 'merge_not_merger', 'Only the card merger or an owner may move a merge forward');
    if (!merge || merge.state !== 'queued')
      return error(409, 'merge_not_prioritizable', 'Only a queued merge can be moved forward', {
        reason: !merge ? 'no_merge' : merge.state === 'running' ? 'running' : 'not_queued',
      });
    const order = this.mergeQueueOrder(merge.repo);
    const ahead = order.taskKeys.slice(0, order.taskKeys.indexOf(task.key));
    if (ahead.length === 0) return ok({ task: clone(task), moved: false });
    this.mergeOrders.set(merge.repo, {
      revision: order.revision + 1,
      taskKeys: [task.key, ...order.taskKeys.filter((key) => key !== task.key)],
    });
    this.addTimeline(taskKey, this.viewerHandle, 'task_merge_prioritized', {
      mergeId: merge.id,
      repo: merge.repo,
      reason: parsed.data.reason,
      ahead,
    });
    return ok({ task: clone(task), moved: true });
  }

  /**
   * Moves a card's merge one step on: queued to running, each step of the run, then its end (merged by
   * default; `setMergeOutcome` chooses a conflict, a failed check or a block). Returns the new state.
   */
  advanceMerge(taskKey: string): TaskMergeState | undefined {
    const task = this.findTask(taskKey);
    const merge = task?.merge;
    if (!task || !merge || (merge.state !== 'queued' && merge.state !== 'running')) return merge;
    const outcome = this.mergeOutcomes.get(taskKey) ?? 'merged';
    const repo = this.config.project.repos.find((entry) => entry.name === merge.repo);
    if (merge.state === 'queued') {
      this.writeMerge(task, { ...merge, state: 'running', step: 'merging' });
      return task.merge;
    }
    if (merge.step === 'engine_waiting') return task.merge;
    const step = merge.step === 'queued' || !merge.step ? 'merging' : merge.step;
    if (outcome === 'conflict' && step === 'merging')
      return this.failMerge(task, merge, {
        reason: 'conflict',
        at: nowIso(),
        base: mockCommit(task, 'b2'),
        files: ['src/checkout/cart.ts', 'src/checkout/cart.test.ts'],
      });
    if (outcome === 'check_failed' && step === 'checking')
      return this.failMerge(task, merge, {
        reason: 'check_failed',
        at: nowIso(),
        base: mockCommit(task, 'b2'),
        command: repo?.reviewTest?.command ?? 'npm test',
        outputTail: 'FAIL src/checkout/cart.test.ts\n  expected 3 items, got 2',
      });
    if (outcome === 'blocked' && step === 'pushing') return this.blockMerge(task, merge, 'push_rejected');
    const next = MERGE_STEPS[MERGE_STEPS.indexOf(step) + 1];
    if (next) {
      this.writeMerge(task, {
        ...merge,
        step: next,
        ...(next === 'pushing' && repo?.reviewTest
          ? { check: { command: repo.reviewTest.command, status: 'passed' as const } }
          : {}),
      });
      return task.merge;
    }
    const merged: TaskMerged = {
      ...(this.mergeFixNotes.has(taskKey)
        ? {
            resolution: {
              note: this.mergeFixNotes.get(taskKey)!,
              commit: merge.commit ?? mockCommit(task, 'a1'),
            },
          }
        : {}),
      via: 'tool',
      mergeCommit: mockCommit(task, 'c3'),
      commit: merge.commit ?? mockCommit(task, 'a1'),
      repo: merge.repo,
      base: merge.base,
      at: nowIso(),
      ...(merge.startedBy ? { by: merge.startedBy } : {}),
      ...(merge.check ? { check: merge.check } : {}),
      ...(repo?.github ? { pushed: { remote: 'origin' } } : {}),
    };
    this.closeMergeItems(task, merge.id);
    this.writeMerge(task, undefined, merged);
    this.addTimeline(task.key, merge.startedBy ?? null, 'task_merged', { ...merged, mergeId: merge.id });
    this.mergeFixNotes.delete(taskKey);
    return undefined;
  }

  /** Runs a queued or running merge to its end. */
  runMerge(taskKey: string): void {
    for (let step = 0; step < MERGE_STEPS.length + 3; step += 1) {
      const state = this.findTask(taskKey)?.merge?.state;
      if (state !== 'queued' && state !== 'running') return;
      this.advanceMerge(taskKey);
    }
  }

  /** A merge that failed: the conflict or the check, kept on the card, the merger asked again. */
  private failMerge(task: Task, merge: TaskMergeState, failure: MergeFailure): TaskMergeState {
    const { block: _block, ...kept } = merge;
    this.writeMerge(task, { ...kept, state: 'failed', step: undefined, failure });
    this.addTimeline(task.key, null, 'task_merge_failed', { ...failure, mergeId: merge.id });
    this.notifyMerge(task);
    return task.merge!;
  }

  /** A merge that could not go on: a human merger gets an alert with a retry. */
  private blockMerge(task: Task, merge: TaskMergeState, reason: MergeBlockReason): TaskMergeState {
    const message = 'The push to the remote was rejected.';
    const { failure: _failure, ...kept } = merge;
    this.writeMerge(task, {
      ...kept,
      state: 'blocked',
      step: undefined,
      block: { reason, message, at: nowIso() },
    });
    this.addTimeline(task.key, null, 'task_merge_blocked', {
      mergeId: merge.id,
      repo: merge.repo,
      base: merge.base,
      reason,
      message,
      landed: merge.landed,
    });
    if (memberOf(this.config, merge.merger)?.kind === 'human')
      this.upsertInbox({
        id: mockId('inb'),
        projectKey: task.projectKey,
        kind: 'alert',
        assignees: [merge.merger],
        source: 'system',
        sessionId: null,
        taskKey: task.key,
        title: message,
        body: null,
        payload: { alert: 'merge_blocked', taskKey: task.key, mergeId: merge.id, reason, message },
        options: [ALERT_SEEN_OPTION],
        state: 'open',
        resolution: null,
        createdAt: nowIso(),
      });
    return task.merge!;
  }

  /**
   * The gate of a move into the merge target: the work has to be merged first. The refusal names the
   * merger and the branch, and opens the card's merge request as the server's gate does.
   */
  private mergeGate(task: Task, stageId: string, labels: string[] = task.labels): MockResponse | null {
    // Only when the move's own gates hold (PM-484): a missing approval is asked for first, as the server does.
    const due = moveMerge(this.config, { ...task, labels }, task.stageId, stageId);
    if (due.kind !== 'due') return null;
    const repo = due.repo;
    if (task.merged?.repo === repo.name) return null;
    this.reconcileMerge(task);
    return error(409, 'task_not_merged', 'The approved commit is not on the default branch', {
      reason: this.mergeRefusals.get(task.key) ?? 'not_merged',
      merger: cardMerger(this.config, task, null),
      base: repo.defaultBranch,
    });
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
      else if (failure.code === 'task_not_merged')
        items.push({
          taskKey: card.key,
          outcome: 'blocked',
          code: 'task_not_merged',
          message: 'The approved commit is not on the default branch',
          unmet: [],
          approvals: [],
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
    // The merge that follows the approval (PM-484), so that the request can say who merges and into what.
    const afterGates = moveMerge(this.config, task, task.stageId, target.id);
    const merger = afterGates.kind === 'after_gates' ? cardMerger(this.config, task, null) : null;
    const merge =
      afterGates.kind === 'after_gates' && merger ? { merger, base: afterGates.repo.defaultBranch } : null;
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
        ...(merge ? { merge } : {}),
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
    extra: Pick<TimelineEventData['task_stage_changed'], 'approvedBy' | 'inboxItemIds' | 'partsClosed'>,
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
    if (this.mergeGate(task, target.id)) {
      this.settleWaiting(task, by, { gateBlocked: { to: target.id, reason: 'task_not_merged' } });
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
          mayCancel: lifecycleAllowed(this.config, { kind: 'human', handle: this.viewerHandle }, 'cancel'),
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
    if (input.complexity !== undefined) {
      if (!canSetComplexity(this.config, this.viewerHandle))
        return error(403, 'complexity_forbidden', 'Cannot set complexity');
      if (input.kind === 'theme') return error(400, 'task_is_theme', 'A theme has no complexity');
      if (input.complexity.points !== null && !isComplexityPoints(input.complexity.points))
        return error(422, 'complexity_points_invalid', 'Invalid points');
    }
    if (this.integratorMode && input.importedAt !== undefined)
      return error(403, 'owner_approval_required', 'Historical human attribution requires an own login');
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
      ...(input.complexity && isComplexityPoints(input.complexity.points)
        ? {
            complexity: {
              points: input.complexity.points,
              reason: input.complexity.reason?.trim() || null,
              setBy: this.viewerHandle,
              setAt: nowIso(),
            },
          }
        : {}),
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
    if (task.complexity)
      this.addTimeline(task.key, this.viewerHandle, 'task_complexity_changed', {
        points: task.complexity.points,
        reason: task.complexity.reason,
        previous: null,
      });
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
      // The shared choice respects limits, load and the recorded override decision.
      const pick = this.pickAutomatic(task, workStage, developers);
      if (pick.kind === 'senior_busy') return this.waitForSenior(task, workStage, pick.seniors);
      if (pick.kind === 'member') assignee = pick.handle;
      if (pick.kind === 'none') assignee = humanStageOwner(this.config, eligible)?.handle ?? null;
      if (
        task.complexity &&
        reachingDevelopers(stageDevelopers(this.config, workStage), complexityOf(task), task.labels)
          .length === 0
      )
        this.addTimeline(task.key, null, 'task_senior_wait', {
          phase: 'no_senior',
          points: task.complexity.points,
        });
    }
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
      member.kind === 'ai' &&
      eligible.has(member.handle) &&
      this.memberLoad(member.handle) < member.capacity &&
      !this.providerPaused(member)
        ? [
            {
              handle: member.handle,
              limit: complexityLimitOf(this.config, member),
              specialtyLabels: member.specialtyLabels,
              temp: !!member.temp,
              load: this.memberLoad(member.handle),
              index,
            },
          ]
        : [],
    );
    return chooseDeveloper({
      points: complexityOf(task),
      labels: task.labels,
      anyDecided: this.seniorWaits.get(task.key)?.decision?.decision === 'any',
      reaching: reachingDevelopers(stageDevelopers(this.config, workStage), complexityOf(task), task.labels),
      free,
      tempMaxPoints: tempMaxPointsOf(this.config),
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
          reason: task.complexity?.reason ?? null,
          ...(task.complexity ? { points: task.complexity.points } : {}),
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
      else if (task.assignee) {
        const member = memberOf(this.config, task.assignee);
        ended =
          member?.kind === 'ai' &&
          task.complexity &&
          complexityLimitOf(this.config, member) >= task.complexity.points
            ? 'senior'
            : 'ended';
      } else if (!task.complexity) ended = 'ended';
      else if (
        reachingDevelopers(stageDevelopers(this.config, stage), complexityOf(task), task.labels).length === 0
      )
        ended = 'ended';
      if (ended) {
        const wasWaiting = task?.startWaiting?.reason === 'senior_busy';
        this.endSeniorWait(taskKey, wait, ended === 'senior');
        // Retry the shared selection after the reason for this wait disappears.
        if (task && !task.assignee && wasWaiting && stage?.kind === 'work') {
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
    if (hasOperatorWaiverField(body))
      return error(403, 'owner_approval_required', 'Use the dedicated owner waiver endpoint');
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
      machineAccess: false,
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

  /** Renames an AI member (PM-1026): the same refusals as the server, the configuration through the shared rule. */
  private renameMember(handle: string, body: unknown): MockResponse {
    if (this.viewerAccess() !== 'owner' || this.integratorMode)
      return error(403, 'insufficient_access', 'Owner login required');
    const input = parseBody(RenameMemberRequest, body);
    if (!input) return error(400, 'invalid_request', 'Invalid handle');
    const member = this.findMember(handle);
    const config = memberOf(this.config, handle);
    if (!member || !config || member.status === 'retired') return error(404, 'not_found', 'Unknown member');
    if (config.kind !== 'ai') return error(400, 'not_ai_member', 'Only AI members can be renamed');
    const to = input.handle;
    const former = this.members.flatMap((entry) => entry.formerHandles ?? []);
    if (to === handle || this.takenHandles().has(to) || former.includes(to))
      return error(409, 'handle_taken', 'Handle already used');
    if (
      config.email?.enabled &&
      emailMailboxTaken([this.config, ...this.email.otherProjects], this.config.project.key, handle, to)
    )
      return error(409, 'email_mailbox_taken', 'The mailbox name is taken', { mailbox: to });
    if (this.sessions.some((s) => s.member === handle && s.state !== 'exited' && s.state !== 'failed'))
      return error(409, 'member_session_live', `${handle} is working`, { reason: 'session', member: handle });

    const next = renameMemberInConfig(this.config, handle, to);
    const failure = this.configChangeFailure(next);
    if (failure) return failure;
    this.config = next;
    member.handle = to;
    member.formerHandles = [...(member.formerHandles ?? []), handle];
    for (const task of this.tasks) if (task.assignee === handle) task.assignee = to;
    for (const session of this.sessions) if (session.member === handle) session.member = to;
    this.addTimeline(null, this.owner, 'member_renamed', { from: handle, to, version: this.configVersion });
    this.commitConfig(`Rename ${handle} to ${to}`);
    this.emit({ type: 'member_changed', projectKey: fixtures.PROJECT_KEY, handle, member: null });
    this.memberChanged(to);
    return ok(this.viewOf(member));
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
    const target = input.handoverTo ? this.findMember(input.handoverTo) : undefined;
    const next = clone(this.config);
    next.team.members = next.team.members.filter((m) => m.handle !== handle);
    next.team.contacts = (next.team.contacts ?? []).filter((contact) => contact !== handle);
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
    // A retired member is no contact any more (PM-985).
    const wasContact = (this.config.team.contacts ?? []).includes(handle);
    this.config.team.contacts = (this.config.team.contacts ?? []).filter((contact) => contact !== handle);
    this.addTimeline(null, this.owner, 'member_retired', { handle, handoverTo: target?.handle ?? null });
    if (wasContact)
      this.addTimeline(null, this.owner, 'team_contact_changed', {
        handle,
        contact: false,
        version: this.configVersion,
      });
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
    return this.memberHolders(handle).length;
  }

  /** What takes the member's places (PM-297): one element per task, one per other live session. */
  private memberHolders(handle: string): CapacityHolder[] {
    const holders: CapacityHolder[] = [];
    const ofTask = new Map<string, CapacityHolder>();
    for (const s of this.sessions) {
      if (s.member !== handle || !this.isLive(s)) continue;
      const working = isSessionAtWork(s, {
        awaitsFirstTurn: false,
        pendingInput: false,
        messageOnItsWay: false,
      });
      if (s.workItem.type !== 'task') {
        holders.push({
          kind: s.workItem.type,
          sessionId: s.id,
          working,
          startedAt: s.startedAt,
          lastActivityAt: s.lastActivityAt,
        });
        continue;
      }
      const task = this.findTask(s.workItem.taskKey);
      if (!task || !isOpenTask(task) || !isWorkingOnTask(this.config, task, handle, s.state)) continue;
      const held = ofTask.get(task.key);
      if (!held) {
        const holder: CapacityHolder = {
          kind: 'task',
          taskKey: task.key,
          sessionId: s.id,
          working,
          startedAt: s.startedAt,
          lastActivityAt: s.lastActivityAt,
        };
        ofTask.set(task.key, holder);
        holders.push(holder);
        continue;
      }
      held.working ||= working;
      if (s.lastActivityAt > held.lastActivityAt) {
        held.lastActivityAt = s.lastActivityAt;
        held.sessionId = s.id;
      }
    }
    return holders;
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
    if (planUsagePause(provider, plan, limits.pauseAbovePlanUsagePercent)) return 'plan_usage_paused';
    return null;
  }

  /** Whether the member's provider is over the plan usage limit: the automatic choice leaves them out (PM-1051). */
  private providerPaused(member: AiMemberConfig): boolean {
    const provider = member.provider ?? DEFAULT_AGENT_PROVIDER;
    return !!planUsagePause(
      provider,
      this.planUsageFor(provider),
      this.config.team.limits.pauseAbovePlanUsagePercent,
    );
  }

  /**
   * The same-role collision a message from the viewer would cause on an open card, from the mock's own
   * sessions, or null; the rule itself is the shared `cardBusyGroups`. The Operator and the project
   * manager never count.
   */
  private cardBusyOf(taskKey: string | undefined, to: readonly string[]): CardBusyDetails | null {
    const task = taskKey ? this.findTask(taskKey) : undefined;
    if (!task || !isOpenTask(task) || isTheme(task)) return null;
    const stage = stageOf(this.config, task.stageId);
    const workers = cardWorkerSessions(
      stage && { kind: stage.kind, owners: stageOwners(this.config, stage) },
      task,
      this.sessions,
    );
    const aiOf = (handle: string) => {
      const member = memberOf(this.config, handle);
      if (member?.kind !== 'ai') return null;
      const { role } = member;
      return isProjectManager(member) ? null : { handle, role };
    };
    const working = workers.flatMap((session) => {
      const member = aiOf(session.member);
      return member && member.handle !== this.viewerHandle ? [{ ...member, state: session.state }] : [];
    });
    const joining = teamRecipients(this.viewerHandle, to).flatMap((handle) => {
      const member = aiOf(handle);
      return member && !workers.some((session) => session.member === handle) ? [member] : [];
    });
    const groups = cardBusyGroups({ working, joining });
    return groups.length > 0 ? { taskKey: task.key, groups } : null;
  }

  private humanTeamMessage(body: unknown): MockResponse {
    const viewer = this.findMember(this.viewerHandle);
    if (!viewer || viewer.kind !== 'human')
      return error(403, 'insufficient_access', 'Developer or client required');
    const input = parseBody(SendTeamMessageRequest, body);
    if (!input) return error(400, 'invalid_request', 'Invalid message');
    // The same rule as the server's (PM-985, PM-1102). A fixture can also mark a viewer by the member's role.
    const recipientRefusal = recipientRefusalForAccess(
      this.config,
      viewer.role === 'viewer' ? 'viewer' : accessOfHandle(this.config, this.viewerHandle),
      input.to,
    );
    if (recipientRefusal)
      return error(
        403,
        recipientRefusal.code,
        recipientRefusal.code === 'recipient_not_contact'
          ? 'the message goes only to the contacts of the project'
          : 'Developer or client access required',
        { recipients: recipientRefusal.recipients },
      );
    if (input.taskKey) {
      if (!this.findTask(input.taskKey)) return error(404, 'not_found', 'Unknown task');
    }
    const ids = input.attachmentIds ?? [];
    const attached = ids.map((id) => this.messageAttachments.find((file) => file.id === id));
    if (
      attached.some(
        (file) =>
          !file ||
          file.messageId ||
          file.uploadedBy.kind !== 'human' ||
          file.uploadedBy.handle !== this.viewerHandle,
      )
    )
      return error(409, 'message_attachment_unavailable', 'Attachment unavailable');
    const refusal = this.teamMessageRefusal(this.viewerHandle, input.to, input.text, ids.length > 0);
    if (refusal) return refusal;
    const busy = input.despiteWorkers ? null : this.cardBusyOf(input.taskKey, input.to);
    if (busy) return error(409, 'card_busy', 'The card already has a worker of the same role', busy);
    // "Igen, intézd" accepts the Operator's open signal with the message itself (PM-476).
    const signal = input.operatorSignal
      ? this.operatorSignals.find((entry) => entry.id === input.operatorSignal)
      : undefined;
    if (input.operatorSignal) {
      if (!signal) return error(404, 'not_found', 'Unknown signal');
      if (signal.state !== 'open')
        return error(409, 'operator_signal_closed', 'The signal is no longer open');
    }
    const message = this.sendTeamMessage(
      this.viewerHandle,
      input.to,
      input.taskKey ?? null,
      input.text,
      undefined,
      undefined,
      undefined,
      attached as MessageAttachmentRef[],
      input.location ? { location: input.location } : undefined,
    );
    for (const file of attached) file!.messageId = message.id;
    if (signal) {
      signal.state = 'accepted';
      signal.decidedBy = this.viewerHandle;
      signal.decidedAt = nowIso();
    }
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

  /**
   * The viewer's corner (PM-434, PM-447, PM-1042): the project manager's state in the server's order of conditions.
   * Every human member has one; a viewer who is not an owner reads and answers only (`readOnly`, no signals and no
   * queue).
   */
  private projectManagerChannel(): MockResponse {
    const viewer = this.findMember(this.viewerHandle);
    if (!viewer || viewer.kind !== 'human') return error(403, 'insufficient_access', 'A member is required');
    const pm = projectManagerOf(this.config);
    const session = pm
      ? this.sessions.find((s) => s.member === pm.handle && s.workItem.type === 'general')
      : undefined;
    const sessionId = session?.id ?? null;
    const readOnly = viewer.role !== 'owner';
    const signals = this.operatorSignals.filter((signal) => !isCoordinatorOnlySignal(signal.kind));
    const rest = {
      requests: clone(this.operatorRequests),
      readOnly,
      signals: readOnly ? [] : clone(signals),
      openSignals: readOnly ? 0 : signals.filter((s) => s.state === 'open' && !s.resolvedAt).length,
      queue: readOnly ? { open: 0, current: null } : this.queueSummary(pm?.handle),
    };
    if (!pm) return ok({ member: null, state: 'missing', sessionId, ...rest });
    const member = { handle: pm.handle, displayName: pm.displayName, onLeave: isOnLeave(pm) };
    if (member.onLeave) return ok({ member, state: 'on_leave', sessionId, ...rest });
    if (this.pauses.isPaused())
      return ok({
        member,
        state: 'waiting',
        waiting: { reason: 'team_paused', since: nowIso() },
        sessionId,
        ...rest,
      });
    if (session?.state === 'starting') return ok({ member, state: 'starting', sessionId, ...rest });
    if (session?.state === 'working' || session?.state === 'waiting_permission')
      return ok({ member, state: 'working', sessionId, ...rest });
    return ok({ member, state: 'available', sessionId, ...rest });
  }

  /** The length of one member's queue and the item it works on, as the corner carries them. */
  private queueSummary(handle: string | undefined): {
    open: number;
    current: { id: string; title: string } | null;
  } {
    const open = handle ? this.openQueueItems(handle) : [];
    const current = open.find((item) => item.state === 'processing');
    return { open: open.length, current: current ? { id: current.id, title: current.title } : null };
  }

  /** The open items of one member, the oldest first (a test fills `queueItems`). */
  private openQueueItems(handle: string): MemberQueueItem[] {
    return this.queueItems
      .filter((item) => item.member === handle && (item.state === 'queued' || item.state === 'processing'))
      .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
  }

  /**
   * The Operator's queue (PM-894), computed from `queueItems`. The closed items are those closed since
   * `closedSince` (default 24 hours), the newest first, at most the limit. Access and the unknown-member
   * answer follow the server.
   */
  private memberQueue(handle: string, query = new URLSearchParams()): MockResponse {
    const viewer = memberOf(this.config, this.viewerHandle);
    if (viewer?.kind === 'human' && !hasAccess(viewer.access, 'developer'))
      return error(403, 'insufficient_access', 'Requires developer access');
    const ai = this.config.team.members.filter((m) => m.kind === 'ai');
    if (!ai.some((m) => m.handle === handle)) return error(404, 'unknown_member', 'Unknown AI member');
    const since = new Date(query.get('closedSince') ?? Date.now() - 24 * 60 * 60_000).getTime();
    const own = this.queueItems.filter((item) => item.member === handle);
    const closed = own
      .filter((item) => item.closedAt !== null && new Date(item.closedAt).getTime() >= since)
      .sort((a, b) => b.closedAt!.localeCompare(a.closedAt!))
      .slice(0, MEMBER_QUEUE_CLOSED_LIMIT);
    return ok({
      member: handle,
      items: clone(this.openQueueItems(handle)),
      closed: clone(closed),
      everQueued: own.length > 0,
    });
  }

  /** "Most ne": only the owner sets an open signal aside; a closed one is a 409 the card shows. */
  private dismissOperatorSignal(id: string): MockResponse {
    const viewer = this.findMember(this.viewerHandle);
    if (viewer?.role !== 'owner') return error(403, 'operator_owner_only', 'Only the owner may decide');
    const signal = this.operatorSignals.find((entry) => entry.id === id);
    if (!signal) return error(404, 'not_found', 'Unknown signal');
    if (signal.state !== 'open') return error(409, 'operator_signal_closed', 'The signal is no longer open');
    signal.state = 'dismissed';
    signal.decidedBy = viewer.handle;
    signal.decidedAt = nowIso();
    return ok(clone(signal));
  }

  /**
   * An Operator proposal decided in the inbox. Approving after the configuration moved on makes the item stale
   * (the server's 409 `operator_approval_stale`, the card then offers only "Rendben"); "dismiss" closes a stale one.
   */
  private resolveOperatorApproval(
    item: InboxItem,
    payload: OperatorApprovalPayload,
    optionId: string,
    by: string,
  ): MockResponse {
    const step = this.operatorRequests
      .flatMap((request) => request.steps)
      .find((candidate) => candidate.id === payload.stepId);
    if (step && step.status !== 'awaiting_approval' && !payload.stale)
      return error(409, 'operator_approval_used', 'The proposal has already been consumed');
    const expired = !!payload.expiresAt && Date.parse(payload.expiresAt) <= Date.now();
    if (
      optionId === 'approve' &&
      (payload.stale ||
        expired ||
        (payload.baseVersion !== null && payload.baseVersion !== this.configVersion))
    ) {
      this.upsertInbox({
        ...item,
        options: [OPERATOR_DISMISS_OPTION],
        payload: {
          ...item.payload,
          operator: {
            ...payload,
            stale: payload.stale ?? { reason: expired ? 'expired' : 'config_changed', at: nowIso() },
          },
        },
      });
      if (step) step.status = 'stale';
      return error(409, 'operator_approval_stale', 'The proposal is out of date');
    }
    if (step)
      step.status = optionId === 'approve' ? 'approved' : optionId === 'reject' ? 'rejected' : 'stale';
    const resolved: InboxItem = {
      ...item,
      state: 'resolved',
      resolution: { optionId, by, at: nowIso(), note: null },
    };
    this.upsertInbox(resolved);
    return ok(clone(resolved));
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

  /** The project's pause routes (PM-219): every member reads it, an owner or an admin changes it. */
  private projectPause(method: string, rest: string): MockResponse {
    if (method === 'GET') return ok(this.pauses.projectView());
    if (!this.pauses.mayManageProject()) return error(403, 'insufficient_access', 'Admin access required');
    if (rest === '/pause/resume') this.pauses.resume('project');
    else if (rest === '/pause/force') this.pauses.force('project');
    else this.pauses.pauseProject();
    return ok(this.pauses.projectView());
  }

  /** The instance's pause routes: the host owner changes it, with or without a project membership. */
  private instancePause(method: string, path: string): MockResponse {
    const viewer = this.findMember(this.viewerHandle);
    if (!viewer && !this.isHostOwner()) return error(403, 'insufficient_access', 'Membership required');
    if (method === 'POST') {
      if (!this.pauses.instanceView().canManage)
        return error(403, 'insufficient_access', 'Only the host owner may pause the instance');
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

  /**
   * The questions the Operator screened (PM-556), for an owner or an admin: those it still holds, and those it
   * settled itself (answered, forwarded, or found moot) since the given time, newest first, at most 20.
   */
  private screenedQuestions(query: URLSearchParams): MockResponse {
    if (!['owner', 'admin'].includes(this.viewerAccess()))
      return error(403, 'insufficient_access', 'Only an admin sees what the Operator screened');
    const since = query.get('since');
    if (!since || Number.isNaN(Date.parse(since))) return error(400, 'invalid_request', 'Invalid since');
    const settled = (item: InboxItem): boolean => {
      if (item.kind !== 'question') return false;
      const screening = questionPayloadOf(item)?.screening;
      if (!screening) return false;
      if (item.state === 'screening') return true;
      return (
        screening.outcome === 'answered' ||
        screening.outcome === 'forwarded' ||
        item.resolution?.rule === 'operator_moot'
      );
    };
    const timeOf = (item: InboxItem) => item.resolution?.at ?? item.createdAt;
    const all = this.inbox
      .filter((item) => settled(item) && Date.parse(timeOf(item)) >= Date.parse(since))
      .sort((a, b) => timeOf(b).localeCompare(timeOf(a)));
    return ok({ items: clone(all.slice(0, 20)), today: all.length });
  }

  private resolve(itemId: string, body: unknown): MockResponse {
    this.sweepIntegratorTodos(nowIso());
    const pending = this.inbox.find((item) => item.id === itemId);
    if (pending && isIntegratorTodo(pending) && (this.integratorMode || this.viewerAccess() !== 'owner'))
      return error(403, 'super_relay_refused', 'Use the dedicated super endpoint or the owner login');
    if (this.integratorMode && pending && !['question', 'alert'].includes(pending.kind)) {
      const verdict = superAccessVerdict(this.config, {
        mode: this.integratorMode,
        operation: 'approval',
        ownerMembership: this.viewerAccess() === 'owner',
      });
      if (!verdict.allowed) return error(403, verdict.code, 'A human decision is required');
    }
    const input = parseBody(ResolveInboxRequest, body);
    const item = this.inbox.find((entry) => entry.id === itemId);
    if (!input) return error(400, 'invalid_request', 'Invalid inbox resolution');
    if (!item || !canSeeInboxItem(this.taskViewer(), item))
      return error(404, 'not_found', 'Unknown inbox item');
    if (input.attachmentIds !== undefined && item.kind !== 'question')
      return error(400, 'invalid_request', 'Only questions accept attachmentIds', { field: 'attachmentIds' });
    if (item.state !== 'open') return error(409, 'inbox_item_closed', 'Already resolved');
    let relayed = false;
    if (this.integratorMode === 'super') {
      const group = questionPayloadOf(item)?.group;
      const members = [
        item,
        ...(group?.itemIds ?? []).flatMap((id) => {
          const row = this.inbox.find((entry) => entry.id === id);
          return row && row.id !== item.id && isPendingQuestion(row) ? [row] : [];
        }),
      ];
      for (const member of members) {
        const refusal = superDecisionRefusal(member, {
          operatorHandle: RETIRED_OPERATOR_HANDLE,
          sessionMember: this.sessions.find((session) => session.id === member.sessionId)?.member,
        });
        const question = member.kind === 'question' ? member.payload : null;
        if (refusal || (question && externalQuestionAnswerRefusal(question, { via: 'integrator' })))
          return error(403, 'owner_approval_required', 'A person must decide this item');
      }
      relayed = members.every(isRelayableQuestionItem);
    }
    if (!item.options.some((option) => option.id === input.optionId)) {
      return error(400, 'unknown_option', `Unknown option ${input.optionId}`);
    }
    const viewer = memberOf(this.config, this.viewerHandle);
    if (viewer?.kind !== 'human') return error(403, 'ai_approval_forbidden', 'Only humans may approve');
    const operatorApproval = operatorApprovalOf(item);
    const knowledge = operatorKnowledgeApprovalOf(item);
    if (knowledge) {
      if (this.viewerAccess() !== 'owner')
        return error(403, 'owner_approval_required', 'Owner login required');
      if (knowledge.applying) return error(409, 'operator_approval_used', 'Proposal is being recorded');
      const reason =
        knowledge.stale?.reason ??
        (knowledge.baseRevision !== this.operatorKnowledge.revision
          ? 'knowledge_changed'
          : knowledge.baseConfigVersion !== null && knowledge.baseConfigVersion !== this.configVersion
            ? 'config_changed'
            : null);
      if (input.optionId === 'approve' && reason) {
        this.upsertInbox({
          ...item,
          options: [OPERATOR_DISMISS_OPTION],
          payload: { ...item.payload, operatorKnowledge: { ...knowledge, stale: { reason, at: nowIso() } } },
        });
        return error(409, 'operator_knowledge_stale', 'Proposal is out of date');
      }
      if (input.optionId === 'approve') {
        const document = this.operatorKnowledge;
        const change = knowledge.change;
        if (change.kind === 'agreement_replace')
          document.agreement = {
            version: (document.agreement?.version ?? 0) + 1,
            data: clone(change.agreement),
            approvedBy: viewer.handle,
            approvedAt: nowIso(),
          };
        else if (change.kind === 'principle_put') {
          const id = change.principle.id ?? mockId('principle');
          document.principles = [
            ...document.principles.filter((entry) => entry.id !== id),
            { ...change.principle, id, approvedBy: viewer.handle, approvedAt: nowIso() },
          ];
        } else document.principles = document.principles.filter((entry) => entry.id !== change.id);
        document.revision++;
        document.appliedProposalIds.push(knowledge.id);
      }
      const step = this.operatorRequests
        .flatMap((request) => request.steps)
        .find((entry) => entry.id === knowledge.stepId);
      if (step)
        step.status =
          input.optionId === 'approve' ? 'approved' : input.optionId === 'reject' ? 'rejected' : 'stale';
      const resolved: InboxItem = {
        ...item,
        state: 'resolved',
        resolution: { optionId: input.optionId, by: viewer.handle, at: nowIso(), note: null },
      };
      this.upsertInbox(resolved);
      return ok(clone(resolved));
    }
    if (operatorApproval) {
      if (!item.assignees.includes(viewer.handle) && viewer.access !== 'owner')
        return error(403, 'not_an_assignee', 'Only assignees may decide');
      return this.resolveOperatorApproval(item, operatorApproval, input.optionId, viewer.handle);
    }
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
    const attached = (input.attachmentIds ?? []).map((id) =>
      this.messageAttachments.find((file) => file.id === id),
    );
    if (
      attached.some(
        (file) =>
          !file ||
          file.projectKey !== item.projectKey ||
          file.messageId ||
          file.uploadedBy.kind !== 'human' ||
          file.uploadedBy.handle !== viewer.handle,
      )
    )
      return error(409, 'message_attachment_unavailable', 'Attachment unavailable');
    if (attached.length && memberOf(this.config, item.source)?.kind !== 'ai')
      return error(400, 'invalid_request', 'Only AI questions accept attachments', {
        field: 'attachmentIds',
      });
    if (item.kind === 'question' && input.optionId === 'answer' && !note && !attached.length) {
      return error(400, 'answer_required', 'A free-text answer needs a note');
    }
    if (item.kind === 'question' && input.optionId === 'todo_cannot' && !note) {
      return error(400, 'todo_reason_required', 'A todo that cannot be done needs a reason');
    }
    if (item.kind === 'hand_on') {
      // Taking the card on is a move under the gates: refused, the item stays open.
      const request = handOnRequestOf(item);
      const task = item.taskKey ? this.findTask(item.taskKey) : undefined;
      if (!request || !task) return error(404, 'not_found', 'Unknown task');
      const unmerged = this.mergeGate(task, request.toStageId);
      if (unmerged) return unmerged;
      const evaluation = evaluateMove(task, this.config, task.stageId, request.toStageId);
      if (evaluation.unmet.length || evaluation.approvals.length) return gateBlockedError(evaluation);
    }
    if (item.kind === 'merge_request') {
      // Resolving the request starts the merge: the same route, the same rules.
      const request = mergeRequestOf(item);
      if (!request) return error(404, 'not_found', 'Unknown merge request');
      const started = this.startMerge(request.taskKey);
      if (started.status >= 400) return started;
    }
    const release = releaseApprovalOf(item);
    if (item.kind === 'release') {
      if (!release || !item.taskKey) return error(404, 'not_found', 'Unknown release');
      // The integrator's key is no approval: the server refuses it the same way.
      if (this.refuseReleaseApproval)
        return error(403, 'owner_approval_required', 'Only an owner decides a release');
    }
    const resolved: InboxItem = {
      ...item,
      state: 'resolved',
      resolution: {
        optionId: input.optionId,
        by: viewer.handle,
        at: nowIso(),
        note,
        ...(this.integratorMode ? { via: 'integrator' as const } : {}),
        ...(this.integratorMode === 'super'
          ? {
              actor: this.viewerActor(),
              ...(relayed ? { ownerAnswerRelayed: true as const } : { superDecision: true as const }),
            }
          : {}),
      },
    };
    this.upsertInbox(resolved);
    if (release && item.taskKey) {
      const approved = input.optionId === 'approve';
      this.addTimeline(
        item.taskKey,
        viewer.handle,
        'release_changed',
        {
          releaseId: release.releaseId,
          state: approved ? 'approved' : 'rejected',
          previousState: 'proposed',
          commit: release.commit,
          ...(!approved && note ? { note } : {}),
        },
        null,
        nowIso(),
        resolved.resolution?.actor,
      );
    }
    const group = questionPayloadOf(item)?.group;
    const groupLive = group ? new Set(questionGroupLiveItemIds(group)) : null;
    if (!groupLive || groupLive.has(item.id)) this.afterResolve(resolved, attached as MessageAttachmentRef[]);
    if (group && group.primaryItemId === item.id) {
      for (const id of group.itemIds.filter((id) => id !== item.id)) {
        const linked = this.inbox.find((entry) => entry.id === id);
        if (!linked || !isPendingQuestion(linked)) continue;
        const next: InboxItem = { ...linked, state: 'resolved', resolution: resolved.resolution };
        this.upsertInbox(next);
        if (groupLive?.has(id)) this.afterResolve(next, attached as MessageAttachmentRef[]);
      }
    }
    return ok(clone(resolved));
  }

  /** What the server does with a decision: record it, answer the asker, apply a gate decision. */
  private afterResolve(item: InboxItem, attachments: MessageAttachmentRef[] = []): void {
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
        resolution.at,
        resolution.actor,
      );
      const question = typeof item.payload.question === 'string' ? item.payload.question : item.title;
      const message = this.sendTeamMessage(
        resolution.actor?.handle ?? resolution.by,
        [item.source],
        item.taskKey,
        answer,
        undefined,
        {
          inboxItemId: item.id,
          question,
          answer,
        },
        undefined,
        attachments,
      );
      for (const attachment of attachments) {
        const stored = this.messageAttachments.find((file) => file.id === attachment.id);
        if (stored) stored.messageId = message.id;
      }
      return;
    }
    if (item.kind === 'hand_on') {
      const request = handOnRequestOf(item);
      const task = item.taskKey ? this.findTask(item.taskKey) : undefined;
      const target = request ? stageOf(this.config, request.toStageId) : undefined;
      if (task && target && task.stageId !== target.id)
        this.applyMove(task, target, resolution.actor ?? { kind: 'human', handle: resolution.by }, {});
      return;
    }
    const gate = item.kind === 'decision' ? gateRequestOf(item) : null;
    if (gate) this.decideGate(item, gate);
  }
}
