import { isOnLeave, memberOf, permissionDelegationOf } from '@projectman/shared';
import type { ExecutionProfile, Me } from '@projectman/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { AuthService } from '../auth';
import type {
  AttachmentStorage,
  BoundaryOperationAdapter,
  ConfigStore,
  ContextPackBuilder,
  EventBus,
  GithubPublisher,
  GithubService,
  ManagedVmBoundary,
  MemberMemoryStore,
  MemberWorkspaceManager,
  PermissionBroker,
  RunnerModule,
  RuntimeBoundary,
  WorktreeManager,
} from '../contracts';
import type { Repositories } from '../db';
import { EgressService } from './egress';
import type { EgressSettings } from './egress';
import type { ProcessProbe } from './workspaces';
import { projectAccessFor } from './access';
import type { ProjectAccess } from './access';
import { Admission, DeferredStarts, MessageStarts, StageHandOver, TaskStarts } from './admission';
import type { StartSpec } from './admission';
import { AttachmentService } from './attachments';
import { BackgroundTasks } from './background';
import { BoardService } from './board';
import { BoundaryService } from './boundary';
import { createDomainContext, defaultTemplateRegistry } from './context';
import type { DomainContext, TemplateRegistry } from './context';
import { createEventBus } from './event-bus';
import { GithubSync } from './github-sync';
import { InboxService, delegatedPermissionPrompt } from './inbox';
import { InvitationService } from './invitations';
import { MemberProfiles, MemberService } from './members';
import { MessageDelivery, MessageService, Messaging } from './messaging';
import { PlanUsageMonitor } from './plan-usage';
import { PresenceService } from './presence';
import { ProjectService } from './projects';
import { PublishingGate } from './publishing';
import { RoleService } from './roles';
import { ScheduleService } from './schedules';
import type { ScheduleTimer } from './schedules';
import { SessionOrchestrator } from './sessions';
import { TaskService } from './tasks';
import { TeamToolsService } from './team-tools';
import { TimelineService } from './timeline';
import { SYSTEM_ACTOR } from './util';

export * from './access';
export * from './context';
export * from './errors';
export { createEventBus } from './event-bus';
export { createDomainEvents } from './events';
export type { DomainEventMap, DomainEvents } from './events';
export { Admission, DeferredStarts, MessageStarts, StageHandOver, TaskStarts } from './admission';
export type {
  AdmissionRequest,
  AutomaticStart,
  DeferredStart,
  DeferredStartStore,
  StartSpec,
  StartTaskOptions,
  StartTaskResult,
} from './admission';
export {
  AttachmentService,
  contentDisposition,
  createAttachmentStorage,
  openWorkspaceFile,
  WorkspaceFileRefusal,
} from './attachments';
export type { WorkspaceFile, WorkspaceFileHooks, WorkspaceFileRefusalReason } from './attachments';
export { BackgroundTasks } from './background';
export { BoardService } from './board';
export { BoundaryService } from './boundary';
export { EgressService } from './egress';
export type { EgressDecision, EgressIdentity, EgressSession, EgressSettings } from './egress';
export { GithubSync } from './github-sync';
export { InboxService, PERMISSION_OPTIONS, DECISION_OPTIONS, ANSWER_OPTION } from './inbox';
export { InvitationService } from './invitations';
export { MemberProfiles, MemberService } from './members';
export { MessageDelivery, MessageService, Messaging } from './messaging';
export { RoleService, roleUsage, roleViews } from './roles';
export { defaultMemberHandle, defaultMemberName } from './naming';
export { PlanUsageCache, PlanUsageMonitor, highestUsagePercent } from './plan-usage';
export { PresenceService } from './presence';
export { ProjectService, OWNER_HANDLE } from './projects';
export type { Author, LoadedProject, ConfigChange } from './projects';
export { ScheduleService } from './schedules';
export type { ScheduleTimer } from './schedules';
export * from './session-policy';
export {
  describeSandbox,
  describeUnattendedCommands,
  preApprovedPrefixes,
  PROJECT_CHECK_COMMANDS,
} from './unattended-commands';
export type { UnattendedCommandsInput } from './unattended-commands';
export {
  SessionOrchestrator,
  BUSY_SESSION_STATES,
  LIVE_SESSION_STATES,
  MAX_FIRST_INPUT_CHARS,
} from './sessions';
export { TaskService, isOpenTask } from './tasks';
export type { MoveResult, StageChange, TaskUpdate } from './tasks';
export { TeamToolsService } from './team-tools';
export { TimelineService } from './timeline';
export { SYSTEM_ACTOR, SYSTEM_AUTHOR, humanActor, aiActor } from './util';

