import {
  SendTeamMessageRequest,
  memberDuties,
  AgentProvider,
  modelForProvider,
  roleBundle,
  roleHolders,
  customRoleDuties,
  resolvedStages,
  gateApprovers,
  stageOwners,
  taskAuthors,
} from '@projectman/shared';
import {
  nextCronRun,
  PatchConfigRequest,
  applyConfigPatch,
  configSchemaIssues,
  humanApprovalChanged,
  validateProjectConfig,
  AcceptInviteRequest,
  CreateInviteRequest,
  InvitationView,
  CancelTaskRequest,
  ReopenTaskRequest,
  CustomRoleRequest,
  UpdateMemberRequest,
  holdersAllow,
  isBuiltInRole,
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
  SetTaskCheckRequest,
  UpdateTaskRequest,
} from '@projectman/shared';
import type {
  PlanUsage,
  ScheduleRun,
  InvitationView as Invitation,
  AiMemberConfig,
  BoardView,
  ChatItem,
  ClientCommand,
  ConfigVersionEntry,
  GateCondition,
  InboxItem,
  MemberView,
  ProjectConfig,
  RoleView,
  ServerEvent,
  Session,
  Task,
  TeamMessage,
  TimelineEvent,
  TimelineEventType,
} from '@projectman/shared';
import { inviteTokenHash, newInviteToken } from './inviteTokens';
import * as fixtures from './fixtures';
import { MockTerminals } from './terminal';
import { mockId, mockUuid, nowIso } from './time';

export type MockAuthState = 'ready' | 'setup' | 'login';

export interface MockResponse {
  status: number;
  body?: unknown;
}

/** A connected mock websocket as seen by the backend. */
export interface MockConnection {
  deliver(event: ServerEvent): void;
}

interface ConnectionState {
  projects: Set<string>;
  terminals: Set<string>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function error(status: number, code: string, message: string, details?: unknown): MockResponse {
  return { status, body: { error: { code, message, ...(details === undefined ? {} : { details }) } } };
}

function ok(body?: unknown): MockResponse {
  return body === undefined ? { status: 204 } : { status: 200, body };
}

function parseBody<T>(
  schema: { safeParse(data: unknown): { success: true; data: T } | { success: false } },
  body: unknown,
): T | null {
  const result = schema.safeParse(body ?? {});
  return result.success ? result.data : null;
}

/**
 * In-memory stand-in for the projectman server (VITE_MOCK=1). It implements the REST
 * routes from the shared route table and publishes the same websocket events the real
 * server would, so the UI runs through its normal data path.
 */
export class MockBackend {
  auth: MockAuthState;
  viewerHandle: string = fixtures.OWNER;
  user = { ...fixtures.mockUser };
  config: ProjectConfig = fixtures.buildConfig();
  configVersion = fixtures.projectSummary.configVersion;
  history: ConfigVersionEntry[] = clone(fixtures.configHistory);
  tasks: Task[] = clone(fixtures.tasks);
  members: MemberView[] = clone(fixtures.members);
  timeline: TimelineEvent[] = clone(fixtures.timeline);
  scheduleRuns: ScheduleRun[] = [];
  providerLoggedIn = { claude: true, codex: true };
  providerPlanUsage: Partial<Record<AgentProvider, PlanUsage>> = {};
  sessions: Session[] = clone(fixtures.sessions);
  chats: Record<string, ChatItem[]> = clone(fixtures.chats);
  inbox: InboxItem[] = clone(fixtures.inbox);
  messages: TeamMessage[] = clone(fixtures.teamMessages);
  memories: Record<string, string> = {
    'fe-1': 'Acme checkout uses fictional fixtures. Keep the cart usable on small screens.',
  };
  planUsage = clone(fixtures.planUsage);
  codexPlanUsage = { ...clone(fixtures.planUsage), fiveHourPercent: 24, weeklyPercent: 36 };
  extraProjects: { key: string; name: string; templateId: string }[] = [];
  invitations: Array<Invitation & { tokenHash: string }> = [];
  accounts = new Map<string, { userId: string; name: string; email: string; password: string }>([
    [fixtures.mockUser.email, { ...fixtures.mockUser, password: 'correct horse battery' }],
  ]);
  private inviteAttempts = { count: 0, resetAt: 0 };
  readonly terminals: MockTerminals;
  private readonly connections = new Map<MockConnection, ConnectionState>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly sessionStops = new Map<string, number>();
  private taskSeq = Math.max(0, ...fixtures.tasks.map((task) => Number(task.key.split('-')[1] ?? 0)));
  private onFirstSubscribe: (() => void) | null = null;

  constructor(auth: MockAuthState = 'ready') {
    this.auth = auth;
    for (const member of this.members) {
      const config = this.config.team.members.find((entry) => entry.handle === member.handle);
      if (config?.kind === 'ai')
        Object.assign(member, {
          provider: config.provider ?? 'claude',
          model: config.model,
          effort: config.effort,
          permissionMode: config.permissionMode,
        });
    }
    for (const message of this.messages) {
      message.receipts ??= message.to.map((handle) => ({
        handle,
        kind: this.findMember(handle)?.kind ?? 'human',
        deliveredAt: message.deliveredAt,
        readAt: null,
      }));
    }
    this.terminals = new MockTerminals(this);
  }

  /** Registers the live-event simulation, started when the first client subscribes. */
  setSimulation(start: () => void): void {
    this.onFirstSubscribe = start;
  }

  /* ---------- plumbing ---------- */

  later(ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
  }

  connect(connection: MockConnection): () => void {
    this.connections.set(connection, { projects: new Set(), terminals: new Set() });
    connection.deliver({ type: 'hello', serverTime: nowIso() });
    return () => {
      const state = this.connections.get(connection);
      state?.terminals.forEach((sessionId) => this.terminals.detach(sessionId, connection));
      this.connections.delete(connection);
    };
  }

  handleCommand(connection: MockConnection, command: ClientCommand): void {
    const state = this.connections.get(connection);
    if (!state) return;
    switch (command.type) {
      case 'subscribe_project':
        state.projects.add(command.projectKey);
        if (this.onFirstSubscribe) {
          const start = this.onFirstSubscribe;
          this.onFirstSubscribe = null;
          start();
        }
        return;
      case 'unsubscribe_project':
        state.projects.delete(command.projectKey);
        return;
      case 'terminal_attach':
        state.terminals.add(command.sessionId);
        this.terminals.attach(command.sessionId, connection);
        return;
      case 'terminal_detach':
        state.terminals.delete(command.sessionId);
        this.terminals.detach(command.sessionId, connection);
        return;
      case 'terminal_input':
        this.terminals.input(command.sessionId, command.data);
        return;
      case 'terminal_resize':
        return;
    }
  }

  /** Publishes a project event to every subscribed connection. */
  emit(event: ServerEvent): void {
    if (
      event.type === 'team_message' &&
      this.findMember(this.viewerHandle)?.role === 'client' &&
      event.message.from !== this.viewerHandle &&
      !event.message.to.includes(this.viewerHandle)
    )
      return;
    const projectKey = 'projectKey' in event ? event.projectKey : null;
    for (const [connection, state] of this.connections) {
      if (projectKey === null || state.projects.has(projectKey)) connection.deliver(event);
    }
  }

  /* ---------- domain helpers (also used by the simulation) ---------- */

  get owner(): string {
    return this.viewerHandle;
  }

  findTask(key: string): Task | undefined {
    return this.tasks.find((task) => task.key === key);
  }

  findSession(id: string): Session | undefined {
    return this.sessions.find((session) => session.id === id);
  }

  findMember(handle: string): MemberView | undefined {
    return this.members.find((member) => member.handle === handle);
  }

  updateTask(key: string, patch: Partial<Task>, actor = this.viewerHandle): Task | undefined {
    const task = this.findTask(key);
    if (!task) return undefined;
    if (
      patch.checks &&
      Object.keys(patch.checks).some(
        (check) =>
          check !== 'client_test' &&
          patch.checks![check as keyof Task['checks']] !== task.checks[check as keyof Task['checks']],
      ) &&
      taskAuthors(task).includes(actor)
    )
      throw Object.assign(new Error('The assignee and PR author cannot review their task'), {
        code: 'self_review_forbidden',
      });
    Object.assign(task, patch, { updatedAt: nowIso() });
    this.emit({ type: 'task_upserted', projectKey: task.projectKey, task: clone(task) });
    return task;
  }

  addTimeline(
    taskKey: string | null,
    who: string | null,
    type: TimelineEventType,
    data: Record<string, unknown>,
    sessionId: string | null = null,
  ): TimelineEvent {
    const member = who ? this.findMember(who) : undefined;
    const event: TimelineEvent = {
      id: mockId('evt'),
      projectKey: fixtures.PROJECT_KEY,
      taskKey,
      sessionId,
      actor: who ? { kind: member?.kind ?? 'system', handle: who } : { kind: 'system', handle: null },
      type,
      data,
      createdAt: nowIso(),
    };
    this.timeline.push(event);
    this.emit({ type: 'timeline_appended', projectKey: event.projectKey, event: clone(event) });
    return event;
  }

  setMemberState(handle: string, status: MemberView['status'], activity: string | null): void {
    const member = this.findMember(handle);
    if (!member) return;
    member.status = status;
    member.activity = activity;
    this.emit({ type: 'member_state', projectKey: fixtures.PROJECT_KEY, handle, status, activity });
  }

  updateSession(id: string, patch: Partial<Session>): Session | undefined {
    const session = this.findSession(id);
    if (!session) return undefined;
    const wasEnded = ['exited', 'failed'].includes(session.state);
    Object.assign(session, patch, { lastActivityAt: nowIso() });
    if (wasEnded || session.state === 'idle' || session.state === 'waiting_input')
      this.flushTeamMessages(session);
    if (session.workItem.type === 'schedule' && ['exited', 'failed'].includes(session.state)) {
      const run = this.scheduleRuns.find((r) => r.sessionId === session.id);
      if (run) {
        run.status = session.state === 'failed' ? 'failed' : 'done';
        run.reason = session.state === 'failed' ? 'session_failed' : null;
      }
    }
    this.emit({ type: 'session_upserted', projectKey: session.projectKey, session: clone(session) });
    return session;
  }

