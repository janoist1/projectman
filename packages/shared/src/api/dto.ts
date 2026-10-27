import { z } from 'zod';

import { BoardPlacement } from '../domain/board-order';
import { ComplexityPoints, COMPLEXITY_REASON_MAX } from '../domain/complexity';
import { DutyId } from '../domain/duty';
import { EngineId } from '../domain/engine';
import { ChatItem } from '../chat/chat';
import {
  AutoCompactWindowTokens,
  EmailMailbox,
  MemberSchedule,
  ProjectConfig,
  RepoConfig,
} from '../config/schema';
import { ConfigChangeRow } from '../config/operator';
import { canonical } from '../config/canonical';
import { OperatorKnowledgeChange } from '../domain/operator-knowledge';
import {
  RedactionCounts,
  SYSTEM_FEEDBACK_BODY_MAX,
  SYSTEM_FEEDBACK_REASON_MAX,
  SYSTEM_FEEDBACK_TITLE_MAX,
  SystemFeedbackAccess,
  SystemFeedbackForwardingMode,
  SystemFeedbackState,
} from '../domain/system-feedback';
import { OperatorConfigPatch } from '../config/edit';
import { ERROR_CODES } from './error-codes';
import { TaskWait } from '../config/task-wait';
import { Actor, TimelineEvent } from '../domain/event';
import { HandoffStart } from '../domain/handoff';
import { InboxItem, InboxOption } from '../domain/inbox';
import { WorkOutage } from '../domain/outage';

import {
  AgentProvider,
  AgentEffort,
  Approver,
  CheapSubagentModel,
  GithubLogin,
  HumanAccess,
  MemberHandle,
  MemberKind,
  MemberStatus,
  PermissionMode,
  SelectablePermissionMode,
} from '../domain/member';
import { SessionState } from '../domain/session';
import { TeamMessage } from '../domain/message';
import { MAX_MESSAGE_ATTACHMENTS, MessageAttachmentId } from '../domain/message-attachment';
import { LabelDefinition, LabelId } from '../domain/label';
import { PauseRequest, ProjectPauseView } from '../domain/pause';
import { BoardColumn, GateCondition, Stage, StageId } from '../domain/pipeline';
import { BuiltInRoleId, CustomRoleDefinition, RoleBundle, RoleHolders, RoleId } from '../domain/role';
import { ScheduleRun } from '../domain/schedule';
import { Session, TaskWork } from '../domain/session';
import { CardRounds } from '../domain/card-measure';
import { MemberUsage } from '../domain/token-usage';
import { AddRelationRef, RelationsChange } from '../domain/relations';
import { UiLocation } from '../domain/ui-place';
import { CapacityHolder, Task, TaskKey, TaskKind, TaskPriority, TaskStartWaiting } from '../domain/task';

export const ServerVersionView = z.object({
  /** What the server reports: a commit id, dev, or a version override. */
  version: z.string(),
  /** The 40/64-hex commit when version is one; otherwise null. */
  commit: z.string().nullable(),
  /** The release tag of that commit; null when it was not released. */
  tag: z.string().nullable(),
});
export type ServerVersionView = z.infer<typeof ServerVersionView>;

/** Empty starts or retries; fixConflict creates a checkout; resolution submits its committed fix (PM-481). */
export const StartMergeRequest = z.object({
  fixConflict: z.boolean().optional(),
  resolution: z.string().trim().min(1).max(2000).optional(),
});
export type StartMergeRequest = z.infer<typeof StartMergeRequest>;

/** The reason a queued merge is put at the front of the queue, in the person's words (PM-576). */
export const PRIORITIZE_MERGE_REASON_MAX = 500;
export const PrioritizeMergeRequest = z.object({
  reason: z.string().trim().min(1).max(PRIORITIZE_MERGE_REASON_MAX),
});
export type PrioritizeMergeRequest = z.infer<typeof PrioritizeMergeRequest>;

/** A complete permutation of the repository's queued cards, guarded by its revision (PM-759). */
export const OrderMergeQueueRequest = z.strictObject({
  repo: z.string().trim().min(1),
  expectedRevision: z.number().int().nonnegative(),
  taskKeys: z.array(TaskKey),
  reason: z.string().trim().min(1).max(PRIORITIZE_MERGE_REASON_MAX),
});
export type OrderMergeQueueRequest = z.infer<typeof OrderMergeQueueRequest>;
export const MergeQueueOrder = z.object({
  revision: z.number().int().nonnegative(),
  taskKeys: z.array(TaskKey),
});
export type MergeQueueOrder = z.infer<typeof MergeQueueOrder>;

export const CheckOutageResponse = z.object({
  item: InboxItem,
  stillFailing: z.boolean(),
  checkedAt: z.string(),
});
export type CheckOutageResponse = z.infer<typeof CheckOutageResponse>;

export const ProjectManagerChannelState = z.enum([
  'available',
  'starting',
  'working',
  'waiting',
  'on_leave',
  'missing',
]);
export type ProjectManagerChannelState = z.infer<typeof ProjectManagerChannelState>;
export const ProjectManagerChannel = z.object({
  /** Null when the project has no AI project manager (state missing). */
  member: z.object({ handle: MemberHandle, displayName: z.string(), onLeave: z.boolean() }).nullable(),
  state: ProjectManagerChannelState,
  /** Present only while the conversation waits to run. */
  waiting: TaskStartWaiting.optional(),
  /** The general conversation, running or ended; null before its first start. */
  sessionId: z.string().nullable(),
});
export type ProjectManagerChannel = z.infer<typeof ProjectManagerChannel>;

/* ---------- the Operator (PM-447, PM-463) ---------- */

/** What the Operator did on an owner's request; one step per tool call. */
export const OperatorAction = z.enum([
  'task_create',
  'task_update',
  'task_move',
  'task_labels',
  'task_priority',
  'task_start',
  'message',
  'config_change',
  'member_change',
  'member_hire',
  'member_retire',
  'member_rename',
  'config_revert',
  'session_stop',
  'project_pause',
  'project_resume',
  'docs_write',
  'decision_offer',
  'knowledge_change',
  'structural_review',
  'super_handoff',
  'operation',
  'system_feedback',
]);
export type OperatorAction = z.infer<typeof OperatorAction>;
export const OperatorStepStatus = z.enum([
  'done',
  'queued',
  'awaiting_approval',
  'approved',
  'rejected',
  'stale',
  'refused',
]);
export type OperatorStepStatus = z.infer<typeof OperatorStepStatus>;
export const OperatorStep = z.object({
  agreementVersion: z.number().int().positive().nullable().optional(),
  approvalMode: z.enum(['click', 'waived']).nullable().optional(),
  id: z.string(),
  requestId: z.string(),
  at: z.string(),
  action: OperatorAction,
  status: OperatorStepStatus,
  taskKey: TaskKey.nullable(),
  member: MemberHandle.nullable(),
  changes: z.array(ConfigChangeRow),
  configVersion: z.string().nullable(),
  inboxItemId: z.string().nullable(),
  /** The system signal the Operator acted on without an owner's request (PM-545). */
  signalId: z.string().nullable(),
  /** The super operation an `operation` step started on the shared path (PM-888). */
  operationId: z.string().nullable().optional(),
  /** The system feedback a `system_feedback` step recorded; `occurrence` 1 is a new item, more a known gap seen again (PM-472). */
  systemFeedback: z
    .object({ id: z.string(), title: z.string(), occurrence: z.number().int() })
    .nullable()
    .optional(),
  refusal: z.object({ code: z.enum(ERROR_CODES), message: z.string() }).nullable(),
});
export type OperatorStep = z.infer<typeof OperatorStep>;
export const OperatorRequestView = z.object({
  id: z.string(),
  messageId: z.string().nullable(),
  quote: z.string(),
  openedAt: z.string(),
  closedAt: z.string().nullable(),
  steps: z.array(OperatorStep),
});
export type OperatorRequestView = z.infer<typeof OperatorRequestView>;
export const OPERATOR_SIGNAL_WAKE_INTERVAL_MS = 15 * 60_000;
/** An answer delivered to a member who has not worked since is a stall once it has stood this long (PM-694). */
export const OPERATOR_ANSWER_STALL_GRACE_MS = 120_000;
/** The least time between two wake-ups carrying `answer_stalled` signals in one project (PM-694). */
export const OPERATOR_ANSWER_STALL_WAKE_MS = 60_000;
export const OPERATOR_SILENT_WORK_MINUTES = 30;
/** A card held by an AI member with no work running for this long is idle (PM-547). */
export const OPERATOR_IDLE_MINUTES = 30;
/** A merge the merger has not started for this long is waiting. */
export const OPERATOR_MERGE_WAIT_MINUTES = 30;
/** Work merged and not released for this long is waiting for a release. */
export const OPERATOR_UNRELEASED_HOURS = 24;
/** Startable cards and free capacity together for this long wake the Operator. */
export const OPERATOR_READY_WAITING_MINUTES = 30;
export const OperatorSignalKind = z.enum([
  'loop_suspected',
  'process_cleanup_failed',
  'outage',
  'nobody',
  'stalled',
  'silent',
  'idle',
  'merge_waiting',
  'merge_blocked',
  'unreleased',
  'ready_waiting',
  'answer_stalled',
  'structural_pattern',
  'milestone_closed',
  'refinement_stalled',
]);
export type OperatorSignalKind = z.infer<typeof OperatorSignalKind>;
/**
 * The facts of a `refinement_stalled` signal (PM-702): the recorded turn, the member's latest session and the
 * open question ids of the card; never a transcript or tool input.
 */
