import {
  AcceptInviteRequest,
  BoundaryRequest,
  DecideBoundaryRequest,
  boundaryOwners,
  boundaryWaitingState,
  canDecideBoundary,
  canReadBoundary,
  AddHumanMemberRequest,
  AgentProvider,
  CancelTaskRequest,
  ChangeTaskLabelsRequest,
  CreateInviteRequest,
  CreateProjectRequest,
  CreateTaskCommentRequest,
  CreateTaskRequest,
  CustomRoleRequest,
  DEFAULT_AGENT_PROVIDER,
  HireMemberRequest,
  INLINE_MEDIA_TYPES,
  InvitationView,
  LoginRequest,
  MAX_ATTACHMENT_BYTES,
  OCTET_STREAM,
  PR_MERGED_LABEL,
  PatchConfigRequest,
  ReopenTaskRequest,
  ResolveInboxRequest,
  RetireMemberRequest,
  RevertConfigRequest,
  SendMessageRequest,
  SendTeamMessageRequest,
  SetupRequest,
  StartTaskRequest,
  UpdateMemberRequest,
  UpdateSessionRequest,
  UpdateTaskRequest,
  aiLimitReached,
  applyConfigPatch,
  approvalRefusal,
  attachmentPreviewOf,
  canDeleteAttachment,
  canReadAttachments,
  canSeeTask,
  canUploadAttachment,
  commentMentions,
  configSchemaIssues,
  evaluateMove,
  expiredLabels,
  gateRequestOf,
  holdersAllow,
  isBuiltInRole,
  isHandleOnLeave,
  isOnLeave,
  isOpenTask,
  isWorkingOnTask,
  labelDefinition,
  labelHolders,
  memberDuties,
  memberOf,
  memberRoles,
  modelForProvider,
  nextCronRun,
  noApproverReason,
  approverBlocker,
  ownerOnlyChanges,
  permissionView,
  effectiveSessionPermissions,
  duplicateMarkRefusal,
  planLabelChange,
  planRelations,
  pullRequestsMerged,
  reverseRelationKind,
  repoOf,
  repoRequired,
  resolvedStages,
  roleBundle,
  roleHolders,
  stageApprovers,
  stageIndex,
  stageOf,
  stageOwners,
  subtaskParentRefusal,
  taskSeq,
  taskWorkOf,
  validateProjectConfig,
  mergeTokenUsage,
  ALERT_SEEN_OPTION,
  alertPayloadOf,
  limitTokens,
  messageBurstAlertFor,
  messageBurstOf,
  usageTotal,
  closedCardsSince,
  countCardRounds,
  DEFAULT_CLOSED_CARDS_DAYS,
  isClosedSince,
  measureClosedCard,
} from '@projectman/shared';
import type {
  Actor,
  BoundaryGrant,
  AiMemberConfig,
  ApprovalRequirement,
  Attachment,
  AttachmentViewer,
  BoardView,
  ChatItem,
  ClientCommand,
  ConfigVersionEntry,
  ErrorCode,
  GateEvaluation,
  HumanAccess,
  GateRequestPayload,
  InboxItem,
  InvitationView as Invitation,
  LabelChangeReason,
  LabelChangeRefusal,
  LabelClearTrigger,
  RelationStep,
  RelationsChange,
  MemberUsage,
  MemberView,
  PlanUsage,
  ProjectConfig,
  ScheduleRun,
  ServerEvent,
  Session,
  SessionTokensAlert,
  Stage,
  Task,
  TeamMessage,
  TokenUsage,
  TimelineEvent,
  TimelineEventData,
  TimelineEventType,
} from '@projectman/shared';
import {
  aiMemberDefaults,
  defaultMemberHandle,
  defaultMemberName,
  humanMemberHandle,
  roleViews,
} from '@projectman/templates';
import * as fixtures from './fixtures';
import { mockId, mockUuid, nowIso } from './time';

export type MockAuthState = 'ready' | 'setup' | 'login';

export interface MockResponse {
  status: number;
  body?: unknown;
}

