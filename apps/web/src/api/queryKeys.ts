/**
 * TanStack Query keys. Everything that belongs to a project starts with
 * ['project', key] so a reconnect can refetch a whole project at once.
 */
export const queryKeys = {
  setupStatus: ['setupStatus'] as const,
  me: ['me'] as const,
  projects: ['projects'] as const,
  templates: ['templates'] as const,
  project: (key: string) => ['project', key] as const,
  board: (key: string) => ['project', key, 'board'] as const,
  task: (key: string, taskKey: string) => ['project', key, 'task', taskKey] as const,
  tasks: (key: string) => ['project', key, 'task'] as const,
  session: (key: string, sessionId: string) => ['project', key, 'session', sessionId] as const,
  sessions: (key: string) => ['project', key, 'session'] as const,
  inbox: (key: string) => ['project', key, 'inbox'] as const,
  messages: (key: string) => ['project', key, 'messages'] as const,
  members: (key: string) => ['project', key, 'members'] as const,
  config: (key: string) => ['project', key, 'config'] as const,
};
