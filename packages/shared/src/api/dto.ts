import { z } from 'zod';
import { DutyId } from '../domain/duty';
import { ChatItem } from '../chat/chat';
import { MemberSchedule, ProjectConfig, RepoConfig } from '../config/schema';
import { TimelineEvent } from '../domain/event';
import { InboxItem } from '../domain/inbox';
import {
  AgentProvider,
  AgentEffort,
  GithubLogin,
  HumanAccess,
  MemberHandle,
  MemberKind,
  MemberStatus,
  PermissionMode,
} from '../domain/member';
import { TeamMessage } from '../domain/message';
import { BoardColumn, CheckName, CheckState, Stage, StageId } from '../domain/pipeline';
import { CustomRoleDefinition, RoleHolders, RoleId } from '../domain/role';
import { Session } from '../domain/session';
import { Task, TaskKey, Visibility } from '../domain/task';

/* ---------- auth ---------- */

export const SetupRequest = z.object({
  name: z.string().min(1),
  email: z.string().min(3),
  password: z.string().min(8),
});
export type SetupRequest = z.infer<typeof SetupRequest>;

export const LoginRequest = z.object({ email: z.string().min(3), password: z.string().min(1) });
export type LoginRequest = z.infer<typeof LoginRequest>;

export const Me = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  /** Member handle of this user per project key. */
  handles: z.record(z.string(), MemberHandle),
  projects: z
    .array(z.object({ key: z.string(), name: z.string(), access: HumanAccess, roles: z.array(RoleId) }))
    .default([]),
});
export type Me = z.infer<typeof Me>;

export const SetupStatus = z.object({ needsSetup: z.boolean() });
export type SetupStatus = z.infer<typeof SetupStatus>;

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
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;

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
  sponsor: MemberHandle.nullable(),
  temp: z.boolean(),
  /** AI members only: the agent CLI the member runs in. */
  provider: AgentProvider.optional(),
  /** AI members only: public session settings, available to every project member. */
  model: z.string().optional(),
  permissionMode: PermissionMode.optional(),
  effort: AgentEffort.optional(),
});
export type MemberView = z.infer<typeof MemberView>;

/** Hires an AI member for a role an AI may hold (built-in or custom). */
export const HireMemberRequest = z.object({
  effort: AgentEffort.optional(),
  role: RoleId,
  displayName: z.string().min(1).optional(),
  handle: MemberHandle.optional(),
  specialty: z.string().optional(),
  model: z.string().optional(),
  schedule: MemberSchedule.optional(),
  /** The agent CLI the member runs in (default "claude"). */
  provider: AgentProvider.optional(),
});
export type HireMemberRequest = z.infer<typeof HireMemberRequest>;

/** PATCH of a member; omitted fields stay as they are. */
export const UpdateMemberRequest = z.object({
  access: HumanAccess.optional(),
  provider: AgentProvider.optional(),
  /** AI only; null restores the provider default. */
  effort: AgentEffort.nullable().optional(),
  displayName: z.string().trim().min(1).optional(),
  /** Humans only: the roles they hold (replaces the list). An AI member holds exactly one role. */
  roles: z.array(RoleId).optional(),
  /** AI only; an empty string removes it. */
  specialty: z.string().optional(),
  /** AI only. */
  model: z.string().trim().min(1).optional(),
  /** AI only; null removes the schedule. */
  schedule: MemberSchedule.nullable().optional(),
});
export type UpdateMemberRequest = z.infer<typeof UpdateMemberRequest>;

export const RetireMemberRequest = z.object({ handoverTo: MemberHandle.optional() });
export type RetireMemberRequest = z.infer<typeof RetireMemberRequest>;

/* ---------- roles ---------- */

/** A role of the catalogue: built-in texts come in the project's language (English fallback). */
export const RoleView = z.object({
  id: RoleId,
  name: z.string(),
  summary: z.string(),
  notTheirJob: z.string(),
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

export const BoardView = z.object({
  project: ProjectSummary,
  columns: z.array(BoardColumnView),
  stages: z.array(Stage),
  tasks: z.array(Task),
  members: z.array(MemberView),
  openInboxCount: z.number().int(),
  planUsage: PlanUsage.nullable(),
  /** Usage snapshots for the providers used by this project. */
  planUsageByProvider: z.partialRecord(AgentProvider, PlanUsage.nullable()).default({}),
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
  task: Task,
  timeline: z.array(TimelineEvent),
  pullRequests: z.array(TaskPullRequest).default([]),
  sessions: z.array(Session),
});
export type TaskDetail = z.infer<typeof TaskDetail>;

export const CreateTaskRequest = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  stageId: StageId.optional(),
  repo: z.string().nullable().optional(),
  labels: z.array(z.string()).optional(),
  visibility: Visibility.optional(),
});
export type CreateTaskRequest = z.infer<typeof CreateTaskRequest>;

