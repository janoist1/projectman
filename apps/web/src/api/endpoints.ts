import {
  AttachmentListResponse,
  BoundaryRequest,
  BoundaryRequestView,
  ChangeTaskLabelsRequest,
  DeleteAttachmentResponse,
  TaskCoverResponse,
  UploadAttachmentResponse,
  ClosedCardsMeasure,
  MemberProfile,
  MemberMemories,
  Session,
  TeamMessage,
  ProvidersView,
  CreatedInvitation,
  InvitationsView,
  PublicInviteView,
  RolesView,
  BoardView,
  ConfigView,
  InboxView,
  Me,
  MemberView,
  ProjectSummary,
  ScheduleRun,
  SchedulesView,
  SessionDetail,
  SetupStatus,
  TaskDetail,
  TeamMessagesView,
  TeamThreadsView,
  TemplateSummary,
  routes,
} from '@projectman/shared';
import type {
  SendTeamMessageRequest,
  DecideBoundaryRequest,
  PatchConfigRequest,
  CreateInviteRequest,
  AcceptInviteRequest,
  CustomRoleRequest,
  UpdateMemberRequest,
  UpdateSessionRequest,
  UpdateTaskRequest,
  TaskCoverRequest,
  CancelTaskRequest,
  CreateProjectRequest,
  CreateTaskRequest,
  HireMemberRequest,
  AddHumanMemberRequest,
  LoginRequest,
  ResolveInboxRequest,
  RetireMemberRequest,
  RevertConfigRequest,
  SendMessageRequest,
  SetupRequest,
  StartTaskRequest,
  CreateTaskCommentRequest,
} from '@projectman/shared';
import { apiRequest } from './client';

/**
 * One function per route in the shared route table. Responses with a shared DTO are validated
 * against it (in development); mutations without one resolve to unknown, and their callers
 * refetch instead of relying on the body.
 */
