import { z } from 'zod';
import { BoardPlacement } from '../domain/board-order';
import { DEVELOPER_LEVEL_REASON_MAX, DeveloperLevel } from '../domain/developer-level';
import { DutyId } from '../domain/duty';
import { ChatItem } from '../chat/chat';
import { AutoCompactWindowTokens, MemberSchedule, ProjectConfig, RepoConfig } from '../config/schema';
import { ConfigChangeRow } from '../config/operator';
import { PatchConfigRequest } from '../config/edit';
import { ERROR_CODES } from './error-codes';
import { TaskWait } from '../config/task-wait';
import { TimelineEvent } from '../domain/event';
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
import { TeamMessage } from '../domain/message';
import { LabelDefinition, LabelId } from '../domain/label';
import { ProjectPauseView } from '../domain/pause';
import { BoardColumn, GateCondition, Stage, StageId } from '../domain/pipeline';
import { CustomRoleDefinition, RoleHolders, RoleId } from '../domain/role';
import { ScheduleRun } from '../domain/schedule';
import { Session, TaskWork } from '../domain/session';
import { CardRounds } from '../domain/card-measure';
import { MemberUsage } from '../domain/token-usage';
import { AddRelationRef, RelationsChange } from '../domain/relations';
import { Task, TaskKey, TaskKind, TaskPriority, TaskStartWaiting, Visibility } from '../domain/task';

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
  'config_revert',
  'session_stop',
  'project_pause',
  'project_resume',
]);
export type OperatorAction = z.infer<typeof OperatorAction>;
export const OperatorStepStatus = z.enum([
  'done',
  'awaiting_approval',
  'approved',
  'rejected',
  'stale',
  'refused',
]);
export type OperatorStepStatus = z.infer<typeof OperatorStepStatus>;
export const OperatorStep = z.object({
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
/** The Operator's conversation as the project manager's, plus the last 50 requests (the newest last). */
export const OperatorChannel = ProjectManagerChannel.extend({ requests: z.array(OperatorRequestView) });
export type OperatorChannel = z.infer<typeof OperatorChannel>;

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
export const IntegratorKeyResponse = z.object({ key: IntegratorKeyInfo.nullable() });
export type IntegratorKeyResponse = z.infer<typeof IntegratorKeyResponse>;
export const CreateIntegratorKeyRequest = z.object({
  expiresInDays: z.union([z.literal(30), z.literal(90), z.literal(365), z.null()]).default(90),
});
export const CreatedIntegratorKey = z.object({ key: IntegratorKeyInfo, secret: z.string() });
export type CreatedIntegratorKey = z.infer<typeof CreatedIntegratorKey>;

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

export const Me = z.object({
  hostOwner: z.boolean().optional(),
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
   * The user may manage the instance as a whole (`canManageInstancePause` on every project):
   * they see the machine display. Absent (an older server): false.
   */
  instanceOwner: z.boolean().optional(),
});
export type Me = z.infer<typeof Me>;

export const SetupStatus = z.object({
  needsSetup: z.boolean(),
  /** `cloud` mode with no user yet: the setup form asks for the code from the server log (PM-317). */
  needsSetupCode: z.boolean().optional(),
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
  templateId: z.string(),
  /** Repositories of the workspace; templates start without any (they can also be added later in the config). */
  repos: z.array(RepoConfig).optional(),
  /** Who moves the cards on; absent means `worker`. `creator` makes the creating human the mover. */
  cardMover: z.enum(['worker', 'project_manager', 'creator']).optional(),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;

/** What `POST /api/projects/preview` answers: the configuration a create would save and its issues. */
export const ProjectPreview = z.object({
  config: ProjectConfig,
  /** The fields of `ConfigIssue`; an absent severity is an error. */
  issues: z.array(
    z.object({
      code: z.string(),
      severity: z.enum(['error', 'warning']).optional(),
      path: z.string(),
      detail: z.string().optional(),
    }),
  ),
});
export type ProjectPreview = z.infer<typeof ProjectPreview>;

export const TemplateSummary = z.object({
  id: z.string(),
  /** i18n keys; the web app translates them. */
  nameKey: z.string(),
  descriptionKey: z.string(),
  memberCount: z.object({ human: z.number().int(), ai: z.number().int() }),
  stageCount: z.number().int(),
});
export type TemplateSummary = z.infer<typeof TemplateSummary>;

/* ---------- members ---------- */

export const MemberView = z.object({
  outage: WorkOutage.optional(),
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
  currentTaskKeys: z.array(TaskKey),
  /**
   * AI members only: the work the member does on cards right now, one entry per working task session
   * (PM-207). A card is "working" only when it has an entry here; `status` and `activity` describe the
   * member as a whole. Omitted: none (and by older servers).
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
   * always fills it in (a member without the setting reads `true`); a missing value (an older server,
   * a test fake) is read as on.
   */
  outboundNetwork: z.boolean().optional(),
  /**
   * The team's Senior (PM-347, `isSenior`): an AI member marked so, and not a temp worker. The server
   * always fills it in; a missing value (an older server, a test fake) is `false`.
   */
  senior: z.boolean().optional(),
});
export type MemberView = z.infer<typeof MemberView>;

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
  access: HumanAccess.optional(),
  provider: AgentProvider.optional(),
  /** AI only; null restores the provider default. */
  effort: AgentEffort.nullable().optional(),
  /** AI only; the compaction window in tokens (PM-212), null falls back to the project's. */
  autoCompactWindowTokens: AutoCompactWindowTokens.nullable().optional(),
  /** AI only, owner only (PM-355): whether the member's commands can reach the network. */
  outboundNetwork: z.boolean().optional(),
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
  /** AI only, not a temp worker (PM-347); true marks the member as the team's Senior, false removes the mark. */
  senior: z.boolean().optional(),
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
export const OperatorOperation = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('config_patch'),
    patch: PatchConfigRequest.omit({ baseVersion: true, message: true }),
  }),
  z.object({ op: z.literal('member_update'), handle: MemberHandle, changes: OperatorMemberChanges }),
  z.object({ op: z.literal('member_hire'), request: HireMemberRequest }),
  z.object({ op: z.literal('member_retire'), handle: MemberHandle }),
  z.object({ op: z.literal('config_revert'), version: z.string() }),
  z.object({ op: z.literal('session_stop'), sessionId: z.string() }),
  z.object({ op: z.literal('project_pause') }),
  z.object({ op: z.literal('project_resume') }),
]);
export type OperatorOperation = z.infer<typeof OperatorOperation>;
export const OperatorConsequence = z.enum([
  'network',
  'permission_mode',
  'pipeline',
  'labels',
  'member_hire',
  'member_retire',
  'member_other',
  'locations',
  'fix_limit',
  'session_stop',
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
  stale: z
    .object({ reason: z.enum(['config_changed', 'session_changed', 'pause_changed']), at: z.string() })
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
  email: z.string().optional(),
  /** AI members: the tokens their sessions used lately (PM-178); omitted for humans and by older servers. */
  usage: MemberUsage.optional(),
});
export type MemberProfile = z.infer<typeof MemberProfile>;
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
  /** When to turn to a member holding the role; omitted by older servers. */
  whenToAsk: z.string().optional(),
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
  /** Public project admission switch; omitted by older servers. */
  aiEnabled: z.boolean().optional(),
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
  /** The open pauses touching the project (PM-219); absent for a client member. */
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
  /** Review rounds and send-backs counted from the whole timeline (PM-222); not shared with clients. */
  rounds: CardRounds.optional(),
  /** The fix rounds since the count began and the project's limit (PM-262); not shared with clients. */
  fixRounds: z
    .object({ rounds: z.number().int().nonnegative(), limit: z.number().int().positive() })
    .optional(),
  /** Why the card stands still (PM-460), for the viewer; null for a closed card; not shared with clients. */
  wait: TaskWait.nullable().optional(),
});
export type TaskDetail = z.infer<typeof TaskDetail>;