export const RefinementStallFacts = z.object({
  label: z.string(),
  member: MemberHandle,
  turnAt: z.string().datetime(),
  session: z
    .object({
      id: z.string(),
      state: SessionState,
      lastActivityAt: z.string().datetime(),
    })
    .nullable(),
  openQuestionIds: z.array(z.string()),
});
export type RefinementStallFacts = z.infer<typeof RefinementStallFacts>;
/** The facts of an `answer_stalled` signal (PM-694): the evidence is a delivered answer or message, never its text. */
export const AnswerStalledFacts = z.object({
  evidenceId: z.string(),
  evidenceAt: z.string().datetime(),
  member: MemberHandle,
  lastActionAt: z.string().datetime().nullable(),
});
export type AnswerStalledFacts = z.infer<typeof AnswerStalledFacts>;
export const OperatorSignalState = z.enum(['pending', 'open', 'accepted', 'dismissed', 'resolved']);
export type OperatorSignalState = z.infer<typeof OperatorSignalState>;
export const OperatorSignal = z.object({
  id: z.string(),
  deliveredTo: MemberHandle.nullable().optional(),
  kind: OperatorSignalKind,
  state: OperatorSignalState,
  actionable: z.boolean(),
  taskKey: TaskKey.nullable(),
  subject: z.string().nullable(),
  inboxItemId: z.string().nullable(),
  messageId: z.string().nullable(),
  raisedAt: z.string(),
  decidedBy: MemberHandle.nullable(),
  decidedAt: z.string().nullable(),
  resolvedAt: z.string().nullable(),
});
export type OperatorSignal = z.infer<typeof OperatorSignal>;
/**
 * The viewer's conversation with the project manager in the top right corner (PM-1042), plus the last 50
 * requests (the newest last). `readOnly` (PM-475, decision 59): the conversation is with a person who is not an
 * owner, so the project manager only reads and answers (and the owners' system signals stay out of it).
 */
export const ProjectManagerCorner = ProjectManagerChannel.extend({
  requests: z.array(OperatorRequestView),
  readOnly: z.boolean(),
  signals: z.array(OperatorSignal),
  openSignals: z.number().int(),
  /** The project manager's member queue (PM-894): the open items and the one being processed. */
  queue: z.object({
    open: z.number().int().min(0),
    current: z.object({ id: z.string(), title: z.string() }).nullable(),
  }),
});
export type ProjectManagerCorner = z.infer<typeof ProjectManagerCorner>;
/** The corner's shape under its old name, until the Operator leaves the app (PM-1045). */
export const OperatorChannel = ProjectManagerCorner;
export type OperatorChannel = ProjectManagerCorner;

/* ---------- auth ---------- */

export const StopSessionRequest = z.object({
  note: z.string().trim().min(1).max(200).optional(),
  purpose: z.literal('assignee_change').optional(),
});
export type StopSessionRequest = z.infer<typeof StopSessionRequest>;

