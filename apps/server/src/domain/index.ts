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
import { defaultTemplateRegistry } from './context';
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
export * from './gates';
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
export { ProjectService, DEFAULT_PROJECT_LANGUAGE, OWNER_HANDLE } from './projects';
export type { Author, LoadedProject, ConfigChange } from './projects';
export { ScheduleService } from './schedules';
export type { ScheduleTimer } from './schedules';
export { Scheduler } from './scheduler';
export type { StartTaskOptions, StartTaskResult } from './scheduler';
export * from './session-policy';
export { SessionOrchestrator, BUSY_SESSION_STATES, LIVE_SESSION_STATES } from './sessions';
export { TaskService, isOpenTask, gatePayload } from './tasks';
export type { MoveResult, GateRequestPayload } from './tasks';
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
  templates?: TemplateRegistry;
  bus?: EventBus;
  now?: () => Date;
  planUsageTtlMs?: number;
  scheduleTimer?: ScheduleTimer;
  /** Delay before a done task's sessions stop and its worktrees are removed (default 2 s). */
  doneCleanupDelayMs?: number;
}

export type Domain = ReturnType<typeof createDomain>;

/** Builds every domain service and wires their listeners. */
export function createDomain(opts: DomainOptions) {
  const now = opts.now ?? (() => new Date());
  const bus = opts.bus ?? createEventBus(opts.logger);
  const ctx: DomainContext = { repos: opts.repos, bus, logger: opts.logger, now };
  const templates = opts.templates ?? defaultTemplateRegistry;

  const timeline = new TimelineService(ctx);
  const projects = new ProjectService({ ctx, configStore: opts.configStore, templates, timeline });
  const inbox = new InboxService({ ctx, timeline, projects });
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
    tasks.unassignMembers(change.projectKey, removed, change.actor);
  });
  projects.onConfigChanged((change) => sessions.handleConfigChange(change));
  // Human decisions.
  inbox.onResolved('decision', (item) => tasks.handleDecisionResolved(item));
  inbox.onResolved('question', (item) => teamTools.deliverAnswer(item));
  tasks.onCancelled((task) => sessions.stopTask(task.projectKey, task.key));
  // Done tasks: temp workers leave; sessions stop and clean worktrees go away.
  tasks.onStageChanged((change) => scheduler.retireFinishedTempWorker(change));
  tasks.onStageChanged((change) => {
    if (change.task.status === 'done') sessions.scheduleDoneCleanup(change.task.projectKey, change.task.key);
  });

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
      usageTimer = setInterval(
        () => {
          void refreshUsage().catch((err: unknown) => opts.logger.warn({ err }, 'plan usage refresh failed'));
        },
        opts.planUsageTtlMs && opts.planUsageTtlMs > 0 ? opts.planUsageTtlMs : 60_000,
      );
      usageTimer.unref();
      schedules.start();
    },

    stop(): Promise<void> {
      if (usageTimer) clearInterval(usageTimer);
      const drained = schedules.stop();
      githubSync.stop();
      sessions.dispose();
      return drained;
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
