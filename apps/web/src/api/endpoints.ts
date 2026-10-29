import {
  OwnerInvitationsView,
  CreatedOwnerInvitation,
  OwnerAccountsView,
  OwnerAccountView,
  HostRequestListResponse,
  HostRequestView,
  ProjectChecklistView,
  ServerVersionView,
  EmailChannelView,
  EmailContact,
  EmailLogResponse,
  OperatorGrantAuditPage,
  PushDeviceView,
  PushOverview,
  PushSettings,
  SubscribePushRequest,
  IntegratorAccessKeysResponse,
  IntegratorAccessKeyResponse,
  CreatedIntegratorAccessKey,
  IntegratorKeyAuditPage,
  SuperAuditPage,
  ListSuperHandoffsResponse,
  SuperOperationDetail,
  SuperHandoffDetail,
  OperatorKnowledgeDocument,
  OperatorPreferenceDocument,
  OperatorApprovalWaiverResponse,
  OperatorGrantResponse,
  MemberQueueView,
  EmailLoginCodeRequested,
  CreateEngineResponse,
  EngineProvidersView,
  EngineStatusResponse,
  EngineView,
  ProjectEngineView,
  ProjectEnginesResponse,
  PublicOwnerInviteView,
  MachineView,
  StopOrphansResult,
  AttachmentListResponse,
  BoardMoveResult,
  ChangeTaskLabelsRequest,
  DeleteAttachmentResponse,
  TaskCoverResponse,
  UploadAttachmentResponse,
  UploadMessageAttachmentResponse,
  DeleteMessageAttachmentResponse,
  ClosedCardsMeasure,
  MemberProfile,
  MemberContextPreview,
  MemberMemories,
  Session,
  TeamMessage,
  OperatorSignal,
  ProjectManagerCorner,
  ProvidersView,
  CreatedInvitation,
  InvitationsView,
  PublicInviteView,
  RolesView,
  BoardView,
  CheckOutageResponse,
  ConfigView,
  InboxView,
  InstancePauseView,
  ScreenedQuestionsResponse,
  Me,
  MemberView,
  ProjectPauseView,
  ProjectSummary,
  ScheduleRun,
  SchedulesView,
  SessionDetail,
  SetupStatus,
  TaskDetail,
  TaskHandoffRecord,
  UpdateTaskResponse,
  TeamMessagesView,
  TeamThreadsView,
  routes,
  InvolvementsResponse,
} from '@projectman/shared';
import type {
  CreateOwnerInviteRequest,
  AnswerHostRequestRequest,
  SetChecklistItemStateRequest,
  CreateIntegratorAccessKeyRequest,
  OperatorGrantDuration,
  OperatorApprovalWaiverRequest,
  CloseFeedbackRequest,
  CreateTaskFromFeedbackRequest,
  CreateTaskFromFeedbackResponse,
  FeedbackCommentRequest,
  FeedbackInboxResponse,
  SetEmailContactRequest,
  FeedbackLaunchRequest,
  FeedbackLaunchResponse,
  FeedbackMarkDetail,
  FeedbackSettingsView,
  FeedbackSummary,
  LinkFeedbackRequest,
  StartMergeRequest,
  PrioritizeMergeRequest,
  StopOrphansRequest,
  BoardMoveRequest,
  SendTeamMessageRequest,
  PatchConfigRequest,
  CreateInviteRequest,
  AcceptInviteRequest,
  EmailLoginCodeRequest,
  EmailLoginVerifyRequest,
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
  RenameMemberRequest,
  RetireMemberRequest,
  RevertConfigRequest,
  SendMessageRequest,
  SetupRequest,
  StartTaskRequest,
  CreateTaskCommentRequest,
  Task,
} from '@projectman/shared';
import { apiRequest } from './client';

/**
 * One function per route in the shared route table. Responses with a shared DTO are validated
 * against it (in development); mutations without one resolve to unknown, and their callers
 * refetch instead of relying on the body.
 */