export const InvolvementQuery = z.object({
  member: MemberHandle.optional(),
  by: z.string().min(1).max(32).optional(),
  task: TaskKey.optional(),
  since: z.string().datetime().optional(),
  kind: z.enum(['started', 'stopped']).optional(),
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type InvolvementQuery = z.infer<typeof InvolvementQuery>;
export const InvolvementItem = z.object({ event: TimelineEvent, taskTitle: z.string().nullable() });
export type InvolvementItem = z.infer<typeof InvolvementItem>;
export const InvolvementsResponse = z.object({
  items: z.array(InvolvementItem),
  counts: z.object({ started: z.number().int(), stopped: z.number().int() }),
  nextBefore: z.string().nullable(),
});
export type InvolvementsResponse = z.infer<typeof InvolvementsResponse>;

export const IntegratorKeyState = z.enum(['active', 'expired', 'revoked']);
export const IntegratorKeyInfo = z.object({
  prefix: z.string(),
  state: IntegratorKeyState,
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export type IntegratorKeyInfo = z.infer<typeof IntegratorKeyInfo>;
export const IntegratorKeyMode = z.enum(['legacy', 'super', 'read']);
export type IntegratorKeyMode = z.infer<typeof IntegratorKeyMode>;
export const IntegratorChannel = z.enum(['mcp', 'cli', 'rest']);
export type IntegratorChannel = z.infer<typeof IntegratorChannel>;
export const IntegratorAccessKeyInfo = IntegratorKeyInfo.extend({
  id: z.string(),
  mode: IntegratorKeyMode,
  lastUsedChannel: IntegratorChannel.nullable(),
});
export type IntegratorAccessKeyInfo = z.infer<typeof IntegratorAccessKeyInfo>;
export const IntegratorAccessKeysResponse = z.object({ keys: z.array(IntegratorAccessKeyInfo) });
export type IntegratorAccessKeysResponse = z.infer<typeof IntegratorAccessKeysResponse>;
export const IntegratorAccessKeyResponse = z.object({ key: IntegratorAccessKeyInfo });
export type IntegratorAccessKeyResponse = z.infer<typeof IntegratorAccessKeyResponse>;
export const CreateIntegratorAccessKeyRequest = z.object({
  mode: z.enum(['super', 'read']),
  expiresInDays: z.union([z.literal(1), z.literal(7), z.literal(30), z.literal(365), z.null()]).default(7),
});
export type CreateIntegratorAccessKeyRequest = z.infer<typeof CreateIntegratorAccessKeyRequest>;
export const CreatedIntegratorAccessKey = z.object({ key: IntegratorAccessKeyInfo, secret: z.string() });
export type CreatedIntegratorAccessKey = z.infer<typeof CreatedIntegratorAccessKey>;
export const IntegratorKeyAuditEntry = z.object({
  seq: z.number().int().positive(),
  keyId: z.string(),
  action: z.enum(['created', 'revoked']),
  prefix: z.string(),
  mode: IntegratorKeyMode,
  at: z.string(),
});
export type IntegratorKeyAuditEntry = z.infer<typeof IntegratorKeyAuditEntry>;
export const IntegratorKeyAuditQuery = z.object({
  before: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type IntegratorKeyAuditQuery = z.infer<typeof IntegratorKeyAuditQuery>;
export const IntegratorKeyAuditPage = z.object({
  entries: z.array(IntegratorKeyAuditEntry),
  nextBefore: z.number().int().positive().nullable(),
});
export type IntegratorKeyAuditPage = z.infer<typeof IntegratorKeyAuditPage>;

/** How long the owner's grant for machine operations lasts (PM-881); `until_revoked` has no end. */
export const OPERATOR_GRANT_DURATIONS = ['until_revoked', '12h', '7d'] as const;
export const OperatorGrantDuration = z.enum(OPERATOR_GRANT_DURATIONS);
export type OperatorGrantDuration = z.infer<typeof OperatorGrantDuration>;
export const OperatorGrantState = z.object({
  active: z.boolean(),
  grantId: z.string().nullable(),
  grantedAt: z.string().nullable(),
  /** The name of the owner who granted it. */
  grantedBy: z.string().nullable(),
  /** Null: until revoked, or there is no active grant. */
  expiresAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  /** The viewer is the host owner with their own login. */
  canManage: z.boolean(),
});
export type OperatorGrantState = z.infer<typeof OperatorGrantState>;
export const OperatorGrantResponse = z.object({ grant: OperatorGrantState });
export type OperatorGrantResponse = z.infer<typeof OperatorGrantResponse>;
export const CreateOperatorGrantRequest = z.object({
  duration: OperatorGrantDuration.default('until_revoked'),
});
export type CreateOperatorGrantRequest = z.infer<typeof CreateOperatorGrantRequest>;
export const OperatorGrantAuditEntry = z.object({
  grantId: z.string(),
  action: z.enum(['granted', 'revoked', 'replaced', 'expired']),
  at: z.string(),
  expiresAt: z.string().nullable(),
  /** Who granted or revoked it; for `expired`, who granted it. */
  by: z.string(),
});
export type OperatorGrantAuditEntry = z.infer<typeof OperatorGrantAuditEntry>;
/** Newest first, at most 100. */
export const OperatorGrantAuditPage = z.object({ entries: z.array(OperatorGrantAuditEntry) });
export type OperatorGrantAuditPage = z.infer<typeof OperatorGrantAuditPage>;

export const SetupRequest = z.object({
  name: z.string().min(1),
  email: z.string().min(3),
  password: z.string().min(8),
  /** The one-time code the cloud server logs at start (PM-317); only a non-local request needs it. */
  setupCode: z.string().optional(),
});
export type SetupRequest = z.infer<typeof SetupRequest>;

export const LoginRequest = z.object({ email: z.string().min(3), password: z.string().min(1) });
export type LoginRequest = z.infer<typeof LoginRequest>;

/* ---------- e-mail login of invited clients (PM-670) ---------- */

const LoginEmail = z.string().trim().min(3).max(254);
const InviteToken = z.string().min(1).max(200);
/** The digits of the one-time code; the code form shows and checks the same number. */
export const EMAIL_LOGIN_CODE_LENGTH = 6;
export const LoginCode = z.string().regex(new RegExp(`^\\d{${EMAIL_LOGIN_CODE_LENGTH}}$`));
const NewAccountName = z.string().trim().min(1).max(100);

/** Asks for a code by the address, or by an invitation token (the code goes to the invited address). */
export const EmailLoginCodeRequest = z.union([
  z.object({ email: LoginEmail }).strict(),
  z.object({ inviteToken: InviteToken }).strict(),
]);
export type EmailLoginCodeRequest = z.infer<typeof EmailLoginCodeRequest>;

/** The answer of a code request: always 202 and always this body, whoever the address belongs to. */
export const EmailLoginCodeRequested = z.object({
  expiresInSeconds: z.literal(600),
  resendAfterSeconds: z.literal(60),
});
export type EmailLoginCodeRequested = z.infer<typeof EmailLoginCodeRequested>;

/** `name` is needed only for a new account whose invitation has no display name. */
export const EmailLoginVerifyRequest = z.union([
  z.object({ email: LoginEmail, code: LoginCode, name: NewAccountName.optional() }).strict(),
  z.object({ inviteToken: InviteToken, code: LoginCode, name: NewAccountName.optional() }).strict(),
]);
export type EmailLoginVerifyRequest = z.infer<typeof EmailLoginVerifyRequest>;

/** `details` of `email_login_rate_limited`. */
export const EmailLoginRateLimitedDetails = z.object({ retryAfterSeconds: z.number().int().positive() });
export type EmailLoginRateLimitedDetails = z.infer<typeof EmailLoginRateLimitedDetails>;

export const Me = z.object({
  hostOwner: z.boolean().optional(),
  /** The user holds an active owner account (PM-1062): may create projects and engines of their own. */
  ownerAccount: z.boolean().optional(),
  via: z.literal('integrator').optional(),
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  /** Member handle of this user per project key. */
  handles: z.record(z.string(), MemberHandle),
  projects: z
    .array(z.object({ key: z.string(), name: z.string(), access: HumanAccess, roles: z.array(RoleId) }))
    .default([]),
  /**
   * The user is the chopper's host owner (the same person as `hostOwner`), who manages the instance as a
   * whole whatever their project memberships: they see the machine display and may pause the instance.
   */
  instanceOwner: z.boolean(),
});
export type Me = z.infer<typeof Me>;

export const SetupStatus = z.object({
  needsSetup: z.boolean(),
  /** `cloud` mode with no user yet: the setup form asks for the code from the server log (PM-317). */
  needsSetupCode: z.boolean().optional(),
  /** The server can send and redeem e-mail login codes (PM-670). Absent: false. */
  emailLoginEnabled: z.boolean().optional(),
  /** The board runs publicly, behind its own login only (PM-672). Absent: false. */
  publicBoard: z.boolean().optional(),
});
export type SetupStatus = z.infer<typeof SetupStatus>;

/* ---------- providers ---------- */

/** Why a provider is not usable (PM-324); only with `loggedIn === false`. */
export const ProviderProblem = z.enum([
  'not_logged_in',
  'no_key',
  'cli_too_old',
  'cli_missing',
  'chatgpt_login',
]);
export type ProviderProblem = z.infer<typeof ProviderProblem>;

/** Subscription login status of each supported runner provider. */
export const ProviderLoginStatus = z.object({
  provider: AgentProvider,
  loggedIn: z.boolean().nullable(),
  method: z.string().nullable(),
  checkedAt: z.string(),
  detail: z.string().optional(),
  problem: ProviderProblem.optional(),
  cliVersion: z.string().optional(),
  minCliVersion: z.string().optional(),
});
export type ProviderLoginStatus = z.infer<typeof ProviderLoginStatus>;
export const ProviderKeyStatus = z.object({ set: z.boolean(), setAt: z.string().nullable() });
export type ProviderKeyStatus = z.infer<typeof ProviderKeyStatus>;
export const ProvidersView = z.object({
  providers: z.array(ProviderLoginStatus),
  keys: z.object({ nanogpt: ProviderKeyStatus }),
  canManageKeys: z.boolean(),
});
export const ProviderKeyValue = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .regex(/^[\x21-\x7E]+$/);
export const SetProviderKeyRequest = z.strictObject({ key: ProviderKeyValue });
export type ProvidersView = z.infer<typeof ProvidersView>;

/* ---------- projects ---------- */

export const ProjectSummary = z.object({
  key: z.string(),
  name: z.string(),
  templateId: z.string().nullable(),
  configVersion: z.string(),
});
export type ProjectSummary = z.infer<typeof ProjectSummary>;

export const CreateProjectRequest = z.object({
  key: z.string().regex(/^[A-Z][A-Z0-9]{0,9}$/),
  name: z.string().min(1),
  workspacePath: z.string().min(1),
  templateId: z.string().optional(),
  language: z.enum(['hu', 'en']).optional(),
  provider: AgentProvider.optional(),
  /** Repositories of the workspace; templates start without any (they can also be added later in the config). */
  repos: z.array(RepoConfig).optional(),
  /** Who moves the cards on; absent means `worker`. `creator` makes the creating human the mover. */
  cardMover: z.enum(['worker', 'project_manager', 'creator']).optional(),
  /**
   * The engine the project is created on (PM-1062): the folder is checked there and it becomes the project's
   * base engine. Required for an owner account; the host owner may leave it out (today's way).
   */
  engineId: EngineId.optional(),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;

export const TemplateSummary = z.object({
  id: z.string(),
  /** i18n keys; the web app translates them. */
  nameKey: z.string(),
  descriptionKey: z.string(),
  memberCount: z.object({ human: z.number().int(), ai: z.number().int() }),
  stageCount: z.number().int(),
  /** The ids of the startup checklist items the template adds (PM-977). */
  checklist: z.array(z.string()),
});
export type TemplateSummary = z.infer<typeof TemplateSummary>;

/* ---------- members ---------- */

export const MEMBER_QUOTA_WAIT_REASONS = ['provider_rate_limited', 'plan_usage_paused'] as const;
/** A waking queued item waits for the AI member's provider limit (PM-999). */
export const MemberQuotaWaiting = z.object({
  reason: TaskStartWaiting.shape.reason.extract(MEMBER_QUOTA_WAIT_REASONS),
  provider: AgentProvider.optional(),
  /** ISO: when the provider says the limit lifts; absent when unknown. */
  until: z.string().optional(),
  /** ISO: the oldest matching item's wait time. */
  since: z.string(),
});
export type MemberQuotaWaiting = z.infer<typeof MemberQuotaWaiting>;

export const MemberView = z.object({
  complexityLimit: ComplexityPoints.optional(),
  specialtyLabels: z.array(LabelId).optional(),
  /** AI members: the server always supplies the effective email settings. */
  email: z.object({ enabled: z.boolean(), sendWithoutApproval: z.boolean() }).optional(),
  outage: WorkOutage.optional(),
  /** AI members only: a waking queued item waits for the provider's limit. */
  quotaWaiting: MemberQuotaWaiting.optional(),
  githubLogin: GithubLogin.optional(),
  handle: MemberHandle,
  displayName: z.string(),
  kind: MemberKind,
  /** HumanAccess for humans, the role id for AI members. */
  role: z.union([HumanAccess, RoleId]),
  /** Roles held: a human's roles (possibly none), or the AI member's one role. */
  roles: z.array(RoleId),
  specialty: z.string().nullable(),
  status: MemberStatus,
  activity: z.string().nullable(),
  /** The card of the session activity comes from; null: no card session. */
  activityTaskKey: TaskKey.nullable().optional(),
  currentTaskKeys: z.array(TaskKey),
  /**
   * AI members only: the work the member does on cards right now, one entry per working task session
   * (PM-207). A card is "working" only when it has an entry here; `status` and `activity` describe the
   * member as a whole. Omitted for humans.
   */
  taskWork: z.array(TaskWork).optional(),
  sponsor: MemberHandle.nullable(),
  temp: z.boolean(),
  /** AI members only: the agent CLI the member runs in. */
  provider: AgentProvider.optional(),
  /** AI members only: public session settings, available to every project member. */
  model: z.string().optional(),
  permissionMode: PermissionMode.optional(),
  /** AI members only: who answers when the CLI asks (the effective value: absent in the configuration reads `human`). */
  approver: Approver.optional(),
  /** AI members only: still on the historical "everything allowed" mode, which cannot be chosen any more. */
  permissionLegacy: z.boolean().optional(),
  /** AI members only: why the AI approver cannot be chosen now; absent when it can. */
  aiApproverBlocker: z.enum(['delegation_off', 'no_ai_decider']).optional(),
  effort: AgentEffort.optional(),
  /** AI members only: the member's own compaction window in tokens (PM-212); omitted: the project's. */
  autoCompactWindowTokens: AutoCompactWindowTokens.optional(),
  /** AI members only: the cheap subagent's model as configured (PM-179); omitted: off. */
  cheapSubagent: CheapSubagentModel.optional(),
  /** AI members only: on leave, nothing starts a session for the member (omitted: at work). */
  onLeave: z.boolean().optional(),
  /**
   * AI members only: whether the member's commands can reach any outbound address (PM-355). The server
   * always fills it in for AI members (a member without the setting reads `true`). Omitted for humans.
   */
  outboundNetwork: z.boolean().optional(),
  /** AI members only: the effective machine access (`machineAccessOf`, decision 66); missing (an older server): off. */
  machineAccess: z.boolean().optional(),
  /** AI members only: the earlier handles, the oldest first (PM-1025); omitted: never renamed. */
  formerHandles: z.array(MemberHandle).optional(),
});
export type MemberView = z.infer<typeof MemberView>;

/** Renames an AI member (PM-1025): the new handle. Owner only. */
export const RenameMemberRequest = z.strictObject({ handle: MemberHandle });
export type RenameMemberRequest = z.infer<typeof RenameMemberRequest>;

/** Adds an unclaimed human seat, without an account or invitation. */
export const AddHumanMemberRequest = z.object({
  displayName: z.string().trim().min(1),
  handle: MemberHandle.optional(),
  access: HumanAccess.exclude(['owner']),
  roles: z.array(RoleId),
});
export type AddHumanMemberRequest = z.infer<typeof AddHumanMemberRequest>;

/** Hires an AI member for a role an AI may hold (built-in or custom). */
export const HireMemberRequest = z.object({
  effort: AgentEffort.optional(),
  /** The cheap subagent's model (PM-179); omitted: off. */
  cheapSubagent: CheapSubagentModel.optional(),
  role: RoleId,
  displayName: z.string().min(1).optional(),
  handle: MemberHandle.optional(),
  specialty: z.string().optional(),
  model: z.string().optional(),
  schedule: MemberSchedule.optional(),
  /** The agent CLI the member runs in (default "claude"). */
  provider: AgentProvider.optional(),
  /** Owner only (PM-355): whether the new member's commands can reach the network; default on. */
  outboundNetwork: z.boolean().optional(),
});
export type HireMemberRequest = z.infer<typeof HireMemberRequest>;

/** PATCH of a member; omitted fields stay as they are. */
export const UpdateMemberRequest = z.object({
  complexityLimit: ComplexityPoints.nullable().optional(),
  specialtyLabels: z.array(LabelId).max(10).nullable().optional(),
  /** AI only; omitted values retain their settings. */
  email: z
    .strictObject({
      enabled: z.boolean().optional(),
      sendWithoutApproval: z.boolean().optional(),
      /** The member's own mailbox name (PM-989); the handle's own value clears the choice. */
      mailbox: EmailMailbox.optional(),
    })
    .optional(),
  access: HumanAccess.optional(),
  provider: AgentProvider.optional(),
  /** AI only; null restores the provider default. */
  effort: AgentEffort.nullable().optional(),
  /** AI only; the compaction window in tokens (PM-212), null falls back to the project's. */
  autoCompactWindowTokens: AutoCompactWindowTokens.nullable().optional(),
  /** AI only, owner only (PM-355): whether the member's commands can reach the network. */
  outboundNetwork: z.boolean().optional(),
  /** AI only, owner only (decision 66): whether the member may put machine work in the owners' queue. */
  machineAccess: z.boolean().optional(),
  /** AI only; the cheap subagent's model (PM-179), null switches it off. */
  cheapSubagent: CheapSubagentModel.nullable().optional(),
  displayName: z.string().trim().min(1).optional(),
  /** Humans only: the roles they hold (replaces the list). An AI member holds exactly one role. */
  roles: z.array(RoleId).optional(),
  /** AI only; an empty string removes it. */
  specialty: z.string().optional(),
  /** AI only. */
  model: z.string().trim().min(1).optional(),
  /** AI only; null removes the schedule. */
  schedule: MemberSchedule.nullable().optional(),
  /** AI only; true sends the member on leave, false calls it back. */
  onLeave: z.boolean().optional(),
  /** AI only; the member's own instructions (English prompt text); an empty string clears them. */
  instructions: z.string().optional(),
  /** AI only, owners only: the CLI permission mode (not `bypassPermissions`). */
  permissionMode: SelectablePermissionMode.optional(),
  /** AI only, owners only: who answers when the CLI asks. */
  approver: Approver.optional(),
});
export type UpdateMemberRequest = z.infer<typeof UpdateMemberRequest>;

export const OperatorMemberChanges = UpdateMemberRequest.omit({
  access: true,
  roles: true,
  displayName: true,
}).extend({
  capacity: z.number().int().min(1).max(5).optional(),
  permissionMode: PermissionMode.optional(),
  role: RoleId.optional(),
});
export type OperatorMemberChanges = z.infer<typeof OperatorMemberChanges>;
export const OperatorPlan = z.strictObject({
  why: z.string().trim().min(1).max(500),
  impact: z.string().trim().min(1).max(500),
  reversible: z.boolean(),
});
export type OperatorPlan = z.infer<typeof OperatorPlan>;
export const RoleConfigurationRead = z.strictObject({
  version: z.string(),
  role: BuiltInRoleId,
  override: RoleBundle.nullable(),
  effective: RoleBundle,
});
export type RoleConfigurationRead = z.infer<typeof RoleConfigurationRead>;

export const OperatorOperation = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('config_patch'),
    patch: OperatorConfigPatch,
  }),
  z.strictObject({ op: z.literal('member_update'), handle: MemberHandle, changes: OperatorMemberChanges }),
  z.strictObject({ op: z.literal('member_hire'), request: HireMemberRequest }),
  z.strictObject({ op: z.literal('member_retire'), handle: MemberHandle }),
  /** Renames an AI member's handle (PM-1025); `to` is the new handle. */
  z.strictObject({ op: z.literal('member_rename'), handle: MemberHandle, to: MemberHandle }),
  z.strictObject({ op: z.literal('config_revert'), version: z.string() }),
  z.strictObject({ op: z.literal('session_stop'), sessionId: z.string() }),
  z.strictObject({ op: z.literal('project_pause'), reason: PauseRequest.shape.reason }),
  z.strictObject({ op: z.literal('project_resume') }),
  z.strictObject({
    op: z.literal('message_send'),
    to: z.array(MemberHandle).min(1).max(10),
    text: z.string().trim().min(1).max(20_000),
    taskKey: TaskKey.optional(),
  }),
]);
export type OperatorOperation = z.infer<typeof OperatorOperation>;

export const ProposeOperatorKnowledgeRequest = z
  .strictObject({
    expected_revision: z.number().int().nonnegative(),
    title: z.string().trim().min(1).max(120),
    change: OperatorKnowledgeChange,
    operations: z.array(OperatorOperation).max(10).default([]),
  })
  .refine((value) => value.change.kind === 'agreement_replace' || value.operations.length === 0, {
    message: 'Only agreement proposals accept operations',
    path: ['operations'],
  });
export type ProposeOperatorKnowledgeRequest = z.infer<typeof ProposeOperatorKnowledgeRequest>;

export const OperatorKnowledgeApprovalPayload = z.strictObject({
  id: z.string(),
  requestId: z.string(),
  stepId: z.string(),
  baseRevision: z.number().int().nonnegative(),
  change: OperatorKnowledgeChange,
  operations: z.array(OperatorOperation).max(10),
  changes: z.array(ConfigChangeRow),
  baseConfigVersion: z.string().nullable(),
  proposedBy: MemberHandle,
  stale: z
    .strictObject({ reason: z.enum(['knowledge_changed', 'config_changed']), at: z.iso.datetime() })
    .nullable(),
  applying: z.strictObject({ by: MemberHandle, at: z.iso.datetime() }).nullable(),
});
export type OperatorKnowledgeApprovalPayload = z.infer<typeof OperatorKnowledgeApprovalPayload>;

export function operatorKnowledgeApprovalOf(
  item: Pick<InboxItem, 'kind' | 'payload'>,
): OperatorKnowledgeApprovalPayload | null {
  if (item.kind !== 'approval') return null;
  const parsed = OperatorKnowledgeApprovalPayload.safeParse(item.payload.operatorKnowledge);
  return parsed.success ? parsed.data : null;
}

/** An agreement of this request must be decided before its suggested operations can run. */
export function hasPendingOperatorAgreement(
  items: readonly InboxItem[],
  projectKey: string,
  requestId: string,
): boolean {
  return items.some((item) => {
    const proposal = operatorKnowledgeApprovalOf(item);
    return (
      item.projectKey === projectKey &&
      item.state === 'open' &&
      proposal?.requestId === requestId &&
      proposal.change.kind === 'agreement_replace'
    );
  });
}

export function operatorKnowledgeContinuationMessageId(proposalId: string): string {
  return `msg_${proposalId}`;
}

/** A marker alone grants nothing. The resolved inbox, human identity and approved step are required. */
export function operatorKnowledgeContinuationOf(
  item: InboxItem,
  facts: {
    projectKey: string;
    from: string;
    operator: string;
    messageId: string;
    approvedStep: boolean;
    owner: boolean;
    via?: string;
  },
): OperatorKnowledgeApprovalPayload | null {
  const payload = operatorKnowledgeApprovalOf(item);
  const resolution = item.resolution;
  if (
    !payload ||
    item.projectKey !== facts.projectKey ||
    item.state !== 'resolved' ||
    resolution?.optionId !== 'approve' ||
    resolution.via ||
    resolution.rule ||
    facts.via ||
    resolution.by !== payload.applying?.by ||
    resolution.by !== facts.from ||
    !facts.owner ||
    !facts.approvedStep ||
    item.source !== facts.operator ||
    payload.proposedBy !== facts.operator ||
    facts.messageId !== operatorKnowledgeContinuationMessageId(payload.id) ||
    payload.change.kind !== 'agreement_replace' ||
    !payload.operations.length
  )
    return null;
  return payload;
}

export function operatorKnowledgeOperationIncluded(
  payload: OperatorKnowledgeApprovalPayload,
  operation: unknown,
): boolean {
  const parsed = OperatorOperation.safeParse(operation);
  return parsed.success && payload.operations.some((entry) => canonical(entry) === canonical(parsed.data));
}

export const OPERATOR_CRITICAL_OPS = ['session_stop', 'message_send'] as const;
export function operatorCriticalOp(op: OperatorOperation['op']): boolean {
  return OPERATOR_CRITICAL_OPS.some((critical) => critical === op);
}
export const OperatorConsequence = z.enum([
  'network',
  'permission_mode',
  'pipeline',
  'labels',
  'member_hire',
  'member_retire',
  'member_rename',
  'member_other',
  'locations',
  'review_test',
  'operator_watch',
  'fix_limit',
  'session_stop',
  'message_send',
  'project_pause',
  'project_resume',
  'project',
  'other',
]);
export type OperatorConsequence = z.infer<typeof OperatorConsequence>;
export const OperatorApprovalPayload = z.object({
  requestId: z.string(),
  stepId: z.string(),
  quote: z.string(),
  action: OperatorAction,
  operation: OperatorOperation,
  changes: z.array(ConfigChangeRow),
  consequence: OperatorConsequence,
  baseVersion: z.string().nullable(),
  session: z.object({ id: z.string(), startedAt: z.string() }).nullable(),
  plan: OperatorPlan.nullable().optional(),
  expiresAt: z.string().nullable().optional(),
  stale: z
    .object({
      reason: z.enum(['config_changed', 'session_changed', 'pause_changed', 'expired', 'interrupted']),
      at: z.string(),
    })
    .nullable(),
});
export type OperatorApprovalPayload = z.infer<typeof OperatorApprovalPayload>;
export function operatorApprovalOf(
  item: Pick<InboxItem, 'kind' | 'payload'>,
): OperatorApprovalPayload | null {
  if (item.kind !== 'approval') return null;
  const parsed = OperatorApprovalPayload.safeParse(item.payload.operator);
  return parsed.success ? parsed.data : null;
}
export const OPERATOR_DISMISS_OPTION: InboxOption = { id: 'dismiss', label: 'dismiss', style: 'secondary' };

export const RetireMemberRequest = z.object({ handoverTo: MemberHandle.optional() });
export type RetireMemberRequest = z.infer<typeof RetireMemberRequest>;

export const MemberProfile = z.object({
  member: MemberView,
  duties: z.array(DutyId),
  tasks: z.array(Task),
  inbox: z.array(InboxItem),
  timeline: z.array(TimelineEvent),
  sessions: z.array(Session),
  capacity: z.number().nullable(),
  capacityUsed: z.number(),
  /** What takes the member's places (PM-297); filled in where `capacityUsed` is. */
  capacityHolders: z.array(CapacityHolder).optional(),
  email: z.string().optional(),
  /** AI members: the tokens their sessions used lately (PM-178); omitted for humans. */
  usage: MemberUsage.optional(),
});
export type MemberProfile = z.infer<typeof MemberProfile>;
export const MemberContextQuery = z.object({ task: TaskKey.optional() });
export type MemberContextQuery = z.infer<typeof MemberContextQuery>;

const ContextText = z.object({ text: z.string(), chars: z.number().int().nonnegative() });
export const MemberContextPreview = z.object({
  generatedAt: z.iso.datetime(),
  member: z.object({
    handle: MemberHandle,
    role: RoleId,
    duties: z.array(DutyId),
    onLeave: z.boolean(),
  }),
  situation: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('general') }),
    z.object({ kind: z.literal('task'), taskKey: TaskKey, stageId: StageId }),
  ]),
  prompt: ContextText.extend({
    sections: z.array(ContextText.extend({ id: z.string(), title: z.string() })),
  }),
  initialMessage: ContextText.nullable(),
  guides: z.array(ContextText.extend({ topic: z.string(), title: z.string() })),
  tools: z.array(z.object({ name: z.string(), title: z.string(), description: z.string() })),
});
export type MemberContextPreview = z.infer<typeof MemberContextPreview>;