/** A test listener for the websocket events the backend publishes. */
export interface MockConnection {
  deliver(event: ServerEvent): void;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function newInviteToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

/** Like the GitHub integration: the system label "pr-merged" follows the linked pull requests. */
function withPrMergedLabel(task: Task, config: Pick<ProjectConfig, 'pipeline'>): Task {
  if (!labelDefinition(config, PR_MERGED_LABEL)) return task;
  const merged = pullRequestsMerged(task);
  if (merged === task.labels.includes(PR_MERGED_LABEL)) return task;
  return {
    ...task,
    labels: merged
      ? [...task.labels, PR_MERGED_LABEL]
      : task.labels.filter((label) => label !== PR_MERGED_LABEL),
  };
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** Like the server: a team message goes to each recipient once and never to its sender. */
function teamRecipients(from: string, to: readonly string[]): string[] {
  return unique(to).filter((handle) => handle !== from);
}

function error(status: number, code: ErrorCode, message: string, details?: unknown): MockResponse {
  return { status, body: { error: { code, message, ...(details === undefined ? {} : { details }) } } };
}

function ok(body?: unknown): MockResponse {
  return body === undefined ? { status: 204 } : { status: 200, body };
}

/** The server's answer to a refused label change. */
function labelChangeError(refusal: LabelChangeRefusal): MockResponse {
  switch (refusal.code) {
    case 'self_review_forbidden':
      return error(403, refusal.code, 'The assignee and PR authors cannot set this label', {
        label: refusal.label,
      });
    case 'label_not_allowed':
      return error(403, refusal.code, 'The label rules forbid this', {
        label: refusal.label,
        reason: refusal.reason,
      });
    case 'comment_required':
      return error(400, refusal.code, 'These labels need a comment', { labels: refusal.labels });
  }
}

function gateBlockedError(evaluation: GateEvaluation): MockResponse {
  return error(409, 'gate_blocked', 'Gate conditions are not met', {
    unmet: evaluation.unmet,
    approvals: evaluation.approvals,
  });
}

function approvalRequestedError(items: readonly InboxItem[]): MockResponse {
  return error(409, 'approval_requested', 'Approvers were asked', {
    inboxItemIds: items.map((item) => item.id),
    approvers: unique(items.flatMap((item) => item.assignees)),
  });
}

const SYSTEM_ACTOR: Actor = { kind: 'system', handle: null };

function parseBody<T>(
  schema: { safeParse(data: unknown): { success: true; data: T } | { success: false } },
  body: unknown,
): T | null {
  const result = schema.safeParse(body ?? {});
  return result.success ? result.data : null;
}

/**
 * In-memory stand-in for the projectman server, the fake behind the UI tests. It implements
 * the REST routes from the shared route table and publishes the same websocket events the
 * real server would, so the UI runs through its normal data path.
 */
export class MockBackend {
  auth: MockAuthState;
  viewerHandle: string = fixtures.OWNER;
  user = { ...fixtures.mockUser };
  config: ProjectConfig = fixtures.buildConfig();
  configVersion = fixtures.projectSummary.configVersion;
  history: ConfigVersionEntry[] = clone(fixtures.configHistory);
  tasks: Task[] = clone(fixtures.tasks).map((task) => withPrMergedLabel(task, this.config));
  members: MemberView[] = clone(fixtures.members);
  timeline: TimelineEvent[] = clone(fixtures.timeline);
  scheduleRuns: ScheduleRun[] = [];
  attachments: Attachment[] = [];
  providerLoggedIn = { claude: true, codex: true };
  providerPlanUsage: Partial<Record<AgentProvider, PlanUsage>> = {};
  sessions: Session[] = clone(fixtures.sessions);
  chats: Record<string, ChatItem[]> = clone(fixtures.chats);
  inbox: InboxItem[] = clone(fixtures.inbox);
  boundaryGrants = new Map<string, BoundaryGrant>();
  messages: TeamMessage[] = clone(fixtures.teamMessages);
  memories: Record<string, string> = {
    'fe-1': 'Acme checkout uses fictional fixtures. Keep the cart usable on small screens.',
  };
  planUsage = clone(fixtures.planUsage);
  codexPlanUsage = { ...clone(fixtures.planUsage), fiveHourPercent: 24, weeklyPercent: 36 };
  extraProjects: { key: string; name: string; templateId: string }[] = [];
  invitations: Array<Invitation & { token: string }> = [];
  accounts = new Map<string, { userId: string; name: string; email: string; password: string }>([
    [fixtures.mockUser.email, { ...fixtures.mockUser, password: 'correct horse battery' }],
  ]);
  private inviteAttempts = { count: 0, resetAt: 0 };
  /** Connected listeners and the projects each subscribed to. */
  private readonly connections = new Map<MockConnection, Set<string>>();
  private lastTaskSeq = Math.max(0, ...fixtures.tasks.map((task) => taskSeq(task.key)));

  constructor(auth: MockAuthState = 'ready') {
    this.auth = auth;
    for (const member of this.members) {
      const config = memberOf(this.config, member.handle);
      if (config?.kind === 'ai')
        Object.assign(member, {
          provider: config.provider ?? DEFAULT_AGENT_PROVIDER,
          model: config.model,
          effort: config.effort,
          ...(config.cheapSubagent ? { cheapSubagent: config.cheapSubagent } : {}),
        });
    }
    this.syncPermissionViews();
    for (const message of this.messages) {
      message.receipts ??= message.to.map((handle) => ({
        handle,
        kind: this.findMember(handle)?.kind ?? 'human',
        deliveredAt: message.deliveredAt,
        readAt: null,
      }));
    }
  }

  /* ---------- plumbing ---------- */

  connect(connection: MockConnection): () => void {
    this.connections.set(connection, new Set());
    connection.deliver({ type: 'hello', serverTime: nowIso() });
    return () => {
      this.connections.delete(connection);
    };
  }

  /** Project subscriptions; terminal commands have no fake terminal behind them. */
  handleCommand(connection: MockConnection, command: ClientCommand): void {
    const projects = this.connections.get(connection);
    if (!projects) return;
    if (command.type === 'subscribe_project') projects.add(command.projectKey);
    else if (command.type === 'unsubscribe_project') projects.delete(command.projectKey);
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
    for (const [connection, projects] of this.connections) {
      if (projectKey === null || projects.has(projectKey)) connection.deliver(event);
    }
  }

  /* ---------- domain helpers ---------- */

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

  /** A copy of the member as the server serves it: with the work its live sessions do on cards. */
  private viewOf(member: MemberView): MemberView {
    if (member.kind !== 'ai') return clone(member);
    const open = new Set(this.tasks.filter(isOpenTask).map((task) => task.key));
    const taskWork = this.sessions
      .filter((session) => session.member === member.handle)
      .flatMap((session) => taskWorkOf(session) ?? [])
      .filter((work) => open.has(work.taskKey));
    return { ...clone(member), taskWork };
  }

  /** The viewer as the shared task rules know them. */
  private taskViewer(): AttachmentViewer {
    const viewer = this.findMember(this.viewerHandle);
    return {
      access: viewer?.kind === 'human' ? (viewer.role as HumanAccess) : 'ai',
      handle: this.viewerHandle,
    };
  }

  /** Whether the viewer may see the task: the rule the server uses (`packages/shared`). */
  canSee(task: Task): boolean {
    return canSeeTask(this.taskViewer(), task);
  }

  /**
   * Adds a file to a task as the viewer, with its timeline event and change notice, as an upload
   * does (the fake trusts the declared type of the file; the server decides from the content).
   */
  addAttachment(
    taskKey: string,
    file: { name: string; size: number; type: string },
    uploadedBy: Actor = this.viewerActor(),
  ): Attachment {
    const mediaType = file.type in INLINE_MEDIA_TYPES ? file.type : OCTET_STREAM;
    const attachment: Attachment = {
      id: `${mockId('att')}0000`,
      projectKey: fixtures.PROJECT_KEY,
      taskKey,
      fileName: file.name || 'file',
      size: file.size,
      mediaType,
      preview: attachmentPreviewOf(mediaType),
      uploadedBy,
      createdAt: nowIso(),
    };
    this.attachments.push(attachment);
    this.addTimeline(taskKey, uploadedBy.handle, 'attachment_added', {
      attachmentId: attachment.id,
      fileName: attachment.fileName,
      size: attachment.size,
      mediaType,
    });
    this.emit({ type: 'task_attachments_changed', projectKey: fixtures.PROJECT_KEY, taskKey });
    return attachment;
  }

  /** Removes a file, as the viewer: the timeline keeps the name. */
  removeAttachment(id: string, who = this.viewerHandle): void {
    const attachment = this.attachments.find((entry) => entry.id === id);
    if (!attachment) return;
    this.attachments = this.attachments.filter((entry) => entry.id !== id);
    this.addTimeline(attachment.taskKey, who, 'attachment_deleted', {
      attachmentId: id,
      fileName: attachment.fileName,
      size: attachment.size,
      mediaType: attachment.mediaType,
    });
    this.emit({
      type: 'task_attachments_changed',
      projectKey: fixtures.PROJECT_KEY,
      taskKey: attachment.taskKey,
    });
  }

  /** A session that has not exited or failed. */
  isLive(session: Session): boolean {
    return session.state !== 'exited' && session.state !== 'failed';
  }

  updateTask(key: string, patch: Partial<Task>, actor = this.viewerHandle): Task | undefined {
    const task = this.findTask(key);
    if (!task) return undefined;
    void actor;
    Object.assign(task, patch, { updatedAt: nowIso() });
    if (patch.links) Object.assign(task, withPrMergedLabel(task, this.config));
    this.emit({ type: 'task_upserted', projectKey: task.projectKey, task: clone(task) });
    return task;
  }

  addTimeline(
    taskKey: string | null,
    who: string | null,
    type: TimelineEventType,
    data: Record<string, unknown>,
    sessionId: string | null = null,
    createdAt = nowIso(),
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
      createdAt,
    };
    this.timeline.push(event);
    this.emit({ type: 'timeline_appended', projectKey: event.projectKey, event: clone(event) });
    if (taskKey && (type === 'team_message' || type === 'task_note')) this.checkMessageBurst(taskKey, who);
    return event;
  }

  /** The message storm rule (PM-186) on the card's conversation: one alert per storm, as the server. */
  private checkMessageBurst(taskKey: string, who: string | null): void {
    const burst = messageBurstOf(this.config.team.limits);
    const now = new Date(nowIso());
    const alerts = this.inbox.flatMap((item) => {
      const payload = item.taskKey === taskKey ? alertPayloadOf(item) : null;
      return payload?.alert === 'message_burst' ? [{ open: item.state === 'open', at: payload.at }] : [];
    });
    const payload = messageBurstAlertFor({
      taskKey,
      burst,
      now,
      earlier: alerts,
      entries: this.timeline
        .filter(
          (event) =>
            event.taskKey === taskKey &&
            (event.type === 'team_message' || event.type === 'task_note') &&
            event.data.importedAuthor === undefined &&
            event.data.importedAt === undefined,
        )
        .map((event) => ({
          createdAt: event.createdAt,
          actor: event.actor.handle,
          to: Array.isArray(event.data.to) ? (event.data.to as string[]) : [],
        }))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    });
    if (!payload) return;
    this.upsertInbox({
      id: mockId('inb'),
      projectKey: fixtures.PROJECT_KEY,
      kind: 'alert',
      assignees: boundaryOwners(this.config),
      source: who ?? 'system',
      sessionId: null,
      taskKey,
      title: `${payload.count} messages and notes on ${taskKey} in ${payload.minutes} minutes`,
      body: null,
      payload,
      options: [ALERT_SEEN_OPTION],
      state: 'open',
      resolution: null,
      createdAt: nowIso(),
    });
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
    const wasEnded = !this.isLive(session);
    const stateChanged = patch.state !== undefined && patch.state !== session.state;
    Object.assign(session, patch, {
      lastActivityAt: nowIso(),
      ...(stateChanged ? { stateSince: nowIso() } : {}),
    });
    if (wasEnded || session.state === 'idle' || session.state === 'waiting_input')
      this.flushTeamMessages(session);
    if (session.workItem.type === 'schedule' && !this.isLive(session)) {
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
  }

  chatItem<K extends ChatItem['kind']>(
    kind: K,
    fields: Omit<Extract<ChatItem, { kind: K }>, 'id' | 'ts' | 'kind'>,
  ): Extract<ChatItem, { kind: K }> {
    return { id: mockId('chat'), ts: nowIso(), kind, ...fields } as unknown as Extract<ChatItem, { kind: K }>;
  }

  /**
   * Like the server's one send path (REST, label and @mention notices, answers to questions):
   * the text trimmed, the sender left out of the recipients. A message the server would refuse
   * (`teamMessageRefusal`) is a mistake of the caller.
   */
  sendTeamMessage(
    from: string,
    recipients: readonly string[],
    taskKey: string | null,
    text: string,
    sessionId?: string,
  ): TeamMessage {
    const refusal = this.teamMessageRefusal(from, recipients, text);
    if (refusal) throw new Error(`The server refuses this team message: ${JSON.stringify(refusal.body)}`);
    const to = teamRecipients(from, recipients);
    const body = text.trim();
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
      const live = this.sessions.filter((s) => s.member === handle && this.isLive(s));
      const target =
        live.find((s) => s.workItem.type === 'task' && s.workItem.taskKey === taskKey) ?? live[0];
      if (target) this.flushTeamMessages(target);
    }
    return message;
  }

  /**
   * The server's refusal of a team message, or null: 400 invalid_request with `details.field`
   * "text" or "to" for an empty text or no recipient but the sender, 404 for unknown members.
   */
  private teamMessageRefusal(from: string, to: readonly string[], text: string): MockResponse | null {
    if (!text.trim()) return error(400, 'invalid_request', 'The message text is empty', { field: 'text' });
    const recipients = teamRecipients(from, to);
    if (!recipients.length)
      return error(400, 'invalid_request', 'The message names no recipient but its sender', { field: 'to' });
    const unknown = recipients.filter((handle) => !memberOf(this.config, handle));
    if (unknown.length)
      return error(404, 'not_found', `Unknown member: ${unknown.join(', ')}`, {
        what: 'member',
        id: unknown[0],
        ids: unknown,
      });
    return null;
  }

  upsertInbox(item: InboxItem): void {
    const index = this.inbox.findIndex((entry) => entry.id === item.id);
    if (index === -1) this.inbox.push(item);
    else this.inbox[index] = item;
    this.emit({ type: 'inbox_upserted', projectKey: item.projectKey, item: clone(item) });
  }

  /**
   * The roster's permission fields follow the configuration (a level, the delegation settings, the
   * deciders). Every commit does it; a test that edits `config` directly calls it itself.
   */
  syncPermissionViews(): void {
    for (const member of this.members) {
      const config = memberOf(this.config, member.handle);
      if (config?.kind !== 'ai') continue;
      delete member.permissionLegacy;
      delete member.aiApproverBlocker;
      Object.assign(member, permissionView(this.config, config));
    }
  }

  private commitConfig(message: string): void {
    this.syncPermissionViews();
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
      member: member && member.status !== 'retired' ? this.viewOf(member) : null,
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
      labels: this.config.pipeline.labels.map((label) => ({
        ...clone(label),
        holders: labelHolders(this.config, label),
      })),
      tasks: clone(this.tasks.filter((task) => this.canSee(task))),
      members: this.members.filter((member) => member.status !== 'retired').map((m) => this.viewOf(m)),
      openInboxCount: this.inbox.filter(
        (item) => item.state === 'open' && item.assignees.includes(this.owner),
      ).length,
      aiEnabled: this.config.team.limits.aiEnabled,
      planUsage: { ...this.planUsage, fetchedAt: nowIso() },
      planUsageByProvider: Object.fromEntries(
        [
          ...new Set(
            this.members
              .filter((member) => member.kind === 'ai' && member.status !== 'retired')
              .map((member) => member.provider ?? DEFAULT_AGENT_PROVIDER),
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
          return error(409, 'project_exists', 'Project key already exists');
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
    const member = memberOf(this.config, this.viewerHandle);
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
    if ((rest === '/tasks' && method === 'POST') || (rest.startsWith('/tasks/') && method === 'PATCH')) {
      if (viewer.kind !== 'human' || !['owner', 'admin', 'developer'].includes(viewer.role))
        return error(403, 'insufficient_access', 'Developer access required');
    }
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
    if (rest === '/measure/closed-cards' && method === 'GET') {
      if (viewer.role === 'client') return error(403, 'insufficient_access', 'Internal access required');
      return ok(this.closedCardsMeasure(Number(query.get('days') ?? DEFAULT_CLOSED_CARDS_DAYS)));
    }

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
        return this.changeTask(task, input);
      }
      return ok(this.taskDetail(task));
    }
    if ((m = /^\/tasks\/([A-Z][A-Z0-9]*-\d+)\/comments$/.exec(rest)) && method === 'POST') {
      if (viewer.kind !== 'human' || !['owner', 'admin', 'developer'].includes(viewer.role))
        return error(403, 'insufficient_access', 'Developer access required');
      const input = parseBody(CreateTaskCommentRequest, body);
      if (!input) return error(400, 'invalid_request', 'Invalid comment');
      if ((input.importedAuthor !== undefined || input.importedAt !== undefined) && viewer.role !== 'owner')
        return error(403, 'insufficient_access', 'Owner access required');
      const task = this.findTask(m[1]!);
      if (!task) return error(404, 'not_found', 'Unknown task');
      const { text, ...importedFrom } = input;
      this.recordNote(task, text, this.viewerActor(), importedFrom);
      return { status: 201, body: this.taskDetail(task) };
    }
    if ((m = /^\/tasks\/([A-Z][A-Z0-9]*-\d+)\/labels$/.exec(rest)) && method === 'POST') {
      if (viewer.kind !== 'human' || !['owner', 'admin', 'developer'].includes(viewer.role))
        return error(403, 'insufficient_access', 'Developer access required');
      const input = parseBody(ChangeTaskLabelsRequest, body);
      if (!input) return error(400, 'invalid_request', 'Invalid label change');
      const task = this.findTask(m[1]!);
      if (!task) return error(404, 'not_found', 'Unknown task');
      const refused = this.applyLabels(task, input, this.viewerActor(), { comment: input.comment });
      return refused ?? ok(this.taskDetail(task));
    }
    if ((m = /^\/tasks\/([A-Z][A-Z0-9]*-\d+)\/attachments(?:\/(att_[a-z0-9]+))?$/.exec(rest))) {
      return this.handleAttachments(method, m[1]!, m[2], body);
    }
    if ((m = /^\/tasks\/([A-Z][A-Z0-9]*-\d+)\/start$/.exec(rest)) && method === 'POST') {
      return this.startTask(m[1]!, body);
    }

    if ((m = /^\/tasks\/([A-Z][A-Z0-9]*-\d+)\/(cancel|reopen)$/.exec(rest)) && method === 'POST') {
      return this.taskLifecycle(m[1]!, m[2]!, body);
    }
    if (rest === '/roles') {
      if (method === 'GET') return ok({ roles: roleViews(this.config) });
      if (method === 'POST') return this.saveRole(undefined, body);
    }
    if ((m = /^\/roles\/([a-z][a-z0-9_]+)$/.exec(rest))) {
      if (method === 'PUT') return this.saveRole(m[1]!, body);
      if (method === 'DELETE') return this.deleteRole(m[1]!);
    }
    if ((m = /^\/members\/([a-z0-9-]+)$/.exec(rest)) && method === 'PATCH')
      return this.editMember(m[1]!, body);

    if (rest === '/members/human' && method === 'POST') return this.addHuman(body);
    if (rest === '/members') {
      if (method === 'POST') return this.hire(body);
      return ok(this.members.filter((member) => member.status !== 'retired').map((m) => this.viewOf(m)));
    }
    if ((m = /^\/members\/([a-z0-9-]+)$/.exec(rest)) && method === 'DELETE') return this.retire(m[1]!, body);

    if ((m = /^\/sessions\/([\w-]+)$/.exec(rest)) && method === 'PATCH')
      return this.updateSessionPermissions(m[1]!, body);
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
      const original = memberOf(this.config, handle);
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
        const visible = this.tasks.filter((t) => isOpenTask(t) && this.canSee(t));
        const awaiting = new Set(
          this.inbox.filter((i) => i.state === 'open' && i.assignees.includes(handle)).map((i) => i.taskKey),
        );
        const stages = this.config.pipeline.stages
          .filter((stage) => stageApprovers(this.config, stage).includes(handle))
          .map((stage) => stage.id);
        return ok({
          member: {
            ...this.viewOf(member),
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
          ...(original.kind === 'ai' && internal ? { usage: this.memberUsage(handle) } : {}),
          ...(original.kind === 'human' && ['owner', 'admin'].includes(viewer.role) && original.email
            ? { email: original.email }
            : {}),
        });
      }
    }
    if (rest === '/inbox') {
      this.refreshBoundaryInbox();
      return ok({ items: clone(this.inbox) });
    }
    if ((m = /^\/boundary\/([\w-]+)$/.exec(rest)) && method === 'GET') {
      this.refreshBoundaryInbox();
      const item = this.inbox.find((i) => i.id === m![1] && i.kind === 'boundary');
      const parsed = BoundaryRequest.safeParse(item?.payload.boundary);
      if (!parsed.success) return error(404, 'not_found', 'Unknown boundary request');
      if (!canReadBoundary(this.config, parsed.data, this.viewerHandle))
        return error(403, 'not_an_assignee', 'Boundary request is private');
      return ok({
        request: clone(parsed.data),
        grant: clone(this.boundaryGrants.get(parsed.data.id) ?? null),
      });
    }
    if ((m = /^\/boundary\/([\w-]+)\/(decide|revoke)$/.exec(rest)) && method === 'POST')
      return this.decideBoundary(m[1]!, body, m[2] === 'revoke');
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
      this.commitConfig(`Revert to ${target.version}`);
      return ok({ version: this.configVersion });
    }
    return error(404, 'not_found', `No route for ${method} ${rest}`);
  }

