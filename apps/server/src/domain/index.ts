import { DEFAULT_AGENT_PROVIDER, type AgentProvider, type Me } from '@projectman/shared';
import type { FastifyBaseLogger } from 'fastify';
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
import { createDomainContext, defaultTemplateRegistry } from './context';
import type { DomainContext, TemplateRegistry } from './context';
import { createEventBus } from './event-bus';
import { GithubSync } from './github-sync';
import { InboxService } from './inbox';
import { MemberService } from './members';
import { MessageService } from './messages';
import { PlanUsageCache } from './plan-usage';
import { PresenceService } from './presence';
import { ProjectService } from './projects';
import { RoleService } from './roles';
import { ScheduleService } from './schedules';
import type { ScheduleTimer } from './schedules';
import { Scheduler } from './scheduler';
import { SessionOrchestrator } from './sessions';
import { TaskService } from './tasks';
import { TeamToolsService } from './team-tools';
import { TimelineService } from './timeline';

export * from './access';
export * from './context';
export * from './errors';
export { createEventBus } from './event-bus';
export { GithubSync } from './github-sync';
export {
  InboxService,
  PERMISSION_OPTIONS,
  DECISION_OPTIONS,
  ANSWER_OPTION,
  summarizeToolInput,
} from './inbox';
export { MemberService } from './members';
export { MessageService } from './messages';
export { RoleService, roleUsage, roleViews } from './roles';
export { defaultMemberHandle, defaultMemberName } from './naming';
export { PlanUsageCache, highestUsagePercent } from './plan-usage';
export { PresenceService } from './presence';
export { ProjectService, OWNER_HANDLE } from './projects';
export type { Author, LoadedProject, ConfigChange } from './projects';
export { ScheduleService } from './schedules';
export type { ScheduleTimer } from './schedules';
export { Scheduler } from './scheduler';
export type { StartTaskOptions, StartTaskResult } from './scheduler';
export * from './session-policy';
export { SessionOrchestrator, BUSY_SESSION_STATES, LIVE_SESSION_STATES } from './sessions';
export { TaskService, isOpenTask } from './tasks';
export type { MoveResult, TaskUpdate } from './tasks';
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