export const api = {
  boundaryRequest: (key: string, id: string) =>
    apiRequest(routes.boundaryRequest(key, id), { schema: BoundaryRequestView }),
  decideBoundary: (key: string, id: string, body: DecideBoundaryRequest) =>
    apiRequest(routes.decideBoundary(key, id), { method: 'POST', body, schema: BoundaryRequest }),
  revokeBoundary: (key: string, id: string) =>
    apiRequest(routes.revokeBoundary(key, id), { method: 'POST', schema: BoundaryRequest }),
  addHumanMember: (key: string, body: AddHumanMemberRequest) =>
    apiRequest(routes.addHumanMember(key), { method: 'POST', body, schema: MemberView }),
  providers: () => apiRequest(routes.providers(), { schema: ProvidersView }),
  setupStatus: () => apiRequest(routes.setupStatus(), { schema: SetupStatus }),
  setup: (body: SetupRequest) => apiRequest<unknown>(routes.setup(), { method: 'POST', body }),
  login: (body: LoginRequest) => apiRequest<unknown>(routes.login(), { method: 'POST', body }),
  logout: () => apiRequest<unknown>(routes.logout(), { method: 'POST' }),
  me: () => apiRequest(routes.me(), { schema: Me }),

  invitations: (key: string) => apiRequest(routes.invitations(key), { schema: InvitationsView }),
  createInvite: (key: string, body: CreateInviteRequest) =>
    apiRequest(routes.invitations(key), { method: 'POST', body, schema: CreatedInvitation }),
  revokeInvite: (key: string, id: string) =>
    apiRequest<unknown>(routes.invitation(key, id), { method: 'DELETE' }),
  invite: (token: string) => apiRequest(routes.invite(token), { schema: PublicInviteView }),
  acceptInvite: (token: string, body: AcceptInviteRequest) =>
    apiRequest(routes.acceptInvite(token), { method: 'POST', body, schema: Me }),

  templates: () => apiRequest(routes.templates(), { schema: TemplateSummary.array() }),
  projects: () => apiRequest(routes.projects(), { schema: ProjectSummary.array() }),
  createProject: (body: CreateProjectRequest) =>
    apiRequest<unknown>(routes.projects(), { method: 'POST', body }),

  board: (key: string) => apiRequest(routes.board(key), { schema: BoardView }),
  createTaskComment: (key: string, taskKey: string, body: CreateTaskCommentRequest) =>
    apiRequest(routes.taskComments(key, taskKey), { method: 'POST', body, schema: TaskDetail }),
  changeTaskLabels: (key: string, taskKey: string, body: ChangeTaskLabelsRequest) =>
    apiRequest(routes.taskLabels(key, taskKey), { method: 'POST', body, schema: TaskDetail }),
  task: (key: string, taskKey: string) => apiRequest(routes.task(key, taskKey), { schema: TaskDetail }),
  createTask: (key: string, body: CreateTaskRequest) =>
    apiRequest<unknown>(routes.tasks(key), { method: 'POST', body }),
  startTask: (key: string, taskKey: string, body: StartTaskRequest) =>
    apiRequest<unknown>(routes.startTask(key, taskKey), { method: 'POST', body }),

  attachments: (key: string, taskKey: string) =>
    apiRequest(routes.taskAttachments(key, taskKey), { schema: AttachmentListResponse }),
  /** One file per request, as the route takes it (multipart field "file"). */
  uploadAttachment: (key: string, taskKey: string, file: File, signal?: AbortSignal) => {
    const body = new FormData();
    body.append('file', file, file.name);
    return apiRequest(routes.taskAttachments(key, taskKey), {
      method: 'POST',
      body,
      schema: UploadAttachmentResponse,
      signal,
    });
  },
  setTaskCover: (key: string, taskKey: string, body: TaskCoverRequest) =>
    apiRequest(routes.taskCover(key, taskKey), { method: 'PUT', body, schema: TaskCoverResponse }),
  deleteAttachment: (key: string, taskKey: string, id: string) =>
    apiRequest(routes.taskAttachment(key, taskKey, id), {
      method: 'DELETE',
      schema: DeleteAttachmentResponse,
    }),

  roles: (key: string) => apiRequest(routes.roles(key), { schema: RolesView }),
  createRole: (key: string, body: CustomRoleRequest) =>
    apiRequest<unknown>(routes.roles(key), { method: 'POST', body }),
  updateRole: (key: string, id: string, body: CustomRoleRequest) =>
    apiRequest<unknown>(routes.role(key, id), { method: 'PUT', body }),
  deleteRole: (key: string, id: string) => apiRequest<unknown>(routes.role(key, id), { method: 'DELETE' }),
  updateMember: (key: string, handle: string, body: UpdateMemberRequest) =>
    apiRequest<unknown>(routes.member(key, handle), { method: 'PATCH', body }),
  updateTask: (key: string, taskKey: string, body: UpdateTaskRequest) =>
    apiRequest<unknown>(routes.task(key, taskKey), { method: 'PATCH', body }),
  cancelTask: (key: string, taskKey: string, body: CancelTaskRequest) =>
    apiRequest<unknown>(routes.cancelTask(key, taskKey), { method: 'POST', body }),
  closeTheme: (key: string, taskKey: string) =>
    apiRequest<unknown>(routes.closeTheme(key, taskKey), { method: 'POST', body: {} }),
  reopenTask: (key: string, taskKey: string) =>
    apiRequest<unknown>(routes.reopenTask(key, taskKey), { method: 'POST', body: {} }),

  members: (key: string) => apiRequest(routes.members(key), { schema: MemberView.array() }),
  hireMember: (key: string, body: HireMemberRequest) =>
    apiRequest<unknown>(routes.members(key), { method: 'POST', body }),
  retireMember: (key: string, handle: string, body: RetireMemberRequest) =>
    apiRequest<unknown>(routes.member(key, handle), { method: 'DELETE', body }),

  session: (key: string, sessionId: string) =>
    apiRequest(routes.session(key, sessionId), { schema: SessionDetail }),
  sendSessionMessage: (key: string, sessionId: string, body: SendMessageRequest) =>
    apiRequest<unknown>(routes.sessionMessages(key, sessionId), { method: 'POST', body }),
  stopSession: (key: string, sessionId: string) =>
    apiRequest<unknown>(routes.stopSession(key, sessionId), { method: 'POST' }),
  updateSession: (key: string, sessionId: string, body: UpdateSessionRequest) =>
    apiRequest(routes.session(key, sessionId), { method: 'PATCH', body, schema: Session }),

  closedCardsMeasure: (key: string, days: number) =>
    apiRequest(`${routes.closedCardsMeasure(key)}?days=${days}`, { schema: ClosedCardsMeasure }),
  memberProfile: (key: string, handle: string) =>
    apiRequest(routes.memberProfile(key, handle), { schema: MemberProfile }),
  memberMemories: (key: string, handle: string) =>
    apiRequest(routes.memberMemories(key, handle), { schema: MemberMemories }),
  startConversation: (key: string, handle: string) =>
    apiRequest(routes.startConversation(key, handle), { method: 'POST', schema: Session }),
  removeHuman: (key: string, handle: string) =>
    apiRequest<unknown>(routes.removeHuman(key, handle), { method: 'DELETE' }),
  sendTeamMessage: (key: string, body: SendTeamMessageRequest) =>
    apiRequest(routes.sendTeamMessage(key), { method: 'POST', body, schema: TeamMessage }),
  readTeamMessage: (key: string, id: string) =>
    apiRequest(routes.readTeamMessage(key, id), { method: 'POST', schema: TeamMessage }),
  readTeamMessages: (key: string, ids: string[]) =>
    apiRequest(routes.readTeamMessages(key), { method: 'POST', body: { ids }, schema: TeamMessagesView }),
  teamThreads: (key: string) => apiRequest(routes.teamThreads(key), { schema: TeamThreadsView }),
  /** One conversation with `peer` (the server's page limit) or the project's messages under the filters. */
  teamMessageList: (
    key: string,
    params: { threadWith?: string; member?: string; taskKey?: string; unreadOnly?: boolean },
  ) => {
    const query = new URLSearchParams({ limit: '500' });
    if (params.threadWith) query.set('threadWith', params.threadWith);
    if (params.member) query.set('member', params.member);
    if (params.taskKey) query.set('taskKey', params.taskKey);
    if (params.unreadOnly) query.set('unreadOnly', 'true');
    return apiRequest(`${routes.teamMessages(key)}?${query}`, { schema: TeamMessagesView });
  },
  teamMessages: (key: string, threadWith?: string, unreadOnly = false) =>
    apiRequest(
      `${routes.teamMessages(key)}${threadWith ? `?threadWith=${encodeURIComponent(threadWith)}` : unreadOnly ? '?unreadOnly=true' : ''}`,
      { schema: TeamMessagesView },
    ),

  /** Every state (the server defaults to open items): resolved ones feed the history lists. */
  inbox: (key: string) => apiRequest(`${routes.inbox(key)}?state=all`, { schema: InboxView }),
  resolveInbox: (key: string, itemId: string, body: ResolveInboxRequest) =>
    apiRequest<unknown>(routes.resolveInbox(key, itemId), { method: 'POST', body }),

  schedules: (key: string) => apiRequest(routes.schedules(key), { schema: SchedulesView }),
  runSchedule: (key: string, handle: string) =>
    apiRequest(routes.runSchedule(key, handle), { method: 'POST', schema: ScheduleRun }),

  config: (key: string) => apiRequest(routes.config(key), { schema: ConfigView }),
  patchConfig: (key: string, body: PatchConfigRequest) =>
    apiRequest(routes.patchConfig(key), { method: 'PATCH', body, schema: ConfigView }),
  revertConfig: (key: string, body: RevertConfigRequest) =>
    apiRequest<unknown>(routes.revertConfig(key), { method: 'POST', body }),
};
