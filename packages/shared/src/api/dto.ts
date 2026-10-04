import { z } from 'zod';
import { BoardPlacement } from '../domain/board-order';
import { DutyId } from '../domain/duty';
import { ChatItem } from '../chat/chat';
import { AutoCompactWindowTokens, MemberSchedule, ProjectConfig, RepoConfig } from '../config/schema';
import { TimelineEvent } from '../domain/event';
import { InboxItem } from '../domain/inbox';
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
import { Task, TaskKey, TaskKind, Visibility } from '../domain/task';

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

/* ---------- providers ---------- */

/** Why a provider is not usable (PM-324); only with `loggedIn === false`. */
export const ProviderProblem = z.enum(['not_logged_in', 'no_key', 'cli_too_old', 'cli_missing']);
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
export const ProvidersView = z.object({ providers: z.array(ProviderLoginStatus) });
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
});
export type TaskDetail = z.infer<typeof TaskDetail>;

export const CreateTaskRequest = z.object({
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
  parentKey: TaskKey.nullable().optional(),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  stageId: StageId.optional(),
  labels: z.array(z.string()).optional(),
  visibility: Visibility.optional(),
  /** Owner/admin only; null clears the assignee. Starting work is a separate call. */
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
    code: z.enum(['gate_blocked', 'handover_uncommitted', 'no_approver']),
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

/** An existing account accepts with an empty body and its login cookie. */
export const AcceptInviteRequest = z.object({
  name: SetupRequest.shape.name.trim().min(1).optional(),
  password: SetupRequest.shape.password.optional(),
});
export type AcceptInviteRequest = z.infer<typeof AcceptInviteRequest>;