export const MemberMemories = z.object({ memory: z.string() });
export type MemberMemories = z.infer<typeof MemberMemories>;

/* ---------- schedules ---------- */

export const SchedulesView = z.object({
  timezone: z.string(),
  members: z.array(
    z.object({
      member: MemberHandle,
      cron: z.string(),
      promptSummary: z.string(),
      nextRun: z.string().nullable(),
    }),
  ),
  runs: z.array(ScheduleRun),
});
export type SchedulesView = z.infer<typeof SchedulesView>;

/* ---------- roles ---------- */

/** A role of the catalogue: built-in texts come in the project's language (English fallback). */
export const RoleView = z.object({
  id: RoleId,
  name: z.string(),
  summary: z.string(),
  notTheirJob: z.string(),
  /** When to turn to a member holding the role. */
  whenToAsk: z.string(),
  holders: RoleHolders,
  builtIn: z.boolean(),
  duties: z.array(DutyId).optional(),
  instructions: z.string().optional(),
});
export type RoleView = z.infer<typeof RoleView>;

/** Built-in roles in catalogue order, then the team's custom roles. */
export const RolesView = z.object({ roles: z.array(RoleView) });
export type RolesView = z.infer<typeof RolesView>;

/** Creates (POST) or replaces (PUT, same id) a custom role. */
export const CustomRoleRequest = CustomRoleDefinition;
export type CustomRoleRequest = z.input<typeof CustomRoleRequest>;