export interface DomainOptions {
  boundaryAdapter?: BoundaryOperationAdapter;
  /** The VM boundary (PM-140); absent or `off` everywhere but in the managed VM. */
  runtimeBoundary?: RuntimeBoundary;
  /** The network gate's base destinations and grant length (managed VM). */
  egress?: EgressSettings;
  repos: Repositories;
  configStore: ConfigStore;
  logger: FastifyBaseLogger;
  /** Base URL the claude CLI reaches this server at (MCP endpoint), e.g. http://127.0.0.1:4700. */
  publicBaseUrl: string;
  /** Creates the runner module once the permission broker (the inbox) exists. */
  createRunner: (broker: PermissionBroker) => RunnerModule;
  github: GithubService;
  /**
   * The VM's GitHub publishing identity (PM-142): without it `publish_task_branch` refuses. It is
   * separate from `github`, which only reads, so the poller never holds write rights.
   */
  githubPublisher?: GithubPublisher;
  contextBuilder: ContextPackBuilder;
  memory: MemberMemoryStore;
  worktrees: WorktreeManager;
  /** Where the files of task attachments live (PROJECTMAN_HOME/attachments). */
  attachmentStorage: AttachmentStorage;
  /** Creates the accounts of accepted invitations. */
  accounts: Pick<AuthService, 'prepareUser'>;
  /** Root used to constrain automatic lockfile installs; unset means no install auto-approval. */
  worktreesRootDir?: string;
  /**
   * Durable member workspaces (PM-138) in place of a worktree per task; absent, task sessions use
   * `worktrees` as before.
   */
  memberWorkspaces?: MemberWorkspaceManager;
  /** The installation's home (PROJECTMAN_HOME); its sensitive parts are denied to the agents' file tools. */
  appHome?: string;
  /** Where member workspaces live: a developer's routine steps there run without asking, as in a worktree. */
  workspacesRootDir?: string;
  /** Whether a process group still runs (tests replace it): a workspace reservation outlives a restart until it is gone. */
  processExists?: ProcessProbe;
  /**
   * The installation's execution profile (PM-141): `legacy` (default) or the owner's `managed_vm`,
   * which starts sessions question-free in the member's own workspace, on a verified boundary only.
   */
  executionProfile?: ExecutionProfile;
  /** The proof of the managed VM boundary, asked at every session start of a `managed_vm` installation. */
  managedVm?: ManagedVmBoundary;
  /**
   * A standby copy of an installation (PM-143, `instance.json`): it shows its data but runs no scheduler,
   * no GitHub polling and no automatic starts, and refuses every AI session start. Only one copy of a
   * home may work, and a rehearsal or not yet released copy is never it.
   */
  standby?: boolean;
  templates?: TemplateRegistry;
  bus?: EventBus;
  now?: () => Date;
  planUsageTtlMs?: number;
  scheduleTimer?: ScheduleTimer;
  /** Delay before a done task's sessions stop and its worktrees are removed (default 2 s). */
  doneCleanupDelayMs?: number;
  /** How often refused automatic session starts are retried (default 30 s). */
  handOffRetryMs?: number;
}

export type Domain = ReturnType<typeof createDomain>;

