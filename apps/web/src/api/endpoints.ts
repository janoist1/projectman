import {
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
  SessionDetail,
  SetupStatus,
  TaskDetail,
  TeamMessagesView,
  TemplateSummary,
  routes,
} from '@projectman/shared';
import type {
  SendTeamMessageRequest,
  PatchConfigRequest,
  CreateInviteRequest,
  AcceptInviteRequest,
  CustomRoleRequest,
  UpdateMemberRequest,
  UpdateTaskRequest,
  CancelTaskRequest,
  CreateProjectRequest,
  CreateTaskRequest,
  HireMemberRequest,
  LoginRequest,
  ResolveInboxRequest,
  RetireMemberRequest,
  RevertConfigRequest,
  SendMessageRequest,
  SetupRequest,
  StartTaskRequest,
} from '@projectman/shared';
import { apiRequest, unwrapList } from './client';

/**
 * One function per route in the shared route table. Read endpoints validate their
 * responses against the shared DTOs (in development); mutation responses are not part of
 * the contract yet, so callers refetch instead of relying on them.
 */
export const api = {
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

  templates: async () => {
    const path = routes.templates();
    return unwrapList(await apiRequest<unknown>(path), 'templates', TemplateSummary, path);
  },
  projects: async () => {
    const path = routes.projects();
    return unwrapList(await apiRequest<unknown>(path), 'projects', ProjectSummary, path);
  },
  createProject: (body: CreateProjectRequest) =>
    apiRequest<unknown>(routes.projects(), { method: 'POST', body }),

  board: (key: string) => apiRequest(routes.board(key), { schema: BoardView }),
  task: (key: string, taskKey: string) => apiRequest(routes.task(key, taskKey), { schema: TaskDetail }),
  createTask: (key: string, body: CreateTaskRequest) =>
    apiRequest<unknown>(routes.tasks(key), { method: 'POST', body }),
  startTask: (key: string, taskKey: string, body: StartTaskRequest) =>
    apiRequest<unknown>(routes.startTask(key, taskKey), { method: 'POST', body }),

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
  reopenTask: (key: string, taskKey: string) =>
    apiRequest<unknown>(routes.reopenTask(key, taskKey), { method: 'POST', body: {} }),

  members: async (key: string) => {
    const path = routes.members(key);
    return unwrapList(await apiRequest<unknown>(path), 'members', MemberView, path);
  },
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
  teamMessages: (key: string, threadWith?: string, unreadOnly = false) =>
    apiRequest(
      `${routes.teamMessages(key)}${threadWith ? `?threadWith=${encodeURIComponent(threadWith)}` : unreadOnly ? '?unreadOnly=true' : ''}`,
      { schema: TeamMessagesView },
    ),

  /** Every state (the server defaults to open items): resolved ones feed the history lists. */
  inbox: (key: string) => apiRequest(`${routes.inbox(key)}?state=all`, { schema: InboxView }),
  resolveInbox: (key: string, itemId: string, body: ResolveInboxRequest) =>
    apiRequest<unknown>(routes.resolveInbox(key, itemId), { method: 'POST', body }),

  config: (key: string) => apiRequest(routes.config(key), { schema: ConfigView }),
  patchConfig: (key: string, body: PatchConfigRequest) =>
    apiRequest(routes.patchConfig(key), { method: 'PATCH', body, schema: ConfigView }),
  revertConfig: (key: string, body: RevertConfigRequest) =>
    apiRequest<unknown>(routes.revertConfig(key), { method: 'POST', body }),
};
