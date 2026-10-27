/**
 * HTTP route table shared by the server (registration) and the web app (fetching).
 * All /api routes except setup/login require a session cookie.
 * /mcp (and /hooks, registered by the runner) are internal: localhost only, authenticated by a
 * per-session token.
 */
export const routes = {
  /** GET the running server version for any authenticated user. */
  serverVersion: () => '/api/version',
  /** Owner/admin: GET EmailChannelView. */
  emailChannel: (key: string) => `/api/projects/${key}/email`,
  /** Owner/admin: PUT SetEmailContactRequest -> EmailContact. */
  emailContact: (key: string, handle: string) => `/api/projects/${key}/email/contacts/${handle}`,
  /** Owner/admin: GET ?before=<cursor> -> EmailLogResponse. */
  emailLog: (key: string) => `/api/projects/${key}/email/log`,
  push: () => '/api/me/push',
  pushSettings: () => '/api/me/push/settings',
  pushDevices: () => '/api/me/push/devices',
  pushDevice: (id: string) => `/api/me/push/devices/${id}`,
  pushDeviceTest: (id: string) => `/api/me/push/devices/${id}/test`,
  pushUnsubscribe: () => '/api/me/push/unsubscribe',
  projectManager: (key: string) => `/api/projects/${key}/project-manager`,
  /** GET the Operator's channel with its requests and steps (`OperatorChannel`, PM-463) of the viewer's own conversation (PM-475); a person's own login only. */
  operator: (key: string) => `/api/projects/${key}/operator`,
  /** GET the Operator's member queue (`MemberQueueView`, PM-894); `?closedSince=<iso>`. */
  operatorQueue: (key: string) => `/api/projects/${key}/operator/queue`,
  operatorPreferences: (key: string) => `/api/projects/${key}/operator/preferences`,
  operatorKnowledge: (key: string) => `/api/projects/${key}/operator/knowledge`,
  projectChecklist: (key: string) => `/api/projects/${key}/checklist`,
  projectChecklistItemState: (key: string, itemId: string) =>
    `/api/projects/${key}/checklist/items/${itemId}/state`,
  operatorApprovalWaiver: (key: string) => `/api/projects/${key}/operator/approval-waiver`,
  /** GET the super mode's audit (`SuperAuditPage`, PM-757), newest first; the owner's own login only. */
  operatorSuperAudit: (key: string) => `/api/projects/${key}/operator-super/audit`,
  /** GET the project's super-mode handoffs (`ListSuperHandoffsResponse`, PM-762); the integrator and the owner. */
  superHandoffs: (key: string) => `/api/projects/${key}/operator-super/handoffs`,
  superHandoff: (key: string, handoffId: string) =>
    `/api/projects/${key}/operator-super/handoffs/${handoffId}`,
  /** POST `SuperOperateRequest`: starts a command without a handoff; 202 `{operation}` (PM-764). */
  superOperations: (key: string) => `/api/projects/${key}/operator-super/operations`,
  /** GET `{operation, result}`: the operation and the administration result recorded for it, if any. */
  superOperation: (key: string, operationId: string) =>
    `/api/projects/${key}/operator-super/operations/${operationId}`,
  /** POST `RelayOwnerAnswerRequest`: the integrator relays the owner's answer to a simple information question. */
  relayOwnerAnswer: (key: string, itemId: string) => `/api/projects/${key}/inbox/${itemId}/relay-answer`,
  /** POST `ResolveIntegratorFixLimitRequest`: the integrator decides a fix round limit item addressed to it (PM-714). */
  resolveIntegratorFixLimit: (key: string, itemId: string) =>
    `/api/projects/${key}/inbox/${itemId}/resolve-integrator-fix-limit`,
  operatorPreferenceMe: (key: string) => `/api/projects/${key}/operator/preferences/me`,
  dismissOperatorSignal: (key: string, signalId: string) =>
    `/api/projects/${key}/operator/signals/${signalId}/dismiss`,
  engines: () => '/api/engines',
  engineStatus: () => '/api/engines/status',
  revokeEngine: (id: string) => `/api/engines/${id}/revoke`,
  defaultEngine: (id: string) => `/api/engines/${id}/default`,
  engineLink: () => '/engine/link',
  /** The engine sends a large result here (PM-314): `POST` the bytes; the token comes with the request. */
  engineUpload: (token: string) => `/engine/files/uploads/${token}`,
  /** The engine fetches an attachment from here (PM-314): `GET`; the token comes with the request. */
  engineDownload: (token: string) => `/engine/files/downloads/${token}`,
  integratorKey: () => '/api/auth/integrator-key',
  integratorKeys: () => '/api/auth/integrator-keys',
  integratorAccessKey: (id: string) => `/api/auth/integrator-keys/${id}`,
  integratorKeyAudit: () => '/api/auth/integrator-keys/audit',
  /** GET the state, POST grants, DELETE revokes the Operator's grant for machine operations (PM-881). */
  operatorGrant: () => '/api/auth/operator-grant',
  operatorGrantAudit: () => '/api/auth/operator-grant/audit',
  involvements: (key: string) => `/api/projects/${key}/involvements`,
  projectStructure: (key: string) => `/api/projects/${key}/structure`,
  /**
   * GET (`ProjectChangeEventsQuery`: `after` cursor, `limit` 1..500, `waitMs` 0..25000): the project's durable
   * change journal (`ProjectChangeEventsResponse`, PM-761), waiting up to `waitMs` for a new entry. Internal members only.
   */
  projectEvents: (key: string) => `/api/projects/${key}/events`,
  /** GET (owner): the network destinations opened for the project's members (PM-140). */
  /** POST (owner): closes an opened destination before it expires. */
  /** GET (any logged-in member): whether the VM boundary is configured and ready (PM-140). */
  providers: () => '/api/providers',
  nanogptKey: () => '/api/providers/nanogpt/key',
  setupStatus: () => '/api/setup',
  setup: () => '/api/setup',
  login: () => '/api/auth/login',
  /** POST: asks for a one-time e-mail login code (`EmailLoginCodeRequest`); always 202 `EmailLoginCodeRequested` (PM-670). */
  emailLoginRequest: () => '/api/auth/email/request',
  /** POST: redeems the code (`EmailLoginVerifyRequest`); 200 `Me` and a new session cookie (PM-670). */
  emailLoginVerify: () => '/api/auth/email/verify',
  logout: () => '/api/auth/logout',
  me: () => '/api/me',

  projects: () => '/api/projects',
  board: (key: string) => `/api/projects/${key}/board`,

  tasks: (key: string) => `/api/projects/${key}/tasks`,
  taskMerge: (key: string, taskKey: string) => `/api/projects/${key}/tasks/${taskKey}/merge`,
  mergeQueueOrder: (key: string) => `/api/projects/${key}/merge-queue/order`,
  /** POST: puts the card's queued merge at the front of its repository's queue (`PrioritizeMergeRequest`, PM-576). */
  taskMergePrioritize: (key: string, taskKey: string) =>
    `/api/projects/${key}/tasks/${taskKey}/merge/prioritize`,
  task: (key: string, taskKey: string) => `/api/projects/${key}/tasks/${taskKey}`,
  /** GET: a closed handoff of the card with its note or summary (`TaskHandoffRecord`, PM-342). */
  taskHandoff: (key: string, taskKey: string, id: string) =>
    `/api/projects/${key}/tasks/${taskKey}/handoffs/${id}`,
  taskComments: (key: string, taskKey: string) => `/api/projects/${key}/tasks/${taskKey}/comments`,
  taskLabels: (key: string, taskKey: string) => `/api/projects/${key}/tasks/${taskKey}/labels`,
  startTask: (key: string, taskKey: string) => `/api/projects/${key}/tasks/${taskKey}/start`,
  cancelTask: (key: string, taskKey: string) => `/api/projects/${key}/tasks/${taskKey}/cancel`,
  /** POST (`BoardMoveRequest` -> `BoardMoveResult`): drops a card on the board, by column and place (PM-118). */
  boardMoveTask: (key: string, taskKey: string) => `/api/projects/${key}/tasks/${taskKey}/board-move`,
  closeTheme: (key: string, taskKey: string) => `/api/projects/${key}/tasks/${taskKey}/close-theme`,
  reopenTask: (key: string, taskKey: string) => `/api/projects/${key}/tasks/${taskKey}/reopen`,

  /** GET lists, POST uploads one file (multipart/form-data, field "file"). */
  taskAttachments: (key: string, taskKey: string) => `/api/projects/${key}/tasks/${taskKey}/attachments`,
  /** DELETE removes the attachment. */
  taskAttachment: (key: string, taskKey: string, id: string) =>
    `/api/projects/${key}/tasks/${taskKey}/attachments/${id}`,
  /** Inline when the content is a supported image or PDF, otherwise as a download. */
  attachmentContent: (key: string, taskKey: string, id: string) =>
    `/api/projects/${key}/tasks/${taskKey}/attachments/${id}/content`,
  /** Always as a download. */
  attachmentDownload: (key: string, taskKey: string, id: string) =>
    `/api/projects/${key}/tasks/${taskKey}/attachments/${id}/download`,
  /** A small WebP preview (at most 640 px) of an image attachment; 404 for anything else. */
  attachmentThumbnail: (key: string, taskKey: string, id: string) =>
    `/api/projects/${key}/tasks/${taskKey}/attachments/${id}/thumbnail`,

  /** PUT chooses the card's cover (`TaskCoverRequest`): a given image, or none; the answer is `{ task }`. */
  taskCover: (key: string, taskKey: string) => `/api/projects/${key}/tasks/${taskKey}/cover`,

  invitations: (key: string) => `/api/projects/${key}/invites`,
  invitation: (key: string, id: string) => `/api/projects/${key}/invites/${id}`,
  invite: (token: string) => `/api/invites/${token}`,
  acceptInvite: (token: string) => `/api/invites/${token}/accept`,

  /** GET the project's pauses (`ProjectPauseView`); POST pauses it (`PauseRequest`), admin at least. */
  projectPause: (key: string) => `/api/projects/${key}/pause`,
  projectPauseResume: (key: string) => `/api/projects/${key}/pause/resume`,
  projectPauseForce: (key: string) => `/api/projects/${key}/pause/force`,
  /** The instance's pause (PM-219): GET `InstancePauseView`; the POSTs need `canManageInstancePause`. */
  instancePause: () => '/api/pause',
  instancePauseResume: () => '/api/pause/resume',
  instancePauseForce: () => '/api/pause/force',
  /** The machine display (PM-300): GET `MachineView` (`?panel=1` while the panel is open); instance owners only. */
  machine: () => '/api/machine',
  /** POST `StopOrphansRequest` → `StopOrphansResult`: stops orphan processes of this instance; instance owners only. */
  machineOrphansStop: () => '/api/machine/orphans/stop',

  schedules: (key: string) => `/api/projects/${key}/schedules`,
  runSchedule: (key: string, handle: string) => `/api/projects/${key}/members/${handle}/schedule/run`,

  addHumanMember: (key: string) => `/api/projects/${key}/members/human`,
  members: (key: string) => `/api/projects/${key}/members`,
  member: (key: string, handle: string) => `/api/projects/${key}/members/${handle}`,

  roles: (key: string) => `/api/projects/${key}/roles`,
  role: (key: string, roleId: string) => `/api/projects/${key}/roles/${roleId}`,

  session: (key: string, sessionId: string) => `/api/projects/${key}/sessions/${sessionId}`,
  sessionMessages: (key: string, sessionId: string) => `/api/projects/${key}/sessions/${sessionId}/messages`,
  stopSession: (key: string, sessionId: string) => `/api/projects/${key}/sessions/${sessionId}/stop`,

  sendTeamMessage: (key: string) => `/api/projects/${key}/messages`,
  readTeamMessage: (key: string, id: string) => `/api/projects/${key}/messages/${id}/read`,
  memberProfile: (key: string, handle: string) => `/api/projects/${key}/members/${handle}/profile`,
  memberContext: (key: string, handle: string) => `/api/projects/${key}/members/${handle}/context`,
  memberMemories: (key: string, handle: string) => `/api/projects/${key}/members/${handle}/memories`,
  startConversation: (key: string, handle: string) => `/api/projects/${key}/members/${handle}/conversation`,
  removeHuman: (key: string, handle: string) => `/api/projects/${key}/members/${handle}/remove`,
  /** POST (owner, `RenameMemberRequest`): renames an AI member; answers the new `MemberView` (PM-1025). */
  memberRename: (key: string, handle: string) => `/api/projects/${key}/members/${handle}/rename`,
  teamMessages: (key: string) => `/api/projects/${key}/messages`,
  /** GET: the viewer's conversations with the other members, with the unread count of each (PM-78). */
  teamThreads: (key: string) => `/api/projects/${key}/messages/threads`,
  /** POST `{ ids }`: marks the viewer's unread messages among them read in one request (PM-78). */
  readTeamMessages: (key: string) => `/api/projects/${key}/messages/read`,

  /** POST uploads one file for a message (multipart/form-data, field "file"); the answer is `UploadMessageAttachmentResponse`. */
  messageAttachments: (key: string) => `/api/projects/${key}/message-attachments`,
  /** DELETE removes the file (`DeleteMessageAttachmentResponse`). */
  messageAttachment: (key: string, id: string) => `/api/projects/${key}/message-attachments/${id}`,
  /** GET/HEAD: inline when the content is a supported image or PDF, otherwise as a download. */
  messageAttachmentContent: (key: string, id: string) =>
    `/api/projects/${key}/message-attachments/${id}/content`,
  /** GET/HEAD: always as a download. */
  messageAttachmentDownload: (key: string, id: string) =>
    `/api/projects/${key}/message-attachments/${id}/download`,
  /** GET/HEAD: a small WebP preview (at most 640 px) of an image; 404 for anything else. */
  messageAttachmentThumbnail: (key: string, id: string) =>
    `/api/projects/${key}/message-attachments/${id}/thumbnail`,

  /** GET (internal members; query `days`): the cards closed lately with their rounds and tokens (PM-222). */
  closedCardsMeasure: (key: string) => `/api/projects/${key}/measure/closed-cards`,

  inbox: (key: string) => `/api/projects/${key}/inbox`,
  /** GET (owner, admin; query `since`, ISO): the questions the Operator screened, newest first (PM-556). */
  screenedQuestions: (key: string) => `/api/projects/${key}/inbox/screened`,
  resolveInbox: (key: string, itemId: string) => `/api/projects/${key}/inbox/${itemId}/resolve`,
  checkOutage: (key: string, itemId: string) => `/api/projects/${key}/inbox/${itemId}/check`,

  config: (key: string) => `/api/projects/${key}/config`,
  patchConfig: (key: string) => `/api/projects/${key}/config`,
  revertConfig: (key: string) => `/api/projects/${key}/config/revert`,

  /** GET (`FeedbackInboxResponse`; `?task=KEY` only the marks of that card) the project's feedback marks (PM-506). */
  feedback: (key: string) => `/api/projects/${key}/feedback`,
  /** GET `FeedbackSummary`: the badge numbers. */
  feedbackSummary: (key: string) => `/api/projects/${key}/feedback/summary`,
  /** GET `FeedbackSettingsView` (owner, admin). */
  feedbackSettings: (key: string) => `/api/projects/${key}/feedback/settings`,
  /** POST (`FeedbackLaunchRequest` -> `FeedbackLaunchResponse`): the address that starts the tool on a surface. */
  feedbackLaunch: (key: string) => `/api/projects/${key}/feedback/launch`,
  /** POST (owner, admin): ends every tool session of the member. */
  feedbackMarkerLogout: (key: string, handle: string) =>
    `/api/projects/${key}/feedback/markers/${handle}/logout`,
  /** GET `FeedbackMarkDetail`. */
  feedbackMark: (key: string, markId: string) => `/api/projects/${key}/feedback/${markId}`,
  /** GET (processors): the screenshot; `?thumb=1` the small one. */
  feedbackScreenshot: (key: string, markId: string) => `/api/projects/${key}/feedback/${markId}/screenshot`,
  /** POST (`FeedbackCommentRequest` -> `FeedbackMarkDetail`). */
  feedbackComments: (key: string, markId: string) => `/api/projects/${key}/feedback/${markId}/comments`,
  /** POST: the viewer has read the mark's thread (204). */
  feedbackRead: (key: string, markId: string) => `/api/projects/${key}/feedback/${markId}/read`,
  /** POST (`CreateTaskFromFeedbackRequest` -> `CreateTaskFromFeedbackResponse`, processors). */
  feedbackTask: (key: string, markId: string) => `/api/projects/${key}/feedback/${markId}/task`,
  /** POST (`LinkFeedbackRequest` -> `FeedbackMarkDetail`, processors). */
  feedbackLink: (key: string, markId: string) => `/api/projects/${key}/feedback/${markId}/link`,
  /** POST (`CloseFeedbackRequest` -> `FeedbackMarkDetail`, processors). */
  feedbackClose: (key: string, markId: string) => `/api/projects/${key}/feedback/${markId}/close`,
  /** POST (processors): opens a closed mark again. */
  feedbackReopen: (key: string, markId: string) => `/api/projects/${key}/feedback/${markId}/reopen`,

  /**
   * The public widget API of the feedback tool (PM-506, PM-509). Not under `/api`: it is cross-origin
   * and carries its own bearer session, which the `/api` guard would refuse. `rest` starts with `/`.
   */
  feedbackWidgetApi: (rest = '') => `/feedback/api/v1${rest}`,
  /** GET: the widget script the customer's page embeds. */
  feedbackWidgetScript: () => '/feedback/widget.js',

  websocket: () => '/ws',
  mcp: (token: string) => `/mcp/${token}`,
} as const;