  appendChat(sessionId: string, items: ChatItem[]): void {
    const list = (this.chats[sessionId] ??= []);
    list.push(...items);
    this.emit({ type: 'chat_appended', projectKey: fixtures.PROJECT_KEY, sessionId, items: clone(items) });
    this.terminals.echoChat(sessionId, items);
  }

  chatItem<K extends ChatItem['kind']>(
    kind: K,
    fields: Omit<Extract<ChatItem, { kind: K }>, 'id' | 'ts' | 'kind'>,
  ): Extract<ChatItem, { kind: K }> {
    return { id: mockId('chat'), ts: nowIso(), kind, ...fields } as unknown as Extract<ChatItem, { kind: K }>;
  }

  sendTeamMessage(
    from: string,
    to: string[],
    taskKey: string | null,
    body: string,
    sessionId?: string,
  ): TeamMessage {
    const message: TeamMessage = {
      id: mockId('msg'),
      projectKey: fixtures.PROJECT_KEY,
      from,
      to,
      taskKey,
      body,
      createdAt: nowIso(),
      deliveredAt: to.every((h) => this.findMember(h)?.kind === 'human') ? nowIso() : null,
      receipts: to.map((handle) => ({
        handle,
        kind: this.findMember(handle)?.kind ?? 'human',
        deliveredAt: this.findMember(handle)?.kind === 'human' ? nowIso() : null,
        readAt: null,
      })),
    };
    this.messages.push(message);
    this.emit({ type: 'team_message', projectKey: message.projectKey, message: clone(message) });
    if (taskKey) {
      this.addTimeline(
        taskKey,
        from,
        'team_message',
        {
          messageId: message.id,
          from,
          to,
          excerpt: body.length > 80 ? `${body.slice(0, 77)}…` : body,
        },
        sessionId ?? null,
      );
    }
    if (sessionId)
      this.appendChat(sessionId, [this.chatItem('team_message', { direction: 'out', from, to, text: body })]);
    for (const handle of to) {
      const live = this.sessions.filter(
        (s) => s.member === handle && !['exited', 'failed'].includes(s.state),
      );
      const target =
        live.find((s) => s.workItem.type === 'task' && s.workItem.taskKey === taskKey) ?? live[0];
      if (target) this.flushTeamMessages(target);
    }
    return message;
  }

  upsertInbox(item: InboxItem): void {
    const index = this.inbox.findIndex((entry) => entry.id === item.id);
    if (index === -1) this.inbox.push(item);
    else this.inbox[index] = item;
    this.emit({ type: 'inbox_upserted', projectKey: item.projectKey, item: clone(item) });
  }

  private commitConfig(message: string): void {
    this.configVersion = Math.random().toString(16).slice(2, 9);
    this.history.unshift({ version: this.configVersion, message, author: this.user.name, at: nowIso() });
    this.emit({ type: 'config_changed', projectKey: fixtures.PROJECT_KEY, version: this.configVersion });
  }

  private memberChanged(handle: string): void {
    const member = this.findMember(handle);
    this.emit({
      type: 'member_changed',
      projectKey: fixtures.PROJECT_KEY,
      handle,
      member: member && member.status !== 'retired' ? clone(member) : null,
    });
  }

  private board(): BoardView {
    const stages = resolvedStages(this.config);
    return {
      project: {
        ...fixtures.projectSummary,
        name: this.config.project.name,
        configVersion: this.configVersion,
      },
      columns: this.config.pipeline.columns.map((column) => ({
        ...column,
        stageIds: stages.filter((stage) => stage.columnId === column.id).map((stage) => stage.id),
      })),
      stages: clone(stages),
      tasks: clone(
        this.tasks.filter(
          (task) => this.findMember(this.viewerHandle)?.role !== 'client' || task.visibility === 'shared',
        ),
      ),
      members: clone(this.members.filter((member) => member.status !== 'retired')),
      openInboxCount: this.inbox.filter(
        (item) => item.state === 'open' && item.assignees.includes(this.owner),
      ).length,
      planUsage: { ...this.planUsage, fetchedAt: nowIso() },
      planUsageByProvider: Object.fromEntries(
        [
          ...new Set(
            this.members
              .filter((member) => member.kind === 'ai' && member.status !== 'retired')
              .map((member) => member.provider ?? 'claude'),
          ),
        ].map((provider) => [
          provider,
          provider === 'claude' ? { ...this.planUsage, fetchedAt: nowIso() } : this.codexPlanUsage,
        ]),
      ),
    };
  }

  /* ---------- REST ---------- */

  handle(method: string, path: string, body: unknown, query = new URLSearchParams()): MockResponse {
    const publicInvite = /^\/api\/invites\/([^/]+)(\/accept)?$/.exec(path);
    if (publicInvite) return this.handlePublicInvite(method, publicInvite[1]!, !!publicInvite[2], body);
    if (path === '/api/setup') {
      if (method === 'GET') return ok({ needsSetup: this.auth === 'setup' });
      const input = parseBody(SetupRequest, body);
      if (!input) return error(400, 'invalid_request', 'Invalid setup request');
      this.user = { ...this.user, name: input.name, email: input.email };
      this.accounts.set(input.email.trim().toLowerCase(), {
        ...this.user,
        email: input.email.trim().toLowerCase(),
        password: input.password,
      });
      this.auth = 'ready';
      return ok({ ...this.me() });
    }
    if (path === '/api/auth/login' && method === 'POST') {
      const input = parseBody(LoginRequest, body);
      if (!input || input.password.length < 3)
        return error(401, 'invalid_credentials', 'Invalid email or password');
      const account = this.accounts.get(input.email.trim().toLowerCase());
      if (account && account.userId !== fixtures.mockUser.userId) {
        if (input.password !== account.password)
          return error(401, 'invalid_credentials', 'Invalid email or password');
        this.user = { userId: account.userId, name: account.name, email: account.email };
        this.viewerHandle =
          this.config.team.members.find(
            (member) => member.kind === 'human' && member.email?.toLowerCase() === account.email,
          )?.handle ?? '';
      } else if (account) {
        this.user = { userId: account.userId, name: account.name, email: account.email };
        this.viewerHandle = fixtures.OWNER;
      } else return error(401, 'invalid_credentials', 'Invalid email or password');
      this.auth = 'ready';
      return ok(this.me());
    }
    if (path === '/api/auth/logout' && method === 'POST') {
      this.auth = 'login';
      return ok();
    }
    if (this.auth !== 'ready') return error(401, 'unauthorized', 'Login required');

    if (path === '/api/me') return ok(this.me());
    if (path === '/api/providers' && method === 'GET') {
      return ok({
        providers: AgentProvider.options.map((provider) => ({
          provider,
          loggedIn: this.providerLoggedIn[provider],
          method: this.providerLoggedIn[provider]
            ? provider === 'claude'
              ? 'claude.ai'
              : 'chatgpt'
            : 'none',
          checkedAt: nowIso(),
        })),
      });
    }
    if (path === '/api/templates') return ok(clone(fixtures.templates));
    if (path === '/api/projects') {
      if (method === 'POST') {
        const input = parseBody(CreateProjectRequest, body);
        if (!input) return error(400, 'invalid_request', 'Invalid project');
        if (input.key === fixtures.PROJECT_KEY || this.extraProjects.some((p) => p.key === input.key)) {
          return error(409, 'conflict', 'Project key already exists');
        }
        this.extraProjects.push({ key: input.key, name: input.name, templateId: input.templateId });
        return ok({
          key: input.key,
          name: input.name,
          templateId: input.templateId,
          configVersion: '0000000',
        });
      }
      return ok([
        { ...fixtures.projectSummary, name: this.config.project.name, configVersion: this.configVersion },
        ...this.extraProjects.map((p) => ({ ...p, configVersion: '0000000' })),
      ]);
    }

    const match = /^\/api\/projects\/([A-Z][A-Z0-9]{0,9})(\/.*)?$/.exec(path);
    if (!match) return error(404, 'not_found', `No route for ${method} ${path}`);
    const key = match[1]!;
    const rest = match[2] ?? '';
    if (key !== fixtures.PROJECT_KEY) return error(404, 'not_found', `Unknown project ${key}`);
    return this.handleProject(method, rest, body, query);
  }

  private me() {
    const member = this.config.team.members.find((entry) => entry.handle === this.viewerHandle);
    return {
      ...this.user,
      handles: this.viewerHandle ? { [fixtures.PROJECT_KEY]: this.owner } : {},
      projects:
        member?.kind === 'human'
          ? [
              {
                key: fixtures.PROJECT_KEY,
                name: this.config.project.name,
                access: member.access,
                roles: member.roles,
              },
            ]
          : [],
    };
  }

