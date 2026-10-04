import os from 'node:os';
import { isOnLeave, memberOf, permissionDelegationOf, stageOf } from '@projectman/shared';
import type { ExecutionProfile, Me } from '@projectman/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { AuthService } from '../auth';
import type {
  AttachmentStorage,
  BoundaryOperationAdapter,
  ConfigStore,
  ContextPackBuilder,
  EventBus,
  FullTestExecutor,
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
import {
  Admission,
  DeferredStarts,
  MessageStarts,
  RefinementSteps,
  StageHandOver,
  TaskStarts,
  WorkStarts,
} from './admission';
import type { StartSpec } from './admission';
import { AttachmentService } from './attachments';
import { BackgroundTasks } from './background';
import { BoardService } from './board';
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
import { MessageDelivery, MessageService, Messaging } from './messaging';
import { PlanUsageMonitor } from './plan-usage';
import { PresenceService } from './presence';
import { ProjectService } from './projects';
import { PublishingGate } from './publishing';
import { ReviewWatch } from './review-watch';
import { RoleService } from './roles';
import { ScheduleService } from './schedules';
import type { ScheduleTimer } from './schedules';
import { PauseService } from './pause';
import { SessionOrchestrator } from './sessions';
import { PrerequisiteClosures, TaskService } from './tasks';
import { TeamToolsService } from './team-tools';
import { TimelineService } from './timeline';
import { AgentQuestions } from './agent-question';
import { InputStallAlerts } from './input-stall-alert';
import { UsageAlerts } from './usage-alerts';
import { DiskGuard } from './disk-guard';
import { WorktreeSweep } from './worktree-sweep';
import { CardMeasure } from './card-measure';
import { SYSTEM_ACTOR } from './util';

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
export { PauseService } from './pause';
export type { PauseOptions, PauseRequester, PauseTarget } from './pause';
export { PlanUsageCache, PlanUsageMonitor, highestUsagePercent } from './plan-usage';
export { PresenceService } from './presence';
export { ProjectService, OWNER_HANDLE } from './projects';
export type { Author, LoadedProject, ConfigChange } from './projects';
export { DiskGuard, freeBytesOf } from './disk-guard';
export { CLOSED_WORKTREE_KEEP_MS, WorktreeSweep } from './worktree-sweep';
export type { WorktreeSweepReport } from './worktree-sweep';
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
  /** The user's home (default `os.homedir()`); a developer's sandbox reads nothing below it but its own (PM-153). */
  userHome?: string;
  /** Where member workspaces live: a developer's routine steps there run without asking, as in a worktree. */
  workspacesRootDir?: string;
  /**
   * The checkout the server runs from (`~/projectman-live` for the owner's live instance): reading
   * sessions never change it (PM-188).
   */
  installDir?: string;
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
  /** How often the open loops of cards are looked at for an end (default 60 s, PM-261). */
  loopWatchMs?: number;
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
  // `agentQuestions` is built once the team tools exist; the callback only runs during a session.
  const runnerModule = opts.createRunner({
    ...inbox.broker,
    forwardQuestion: ({ sessionId, toolName, toolInput }) =>
      agentQuestions.forward(sessionId, toolName, toolInput),
  });
  const presence = new PresenceService();
  // The deferred automatic starts live in SQLite too: a restart loads them back (see `start`).
  const deferredStarts = new DeferredStarts(opts.repos.deferredStarts);
  const messages = new MessageService({ ctx, timeline });
  const tasks = new TaskService({
    ctx,
    timeline,
    projects,
    inbox,
    startWaiting: deferredStarts,
    // `sessions` is built below; the callback only runs when a task is handed over for review.
    sourceHead: (config, task) => sessions.sourceHead(config, task),
    // `fixLimit` is built below; the callback only runs when a task is read.
    fixLimit: (task) => fixLimit.view(task),
  });
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
    ctx,
    projects,
    tasks,
    members,
    timeline,
    runner: runnerModule.runner,
    transcripts: runnerModule.transcripts,
    contextBuilder: opts.contextBuilder,
    cardQuestions,
    memory: opts.memory,
    worktrees: opts.worktrees,
    publicBaseUrl: opts.publicBaseUrl,
    doneCleanupDelayMs: opts.doneCleanupDelayMs,
    doneTurnLimitMs: opts.doneTurnLimitMs,
    attachments,
    attachmentDirectory,
    memberWorkspaces: opts.memberWorkspaces,
    processExists: opts.processExists,
    runtimeBoundary: opts.runtimeBoundary,
    executionProfile: opts.executionProfile,
    managedVm: opts.managedVm,
    standby: opts.standby,
    appHome: opts.appHome,
    userHome: opts.userHome,
    readerDenyWrite: [opts.appHome, opts.worktreesRootDir, opts.workspacesRootDir, opts.installDir].filter(
      (dir): dir is string => !!dir,
    ),
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
  });
  const planUsage = usage.cache;
  const disk = new DiskGuard({ ctx, projects, inbox, freeBytes: opts.freeDiskBytes });
  const worktreeSweep = new WorktreeSweep({
    ctx,
    projects,
    inbox,
    sessions,
    worktrees: opts.worktrees,
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
  });
  const delivery = new MessageDelivery({ ctx, sessions, messages });
  const refinement = new RefinementSteps({ projects, tasks, sessions, admission, delivery, inbox, timeline });
  const messaging = new Messaging({ ctx, projects, tasks, sessions, messages, delivery, refinement });
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
  const workStarts = new WorkStarts({ projects, tasks, sessions, admission, starts: taskStarts });
  // The start that waits for the labels an AI member sets runs as a work start, which needs the starts.
  taskStarts.useLabelWait(workStarts);
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
  const messageStarts = new MessageStarts({ projects, tasks, admission, messages, delivery });
  const schedules = new ScheduleService({
    ctx,
    projects,
    admission,
    timeline,
    timer: opts.scheduleTimer,
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
    executor: opts.fullTestExecutor,
    userHome: opts.userHome ?? os.homedir(),
    appHome: opts.appHome,
    released: () => retryDeferredStarts(),
  });
  messaging.useFullTests(fullTests);
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
    memberWorkspaces: opts.memberWorkspaces,
  });
  const openQuestionLabel = new OpenQuestionLabel({ ctx, projects, tasks, inbox });
  const teamTools = new TeamToolsService({
    openQuestionLabel,
    fixLimit,
    boundary,
    egress,
    publishing,
    ctx,
    sessions,
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
      case 'loop_notice':
        return loopWatch.rebuild(spec);
    }
  };

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
  events.on('task_cancelled', (task) => sessions.stopTask(task.projectKey, task.key));
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
  // A started session gets the messages waiting for it; waiting messages wake their recipient.
  // A session that started while the team is paused is held at once (a start that passed admission before the pause).
  events.on('session_started', (session) => pauses.sessionStarted(session));
  events.on('session_started', (session) => delivery.deliverWaiting(session));
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
  let diskTimer: ReturnType<typeof setInterval> | undefined;
  let sweepTimer: ReturnType<typeof setInterval> | undefined;

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
    pauses,
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
    fixLimit,
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
      // The server's full test (PM-217): the sandbox is checked, the runs the last server left are ended
      // and the pins that still need one are queued, before the hand-overs that wait for them come back.
      await fullTests.init();
      // What admission refused before the server stopped waits again and is retried now, as usual
      // (under admission, and not while its master switch is off)...
      if (admission.restoreDeferred(rebuildDeferredStart) > 0) retryDeferredStarts();
      // ... and the pause that stopping the server made ends: its sessions start again (PM-219).
      // In the background: starting the sessions again must not hold the server back.
      background.run(
        () => pauses.resumeAfterStartup(),
        (err) => opts.logger.warn({ err }, 'could not resume the team after the start'),
      );
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
    },

    async stop(): Promise<void> {
      usage.stop();
      if (retryTimer) clearInterval(retryTimer);
      if (boundaryTimer) clearInterval(boundaryTimer);
      if (reviewWatchTimer) clearInterval(reviewWatchTimer);
      if (loopWatchTimer) clearInterval(loopWatchTimer);
      if (diskTimer) clearInterval(diskTimer);
      if (sweepTimer) clearInterval(sweepTimer);
      const drained = schedules.stop();
      githubSync.stop();
      await fullTests.stop();
      await background.stop();
      pauses.dispose();
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