/* ---------- board & tasks ---------- */

export const PlanUsage = z.object({
  fiveHourPercent: z.number().nullable(),
  weeklyPercent: z.number().nullable(),
  fiveHourResetsAt: z.string().nullable(),
  weeklyResetsAt: z.string().nullable(),
  fetchedAt: z.string(),
});
export type PlanUsage = z.infer<typeof PlanUsage>;

export const BoardColumnView = BoardColumn.extend({ stageIds: z.array(StageId) });
export type BoardColumnView = z.infer<typeof BoardColumnView>;

/** A label definition with the members who may set it (resolved from its duties or members). */
export const LabelView = LabelDefinition.extend({ holders: z.array(z.string()) });
export type LabelView = z.infer<typeof LabelView>;

export const BoardView = z.object({
  /** Public project admission switch. */
  aiEnabled: z.boolean(),
  project: ProjectSummary,
  columns: z.array(BoardColumnView),
  stages: z.array(Stage),
  /** The project's label vocabulary, for chips, pickers and gate hints. */
  labels: z.array(LabelView).default([]),
  tasks: z.array(Task),
  members: z.array(MemberView),
  openInboxCount: z.number().int(),
  planUsage: PlanUsage.nullable(),
  /** Usage snapshots for the providers used by this project. */
  planUsageByProvider: z.partialRecord(AgentProvider, PlanUsage.nullable()).default({}),
  /** The open pauses touching the project (PM-219). */
  pause: ProjectPauseView.optional(),
});
export type BoardView = z.infer<typeof BoardView>;