export const UpdateTaskRequest = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  stageId: StageId.optional(),
  labels: z.array(z.string()).optional(),
  visibility: Visibility.optional(),
  /** Owner/admin only; null clears the assignee. Starting work is a separate call. */
  assignee: MemberHandle.nullable().optional(),
});
export type UpdateTaskRequest = z.infer<typeof UpdateTaskRequest>;

export const CreateTaskCommentRequest = z.object({
  text: z.string().trim().min(1).max(10000),
  importedAuthor: z.string().trim().min(1).max(80).optional(),
  importedAt: z.iso.datetime({ offset: true }).optional(),
});
export type CreateTaskCommentRequest = z.infer<typeof CreateTaskCommentRequest>;

export const SetTaskCheckRequest = z.object({
  check: CheckName,
  state: CheckState,
  note: z.string().optional(),
});
export type SetTaskCheckRequest = z.infer<typeof SetTaskCheckRequest>;

export const CancelTaskRequest = z.object({ reason: z.string().optional() });
export type CancelTaskRequest = z.infer<typeof CancelTaskRequest>;

export const ReopenTaskRequest = z.object({});
export type ReopenTaskRequest = z.infer<typeof ReopenTaskRequest>;

export const StartTaskRequest = z.object({
  /** Developer to assign; omitted = the scheduler picks a free developer (or a temp worker). */
  assignee: MemberHandle.optional(),
});
export type StartTaskRequest = z.infer<typeof StartTaskRequest>;

/* ---------- sessions & messages ---------- */

export const SessionDetail = z.object({
  session: Session,
  chat: z.array(ChatItem),
  task: Task.nullable(),
});
export type SessionDetail = z.infer<typeof SessionDetail>;

export const SendMessageRequest = z.object({ text: z.string().min(1) });
export type SendMessageRequest = z.infer<typeof SendMessageRequest>;

export const TeamMessagesView = z.object({
  messages: z.array(TeamMessage),
  unreadCount: z.number().int().nonnegative().optional(),
});
export type TeamMessagesView = z.infer<typeof TeamMessagesView>;

/* ---------- inbox ---------- */

export const InboxView = z.object({ items: z.array(InboxItem) });
export type InboxView = z.infer<typeof InboxView>;

export const ResolveInboxRequest = z.object({ optionId: z.string(), note: z.string().optional() });
export type ResolveInboxRequest = z.infer<typeof ResolveInboxRequest>;

/* ---------- configuration ---------- */

export const ConfigVersionEntry = z.object({
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

/** An existing account accepts with an empty body and its login cookie. */
export const AcceptInviteRequest = z.object({
  name: SetupRequest.shape.name.trim().min(1).optional(),
  password: SetupRequest.shape.password.optional(),
});
export type AcceptInviteRequest = z.infer<typeof AcceptInviteRequest>;

/** Subscription login status of each supported runner provider. */
export const ProviderLoginStatus = z.object({
  provider: AgentProvider,
  loggedIn: z.boolean().nullable(),
  method: z.string().nullable(),
  checkedAt: z.string(),
  detail: z.string().optional(),
});
export type ProviderLoginStatus = z.infer<typeof ProviderLoginStatus>;
export const ProvidersView = z.object({ providers: z.array(ProviderLoginStatus) });
export type ProvidersView = z.infer<typeof ProvidersView>;

export const SendTeamMessageRequest = z.object({
  to: z.array(MemberHandle).min(1).max(100),
  text: z.string().trim().min(1).max(20000),
  taskKey: TaskKey.optional(),
});
export type SendTeamMessageRequest = z.infer<typeof SendTeamMessageRequest>;

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
});
export type MemberProfile = z.infer<typeof MemberProfile>;
export const MemberMemories = z.object({ memory: z.string() });
export type MemberMemories = z.infer<typeof MemberMemories>;
