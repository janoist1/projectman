import type { Me } from '@projectman/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { AuthService } from '../auth';
import type {
  ConfigStore,
  ContextPackBuilder,
  EventBus,
  GithubService,
  MemberMemoryStore,
  PermissionBroker,
  RunnerModule,
  WorktreeManager,
} from '../contracts';
import type { Repositories } from '../db';
import { projectAccessFor } from './access';
import type { ProjectAccess } from './access';
import { Admission, DeferredStarts, MessageStarts, StageHandOver, TaskStarts } from './admission';
import type { StartSpec } from './admission';
import { BackgroundTasks } from './background';
import { BoardService } from './board';
import { createDomainContext, defaultTemplateRegistry } from './context';
import type { DomainContext, TemplateRegistry } from './context';
import { createEventBus } from './event-bus';
import { GithubSync } from './github-sync';
import { InboxService } from './inbox';
import { InvitationService } from './invitations';
import { MemberProfiles, MemberService } from './members';
import { MessageDelivery, MessageService, Messaging } from './messaging';
import { PlanUsageMonitor } from './plan-usage';
import { PresenceService } from './presence';
import { ProjectService } from './projects';
import { RoleService } from './roles';
import { ScheduleService } from './schedules';
import type { ScheduleTimer } from './schedules';
import { SessionOrchestrator } from './sessions';
import { TaskService } from './tasks';
import { TeamToolsService } from './team-tools';
import { TimelineService } from './timeline';

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
export { BackgroundTasks } from './background';
export { BoardService } from './board';
export { GithubSync } from './github-sync';
export { InboxService, PERMISSION_OPTIONS, DECISION_OPTIONS, ANSWER_OPTION } from './inbox';
export { InvitationService } from './invitations';
export { MemberProfiles, MemberService } from './members';
export { MessageDelivery, MessageService, Messaging, routeFor } from './messaging';
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
  repos: Repositories;
  configStore: ConfigStore;
  logger: FastifyBaseLogger;
  /** Base URL the claude CLI reaches this server at (MCP endpoint), e.g. http://127.0.0.1:4700. */
  publicBaseUrl: string;
  /** Creates the runner module once the permission broker (the inbox) exists. */
  createRunner: (broker: PermissionBroker) => RunnerModule;
  github: GithubService;
  contextBuilder: ContextPackBuilder;
  memory: MemberMemoryStore;
  worktrees: WorktreeManager;
  /** Creates the accounts of accepted invitations. */
  accounts: Pick<AuthService, 'prepareUser'>;
  /** Root used to constrain automatic lockfile installs; unset means no install auto-approval. */
  worktreesRootDir?: string;
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
  const inbox = new InboxService({ ctx, timeline, projects, worktreesRootDir: opts.worktreesRootDir });
  const runnerModule = opts.createRunner(inbox.broker);
  const presence = new PresenceService();
  // The deferred automatic starts live in SQLite too: a restart loads them back (see `start`).
  const deferredStarts = new DeferredStarts(opts.repos.deferredStarts);
  const messages = new MessageService({ ctx, timeline });
  const tasks = new TaskService({ ctx, timeline, projects, inbox, startWaiting: deferredStarts });
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
  const teamTools = new TeamToolsService({
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
  // AI work switched back on: the deferred starts continue.
  events.on('config_changed', (change) => {
    if (change.previous?.team.limits.aiEnabled === false && change.next.team.limits.aiEnabled)
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
  events.on('message_waiting', ({ projectKey, handle, workItem, messageId }) => {
    background.run(
      () => messageStarts.wake(projectKey, handle, workItem),
      (err) =>
        opts.logger.info({ err, projectKey, member: handle, messageId }, 'team message session start failed'),
    );
  });

  let retryTimer: ReturnType<typeof setInterval> | undefined;

  return {
    ctx,
    bus,
    templates,
    timeline,
    projects,
    inbox,
    runnerModule,
    presence,
    messages,
    messaging,
    tasks,
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
    },

    async stop(): Promise<void> {
      usage.stop();
      if (retryTimer) clearInterval(retryTimer);
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