export const TaskPullRequest = z.object({
  repo: z.string(),
  number: z.number().int().positive(),
  url: z.string().nullable(),
  title: z.string().nullable(),
  state: z.enum(['open', 'closed', 'merged', 'draft']).nullable(),
  checks: z.enum(['pending', 'passing', 'failing']).nullable(),
  reviewDecision: z.enum(['approved', 'changes_requested', 'review_required']).nullable(),
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
});
export type TaskPullRequest = z.infer<typeof TaskPullRequest>;

export const TaskDetail = z.object({
  parent: Task.nullable().optional(),
  subtasks: z.array(Task).optional(),
  task: Task,
  timeline: z.array(TimelineEvent),
  pullRequests: z.array(TaskPullRequest).default([]),
  sessions: z.array(Session),
  /** Review rounds and send-backs counted from the whole timeline (PM-222). */
  rounds: CardRounds.optional(),
  /** The fix rounds since the count began and the project's limit (PM-262). */
  fixRounds: z
    .object({ rounds: z.number().int().nonnegative(), limit: z.number().int().positive() })
    .optional(),
  /** Why the card stands still (PM-460), for the viewer; null for a closed card. */
  wait: TaskWait.nullable().optional(),
});
export type TaskDetail = z.infer<typeof TaskDetail>;

export const ComplexityRequest = z.object({
  points: z.number().int().nullable(),
  reason: z.string().max(COMPLEXITY_REASON_MAX).nullable().optional(),
});
export type ComplexityRequest = z.infer<typeof ComplexityRequest>;

export const CreateTaskRequest = z.object({
  complexity: ComplexityRequest.optional(),
  parentKey: TaskKey.optional(),
  importedAt: z.string().datetime().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  stageId: StageId.optional(),
  repo: z.string().nullable().optional(),
  labels: z.array(z.string()).optional(),
  /** Relations the new card starts with (PM-192); a refused one refuses the creation. */
  relations: z.array(AddRelationRef).optional(),
  /** `theme` creates a theme (PM-192); absent: a task. A theme takes no stage, repository, parent or theme of its own (plain labels are allowed). */
  kind: TaskKind.optional(),
  /** The theme the new card belongs to (not for a theme or a subtask). */
  themeKey: TaskKey.optional(),
});
export type CreateTaskRequest = z.infer<typeof CreateTaskRequest>;

export const UpdateTaskRequest = z.object({
  complexity: ComplexityRequest.optional(),
  /** People only (PM-287); null clears it. */
  priority: TaskPriority.nullable().optional(),
  parentKey: TaskKey.nullable().optional(),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  stageId: StageId.optional(),
  labels: z.array(z.string()).optional(),
  /**
   * Owner/admin only; null clears the assignee. Starting work is a separate call. A live session of
   * the old assignee does not refuse the change: it is asked for a handoff note (PM-342).
   */
  assignee: MemberHandle.nullable().optional(),
  /**
   * The repository the task works in: the name of a repository of the project's configuration, or
   * null to clear it. Refused while a session of the task is running (`task_session_live`).
   */
  repo: z.string().nullable().optional(),
  /**
   * Relations to other cards (PM-192), all or nothing with the rest of the change; removals apply
   * first. Added: the four forward kinds. Removed: any kind, the reverse of a stored one included.
   */
  relations: RelationsChange.optional(),
  /**
   * The theme the card belongs to (PM-192); null removes it. Refused for a theme and for a subtask,
   * which reads its parent's theme, and for a theme that is closed.
   */
  themeKey: TaskKey.nullable().optional(),
  /**
   * A person moves the card into the work stage after the warning that a prerequisite is open
   * (PM-204): the automatic start that follows does not wait for it. Only a person may send it;
   * the team tool does not offer it, so a card an AI member moves waits.
   */
  despitePrerequisites: z.boolean().optional(),
});
export type UpdateTaskRequest = z.infer<typeof UpdateTaskRequest>;

/**
 * The answer to the change of a card: the card, and `handoffStart` when this request set off a handoff of
 * its assignee or redirected the one that was open (PM-342).
 */
export const UpdateTaskResponse = Task.extend({ handoffStart: HandoffStart.optional() });
export type UpdateTaskResponse = z.infer<typeof UpdateTaskResponse>;

/**
 * A card dropped on the board (PM-118): into the column `columnId` at `placement`. The card is the
 * one in the route; `fromStageId` is the stage the person saw it in, so a card that moved meanwhile is
 * refused (409 `board_stale`) rather than placed by a stale picture. Dropped in its own column it only
 * changes its place; dropped in another it enters that column's first stage through the usual gates
 * (409 `gate_blocked`, or `approval_requested`, which keeps the placement for the approval). The
 * client sends the place relative to a card it sees, never a rank and never a whole list.
 */
export const BoardMoveRequest = z
  .object({
    columnId: z.string(),
    fromStageId: StageId,
    placement: BoardPlacement,
    /** As `UpdateTaskRequest.despitePrerequisites`, for a drop that starts work (PM-204). */
    despitePrerequisites: z.boolean().optional(),
    /**
     * A collecting card dragged to another column takes the direct subtasks that stand in its column
     * with it (PM-121), each through the gates of its own move; the server picks them from its own
     * state (`subtasksMovingAlong`) and answers with `group`. Without it only the card moves, as before.
     */
    withSubtasks: z.boolean().optional(),
    // Strict: the client never sends a rank or a list of cards; the server computes the place.
  })
  .strict();
export type BoardMoveRequest = z.infer<typeof BoardMoveRequest>;

/**
 * What a group move did to one card (PM-121): `moved`; `blocked` by a business rule (`gate_blocked`
 * with the unmet conditions and the approvals the gate asks for, or `handover_uncommitted`, the
 * developer's uncommitted work that a review hand-over refuses) with the server's message; waiting
 * for a human approval (`approval_pending`, the inbox items it waits on: the card moves on its own
 * once they are approved); or `skipped` because the card changed meanwhile (no longer in the column,
 * closed) and was not touched.
 */
export const BoardGroupItem = z.discriminatedUnion('outcome', [
  z.object({ taskKey: TaskKey, outcome: z.literal('moved') }),
  z.object({
    taskKey: TaskKey,
    outcome: z.literal('blocked'),
    // `no_approver`: an approval the move needs cannot be given by anyone; `approvals` names it, no approvers.
    code: z.enum(['gate_blocked', 'handover_uncommitted', 'no_approver', 'task_not_merged']),
    message: z.string(),
    unmet: z.array(
      z.object({ stageId: StageId, condition: GateCondition, setters: z.array(z.string()).optional() }),
    ),
    approvals: z.array(z.object({ stageId: StageId, label: LabelId, approvers: z.array(z.string()) })),
  }),
  z.object({ taskKey: TaskKey, outcome: z.literal('approval_pending'), inboxItemIds: z.array(z.string()) }),
  z.object({ taskKey: TaskKey, outcome: z.literal('skipped'), reason: z.enum(['changed', 'closed']) }),
]);
export type BoardGroupItem = z.infer<typeof BoardGroupItem>;

/**
 * What a board move did to the card: `reordered` (its place in its column changed), `moved` (it entered
 * another column), or `unchanged` (it was there already). `task` is the card as it is now; `reranked` are
 * the keys of the cards whose rank was written, the card included (each of them was published as
 * `task_upserted`). Meant to grow a per-card result list when several cards are moved at once.
 */
export const BoardMoveResult = z.object({
  task: Task,
  outcome: z.enum(['reordered', 'moved', 'unchanged']),
  reranked: z.array(TaskKey),
  /**
   * The result of every card of a group move (PM-121), the collecting card first, then its subtasks in
   * their order; absent unless the request asked `withSubtasks` and subtasks of the column were found.
   * A refusal of one card (a gate, a pending approval, a card that changed meanwhile) is its own item and
   * does not stop the others; `task` is then the collecting card as it is now, `outcome` its own.
   */
  group: z.array(BoardGroupItem).optional(),
});
export type BoardMoveResult = z.infer<typeof BoardMoveResult>;

export const CreateTaskCommentRequest = z.object({
  text: z.string().trim().min(1).max(10000),
  importedAuthor: z.string().trim().min(1).max(80).optional(),
  importedAt: z.iso.datetime({ offset: true }).optional(),
});
export type CreateTaskCommentRequest = z.infer<typeof CreateTaskCommentRequest>;