/** Builds every domain service and wires their listeners. */
export function createDomain(opts: DomainOptions) {
  const now = opts.now ?? (() => new Date());
  const bus = opts.bus ?? createEventBus(opts.logger);
  const ctx: DomainContext = createDomainContext({ repos: opts.repos, bus, logger: opts.logger, now });
  const templates = opts.templates ?? defaultTemplateRegistry;

  const timeline = new TimelineService(ctx);
  const projects = new ProjectService({ ctx, configStore: opts.configStore, templates, timeline });
  const inbox = new InboxService({ ctx, timeline, projects, worktreesRootDir: opts.worktreesRootDir });
  const runnerModule = opts.createRunner(inbox.broker);
  const presence = new PresenceService();
  const messages = new MessageService({ ctx, timeline });
  const tasks = new TaskService({ ctx, timeline, projects, inbox });
  const members = new MemberService({ ctx, projects, timeline, presence, tasks, inbox });
  const roles = new RoleService({ projects });
  const sessions = new SessionOrchestrator({
    ctx,
    projects,
    tasks,
    members,
    messages,
    timeline,
    runner: runnerModule.runner,
    transcripts: runnerModule.transcripts,
    contextBuilder: opts.contextBuilder,
    memory: opts.memory,
    worktrees: opts.worktrees,
    publicBaseUrl: opts.publicBaseUrl,
    doneCleanupDelayMs: opts.doneCleanupDelayMs,
  });
  // A label that notifies the assignee (e.g. "QA: failed") reaches them as a team message.
  tasks.onLabelNotify(async (task, labels, actor, comment) => {
    const config = await projects.config(task.projectKey);
    const names = labels.map((id) => config.pipeline.labels.find((l) => l.id === id)?.name ?? id);
    await sessions.sendTeamMessage(
      task.projectKey,
      actor.handle!,
      {
        to: [task.assignee!],
        text: [names.join(', '), comment].filter(Boolean).join('\n\n'),
        taskKey: task.key,
      },
      actor,
    );
  });
  tasks.onNoteAdded(async (event, mentions) => {
    await sessions.sendTeamMessage(
      event.projectKey,
      event.actor.handle!,
      {
        to: mentions,
        text: event.data.text as string,
        taskKey: event.taskKey!,
      },
      event.actor,
      event.sessionId,
    );
  });
  const planUsage = new PlanUsageCache({
    provider: runnerModule.planUsage,
    providerFor: (provider) => runnerModule.planUsageFor?.(provider),
    logger: opts.logger,
    now,
    ttlMs: opts.planUsageTtlMs,
    onFetched: async (provider, usage) => {
      for (const project of projects.summaries()) {
        const config = await projects.config(project.key);
        if (
          config.team.members.some(
            (m) => m.kind === 'ai' && (m.provider ?? DEFAULT_AGENT_PROVIDER) === provider,
          )
        ) {
          bus.publish({ type: 'plan_usage', projectKey: project.key, provider, usage });
        }
      }
    },
  });
  const scheduler = new Scheduler({ ctx, projects, tasks, members, sessions, planUsage });
  const schedules = new ScheduleService({
    ctx,
    projects,
    scheduler,
    sessions,
    timeline,
    timer: opts.scheduleTimer,
  });
  const githubSync = new GithubSync({ ctx, github: opts.github, tasks, projects });
  const teamTools = new TeamToolsService({
    ctx,
    projects,
    tasks,
    members,
    sessions,
    messages,
    inbox,
    timeline,
    memory: opts.memory,
    github: opts.github,
    githubSync,
  });

  // Configuration changes: runtime state follows the roster.
  projects.onConfigChanged((change) => members.reconcile(change));
  projects.onConfigChanged((change) => {
    if (!change.previous) return;
    const remaining = new Set(change.next.team.members.map((m) => m.handle));
    const removed = change.previous.team.members.map((m) => m.handle).filter((h) => !remaining.has(h));
    tasks.handOverTasks(change.projectKey, removed, change.actor, change.handovers);
  });
  projects.onConfigChanged((change) => sessions.handleConfigChange(change));
  // Human decisions.
  inbox.onResolved('decision', (item) => tasks.handleDecisionResolved(item));
  inbox.onResolved('question', (item) => teamTools.deliverAnswer(item));
  tasks.onCancelled((task) => sessions.stopTask(task.projectKey, task.key));
  tasks.onCancelled(async (task) => scheduler.discardStaleTaskStarts(task));
  tasks.onStageChanged((change) => scheduler.discardStaleTaskStarts(change.task));
  // Done tasks: temp workers leave; sessions stop and clean worktrees go away.
  tasks.onStageChanged((change) => scheduler.retireFinishedTempWorker(change));
  // Human and AI messages wake idle recipients through admission; stop() drains pending starts.
  const messageStarts = new Set<Promise<void>>();
  sessions.onMessageNeedsSession((projectKey, handle, workItem, messageId) => {
    if (stopped) return;
    const start = scheduler
      .startQueuedMessageSession(projectKey, handle, workItem)
      .catch((err: unknown) =>
        opts.logger.info({ err, projectKey, member: handle, messageId }, 'team message session start failed'),
      )
      .finally(() => messageStarts.delete(start));
    messageStarts.add(start);
  });
  // Later stages owned by AI members (review, QA, release, …) get their owner started, in the
  // background so a session start does not hold up the move; stop() waits for pending ones.
  const handOffs = new Set<Promise<void>>();
  const trackHandOff = (work: () => Promise<void>) => {
    if (stopped) return;
    const handOff = work()
      .catch((err: unknown) => opts.logger.warn({ err }, 'stage hand-over failed'))
      .finally(() => handOffs.delete(handOff));
    handOffs.add(handOff);
  };
  tasks.onStageChanged((change) => trackHandOff(() => scheduler.handOffToStageOwner(change)));
  projects.onConfigChanged((change) => {
    if (change.previous?.team.limits.aiEnabled === false && change.next.team.limits.aiEnabled)
      trackHandOff(() => scheduler.retryDeferredStarts());
  });
  let handOffTimer: ReturnType<typeof setInterval> | undefined;
  tasks.onStageChanged((change) => {
    if (change.task.status === 'done') sessions.scheduleDoneCleanup(change.task.projectKey, change.task.key);
  });

  let stopped = false;
  let usageRefresh: Promise<void> | undefined;
  const refreshUsage = async () => {
    const providers = new Set<AgentProvider>();
    for (const project of projects.summaries()) {
      const config = await projects.config(project.key);
      for (const member of config.team.members) {
        if (member.kind === 'ai') providers.add(member.provider ?? DEFAULT_AGENT_PROVIDER);
      }
    }
    await Promise.all([...providers].map((provider) => planUsage.get(provider)));
  };
  const refreshUsageInBackground = () => {
    if (stopped || usageRefresh) return;
    usageRefresh = refreshUsage()
      .catch((err: unknown) => opts.logger.warn({ err }, 'plan usage refresh failed'))
      .finally(() => {
        usageRefresh = undefined;
      });
  };
  // New projects and provider changes get a probe without blocking the config response.
  projects.onConfigChanged(() => {
    setImmediate(refreshUsageInBackground).unref();
  });
  let usageTimer: ReturnType<typeof setInterval> | undefined;

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
    tasks,
    members,
    roles,
    sessions,
    planUsage,
    scheduler,
    schedules,
    githubSync,
    teamTools,

    /** Startup: import projects from the repository, clean up state that did not survive a restart, watch PRs. */
    async start(): Promise<void> {
      await projects.syncFromStore();
      sessions.reconcileAfterRestart();
      inbox.expireOpenPermissions();
      githubSync.start();
      stopped = false;
      refreshUsageInBackground();
      usageTimer = setInterval(
        refreshUsageInBackground,
        opts.planUsageTtlMs && opts.planUsageTtlMs > 0 ? opts.planUsageTtlMs : 60_000,
      );
      usageTimer.unref();
      schedules.start();
      // Refused hand-overs and message starts retry once capacity or plan usage allows.
      handOffTimer = setInterval(
        () => trackHandOff(() => scheduler.retryDeferredStarts()),
        opts.handOffRetryMs ?? 30_000,
      );
      handOffTimer.unref();
    },

    async stop(): Promise<void> {
      stopped = true;
      if (usageTimer) clearInterval(usageTimer);
      if (handOffTimer) clearInterval(handOffTimer);
      const drained = schedules.stop();
      githubSync.stop();
      await Promise.allSettled([...handOffs, ...messageStarts]);
      sessions.dispose();
      await drained;
      await usageRefresh;
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