  private handleProject(method: string, rest: string, body: unknown, query: URLSearchParams): MockResponse {
    let m: RegExpExecArray | null;
    const restricted =
      rest.startsWith('/invites') ||
      (rest === '/roles' && method !== 'GET') ||
      (rest.startsWith('/roles/') && method !== 'GET') ||
      (rest.startsWith('/members') && method !== 'GET' && !rest.endsWith('/conversation')) ||
      /\/tasks\/[^/]+\/(cancel|reopen)$/.test(rest) ||
      (rest.startsWith('/tasks/') &&
        method === 'PATCH' &&
        body !== null &&
        typeof body === 'object' &&
        'assignee' in body);
    const viewer = this.findMember(this.viewerHandle);
    if (!viewer) return error(403, 'not_a_member', 'Not a member');
    if (restricted && (viewer.kind !== 'human' || !['owner', 'admin'].includes(viewer.role)))
      return error(403, 'insufficient_access', 'Owner or admin required');
    if (rest.startsWith('/invites')) return this.handleInvitations(method, rest, body);
    if (rest === '' && method === 'GET')
      return ok({
        ...fixtures.projectSummary,
        name: this.config.project.name,
        configVersion: this.configVersion,
      });
    if (rest === '/schedules' && method === 'GET') return ok(this.schedulesView());
    const scheduleMatch = /^\/members\/([\w-]+)\/schedule\/run$/.exec(rest);
    if (scheduleMatch && method === 'POST') return this.runSchedule(scheduleMatch[1]!);
    if (rest === '/board') return ok(this.board());

    if (rest === '/tasks') {
      if (method === 'POST') return this.createTask(body);
      return ok(clone(this.tasks));
    }
    if ((m = /^\/tasks\/([A-Z][A-Z0-9]*-\d+)$/.exec(rest))) {
      const task = this.findTask(m[1]!);
      if (!task) return error(404, 'not_found', 'Unknown task');
      if (method === 'PATCH') {
        const input = parseBody(UpdateTaskRequest, body);
        if (!input) return error(400, 'invalid_request', 'Invalid task update');
        if (input.stageId !== undefined) {
          if (viewer.kind !== 'human' || !['owner', 'admin', 'developer'].includes(viewer.role))
            return error(403, 'insufficient_access', 'Developer access required');
          const result = this.moveTask(task, input.stageId);
          if (result.status !== 200) return result;
        }
        if (input.assignee !== undefined) {
          if (
            input.assignee !== null &&
            !this.config.team.members.some((member) => member.handle === input.assignee)
          )
            return error(400, 'unknown_member', 'Unknown member');
          const live = this.taskSessions(task.key).find(
            (session) => !['exited', 'failed'].includes(session.state),
          );
          if (live) return error(409, 'task_session_live', 'A session is still live', { sessionId: live.id });
          if (input.assignee !== task.assignee)
            this.addTimeline(task.key, this.owner, 'task_assigned', {
              assignee: input.assignee,
              previous: task.assignee,
            });
        }
        const fields = Object.keys(input).filter((field) => field !== 'assignee' && field !== 'stageId');
        if (fields.length) this.addTimeline(task.key, this.owner, 'task_updated', { fields });
        const { stageId: _stageId, ...fieldsToUpdate } = input;
        this.updateTask(task.key, fieldsToUpdate);
      }
      return ok({
        task: clone(task),
        pullRequests: this.taskPullRequests(task),
        timeline: clone(this.timeline.filter((event) => event.taskKey === task.key)),
        sessions: clone(
          this.sessions.filter((s) => s.workItem.type === 'task' && s.workItem.taskKey === task.key),
        ),
      });
    }
    if ((m = /^\/tasks\/([A-Z][A-Z0-9]*-\d+)\/checks$/.exec(rest)) && method === 'POST') {
      if (viewer.kind !== 'human' || !['owner', 'admin', 'developer'].includes(viewer.role))
        return error(403, 'insufficient_access', 'Developer access required');
      const input = parseBody(SetTaskCheckRequest, body);
      if (!input) return error(400, 'invalid_request', 'Invalid check result');
      const task = this.findTask(m[1]!);
      if (!task) return error(404, 'not_found', 'Unknown task');
      if (['done', 'cancelled'].includes(task.status)) return error(409, 'task_closed', 'Task is closed');
      if (input.check !== 'client_test' && taskAuthors(task).includes(this.viewerHandle))
        return error(403, 'self_review_forbidden', 'The assignee and PR authors cannot review their task');
      const from = task.checks[input.check] ?? null;
      this.updateTask(task.key, { checks: { ...task.checks, [input.check]: input.state } });
      if (from !== input.state)
        this.addTimeline(task.key, this.viewerHandle, 'task_check_changed', {
          check: input.check,
          from,
          to: input.state,
        });
      if (input.note !== undefined)
        this.addTimeline(task.key, this.viewerHandle, 'task_note', { text: input.note });
      return this.handleProject('GET', `/tasks/${task.key}`, undefined, query);
    }
    if ((m = /^\/tasks\/([A-Z][A-Z0-9]*-\d+)\/start$/.exec(rest)) && method === 'POST') {
      return this.startTask(m[1]!, body);
    }

    if ((m = /^\/tasks\/([A-Z][A-Z0-9]*-\d+)\/(cancel|reopen)$/.exec(rest)) && method === 'POST') {
      return this.taskLifecycle(m[1]!, m[2]!, body);
    }
    if (rest === '/roles') {
      if (method === 'GET') return ok({ roles: this.roleCatalogue() });
      if (method === 'POST') return this.saveRole(undefined, body);
    }
    if ((m = /^\/roles\/([a-z][a-z0-9_]+)$/.exec(rest))) {
      if (method === 'PUT') return this.saveRole(m[1]!, body);
      if (method === 'DELETE') return this.deleteRole(m[1]!);
    }
    if ((m = /^\/members\/([a-z0-9-]+)$/.exec(rest)) && method === 'PATCH')
      return this.editMember(m[1]!, body);

    if (rest === '/members') {
      if (method === 'POST') return this.hire(body);
      return ok(clone(this.members.filter((member) => member.status !== 'retired')));
    }
    if ((m = /^\/members\/([a-z0-9-]+)$/.exec(rest)) && method === 'DELETE') return this.retire(m[1]!, body);

    if ((m = /^\/sessions\/([\w-]+)$/.exec(rest))) {
      const session = this.findSession(m[1]!);
      if (!session) return error(404, 'not_found', 'Unknown session');
      const task = session.workItem.type === 'task' ? this.findTask(session.workItem.taskKey) : undefined;
      return ok({
        session: clone(session),
        chat: clone(this.chats[session.id] ?? []),
        task: task ? clone(task) : null,
      });
    }
    if ((m = /^\/sessions\/([\w-]+)\/messages$/.exec(rest)) && method === 'POST')
      return this.sessionMessage(m[1]!, body);
    if ((m = /^\/sessions\/([\w-]+)\/stop$/.exec(rest)) && method === 'POST') return this.stopSession(m[1]!);

    if (rest === '/messages') {
      if (method === 'POST') return this.humanTeamMessage(body);
      return ok({
        messages: clone(
          this.messages
            .filter((message) => {
              const peer = query.get('threadWith');
              return (
                !peer ||
                (message.from === this.viewerHandle && message.to.includes(peer)) ||
                (message.from === peer && message.to.includes(this.viewerHandle))
              );
            })
            .filter(
              (message) =>
                query.get('unreadOnly') !== 'true' ||
                (message.to.includes(this.viewerHandle) &&
                  !message.receipts?.find((r) => r.handle === this.viewerHandle)?.readAt),
            )
            .filter(
              (message) =>
                viewer.role !== 'client' ||
                message.from === this.viewerHandle ||
                message.to.includes(this.viewerHandle),
            ),
        ),
        unreadCount: this.messages.filter(
          (message) =>
            message.to.includes(this.viewerHandle) &&
            !message.receipts?.find((r) => r.handle === this.viewerHandle)?.readAt,
        ).length,
      });
    }
    if ((m = /^\/messages\/([\w-]+)\/read$/.exec(rest)) && method === 'POST') {
      const message = this.messages.find((entry) => entry.id === m![1]);
      if (!message) return error(404, 'not_found', 'Unknown message');
      if (!message.to.includes(this.viewerHandle))
        return error(403, 'not_a_recipient', 'Only recipients may mark read');
      message.receipts ??= message.to.map((handle) => ({
        handle,
        kind: this.findMember(handle)?.kind ?? 'human',
        deliveredAt: message.deliveredAt,
        readAt: null,
      }));
      const receipt = message.receipts.find((r) => r.handle === this.viewerHandle)!;
      receipt.readAt ??= nowIso();
      receipt.deliveredAt ??= nowIso();
      this.emit({ type: 'team_message', projectKey: fixtures.PROJECT_KEY, message: clone(message) });
      return ok(clone(message));
    }
    if ((m = /^\/members\/([a-z0-9-]+)\/(profile|memories|conversation|remove)$/.exec(rest))) {
      const handle = m[1]!;
      const member = this.findMember(handle);
      const original = this.config.team.members.find((entry) => entry.handle === handle);
      if (!member || !original || member.status === 'retired')
        return error(404, 'not_found', 'Unknown member');
      if (m[2] === 'conversation' && method === 'POST') return this.startConversation(handle);
      if (m[2] === 'memories' && method === 'GET') {
        if (viewer.role === 'client') return error(403, 'insufficient_access', 'Internal access required');
        if (member.kind !== 'ai') return error(400, 'not_ai_member', 'Only AI members have memory');
        return ok({ memory: this.memories[handle] ?? '' });
      }
      if (m[2] === 'remove' && method === 'DELETE') {
        if (handle === this.viewerHandle) return error(403, 'cannot_remove_self', 'Cannot remove yourself');
        if (original.kind !== 'human') return error(400, 'not_human_member', 'Only humans can be removed');
        const next = clone(this.config);
        next.team.members = next.team.members.filter((entry) => entry.handle !== handle);
        for (const stage of next.pipeline.stages)
          if (stage.owners) stage.owners = stage.owners.filter((h) => h !== handle);
        const failure = this.configChangeFailure(next);
        if (failure) return failure;
        this.config = next;
        for (const item of this.inbox.filter((i) => i.state === 'open' && i.assignees.includes(handle))) {
          const remaining = item.assignees.filter((h) => h !== handle);
          item.assignees = remaining.length
            ? remaining
            : next.team.members
                .filter((m) => m.kind === 'human' && m.access === 'owner')
                .map((m) => m.handle);
          this.emit({ type: 'inbox_upserted', projectKey: fixtures.PROJECT_KEY, item: clone(item) });
        }
        this.members = this.members.filter((entry) => entry.handle !== handle);
        for (const task of this.tasks.filter((t) => t.assignee === handle))
          this.updateTask(task.key, { assignee: null });
        this.commitConfig(`Remove human member ${handle}`);
        this.memberChanged(handle);
        return ok();
      }
      if (m[2] === 'profile' && method === 'GET') {
        const internal = viewer.role !== 'client';
        const visible = this.tasks.filter(
          (t) => !['done', 'cancelled'].includes(t.status) && (internal || t.visibility === 'shared'),
        );
        const awaiting = new Set(
          this.inbox.filter((i) => i.state === 'open' && i.assignees.includes(handle)).map((i) => i.taskKey),
        );
        const stages = this.config.pipeline.stages
          .filter((s) =>
            s.gate?.conditions.some(
              (c) => c.type === 'human_approval' && gateApprovers(this.config, c).includes(handle),
            ),
          )
          .map((s) => s.id);
        return ok({
          member: {
            ...clone(member),
            currentTaskKeys: member.currentTaskKeys.filter((k) => visible.some((t) => t.key === k)),
          },
          duties: memberDuties(this.config, original),
          tasks: clone(
            visible.filter(
              (t) =>
                t.assignee === handle ||
                member.currentTaskKeys.includes(t.key) ||
                stages.includes(t.stageId) ||
                awaiting.has(t.key),
            ),
          ),
          inbox: clone(
            this.inbox.filter(
              (i) =>
                i.state === 'open' &&
                i.assignees.includes(handle) &&
                (internal || handle === this.viewerHandle),
            ),
          ),
          timeline: internal
            ? clone(
                this.timeline
                  .filter(
                    (e) =>
                      e.actor.handle === handle ||
                      e.data.handle === handle ||
                      e.data.member === handle ||
                      e.data.assignee === handle ||
                      (Array.isArray(e.data.to) && e.data.to.includes(handle)),
                  )
                  .slice(-30),
              )
            : [],
          sessions: internal
            ? clone(
                this.sessions
                  .filter((s) => s.member === handle)
                  .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)),
              )
            : [],
          capacity: original.kind === 'ai' ? original.capacity : null,
          capacityUsed: original.kind === 'ai' && internal ? this.memberLoad(handle) : 0,
          ...(original.kind === 'human' && ['owner', 'admin'].includes(viewer.role) && original.email
            ? { email: original.email }
            : {}),
        });
      }
    }
    if (rest === '/inbox') return ok({ items: clone(this.inbox) });
    if ((m = /^\/inbox\/([\w-]+)\/resolve$/.exec(rest)) && method === 'POST')
      return this.resolve(m[1]!, body);

