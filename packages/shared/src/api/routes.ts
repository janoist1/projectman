/**
 * HTTP route table shared by the server (registration) and the web app (fetching).
 * All /api routes except setup/login require a session cookie.
 * /hooks and /mcp are internal: localhost only, authenticated by a per-session token.
 */
export const routes = {
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
  taskChecks: (key: string, taskKey: string) => `/api/projects/${key}/tasks/${taskKey}/checks`,
  startTask: (key: string, taskKey: string) => `/api/projects/${key}/tasks/${taskKey}/start`,
  cancelTask: (key: string, taskKey: string) => `/api/projects/${key}/tasks/${taskKey}/cancel`,
  reopenTask: (key: string, taskKey: string) => `/api/projects/${key}/tasks/${taskKey}/reopen`,

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

  inbox: (key: string) => `/api/projects/${key}/inbox`,
  resolveInbox: (key: string, itemId: string) => `/api/projects/${key}/inbox/${itemId}/resolve`,

  config: (key: string) => `/api/projects/${key}/config`,
  patchConfig: (key: string) => `/api/projects/${key}/config`,
  revertConfig: (key: string) => `/api/projects/${key}/config/revert`,

  websocket: () => '/ws',
  hooks: (token: string) => `/hooks/${token}`,
  mcp: (token: string) => `/mcp/${token}`,
} as const;

/** Methods per route (for documentation and route registration). */
export const routeMethods = {
  providers: 'GET',
  setupStatus: 'GET',
  setup: 'POST',
  login: 'POST',
  logout: 'POST',
  me: 'GET',
  templates: 'GET',
  projects: 'GET | POST',
  project: 'GET',
  board: 'GET',
  tasks: 'GET | POST',
  task: 'GET | PATCH',
  taskComments: 'POST',
  taskChecks: 'POST',
  startTask: 'POST',
  cancelTask: 'POST',
  reopenTask: 'POST',
  invitations: 'GET | POST',
  invitation: 'DELETE',
  invite: 'GET',
  acceptInvite: 'POST',
  schedules: 'GET',
  runSchedule: 'POST',
  addHumanMember: 'POST',
  members: 'GET | POST',
  member: 'PATCH | DELETE',
  roles: 'GET | POST',
  role: 'PUT | DELETE',
  session: 'GET',
  sessionMessages: 'POST',
  stopSession: 'POST',
  sendTeamMessage: 'POST',
  readTeamMessage: 'POST',
  memberProfile: 'GET',
  memberMemories: 'GET',
  startConversation: 'POST',
  removeHuman: 'DELETE',
  teamMessages: 'GET',
  inbox: 'GET',
  resolveInbox: 'POST',
  config: 'GET | PUT',
  patchConfig: 'PATCH',
  revertConfig: 'POST',
} as const;
