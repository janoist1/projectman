/** The filters of the "All messages" list (PM-78); an empty string is no filter. */
export interface AllMessagesFilter {
  member: string;
  task: string;
  unread: boolean;
}

/**
 * TanStack Query keys. Everything that belongs to a project starts with
 * ['project', key] so a reconnect can refetch a whole project at once.
 */
export const queryKeys = {
  checklist: (key: string) => ['project', key, 'checklist'] as const,
  serverVersion: ['server-version'] as const,
  operatorKnowledge: (key: string) => ['project', key, 'operator-knowledge'] as const,
  /** The Operator's queue (PM-894); the shorter key is every `closedSince` of it. */
  operatorQueueAll: (key: string) => ['project', key, 'operator-queue'] as const,
  operatorQueue: (key: string, closedSince: string) =>
    ['project', key, 'operator-queue', closedSince] as const,
  /** The Operator's grant for machine operations (PM-881); one for the whole instance. */
  operatorGrant: ['operator-grant'] as const,
  operatorGrantAudit: ['operator-grant-audit'] as const,
  operatorPreferenceMeAll: (key: string) => ['project', key, 'operator-preference'] as const,
  operatorPreferenceMe: (key: string, handle: string | null) =>
    ['project', key, 'operator-preference', handle] as const,
  operatorPreferences: (key: string) => ['project', key, 'operator-preferences'] as const,
  profiles: (key: string) => ['project', key, 'profile'] as const,
  profile: (key: string, handle: string) => ['project', key, 'profile', handle] as const,
  memories: (key: string, handle: string) => ['project', key, 'memory', handle] as const,
  /** The closed cards comparison (PM-222); `closedCardsAll` is the prefix of every period. */
  closedCards: (key: string, days: number) => ['project', key, 'closed-cards', days] as const,
  closedCardsAll: (key: string) => ['project', key, 'closed-cards'] as const,
  providers: ['providers'] as const,
  /** Hybrid mode (PM-316): what every internal member sees, kept live by `engine_changed`, and the owner's list. */
  engineStatus: ['engines', 'status'] as const,
  engines: ['engines', 'list'] as const,
  invitations: (key: string) => ['project', key, 'invitations'] as const,
  invite: (token: string) => ['invite', token] as const,
  setupStatus: ['setupStatus'] as const,
  me: ['me'] as const,
  /** The person's own web push devices and settings (PM-815): not tied to a project. */
  push: ['push'] as const,
  projects: ['projects'] as const,
  project: (key: string) => ['project', key] as const,
  board: (key: string) => ['project', key, 'board'] as const,
  task: (key: string, taskKey: string) => ['project', key, 'task', taskKey] as const,
  /** A closed handoff record of a task (PM-342); its note never changes. */
  taskHandoff: (key: string, taskKey: string, handoffId: string) =>
    ['project', key, 'task-handoff', taskKey, handoffId] as const,
  /** A task's attachment list: next to the task detail, not under it, so the detail's prefix never matches it. */
  attachments: (key: string, taskKey: string) => ['project', key, 'attachments', taskKey] as const,
  /** Prefix of every task detail query of a project. */
  taskDetails: (key: string) => ['project', key, 'task'] as const,
  session: (key: string, sessionId: string) => ['project', key, 'session', sessionId] as const,
  /** Prefix of every session detail query of a project. */
  sessionDetails: (key: string) => ['project', key, 'session'] as const,
  inbox: (key: string) => ['project', key, 'inbox'] as const,
  /** The Operator's screened questions of a day (PM-561); `since` is the start of the viewer's day. */
  screenedQuestions: (key: string, since: string) => ['project', key, 'inbox-screened', since] as const,
  screenedQuestionsAll: (key: string) => ['project', key, 'inbox-screened'] as const,
  /** The project's message feed; also the prefix of the thread and unread queries below. */
  messages: (key: string) => ['project', key, 'messages'] as const,
  messageThread: (key: string, handle: string) => ['project', key, 'messages', 'thread', handle] as const,
  unreadMessages: (key: string) => ['project', key, 'messages', 'unread'] as const,
  /** The viewer's conversation list (PM-78). */
  teamThreads: (key: string) => ['project', key, 'messages', 'threads'] as const,
  /** One conversation of the viewer with `handle`, up to the server's page limit (PM-78). */
  conversation: (key: string, handle: string) =>
    ['project', key, 'messages', 'conversation', handle] as const,
  /** The messages of one card, as the viewer may see them (PM-273). */
  taskMessages: (key: string, taskKey: string) => ['project', key, 'messages', 'task', taskKey] as const,
  /** "All messages" under a filter (PM-78). */
  allMessages: (key: string, filter: AllMessagesFilter) =>
    ['project', key, 'messages', 'all', filter] as const,
  /** Feedback marks (PM-511); also the prefix of the list, the badge numbers, the settings and every mark. */
  feedback: (key: string) => ['project', key, 'feedback'] as const,
  feedbackList: (key: string) => ['project', key, 'feedback', 'list'] as const,
  feedbackSummary: (key: string) => ['project', key, 'feedback', 'summary'] as const,
  feedbackSettings: (key: string) => ['project', key, 'feedback', 'settings'] as const,
  /** The marks of one card (the "From feedback" row of its drawer). */
  feedbackOfTask: (key: string, taskKey: string) => ['project', key, 'feedback', 'task', taskKey] as const,
  feedbackMark: (key: string, markId: string) => ['project', key, 'feedback', 'mark', markId] as const,
  /** The e-mail channel (PM-942): its state, and its log (the pages of one infinite query). */
  emailChannel: (key: string) => ['project', key, 'email', 'channel'] as const,
  emailLog: (key: string) => ['project', key, 'email', 'log'] as const,
  /** The project manager's channel state (PM-429); its own prefix, reloaded on the events that change it. */
  projectManager: (key: string) => ['project', key, 'project-manager'] as const,
  /** The viewer's Operator channel (PM-447); reloaded on the same events and on the signals. */
  operator: (key: string) => ['project', key, 'operator'] as const,
  schedules: (key: string) => ['project', key, 'schedules'] as const,
  members: (key: string) => ['project', key, 'members'] as const,
  roles: (key: string) => ['project', key, 'roles'] as const,
  config: (key: string) => ['project', key, 'config'] as const,
  /** The instance's pause (PM-220): not under a project, it covers all of them. */
  instancePause: ['instancePause'] as const,
};