    if (rest === '/config') {
      if (method === 'PATCH') return this.patchConfig(body);
      return ok({ config: clone(this.config), version: this.configVersion, history: clone(this.history) });
    }
    if (rest === '/config/revert' && method === 'POST') {
      const input = parseBody(RevertConfigRequest, body);
      if (!input) return error(400, 'invalid_request', 'Invalid revert request');
      const target = this.history.find((entry) => entry.version === input.version);
      if (!target) return error(404, 'not_found', 'Unknown version');
      this.commitConfig(`Visszaállítva: ${target.version} (${target.message})`);
      return ok({ version: this.configVersion });
    }
    return error(404, 'not_found', `No route for ${method} ${rest}`);
  }

  /* ---------- mutations ---------- */

  private configChangeFailure(next: ProjectConfig): MockResponse | null {
    const viewer = this.config.team.members.find((m) => m.handle === this.viewerHandle);
    if (viewer?.kind !== 'human' || !['owner', 'admin'].includes(viewer.access))
      return error(403, 'insufficient_access', 'Requires admin access');
    if (viewer.access !== 'owner' && humanApprovalChanged(this.config, next))
      return error(403, 'owner_only', 'Only owners may change release approval');
    const issues = validateProjectConfig(next);
    return issues.some((i) => i.severity !== 'warning')
      ? error(400, 'config_invalid', 'Invalid configuration', { issues })
      : null;
  }

  private patchConfig(body: unknown): MockResponse {
    const member = this.config.team.members.find((member) => member.handle === this.viewerHandle);
    if (member?.kind !== 'human' || !['owner', 'admin'].includes(member.access)) {
      return error(403, 'insufficient_access', 'Requires admin access');
    }
    const parsed = PatchConfigRequest.safeParse(body);
    if (!parsed.success) {
      return error(400, 'config_invalid', 'Invalid configuration', {
        issues: configSchemaIssues(parsed.error.issues),
      });
    }
    const input = parsed.data;
    if (input.baseVersion !== this.configVersion) {
      return error(409, 'config_conflict', 'Configuration changed', { currentVersion: this.configVersion });
    }
    const next = applyConfigPatch(this.config, input);
    if (member.access !== 'owner' && humanApprovalChanged(this.config, next)) {
      return error(403, 'owner_only', 'Only owners may change human approval gates');
    }
    const stageIds = new Set(next.pipeline.stages.map((stage) => stage.id));
    for (const stage of this.config.pipeline.stages.filter((stage) => !stageIds.has(stage.id))) {
      const count = this.tasks.filter((task) => task.stageId === stage.id).length;
      if (count)
        return error(409, 'stage_in_use', 'Tasks still occupy the removed stage', {
          stageId: stage.id,
          tasks: count,
        });
    }
    const issues = validateProjectConfig(next);
    if (issues.some((issue) => issue.severity !== 'warning'))
      return error(400, 'config_invalid', 'Invalid configuration', { issues });
    if (JSON.stringify(next) !== JSON.stringify(this.config)) {
      this.config = next;
      const message =
        input.message ??
        (input.pipeline ? 'Update pipeline' : input.limits ? 'Update limits' : 'Update project');
      this.commitConfig(message);
      this.addTimeline(null, this.viewerHandle, 'config_changed', { version: this.configVersion, message });
    }
    return ok({ config: clone(this.config), version: this.configVersion, history: clone(this.history) });
  }

  private handleInvitations(method: string, rest: string, body: unknown): MockResponse {
    if (rest === '/invites' && method === 'GET') {
      const recent = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
      return ok({
        invitations: this.invitations
          .filter(
            (invite) =>
              (!invite.acceptedAt && !invite.revokedAt && invite.expiresAt > nowIso()) ||
              invite.createdAt >= recent ||
              (invite.acceptedAt ?? '') >= recent ||
              (invite.revokedAt ?? '') >= recent,
          )
          .map((invite) => InvitationView.parse(invite))
          .reverse(),
      });
    }
    if (rest === '/invites' && method === 'POST') {
      const input = parseBody(CreateInviteRequest, body);
      if (!input) return error(400, 'invalid_request', 'Invalid invitation');
      if (input.access === 'admin' && this.findMember(this.viewerHandle)?.role !== 'owner')
        return error(403, 'owner_only', 'Only an owner may invite an admin');
      if (
        this.config.team.members.some(
          (member) => member.kind === 'human' && member.email?.trim().toLowerCase() === input.email,
        )
      )
        return error(409, 'already_member', 'Already a human member');
      for (const id of input.roles) {
        const role = this.roleCatalogue().find((role) => role.id === id);
        if (!role) return error(400, 'unknown_role', 'Unknown role');
        if (
          this.findMember(this.viewerHandle)?.role !== 'owner' &&
          roleBundle(this.config, id).duties.includes('release_approval')
        )
          return error(403, 'owner_only', 'Only owners may grant release approval');
        if (!holdersAllow(role.holders, 'human')) return error(400, 'role_not_for_human', 'AI-only role');
      }
      const token = newInviteToken();
      const invite = {
        ...input,
        displayName: input.displayName ?? null,
        roles: [...new Set(input.roles)],
        id: mockId('inv'),
        projectKey: fixtures.PROJECT_KEY,
        invitedBy: this.user.userId,
        createdAt: nowIso(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
        acceptedAt: null,
        revokedAt: null,
        tokenHash: inviteTokenHash(token),
      };
      this.invitations.push(invite);
      return { status: 201, body: { ...InvitationView.parse(invite), path: `/invite/${token}` } };
    }
    const match = /^\/invites\/([^/]+)$/.exec(rest);
    if (match && method === 'DELETE') {
      const invite = this.invitations.find((invite) => invite.id === match[1]);
      if (!invite) return error(404, 'not_found', 'Unknown invitation');
      if (invite.acceptedAt) return error(409, 'invite_used', 'Invitation already used');
      invite.revokedAt ??= nowIso();
      return ok();
    }
    return error(404, 'not_found', 'Unknown invitation route');
  }

  private handlePublicInvite(method: string, token: string, accepting: boolean, body: unknown): MockResponse {
    if (!(method === 'GET' && !accepting) && !(method === 'POST' && accepting))
      return error(404, 'not_found', 'Unknown invitation route');
    if (this.inviteAttempts.resetAt <= Date.now())
      this.inviteAttempts = { count: 0, resetAt: Date.now() + 15 * 60_000 };
    if (this.inviteAttempts.count++ >= 10)
      return error(429, 'too_many_attempts', 'Too many invitation attempts');
    const invite = this.invitations.find((invite) => invite.tokenHash === inviteTokenHash(token));
    if (!invite || invite.acceptedAt || invite.revokedAt || invite.expiresAt <= nowIso())
      return error(404, 'invite_invalid', 'Invalid invitation');
    const account = this.accounts.get(invite.email);
    if (!accepting)
      return ok({
        projectKey: invite.projectKey,
        projectName: this.config.project.name,
        inviterName:
          [...this.accounts.values()].find((user) => user.userId === invite.invitedBy)?.name ??
          fixtures.mockUser.name,
        displayName: invite.displayName,
        access: invite.access,
        roles: invite.roles,
        roleNames: invite.roles.map((id) => this.roleCatalogue().find((role) => role.id === id)?.name ?? id),
        expiresAt: invite.expiresAt,
        requiresLogin: !!account,
      });
    if (account && (this.auth !== 'ready' || this.user.userId !== account.userId))
      return error(409, 'login_required', 'Log in as the invited account');
    if (account && !parseBody(AcceptInviteRequest, body))
      return error(400, 'invalid_request', 'Invalid invitation acceptance body');
    const input = account ? null : parseBody(AcceptInviteRequest.required(), body);
    if (!account && !input)
      return error(400, 'invalid_request', 'Name and eight-character password required');
    if (
      this.config.team.members.some(
        (member) => member.kind === 'human' && member.email?.toLowerCase() === invite.email,
      )
    )
      return error(409, 'already_member', 'Already a human member');
    for (const id of invite.roles) {
      const role = this.roleCatalogue().find((role) => role.id === id);
      if (!role) return error(400, 'unknown_role', 'Unknown role');
      if (!holdersAllow(role.holders, 'human')) return error(400, 'role_not_for_human', 'AI-only role');
    }
    const user = account ?? {
      userId: mockId('usr'),
      name: input!.name,
      email: invite.email,
      password: input!.password,
    };
    const base =
      user.name
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 24) || 'member';
    let handle = base;
    for (let suffix = 2; this.members.some((member) => member.handle === handle); suffix++)
      handle = `${base}-${suffix}`;
    this.config.team.members.push({
      kind: 'human',
      handle,
      displayName: user.name,
      email: user.email,
      access: invite.access,
      roles: invite.roles,
    });
    this.members.push({
      kind: 'human',
      handle,
      displayName: user.name,
      role: invite.access,
      roles: invite.roles,
      status: 'online',
      activity: null,
      currentTaskKeys: [],
      specialty: null,
      sponsor: null,
      temp: false,
    });
    this.accounts.set(user.email, user);
    this.user = { userId: user.userId, name: user.name, email: user.email };
    this.viewerHandle = handle;
    this.auth = 'ready';
    this.commitConfig(`Invite accepted: ${user.name}`);
    this.memberChanged(handle);
    invite.acceptedAt = nowIso();
    return ok(this.me());
  }

  private roleCatalogue(): RoleView[] {
    return [
      ...clone(fixtures.builtInRoles).map((role) => ({
        ...role,
        ...roleBundle(this.config, role.id),
        holders: roleHolders(role.id, this.config.team.roles, this.config.team.roleOverrides)!,
      })),
      ...this.config.team.roles.map((role) => ({
        ...role,
        duties: customRoleDuties(role),
        holders: roleHolders(role.id, this.config.team.roles)!,
        builtIn: false,
      })),
    ];
  }

  private validateRole(id: string, kind: 'human' | 'ai'): MockResponse | null {
    const role = this.roleCatalogue().find((entry) => entry.id === id);
    if (!role) return error(400, 'unknown_role', 'Unknown role');
    if (!holdersAllow(role.holders, kind))
      return error(
        400,
        kind === 'ai' ? 'role_not_for_ai' : 'role_not_for_human',
        'Role does not allow this member kind',
      );
    return null;
  }

  private roleUsage(id: string, holders?: 'human' | 'ai' | 'both') {
    return {
      members: this.config.team.members
        .filter(
          (member) =>
            (member.kind === 'ai' ? member.role === id : member.roles.includes(id)) &&
            (!holders || !holdersAllow(holders, member.kind)),
        )
        .map((member) => member.handle),
      tempWorkers:
        this.config.team.limits.tempWorkers.role === id && (!holders || !holdersAllow(holders, 'ai')),
    };
  }

  private saveRole(id: string | undefined, body: unknown): MockResponse {
    const input = parseBody(CustomRoleRequest, body);
    if (!input) return error(400, 'invalid_request', 'Invalid role');
    if (id && input.id !== id) return error(400, 'role_id_mismatch', 'Role id differs');
    if (isBuiltInRole(input.id))
      return error(id ? 400 : 409, id ? 'builtin_role' : 'custom_role_shadows_builtin', 'Built-in role');
    const index = this.config.team.roles.findIndex((role) => role.id === input.id);
    if (id && index < 0) return error(404, 'not_found', 'Unknown role');
    if (!id && index >= 0) return error(409, 'duplicate_role', 'Duplicate role');
    const usage = this.roleUsage(input.id, roleHolders(input.id, [input])!);
    if (usage.members.length || usage.tempWorkers) return error(409, 'role_in_use', 'Role is in use', usage);
    const next = clone(this.config);
    if (id) next.team.roles[index] = input;
    else next.team.roles.push(input);
    const failure = this.configChangeFailure(next);
    if (failure) return failure;
    if (id) this.config.team.roles[index] = input;
    else this.config.team.roles.push(input);
    this.commitConfig(`${id ? 'Update' : 'Add'} role ${input.id}`);
    return { status: id ? 200 : 201, body: this.roleCatalogue().find((role) => role.id === input.id) };
  }

  private deleteRole(id: string): MockResponse {
    if (isBuiltInRole(id)) return error(400, 'builtin_role', 'Built-in role');
    if (!this.config.team.roles.some((role) => role.id === id))
      return error(404, 'not_found', 'Unknown role');
    const usage = this.roleUsage(id);
    if (usage.members.length || usage.tempWorkers) return error(409, 'role_in_use', 'Role is in use', usage);
    const next = clone(this.config);
    next.team.roles = next.team.roles.filter((role) => role.id !== id);
    const failure = this.configChangeFailure(next);
    if (failure) return failure;
    this.config.team.roles = next.team.roles;
    this.commitConfig(`Remove role ${id}`);
    return ok();
  }

  private editMember(handle: string, body: unknown): MockResponse {
    const input = parseBody(UpdateMemberRequest, body);
    if (!input) return error(400, 'invalid_request', 'Invalid member update');
    const member = this.findMember(handle);
    const config = this.config.team.members.find((entry) => entry.handle === handle);
    if (!member || !config) return error(404, 'not_found', 'Unknown member');
    if (input.roles !== undefined) {
      if (config.kind !== 'human') return error(400, 'not_human_member', 'Not a human member');
      for (const role of input.roles) {
        const failure = this.validateRole(role, 'human');
        if (failure) return failure;
      }
    }
    if (
      config.kind !== 'ai' &&
      (input.specialty !== undefined ||
        input.model !== undefined ||
        input.schedule !== undefined ||
        input.provider !== undefined ||
        input.effort !== undefined)
    )
      return error(400, 'not_ai_member', 'Not an AI member');
    const next = clone(this.config);
    const nextMember = next.team.members.find((m) => m.handle === handle)!;
    if (input.access !== undefined && nextMember.kind !== 'human')
      return error(400, 'not_human_member', 'Access is for humans');
    if (nextMember.kind === 'human' && input.access !== undefined) nextMember.access = input.access;
    if (nextMember.kind === 'human' && input.roles !== undefined) nextMember.roles = input.roles;
    const failure = this.configChangeFailure(next);
    if (failure) return failure;
    if (input.displayName !== undefined) member.displayName = config.displayName = input.displayName;
    if (config.kind === 'human' && input.access !== undefined) member.role = config.access = input.access;
    if (config.kind === 'human' && input.roles !== undefined)
      member.roles = config.roles = [...new Set(input.roles)];
    if (config.kind === 'ai') {
      if (input.specialty !== undefined) {
        config.specialty = input.specialty.trim() || undefined;
        member.specialty = config.specialty ?? null;
      }
      if (input.model !== undefined) member.model = config.model = input.model;
      if (input.provider !== undefined && input.provider !== (config.provider ?? 'claude')) {
        member.provider = config.provider = input.provider;
        member.model = config.model = modelForProvider(input.provider, config.model);
      }
      if (input.effort !== undefined) {
        if (input.effort === null) {
          delete member.effort;
          delete config.effort;
        } else member.effort = config.effort = input.effort;
      }
      if (input.schedule !== undefined) config.schedule = input.schedule ?? undefined;
    }
    this.commitConfig(`Update member ${handle}`);
    this.memberChanged(handle);
    return ok(clone(member));
  }

  private taskPullRequests(task: Task) {
    return task.links
      .filter((link) => link.kind === 'pull_request' && link.repo)
      .map((link) => ({
        repo: link.repo!,
        number: Number(link.ref),
        url: `https://github.com/${link.repo}/pull/${link.ref}`,
        title: link.title ?? null,
        state: link.state ?? null,
        checks: 'passing',
        reviewDecision: 'approved',
        additions: 42,
        deletions: 8,
      }));
  }

  private taskSessions(taskKey: string): Session[] {
    return this.sessions.filter(
      (session) => session.workItem.type === 'task' && session.workItem.taskKey === taskKey,
    );
  }

  private taskLifecycle(taskKey: string, action: string, body: unknown): MockResponse {
    const input =
      action === 'cancel' ? parseBody(CancelTaskRequest, body) : parseBody(ReopenTaskRequest, body);
    if (!input) return error(400, 'invalid_request', 'Invalid lifecycle request');
    const task = this.findTask(taskKey);
    if (!task) return error(404, 'not_found', 'Unknown task');
    if (action === 'cancel') {
      if (['done', 'cancelled'].includes(task.status)) return error(409, 'task_closed', 'Task is closed');
      const previousStatus = task.status;
      const reason = 'reason' in input ? input.reason : undefined;
      this.updateTask(taskKey, { status: 'cancelled', closedAt: nowIso() });
      this.addTimeline(taskKey, this.owner, 'task_updated', {
        action: 'cancelled',
        previousStatus,
        fields: ['status', 'closedAt'],
        ...(reason === undefined ? {} : { reason }),
      });
      for (const session of this.taskSessions(taskKey))
        if (!['exited', 'failed'].includes(session.state)) this.stopSession(session.id);
      for (const item of this.inbox.filter((entry) => entry.taskKey === taskKey && entry.state === 'open'))
        this.upsertInbox({ ...item, state: 'cancelled' });
      for (const member of this.members)
        member.currentTaskKeys = member.currentTaskKeys.filter((key) => key !== taskKey);
    } else {
      if (task.status !== 'cancelled') return error(409, 'task_not_cancelled', 'Task is not cancelled');
      const previousAssignee = task.assignee;
      this.updateTask(taskKey, { status: 'active', closedAt: null, assignee: null });
      this.addTimeline(taskKey, this.owner, 'task_updated', {
        action: 'reopened',
        previousAssignee,
        fields: ['status', 'closedAt', 'assignee'],
      });
    }
    return ok(clone(task));
  }

  private moveTask(task: Task, stageId: string): MockResponse {
    if (['done', 'cancelled'].includes(task.status)) return error(409, 'task_closed', 'Task is closed');
    const stages = resolvedStages(this.config);
    const to = stages.findIndex((stage) => stage.id === stageId);
    if (to < 0) return error(400, 'unknown_stage', 'Unknown stage');
    if (task.stageId === stageId) return ok(task);
    const from = stages.findIndex((stage) => stage.id === task.stageId);
    const entered = to > from ? stages.slice(from + 1, to + 1) : [stages[to]!];
    const unmet: Array<{ stageId: string; condition: GateCondition }> = [];
    const approvals: Array<{ stageId: string; conditionIndex: number; approvers: string[] }> = [];
    for (const stage of entered) {
      (stage.gate?.conditions ?? []).forEach((condition, conditionIndex) => {
        if (condition.type === 'human_approval') {
          approvals.push({
            stageId: stage.id,
            conditionIndex,
            approvers: gateApprovers(this.config, condition).filter(
              (h) =>
                !(
                  stage.kind === 'release' &&
                  this.config.team.releaseFourEyes &&
                  taskAuthors(task).includes(h)
                ),
            ),
          });
        } else {
          const prs = task.links.filter((link) => link.kind === 'pull_request');
          const holds =
            condition.type === 'check_passed'
              ? task.checks[condition.check] === 'passed'
              : prs.some((pr) => pr.state === 'merged') &&
                prs.every((pr) => pr.state === 'merged' || pr.state === 'closed');
          if (!holds) unmet.push({ stageId: stage.id, condition });
        }
      });
    }
    if (unmet.length) return error(409, 'gate_blocked', 'Gate conditions are not met', { unmet, approvals });
    if (approvals.some((a) => !a.approvers.length))
      return error(409, 'release_four_eyes', 'No independent human approver is available');
    if (approvals.length) {
      const items: InboxItem[] = [];
      const requestId = mockId('gate');
      for (const requirement of approvals) {
        const existing = this.inbox.find((item) => {
          const gate = item.payload.gate as
            | { fromStageId?: string; toStageId?: string; stageId?: string; conditionIndex?: number }
            | undefined;
          return (
            item.state === 'open' &&
            item.taskKey === task.key &&
            gate?.fromStageId === task.stageId &&
            gate.toStageId === stageId &&
            gate.stageId === requirement.stageId &&
            gate.conditionIndex === requirement.conditionIndex
          );
        });
        const item: InboxItem = existing ?? {
          id: mockId('inb'),
          projectKey: task.projectKey,
          kind: 'decision',
          assignees: requirement.approvers,
          source: this.viewerHandle,
          sessionId: null,
          taskKey: task.key,
          title: task.title,
          body: null,
          payload: {
            gate: {
              requestId,
              taskKey: task.key,
              fromStageId: task.stageId,
              toStageId: stageId,
              stageId: requirement.stageId,
              conditionIndex: requirement.conditionIndex,
              requestedBy: { kind: 'human', handle: this.viewerHandle },
            },
          },
          options: fixtures.DECISION_OPTIONS,
          state: 'open',
          resolution: null,
          createdAt: nowIso(),
        };
        if (!existing) this.upsertInbox(item);
        items.push(item);
      }
      this.updateTask(task.key, { status: 'waiting' });
      return error(409, 'approval_requested', 'Approvers were asked', {
        inboxItemIds: items.map((item) => item.id),
        approvers: [...new Set(items.flatMap((item) => item.assignees))],
      });
    }
    const previous = task.stageId;
    const done = stages[to]!.kind === 'done';
    this.updateTask(task.key, {
      stageId,
      status: done ? 'done' : 'active',
      closedAt: done ? nowIso() : null,
    });
    this.addTimeline(task.key, this.viewerHandle, 'task_stage_changed', { from: previous, to: stageId });
    return ok(task);
  }

  private createTask(body: unknown): MockResponse {
    const input = parseBody(CreateTaskRequest, body);
    if (!input) return error(400, 'invalid_request', 'Invalid task');
    this.taskSeq += 1;
    const now = nowIso();
    const task: Task = {
      id: mockId('tsk'),
      projectKey: fixtures.PROJECT_KEY,
      key: `${fixtures.PROJECT_KEY}-${this.taskSeq}`,
      title: input.title,
      description: input.description ?? '',
      stageId: input.stageId ?? this.config.pipeline.stages[0]!.id,
      status: 'active',
      assignee: null,
      repo: input.repo ?? null,
      priority: null,
      labels: input.labels ?? [],
      checks: {},
      links: [],
      visibility: input.visibility ?? 'internal',
      createdBy: this.owner,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
    this.tasks.push(task);
    this.emit({ type: 'task_upserted', projectKey: task.projectKey, task: clone(task) });
    this.addTimeline(task.key, this.owner, 'task_created', { title: task.title });
    return { status: 201, body: clone(task) };
  }

  private startTask(taskKey: string, body: unknown): MockResponse {
    const input = parseBody(StartTaskRequest, body);
    const task = this.findTask(taskKey);
    if (!task || !input) return error(404, 'not_found', 'Unknown task');
    if (['done', 'cancelled'].includes(task.status)) return error(409, 'task_closed', 'Task is closed');
    const workStage = this.config.pipeline.stages.find((stage) => stage.kind === 'work');
    const eligible = workStage ? stageOwners(this.config, workStage) : [];
    const developers = this.members.filter(
      (member) => eligible.includes(member.handle) && member.status !== 'retired',
    );
    const assignee =
      input.assignee ??
      [...developers].sort((a, b) => a.currentTaskKeys.length - b.currentTaskKeys.length)[0]?.handle ??
      null;
    if (!assignee) return error(409, 'no_developer', 'No developer available');
    if (!eligible.includes(assignee))
      return error(400, 'not_stage_owner', 'Assignee must own the work stage');
    const from = task.stageId;
    this.updateTask(task.key, { assignee, stageId: workStage?.id ?? task.stageId, status: 'active' });
    this.addTimeline(task.key, null, 'task_assigned', { assignee });
    if (workStage) this.addTimeline(task.key, null, 'task_stage_changed', { from, to: workStage.id });
    if (this.findMember(assignee)?.kind === 'human')
      return ok({ task: clone(task), session: null, hired: null });
    const session: Session = {
      id: mockId('ses'),
      projectKey: fixtures.PROJECT_KEY,
      member: assignee,
      workItem: { type: 'task', taskKey: task.key },
      claudeSessionId: mockUuid(Math.floor(Math.random() * 1e9)),
      cwd: `/Users/owner/.projectman/worktrees/${fixtures.PROJECT_KEY}/${task.key}`,
      branch: `${task.key.split('-')[1]}-work`,
      transcriptPath: null,
      state: 'starting',
      activity: null,
      startedAt: nowIso(),
      lastActivityAt: nowIso(),
      endedAt: null,
    };
    this.sessions.push(session);
    this.chats[session.id] = [];
    this.flushTeamMessages(session);
    this.emit({ type: 'session_upserted', projectKey: session.projectKey, session: clone(session) });
    this.addTimeline(task.key, assignee, 'session_started', { member: assignee, resumed: false }, session.id);
    const member = this.findMember(assignee);
    if (member) member.currentTaskKeys = [...member.currentTaskKeys, task.key];
    this.setMemberState(assignee, 'working', `Indul: ${task.key}`);
    this.later(900, () => {
      if (session.state === 'exited' || task.status === 'cancelled') return;
      this.updateSession(session.id, { state: 'working', activity: 'Read: README.md' });
      this.appendChat(session.id, [
        this.chatItem('user_text', {
          origin: 'brief',
          text: `Task ${task.key}: ${task.title}\n\n${task.description}`,
        }),
        this.chatItem('assistant_text', { text: 'Átnézem a feladatot és a kódtárat, aztán nekiállok.' }),
      ]);
    });
    this.later(2600, () => {
      if (session.state === 'exited' || task.status === 'cancelled') return;
      const call = this.chatItem('tool_call', {
        toolUseId: mockId('toolu'),
        name: 'Read',
        summary: 'README.md',
        input: {},
      });
      this.appendChat(session.id, [call]);
      this.later(700, () => {
        if (call.kind !== 'tool_call' || session.state === 'exited' || task.status === 'cancelled') return;
        this.appendChat(session.id, [
          this.chatItem('tool_result', { toolUseId: call.toolUseId, ok: true, summary: '88 sor' }),
        ]);
        this.setMemberState(assignee, 'working', `Olvassa: ${task.key}`);
      });
    });
    return ok({
      task: clone(task),
      pullRequests: this.taskPullRequests(task),
      timeline: clone(this.timeline.filter((event) => event.taskKey === task.key)),
      sessions: clone(
        this.sessions.filter((s) => s.workItem.type === 'task' && s.workItem.taskKey === task.key),
      ),
    });
  }

  private hire(body: unknown): MockResponse {
    const input = parseBody(HireMemberRequest, body);
    if (!input) return error(400, 'invalid_request', 'Invalid hire request');
    const failure = this.validateRole(input.role, 'ai');
    if (failure) return failure;
    const taken = (candidate: string) => this.members.some((member) => member.handle === candidate);
    if (input.handle && taken(input.handle)) return error(409, 'handle_taken', 'Handle already taken');
    const base = input.role === 'developer' ? 'dev' : input.role.replace(/_/g, '-');
    let handle = input.handle ?? base;
    for (let n = 2; taken(handle); n += 1) handle = `${base}-${n}`;
    const member: MemberView = {
      handle,
      displayName: input.displayName ?? this.roleCatalogue().find((role) => role.id === input.role)!.name,
      kind: 'ai',
      provider: input.provider ?? 'claude',
      model: input.provider === 'codex' ? modelForProvider('codex', input.model) : (input.model ?? 'opus'),
      effort: input.effort,
      permissionMode: 'default',
      role: input.role,
      roles: [input.role],
      specialty: input.specialty ?? null,
      status: 'idle',
      activity: null,
      currentTaskKeys: [],
      sponsor: this.owner,
      temp: false,
    };
    this.members.push(member);
    const config: AiMemberConfig = {
      kind: 'ai',
      provider: input.provider ?? 'claude',
      handle,
      displayName: member.displayName,
      role: input.role,
      specialty: input.specialty,
      model: input.provider === 'codex' ? modelForProvider('codex', input.model) : (input.model ?? 'opus'),
      effort: input.effort,
      permissionMode: 'default',
      capacity: 1,
      instructions: '',
      schedule: input.schedule,
      sponsor: this.owner,
      temp: false,
    };
    this.config.team.members.push(config);
    this.commitConfig(`Felvéve: ${member.displayName} (${handle})`);
    this.memberChanged(handle);
    return { status: 201, body: clone(member) };
  }

  private retire(handle: string, body: unknown): MockResponse {
    const input = parseBody(RetireMemberRequest, body) ?? {};
    const member = this.findMember(handle);
    if (!member || member.kind !== 'ai') return error(404, 'not_found', 'Unknown AI member');
    const target = input.handoverTo ? this.findMember(input.handoverTo) : undefined;
    const next = clone(this.config);
    next.team.members = next.team.members.filter((m) => m.handle !== handle);
    for (const stage of next.pipeline.stages) {
      if (stage.owners)
        stage.owners = [
          ...new Set(stage.owners.flatMap((h) => (h === handle ? (target ? [target.handle] : []) : [h]))),
        ];
    }
    const failure = this.configChangeFailure(next);
    if (failure) return failure;

    for (const taskKey of member.currentTaskKeys) {
      const task = this.findTask(taskKey);
      if (task?.assignee === handle) this.updateTask(taskKey, { assignee: target?.handle ?? null });
      if (target) target.currentTaskKeys = [...target.currentTaskKeys, taskKey];
    }
    for (const stage of this.config.pipeline.stages) {
      if ((stage.owners ?? []).includes(handle)) {
        stage.owners = (stage.owners ?? []).filter((owner) => owner !== handle);
        if (target && !(stage.owners ?? []).includes(target.handle)) stage.owners.push(target.handle);
      }
    }
    member.status = 'retired';
    member.currentTaskKeys = [];
    this.config.team.members = this.config.team.members.filter((entry) => entry.handle !== handle);
    this.addTimeline(null, this.owner, 'member_retired', { handle, handoverTo: target?.handle ?? null });
    this.commitConfig(`Elbocsátva: ${member.displayName} (${handle})`);
    this.memberChanged(handle);
    return ok();
  }

  private sessionMessage(sessionId: string, body: unknown): MockResponse {
    const input = parseBody(SendMessageRequest, body);
    const session = this.findSession(sessionId);
    if (!session || !input) return error(404, 'not_found', 'Unknown session');
    const taskKey = session.workItem.type === 'task' ? session.workItem.taskKey : null;
    if (taskKey && ['done', 'cancelled'].includes(this.findTask(taskKey)?.status ?? ''))
      return error(409, 'task_closed', 'Task is closed');
    const stops = this.sessionStops.get(sessionId);
    const wasIdle = session.state !== 'working';
    this.later(wasIdle ? 350 : 1500, () => {
      if (this.sessionStops.get(sessionId) !== stops) return;
      this.appendChat(sessionId, [this.chatItem('user_text', { origin: 'human', text: input.text })]);
      this.updateSession(sessionId, { state: 'working', activity: null, endedAt: null });
      this.setMemberState(session.member, 'working', 'Válaszol');
    });
    this.later(wasIdle ? 2200 : 3400, () => {
      if (this.sessionStops.get(sessionId) !== stops) return;
      this.appendChat(sessionId, [
        this.chatItem('assistant_text', {
          text: 'Rendben, megnézem. Ha kész, jelzek a csapatnak, és ide is visszaírok.',
        }),
      ]);
      this.updateSession(sessionId, { state: 'idle', activity: null });
      this.setMemberState(session.member, 'idle', null);
    });
    return { status: 202 };
  }

  private memberLoad(handle: string): number {
    const keys = new Set(this.tasks.filter((t) => t.assignee === handle).map((t) => t.key));
    for (const s of this.sessions)
      if (s.member === handle && s.workItem.type === 'task') keys.add(s.workItem.taskKey);
    return (
      this.tasks.filter((t) => keys.has(t.key) && !['done', 'cancelled'].includes(t.status)).length +
      this.sessions.filter(
        (s) => s.member === handle && s.workItem.type !== 'task' && !['exited', 'failed'].includes(s.state),
      ).length
    );
  }

  private humanTeamMessage(body: unknown): MockResponse {
    const viewer = this.findMember(this.viewerHandle);
    if (!viewer || !['owner', 'admin', 'developer', 'client'].includes(viewer.role))
      return error(403, 'insufficient_access', 'Developer or client required');
    const input = parseBody(SendTeamMessageRequest, body);
    if (!input) return error(400, 'invalid_request', 'Invalid message');
    if (input.to.some((h) => !this.config.team.members.some((m) => m.handle === h)))
      return error(404, 'not_found', 'Unknown member');
    if (input.taskKey) {
      const task = this.findTask(input.taskKey);
      if (!task || (viewer.role === 'client' && task.visibility !== 'shared'))
        return error(404, 'not_found', 'Unknown task');
    }
    const message = this.sendTeamMessage(
      this.viewerHandle,
      [...new Set(input.to)],
      input.taskKey ?? null,
      input.text,
    );
    return { status: 202, body: clone(message) };
  }

  private flushTeamMessages(session: Session): void {
    if (!['idle', 'waiting_input'].includes(session.state)) return;
    for (const message of this.messages) {
      const receipt = message.receipts?.find(
        (r) => r.handle === session.member && r.kind === 'ai' && !r.deliveredAt,
      );
      if (!receipt) continue;
      this.appendChat(session.id, [
        this.chatItem('team_message', {
          direction: 'in',
          from: message.from,
          to: [session.member],
          text: message.body,
        }),
      ]);
      receipt.deliveredAt = nowIso();
      if (message.receipts!.every((r) => r.deliveredAt)) message.deliveredAt = nowIso();
      this.emit({ type: 'team_message', projectKey: fixtures.PROJECT_KEY, message: clone(message) });
    }
  }

  private startConversation(handle: string): MockResponse {
    if (!['owner', 'admin', 'developer'].includes(this.findMember(this.viewerHandle)?.role ?? ''))
      return error(403, 'insufficient_access', 'Developer access required');
    const member = this.config.team.members.find((m) => m.handle === handle);
    if (!member) return error(404, 'not_found', 'Unknown member');
    if (member.kind !== 'ai') return error(400, 'not_ai_member', 'Only AI conversations');
    const existing = this.sessions.find((s) => s.member === handle && s.workItem.type === 'general');
    if (existing && !['exited', 'failed'].includes(existing.state))
      return { status: 202, body: clone(existing) };
    if (this.memberLoad(handle) >= member.capacity) return error(409, 'member_at_capacity', 'At capacity');
    const provider = member.provider ?? 'claude';
    const plan =
      this.providerPlanUsage[provider] ?? (provider === 'claude' ? this.planUsage : this.codexPlanUsage);
    if (
      this.sessions.filter((s) => ['starting', 'working', 'waiting_permission'].includes(s.state)).length >=
      this.config.team.limits.maxConcurrentAi
    )
      return error(409, 'ai_limit_reached', 'Too many sessions');
    if (
      Math.max(plan?.fiveHourPercent ?? 0, plan?.weeklyPercent ?? 0) >
      this.config.team.limits.pauseAbovePlanUsagePercent
    )
      return error(409, 'plan_usage_paused', 'Plan usage paused');
    if (!this.providerLoggedIn[provider])
      return error(409, 'provider_not_logged_in', 'Provider not logged in', { provider });
    const at = nowIso();
    const session: Session = existing ?? {
      id: mockId('ses'),
      projectKey: fixtures.PROJECT_KEY,
      member: handle,
      workItem: { type: 'general' },
      claudeSessionId: mockUuid(this.sessions.length + 1),
      cwd: this.config.project.workspacePath,
      branch: null,
      transcriptPath: null,
      state: 'idle',
      activity: null,
      startedAt: at,
      lastActivityAt: at,
      endedAt: null,
    };
    if (!existing) this.sessions.push(session);
    this.chats[session.id] ??= [];
    this.updateSession(session.id, { state: 'idle', endedAt: null });
    this.addTimeline(
      null,
      handle,
      'session_started',
      { member: handle, resumed: Boolean(existing) },
      session.id,
    );
    this.flushTeamMessages(session);
    return { status: 202, body: clone(session) };
  }

  private schedulesView() {
    return {
      timezone: this.config.project.timezone,
      members: this.config.team.members.flatMap((member) => {
        if (member.kind !== 'ai' || !member.schedule) return [];
        let nextRun: string | null = null;
        try {
          nextRun = nextCronRun(member.schedule.cron, new Date(), this.config.project.timezone);
        } catch {
          /* Invalid legacy schedule. */
        }
        return [
          {
            member: member.handle,
            cron: member.schedule.cron,
            promptSummary: member.schedule.prompt.replace(/\s+/g, ' ').slice(0, 140),
            nextRun,
          },
        ];
      }),
      runs: clone(this.scheduleRuns.slice(-20).reverse()),
    };
  }

  private runSchedule(handle: string): MockResponse {
    const member = this.config.team.members.find((m) => m.handle === handle);
    if (!member) return error(404, 'not_found', 'Unknown member');
    if (member.kind !== 'ai' || !member.schedule)
      return error(400, 'member_not_scheduled', 'Member has no AI schedule');
    const live = this.sessions.filter((s) => !['exited', 'failed'].includes(s.state));
    const keys = new Set(this.tasks.filter((t) => t.assignee === handle).map((t) => t.key));
    for (const session of this.sessions)
      if (session.member === handle && session.workItem.type === 'task') keys.add(session.workItem.taskKey);
    const load =
      this.tasks.filter((t) => keys.has(t.key) && !['done', 'cancelled'].includes(t.status)).length +
      live.filter((s) => s.member === handle && s.workItem.type !== 'task').length;
    const provider = member.provider ?? 'claude';
    const plan = this.providerPlanUsage[provider] ?? (provider === 'claude' ? this.planUsage : null);
    const usage = Math.max(plan?.fiveHourPercent ?? 0, plan?.weeklyPercent ?? 0);
    const reason = live.some((s) => s.member === handle && s.workItem.type === 'schedule')
      ? 'previous_run_live'
      : load >= member.capacity
        ? 'member_at_capacity'
        : live.filter((s) => ['starting', 'working', 'waiting_permission'].includes(s.state)).length >=
            this.config.team.limits.maxConcurrentAi
          ? 'ai_limit_reached'
          : usage > this.config.team.limits.pauseAbovePlanUsagePercent
            ? 'plan_usage_paused'
            : !this.providerLoggedIn[provider]
              ? 'provider_not_logged_in'
              : null;
    const at = nowIso();
    const run: ScheduleRun = {
      id: mockId('run'),
      projectKey: fixtures.PROJECT_KEY,
      member: handle,
      scheduledFor: at,
      startedAt: reason ? null : at,
      sessionId: null,
      status: reason ? 'skipped' : 'started',
      reason,
    };
    this.scheduleRuns.push(run);
    if (reason) {
      this.addTimeline(null, null, 'schedule_skipped', {
        runId: run.id,
        member: handle,
        scheduledFor: at,
        reason,
      });
      return error(409, reason, 'Scheduled run refused', { reason, run: clone(run) });
    }
    const session: Session = {
      id: mockId('ses'),
      projectKey: fixtures.PROJECT_KEY,
      member: handle,
      workItem: { type: 'schedule', runId: run.id },
      claudeSessionId: mockUuid(this.sessions.length + 1),
      cwd: this.config.project.workspacePath,
      branch: null,
      transcriptPath: null,
      state: 'working',
      activity: null,
      startedAt: at,
      lastActivityAt: at,
      endedAt: null,
    };
    run.sessionId = session.id;
    this.sessions.push(session);
    this.chats[session.id] = [this.chatItem('user_text', { text: member.schedule.prompt, origin: 'brief' })];
    this.flushTeamMessages(session);
    this.emit({ type: 'session_upserted', projectKey: fixtures.PROJECT_KEY, session: clone(session) });
    this.addTimeline(
      null,
      null,
      'schedule_started',
      { runId: run.id, member: handle, scheduledFor: at },
      session.id,
    );
    return { status: 201, body: clone(run) };
  }

  private stopSession(sessionId: string): MockResponse {
    const session = this.findSession(sessionId);
    if (!session) return error(404, 'not_found', 'Unknown session');
    this.sessionStops.set(sessionId, (this.sessionStops.get(sessionId) ?? 0) + 1);
    this.updateSession(sessionId, { state: 'exited', activity: null, endedAt: nowIso() });
    this.appendChat(sessionId, [this.chatItem('system_note', { text: 'A session leállt.' })]);
    if (session.workItem.type === 'task') {
      this.addTimeline(
        session.workItem.taskKey,
        session.member,
        'session_ended',
        { member: session.member, exitCode: 0 },
        sessionId,
      );
    }
    this.setMemberState(session.member, 'idle', null);
    return ok();
  }

  private resolve(itemId: string, body: unknown): MockResponse {
    const input = parseBody(ResolveInboxRequest, body);
    const item = this.inbox.find((entry) => entry.id === itemId);
    if (!item || !input) return error(404, 'not_found', 'Unknown inbox item');
    if (item.state !== 'open') return error(409, 'inbox_item_closed', 'Already resolved');
    if (!item.options.some((option) => option.id === input.optionId)) {
      return error(400, 'unknown_option', `Unknown option ${input.optionId}`);
    }
    if (item.kind === 'question' && input.optionId === 'answer' && !input.note?.trim()) {
      return error(400, 'answer_required', 'A free-text answer needs a note');
    }
    const viewer = this.config.team.members.find((m) => m.handle === this.viewerHandle);
    if (viewer?.kind !== 'human') return error(403, 'ai_approval_forbidden', 'Only humans may approve');
    if (!item.assignees.includes(viewer.handle) && !(item.kind !== 'decision' && viewer.access === 'owner'))
      return error(403, 'not_an_assignee', 'Only assignees may decide');
    const gate = item.payload.gate as { stageId?: string; conditionIndex?: number } | undefined;
    const stage = this.config.pipeline.stages.find((s) => s.id === gate?.stageId);
    const condition = stage?.gate?.conditions[Number(gate?.conditionIndex)];
    const task = item.taskKey ? this.findTask(item.taskKey) : undefined;
    if (
      input.optionId === 'approve' &&
      stage?.kind === 'release' &&
      this.config.team.releaseFourEyes &&
      task &&
      taskAuthors(task).includes(viewer.handle)
    )
      return error(403, 'release_four_eyes', 'Independent approval required');
    if (
      input.optionId === 'approve' &&
      condition?.type === 'human_approval' &&
      !gateApprovers(this.config, condition).includes(viewer.handle)
    )
      return error(403, 'not_an_assignee', 'Current gate changed');
    const resolved: InboxItem = {
      ...item,
      state: 'resolved',
      resolution: { optionId: input.optionId, by: this.viewerHandle, at: nowIso(), note: input.note ?? null },
    };
    this.upsertInbox(resolved);
    this.planUsage.fiveHourPercent = Math.min(99, (this.planUsage.fiveHourPercent ?? 0) + 1);
    this.emit({
      type: 'plan_usage',
      projectKey: fixtures.PROJECT_KEY,
      provider: 'claude',
      usage: clone(this.planUsage),
    });
    if (
      this.members.some(
        (member) => member.kind === 'ai' && member.provider === 'codex' && member.status !== 'retired',
      )
    ) {
      this.emit({
        type: 'plan_usage',
        projectKey: fixtures.PROJECT_KEY,
        provider: 'codex',
        usage: clone(this.codexPlanUsage),
      });
    }
    this.later(250, () => this.afterResolve(resolved, input));
    return ok(clone(resolved));
  }

  private afterResolve(item: InboxItem, input: ResolveInboxRequest): void {
    const sessionId = item.sessionId;
    const source = item.source;
    if (item.taskKey && this.findTask(item.taskKey)?.status === 'cancelled') return;
    if (sessionId && this.findSession(sessionId)?.state === 'exited') return;
    if (item.kind === 'permission') {
      const allowed = input.optionId !== 'deny';
      if (item.taskKey) {
        this.addTimeline(
          item.taskKey,
          this.owner,
          'permission_resolved',
          {
            inboxItemId: item.id,
            decision: allowed ? 'allow' : 'deny',
          },
          sessionId,
        );
      }
      if (!sessionId) return;
      const chat = this.chats[sessionId] ?? [];
      const answered = new Set(
        chat.flatMap((entry) => (entry.kind === 'tool_result' ? [entry.toolUseId] : [])),
      );
      const pending = [...chat]
        .reverse()
        .find((entry) => entry.kind === 'tool_call' && !answered.has(entry.toolUseId));
      if (pending && pending.kind === 'tool_call') {
        this.appendChat(sessionId, [
          this.chatItem('tool_result', {
            toolUseId: pending.toolUseId,
            ok: allowed,
            summary: allowed ? 'feltöltve' : 'elutasítva',
          }),
        ]);
      }
      if (!allowed) {
        this.appendChat(sessionId, [
          this.chatItem('assistant_text', {
            text: 'Rendben, ezt nem futtatom. Írd meg, mi legyen helyette.',
          }),
        ]);
        this.updateSession(sessionId, { state: 'idle', activity: null });
        this.setMemberState(source, 'idle', 'Válaszra vár');
        return;
      }
      if (item.id !== 'inb_perm_push') {
        this.updateSession(sessionId, { state: 'working', activity: null });
        this.setMemberState(source, 'working', 'Folytatja');
        this.later(1200, () => {
          if (this.findSession(sessionId)?.state === 'exited') return;
          this.appendChat(sessionId, [
            this.chatItem('assistant_text', { text: 'Lefutott, folytatom a munkát.' }),
          ]);
        });
        return;
      }
      this.updateSession(sessionId, { state: 'working', activity: 'mcp__team__send_message' });
      this.setMemberState(source, 'working', 'Szól a Code review-nak');
      this.later(1400, () => {
        if (this.findSession(sessionId)?.state === 'exited') return;
        this.appendChat(sessionId, [
          this.chatItem('assistant_text', {
            text: 'Feltöltve. Szólok a Code review-nak: ha nem blokkol, jöhet az integration, utána a QA újrateszt.',
          }),
        ]);
        this.sendTeamMessage(
          source,
          ['code-review'],
          item.taskKey,
          'Javítva a mobil gombsor (4e1c2a9), egy CSS-fájl. Kérlek, nézd át. Ha nem blokkol, mehet újra az integrationre, utána a QA a 6. forgatókönyvet futtatja.',
          sessionId,
        );
        if (item.taskKey) {
          const task = this.findTask(item.taskKey);
          if (task) {
            this.updateTask(task.key, {
              stageId: 'code_review',
            });
            this.addTimeline(
              task.key,
              source,
              'task_stage_changed',
              { from: 'qa', to: 'code_review' },
              sessionId,
            );
          }
        }
        this.updateSession(sessionId, { state: 'idle', activity: null });
        this.setMemberState(source, 'idle', 'A Code review-ra vár');
        this.setMemberState('code-review', 'working', `Átnézi: ${item.taskKey ?? ''}`.trim());
      });
      return;
    }

    if (item.kind === 'question') {
      const answer =
        input.note ?? item.options.find((option) => option.id === input.optionId)?.label ?? input.optionId;
      if (item.taskKey) {
        this.addTimeline(
          item.taskKey,
          this.owner,
          'question_answered',
          { inboxItemId: item.id, answer },
          sessionId,
        );
      }
      this.sendTeamMessage(this.owner, [source], item.taskKey, answer);
      if (!sessionId) return;
      this.appendChat(sessionId, [
        this.chatItem('team_message', { direction: 'in', from: this.owner, to: [source], text: answer }),
      ]);
      this.updateSession(sessionId, { state: 'working', activity: null });
      this.setMemberState(source, 'working', 'Folytatja a válasz alapján');
      this.later(1800, () => {
        if (this.findSession(sessionId)?.state === 'exited') return;
        this.appendChat(sessionId, [
          this.chatItem('assistant_text', { text: 'Köszönöm, ennek megfelelően folytatom.' }),
        ]);
        this.updateSession(sessionId, { state: 'idle', activity: null });
        this.setMemberState(source, 'idle', null);
      });
      return;
    }

    const approved = input.optionId === 'approve';
    const gate = item.payload.gate as
      { requestId?: string; fromStageId?: string; toStageId?: string } | undefined;
    if (item.kind === 'decision' && gate?.toStageId && item.taskKey) {
      const task = this.findTask(item.taskKey);
      if (!task) return;
      if (!approved) {
        this.updateTask(task.key, { status: 'active' });
        this.addTimeline(task.key, this.owner, 'task_updated', {
          fields: ['status'],
          gateRejected: { requestId: gate.requestId, to: gate.toStageId, inboxItemId: item.id },
        });
        this.setMemberState(source, 'idle', null);
        return;
      }
      const from = task.stageId;
      const to = gate.toStageId;
      this.updateTask(task.key, { stageId: to, status: 'active' });
      this.addTimeline(task.key, this.owner, 'task_stage_changed', { from, to, approvedBy: [this.owner] });
      if (to !== 'release') {
        this.setMemberState(source, 'idle', null);
        return;
      }
      this.setMemberState(source, 'working', 'Élesít');
      this.later(1800, () => {
        if (task.status === 'cancelled') return;
        this.updateTask(task.key, { stageId: 'done', status: 'done', closedAt: nowIso() });
        this.addTimeline(task.key, source, 'task_note', { text: 'Élesen: release-2026-09-30.1' });
        this.addTimeline(task.key, source, 'task_stage_changed', { from: 'release', to: 'done' });
        this.sendTeamMessage(
          source,
          [this.owner],
          task.key,
          'Kint van élesben: release-2026-09-30.1. A naplóban nincs hiba.',
        );
        this.setMemberState(source, 'idle', null);
      });
      return;
    }
    if (item.taskKey) {
      this.addTimeline(item.taskKey, this.owner, 'task_note', {
        text: approved ? `Jóváhagyva: ${item.title}` : `Elhalasztva: ${item.title}`,
      });
    }
    this.setMemberState(source, 'idle', null);
    if (approved && item.kind === 'approval') {
      this.later(900, () => this.sendTeamMessage(source, [this.owner], null, 'Elküldtem a levelet Katának.'));
    }
  }
}
