import {
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
  UpdateTaskRequest,
} from '@projectman/shared';
import type {
  AiMemberConfig,
  BoardView,
  ChatItem,
  ClientCommand,
  ConfigVersionEntry,
  InboxItem,
  MemberView,
  ProjectConfig,
  ServerEvent,
  Session,
  Task,
  TeamMessage,
  TimelineEvent,
  TimelineEventType,
} from '@projectman/shared';
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

function error(status: number, code: string, message: string): MockResponse {
  return { status, body: { error: { code, message } } };
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
  user = { ...fixtures.mockUser };
  config: ProjectConfig = fixtures.buildConfig();
  configVersion = fixtures.projectSummary.configVersion;
  history: ConfigVersionEntry[] = clone(fixtures.configHistory);
  tasks: Task[] = clone(fixtures.tasks);
  members: MemberView[] = clone(fixtures.members);
  timeline: TimelineEvent[] = clone(fixtures.timeline);
  sessions: Session[] = clone(fixtures.sessions);
  chats: Record<string, ChatItem[]> = clone(fixtures.chats);
  inbox: InboxItem[] = clone(fixtures.inbox);
  messages: TeamMessage[] = clone(fixtures.teamMessages);
  planUsage = clone(fixtures.planUsage);
  extraProjects: { key: string; name: string; templateId: string }[] = [];
  readonly terminals: MockTerminals;
  private readonly connections = new Map<MockConnection, ConnectionState>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private taskSeq = Math.max(0, ...fixtures.tasks.map((task) => Number(task.key.split('-')[1] ?? 0)));
  private onFirstSubscribe: (() => void) | null = null;

  constructor(auth: MockAuthState = 'ready') {
    this.auth = auth;
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
    const projectKey = 'projectKey' in event ? event.projectKey : null;
    for (const [connection, state] of this.connections) {
      if (projectKey === null || state.projects.has(projectKey)) connection.deliver(event);
    }
  }

  /* ---------- domain helpers (also used by the simulation) ---------- */

  get owner(): string {
    return fixtures.OWNER;
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

  updateTask(key: string, patch: Partial<Task>): Task | undefined {
    const task = this.findTask(key);
    if (!task) return undefined;
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
    Object.assign(session, patch, { lastActivityAt: nowIso() });
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
      deliveredAt: nowIso(),
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

  private board(): BoardView {
    const stages = this.config.pipeline.stages;
    return {
      project: { ...fixtures.projectSummary, configVersion: this.configVersion },
      columns: this.config.pipeline.columns.map((column) => ({
        ...column,
        stageIds: stages.filter((stage) => stage.columnId === column.id).map((stage) => stage.id),
      })),
      stages: clone(stages),
      tasks: clone(this.tasks),
      members: clone(this.members.filter((member) => member.status !== 'retired')),
      openInboxCount: this.inbox.filter(
        (item) => item.state === 'open' && item.assignees.includes(this.owner),
      ).length,
      planUsage: { ...this.planUsage, fetchedAt: nowIso() },
    };
  }

  /* ---------- REST ---------- */

  handle(method: string, path: string, body: unknown): MockResponse {
    if (path === '/api/setup') {
      if (method === 'GET') return ok({ needsSetup: this.auth === 'setup' });
      const input = parseBody(SetupRequest, body);
      if (!input) return error(400, 'invalid_request', 'Invalid setup request');
      this.user = { ...this.user, name: input.name, email: input.email };
      this.auth = 'ready';
      return ok({ ...this.me() });
    }
    if (path === '/api/auth/login' && method === 'POST') {
      const input = parseBody(LoginRequest, body);
      if (!input || input.password.length < 3)
        return error(401, 'invalid_credentials', 'Invalid email or password');
      this.auth = 'ready';
      return ok(this.me());
    }
    if (path === '/api/auth/logout' && method === 'POST') {
      this.auth = 'login';
      return ok();
    }
    if (this.auth !== 'ready') return error(401, 'unauthorized', 'Login required');

    if (path === '/api/me') return ok(this.me());
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
        { ...fixtures.projectSummary, configVersion: this.configVersion },
        ...this.extraProjects.map((p) => ({ ...p, configVersion: '0000000' })),
      ]);
    }

    const match = /^\/api\/projects\/([A-Z][A-Z0-9]{0,9})(\/.*)?$/.exec(path);
    if (!match) return error(404, 'not_found', `No route for ${method} ${path}`);
    const key = match[1]!;
    const rest = match[2] ?? '';
    if (key !== fixtures.PROJECT_KEY) return error(404, 'not_found', `Unknown project ${key}`);
    return this.handleProject(method, rest, body);
  }

  private me() {
    return { ...this.user, handles: { [fixtures.PROJECT_KEY]: this.owner } };
  }

  private handleProject(method: string, rest: string, body: unknown): MockResponse {
    let m: RegExpExecArray | null;
    if (rest === '' && method === 'GET')
      return ok({ ...fixtures.projectSummary, configVersion: this.configVersion });
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
        this.updateTask(task.key, input);
      }
      return ok({
        task: clone(task),
        timeline: clone(this.timeline.filter((event) => event.taskKey === task.key)),
        sessions: clone(
          this.sessions.filter((s) => s.workItem.type === 'task' && s.workItem.taskKey === task.key),
        ),
      });
    }
    if ((m = /^\/tasks\/([A-Z][A-Z0-9]*-\d+)\/start$/.exec(rest)) && method === 'POST') {
      return this.startTask(m[1]!, body);
    }

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

    if (rest === '/messages') return ok({ messages: clone(this.messages) });
    if (rest === '/inbox') return ok({ items: clone(this.inbox) });
    if ((m = /^\/inbox\/([\w-]+)\/resolve$/.exec(rest)) && method === 'POST')
      return this.resolve(m[1]!, body);

    if (rest === '/config') {
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
    const developers = this.members.filter((member) => member.kind === 'ai' && member.role === 'developer');
    const assignee =
      input.assignee ??
      [...developers].sort((a, b) => a.currentTaskKeys.length - b.currentTaskKeys.length)[0]?.handle ??
      null;
    if (!assignee) return error(409, 'no_developer', 'No developer available');
    const workStage = this.config.pipeline.stages.find((stage) => stage.kind === 'work');
    const from = task.stageId;
    this.updateTask(task.key, { assignee, stageId: workStage?.id ?? task.stageId, status: 'active' });
    this.addTimeline(task.key, null, 'task_assigned', { assignee });
    if (workStage) this.addTimeline(task.key, null, 'task_stage_changed', { from, to: workStage.id });
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
    this.emit({ type: 'session_upserted', projectKey: session.projectKey, session: clone(session) });
    this.addTimeline(task.key, assignee, 'session_started', { member: assignee, resumed: false }, session.id);
    const member = this.findMember(assignee);
    if (member) member.currentTaskKeys = [...member.currentTaskKeys, task.key];
    this.setMemberState(assignee, 'working', `Indul: ${task.key}`);
    this.later(900, () => {
      this.updateSession(session.id, { state: 'working', activity: 'Read: README.md' });
      this.appendChat(session.id, [
        this.chatItem('user_text', { text: `Task ${task.key}: ${task.title}\n\n${task.description}` }),
        this.chatItem('assistant_text', { text: 'Átnézem a feladatot és a kódtárat, aztán nekiállok.' }),
      ]);
    });
    this.later(2600, () => {
      const call = this.chatItem('tool_call', {
        toolUseId: mockId('toolu'),
        name: 'Read',
        summary: 'README.md',
        input: {},
      });
      this.appendChat(session.id, [call]);
      this.later(700, () => {
        if (call.kind !== 'tool_call') return;
        this.appendChat(session.id, [
          this.chatItem('tool_result', { toolUseId: call.toolUseId, ok: true, summary: '88 sor' }),
        ]);
        this.setMemberState(assignee, 'working', `Olvassa: ${task.key}`);
      });
    });
    return ok({
      task: clone(task),
      timeline: clone(this.timeline.filter((event) => event.taskKey === task.key)),
      sessions: clone(
        this.sessions.filter((s) => s.workItem.type === 'task' && s.workItem.taskKey === task.key),
      ),
    });
  }

  private hire(body: unknown): MockResponse {
    const input = parseBody(HireMemberRequest, body);
    if (!input) return error(400, 'invalid_request', 'Invalid hire request');
    const taken = (candidate: string) => this.members.some((member) => member.handle === candidate);
    if (input.handle && taken(input.handle)) return error(409, 'conflict', 'Handle already taken');
    const base = input.role === 'developer' ? 'dev' : input.role.replace(/_/g, '-');
    let handle = input.handle ?? base;
    for (let n = 2; taken(handle); n += 1) handle = `${base}-${n}`;
    const member: MemberView = {
      handle,
      displayName: input.displayName ?? handle,
      kind: 'ai',
      role: input.role,
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
      handle,
      displayName: member.displayName,
      role: input.role,
      specialty: input.specialty,
      model: input.model ?? 'opus',
      permissionMode: 'default',
      capacity: 1,
      instructions: '',
      sponsor: this.owner,
      temp: false,
    };
    this.config.team.members.push(config);
    this.commitConfig(`Felvéve: ${member.displayName} (${handle})`);
    return { status: 201, body: clone(member) };
  }

  private retire(handle: string, body: unknown): MockResponse {
    const input = parseBody(RetireMemberRequest, body) ?? {};
    const member = this.findMember(handle);
    if (!member || member.kind !== 'ai') return error(404, 'not_found', 'Unknown AI member');
    const target = input.handoverTo ? this.findMember(input.handoverTo) : undefined;
    for (const taskKey of member.currentTaskKeys) {
      const task = this.findTask(taskKey);
      if (task?.assignee === handle) this.updateTask(taskKey, { assignee: target?.handle ?? null });
      if (target) target.currentTaskKeys = [...target.currentTaskKeys, taskKey];
    }
    for (const stage of this.config.pipeline.stages) {
      if (stage.owners.includes(handle)) {
        stage.owners = stage.owners.filter((owner) => owner !== handle);
        if (target && !stage.owners.includes(target.handle)) stage.owners.push(target.handle);
      }
    }
    member.status = 'retired';
    member.currentTaskKeys = [];
    this.config.team.members = this.config.team.members.filter((entry) => entry.handle !== handle);
    this.addTimeline(null, this.owner, 'member_retired', { handle, handoverTo: target?.handle ?? null });
    this.commitConfig(`Elbocsátva: ${member.displayName} (${handle})`);
    return ok();
  }

  private sessionMessage(sessionId: string, body: unknown): MockResponse {
    const input = parseBody(SendMessageRequest, body);
    const session = this.findSession(sessionId);
    if (!session || !input) return error(404, 'not_found', 'Unknown session');
    const wasIdle = session.state !== 'working';
    this.later(wasIdle ? 350 : 1500, () => {
      this.appendChat(sessionId, [this.chatItem('user_text', { text: input.text })]);
      this.updateSession(sessionId, { state: 'working', activity: null, endedAt: null });
      this.setMemberState(session.member, 'working', 'Válaszol');
    });
    this.later(wasIdle ? 2200 : 3400, () => {
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

  private stopSession(sessionId: string): MockResponse {
    const session = this.findSession(sessionId);
    if (!session) return error(404, 'not_found', 'Unknown session');
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
    const resolved: InboxItem = {
      ...item,
      state: 'resolved',
      resolution: { optionId: input.optionId, by: this.owner, at: nowIso(), note: input.note ?? null },
    };
    this.upsertInbox(resolved);
    this.planUsage.fiveHourPercent = Math.min(99, (this.planUsage.fiveHourPercent ?? 0) + 1);
    this.later(250, () => this.afterResolve(resolved, input));
    return ok(clone(resolved));
  }

  private afterResolve(item: InboxItem, input: ResolveInboxRequest): void {
    const sessionId = item.sessionId;
    const source = item.source;
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
          this.appendChat(sessionId, [
            this.chatItem('assistant_text', { text: 'Lefutott, folytatom a munkát.' }),
          ]);
        });
        return;
      }
      this.updateSession(sessionId, { state: 'working', activity: 'mcp__team__send_message' });
      this.setMemberState(source, 'working', 'Szól a Code review-nak');
      this.later(1400, () => {
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
              checks: { ...task.checks, code_review: 'pending' },
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
