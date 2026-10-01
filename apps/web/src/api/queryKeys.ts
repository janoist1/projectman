/**
 * TanStack Query keys. Everything that belongs to a project starts with
 * ['project', key] so a reconnect can refetch a whole project at once.
 */
export const queryKeys = {
  profiles: (key: string) => ['project', key, 'profile'] as const,
  profile: (key: string, handle: string) => ['project', key, 'profile', handle] as const,
  memories: (key: string, handle: string) => ['project', key, 'memory', handle] as const,
  providers: ['providers'] as const,
  invitations: (key: string) => ['project', key, 'invitations'] as const,
  invite: (token: string) => ['invite', token] as const,
  setupStatus: ['setupStatus'] as const,
  me: ['me'] as const,
  projects: ['projects'] as const,
  templates: ['templates'] as const,
  project: (key: string) => ['project', key] as const,
  board: (key: string) => ['project', key, 'board'] as const,
  task: (key: string, taskKey: string) => ['project', key, 'task', taskKey] as const,
  /** A task's attachment list: next to the task detail, not under it, so the detail's prefix never matches it. */
  attachments: (key: string, taskKey: string) => ['project', key, 'attachments', taskKey] as const,
  /** Prefix of every task detail query of a project. */
  taskDetails: (key: string) => ['project', key, 'task'] as const,
  session: (key: string, sessionId: string) => ['project', key, 'session', sessionId] as const,
  /** Prefix of every session detail query of a project. */
  sessionDetails: (key: string) => ['project', key, 'session'] as const,
  inbox: (key: string) => ['project', key, 'inbox'] as const,
  /** The project's message feed; also the prefix of the thread and unread queries below. */
  messages: (key: string) => ['project', key, 'messages'] as const,
  messageThread: (key: string, handle: string) => ['project', key, 'messages', 'thread', handle] as const,
  unreadMessages: (key: string) => ['project', key, 'messages', 'unread'] as const,
  schedules: (key: string) => ['project', key, 'schedules'] as const,
  members: (key: string) => ['project', key, 'members'] as const,
  roles: (key: string) => ['project', key, 'roles'] as const,
  config: (key: string) => ['project', key, 'config'] as const,
};
