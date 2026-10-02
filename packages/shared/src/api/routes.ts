/**
 * HTTP route table shared by the server (registration) and the web app (fetching).
 * All /api routes except setup/login require a session cookie.
 * /mcp (and /hooks, registered by the runner) are internal: localhost only, authenticated by a
 * per-session token.
 */
export const routes = {
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
  setupStatus: () => '/api/setup',
  setup: () => '/api/setup',
  login: () => '/api/auth/login',
  logout: () => '/api/auth/logout',
  me: () => '/api/me',

  templates: () => '/api/templates',
  projects: () => '/api/projects',
  project: (key: string) => `/api/projects/${key}`,
  board: (key: string) => `/api/projects/${key}/board`,

  tasks: (key: string) => `/api/projects/${key}/tasks`,
  task: (key: string, taskKey: string) => `/api/projects/${key}/tasks/${taskKey}`,
  taskComments: (key: string, taskKey: string) => `/api/projects/${key}/tasks/${taskKey}/comments`,
  taskLabels: (key: string, taskKey: string) => `/api/projects/${key}/tasks/${taskKey}/labels`,
  startTask: (key: string, taskKey: string) => `/api/projects/${key}/tasks/${taskKey}/start`,
  cancelTask: (key: string, taskKey: string) => `/api/projects/${key}/tasks/${taskKey}/cancel`,
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

  invitations: (key: string) => `/api/projects/${key}/invites`,
  invitation: (key: string, id: string) => `/api/projects/${key}/invites/${id}`,
  invite: (token: string) => `/api/invites/${token}`,
  acceptInvite: (token: string) => `/api/invites/${token}/accept`,

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

  /** GET (internal members; query `days`): the cards closed lately with their rounds and tokens (PM-222). */
  closedCardsMeasure: (key: string) => `/api/projects/${key}/measure/closed-cards`,

  inbox: (key: string) => `/api/projects/${key}/inbox`,
  resolveInbox: (key: string, itemId: string) => `/api/projects/${key}/inbox/${itemId}/resolve`,

  config: (key: string) => `/api/projects/${key}/config`,
  patchConfig: (key: string) => `/api/projects/${key}/config`,
  revertConfig: (key: string) => `/api/projects/${key}/config/revert`,

  websocket: () => '/ws',
  mcp: (token: string) => `/mcp/${token}`,
} as const;
