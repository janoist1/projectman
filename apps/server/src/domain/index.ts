import {
  canManageInstancePause,
  isOnLeave,
  isOpenTask,
  isSenior,
  isTheme,
  LOCAL_ENGINE_ID,
  memberOf,
  permissionDelegationOf,
  routeFor,
  seniorWaitMinutesOf,
  stageOf,
} from '@projectman/shared';
export { EngineRegistry, machineKeyHash, newMachineKey } from './engine-registry';
export type { EngineCounters, EngineHelloMetadata } from './engine-registry';
import path from 'node:path';
import type { EngineId, ExecutionProfile, Me, Session, Task } from '@projectman/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { AuthService } from '../auth';
import type { EngineCounters } from './engine-registry';
import type {
  AttachmentStorage,
  BoundaryOperationAdapter,
  ConfigStore,
  ContextPackBuilder,
  EngineAttachments,
  EngineDirectory,
  EventBus,
  FullTestExecutor,
  ScreenshotExecutor,
  GithubPublisher,
  GithubService,
  MachineProbe,
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
import {
  Admission,
  DeferredStarts,
  MessageStarts,
  RefinementSteps,
  SeniorWaits,
  StageHandOver,
  TaskStarts,
  WorkStarts,
} from './admission';
import type { StartSpec } from './admission';
import { AttachmentService } from './attachments';
import { BackgroundTasks } from './background';
import { BoardService } from './board';
import { ProjectManagerChannels } from './project-manager';
import { PmReplyRelay } from './pm-reply-relay';
import { BoundaryService } from './boundary';
import { CardQuestions } from './card-questions';
import { createDomainContext, defaultTemplateRegistry } from './context';
import type { DomainContext, TemplateRegistry } from './context';
import { createEventBus } from './event-bus';
import { GithubSync } from './github-sync';
import { InboxService, delegatedPermissionPrompt } from './inbox';
import { FixLimitWatch } from './fix-limit';
import { FullTestRuns } from './full-tests';
import { LoopWatch } from './loop-watch';
import { OpenQuestionLabel } from './open-question-label';
import { InvitationService } from './invitations';
import { MemberProfiles, MemberService } from './members';
import { MessageDelivery, MessageService, Messaging, RelationNotices } from './messaging';
import { PlanUsageMonitor } from './plan-usage';
import { PresenceService } from './presence';
import { OWNER_HANDLE, ProjectService } from './projects';
import { PublishingGate } from './publishing';
import { ReviewWatch } from './review-watch';
import { RoleService } from './roles';
import { ScheduleService } from './schedules';
import type { ScheduleTimer } from './schedules';
import { HandoffService } from './handoffs';
import { PauseService } from './pause';
import { MachineMonitor } from './machine';
import { createMachineProbe } from '../machine';
import { createLocalEngine, LocalEngineDirectory } from './engines';
import { conflict } from './errors';
import { SessionCloser } from './session-closer';
import { SessionOrchestrator } from './sessions';
import { ScreenshotRuns } from './screenshot-runs';
import { AutoAdvance, PrerequisiteClosures, TaskService } from './tasks';
import { TeamToolsService } from './team-tools';
import { TimelineService } from './timeline';
import { InvolvementService } from './involvements';
import { ProjectFocusService } from './project-focus';
import { AgentQuestions } from './agent-question';
import { InputStallAlerts } from './input-stall-alert';
import { UsageAlerts } from './usage-alerts';
import { DiskGuard } from './disk-guard';
import { WorktreeSweep } from './worktree-sweep';
import { CardMeasure } from './card-measure';
import { SYSTEM_ACTOR } from './util';
import { SYSTEM_SENDER } from '@projectman/shared';

export * from './access';
export * from './context';
export * from './errors';
export { createEventBus } from './event-bus';
export { createDomainEvents } from './events';
export type { DomainEventMap, DomainEvents } from './events';
export {
  Admission,
  DeferredStarts,
  MessageStarts,
  RefinementSteps,
  SeniorWaits,
  StageHandOver,
  TaskStarts,
  WorkStarts,
} from './admission';
export type {
  AdmissionRequest,
  AutomaticStart,
  DeferredStart,
  DeferredStartStore,
  StartSpec,
  StartTaskOptions,
  StartTaskResult,
} from './admission';
export { AttachmentService, contentDisposition, createAttachmentStorage } from './attachments';
export { BackgroundTasks } from './background';
export { BoardService } from './board';
export { BoundaryService } from './boundary';
export { CardQuestions, QUESTION_LIMIT } from './card-questions';
export { EgressService } from './egress';
export type { EgressDecision, EgressIdentity, EgressSession, EgressSettings } from './egress';
export { GithubSync } from './github-sync';
export { InboxService, PERMISSION_OPTIONS, DECISION_OPTIONS, ANSWER_OPTION } from './inbox';
export { CardMeasure } from './card-measure';
export { FixLimitWatch } from './fix-limit';
export { FullTestRuns } from './full-tests';
export { InvitationService } from './invitations';
export { MemberProfiles, MemberService } from './members';
export { MessageDelivery, MessageService, Messaging } from './messaging';
export { RoleService, roleUsage, roleViews } from './roles';
export { defaultMemberHandle, defaultMemberName } from './naming';
export { HandoffService } from './handoffs';
export { PauseService } from './pause';
export { MachineMonitor } from './machine';
export type { PauseOptions, PauseRequester, PauseTarget } from './pause';
export { PlanUsageCache, PlanUsageMonitor, highestUsagePercent } from './plan-usage';
export { PresenceService } from './presence';
export { ProjectService, OWNER_HANDLE } from './projects';
export type { Author, LoadedProject, ConfigChange } from './projects';
export { DiskGuard } from './disk-guard';
export { CLOSED_WORKTREE_KEEP_MS, WorktreeSweep } from './worktree-sweep';
export type { WorktreeSweepReport } from './worktree-sweep';
export { ScheduleService } from './schedules';
export type { ScheduleTimer } from './schedules';
export * from './session-policy';
export {
  describeSandbox,
  describeSessionFolder,
  describeSessionTmpDir,
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
export { ProjectFocusService } from './project-focus';
export { SYSTEM_ACTOR, SYSTEM_AUTHOR, humanActor, aiActor } from './util';

import { ProviderKeys } from './provider-keys';
export { ProviderKeys } from './provider-keys';
export type { NanogptKeyCheck } from './provider-keys';
export { createNanogptKeyCheck } from './nanogpt-key-check';

export interface DomainOptions {
  nanogptKeyCheck?: import('./provider-keys').NanogptKeyCheck;
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
  createRunner: (broker: PermissionBroker, nanogptKey?: () => Promise<string | null>) => RunnerModule;
  github: GithubService;
  /**
   * The VM's GitHub publishing identity (PM-142): without it `publish_task_branch` refuses. It is
   * separate from `github`, which only reads, so the poller never holds write rights.
   */
  githubPublisher?: GithubPublisher;
  contextBuilder: ContextPackBuilder;
  memory: MemberMemoryStore;
  worktrees: WorktreeManager;
  /**
   * The machines the sessions run on (PM-311). Absent: the one this server runs on, `local`, built from
   * the options below (`worktrees`, `memberWorkspaces`, the directories, the executors).
   */
  engines?: EngineDirectory;
  /** The attachments' way to a remote engine (PM-315, cloud mode); absent: the sessions read the stored files. */
  engineAttachments?: EngineAttachments;
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
  /** The user's home (default `os.homedir()`); a developer's sandbox reads nothing below it but its own (PM-153). */
  userHome?: string;
  /** Where member workspaces live: a developer's routine steps there run without asking, as in a worktree. */
  workspacesRootDir?: string;
  /**
   * The checkout the server runs from (`~/projectman-live` for the owner's live instance): reading
   * sessions never change it (PM-188).
   */
  installDir?: string;
  /**
   * The root of the session folders (PM-268): each Claude session gets its own writable folder below
   * it. Checked here (`prepareSessionFoldersRoot`); one that is not safe, or the managed VM, turns
   * the folders off. Absent: no folders.
   */
  sessionFoldersDir?: string;
  /**
   * The root of the Codex sessions' own temporary directories (PM-339), a short path (a Unix
   * socket's is 104 bytes at most): each gets one below it, the TMPDIR of its commands, removed with
   * its folder. Checked here (`prepareSessionTmpRoot`). Absent or unsafe: Codex gets no folder.
   */
  sessionTmpDir?: string;
  /**
   * The base of Claude Code's temporary root when the server's environment sets `CLAUDE_CODE_TMPDIR`
   * (PM-353); the root every Claude Code process of the user shares is `<base>/claude-<uid>`, else
   * `/tmp/claude-<uid>`. Closed to the members' commands and to the server's full test.
   */
  claudeTmpBase?: string;
  /**
   * The shared roots themselves, instead of the ones computed from this machine and `claudeTmpBase`.
   * For tests, whose own directories may lie below the host's Claude Code root.
   */
  claudeTmpRoots?: readonly string[];
  /** Playwright's browsers (PM-268): read-only for Claude sessions, in `PLAYWRIGHT_BROWSERS_PATH`. */
  browsersDir?: string;
  /** The machine's heavy-run queue folder (PM-332): its parent is writable for the members' commands. */
  heavyLockDir?: string;
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
  /** How long a session may wait for input before the owners are told (PM-199; default 10 minutes). */
  inputStallMs?: number;
  templates?: TemplateRegistry;
  bus?: EventBus;
  now?: () => Date;
  planUsageTtlMs?: number;
  scheduleTimer?: ScheduleTimer;
  /** Delay before a done task's sessions stop and its worktrees are removed (default 2 s). */
  doneCleanupDelayMs?: number;
  /** How long the session that moved a task to done may take to finish its turn (default 10 min). */
  doneTurnLimitMs?: number;
  /** How often refused automatic session starts are retried (default 30 s). */
  handOffRetryMs?: number;
  /** How often the branch of a task in review is compared with its pinned commit (default 30 s). */
  reviewWatchMs?: number;
  /**
   * Runs the server's full test of a pinned commit before review (PM-217) in its own sandbox. Absent
   * (tests, the managed VM, a platform without the sandbox), the feature is off.
   */
  fullTestExecutor?: FullTestExecutor;
  /**
   * Runs `npm run shots` for a member whose own sandbox cannot start the browser (Codex, PM-351) in the
   * server's sandbox. Absent, `take_screenshots` is refused.
   */
  screenshotExecutor?: ScreenshotExecutor;
  /** How often the open loops of cards are looked at for an end (default 60 s, PM-261). */
  loopWatchMs?: number;
  /** How often the cards that wait for the Senior are looked at for the wait limit (default 60 s, PM-348). */
  seniorWaitMs?: number;
  /**
   * The free bytes of the disk the installation's data is on (PM-243); null: not measurable. Without
   * it nothing is measured, so no start is refused for disk space.
   */
  freeDiskBytes?: () => Promise<number | null>;
  /** How often the free disk space is checked (default 1 min). */
  diskCheckMs?: number;
  /** How often the worktrees of closed cards are swept, starting at startup (default 6 hours). */
  worktreeSweepMs?: number;
  /** How long a closed card's worktree stays (default `CLOSED_WORKTREE_KEEP_MS`, 3 days). */
  closedWorktreeKeepMs?: number;
  /** How often the idle sessions are looked at for a close (default 1 min, PM-295). */
  idleCloseSweepMs?: number;
  /** How often the open assignee handoffs are looked at for a late note (default 15 s, PM-342). */
  handoffSweepMs?: number;
  /**
   * Makes what the machine display measures with (PM-320); default: the operating system's
   * (`createMachineProbe`). It gets the pids of the running sessions' CLIs, for the fixed-data probe
   * of the screenshot mode.
   */
  machineProbe?: (deps: { runningPids: () => number[] }) => MachineProbe;
  /**
   * Cloud mode (PM-315): the machine shown is the default engine's. `identity` is the engine's own process
   * (from its `hello`), `available` whether there is an engine to show; without one the display is refused.
   */
  machineEngine?: {
    identity(): { pid: number; uid: number | null; instanceTag?: string } | null;
    available(): boolean;
  };
  /**
   * The tag of this instance (PM-320), set in the environment of every session the runner starts:
   * only a process that carries it can be an orphan of this instance. Absent: none is recognised.
   */
  instanceTag?: string;
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
  const providerKeys = opts.appHome
    ? new ProviderKeys({
        home: opts.appHome,
        now,
        logger: opts.logger,
        check: opts.nanogptKeyCheck ?? (async () => 'unknown'),
      })
    : null;

  const timeline = new TimelineService(ctx);
  const involvements = new InvolvementService(ctx);
  const projects = new ProjectService({
    ctx,
    configStore: opts.configStore,
    templates,
    timeline,
    // The new project's work runs on the engine its owner's sessions get (`engines` is built below,
    // from this service's cached configurations, so it is looked up when asked).
    isDirectory: async (projectKey, path) => {
      const engineId = engines.engineFor(projectKey, OWNER_HANDLE);
      const engine = engineId ? engines.get(engineId) : null;
      // The folder can only be checked where it is: no engine to ask is a refusal, not "not a folder" (PM-315).
      if (!engine) throw conflict('engine_offline', 'The engine the project would run on is not connected');
      return engine.isDirectory(path);
    },
  });
  // A session on a remote engine reads a card's attachments from that engine's cache (PM-315).
  const attachmentDirectory = (projectKey: string, taskKey: string) =>
    opts.engineAttachments
      ? opts.engineAttachments.directory(projectKey, taskKey)
      : opts.attachmentStorage.taskDirectory(projectKey, taskKey);
  // The machines the sessions can run on (PM-311): without a given directory, the one this server runs
  // on, built from the options below (a single-machine installation behaves as before).
  const engines: EngineDirectory =
    opts.engines ??
    new LocalEngineDirectory(
      createLocalEngine(
        {
          worktrees: opts.worktrees,
          memberWorkspaces: opts.memberWorkspaces,
          fullTestExecutor: opts.fullTestExecutor,
          screenshotExecutor: opts.screenshotExecutor,
          freeDiskBytes: opts.freeDiskBytes,
          processExists: opts.processExists,
          workspacePath: (projectKey) => projects.cachedConfig(projectKey)?.project.workspacePath ?? null,
          repoPath: (projectKey, repoName) => {
            const project = projects.cachedConfig(projectKey)?.project;
            const repo = project?.repos.find((entry) => entry.name === repoName);
            return project && repo ? path.resolve(project.workspacePath, repo.path) : null;
          },
          runtimeBoundary: opts.runtimeBoundary,
          appHome: opts.appHome,
          userHome: opts.userHome,
          worktreesRootDir: opts.worktreesRootDir,
          workspacesRootDir: opts.workspacesRootDir,
          installDir: opts.installDir,
          sessionFoldersDir: opts.sessionFoldersDir,
          sessionTmpDir: opts.sessionTmpDir,
          claudeTmpBase: opts.claudeTmpBase,
          claudeTmpRoots: opts.claudeTmpRoots,
          browsersDir: opts.browsersDir,
          heavyLockDir: opts.heavyLockDir,
        },
        opts.logger,
      ),
    );
  const inbox = new InboxService({ ctx, timeline, projects, engines, attachmentDirectory });
  // `agentQuestions` is built once the team tools exist; the callback only runs during a session.
  const runnerModule = opts.createRunner(
    {
      ...inbox.broker,
      forwardQuestion: ({ sessionId, toolName, toolInput }) =>
        agentQuestions.forward(sessionId, toolName, toolInput),
    },
    () => providerKeys?.nanogptKey() ?? Promise.resolve(null),
  );
  const presence = new PresenceService();
  // The deferred automatic starts live in SQLite too: a restart loads them back (see `start`).
  const deferredStarts = new DeferredStarts(opts.repos.deferredStarts);
  const messages = new MessageService({ ctx, timeline, projects });
  const tasks = new TaskService({
    ctx,
    timeline,
    projects,
    inbox,
    startWaiting: deferredStarts,
    // `sessions` is built below; the callback only runs when a task is handed over for review.
    sourceHead: (config, task) => sessions.sourceHead(config, task),
    notifyHandOn: async (config, task, request) => {
      const from = config.pipeline.stages.find((s) => s.id === request.fromStageId);
      const to = config.pipeline.stages.find((s) => s.id === request.toStageId);
      await messaging.send(
        task.projectKey,
        SYSTEM_SENDER,
        {
          to: [request.mover],
          taskKey: task.key,
          text: `${request.requestedBy} finished ${from?.name ?? request.fromStageId} on ${task.key}. In this project you move cards on: check the card with get_task and move it to ${to?.name ?? request.toStageId} with update_task (stage_id ${request.toStageId}), or tell ${request.requestedBy} what is missing.`,
        },
        { kind: 'action' },
      );
    },
    // `fixLimit` is built below; the callback only runs when a task is read.
    fixLimit: (task) => fixLimit.view(task),
    // `handoffs` is built below; the callback only runs when a card changes its assignee.
    handoff: (input) => handoffs.begin(input),
  });
  const projectFocus = new ProjectFocusService({ ctx, projects, tasks, timeline });
  const attachments = new AttachmentService({
    ctx,
    projects,
    tasks,
    timeline,
    storage: opts.attachmentStorage,
  });
  const members = new MemberService({ ctx, projects, timeline, presence, inbox });
  const cardQuestions = new CardQuestions({ ctx });
  const roles = new RoleService({ projects });
  const sessions = new SessionOrchestrator({
    inbox,
    ctx,
    projects,
    tasks,
    projectFocus,
    members,
    timeline,
    runner: runnerModule.runner,
    transcripts: runnerModule.transcripts,
    contextBuilder: opts.contextBuilder,
    cardQuestions,
    memory: opts.memory,
    engines,
    publicBaseUrl: opts.publicBaseUrl,
    doneCleanupDelayMs: opts.doneCleanupDelayMs,
    doneTurnLimitMs: opts.doneTurnLimitMs,
    attachments,
    attachmentDirectory,
    runtimeBoundary: opts.runtimeBoundary,
    executionProfile: opts.executionProfile,
    managedVm: opts.managedVm,
    standby: opts.standby,
    // `boundary` is built below; the callback only runs when a session starts.
    onExecutionProfileChange: (projectKey, sessionId) => boundary.invalidateSession(projectKey, sessionId),
    usageAlerts: new UsageAlerts({ ctx, projects, inbox }),
    inputStall: new InputStallAlerts({ ctx, projects, inbox }),
    inputStallMs: opts.inputStallMs,
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
    onFetched: (provider, value) => sessions.observeProviderUsage(provider, value),
  });
  const planUsage = usage.cache;
  const disk = new DiskGuard({ ctx, projects, inbox, engines });
  const worktreeSweep = new WorktreeSweep({
    ctx,
    projects,
    inbox,
    sessions,
    engines,
    disk,
    keepMs: opts.closedWorktreeKeepMs,
  });
  const admission = new Admission({
    ctx,
    sessions,
    planUsage,
    tasks,
    projects,
    deferred: deferredStarts,
    disk,
    engines,
  });
  const delivery = new MessageDelivery({ ctx, sessions, messages, projects });
  const pmReplyRelay = new PmReplyRelay({ ctx, sessions, messages, projects, background });
  events.on('session_idle', (session) => pmReplyRelay.finish(session));
  events.on('session_ended', (session) => pmReplyRelay.finish(session));
  providerKeys?.onChange(() => {
    void runnerModule.runner
      .providerStatus?.('nanogpt', { refresh: true })
      .then(() => admission.retryDeferred())
      .catch(() => ctx.logger.warn('could not refresh NanoGPT readiness'));
  });
  const refinement = new RefinementSteps({ projects, tasks, sessions, admission, delivery, inbox, timeline });
  const messaging = new Messaging({
    ctx,
    projects,
    tasks,
    sessions,
    messages,
    delivery,
    refinement,
    engines,
  });
  sessions.useProjectManagerStarts((projectKey, handle, taskKey, cause) =>
    messaging.projectManagerStart(projectKey, handle, taskKey, cause),
  );
  delivery.useMessageHolds((session) => messaging.holdsMessagesOf(session));
  const sessionCloser = new SessionCloser({
    ctx,
    projects,
    tasks,
    sessions,
    refinement,
    messaging,
    delivery,
  });
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
            { actor: SYSTEM_ACTOR, kind: 'action', subject: { type: 'permission', inboxItemId: item.id } },
          )
          .then(() => undefined),
      () => opts.logger.warn({ itemId: item.id }, 'permission decider notification failed'),
    );
  });
  // The wait of a card recommended for the Senior (PM-348); an answer tries the deferred starts again.
  const seniorWaits = new SeniorWaits({
    ctx,
    projects,
    tasks,
    inbox,
    timeline,
    retry: () => retryDeferredStarts(),
  });
  const taskStarts = new TaskStarts({ projects, tasks, members, sessions, admission, seniorWaits });
  const workStarts = new WorkStarts({ projects, tasks, sessions, admission, starts: taskStarts });
  // The start that waits for the labels an AI member sets runs as a work start, which needs the starts.
  taskStarts.useLabelWait(workStarts);
  taskStarts.useSeniorWait(workStarts);
  const handOver = new StageHandOver({ projects, tasks, sessions, admission, delivery });
  // A card at its fix round limit holds back its assignee's messages and hand-over notice (PM-262); the
  // hold needs the classes it binds to, which are built first.
  const fixLimit = new FixLimitWatch({
    ctx,
    projects,
    tasks,
    sessions,
    inbox,
    timeline,
    messaging,
    admission,
    delivery,
    starts: taskStarts,
  });
  messaging.useFixLimit(fixLimit);
  taskStarts.useFixLimit(fixLimit);
  handOver.useFixLimit(fixLimit);
  const autoAdvance = new AutoAdvance({ ctx, projects, tasks, sessions });
  const messageStarts = new MessageStarts({ projects, tasks, admission, messages, delivery });
  sessions.useQuotaRecovery(planUsage, (session, stageId) =>
    messageStarts.resumeAfterQuota(session, stageId),
  );
  const schedules = new ScheduleService({
    ctx,
    projects,
    admission,
    timeline,
    timer: opts.scheduleTimer,
  });
  // The handoff of a card's assignee (PM-342): the old member's note, or the summary, before the receiver starts.
  const handoffs = new HandoffService({
    ctx,
    projects,
    tasks,
    sessions,
    admission,
    runner: runnerModule.runner,
    messages,
    messaging,
    timeline,
    contextBuilder: opts.contextBuilder,
    background,
    retry: () => retryDeferredStarts(),
  });
  // The pause lets what it held go on: it needs the services that hold work back for it.
  const pauses = new PauseService({
    ctx,
    projects,
    sessions,
    admission,
    runner: runnerModule.runner,
    delivery,
    messaging,
    timeline,
    fixLimit,
    schedules,
    refinement,
    handoffs,
  });
  const machine = new MachineMonitor({
    probe:
      opts.machineProbe?.({ runningPids: () => runnerModule.runner.list().map((info) => info.pid) }) ??
      createMachineProbe(),
    runner: runnerModule.runner,
    sessions: opts.repos.sessions,
    tasks: opts.repos.tasks,
    memberOf: async (projectKey, handle) => {
      const member = memberOf(await projects.config(projectKey), handle);
      if (member?.kind !== 'ai') return null;
      return {
        handle: member.handle,
        displayName: member.displayName,
        kind: member.kind,
        role: member.role,
        specialty: member.specialty ?? null,
      };
    },
    instanceTag: opts.instanceTag,
    ...(opts.machineEngine
      ? { identity: opts.machineEngine.identity, unavailable: () => !opts.machineEngine!.available() }
      : {}),
    logger: opts.logger.child({ module: 'machine' }),
    now,
  });
  const reviewWatch = new ReviewWatch({ ctx, projects, tasks, sessions, messaging });
  // The server's full test of the pinned commit (PM-217) holds the reviewers back until its result is in.
  const fullTests = new FullTestRuns({
    ctx,
    projects,
    tasks,
    sessions,
    messaging,
    timeline,
    engines,
    released: () => retryDeferredStarts(),
  });
  messaging.useFullTests(fullTests);
  sessions.useFullTests(fullTests);
  handOver.useFullTests(fullTests);
  const githubSync = new GithubSync({
    ctx,
    github: opts.github,
    tasks,
    projects,
    onNewCommits: (projectKey, taskKey) =>
      reviewWatch.checkTask(projectKey, taskKey).catch((err: unknown) => {
        opts.logger.warn({ err, taskKey }, 'could not check the pinned review commit');
      }),
  });
  const publishing = new PublishingGate({
    ctx,
    projects,
    tasks,
    githubSync,
    publisher: opts.githubPublisher,
    // Publishing is the server's own act, on the machine it runs on.
    memberWorkspaces: engines.get(LOCAL_ENGINE_ID)?.memberWorkspaces,
  });
  const openQuestionLabel = new OpenQuestionLabel({ ctx, projects, tasks, inbox });
  // The screenshots of the Codex members (PM-351): a session that ends stops its run before its folder goes.
  // Remote engines are not connected yet when this is built, so a given directory always gets the runs (PM-315).
  const screenshotRuns =
    opts.engines || engines.ids().some((id) => engines.get(id)?.screenshotExecutor)
      ? new ScreenshotRuns({
          executorFor: (sessionId) => engines.get(sessions.engineOf(sessionId))?.screenshotExecutor,
          platformFor: (sessionId) => engines.get(sessions.engineOf(sessionId))?.platform,
          diskFor: (sessionId) => engines.get(sessions.engineOf(sessionId)) ?? undefined,
          sessions,
          logger: opts.logger,
        })
      : undefined;
  if (screenshotRuns) sessions.onFolderRemoved((sessionId) => screenshotRuns.stopSession(sessionId));
  const teamTools = new TeamToolsService({
    screenshots: screenshotRuns,
    openQuestionLabel,
    fixLimit,
    handoffs,
    boundary,
    egress,
    publishing,
    ctx,
    sessions,
    projectFocus,
    cardQuestions,
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
    materializeAttachment: opts.engineAttachments?.materialize,
    // The files and the folder of a session are on its engine.
    sessionEngine: (sessionId) => engines.get(sessions.engineOf(sessionId)) ?? undefined,
  });
  const agentQuestions = new AgentQuestions({
    ctx,
    askHuman: (toolContext, args) => teamTools.askHuman(toolContext, args),
  });
  // Read models and flows over the services above.
  const board = new BoardService({ projects, tasks, members, inbox, planUsage, pauses });
  const profiles = new MemberProfiles({ ctx, projects, members, tasks, inbox, sessions, admission });
  const invitations = new InvitationService({ ctx, projects, members, accounts: opts.accounts });
  const cardMeasure = new CardMeasure({
    ctx,
    projects,
    fixRounds: (task, config) => fixLimit.fixRounds(task, config),
  });

  const retryDeferredStarts = () =>
    background.run(
      () => admission.retryDeferred(),
      (err) => opts.logger.warn({ err }, 'deferred start retry failed'),
    );
  // A start that waits for an engine (`engine_offline`) goes on when the engine connects (PM-311).
  const unsubscribeEngines = engines.onChange((id, online) => {
    if (!online) return;
    // A remote engine that connects later is checked for the full test sandbox like a local one at startup.
    if (!opts.standby)
      background.run(
        () => fullTests.engineOnline(id),
        (err) =>
          opts.logger.warn({ err, engineId: id }, 'could not check the full test sandbox of an engine'),
      );
    // The messages that waited for the engine reach their members.
    background.run(
      () => messaging.releaseForEngine(id),
      (err) => opts.logger.warn({ err, engineId: id }, 'could not release the messages held for an engine'),
    );
    retryDeferredStarts();
  });
  /** A deferred start as it was stored, made again by the module that made it. */
  const rebuildDeferredStart = (spec: StartSpec) => {
    switch (spec.kind) {
      case 'hand_over':
        return handOver.rebuild(spec);
      case 'work_start':
        return workStarts.rebuild(spec);
      case 'refinement_turn':
        return refinement.rebuild(spec);
      case 'message_wake':
        return messageStarts.rebuild(spec);
      case 'provider_resume':
        return messageStarts.rebuildQuota(spec);
      case 'loop_notice':
        return loopWatch.rebuild(spec);
      case 'handoff_takeover':
        return handoffs.rebuild(spec);
    }
  };

  // The handoff follows what happens to the old member, the receiver and the card meanwhile.
  events.on('config_changed', (change) => handoffs.configChanged(change.projectKey, change.next));
  events.on('task_cancelled', (task) => handoffs.taskClosed(task));
  events.on('task_stage_changed', (change) => {
    if (change.task.status === 'done') handoffs.taskClosed(change.task, change.actor);
  });
  events.on('session_ended', (session) => handoffs.sessionEnded(session));

  // Configuration changes: runtime state follows the roster.
  events.on('config_changed', (change) => tasks.reconcileHandOns(change.next));
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
  // A card that waits for the Senior: the wait ends with its card's assignment, move, closure or level, or
  // with the team's Senior, and the owners' answer to the question is kept (PM-348). These run before the
  // listeners that retry the deferred starts, so a retry sees the wait settled.
  const settleSeniorWait = (task: { projectKey: string; key: string }) => {
    const config = projects.cachedConfig(task.projectKey);
    const current = tasks.find(task.projectKey, task.key);
    if (config && current) seniorWaits.settle(current, config);
  };
  events.on('task_assigned', ({ task }) => settleSeniorWait(task));
  // A message from an AI member that waits for a member with no role on the card starts nothing (PM-426).
  // The new assignee has a role: their waiting messages wake them now, unless the card holds them back.
  events.on('task_assigned', ({ task }) => {
    const assignee = task.assignee;
    const config = projects.cachedConfig(task.projectKey);
    if (!assignee || !config || memberOf(config, assignee)?.kind !== 'ai') return;
    if (!isOpenTask(task) || isTheme(task)) return;
    background.run(
      () =>
        messaging.wakeWaiting({
          projectKey: task.projectKey,
          member: assignee,
          workItem: routeFor(task.key),
        }),
      (err) =>
        opts.logger.warn({ err, taskKey: task.key }, 'could not wake the new assignee for waiting messages'),
    );
  });
  events.on('task_stage_changed', (change) => settleSeniorWait(change.task));
  events.on('task_cancelled', (task) => settleSeniorWait(task));
  events.on('task_level_changed', ({ task }) => {
    settleSeniorWait(task);
    retryDeferredStarts();
  });
  events.on('config_changed', (change) => {
    seniorWaits.configChanged(change);
    const { previous, next } = change;
    const seniors = (config: typeof next) =>
      config.team.members
        .filter((m) => isSenior(m))
        .map((m) => m.handle)
        .join(',');
    if (
      previous &&
      (seniors(previous) !== seniors(next) ||
        seniorWaitMinutesOf(previous.team.limits) !== seniorWaitMinutesOf(next.team.limits))
    )
      retryDeferredStarts();
  });
  events.on('inbox_resolved', (item) => seniorWaits.decided(item));
  // Human decisions.
  events.on('inbox_resolved', (item) =>
    item.kind === 'decision' ? tasks.handleDecisionResolved(item) : undefined,
  );
  events.on('inbox_resolved', (item) => (item.kind === 'question' ? messaging.answer(item) : undefined));
  // The card's other workers learn what was answered, so they do not ask it again (PM-249).
  events.on('inbox_resolved', (item) =>
    item.kind === 'question' ? messaging.answeredNotice(item) : undefined,
  );
  // An open AI question holds its card back with the waiting label; the last one closing frees it.
  events.on('inbox_resolved', (item) => openQuestionLabel.release(item));
  events.on('inbox_cancelled', (item) => openQuestionLabel.release(item));
  // AI members writing round in circles on a card: the scheduling duty's holder is told first, people
  // only when that did not help (PM-261). A loop ends when the card makes progress or goes quiet.
  const loopWatch = new LoopWatch({ ctx, projects, tasks, sessions, admission, delivery, inbox, timeline });
  events.on('task_talk_recorded', ({ event }) => loopWatch.check(event));
  events.on('task_work_recorded', ({ event }) => loopWatch.worked(event));
  events.on('task_stage_changed', (change) => loopWatch.progressed(change.task, 'stage'));
  events.on('task_labels_changed', ({ task }) => loopWatch.progressed(task, 'label'));
  events.on('task_cancelled', (task) => loopWatch.progressed(task, 'closed'));
  events.on('config_changed', (change) => loopWatch.configChanged(change));
  events.on('inbox_resolved', (item) => (item.kind === 'decision' ? loopWatch.decided(item) : undefined));
  // A card that reached its fix round limit is held back until its decider decides (PM-262). A round may
  // reach the limit when its label is set or its card moved back; the hold ends with the assignee or the card.
  events.on('task_labels_changed', ({ task }) => fixLimit.check(task));
  events.on('task_stage_changed', (change) => {
    if (change.task.status === 'done') fixLimit.closed(change.task);
    else fixLimit.check(change.task);
  });
  events.on('task_assigned', (change) => fixLimit.assigned(change));
  events.on('task_cancelled', (task) => fixLimit.closed(task));
  events.on('inbox_resolved', (item) => (item.kind === 'decision' ? fixLimit.decided(item) : undefined));
  // A card that lacks only a human's approval for its next stage asks for it, or moves when nothing is
  // missing (PM-445): looked at when its labels change or a session of it ends.
  const advanceCard = (task: Task | null): void => {
    if (!task) return;
    background.run(
      () => autoAdvance.check(task),
      (err) => opts.logger.warn({ err, taskKey: task.key }, 'automatic stage advance failed'),
    );
  };
  events.on('task_labels_changed', ({ task }) => advanceCard(task));
  events.on('task_stage_changed', (change) => advanceCard(change.task));
  const advanceSessionCard = (session: Session) =>
    advanceCard(
      session.workItem.type === 'task' ? tasks.find(session.projectKey, session.workItem.taskKey) : null,
    );
  events.on('session_idle', advanceSessionCard);
  events.on('session_ended', advanceSessionCard);
  // A card entering review gets its pinned commit tested, and one that left or got a new pin drops its
  // old run (PM-217); the pin is saved with the move, so it is there when this runs.
  const syncFullTest = (task: { projectKey: string; key: string }) =>
    background.run(
      () => fullTests.sync(task.projectKey, task.key),
      (err) => opts.logger.warn({ err, taskKey: task.key }, 'could not queue the full test'),
    );
  events.on('task_stage_changed', (change) => {
    syncFullTest(change.task);
  });
  events.on('task_cancelled', (task) => {
    syncFullTest(task);
  });
  // Cancelled tasks stop their sessions; moves and closures drop the starts they made obsolete.
  events.on('task_cancelled', (task) =>
    sessions.stopTask(task.projectKey, task.key, {
      kind: 'task_cancelled',
      taskKey: task.key,
      by: task.cancelledBy,
    }),
  );
  events.on('task_cancelled', (task) => admission.discardStale(task));
  // A card that closes (done or withdrawn) frees the cards that need it first (PM-204).
  const prerequisites = new PrerequisiteClosures({ ctx, timeline });
  events.on('task_cancelled', (task) => {
    prerequisites.closed(task);
  });
  events.on('task_stage_changed', (change) => {
    prerequisites.closed(change.task);
  });
  events.on('task_stage_changed', (change) => admission.discardStale(change.task));
  // A task entering a stage hands its work over anew: reviewers and testers get a new round.
  events.on('task_stage_changed', (change) => {
    if (change.task.status !== 'done') sessions.requestReviewRound(change.task.projectKey, change.task.key);
  });
  // A card leaving a stage ends the round of the members who worked it there: their conversations are
  // compacted (PM-213), in the background so a move does not wait for a session.
  events.on('task_stage_changed', (change) => {
    background.run(
      () => sessions.roundEnded(change.task),
      (err) => opts.logger.warn({ err }, 'end-of-round compaction failed'),
    );
  });
  // A member whose step on the card is over has its session closed (PM-295): at once if it is idle, else
  // when its turn ends. The conversation stays, and the next message or hand-over resumes it.
  events.on('task_stage_changed', (change) => {
    background.run(
      () => sessionCloser.stageChanged(change),
      (err) => opts.logger.warn({ err }, 'closing the sessions of a finished step failed'),
    );
  });
  events.on('session_idle', (session) => {
    background.run(
      () => sessionCloser.sessionIdle(session),
      (err) => opts.logger.warn({ err }, 'closing an idle session failed'),
    );
  });
  refinement.onTurnLeft((task, member) => {
    background.run(
      () => sessionCloser.refinementTurnLeft(task, member),
      (err) => opts.logger.warn({ err }, 'closing the session of a finished refinement turn failed'),
    );
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
  // A card moved into a work stage without an assignee starts like the Start button starts it (PM-119).
  events.on('task_stage_changed', (change) => {
    background.run(
      () => workStarts.begin(change),
      (err) => opts.logger.warn({ err }, 'work start failed'),
    );
  });
  // Capacity frees up when a card leaves a work stage (handed on, closed) or a session ends: the
  // starts that wait for a developer try again at once, not only on the timer.
  events.on('task_stage_changed', (change) => {
    const config = projects.cachedConfig(change.task.projectKey);
    if (change.task.status === 'done' || (config && stageOf(config, change.from)?.kind === 'work'))
      retryDeferredStarts();
  });
  events.on('task_cancelled', () => {
    retryDeferredStarts();
  });
  // A card waiting for a prerequisite starts when the last one closes (above: done or withdrawn)
  // or its relation is removed (PM-204).
  events.on('task_prerequisite_removed', () => {
    retryDeferredStarts();
  });
  // A card waiting for a label an AI member sets (PM-236) starts once its gate lets it through.
  events.on('task_labels_changed', () => {
    retryDeferredStarts();
  });
  events.on('session_ended', () => {
    retryDeferredStarts();
  });
  events.on('session_idle', () => {
    retryDeferredStarts();
  });
  // A card that is being worked out goes on to its next step (decision 31), in the background.
  const refine = (run: () => Promise<void>) => {
    background.run(run, (err) => opts.logger.warn({ err }, 'refinement step failed'));
  };
  events.on('task_labels_changed', ({ task }) => {
    refine(() => refinement.changed(task));
  });
  events.on('task_stage_changed', (change) => {
    refine(() => refinement.moved(change));
  });
  // The messages that waited for their turn on a card reach their members once it is out of refinement.
  events.on('task_labels_changed', ({ task, previousLabels }) => {
    refine(() => messaging.releaseHeld(task.projectKey, task.key, { ...task, labels: previousLabels }));
  });
  events.on('task_stage_changed', (change) => {
    refine(() =>
      messaging.releaseHeld(change.task.projectKey, change.task.key, {
        ...change.task,
        stageId: change.from,
      }),
    );
  });
  events.on('session_idle', (session) => {
    refine(() => refinement.turnEnded(session));
  });
  events.on('session_ended', (session) => {
    refine(() => refinement.turnEnded(session));
  });
  events.on('task_stage_changed', (change) => {
    if (change.task.status !== 'done') return;
    // An AI member that moved the task finishes its turn first (its messages and notes, PM-190).
    const mover = change.actor.kind === 'ai' ? change.actor.handle : null;
    sessions.scheduleDoneCleanup(change.task.projectKey, change.task.key, mover);
  });
  // Labels that notify the assignee and @mentions reach members as team messages.
  events.on('task_labels_notice', (notice) => messaging.labelNotice(notice));
  events.on('task_note_added', (note) => messaging.mentionNotice(note));
  // A changed description reaches the sessions working the card; a reviewer restarts on it (PM-184).
  events.on('task_description_changed', (change) => messaging.descriptionNotice(change));
  // New relations on a card that is being worked on reach its workers and, when they may change the work, its analyst (PM-421).
  const relationNotices = new RelationNotices({ ctx, projects, tasks, sessions, messaging, inbox });
  events.on('task_relations_added', (added) => relationNotices.added(added));
  // A started session gets the messages waiting for it; waiting messages wake their recipient.
  // A session that started while the team is paused is held at once (a start that passed admission before the pause).
  events.on('session_started', (session) => pauses.sessionStarted(session));
  events.on('session_started', (session) => delivery.deliverWaiting(session));
  events.on('session_idle', (session) => delivery.deliverWaiting(session));
  // A member joining a card is told to the card's other workers; a notice kept for an ended session is dropped (PM-249).
  events.on('task_session_joined', (joined) => messaging.joinedNotice(joined));
  events.on('session_ended', (session) => delivery.dropHeld(session.id));
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
  let reviewWatchTimer: ReturnType<typeof setInterval> | undefined;
  let loopWatchTimer: ReturnType<typeof setInterval> | undefined;
  let seniorWaitTimer: ReturnType<typeof setInterval> | undefined;
  let diskTimer: ReturnType<typeof setInterval> | undefined;
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  let idleCloseTimer: ReturnType<typeof setInterval> | undefined;
  let handoffTimer: ReturnType<typeof setInterval> | undefined;

  /** What the engine's settings view counts (PM-315): its sessions and what waits for it. */
  const engineCounters = (id: EngineId): EngineCounters => ({
    runningSessions: sessions.liveOn(id),
    waitingStarts: deferredStarts
      .list()
      .filter((entry) => entry.waiting.reason === 'engine_offline' && entry.waiting.engine === id).length,
    waitingMessages: messaging.waitingForEngine(id),
  });

  return {
    engineCounters,
    ctx,
    projectManagerChannels: new ProjectManagerChannels({ ctx, projects, deferred: deferredStarts, pauses }),
    bus,
    templates,
    timeline,
    involvements,
    projectFocus,
    projects,
    inbox,
    boundary,
    egress,
    runtimeBoundary: opts.runtimeBoundary ?? null,
    runnerModule,
    providerKeys,
    presence,
    messages,
    messaging,
    sessionCloser,
    tasks,
    attachments,
    members,
    roles,
    sessions,
    planUsage,
    admission,
    pauses,
    handoffs,
    machine,
    taskStarts,
    handOver,
    workStarts,
    messageStarts,
    refinement,
    schedules,
    githubSync,
    reviewWatch,
    fullTests,
    loopWatch,
    seniorWaits,
    fixLimit,
    autoAdvance,
    disk,
    worktreeSweep,
    teamTools,
    cardQuestions,
    board,
    profiles,
    invitations,
    cardMeasure,

    /** Startup: import projects from the repository, clean up state that did not survive a restart, watch PRs. */
    async start(): Promise<void> {
      await projects.syncFromStore();
      await sessions.reconcileAfterRestart();
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
      // Restore quota holds before schedulers or background probes can admit inference.
      const restoredStarts = admission.restoreDeferred(rebuildDeferredStart);
      usage.start();
      schedules.start();
      // The server's full test (PM-217): the sandbox is checked, the runs the last server left are ended
      // and the pins that still need one are queued, before the hand-overs that wait for them come back.
      await fullTests.init();
      // What admission refused before the server stopped waits again and is retried now, as usual
      // (under admission, and not while its master switch is off)...
      if (restoredStarts > 0) retryDeferredStarts();
      // ... and the pause that stopping the server made ends: its sessions start again (PM-219).
      // In the background: starting the sessions again must not hold the server back.
      background.run(
        () => pauses.resumeAfterStartup(),
        (err) => opts.logger.warn({ err }, 'could not resume the team after the start'),
      );
      // ... and the handoffs of cards that were open go on (PM-342); a note that is late falls back to the summary.
      handoffs.resumeAfterStartup();
      // ... and the cards that lack only a human's approval, and got stuck before, ask for it (PM-445).
      background.run(
        () => autoAdvance.sweep(),
        (err) => opts.logger.warn({ err }, 'automatic stage advance sweep failed'),
      );
      handoffTimer = setInterval(
        () =>
          background.run(
            () => handoffs.sweep(),
            (err) => opts.logger.warn({ err }, 'handoff sweep failed'),
          ),
        opts.handoffSweepMs ?? 15_000,
      );
      handoffTimer.unref();
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
      // The branch of a task in review must stay at the commit handed over (PM-183).
      reviewWatchTimer = setInterval(
        () =>
          background.run(
            async () => {
              await reviewWatch.check();
              // A pin that has no run yet (the server stopped between the move and the queueing) gets one.
              await fullTests.syncAll();
            },
            (err) => opts.logger.warn({ err }, 'review commit check failed'),
          ),
        opts.reviewWatchMs ?? 30_000,
      );
      reviewWatchTimer.unref();
      // A loop on a card ends when its branch got a commit or nobody wrote for a whole window (PM-261).
      loopWatchTimer = setInterval(
        () =>
          background.run(
            () => loopWatch.sweep(),
            (err) => opts.logger.warn({ err }, 'loop watch sweep failed'),
          ),
        opts.loopWatchMs ?? 60_000,
      );
      loopWatchTimer.unref();
      // A card that waited for the Senior past the wait limit asks the owners, once (PM-348).
      seniorWaitTimer = setInterval(
        () =>
          background.run(
            async () => seniorWaits.sweep(),
            (err) => opts.logger.warn({ err }, 'Senior wait sweep failed'),
          ),
        opts.seniorWaitMs ?? 60_000,
      );
      seniorWaitTimer.unref();
      // Free disk space (PM-243): warn the owners early, so that admission need not be the first to find out.
      const checkDisk = () =>
        background.run(
          () => disk.check(),
          (err) => opts.logger.warn({ err }, 'free disk space check failed'),
        );
      checkDisk();
      diskTimer = setInterval(checkDisk, opts.diskCheckMs ?? 60_000);
      diskTimer.unref();
      // The worktrees of closed cards (PM-243): at startup and then every few hours.
      const sweepWorktrees = () =>
        background.run(
          async () => {
            await worktreeSweep.run();
          },
          (err) => opts.logger.warn({ err }, 'worktree sweep failed'),
        );
      sweepWorktrees();
      sweepTimer = setInterval(sweepWorktrees, opts.worktreeSweepMs ?? 6 * 60 * 60_000);
      sweepTimer.unref();
      // Sessions that sat idle for a quarter of an hour close (PM-295).
      idleCloseTimer = setInterval(
        () =>
          background.run(
            () => sessionCloser.sweep(),
            (err) => opts.logger.warn({ err }, 'idle session close sweep failed'),
          ),
        opts.idleCloseSweepMs ?? 60_000,
      );
      idleCloseTimer.unref();
    },

    async stop(): Promise<void> {
      unsubscribeEngines();
      usage.stop();
      if (retryTimer) clearInterval(retryTimer);
      if (boundaryTimer) clearInterval(boundaryTimer);
      if (reviewWatchTimer) clearInterval(reviewWatchTimer);
      if (loopWatchTimer) clearInterval(loopWatchTimer);
      if (seniorWaitTimer) clearInterval(seniorWaitTimer);
      if (diskTimer) clearInterval(diskTimer);
      if (sweepTimer) clearInterval(sweepTimer);
      if (idleCloseTimer) clearInterval(idleCloseTimer);
      if (handoffTimer) clearInterval(handoffTimer);
      const drained = schedules.stop();
      githubSync.stop();
      await fullTests.stop();
      await screenshotRuns?.stop();
      await background.stop();
      pauses.dispose();
      sessions.dispose();
      // The folders still being removed finish before the temporary root is released.
      await sessions.settleFolderRemovals();
      await Promise.all(engines.ids().map((id) => engines.get(id)?.sessionFolders?.releaseTmpRoot()));
      await machine.stop();
      await drained;
    },

    /**
     * Whether the user may manage the instance as a whole: the owner of every project, the same rule
     * as the instance's pause (`canManageInstancePause`). The machine display is for them alone.
     */
    async instanceOwner(email: string): Promise<boolean> {
      const accesses = await Promise.all(
        projects.summaries().map(async (project) => {
          const access = await this.accessFor(project.key, email);
          return access?.access ?? null;
        }),
      );
      return canManageInstancePause(accesses);
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