/**
 * Adds and/or removes labels under the project's label rules (who may set them, no self-review,
 * comment required). The comment is recorded with the change; adding a grouped label replaces
 * the other labels of its group.
 */
export const ChangeTaskLabelsRequest = z
  .object({
    add: z.array(LabelId).optional(),
    remove: z.array(LabelId).optional(),
    comment: z.string().trim().min(1).max(10000).optional(),
  })
  .refine((r) => (r.add?.length ?? 0) + (r.remove?.length ?? 0) > 0, 'add or remove a label');
export type ChangeTaskLabelsRequest = z.infer<typeof ChangeTaskLabelsRequest>;

export const CancelTaskRequest = z.object({ reason: z.string().optional() });
export type CancelTaskRequest = z.infer<typeof CancelTaskRequest>;

/** Closes a theme (PM-192): it only closes; the cards that belong to it are not touched. */
export const CloseThemeRequest = z.object({});
export type CloseThemeRequest = z.infer<typeof CloseThemeRequest>;

/** The answer of `PUT routes.taskCover`: the card as boards show it (PM-224). */
export const TaskCoverResponse = z.object({ task: Task });
export type TaskCoverResponse = z.infer<typeof TaskCoverResponse>;

export const ReopenTaskRequest = z.object({});
export type ReopenTaskRequest = z.infer<typeof ReopenTaskRequest>;

export const StartTaskRequest = z.object({
  /** Developer to assign; omitted = the scheduler picks a free developer (or a temp worker). */
  assignee: MemberHandle.optional(),
  /**
   * A person starts the card after the warning that a prerequisite is open (PM-204); without it
   * the start is refused (409 `prerequisite_open`). Only a person may send it.
   */
  despitePrerequisites: z.boolean().optional(),
});
export type StartTaskRequest = z.infer<typeof StartTaskRequest>;

/* ---------- sessions & messages ---------- */

export const SessionDetail = z.object({
  session: Session,
  chat: z.array(ChatItem),
  task: Task.nullable(),
});
export type SessionDetail = z.infer<typeof SessionDetail>;

/**
 * An owner sets a session's own permission settings (PM-170, `PATCH` of the session): the CLI mode
 * (not `bypassPermissions`) and who answers when it asks. `null` goes back to the member's setting;
 * an absent field stays as it is. The member's own settings never change.
 */
export const UpdateSessionRequest = z
  .object({
    permissionMode: SelectablePermissionMode.nullable().optional(),
    approver: Approver.nullable().optional(),
  })
  .strict()
  .refine((req) => req.permissionMode !== undefined || req.approver !== undefined, {
    message: 'permissionMode or approver is required',
  });
export type UpdateSessionRequest = z.infer<typeof UpdateSessionRequest>;

export const SendMessageRequest = z.object({ text: z.string().min(1) });
export type SendMessageRequest = z.infer<typeof SendMessageRequest>;

export const SendTeamMessageRequest = z
  .object({
    despiteWorkers: z.boolean().optional(),
    operatorSignal: z.string().optional(),
    to: z.array(MemberHandle).min(1).max(100),
    /** Empty only when `attachmentIds` names a file (PM-515). */
    text: z.string().trim().max(20000),
    taskKey: TaskKey.optional(),
    /** Uploaded files the message takes (`routes.messageAttachments`), each of the sender's and not sent yet. */
    attachmentIds: z.array(MessageAttachmentId).max(MAX_MESSAGE_ATTACHMENTS).optional(),
    /** Where the sender is in the app (PM-1071); the recipient gets it as background. */
    location: UiLocation.optional(),
  })
  .refine((request) => request.text !== '' || (request.attachmentIds?.length ?? 0) > 0, {
    path: ['text'],
    message: 'text or attachmentIds is required',
  })
  .refine((request) => new Set(request.attachmentIds).size === (request.attachmentIds?.length ?? 0), {
    path: ['attachmentIds'],
    message: 'attachmentIds must be unique',
  });
export type SendTeamMessageRequest = z.infer<typeof SendTeamMessageRequest>;

export const TeamMessagesView = z.object({
  messages: z.array(TeamMessage),
  unreadCount: z.number().int().nonnegative().optional(),
});
export type TeamMessagesView = z.infer<typeof TeamMessagesView>;

/** One conversation of the viewer with another member: its latest message and their unread messages in it (PM-78). */
export const TeamThread = z.object({
  peer: MemberHandle,
  lastMessage: TeamMessage,
  unreadCount: z.number().int().nonnegative(),
});
export type TeamThread = z.infer<typeof TeamThread>;

/** The viewer's own conversations, the most recently active first, and all their unread messages. */
export const TeamThreadsView = z.object({
  threads: z.array(TeamThread),
  unreadCount: z.number().int().nonnegative(),
});
export type TeamThreadsView = z.infer<typeof TeamThreadsView>;

/** Marks the messages read that were sent to the viewer; the others of the list are left as they are. */
export const ReadTeamMessagesRequest = z.object({ ids: z.array(z.string().min(1)).min(1).max(500) });
export type ReadTeamMessagesRequest = z.infer<typeof ReadTeamMessagesRequest>;

/* ---------- inbox ---------- */

export const InboxView = z.object({ items: z.array(InboxItem) });
export type InboxView = z.infer<typeof InboxView>;

export const ResolveInboxRequest = z.object({
  optionId: z.string(),
  note: z.string().optional(),
  attachmentIds: z.array(MessageAttachmentId).max(MAX_MESSAGE_ATTACHMENTS).optional(),
});
export type ResolveInboxRequest = z.infer<typeof ResolveInboxRequest>;

export const ResolveIntegratorTodoRequest = z.strictObject({
  optionId: z.enum(['todo_done', 'todo_cannot']),
  note: z.string().trim().max(10_000).optional(),
});
export type ResolveIntegratorTodoRequest = z.infer<typeof ResolveIntegratorTodoRequest>;

/**
 * The integrator's decision about a fix round limit item addressed to it (PM-714): one of the three
 * outcomes, or `to_owner` to hand the same item to the owners (a note is then required: why). `to_owner` is
 * a change of recipient, not a fourth outcome.
 */
export const ResolveIntegratorFixLimitRequest = z
  .strictObject({
    optionId: z.enum(['replan', 'reassign', 'another_round', 'to_owner']),
    note: z.string().trim().max(10_000).optional(),
  })
  .refine((request) => request.optionId !== 'to_owner' || !!request.note, {
    path: ['note'],
    message: 'a note is required when the item goes on to the owners',
  });
export type ResolveIntegratorFixLimitRequest = z.infer<typeof ResolveIntegratorFixLimitRequest>;

/* ---------- configuration ---------- */

export const ConfigVersionEntry = z.object({
  operatorStepId: z.string().optional(),
  operatorRequestId: z.string().optional(),
  operatorAgreementVersion: z.number().int().positive().optional(),
  operatorApprovalMode: z.enum(['click', 'waived']).optional(),
  operator: MemberHandle.optional(),
  request: z.string().optional(),
  approvedBy: MemberHandle.optional(),
  via: z.literal('integrator').optional(),
  /** The full origin of a change made in the Operator's super mode (PM-757), read back from the commit trailers. */
  actor: Actor.optional(),
  /** The audit entry that began this super-mode commit (PM-757): how a lost response is settled from the commit. */
  superAuditId: z.string().optional(),
  version: z.string(),
  message: z.string(),
  author: z.string(),
  at: z.string(),
});
export type ConfigVersionEntry = z.infer<typeof ConfigVersionEntry>;

export const ConfigView = z.object({
  config: ProjectConfig,
  version: z.string(),
  history: z.array(ConfigVersionEntry),
});
export type ConfigView = z.infer<typeof ConfigView>;

export const OperatorApprovalWaiverRequest = z.strictObject({
  baseVersion: z.string(),
  enabled: z.boolean(),
  agreementVersion: z.number().int().min(1),
});
export type OperatorApprovalWaiverRequest = z.infer<typeof OperatorApprovalWaiverRequest>;
export const OperatorApprovalWaiverResponse = z.object({
  version: z.string(),
  enabled: z.boolean(),
  agreementVersion: z.number().int().min(1),
});
export type OperatorApprovalWaiverResponse = z.infer<typeof OperatorApprovalWaiverResponse>;

export const RevertConfigRequest = z.object({ version: z.string() });
export type RevertConfigRequest = z.infer<typeof RevertConfigRequest>;

/* ---------- errors ---------- */

export const ApiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

/* ---------- invitations ---------- */

export const InviteAccess = HumanAccess.exclude(['owner']);
export type InviteAccess = z.infer<typeof InviteAccess>;

export const CreateInviteRequest = z.object({
  memberHandle: MemberHandle.optional(),
  email: z
    .string()
    .trim()
    .email()
    .transform((email) => email.toLowerCase()),
  displayName: z.string().trim().min(1).optional(),
  access: InviteAccess,
  roles: z.array(RoleId),
});
export type CreateInviteRequest = z.infer<typeof CreateInviteRequest>;