export const api = {
  checklist: (key: string) => apiRequest(routes.projectChecklist(key), { schema: ProjectChecklistView }),
  setChecklistItemState: (key: string, itemId: string, body: SetChecklistItemStateRequest) =>
    apiRequest(routes.projectChecklistItemState(key, itemId), {
      method: 'POST',
      body,
      schema: ProjectChecklistView,
    }),
  serverVersion: () => apiRequest(routes.serverVersion(), { schema: ServerVersionView }),
  operatorGrantAudit: () => apiRequest(routes.operatorGrantAudit(), { schema: OperatorGrantAuditPage }),
  createOperatorGrant: (duration: OperatorGrantDuration) =>
    apiRequest(routes.operatorGrant(), { method: 'POST', body: { duration }, schema: OperatorGrantResponse }),
  revokeOperatorGrant: () =>
    apiRequest(routes.operatorGrant(), { method: 'DELETE', schema: OperatorGrantResponse }),
  /** Web push (PM-815): the signed-in person's own devices and settings. */
  push: () => apiRequest(routes.push(), { schema: PushOverview }),
  savePushSettings: (body: PushSettings) =>
    apiRequest(routes.pushSettings(), { method: 'PUT', body, schema: PushSettings }),
  subscribePush: (body: SubscribePushRequest) =>
    apiRequest(routes.pushDevices(), { method: 'POST', body, schema: PushDeviceView }),
  setPushDeviceEnabled: (id: string, enabled: boolean) =>
    apiRequest(routes.pushDevice(id), { method: 'PATCH', body: { enabled }, schema: PushDeviceView }),
  removePushDevice: (id: string) => apiRequest<null>(routes.pushDevice(id), { method: 'DELETE' }),
  testPushDevice: (id: string) =>
    apiRequest(routes.pushDeviceTest(id), { method: 'POST', body: {}, schema: PushDeviceView }),
  unsubscribePush: (endpoint: string) =>
    apiRequest<null>(routes.pushUnsubscribe(), { method: 'POST', body: { endpoint } }),
  superHandoff: (key: string, id: string) =>
    apiRequest(routes.superHandoff(key, encodeURIComponent(id)), { schema: SuperHandoffDetail }),
  superOperation: (key: string, id: string) =>
    apiRequest(routes.superOperation(key, id), { schema: SuperOperationDetail }),
  integratorKeys: () => apiRequest(routes.integratorKeys(), { schema: IntegratorAccessKeysResponse }),
  createIntegratorAccessKey: (
    mode: 'super' | 'read',
    expiresInDays: CreateIntegratorAccessKeyRequest['expiresInDays'],
  ) =>
    apiRequest(routes.integratorKeys(), {
      method: 'POST',
      body: { mode, expiresInDays },
      schema: CreatedIntegratorAccessKey,
    }),
  revokeIntegratorAccessKey: (id: string) =>
    apiRequest(routes.integratorAccessKey(id), { method: 'DELETE', schema: IntegratorAccessKeyResponse }),
  integratorKeyAudit: (before?: number) =>
    apiRequest(`${routes.integratorKeyAudit()}?limit=50${before === undefined ? '' : `&before=${before}`}`, {
      schema: IntegratorKeyAuditPage,
    }),
  superAudit: (key: string, prefix: string, before: string) =>
    apiRequest(
      `${routes.operatorSuperAudit(key)}?limit=50${prefix ? `&prefix=${encodeURIComponent(prefix)}` : ''}${before ? `&before=${encodeURIComponent(before)}` : ''}`,
      { schema: SuperAuditPage },
    ),
  superHandoffs: (key: string, pending = false) =>
    apiRequest(`${routes.superHandoffs(key)}?limit=50${pending ? '&state=pending' : ''}`, {
      schema: ListSuperHandoffsResponse,
    }),
  involvements: (key: string, query = '') =>
    apiRequest(routes.involvements(key) + query, { schema: InvolvementsResponse }),
  machine: (panel: boolean, signal?: AbortSignal) =>
    apiRequest(`${routes.machine()}${panel ? '?panel=1' : ''}`, { schema: MachineView, signal }),
  /** Hybrid mode (PM-316): `single` on a one-machine installation, else the engines the viewer may see. */
  engineStatus: () => apiRequest(routes.engineStatus(), { schema: EngineStatusResponse }),
  engines: () => apiRequest(routes.engines(), { schema: EngineView.array() }),
  createEngine: (name: string) =>
    apiRequest(routes.engines(), { method: 'POST', body: { name }, schema: CreateEngineResponse }),
  revokeEngine: (id: string) =>
    apiRequest(routes.revokeEngine(id), { method: 'POST', body: {}, schema: EngineView }),
  defaultEngine: (id: string) =>
    apiRequest(routes.defaultEngine(id), { method: 'POST', body: {}, schema: EngineView.array() }),
  /** The provider logins on one engine's machine (PM-1077); `refresh` asks the machine again. */
  engineProviders: (id: string, refresh = false) =>
    apiRequest(`${routes.engineProviders(id)}${refresh ? '?refresh=1' : ''}`, {
      schema: EngineProvidersView,
    }),
  projectEngines: (key: string) => apiRequest(routes.projectEngines(key), { schema: ProjectEnginesResponse }),
  /** PM-1077: the engine's owner renames it. */
  renameEngine: (id: string, name: string) =>
    apiRequest(routes.engine(id), { method: 'PATCH', body: { name }, schema: EngineView }),
  /** PM-1060: binds the engine to the project; `isDefault` also makes it the project's base engine. */
  bindProjectEngine: (key: string, engineId: string, isDefault: boolean) =>
    apiRequest(routes.projectEngine(key, engineId), {
      method: 'PUT',
      body: isDefault ? { default: true } : {},
      schema: ProjectEngineView,
    }),
  unbindProjectEngine: (key: string, engineId: string) =>
    apiRequest<null>(routes.projectEngine(key, engineId), { method: 'DELETE' }),
  stopOrphans: (body: StopOrphansRequest) =>
    apiRequest(routes.machineOrphansStop(), { method: 'POST', body, schema: StopOrphansResult }),
  addHumanMember: (key: string, body: AddHumanMemberRequest) =>
    apiRequest(routes.addHumanMember(key), { method: 'POST', body, schema: MemberView }),
  providers: () => apiRequest(routes.providers(), { schema: ProvidersView }),
  setNanogptKey: (key: string) =>
    apiRequest(routes.nanogptKey(), { method: 'PUT', body: { key }, schema: ProvidersView }),
  deleteNanogptKey: () => apiRequest(routes.nanogptKey(), { method: 'DELETE', schema: ProvidersView }),
  setupStatus: () => apiRequest(routes.setupStatus(), { schema: SetupStatus }),
  setup: (body: SetupRequest) => apiRequest<unknown>(routes.setup(), { method: 'POST', body }),
  login: (body: LoginRequest) => apiRequest<unknown>(routes.login(), { method: 'POST', body }),
  requestEmailLoginCode: (body: EmailLoginCodeRequest) =>
    apiRequest(routes.emailLoginRequest(), { method: 'POST', body, schema: EmailLoginCodeRequested }),
  verifyEmailLogin: (body: EmailLoginVerifyRequest) =>
    apiRequest(routes.emailLoginVerify(), { method: 'POST', body, schema: Me }),
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
  ownerInvite: (token: string) => apiRequest(routes.ownerInvite(token), { schema: PublicOwnerInviteView }),
  acceptOwnerInvite: (token: string, body: AcceptInviteRequest) =>
    apiRequest(routes.acceptOwnerInvite(token), { method: 'POST', body, schema: Me }),

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
    apiRequest(routes.startTask(key, taskKey), { method: 'POST', body, schema: TaskDetail }),
  /** The merger starts the merge of the card's approved work into the main branch (PM-452). */
  startMerge: (key: string, taskKey: string, body?: StartMergeRequest) =>
    apiRequest<{ task: Task }>(routes.taskMerge(key, taskKey), { method: 'POST', body }),
  /** The merger or an owner puts the card's queued merge at the front of the queue (PM-576). */
  prioritizeMerge: (key: string, taskKey: string, body: PrioritizeMergeRequest) =>
    apiRequest<{ task: Task; moved: boolean }>(routes.taskMergePrioritize(key, taskKey), {
      method: 'POST',
      body,
    }),

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
    apiRequest(routes.task(key, taskKey), { method: 'PATCH', body, schema: UpdateTaskResponse }),
  /** A closed handoff of the card with its note or summary (PM-342). */
  taskHandoff: (key: string, taskKey: string, handoffId: string) =>
    apiRequest(routes.taskHandoff(key, taskKey, handoffId), { schema: TaskHandoffRecord }),
  /** A card dropped on the board: a place in a column (PM-118). */
  boardMoveTask: (key: string, taskKey: string, body: BoardMoveRequest) =>
    apiRequest(routes.boardMoveTask(key, taskKey), { method: 'POST', body, schema: BoardMoveResult }),
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
  renameMember: (key: string, handle: string, body: RenameMemberRequest) =>
    apiRequest(routes.memberRename(key, handle), { method: 'POST', body, schema: MemberView }),

  session: (key: string, sessionId: string) =>
    apiRequest(routes.session(key, sessionId), { schema: SessionDetail }),
  sendSessionMessage: (key: string, sessionId: string, body: SendMessageRequest) =>
    apiRequest<unknown>(routes.sessionMessages(key, sessionId), { method: 'POST', body }),
  stopSession: (key: string, sessionId: string, body?: import('@projectman/shared').StopSessionRequest) =>
    apiRequest<unknown>(routes.stopSession(key, sessionId), { method: 'POST', ...(body ? { body } : {}) }),
  updateSession: (key: string, sessionId: string, body: UpdateSessionRequest) =>
    apiRequest(routes.session(key, sessionId), { method: 'PATCH', body, schema: Session }),

  closedCardsMeasure: (key: string, days: number) =>
    apiRequest(`${routes.closedCardsMeasure(key)}?days=${days}`, { schema: ClosedCardsMeasure }),
  memberProfile: (key: string, handle: string) =>
    apiRequest(routes.memberProfile(key, handle), { schema: MemberProfile }),
  memberContext: (key: string, handle: string, taskKey?: string) =>
    apiRequest(
      `${routes.memberContext(key, handle)}${taskKey !== undefined ? `?task=${encodeURIComponent(taskKey)}` : ''}`,
      { schema: MemberContextPreview },
    ),
  memberMemories: (key: string, handle: string) =>
    apiRequest(routes.memberMemories(key, handle), { schema: MemberMemories }),
  startConversation: (key: string, handle: string) =>
    apiRequest(routes.startConversation(key, handle), { method: 'POST', schema: Session }),
  removeHuman: (key: string, handle: string) =>
    apiRequest<unknown>(routes.removeHuman(key, handle), { method: 'DELETE' }),
  uploadMessageAttachment: (key: string, file: File, signal?: AbortSignal) => {
    const body = new FormData();
    body.append('file', file);
    return apiRequest(routes.messageAttachments(key), {
      method: 'POST',
      body,
      signal,
      schema: UploadMessageAttachmentResponse,
    });
  },
  deleteMessageAttachment: (key: string, id: string) =>
    apiRequest(routes.messageAttachment(key, id), {
      method: 'DELETE',
      schema: DeleteMessageAttachmentResponse,
    }),
  sendTeamMessage: (key: string, body: SendTeamMessageRequest) =>
    apiRequest(routes.sendTeamMessage(key), { method: 'POST', body, schema: TeamMessage }),
  readTeamMessage: (key: string, id: string) =>
    apiRequest(routes.readTeamMessage(key, id), { method: 'POST', schema: TeamMessage }),
  readTeamMessages: (key: string, ids: string[]) =>
    apiRequest(routes.readTeamMessages(key), { method: 'POST', body: { ids }, schema: TeamMessagesView }),
  teamThreads: (key: string) => apiRequest(routes.teamThreads(key), { schema: TeamThreadsView }),
  /**
   * The viewer's own conversation with the project manager: who it is, whether it can answer now, requests with
   * steps, signals and the queue (PM-434, PM-475, PM-1042).
   */
  projectManager: (key: string) => apiRequest(routes.projectManager(key), { schema: ProjectManagerCorner }),
  /** The project manager's queue: the open items and those closed since `closedSince` (PM-894, PM-1042). */
  projectManagerQueue: (key: string, closedSince: string) =>
    apiRequest(`${routes.projectManagerQueue(key)}?closedSince=${encodeURIComponent(closedSince)}`, {
      schema: MemberQueueView,
    }),
  /** The owner's grant of machine operations to the Operator, as the viewer may see it (PM-881). */
  operatorGrant: () => apiRequest(routes.operatorGrant(), { schema: OperatorGrantResponse }),
  operatorKnowledge: (key: string) =>
    apiRequest(routes.operatorKnowledge(key), { schema: OperatorKnowledgeDocument }),
  operatorPreferenceMe: (key: string) =>
    apiRequest(routes.operatorPreferenceMe(key), { schema: OperatorPreferenceDocument }),
  operatorPreferences: (key: string) =>
    apiRequest<{ items: { handle: string; preference: OperatorPreferenceDocument }[] }>(
      routes.operatorPreferences(key),
    ),
  operatorApprovalWaiver: (key: string, body: OperatorApprovalWaiverRequest) =>
    apiRequest(routes.operatorApprovalWaiver(key), {
      method: 'PUT',
      body,
      schema: OperatorApprovalWaiverResponse,
    }),
  /** "Most ne": the owner sets a signal aside (PM-476); the answer is the signal as it is now. */
  dismissOperatorSignal: (key: string, signalId: string) =>
    apiRequest(routes.dismissOperatorSignal(key, signalId), { method: 'POST', schema: OperatorSignal }),
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

  /** Every open item, never cut off: what waits for someone. */
  inbox: (key: string) => apiRequest(`${routes.inbox(key)}?state=open`, { schema: InboxView }),
  /** The newest closed items (resolved, expired, cancelled): the "recently decided" lists. */
  inboxHistory: (key: string, limit: number) =>
    apiRequest(`${routes.inbox(key)}?state=closed&limit=${limit}`, { schema: InboxView }),
  /** The questions the Operator screened since `since` (an ISO time with an offset); owners and admins only (PM-558). */
  screenedQuestions: (key: string, since: string) =>
    apiRequest(`${routes.screenedQuestions(key)}?since=${encodeURIComponent(since)}`, {
      schema: ScreenedQuestionsResponse,
    }),
  resolveInbox: (key: string, itemId: string, body: ResolveInboxRequest) =>
    apiRequest<unknown>(routes.resolveInbox(key, itemId), { method: 'POST', body }),
  /** "Check now" on an outage alert (PM-466): the server looks again at once; no body. */
  checkOutage: (key: string, itemId: string) =>
    apiRequest(routes.checkOutage(key, itemId), { method: 'POST', schema: CheckOutageResponse }),

  schedules: (key: string) => apiRequest(routes.schedules(key), { schema: SchedulesView }),
  runSchedule: (key: string, handle: string) =>
    apiRequest(routes.runSchedule(key, handle), { method: 'POST', schema: ScheduleRun }),

  /** The pause (PM-219): a project's view holds its own and the instance's; the POSTs take an empty body. */
  pauseProject: (key: string) =>
    apiRequest(routes.projectPause(key), { method: 'POST', body: {}, schema: ProjectPauseView }),
  resumeProject: (key: string) =>
    apiRequest(routes.projectPauseResume(key), { method: 'POST', body: {}, schema: ProjectPauseView }),
  forcePauseProject: (key: string) =>
    apiRequest(routes.projectPauseForce(key), { method: 'POST', body: {}, schema: ProjectPauseView }),
  instancePause: () => apiRequest(routes.instancePause(), { schema: InstancePauseView }),
  resumeInstance: () =>
    apiRequest(routes.instancePauseResume(), { method: 'POST', body: {}, schema: InstancePauseView }),
  forcePauseInstance: () =>
    apiRequest(routes.instancePauseForce(), { method: 'POST', body: {}, schema: InstancePauseView }),

  /** Feedback marks (PM-511): the DTOs are interfaces, so the answers carry no schema. */
  feedback: (key: string, taskKey?: string) =>
    apiRequest<FeedbackInboxResponse>(
      `${routes.feedback(key)}${taskKey ? `?task=${encodeURIComponent(taskKey)}` : ''}`,
    ),
  feedbackSummary: (key: string) => apiRequest<FeedbackSummary>(routes.feedbackSummary(key)),
  feedbackSettings: (key: string) => apiRequest<FeedbackSettingsView>(routes.feedbackSettings(key)),
  feedbackMark: (key: string, markId: string) =>
    apiRequest<FeedbackMarkDetail>(routes.feedbackMark(key, markId)),
  feedbackLaunch: (key: string, body: FeedbackLaunchRequest) =>
    apiRequest<FeedbackLaunchResponse>(routes.feedbackLaunch(key), { method: 'POST', body }),
  feedbackMarkerLogout: (key: string, handle: string) =>
    apiRequest<null>(routes.feedbackMarkerLogout(key, handle), { method: 'POST', body: {} }),
  feedbackComment: (key: string, markId: string, body: FeedbackCommentRequest) =>
    apiRequest<FeedbackMarkDetail>(routes.feedbackComments(key, markId), { method: 'POST', body }),
  feedbackRead: (key: string, markId: string) =>
    apiRequest<null>(routes.feedbackRead(key, markId), { method: 'POST', body: {} }),
  feedbackCreateTask: (key: string, markId: string, body: CreateTaskFromFeedbackRequest) =>
    apiRequest<CreateTaskFromFeedbackResponse>(routes.feedbackTask(key, markId), { method: 'POST', body }),
  feedbackLink: (key: string, markId: string, body: LinkFeedbackRequest) =>
    apiRequest<FeedbackMarkDetail>(routes.feedbackLink(key, markId), { method: 'POST', body }),
  feedbackClose: (key: string, markId: string, body: CloseFeedbackRequest) =>
    apiRequest<FeedbackMarkDetail>(routes.feedbackClose(key, markId), { method: 'POST', body }),
  feedbackReopen: (key: string, markId: string) =>
    apiRequest<FeedbackMarkDetail>(routes.feedbackReopen(key, markId), { method: 'POST', body: {} }),

  /** The e-mail channel (PM-942): owner and admin only; `before` is the cursor of the log's older page. */
  emailChannel: (key: string) => apiRequest(routes.emailChannel(key), { schema: EmailChannelView }),
  emailLog: (key: string, before?: string) =>
    apiRequest(`${routes.emailLog(key)}${before ? `?before=${encodeURIComponent(before)}` : ''}`, {
      schema: EmailLogResponse,
    }),
  setEmailContact: (key: string, handle: string, body: SetEmailContactRequest) =>
    apiRequest(routes.emailContact(key, handle), { method: 'PUT', body, schema: EmailContact }),

  ownerInvitations: () => apiRequest(routes.ownerInvitations(), { schema: OwnerInvitationsView }),
  createOwnerInvitation: (body: CreateOwnerInviteRequest) =>
    apiRequest(routes.ownerInvitations(), { method: 'POST', body, schema: CreatedOwnerInvitation }),
  revokeOwnerInvitation: (id: string) => apiRequest<void>(routes.ownerInvitation(id), { method: 'DELETE' }),
  ownerAccounts: () => apiRequest(routes.ownerAccounts(), { schema: OwnerAccountsView }),
  revokeOwnerAccount: (id: string) =>
    apiRequest(routes.revokeOwnerAccount(id), { method: 'POST', schema: OwnerAccountView }),
  hostRequests: (state: 'open' | 'all') =>
    apiRequest(`${routes.hostRequests()}${state === 'open' ? '?state=open' : ''}`, {
      schema: HostRequestListResponse,
    }),
  answerHostRequest: (id: string, body: AnswerHostRequestRequest) =>
    apiRequest(routes.answerHostRequest(id), { method: 'POST', body, schema: HostRequestView }),
  config: (key: string) => apiRequest(routes.config(key), { schema: ConfigView }),
  patchConfig: (key: string, body: PatchConfigRequest) =>
    apiRequest(routes.patchConfig(key), { method: 'PATCH', body, schema: ConfigView }),
  revertConfig: (key: string, body: RevertConfigRequest) =>
    apiRequest<unknown>(routes.revertConfig(key), { method: 'POST', body }),
};