/** Builds every domain service and wires their reactions to the domain events. */
export function createDomain(opts: DomainOptions) {
  const now = opts.now ?? (() => new Date());
  const bus = opts.bus ?? createEventBus(opts.logger);
  const ctx: DomainContext = createDomainContext({ repos: opts.repos, bus, logger: opts.logger, now });
  const { events } = ctx;
  const templates = opts.templates ?? defaultTemplateRegistry;
  const background = new BackgroundTasks();

  const timeline = new TimelineService(ctx);
  const projects = new ProjectService({ ctx, configStore: opts.configStore, templates, timeline });
  const attachmentDirectory = (projectKey: string, taskKey: string) =>
    opts.attachmentStorage.taskDirectory(projectKey, taskKey);
  const inbox = new InboxService({
    ctx,
    timeline,
    projects,
    worktreesRootDir: opts.worktreesRootDir,
    workspacesRootDir: opts.memberWorkspaces ? opts.workspacesRootDir : undefined,
    attachmentDirectory,
  });
  const runnerModule = opts.createRunner(inbox.broker);
  const presence = new PresenceService();
  // The deferred automatic starts live in SQLite too: a restart loads them back (see `start`).
  const deferredStarts = new DeferredStarts(opts.repos.deferredStarts);
  const messages = new MessageService({ ctx, timeline });
  const tasks = new TaskService({ ctx, timeline, projects, inbox, startWaiting: deferredStarts });
  const attachments = new AttachmentService({
    ctx,
    projects,
    tasks,
    timeline,
    storage: opts.attachmentStorage,
  });
  const members = new MemberService({ ctx, projects, timeline, presence, inbox });
  const roles = new RoleService({ projects });
  const sessions = new SessionOrchestrator({
    ctx,
    projects,
    tasks,
    members,
    timeline,
    runner: runnerModule.runner,
    transcripts: runnerModule.transcripts,
    contextBuilder: opts.contextBuilder,
    memory: opts.memory,
    worktrees: opts.worktrees,
    publicBaseUrl: opts.publicBaseUrl,
    doneCleanupDelayMs: opts.doneCleanupDelayMs,
    attachments,
    attachmentDirectory,
    memberWorkspaces: opts.memberWorkspaces,
    processExists: opts.processExists,
    runtimeBoundary: opts.runtimeBoundary,
    executionProfile: opts.executionProfile,
    managedVm: opts.managedVm,
    standby: opts.standby,
    appHome: opts.appHome,
    // `boundary` is built below; the callback only runs when a session starts.
    onExecutionProfileChange: (projectKey, sessionId) => boundary.invalidateSession(projectKey, sessionId),
  });
  const usage = new PlanUsageMonitor({
    provider: runnerModule.planUsage,
    providerFor: (provider) => runnerModule.planUsageFor?.(provider),
    projects,
    bus: ctx.bus,
    logger: opts.logger,
    now,
    background,
    ttlMs: opts.planUsageTtlMs,
  });
  const planUsage = usage.cache;
  const admission = new Admission({ ctx, sessions, planUsage, tasks, projects, deferred: deferredStarts });
  const delivery = new MessageDelivery({ ctx, sessions, messages });
  const messaging = new Messaging({ ctx, projects, tasks, sessions, messages, delivery });
  // The network gate's egress operations are one registry of the protected adapter; another
  // adapter (PM-142's publishing) answers the operation ids that are not egress ones.
  const egress = new EgressService({ ctx, projects, timeline, settings: opts.egress });
  const boundary = new BoundaryService({
    ctx,
    projects,
    inbox,
    timeline,
    adapter: {
      resolve: (requester, operationId) =>
        egress.resolve(requester, operationId) ??
        opts.boundaryAdapter?.resolve(requester, operationId) ??
        null,
    },
    notify(request, recipients) {
      const config = projects.cachedConfig(request.projectKey);
      // Humans receive the localized inbox/timeline; this English message is an agent prompt.
      const agents = recipients.filter((h) => config && memberOf(config, h)?.kind === 'ai');
      if (!agents.length) return;
      background.run(
        () =>
          messaging
            .send(
              request.projectKey,
              'system',
              {
                to: agents,
                taskKey: request.taskKey,
                text: `Boundary request ${request.id}: ${request.state}. Operation: ${request.target.operation}; resource: ${request.target.resource}. Inspect with get_boundary_request. Delegated approvers use decide_boundary_request; owner exceptions require the owner's inbox decision.`,
              },
              { actor: SYSTEM_ACTOR },
            )
            .then(() => undefined),
        () => opts.logger.warn({ requestId: request.id }, 'boundary notification failed'),
      );
    },
  });
  egress.attach(boundary);
  // A member's tool question went to its AI decider: wake it like a boundary request's lead. The
  // sponsor and owners are not told; they hear of it only if it comes to them.
  events.on('permission_delegated', (item) => {
    const leads = permissionDelegationOf(item)?.leads ?? [];
    if (!leads.length) return;
    background.run(
      () =>
        messaging
          .send(
            item.projectKey,
            'system',
            { to: leads, taskKey: item.taskKey, text: delegatedPermissionPrompt(item) },
            { actor: SYSTEM_ACTOR },
          )
          .then(() => undefined),
      () => opts.logger.warn({ itemId: item.id }, 'permission decider notification failed'),
    );
  });
  const taskStarts = new TaskStarts({ projects, tasks, members, sessions, admission });
  const handOver = new StageHandOver({ projects, tasks, sessions, admission, delivery });
  const messageStarts = new MessageStarts({ projects, tasks, admission, messages, delivery });
  const schedules = new ScheduleService({
    ctx,
    projects,
    admission,
    timeline,
    timer: opts.scheduleTimer,
  });
  const githubSync = new GithubSync({ ctx, github: opts.github, tasks, projects });
  const publishing = new PublishingGate({
    ctx,
    projects,
    tasks,
    githubSync,
    publisher: opts.githubPublisher,
    memberWorkspaces: opts.memberWorkspaces,
  });
  const teamTools = new TeamToolsService({
    boundary,
    egress,
    publishing,
    ctx,
    projects,
    tasks,
    members,
    messaging,
    inbox,
    timeline,
    memory: opts.memory,
    github: opts.github,
    githubSync,
    attachments,
    attachmentDirectory,
  });
  // Read models and flows over the services above.
  const board = new BoardService({ projects, tasks, members, inbox, planUsage });
  const profiles = new MemberProfiles({ ctx, projects, members, tasks, inbox, sessions, admission });
  const invitations = new InvitationService({ ctx, projects, members, accounts: opts.accounts });

  const retryDeferredStarts = () =>
    background.run(
      () => admission.retryDeferred(),
      (err) => opts.logger.warn({ err }, 'deferred start retry failed'),
    );
  /** A deferred start as it was stored, made again by the module that made it. */
  const rebuildDeferredStart = (spec: StartSpec) =>
    spec.kind === 'hand_over' ? handOver.rebuild(spec) : messageStarts.rebuild(spec);

  // Configuration changes: runtime state follows the roster.
  events.on('config_changed', (change) => members.reconcile(change));
  events.on('config_changed', (change) => {
    if (!change.previous) return;
    const remaining = new Set(change.next.team.members.map((m) => m.handle));
    const removed = change.previous.team.members.map((m) => m.handle).filter((h) => !remaining.has(h));
    tasks.handOverTasks(change.projectKey, removed, change.actor, change.handovers);
  });
  events.on('config_changed', (change) => sessions.handleConfigChange(change));
  events.on('config_changed', () => boundary.sweep());
  events.on('config_changed', () => inbox.sweepDelegations());
  events.on('config_changed', (change) => egress.handleConfigChange(change));
  events.on('task_cancelled', () => boundary.sweep());
  // AI work switched back on: the deferred starts continue.
  events.on('config_changed', (change) => {
    if (change.previous?.team.limits.aiEnabled === false && change.next.team.limits.aiEnabled)
      retryDeferredStarts();
  });
  // A member called back from leave: the starts and messages that waited for it continue.
  events.on('config_changed', (change) => {
    const { previous, next } = change;
    if (previous?.team.members.some((m) => isOnLeave(m) && !isOnLeave(memberOf(next, m.handle))))
      retryDeferredStarts();
  });
  // New projects and provider changes get a probe without blocking the config response.
  events.on('config_changed', () => {
    setImmediate(() => usage.refresh()).unref();
  });
  // Human decisions.
  events.on('inbox_resolved', (item) =>
    item.kind === 'decision' ? tasks.handleDecisionResolved(item) : undefined,
  );
  events.on('inbox_resolved', (item) => (item.kind === 'question' ? messaging.answer(item) : undefined));
  // Cancelled tasks stop their sessions; moves and closures drop the starts they made obsolete.
  events.on('task_cancelled', (task) => sessions.stopTask(task.projectKey, task.key));
  events.on('task_cancelled', (task) => admission.discardStale(task));
  events.on('task_stage_changed', (change) => admission.discardStale(change.task));
  // A task entering a stage hands its work over anew: reviewers and testers get a new round.
  events.on('task_stage_changed', (change) => {
    if (change.task.status !== 'done') sessions.requestReviewRound(change.task.projectKey, change.task.key);
  });
  // Done tasks: temp workers leave; sessions stop and clean worktrees go away.
  events.on('task_stage_changed', (change) => taskStarts.retireFinishedTempWorker(change));
  // Later stages owned by AI members (review, QA, release, …) get their owner started, in the
  // background so a session start does not hold up the move.
  events.on('task_stage_changed', (change) => {
    background.run(
      () => handOver.handOff(change),
      (err) => opts.logger.warn({ err }, 'stage hand-over failed'),
    );
  });
  events.on('task_stage_changed', (change) => {
    if (change.task.status === 'done') sessions.scheduleDoneCleanup(change.task.projectKey, change.task.key);
  });
  // Labels that notify the assignee and @mentions reach members as team messages.
  events.on('task_labels_notice', (notice) => messaging.labelNotice(notice));
  events.on('task_note_added', (note) => messaging.mentionNotice(note));
  // A started session gets the messages waiting for it; waiting messages wake their recipient.
  events.on('session_started', (session) => delivery.deliverWaiting(session));
  events.on('session_input_released', (session) => delivery.deliverWaiting(session));
  events.on('message_waiting', ({ projectKey, handle, workItem, messageId }) => {
    background.run(
      () => messageStarts.wake(projectKey, handle, workItem),
      (err) =>
        opts.logger.info({ err, projectKey, member: handle, messageId }, 'team message session start failed'),
    );
  });

  let retryTimer: ReturnType<typeof setInterval> | undefined;
  let boundaryTimer: ReturnType<typeof setInterval> | undefined;

  return {
    ctx,
    bus,
    templates,
    timeline,
    projects,
    inbox,
    boundary,
    egress,
    runtimeBoundary: opts.runtimeBoundary ?? null,
    runnerModule,
    presence,
    messages,
    messaging,
    tasks,
    attachments,
    members,
    roles,
    sessions,
    planUsage,
    admission,
    taskStarts,
    handOver,
    messageStarts,
    schedules,
    githubSync,
    teamTools,
    board,
    profiles,
    invitations,

    /** Startup: import projects from the repository, clean up state that did not survive a restart, watch PRs. */
    async start(): Promise<void> {
      await projects.syncFromStore();
      sessions.reconcileAfterRestart();
      members.reconcileAfterRestart();
      inbox.expireOpenPermissions();
      await boundary.sweep();
      // Uploads and deletions the last run left half done (files and rows share no transaction).
      await attachments.recover();
      // A standby copy only shows its data: nothing below acts on the outside world or starts a session.
      if (opts.standby) {
        opts.logger.warn(
          'standby instance: no scheduler, GitHub polling or automatic starts; AI sessions are refused',
        );
        return;
      }
      githubSync.start();
      background.start();
      usage.start();
      schedules.start();
      // What admission refused before the server stopped waits again and is retried now, as usual
      // (under admission, and not while its master switch is off)...
      if (admission.restoreDeferred(rebuildDeferredStart) > 0) retryDeferredStarts();
      // ... and refused hand-overs and message wake-ups retry once admission allows them.
      retryTimer = setInterval(retryDeferredStarts, opts.handOffRetryMs ?? 30_000);
      retryTimer.unref();
      boundaryTimer = setInterval(
        () =>
          background.run(
            async () => {
              await boundary.sweep();
              await inbox.sweepDelegations();
            },
            () => opts.logger.warn('boundary deadline sweep failed'),
          ),
        1000,
      );
      boundaryTimer.unref();
    },

    async stop(): Promise<void> {
      usage.stop();
      if (retryTimer) clearInterval(retryTimer);
      if (boundaryTimer) clearInterval(boundaryTimer);
      const drained = schedules.stop();
      githubSync.stop();
      await background.stop();
      sessions.dispose();
      await drained;
    },

    /** The user's membership in a project, or null (unknown project or not a member). */
    async accessFor(projectKey: string, email: string): Promise<ProjectAccess | null> {
      if (!projects.has(projectKey)) return null;
      return projectAccessFor(await projects.config(projectKey), email);
    },

    async projectsFor(email: string): Promise<Me['projects']> {
      const memberships: Me['projects'] = [];
      for (const summary of projects.summaries()) {
        try {
          const access = projectAccessFor(await projects.config(summary.key), email);
          if (access)
            memberships.push({
              key: summary.key,
              name: summary.name,
              access: access.access,
              roles: access.member.roles,
            });
        } catch (err) {
          opts.logger.warn({ err, projectKey: summary.key }, 'could not load project configuration');
        }
      }
      return memberships;
    },

    /** Member handle of the user per project key. */
    async handlesFor(email: string): Promise<Record<string, string>> {
      const handles: Record<string, string> = {};
      for (const summary of projects.summaries()) {
        try {
          const access = projectAccessFor(await projects.config(summary.key), email);
          if (access) handles[summary.key] = access.handle;
        } catch (err) {
          opts.logger.warn({ err, projectKey: summary.key }, 'could not load project configuration');
        }
      }
      return handles;
    },
  };
}