/** Never includes the token or its hash. */
export const InvitationView = z.object({
  memberHandle: MemberHandle.optional(),
  id: z.string(),
  projectKey: z.string(),
  email: z.string(),
  displayName: z.string().nullable(),
  access: InviteAccess,
  roles: z.array(RoleId),
  invitedBy: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  acceptedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export type InvitationView = z.infer<typeof InvitationView>;
export const InvitationsView = z.object({ invitations: z.array(InvitationView) });
export type InvitationsView = z.infer<typeof InvitationsView>;
export const CreatedInvitation = InvitationView.extend({ path: z.string() });
export type CreatedInvitation = z.infer<typeof CreatedInvitation>;

export const PublicInviteView = z.object({
  projectKey: z.string(),
  projectName: z.string(),
  inviterName: z.string(),
  displayName: z.string().nullable(),
  access: InviteAccess,
  roles: z.array(RoleId),
  roleNames: z.array(z.string()),
  expiresAt: z.string(),
  requiresLogin: z.boolean(),
  /** The invited address, masked (`j***@e***.uk`); only for a client invitation (PM-670). */
  emailHint: z.string().optional(),
});
export type PublicInviteView = z.infer<typeof PublicInviteView>;

/* ---------- owner accounts (PM-1062) ---------- */

/** An invitation of a new owner; never includes the token or its hash. */
export const OwnerInvitationView = z.object({
  id: z.string(),
  email: z.string(),
  /** The display name of the inviter. */
  invitedBy: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  acceptedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export type OwnerInvitationView = z.infer<typeof OwnerInvitationView>;
export const OwnerInvitationsView = z.object({ invitations: z.array(OwnerInvitationView) });
export type OwnerInvitationsView = z.infer<typeof OwnerInvitationsView>;
/** `path` is the link to hand over: `/owner-invite/<token>`. */
export const CreatedOwnerInvitation = OwnerInvitationView.extend({ path: z.string() });
export type CreatedOwnerInvitation = z.infer<typeof CreatedOwnerInvitation>;
export const CreateOwnerInviteRequest = z.object({ email: z.string().email() }).strict();
export type CreateOwnerInviteRequest = z.infer<typeof CreateOwnerInviteRequest>;

export const PublicOwnerInviteView = z.object({
  inviterName: z.string(),
  expiresAt: z.string(),
  requiresLogin: z.boolean(),
});
export type PublicOwnerInviteView = z.infer<typeof PublicOwnerInviteView>;

export const OwnerAccountView = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  grantedAt: z.string(),
  revokedAt: z.string().nullable(),
});
export type OwnerAccountView = z.infer<typeof OwnerAccountView>;
export const OwnerAccountsView = z.object({ accounts: z.array(OwnerAccountView) });
export type OwnerAccountsView = z.infer<typeof OwnerAccountsView>;

/** Puts a theme or card into the project's focus (PM-427); `position` is 1-based, absent: the end of the list. */
export const ProjectFocusAddRequest = z.object({
  key: TaskKey,
  position: z.number().int().min(1).optional(),
});
export type ProjectFocusAddRequest = z.infer<typeof ProjectFocusAddRequest>;

/** Moves a focus item to the 1-based `position`, clamped to the length of the list. */
export const ProjectFocusMoveRequest = z.object({ position: z.number().int().min(1) });
export type ProjectFocusMoveRequest = z.infer<typeof ProjectFocusMoveRequest>;

/** The project's `focus_changed` events, newest first. */
export const ProjectFocusChanges = z.object({ events: z.array(TimelineEvent) });
export type ProjectFocusChanges = z.infer<typeof ProjectFocusChanges>;

/** An existing account accepts with an empty body and its login cookie. */
export const AcceptInviteRequest = z.object({
  name: SetupRequest.shape.name.trim().min(1).optional(),
  password: SetupRequest.shape.password.optional(),
});
export type AcceptInviteRequest = z.infer<typeof AcceptInviteRequest>;

/* ---------- system feedback (PM-472): the Operator's findings about projectman itself ---------- */

export const SystemFeedbackOccurrence = z.object({ at: z.string(), version: z.string() });
export type SystemFeedbackOccurrence = z.infer<typeof SystemFeedbackOccurrence>;
export const SystemFeedbackForwarded = z.object({
  kind: z.enum(['card', 'issue']),
  projectKey: z.string().nullable(),
  taskKey: TaskKey.nullable(),
  url: z.string().nullable(),
  /** The name of whoever sent it; null: sent automatically. */
  by: z.string().nullable(),
  at: z.string(),
});
export type SystemFeedbackForwarded = z.infer<typeof SystemFeedbackForwarded>;
export const SystemFeedbackItem = z.object({
  /** `fb_…` */
  id: z.string(),
  projectKey: z.string(),
  title: z.string(),
  what: z.string(),
  workaround: z.string(),
  fix: z.string(),
  state: SystemFeedbackState,
  createdAt: z.string(),
  lastSeenAt: z.string(),
  version: z.string(),
  /** Oldest first, the first one included. */
  occurrences: z.array(SystemFeedbackOccurrence),
  /** What the filter covered when the item was recorded. */
  counts: RedactionCounts,
  forwarded: SystemFeedbackForwarded.nullable(),
  dismissed: z.object({ reason: z.string(), by: z.string(), at: z.string() }).nullable(),
  cardError: z.object({ code: z.string(), message: z.string(), at: z.string() }).nullable(),
});
export type SystemFeedbackItem = z.infer<typeof SystemFeedbackItem>;
export const SystemFeedbackForwardingChange = z.object({
  mode: SystemFeedbackForwardingMode,
  projectKey: z.string().nullable(),
  /** The name of whoever changed it. */
  by: z.string(),
  at: z.string(),
});
export type SystemFeedbackForwardingChange = z.infer<typeof SystemFeedbackForwardingChange>;
export const SystemFeedbackForwardingView = z.object({
  mode: SystemFeedbackForwardingMode,
  projectKey: z.string().nullable(),
  /** Newest first, at most 20; empty means the default, manual. */
  history: z.array(SystemFeedbackForwardingChange),
});
export type SystemFeedbackForwardingView = z.infer<typeof SystemFeedbackForwardingView>;
export const SystemFeedbackList = z.object({
  access: SystemFeedbackAccess,
  /** At most 200, the most recently seen first. */
  items: z.array(SystemFeedbackItem),
  newCount: z.number().int(),
  /** Only for `manage`. */
  forwarding: SystemFeedbackForwardingView.nullable(),
  repository: z.string(),
});
export type SystemFeedbackList = z.infer<typeof SystemFeedbackList>;
export const SystemFeedbackSummary = z.object({ newCount: z.number().int() });
export type SystemFeedbackSummary = z.infer<typeof SystemFeedbackSummary>;
export const SetSystemFeedbackForwardingRequest = z
  .object({ mode: SystemFeedbackForwardingMode, projectKey: z.string().optional() })
  .refine((request) => (request.mode === 'card') === (request.projectKey !== undefined));
export type SetSystemFeedbackForwardingRequest = z.infer<typeof SetSystemFeedbackForwardingRequest>;
export const DismissSystemFeedbackRequest = z.object({
  reason: z.string().trim().min(1).max(SYSTEM_FEEDBACK_REASON_MAX),
});
export type DismissSystemFeedbackRequest = z.infer<typeof DismissSystemFeedbackRequest>;
export const SystemFeedbackPreview = z.object({
  title: z.string(),
  body: z.string(),
  counts: RedactionCounts,
  repository: z.string(),
});
export type SystemFeedbackPreview = z.infer<typeof SystemFeedbackPreview>;
export const PrepareSystemFeedbackRequest = z.object({
  title: z.string().trim().min(1).max(SYSTEM_FEEDBACK_TITLE_MAX),
  body: z.string().trim().min(1).max(SYSTEM_FEEDBACK_BODY_MAX),
});
export type PrepareSystemFeedbackRequest = z.infer<typeof PrepareSystemFeedbackRequest>;
export const SystemFeedbackPrepared = z.discriminatedUnion('result', [
  z.object({ result: z.literal('ready'), url: z.string(), bodyInUrl: z.boolean() }),
  z.object({
    result: z.literal('refiltered'),
    title: z.string(),
    body: z.string(),
    counts: RedactionCounts,
  }),
]);
export type SystemFeedbackPrepared = z.infer<typeof SystemFeedbackPrepared>;
export const MarkSystemFeedbackForwardedRequest = z.object({
  issueUrl: z.string().trim().min(1).optional(),
});
export type MarkSystemFeedbackForwardedRequest = z.infer<typeof MarkSystemFeedbackForwardedRequest>;