  /* ---------- mutations ---------- */

  /** The server's checks on every configuration change: access, owner-only changes, invariants. */
  private configChangeFailure(next: ProjectConfig): MockResponse | null {
    const viewer = memberOf(this.config, this.viewerHandle);
    if (viewer?.kind !== 'human' || !['owner', 'admin'].includes(viewer.access))
      return error(403, 'insufficient_access', 'Requires admin access');
    const [ownerOnly] = viewer.access === 'owner' ? [] : ownerOnlyChanges(this.config, next);
    if (ownerOnly) return error(403, 'owner_only', `Only an owner may make this change (${ownerOnly})`);
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
    return issues.some((i) => i.severity !== 'warning')
      ? error(400, 'config_invalid', 'Invalid configuration', { issues })
      : null;
  }

  private patchConfig(body: unknown): MockResponse {
    const member = memberOf(this.config, this.viewerHandle);
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
    const failure = this.configChangeFailure(next);
    if (failure) return failure;
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

  /** Handles in use now or in the past (the configuration, retired members, sessions): never reused. */
  private takenHandles(config: ProjectConfig = this.config): Set<string> {
    return new Set([
      ...config.team.members.map((member) => member.handle),
      ...this.members.map((member) => member.handle),
      ...this.sessions.map((session) => session.member),
    ]);
  }

  private addHuman(body: unknown): MockResponse {
    const input = parseBody(AddHumanMemberRequest, body);
    if (!input) return error(400, 'invalid_request', 'Invalid human member');
    for (const role of input.roles) {
      const failure = this.validateRole(role, 'human');
      if (failure) return failure;
    }
    const taken = this.takenHandles();
    if (input.handle && taken.has(input.handle)) return error(409, 'handle_taken', 'Handle taken');
    const handle = input.handle ?? humanMemberHandle(input.displayName, taken);
    const roles = unique(input.roles);
    const next = clone(this.config);
    next.team.members.push({
      kind: 'human',
      handle,
      displayName: input.displayName,
      access: input.access,
      roles,
    });
    const failure = this.configChangeFailure(next);
    if (failure) return failure;
    this.config = next;
    const member: MemberView = {
      kind: 'human',
      handle,
      displayName: input.displayName,
      role: input.access,
      roles,
      status: 'no_account',
      activity: null,
      currentTaskKeys: [],
      specialty: null,
      sponsor: null,
      temp: false,
    };
    this.members.push(member);
    this.commitConfig(`Add human member ${handle} without account`);
    this.memberChanged(handle);
    return { status: 201, body: clone(member) };
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
      const member = input.memberHandle ? memberOf(this.config, input.memberHandle) : undefined;
      if (input.memberHandle) {
        if (!member) return error(404, 'invite_member_not_found', 'Unknown member');
        if (member.kind !== 'human') return error(400, 'invite_member_not_human', 'Human required');
        if (member.email) return error(409, 'member_has_account', 'Member has email');
        if (
          this.invitations.some(
            (invite) =>
              invite.memberHandle === member.handle &&
              !invite.acceptedAt &&
              !invite.revokedAt &&
              invite.expiresAt > nowIso(),
          )
        )
          return error(409, 'member_invite_pending', 'Invitation pending');
      }
      if (
        this.config.team.members.some(
          (member) => member.kind === 'human' && member.email?.trim().toLowerCase() === input.email,
        )
      )
        return error(409, 'already_member', 'Already a human member');
      for (const id of input.roles) {
        const role = roleViews(this.config).find((role) => role.id === id);
        if (!role) return error(400, 'unknown_role', 'Unknown role');
        if (
          !input.memberHandle &&
          this.findMember(this.viewerHandle)?.role !== 'owner' &&
          roleBundle(this.config, id).duties.includes('release_approval')
        )
          return error(403, 'owner_only', 'Only owners may grant release approval');
        if (!holdersAllow(role.holders, 'human')) return error(400, 'role_not_for_human', 'AI-only role');
      }
      const token = newInviteToken();
      const invite = {
        ...input,
        displayName: member?.displayName ?? input.displayName ?? null,
        roles: member?.kind === 'human' ? member.roles : [...new Set(input.roles)],
        id: mockId('inv'),
        projectKey: fixtures.PROJECT_KEY,
        invitedBy: this.user.userId,
        createdAt: nowIso(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
        acceptedAt: null,
        revokedAt: null,
        token,
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
    const invite = this.invitations.find((invite) => invite.token === token);
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
        roleNames: invite.roles.map(
          (id) => roleViews(this.config).find((role) => role.id === id)?.name ?? id,
        ),
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
      const failure = this.validateRole(id, 'human');
      if (failure) return failure;
    }
    const user = account ?? {
      userId: mockId('usr'),
      name: input!.name,
      email: invite.email,
      password: input!.password,
    };
    const seat = invite.memberHandle ? memberOf(this.config, invite.memberHandle) : undefined;
    if (invite.memberHandle) {
      if (!seat) return error(404, 'invite_member_not_found', 'Unknown member');
      if (seat.kind !== 'human') return error(400, 'invite_member_not_human', 'Human required');
      if (seat.email) return error(409, 'member_has_account', 'Member has email');
    }
    let handle = humanMemberHandle(user.name, this.takenHandles());
    if (seat?.kind === 'human') {
      handle = seat.handle;
      seat.email = user.email;
      seat.access = invite.access;
      const view = this.findMember(handle)!;
      view.role = invite.access;
      view.status = 'online';
    } else {
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
    }
    this.accounts.set(user.email, user);
    this.user = { userId: user.userId, name: user.name, email: user.email };
    this.viewerHandle = handle;
    this.auth = 'ready';
    this.commitConfig(`Invite accepted: ${user.name}`);
    this.memberChanged(handle);
    invite.acceptedAt = nowIso();
    return ok(this.me());
  }

  private validateRole(id: string, kind: 'human' | 'ai'): MockResponse | null {
    const role = roleViews(this.config).find((entry) => entry.id === id);
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
          (member) => memberRoles(member).includes(id) && (!holders || !holdersAllow(holders, member.kind)),
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
    return { status: id ? 200 : 201, body: roleViews(this.config).find((role) => role.id === input.id) };
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
    const config = memberOf(this.config, handle);
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
        input.effort !== undefined ||
        input.cheapSubagent !== undefined ||
        input.onLeave !== undefined ||
        input.instructions !== undefined ||
        input.permissionMode !== undefined ||
        input.approver !== undefined)
    )
      return error(400, 'not_ai_member', 'Not an AI member');
    if (input.approver !== undefined) {
      // Who may change the settings is `ownerOnlyChanges`, run by `configChangeFailure` below, as on the server.
      const blocker = approverBlocker(this.config, handle, input.approver);
      if (blocker) return error(422, 'approver_unavailable', 'This approver is not available', { blocker });
    }
    const next = clone(this.config);
    const nextMember = memberOf(next, handle)!;
    if (nextMember.kind === 'ai') {
      if (input.permissionMode !== undefined) nextMember.permissionMode = input.permissionMode;
      if (input.approver !== undefined) nextMember.approver = input.approver;
    }
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
      if (input.provider !== undefined && input.provider !== (config.provider ?? DEFAULT_AGENT_PROVIDER)) {
        member.provider = config.provider = input.provider;
        member.model = config.model = modelForProvider(input.provider, config.model);
      }
      if (input.effort !== undefined) {
        if (input.effort === null) {
          delete member.effort;
          delete config.effort;
        } else member.effort = config.effort = input.effort;
      }
      if (input.cheapSubagent !== undefined) {
        if (input.cheapSubagent === null) {
          delete member.cheapSubagent;
          delete config.cheapSubagent;
        } else member.cheapSubagent = config.cheapSubagent = input.cheapSubagent;
      }
      if (input.schedule !== undefined) config.schedule = input.schedule ?? undefined;
      if (input.instructions !== undefined) config.instructions = input.instructions.trim();
      if (input.permissionMode !== undefined) config.permissionMode = input.permissionMode;
      if (input.approver !== undefined) config.approver = input.approver;
      if (input.onLeave !== undefined) {
        if (input.onLeave) {
          config.onLeave = member.onLeave = true;
          // Like the server: the running sessions of a member sent on leave stop.
          for (const session of this.sessions.filter((s) => s.member === handle && this.isLive(s)))
            this.updateSession(session.id, { state: 'exited', activity: null, endedAt: nowIso() });
          this.setMemberState(handle, 'idle', null);
        } else {
          delete config.onLeave;
          delete member.onLeave;
        }
      }
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
      if (!isOpenTask(task)) return error(409, 'task_closed', 'Task is closed');
      const reason = 'reason' in input ? input.reason : undefined;
      this.cancelTask(taskKey, reason === undefined ? {} : { reason });
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

  /** Cancels an open task: the timeline says why (a duplicate names its original), its sessions stop and its questions close. */
  private cancelTask(taskKey: string, why: { reason?: string; duplicateOf?: string }): void {
    const task = this.findTask(taskKey)!;
    const previousStatus = task.status;
    this.updateTask(taskKey, { status: 'cancelled', closedAt: nowIso() });
    this.addTimeline(taskKey, this.owner, 'task_updated', {
      action: 'cancelled',
      previousStatus,
      fields: ['status', 'closedAt'],
      ...why,
    });
    for (const session of this.taskSessions(taskKey)) if (this.isLive(session)) this.stopSession(session.id);
    for (const item of this.inbox.filter((entry) => entry.taskKey === taskKey && entry.state === 'open'))
      this.upsertInbox({ ...item, state: 'cancelled' });
    for (const member of this.members)
      member.currentTaskKeys = member.currentTaskKeys.filter((key) => key !== taskKey);
  }

  private viewerActor(): Actor {
    return { kind: 'human', handle: this.viewerHandle };
  }

  /**
   * The task's attachments, with the server's answers: a task the viewer may not see is unknown,
   * and the shared rules decide who uploads and who deletes. The bytes are not served (the UI
   * points the browser at the content routes, not at fetch).
   */
  private handleAttachments(
    method: string,
    taskKey: string,
    id: string | undefined,
    body: unknown,
  ): MockResponse {
    const viewer = this.taskViewer();
    const task = this.findTask(taskKey);
    if (!task || !canReadAttachments(viewer, task)) return error(404, 'not_found', 'Unknown task');
    if (!id && method === 'GET') {
      return ok({ attachments: clone(this.attachments.filter((entry) => entry.taskKey === taskKey)) });
    }
    if (!id && method === 'POST') {
      if (!canUploadAttachment(viewer, task))
        return error(403, 'insufficient_access', 'Viewers cannot attach files');
      const file = body instanceof FormData ? body.get('file') : null;
      if (!(file instanceof File)) return error(400, 'invalid_request', 'The request carries no file');
      if (file.size > MAX_ATTACHMENT_BYTES) {
        return error(413, 'attachment_too_large', 'Too large', { maxBytes: MAX_ATTACHMENT_BYTES });
      }
      return { status: 201, body: { attachment: clone(this.addAttachment(taskKey, file)) } };
    }
    if (id && method === 'DELETE') {
      const attachment = this.attachments.find((entry) => entry.id === id && entry.taskKey === taskKey);
      if (!attachment) return error(404, 'not_found', 'Unknown attachment');
      if (!canDeleteAttachment(viewer, task, attachment))
        return error(403, 'insufficient_access', 'Only the uploader, an owner or an admin may delete this');
      this.removeAttachment(id);
      return ok({ id, deleted: true });
    }
    return error(404, 'not_found', `No route for ${method}`);
  }

  private taskDetail(task: Task) {
    return {
      task: clone(task),
      parent: task.parentKey ? clone(this.findTask(task.parentKey) ?? null) : null,
      subtasks: clone(this.tasks.filter((child) => child.parentKey === task.key)),
      pullRequests: this.taskPullRequests(task),
      timeline: clone(this.timeline.filter((event) => event.taskKey === task.key)),
      sessions: clone(this.taskSessions(task.key)),
      ...(this.findMember(this.viewerHandle)?.role === 'client' ? {} : { rounds: this.cardRounds(task.key) }),
    };
  }

  /** The card's review rounds and send-backs, by the shared rule (PM-222). */
  private cardRounds(taskKey: string) {
    return countCardRounds(
      this.timeline.filter((event) => event.taskKey === taskKey),
      this.config,
    );
  }

  /** The cards closed lately, measured by the shared rules from the fake's sessions and timeline (PM-222). */
  private closedCardsMeasure(days: number) {
    const since = closedCardsSince(new Date(), days);
    const cards = this.tasks
      .filter((task) => isClosedSince(task, since))
      .sort((a, b) => (a.closedAt! < b.closedAt! ? 1 : -1))
      .map((task) => measureClosedCard(task, this.taskSessions(task.key), this.cardRounds(task.key)));
    return { since, days, cards: clone(cards) };
  }

  /**
   * Like the server's all-or-nothing task update: the whole change is validated first (label
   * rules, then the gates against the labels the task will have, and whether someone may give
   * the approvals the move needs); fields, assignee and labels are applied before the move, and
   * a move that needs an approval requests it with the rest applied.
   */
  private changeTask(task: Task, input: UpdateTaskRequest): MockResponse {
    const actor = this.viewerActor();
    const patch: Partial<Task> = {};
    const fields: string[] = [];
    if (input.title !== undefined && input.title.trim() !== task.title) {
      patch.title = input.title.trim();
      if (!patch.title) return error(400, 'invalid_request', 'Empty title');
      fields.push('title');
    }
    if (input.description !== undefined && input.description !== task.description) {
      patch.description = input.description;
      fields.push('description');
    }
    if (input.visibility !== undefined && input.visibility !== task.visibility) {
      patch.visibility = input.visibility;
      fields.push('visibility');
    }
    if (input.relations && input.parentKey !== undefined)
      return error(400, 'invalid_request', 'Give the parent in parentKey or in relations, not both');
    const relationPlan = input.relations ? this.planRelationChange(task, input.relations) : null;
    if (relationPlan && 'status' in relationPlan) return relationPlan;
    if (relationPlan?.closes && input.stageId !== undefined && input.stageId !== task.stageId)
      return error(400, 'invalid_request', 'A card marked as a duplicate cannot move in the same call');
    if (input.parentKey) {
      const refusal = this.validateParent(task.key, input.parentKey);
      if (refusal) return refusal;
    }
    if (input.parentKey !== undefined && input.parentKey !== (task.parentKey ?? null)) {
      patch.parentKey = input.parentKey;
      fields.push('parentKey');
    }
    // Like the server: a repository of the project, and not while a session of the task runs.
    if (input.repo !== undefined && input.repo !== task.repo) {
      if (input.repo !== null && !repoOf(this.config, input.repo))
        return error(400, 'unknown_repo', 'Unknown repository');
      const live = this.taskSessions(task.key).find((session) => this.isLive(session));
      if (live) return error(409, 'task_session_live', 'A session is still live', { sessionId: live.id });
      patch.repo = input.repo;
      fields.push('repo');
    }
    if (input.assignee !== undefined) {
      if (input.assignee !== null && !memberOf(this.config, input.assignee))
        return error(400, 'unknown_member', 'Unknown member');
      const live = this.taskSessions(task.key).find((session) => this.isLive(session));
      if (live) return error(409, 'task_session_live', 'A session is still live', { sessionId: live.id });
      if (input.assignee !== task.assignee) {
        if (isHandleOnLeave(this.config, input.assignee))
          return error(409, 'member_on_leave', `${input.assignee} is on leave`);
        patch.assignee = input.assignee;
      }
    }
    const wanted = input.labels && unique(input.labels.map((label) => label.trim()).filter(Boolean));
    const labels = planLabelChange(
      this.config,
      { ...task, ...patch },
      wanted
        ? {
            add: wanted.filter((label) => !task.labels.includes(label)),
            remove: task.labels.filter((label) => !wanted.includes(label)),
          }
        : {},
      actor,
    );
    if (!labels.ok) return labelChangeError(labels.refusal);
    const moving = input.stageId !== undefined && input.stageId !== task.stageId;
    if (moving) {
      if (task.status === 'cancelled') return error(409, 'task_closed', 'Task is cancelled');
      const target = stageOf(this.config, input.stageId!);
      if (!target) return error(400, 'unknown_stage', 'Unknown stage');
      const evaluation = evaluateMove(
        { ...task, ...patch, labels: labels.labels },
        this.config,
        task.stageId,
        target.id,
      );
      if (evaluation.unmet.length) return gateBlockedError(evaluation);
      const nobody = this.noApproverError(
        { ...task, ...patch, labels: labels.labels },
        target,
        evaluation.approvals,
      );
      if (nobody) return nobody;
    }

    const previous = { assignee: task.assignee, parentKey: task.parentKey ?? null, repo: task.repo };
    const labelsChanged = labels.added.length > 0 || labels.removed.length > 0;
    if (fields.length || patch.assignee !== undefined || labelsChanged) {
      this.updateTask(task.key, { ...patch, ...(labelsChanged ? { labels: labels.labels } : {}) });
      if (fields.length)
        this.addTimeline(task.key, actor.handle, 'task_updated', {
          fields,
          ...(patch.repo !== undefined ? { repo: patch.repo, previousRepo: previous.repo } : {}),
        });
      if (labelsChanged) this.recordLabels(task, labels, actor, {});
      if (patch.assignee !== undefined)
        this.addTimeline(task.key, actor.handle, 'task_assigned', {
          assignee: task.assignee,
          previous: previous.assignee,
        });
      if (patch.parentKey !== undefined)
        this.recordParentChange(task.key, previous.parentKey, task.parentKey ?? null);
    }
    if (relationPlan) this.applyRelationPlan(relationPlan.steps, task, actor);
    return moving ? this.move(task, input.stageId!, actor) : ok(clone(task));
  }

  /** Adds a comment; the members it mentions get it as a team message (imported ones do not). */
  private recordNote(
    task: Task,
    text: string,
    actor: Actor,
    imported: Pick<CreateTaskCommentRequest, 'importedAuthor' | 'importedAt'> = {},
  ): void {
    const mentions = commentMentions(
      text,
      this.config.team.members.map((member) => member.handle),
      actor.handle,
    );
    this.addTimeline(task.key, actor.handle, 'task_note', { text, mentions, ...imported });
    const isImported = imported.importedAuthor !== undefined || imported.importedAt !== undefined;
    if (!isImported && mentions.length && actor.handle)
      this.sendTeamMessage(actor.handle, mentions, task.key, text);
  }

  /** Records a label change already written to the task: the event, the comment, the assignee's notice. */
  private recordLabels(
    task: Task,
    plan: { added: string[]; removed: string[]; notify: string[] },
    actor: Actor,
    opts: { comment?: string; reason?: LabelChangeReason },
  ): void {
    const data: TimelineEventData['task_labels_changed'] = { added: plan.added, removed: plan.removed };
    if (opts.reason) data.reason = opts.reason;
    this.addTimeline(task.key, actor.handle, 'task_labels_changed', { ...data });
    const comment = opts.comment?.trim();
    if (comment) this.recordNote(task, comment, actor);
    if (plan.notify.length && task.assignee && actor.handle && task.assignee !== actor.handle) {
      const names = plan.notify.map((id) => labelDefinition(this.config, id)?.name ?? id);
      this.sendTeamMessage(
        actor.handle,
        [task.assignee],
        task.key,
        [names.join(', '), comment].filter(Boolean).join('\n\n'),
      );
    }
  }

  /** Adds and removes labels under the project's label rules; a refusal changes nothing. */
  private applyLabels(
    task: Task,
    change: { add?: string[]; remove?: string[] },
    actor: Actor,
    opts: { comment?: string; reason?: LabelChangeReason },
  ): MockResponse | null {
    const plan = planLabelChange(this.config, task, change, actor, opts.comment);
    if (!plan.ok) return labelChangeError(plan.refusal);
    if (!plan.added.length && !plan.removed.length) return null;
    this.updateTask(task.key, { labels: plan.labels });
    this.recordLabels(task, plan, actor, opts);
    return null;
  }

  /** Takes off the labels that expire on an event (the task moving back, its PR changing). */
  private expireLabels(task: Task, trigger: LabelClearTrigger): void {
    const expired = expiredLabels(this.config, task, trigger);
    if (expired.length) this.applyLabels(task, { remove: expired }, SYSTEM_ACTOR, { reason: trigger });
  }

  /** A stage move under the gates: blocked, an approval request in the inbox, or the move itself. */
  private move(task: Task, stageId: string, actor: Actor): MockResponse {
    if (task.status === 'cancelled') return error(409, 'task_closed', 'Task is cancelled');
    const target = stageOf(this.config, stageId);
    if (!target) return error(400, 'unknown_stage', 'Unknown stage');
    if (task.stageId === target.id) return ok(clone(task));
    const evaluation = evaluateMove(task, this.config, task.stageId, target.id);
    if (evaluation.unmet.length) return gateBlockedError(evaluation);
    if (evaluation.approvals.length) return this.requestApproval(task, target, evaluation.approvals, actor);
    this.applyMove(task, target, actor, {});
    return ok(clone(task));
  }

  private openDecisions(task: Task): InboxItem[] {
    return this.inbox.filter(
      (item) => item.state === 'open' && item.kind === 'decision' && item.taskKey === task.key,
    );
  }

  /** The open approval request for this move (one decision per missing approval). */
  private openGateRequests(task: Task, target: Stage): InboxItem[] {
    return this.openDecisions(task).filter((item) => {
      const gate = gateRequestOf(item);
      return gate?.fromStageId === task.stageId && gate.toStageId === target.id;
    });
  }

  /**
   * Like the server: a move needs an approval nobody may give (every holder authored the task,
   * or nobody holds the label) and no request for it is open yet.
   */
  private noApproverError(task: Task, target: Stage, approvals: ApprovalRequirement[]): MockResponse | null {
    if (this.openGateRequests(task, target).length) return null;
    const missing = approvals.find((approval) => !approval.approvers.length);
    if (!missing) return null;
    return error(
      409,
      noApproverReason(this.config, missing.label, task) ?? 'missing_duty_holder',
      `Nobody may approve the label ${missing.label} on this task`,
      { stageId: missing.stageId, label: missing.label },
    );
  }

  /** One decision per missing approval (or the request already open); the task waits. */
  private requestApproval(
    task: Task,
    target: Stage,
    approvals: ApprovalRequirement[],
    actor: Actor,
  ): MockResponse {
    const open = this.openGateRequests(task, target);
    if (open.length) return approvalRequestedError(open);
    const nobody = this.noApproverError(task, target, approvals);
    if (nobody) return nobody;
    const requestId = mockId('gat');
    const items = approvals.map((approval): InboxItem => {
      const gate: GateRequestPayload = {
        requestId,
        taskKey: task.key,
        fromStageId: task.stageId,
        toStageId: target.id,
        stageId: approval.stageId,
        label: approval.label,
        requestedBy: actor,
      };
      const item: InboxItem = {
        id: mockId('inb'),
        projectKey: task.projectKey,
        kind: 'decision',
        assignees: approval.approvers,
        source: actor.handle ?? 'system',
        sessionId: null,
        taskKey: task.key,
        title: task.title,
        body: null,
        payload: { gate },
        options: fixtures.DECISION_OPTIONS,
        state: 'open',
        resolution: null,
        createdAt: nowIso(),
      };
      this.upsertInbox(item);
      return item;
    });
    const waiting = task.status === 'active';
    if (waiting) this.updateTask(task.key, { status: 'waiting' });
    this.addTimeline(task.key, actor.handle, 'task_updated', {
      fields: waiting ? ['status'] : [],
      gateRequest: {
        requestId,
        from: task.stageId,
        to: target.id,
        inboxItemIds: items.map((item) => item.id),
      },
    });
    return approvalRequestedError(items);
  }

  private applyMove(
    task: Task,
    target: Stage,
    actor: Actor,
    extra: Pick<TimelineEventData['task_stage_changed'], 'approvedBy' | 'inboxItemIds'>,
  ): void {
    const from = task.stageId;
    const patch: Partial<Task> = { stageId: target.id };
    if (target.kind === 'done') Object.assign(patch, { status: 'done', closedAt: nowIso() });
    else if (task.status === 'done' || task.status === 'waiting')
      Object.assign(patch, { status: 'active', closedAt: null });
    this.updateTask(task.key, patch);
    this.addTimeline(task.key, actor.handle, 'task_stage_changed', { from, to: target.id, ...extra });
    if (stageIndex(this.config.pipeline, target.id) < stageIndex(this.config.pipeline, from))
      this.expireLabels(task, 'moved_back');
    // Requests made from the previous stage are stale now.
    for (const item of this.openDecisions(task)) this.upsertInbox({ ...item, state: 'cancelled' });
  }

  /** Ends the "waiting for approval" status after a rejected or dropped request. */
  private settleWaiting(
    task: Task,
    by: string,
    data: Pick<TimelineEventData['task_updated'], 'gateRejected' | 'gateBlocked'>,
  ): void {
    const waiting = task.status === 'waiting';
    if (waiting) this.updateTask(task.key, { status: 'active' });
    this.addTimeline(task.key, by, 'task_updated', { fields: waiting ? ['status'] : [], ...data });
  }

  /** Completes (or drops) the stage move an approver decided on, like the server. */
  private decideGate(item: InboxItem, gate: GateRequestPayload): void {
    const task = this.findTask(gate.taskKey);
    const by = item.resolution?.by;
    if (!task || !by) return;
    const siblings = this.inbox.filter(
      (entry) => entry.taskKey === task.key && gateRequestOf(entry)?.requestId === gate.requestId,
    );
    if (item.resolution?.optionId !== 'approve') {
      for (const sibling of siblings)
        if (sibling.state === 'open') this.upsertInbox({ ...sibling, state: 'cancelled' });
      this.settleWaiting(task, by, {
        gateRejected: { requestId: gate.requestId, to: gate.toStageId, inboxItemId: item.id },
      });
      return;
    }
    if (siblings.some((sibling) => sibling.state === 'open')) return;
    if (!siblings.every((s) => s.state === 'resolved' && s.resolution?.optionId === 'approve')) return;
    if (task.stageId !== gate.fromStageId || task.status === 'cancelled') return;
    const target = stageOf(this.config, gate.toStageId);
    if (!target) {
      this.settleWaiting(task, by, { gateBlocked: { to: gate.toStageId, reason: 'unknown_stage' } });
      return;
    }
    // Approving puts each requested human-only label on the task in the approver's name.
    for (const sibling of siblings) {
      const label = gateRequestOf(sibling)?.label;
      if (!label) {
        // A request from before approvals were labels names no label to put on.
        this.settleWaiting(task, by, { gateBlocked: { to: target.id } });
        return;
      }
      const approver: Actor = { kind: 'human', handle: sibling.resolution!.by };
      const refused = this.applyLabels(task, { add: [label] }, approver, { reason: 'approval' });
      if (refused) {
        const code = (refused.body as { error: { code: string } }).error.code;
        this.settleWaiting(task, by, { gateBlocked: { to: target.id, label, reason: code } });
        return;
      }
    }
    const evaluation = evaluateMove(task, this.config, task.stageId, target.id);
    if (evaluation.unmet.length || evaluation.approvals.length) {
      this.settleWaiting(task, by, {
        gateBlocked: { to: target.id, unmet: evaluation.unmet, approvals: evaluation.approvals },
      });
      return;
    }
    this.applyMove(
      task,
      target,
      { kind: 'human', handle: by },
      {
        approvedBy: unique(siblings.map((sibling) => sibling.resolution!.by)),
        inboxItemIds: siblings.map((sibling) => sibling.id),
      },
    );
  }

  private validateParent(taskKey: string | null, parentKey: string): MockResponse | null {
    const refusal = subtaskParentRefusal(parentKey, this.findTask(parentKey), {
      key: taskKey,
      projectKey: fixtures.PROJECT_KEY,
      hasSubtasks: taskKey !== null && this.tasks.some((child) => child.parentKey === taskKey),
    });
    return refusal ? error(400, refusal, `The task cannot become a subtask of ${parentKey}`) : null;
  }

  private recordParentChange(subtaskKey: string, previous: string | null, next: string | null): void {
    for (const [parentKey, type] of [
      [previous, 'task_subtask_removed'],
      [next, 'task_subtask_added'],
    ] as const) {
      if (!parentKey) continue;
      for (const taskKey of [parentKey, subtaskKey])
        this.addTimeline(taskKey, this.owner, type, { parentKey, subtaskKey });
    }
  }

  /**
   * Plans a change of relations with the shared rules (the server's too): what to write, or the
   * refusal as the server answers it. Nothing is written.
   */
  private planRelationChange(
    task: Task,
    change: RelationsChange,
    cards: readonly Task[] = this.tasks,
  ): { steps: RelationStep[]; closes: boolean } | MockResponse {
    const viewer = this.findMember(this.viewerHandle);
    const plan = planRelations({
      task,
      cards,
      elsewhere: () => undefined,
      change,
      markDuplicate: () =>
        duplicateMarkRefusal({
          task,
          stageKind: stageOf(this.config, task.stageId)?.kind,
          hasLiveSession: this.taskSessions(task.key).some((session) => this.isLive(session)),
          mayCancel: viewer?.kind === 'human' && (viewer.role === 'admin' || viewer.role === 'owner'),
        }),
    });
    if (plan.ok) return plan;
    const { refusal } = plan;
    return error(
      refusal.code === 'duplicate_not_allowed' ? 403 : 400,
      refusal.code,
      `The relation with ${plan.key} is refused: ${refusal.code}`,
      refusal,
    );
  }

  /** Writes a planned relation change: the links, the parents, both timelines, and the close of a duplicate. */
  private applyRelationPlan(steps: readonly RelationStep[], task: Task, actor: Actor): void {
    for (const step of steps) {
      if (step.type === 'link_add' || step.type === 'link_remove') {
        const owner = this.findTask(step.owner)!;
        const links =
          step.type === 'link_add'
            ? [...owner.links, { kind: step.kind, ref: step.ref }]
            : owner.links.filter((l) => !(l.kind === step.kind && l.ref === step.ref));
        this.updateTask(owner.key, { links });
        const type = step.type === 'link_add' ? 'task_relation_added' : 'task_relation_removed';
        this.addTimeline(step.owner, actor.handle, type, { kind: step.kind, ref: step.ref });
        this.addTimeline(step.ref, actor.handle, type, {
          kind: reverseRelationKind(step.kind),
          ref: step.owner,
        });
      } else if (step.type === 'parent') {
        const child = this.findTask(step.child)!;
        const previous = child.parentKey ?? null;
        this.updateTask(child.key, { parentKey: step.parent });
        this.recordParentChange(child.key, previous, step.parent);
      } else if (isOpenTask(this.findTask(task.key)!)) {
        this.cancelTask(task.key, {
          reason: `duplicate of ${step.original}`,
          duplicateOf: step.original,
        });
      }
    }
  }

  /** Like the server: a new task may start in any stage its gates let it enter (imports skip them). */
  private createTask(body: unknown): MockResponse {
    const input = parseBody(CreateTaskRequest, body);
    if (!input) return error(400, 'invalid_request', 'Invalid task');
    const actor = this.viewerActor();
    if (input.importedAt !== undefined && this.findMember(this.viewerHandle)?.role !== 'owner')
      return error(403, 'owner_only', 'Only an owner may import tasks');
    const first = this.config.pipeline.stages[0]!;
    const target = input.stageId ? stageOf(this.config, input.stageId) : first;
    if (!target) return error(400, 'unknown_stage', 'Unknown stage');
    const title = input.title.trim();
    if (!title) return error(400, 'invalid_request', 'Empty title');
    const repo = input.repo ?? null;
    if (repo && !repoOf(this.config, repo)) return error(400, 'unknown_repo', 'Unknown repository');
    if (input.parentKey) {
      const refusal = this.validateParent(null, input.parentKey);
      if (refusal) return refusal;
    }
    const at = input.importedAt ?? nowIso();
    const task: Task = {
      parentKey: input.parentKey ?? null,
      id: mockId('tsk'),
      projectKey: fixtures.PROJECT_KEY,
      key: `${fixtures.PROJECT_KEY}-0`,
      title,
      description: input.description ?? '',
      stageId: first.id,
      status: 'active',
      assignee: null,
      repo,
      priority: null,
      labels: unique((input.labels ?? []).map((label) => label.trim()).filter(Boolean)),
      links: [],
      visibility: input.visibility ?? 'internal',
      createdBy: this.viewerHandle,
      createdAt: at,
      updatedAt: at,
      closedAt: null,
    };
    if (target.id !== first.id) {
      if (input.importedAt === undefined) {
        const evaluation = evaluateMove(task, this.config, first.id, target.id);
        if (evaluation.unmet.length || evaluation.approvals.length) return gateBlockedError(evaluation);
      }
      task.stageId = target.id;
    }
    if (target.kind === 'done') Object.assign(task, { status: 'done', closedAt: at });
    if (input.importedAt === undefined) {
      const plan = planLabelChange(this.config, { ...task, labels: [] }, { add: task.labels }, actor);
      if (!plan.ok) return labelChangeError(plan.refusal);
    }
    // Relations are planned with the new card among the project's: a refused one refuses the creation.
    const nextKey = `${fixtures.PROJECT_KEY}-${this.lastTaskSeq + 1}`;
    const relationPlan = input.relations?.length
      ? this.planRelationChange({ ...task, key: nextKey }, { add: input.relations }, [
          ...this.tasks,
          { ...task, key: nextKey },
        ])
      : null;
    if (relationPlan && 'status' in relationPlan) return relationPlan;
    this.lastTaskSeq += 1;
    task.key = nextKey;
    this.tasks.push(task);
    this.emit({ type: 'task_upserted', projectKey: task.projectKey, task: clone(task) });
    this.addTimeline(
      task.key,
      actor.handle,
      'task_created',
      { title, ...(input.importedAt !== undefined ? { imported: true } : {}) },
      null,
      at,
    );
    if (task.parentKey) this.recordParentChange(task.key, null, task.parentKey);
    if (relationPlan) this.applyRelationPlan(relationPlan.steps, task, actor);
    return { status: 201, body: clone(this.findTask(task.key)!) };
  }

  private startTask(taskKey: string, body: unknown): MockResponse {
    const input = parseBody(StartTaskRequest, body);
    const task = this.findTask(taskKey);
    if (!task || !input) return error(404, 'not_found', 'Unknown task');
    if (!isOpenTask(task)) return error(409, 'task_closed', 'Task is closed');
    const workStage = this.config.pipeline.stages.find((stage) => stage.kind === 'work');
    const eligible = workStage ? stageOwners(this.config, workStage) : [];
    const developers = this.members.filter(
      (member) => eligible.includes(member.handle) && member.status !== 'retired' && !member.onLeave,
    );
    const assignee =
      input.assignee ??
      [...developers].sort((a, b) => a.currentTaskKeys.length - b.currentTaskKeys.length)[0]?.handle ??
      null;
    if (!assignee) return error(409, 'no_free_member', 'No developer available');
    if (!eligible.includes(assignee))
      return error(400, 'not_stage_owner', 'Assignee must own the work stage');
    // Like admission: a role that changes files needs the task's repository, and nothing has happened yet.
    const chosen = memberOf(this.config, assignee);
    if (isOnLeave(chosen)) return error(409, 'member_on_leave', `${assignee} is on leave`);
    if (chosen?.kind === 'ai' && repoRequired(this.config, chosen.role, task))
      return error(409, 'repo_required', 'The task needs a repository before a developer starts on it', {
        taskKey: task.key,
      });
    const running = this.sessions.find(
      (s) =>
        s.member === assignee &&
        s.workItem.type === 'task' &&
        s.workItem.taskKey === task.key &&
        this.isLive(s),
    );
    if (this.findMember(assignee)?.kind === 'ai' && !running && !this.config.team.limits.aiEnabled)
      return error(409, 'ai_disabled', 'AI work is switched off in this project');
    const from = task.stageId;
    this.updateTask(task.key, { assignee, stageId: workStage?.id ?? task.stageId, status: 'active' });
    this.addTimeline(task.key, null, 'task_assigned', { assignee });
    if (workStage) this.addTimeline(task.key, null, 'task_stage_changed', { from, to: workStage.id });
    if (this.findMember(assignee)?.kind === 'human' || running) return ok(this.taskDetail(task));
    const session: Session = {
      id: mockId('ses'),
      projectKey: fixtures.PROJECT_KEY,
      member: assignee,
      workItem: { type: 'task', taskKey: task.key },
      claudeSessionId: mockUuid(Math.floor(Math.random() * 1e9)),
      provider: this.providerOf(assignee),
      cwd: `/Users/owner/.projectman/worktrees/${fixtures.PROJECT_KEY}/${task.key}`,
      branch: `${taskSeq(task.key)}-work`,
      transcriptPath: null,
      state: 'starting',
      activity: null,
      startedAt: nowIso(),
      lastActivityAt: nowIso(),
      endedAt: null,
      usage: { since: nowIso(), rows: [] },
    };
    this.sessions.push(session);
    this.chats[session.id] = [];
    this.flushTeamMessages(session);
    this.emit({ type: 'session_upserted', projectKey: session.projectKey, session: clone(session) });
    this.addTimeline(task.key, assignee, 'session_started', { member: assignee, resumed: false }, session.id);
    const member = this.findMember(assignee);
    if (member) member.currentTaskKeys = [...member.currentTaskKeys, task.key];
    this.setMemberState(assignee, 'working', `Indul: ${task.key}`);
    return ok(this.taskDetail(task));
  }

  /** Hires an AI member with the role's defaults, named and handled like the server does. */
  private hire(body: unknown): MockResponse {
    const input = parseBody(HireMemberRequest, body);
    if (!input) return error(400, 'invalid_request', 'Invalid hire request');
    const failure = this.validateRole(input.role, 'ai');
    if (failure) return failure;
    const defaults = aiMemberDefaults(input.role, this.config.team.roles, this.config.team.roleOverrides);
    if (!defaults) return error(400, 'role_not_for_ai', 'No AI member can hold this role');
    const taken = this.takenHandles();
    if (input.handle && taken.has(input.handle)) return error(409, 'handle_taken', 'Handle already taken');
    const handle = input.handle ?? defaultMemberHandle(input.role, taken, input.specialty);
    const specialty = input.specialty?.trim() ?? '';
    const index =
      this.config.team.members.filter(
        (m) => m.kind === 'ai' && m.role === input.role && (m.specialty ?? '').trim() === specialty,
      ).length + 1;
    const config: AiMemberConfig = {
      kind: 'ai',
      handle,
      displayName:
        input.displayName?.trim() ||
        defaultMemberName(input.role, this.config.project.language, index, {
          specialty: specialty || undefined,
          customRoles: this.config.team.roles,
        }),
      role: input.role,
      ...(input.specialty ? { specialty: input.specialty } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      model:
        input.provider === 'codex' ? modelForProvider('codex', input.model) : (input.model ?? defaults.model),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.cheapSubagent ? { cheapSubagent: input.cheapSubagent } : {}),
      permissionMode: defaults.permissionMode,
      approver: defaults.approver,
      capacity: defaults.capacity,
      instructions: defaults.instructions,
      sponsor: this.sponsor(),
      temp: false,
      ...(input.schedule ? { schedule: input.schedule } : {}),
    };
    const next = clone(this.config);
    next.team.members.push(config);
    const refused = this.configChangeFailure(next);
    if (refused) return refused;
    this.config = next;
    const member: MemberView = {
      handle,
      displayName: config.displayName,
      kind: 'ai',
      provider: config.provider ?? DEFAULT_AGENT_PROVIDER,
      model: config.model,
      effort: config.effort,
      ...(config.cheapSubagent ? { cheapSubagent: config.cheapSubagent } : {}),
      ...permissionView(this.config, config),
      role: config.role,
      roles: memberRoles(config),
      specialty: config.specialty ?? null,
      status: 'idle',
      activity: null,
      currentTaskKeys: [],
      sponsor: config.sponsor,
      temp: false,
    };
    this.members.push(member);
    this.commitConfig(`Hire ${input.role} ${handle}`);
    this.addTimeline(null, this.viewerHandle, 'member_hired', {
      handle,
      role: config.role,
      temp: false,
      sponsor: config.sponsor,
    });
    this.memberChanged(handle);
    return { status: 201, body: clone(member) };
  }

  /** The sponsor of an AI member a human hires: the requester when an owner, else the first owner. */
  private sponsor(): string {
    const viewer = memberOf(this.config, this.viewerHandle);
    if (viewer?.kind === 'human' && viewer.access === 'owner') return viewer.handle;
    return (
      this.config.team.members.find((m) => m.kind === 'human' && m.access === 'owner')?.handle ??
      this.viewerHandle
    );
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
    this.commitConfig(`Retire ${handle}${target ? ` (handover to ${target.handle})` : ''}`);
    this.memberChanged(handle);
    return ok();
  }

  /** A human writes into an AI session's chat: like the server, the text trimmed and not empty. */
  private sessionMessage(sessionId: string, body: unknown): MockResponse {
    const input = parseBody(SendMessageRequest, body);
    if (!input) return error(400, 'invalid_request', 'Invalid message');
    const session = this.findSession(sessionId);
    if (!session) return error(404, 'not_found', 'Unknown session');
    const text = input.text.trim();
    if (!text) return error(400, 'invalid_request', 'The message text is empty', { field: 'text' });
    const taskKey = session.workItem.type === 'task' ? session.workItem.taskKey : null;
    if (!this.isLive(session) && !this.config.team.limits.aiEnabled)
      return error(409, 'ai_disabled', 'AI work is switched off in this project');
    if (taskKey && this.findTask(taskKey) && !isOpenTask(this.findTask(taskKey)!))
      return error(409, 'task_closed', 'Task is closed');
    this.appendChat(sessionId, [this.chatItem('user_text', { origin: 'human', text })]);
    this.updateSession(sessionId, { state: 'working', activity: null, endedAt: null });
    return { status: 202 };
  }

  /**
   * A running session reports usage (the runner's `usage` event, PM-178): it is added to the
   * session, and, as on the server, once the session's `limitTokens` reach the project's warning
   * limit (PM-187) the session is marked and the owners get one alert. The session keeps running.
   */
  reportUsage(sessionId: string, entries: readonly TokenUsage[]): void {
    const session = this.findSession(sessionId);
    if (!session) return;
    const usage = session.usage ?? { since: nowIso(), rows: [] };
    const rows = mergeTokenUsage([...usage.rows, ...entries]);
    const limit = this.config.team.limits.warnAboveSessionTokens;
    const counted = limitTokens(usageTotal(rows));
    const alerted = !session.usageAlert && limit !== undefined && counted >= limit;
    this.updateSession(sessionId, {
      usage: { ...usage, rows },
      ...(alerted ? { usageAlert: { at: nowIso(), countedTokens: counted, limitTokens: limit } } : {}),
    });
    if (!alerted) return;
    const payload: SessionTokensAlert = {
      alert: 'session_tokens',
      countedTokens: counted,
      limitTokens: limit,
      workItem: session.workItem,
      sessionStartedAt: session.startedAt,
    };
    this.upsertInbox({
      id: mockId('inb'),
      projectKey: session.projectKey,
      kind: 'alert',
      assignees: boundaryOwners(this.config),
      source: session.member,
      sessionId: session.id,
      taskKey: session.workItem.type === 'task' ? session.workItem.taskKey : null,
      title: `Session used ${counted} tokens, above the warning limit of ${limit}`,
      body: null,
      payload,
      options: [ALERT_SEEN_OPTION],
      state: 'open',
      resolution: null,
      createdAt: nowIso(),
    });
  }

  /**
   * What the member's sessions used lately (PM-178). The fake keeps no hourly rows: a measured
   * session counts whole in a window its last activity falls in.
   */
  private memberUsage(handle: string): MemberUsage {
    const within = (hours: number) =>
      mergeTokenUsage(
        this.sessions
          .filter(
            (s) =>
              s.member === handle &&
              s.usage &&
              Date.now() - Date.parse(s.lastActivityAt) <= hours * 3_600_000,
          )
          .flatMap((s) => s.usage!.rows),
      );
    return { lastDay: within(24), lastWeek: within(24 * 7) };
  }

  /** What the member is working on now (see `isWorkingOnTask`), plus its live other chats. */
  private memberLoad(handle: string): number {
    const live = this.sessions.filter((s) => s.member === handle && this.isLive(s));
    const keys = new Set(
      live.flatMap((s) => {
        if (s.workItem.type !== 'task') return [];
        const task = this.findTask(s.workItem.taskKey);
        return task && isOpenTask(task) && isWorkingOnTask(this.config, task, handle, s.state)
          ? [task.key]
          : [];
      }),
    );
    return keys.size + live.filter((s) => s.workItem.type !== 'task').length;
  }

  /** Like the server, a session records the agent CLI it runs: the member's provider. */
  private providerOf(handle: string): AgentProvider {
    const member = memberOf(this.config, handle);
    return (member?.kind === 'ai' ? member.provider : undefined) ?? DEFAULT_AGENT_PROVIDER;
  }

  private planUsageFor(provider: AgentProvider): PlanUsage | null {
    return this.providerPlanUsage[provider] ?? (provider === 'claude' ? this.planUsage : this.codexPlanUsage);
  }

  /**
   * Why an automatic start of the member's AI work must wait, or null: the project's AI switch, a
   * live previous schedule run (schedule runs only), the member's capacity, the concurrency
   * limit, the provider's plan usage and its login.
   */
  private admissionRefusal(member: AiMemberConfig, opts: { scheduleRun?: boolean } = {}): ErrorCode | null {
    const limits = this.config.team.limits;
    const live = this.sessions.filter((s) => this.isLive(s));
    const provider = member.provider ?? DEFAULT_AGENT_PROVIDER;
    const plan = this.planUsageFor(provider);
    if (!limits.aiEnabled) return 'ai_disabled';
    if (isOnLeave(member)) return 'member_on_leave';
    if (opts.scheduleRun && live.some((s) => s.member === member.handle && s.workItem.type === 'schedule'))
      return 'previous_run_live';
    if (this.memberLoad(member.handle) >= member.capacity) return 'member_at_capacity';
    if (
      aiLimitReached(
        this.config,
        live.filter((s) => ['starting', 'working', 'waiting_permission'].includes(s.state)).length,
      )
    )
      return 'ai_limit_reached';
    if (Math.max(plan?.fiveHourPercent ?? 0, plan?.weeklyPercent ?? 0) > limits.pauseAbovePlanUsagePercent)
      return 'plan_usage_paused';
    if (!this.providerLoggedIn[provider]) return 'provider_not_logged_in';
    return null;
  }

  private humanTeamMessage(body: unknown): MockResponse {
    const viewer = this.findMember(this.viewerHandle);
    if (!viewer || !['owner', 'admin', 'developer', 'client'].includes(viewer.role))
      return error(403, 'insufficient_access', 'Developer or client required');
    const input = parseBody(SendTeamMessageRequest, body);
    if (!input) return error(400, 'invalid_request', 'Invalid message');
    if (input.taskKey) {
      const task = this.findTask(input.taskKey);
      if (!task || !this.canSee(task)) return error(404, 'not_found', 'Unknown task');
    }
    const refusal = this.teamMessageRefusal(this.viewerHandle, input.to, input.text);
    if (refusal) return refusal;
    const message = this.sendTeamMessage(this.viewerHandle, input.to, input.taskKey ?? null, input.text);
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
    const member = memberOf(this.config, handle);
    if (!member) return error(404, 'not_found', 'Unknown member');
    if (member.kind !== 'ai') return error(400, 'not_ai_member', 'Only AI conversations');
    const existing = this.sessions.find((s) => s.member === handle && s.workItem.type === 'general');
    if (existing && this.isLive(existing)) return { status: 202, body: clone(existing) };
    const refusal = this.admissionRefusal(member);
    if (refusal) return error(409, refusal, 'The conversation cannot start now');
    const at = nowIso();
    const session: Session = existing ?? {
      id: mockId('ses'),
      projectKey: fixtures.PROJECT_KEY,
      member: handle,
      workItem: { type: 'general' },
      claudeSessionId: mockUuid(this.sessions.length + 1),
      provider: this.providerOf(handle),
      cwd: this.config.project.workspacePath,
      branch: null,
      transcriptPath: null,
      state: 'idle',
      activity: null,
      startedAt: at,
      lastActivityAt: at,
      endedAt: null,
      usage: { since: at, rows: [] },
    };
    if (!existing) this.sessions.push(session);
    this.chats[session.id] ??= [];
    this.updateSession(session.id, { state: 'idle', endedAt: null, provider: this.providerOf(handle) });
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
    const member = memberOf(this.config, handle);
    if (!member) return error(404, 'not_found', 'Unknown member');
    if (member.kind !== 'ai' || !member.schedule)
      return error(400, 'member_not_scheduled', 'Member has no AI schedule');
    const reason = this.admissionRefusal(member, { scheduleRun: true });
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
      provider: this.providerOf(handle),
      cwd: this.config.project.workspacePath,
      branch: null,
      transcriptPath: null,
      state: 'working',
      activity: null,
      startedAt: at,
      lastActivityAt: at,
      endedAt: null,
      usage: { since: at, rows: [] },
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

  /**
   * An owner sets a session's own permission settings (PM-170), as the server does: only an owner,
   * the AI approver only while it can be chosen, `null` back to the member's. A new mode of a
   * session in a turn waits for its restart; an idle one restarts at once (nothing to show here).
   */
  private updateSessionPermissions(sessionId: string, body: unknown): MockResponse {
    if (this.findMember(this.viewerHandle)?.role !== 'owner')
      return error(403, 'insufficient_access', 'requires owner access');
    const input = parseBody(UpdateSessionRequest, body);
    if (!input) return error(400, 'invalid_request', 'Invalid session update');
    const session = this.findSession(sessionId);
    if (!session) return error(404, 'not_found', 'Unknown session');
    const member = memberOf(this.config, session.member);
    if (member?.kind !== 'ai') return error(404, 'not_found', 'Unknown member');
    if (input.approver) {
      const blocker = approverBlocker(this.config, member.handle, input.approver);
      if (blocker) return error(422, 'approver_unavailable', 'This approver is not available', { blocker });
    }
    const from = effectiveSessionPermissions(member, session);
    const next: Session = clone(session);
    if (input.permissionMode !== undefined) {
      if (input.permissionMode === null) delete next.permissionModeOverride;
      else next.permissionModeOverride = input.permissionMode;
    }
    if (input.approver !== undefined) {
      if (input.approver === null) delete next.approverOverride;
      else next.approverOverride = input.approver;
    }
    const to = effectiveSessionPermissions(member, next);
    const restart =
      this.isLive(session) && session.state !== 'idle' && from.permissionMode !== to.permissionMode;
    const taskKey = session.workItem.type === 'task' ? session.workItem.taskKey : null;
    const record = (field: 'mode' | 'approver', values: [unknown, unknown], sources: [string, string]) => {
      if (values[0] === values[1] && sources[0] === sources[1]) return;
      this.addTimeline(
        taskKey,
        this.viewerHandle,
        'session_permission_changed',
        {
          member: session.member,
          field,
          from: values[0] ?? null,
          to: values[1] ?? null,
          ...(sources[1] === 'member' ? { reset: true } : {}),
          ...(field === 'mode' && restart ? { restart: true } : {}),
        },
        session.id,
      );
    };
    if (input.permissionMode !== undefined)
      record('mode', [from.permissionMode, to.permissionMode], [from.source.mode, to.source.mode]);
    if (input.approver !== undefined)
      record('approver', [from.approver, to.approver], [from.source.approver, to.source.approver]);
    delete session.permissionModeOverride;
    delete session.approverOverride;
    delete session.permissionRestartPending;
    const updated = this.updateSession(sessionId, {
      ...(next.permissionModeOverride ? { permissionModeOverride: next.permissionModeOverride } : {}),
      ...(next.approverOverride ? { approverOverride: next.approverOverride } : {}),
      ...(restart ? { permissionRestartPending: true as const } : {}),
    })!;
    return ok(clone(updated));
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
    const viewer = memberOf(this.config, this.viewerHandle);
    if (viewer?.kind !== 'human') return error(403, 'ai_approval_forbidden', 'Only humans may approve');
    if (item.kind === 'boundary') return error(403, 'insufficient_access', 'Use the boundary endpoint');
    const gate = item.kind === 'decision' && input.optionId === 'approve' ? gateRequestOf(item) : null;
    if (gate?.label) {
      // Approving puts the label on in the approver's name: the label rules apply up front.
      const task = item.taskKey ? (this.findTask(item.taskKey) ?? null) : null;
      const refusal = approvalRefusal(this.config, gate.label, viewer.handle, task);
      if (refusal) return error(403, refusal, 'The approval is not allowed');
    }
    if (!item.assignees.includes(viewer.handle) && !(item.kind !== 'decision' && viewer.access === 'owner'))
      return error(403, 'not_an_assignee', 'Only assignees may decide');
    const note = input.note?.trim() || null;
    if (item.kind === 'question' && input.optionId === 'answer' && !note) {
      return error(400, 'answer_required', 'A free-text answer needs a note');
    }
    const resolved: InboxItem = {
      ...item,
      state: 'resolved',
      resolution: { optionId: input.optionId, by: viewer.handle, at: nowIso(), note },
    };
    this.upsertInbox(resolved);
    this.afterResolve(resolved);
    return ok(clone(resolved));
  }

  private refreshBoundaryInbox(): void {
    for (const item of this.inbox.filter((entry) => entry.kind === 'boundary')) {
      const parsed = BoundaryRequest.safeParse(item.payload.boundary);
      if (!parsed.success) continue;
      const request = parsed.data;
      const grant = this.boundaryGrants.get(request.id);
      if (request.consumedAt || grant?.state === 'consumed' || grant?.consumedAt) continue;
      const state = boundaryWaitingState(this.config, request, Date.now());
      if (state === request.state) continue;
      if (grant?.state === 'active' && state === 'expired')
        this.boundaryGrants.set(request.id, { ...grant, state: 'expired', revokedAt: nowIso() });
      const next = {
        ...request,
        state,
        updatedAt: nowIso(),
        assignees: state === 'pending_owner' ? boundaryOwners(this.config) : request.assignees,
        ...(state === 'expired'
          ? {
              invalidation: {
                actor: { kind: 'system', handle: null },
                reason: 'deadline_expired',
                at: nowIso(),
              },
            }
          : {}),
      };
      this.upsertInbox({
        ...item,
        payload: { boundary: next },
        assignees: [...new Set([...next.assignees, ...boundaryOwners(this.config)])],
        state: state === 'expired' && item.state === 'open' ? 'expired' : item.state,
      });
    }
  }

  private decideBoundary(id: string, body: unknown, revoke: boolean): MockResponse {
    this.refreshBoundaryInbox();
    const item = this.inbox.find((entry) => entry.id === id && entry.kind === 'boundary');
    const parsed = BoundaryRequest.safeParse(item?.payload.boundary);
    if (!item || !parsed.success) return error(404, 'not_found', 'Unknown boundary request');
    const request = parsed.data;
    const viewer = memberOf(this.config, this.viewerHandle);
    if (revoke && (viewer?.kind !== 'human' || viewer.access !== 'owner'))
      return error(403, 'owner_only', 'Only owners may revoke');
    const storedGrant = this.boundaryGrants.get(id);
    if (revoke && (request.consumedAt || storedGrant?.state === 'consumed' || storedGrant?.consumedAt))
      return error(409, 'inbox_item_closed', 'Boundary grant was already consumed');
    if (
      revoke ? !['pending_lead', 'pending_owner', 'allowed'].includes(request.state) : item.state !== 'open'
    )
      return error(409, 'inbox_item_closed', 'Boundary request closed');
    const input = revoke ? null : parseBody(DecideBoundaryRequest, body);
    if (!revoke && !input) return error(400, 'invalid_request', 'Invalid decision');
    if (!revoke && !canDecideBoundary(this.config, request, this.viewerHandle))
      return error(403, 'not_an_assignee', 'No live authorization duty');
    const state = revoke ? 'revoked' : input!.decision === 'allow' ? 'allowed' : 'denied';
    const reason = revoke ? 'owner_revoked' : input!.reason;
    const next: BoundaryRequest = {
      ...request,
      state,
      reason: revoke && request.decidedBy ? request.reason : reason,
      updatedAt: nowIso(),
      decidedBy: revoke ? request.decidedBy : { kind: viewer!.kind, handle: viewer!.handle },
      ...(revoke
        ? {
            invalidation: {
              actor: { kind: viewer!.kind, handle: viewer!.handle },
              reason: 'owner_revoked' as const,
              at: nowIso(),
            },
          }
        : {}),
    };
    if (state === 'allowed')
      this.boundaryGrants.set(id, {
        id: `grt_${id.slice(-100)}`,
        requestId: id,
        projectKey: request.projectKey,
        member: request.member,
        sessionId: request.sessionId,
        taskKey: request.taskKey,
        operationId: request.operationId,
        target: request.target,
        policyVersion: request.policyVersion,
        state: 'active',
        decidedBy: next.decidedBy!,
        reason: input!.reason,
        createdAt: nowIso(),
        expiresAt: request.expiresAt,
        revokedAt: null,
        consumedAt: null,
      });
    const grant = this.boundaryGrants.get(id);
    if (revoke && grant?.state === 'active')
      this.boundaryGrants.set(id, { ...grant, state: 'revoked', revokedAt: nowIso() });
    this.upsertInbox({
      ...item,
      state: revoke && item.state === 'open' ? 'cancelled' : 'resolved',
      payload: { boundary: next },
      resolution:
        revoke && item.resolution
          ? item.resolution
          : {
              optionId: state === 'allowed' ? 'allow' : 'deny',
              by: this.viewerHandle,
              at: nowIso(),
              note: reason,
            },
    });
    this.addTimeline(
      item.taskKey,
      this.viewerHandle,
      'boundary_changed',
      {
        requestId: id,
        state,
        reason,
        operation: request.target.operation,
        resource: request.target.resource,
        category: request.category,
        assignees: request.assignees,
        policyVersion: request.policyVersion,
      },
      item.sessionId,
    );
    return ok(clone(next));
  }

  /** What the server does with a decision: record it, answer the asker, apply a gate decision. */
  private afterResolve(item: InboxItem): void {
    const resolution = item.resolution!;
    const sessionId = item.sessionId;
    if (item.kind === 'permission') {
      const allowed = resolution.optionId !== 'deny';
      this.addTimeline(
        item.taskKey,
        resolution.by,
        'permission_resolved',
        { inboxItemId: item.id, decision: allowed ? 'allow' : 'deny', optionId: resolution.optionId },
        sessionId,
      );
      const session = sessionId ? this.findSession(sessionId) : undefined;
      if (session && this.isLive(session))
        this.updateSession(session.id, { state: allowed ? 'working' : 'idle', activity: null });
      return;
    }
    if (item.kind === 'question') {
      const answer =
        resolution.note ??
        item.options.find((option) => option.id === resolution.optionId)?.label ??
        resolution.optionId;
      this.addTimeline(
        item.taskKey,
        resolution.by,
        'question_answered',
        { inboxItemId: item.id, answer },
        sessionId,
      );
      this.sendTeamMessage(resolution.by, [item.source], item.taskKey, answer);
      return;
    }
    const gate = item.kind === 'decision' ? gateRequestOf(item) : null;
    if (gate) this.decideGate(item, gate);
  }
}