/**
 * The recommended developer in a request (PM-347). The reason is required for `senior` (checked by the
 * server: `developer_level_reason_required`); an empty one counts as none.
 */
export const DeveloperLevelRequest = z.object({
  level: DeveloperLevel,
  reason: z.string().trim().max(DEVELOPER_LEVEL_REASON_MAX).nullable().optional(),
});
export type DeveloperLevelRequest = z.infer<typeof DeveloperLevelRequest>;

export const CreateTaskRequest = z.object({
  /** The developer the card is recommended for (PM-347); only whoever `canSetDeveloperLevel` may send it. */
  developerLevel: DeveloperLevelRequest.optional(),
  parentKey: TaskKey.optional(),
  importedAt: z.string().datetime().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  stageId: StageId.optional(),
  repo: z.string().nullable().optional(),
  labels: z.array(z.string()).optional(),
  visibility: Visibility.optional(),
  /** Relations the new card starts with (PM-192); a refused one refuses the creation. */
  relations: z.array(AddRelationRef).optional(),
  /** `theme` creates a theme (PM-192); absent: a task. A theme takes no stage, repository, parent or theme of its own (plain labels are allowed). */
  kind: TaskKind.optional(),
  /** The theme the new card belongs to (not for a theme or a subtask). */
  themeKey: TaskKey.optional(),
});
export type CreateTaskRequest = z.infer<typeof CreateTaskRequest>;

export const UpdateTaskRequest = z.object({
  /** The developer the card is recommended for (PM-347); only whoever `canSetDeveloperLevel` may send it. */
  developerLevel: DeveloperLevelRequest.optional(),
  /** People only (PM-287); null clears it. */
  priority: TaskPriority.nullable().optional(),
  parentKey: TaskKey.nullable().optional(),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  stageId: StageId.optional(),
  labels: z.array(z.string()).optional(),
  visibility: Visibility.optional(),
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

export const SendTeamMessageRequest = z.object({
  to: z.array(MemberHandle).min(1).max(100),
  text: z.string().trim().min(1).max(20000),
  taskKey: TaskKey.optional(),
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

export const ResolveInboxRequest = z.object({ optionId: z.string(), note: z.string().optional() });
export type ResolveInboxRequest = z.infer<typeof ResolveInboxRequest>;

/* ---------- configuration ---------- */

export const ConfigVersionEntry = z.object({
  operator: MemberHandle.optional(),
  request: z.string().optional(),
  approvedBy: MemberHandle.optional(),
  via: z.literal('integrator').optional(),
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
});
export type PublicInviteView = z.infer<typeof PublicInviteView>;

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
