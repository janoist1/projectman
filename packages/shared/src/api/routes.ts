/**
 * HTTP route table shared by the server (registration) and the web app (fetching).
 * All /api routes except setup/login require a session cookie.
 * /mcp (and /hooks, registered by the runner) are internal: localhost only, authenticated by a
 * per-session token.
 */
export const routes = {
  projectManager: (key: string) => `/api/projects/${key}/project-manager`,
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
  involvements: (key: string) => `/api/projects/${key}/involvements`,
  /** GET the project's focus (`ProjectFocusView`, PM-427); internal members only. */
  projectFocus: (key: string) => `/api/projects/${key}/focus`,
  /** POST (`ProjectFocusAddRequest`): puts a theme or card into the focus. */
  projectFocusItems: (key: string) => `/api/projects/${key}/focus/items`,
  /** PATCH (`ProjectFocusMoveRequest`) moves an item; DELETE takes it out. */
  projectFocusItem: (key: string, taskKey: string) => `/api/projects/${key}/focus/items/${taskKey}`,
  /** GET (`?limit=`, 1 to 200, default 50): the project's `focus_changed` events (`ProjectFocusChanges`). */
  projectFocusChanges: (key: string) => `/api/projects/${key}/focus/changes`,
  boundaryRequest: (key: string, id: string) => `/api/projects/${key}/boundary/${id}`,
  decideBoundary: (key: string, id: string) => `/api/projects/${key}/boundary/${id}/decide`,
  revokeBoundary: (key: string, id: string) => `/api/projects/${key}/boundary/${id}/revoke`,
  /** GET (owner): the network destinations opened for the project's members (PM-140). */
  egressAllowances: (key: string) => `/api/projects/${key}/egress`,
  /** POST (owner): closes an opened destination before it expires. */
  revokeEgressAllowance: (key: string, id: string) => `/api/projects/${key}/egress/${id}/revoke`,
  /** GET (any logged-in member): whether the VM boundary is configured and ready (PM-140). */
  runtimeBoundary: () => '/api/runtime-boundary',
  providers: () => '/api/providers',
  nanogptKey: () => '/api/providers/nanogpt/key',
  setupStatus: () => '/api/setup',
  setup: () => '/api/setup',
  login: () => '/api/auth/login',
  logout: () => '/api/auth/logout',
  me: () => '/api/me',

  templates: () => '/api/templates',
  projects: () => '/api/projects',
  projectPreview: () => '/api/projects/preview',
  project: (key: string) => `/api/projects/${key}`,
  board: (key: string) => `/api/projects/${key}/board`,

  tasks: (key: string) => `/api/projects/${key}/tasks`,
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
  memberMemories: (key: string, handle: string) => `/api/projects/${key}/members/${handle}/memories`,
  startConversation: (key: string, handle: string) => `/api/projects/${key}/members/${handle}/conversation`,
  removeHuman: (key: string, handle: string) => `/api/projects/${key}/members/${handle}/remove`,
  teamMessages: (key: string) => `/api/projects/${key}/messages`,
  /** GET: the viewer's conversations with the other members, with the unread count of each (PM-78). */
  teamThreads: (key: string) => `/api/projects/${key}/messages/threads`,
  /** POST `{ ids }`: marks the viewer's unread messages among them read in one request (PM-78). */
  readTeamMessages: (key: string) => `/api/projects/${key}/messages/read`,

  /** GET (internal members; query `days`): the cards closed lately with their rounds and tokens (PM-222). */
  closedCardsMeasure: (key: string) => `/api/projects/${key}/measure/closed-cards`,

  inbox: (key: string) => `/api/projects/${key}/inbox`,
  resolveInbox: (key: string, itemId: string) => `/api/projects/${key}/inbox/${itemId}/resolve`,
  checkOutage: (key: string, itemId: string) => `/api/projects/${key}/inbox/${itemId}/check`,

  config: (key: string) => `/api/projects/${key}/config`,
  patchConfig: (key: string) => `/api/projects/${key}/config`,
  revertConfig: (key: string) => `/api/projects/${key}/config/revert`,

  websocket: () => '/ws',
  mcp: (token: string) => `/mcp/${token}`,
} as const;
