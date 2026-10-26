import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectConfig } from '@projectman/shared';
import { vi } from 'vitest';
import { AuthService } from '../../src/auth';
import { createConfigStore, createOperatorKnowledgeStore } from '../../src/config';
import { createRepositories, openDatabase } from '../../src/db';
import type {
  AttachmentStorage,
  BoundaryOperationAdapter,
  EngineAttachments,
  EngineDirectory,
  BranchMerger,
  FullTestExecutor,
  HistorySemanticPort,
  ScreenshotExecutor,
  MemberWorkspaceManager,
} from '../../src/contracts';
import { attachmentToolRules } from '../../src/runtime/sessions';
import { createDomain } from '../../src/assembly';
import { humanActor } from '../../src/kernel';
import { createAttachmentStorage, createMessageAttachmentStorage } from '../../src/core/attachments';
import { createTemplateRegistry } from '../../src/core/base';
import type { ScheduleTimer } from '../../src/services/schedules';
import type { EmailChannelEnv, EmailSender } from '../../src/services/email-channel';
import { createMemberWorkspaceManager } from '../../src/worktree';
import type { Domain, DomainOptions } from '../../src/assembly';
import { sharedClaudeTmpRoots } from '../../src/engine-host';
import { createLocalEngine } from '../../src/engine-host';
import { LocalEngineDirectory } from '../../src/runtime/sessions';
import {
  capturingLogger,
  createFakeRunnerModule,
  FakeContextBuilder,
  FakeGithub,
  FakeMemoryStore,
  FakeWorktreeManager,
  planUsage,
} from './fakes';
import { readEntries, seedCustomizationRepository, writeEntries } from './customization-seed';
import type { SeedEntry } from './customization-seed';
import { openMigratedMemoryDatabase, seedDatabaseFile } from './database-seed';
import { testTemplate, testTemplateWithActivePm } from './test-template';
import { withoutOnboarding } from './onboarding';

export const OWNER = { name: 'Owner', email: 'owner@example.com' };

function errorReplacer(_key: string, value: unknown): unknown {
  return value instanceof Error ? { message: value.message, stack: value.stack } : value;
}
export const OWNER_ACTOR = humanActor('owner');

/** Waits for an asynchronously started session without assuming event-loop turns finish the start. */
export async function waitForSession(
  domain: Pick<Domain, 'sessions'>,
  filters: Parameters<Domain['sessions']['list']>[1] = {},
  projectKey = 'AR',
) {
  return vi.waitFor(() => {
    const session = domain.sessions.list(projectKey, filters)[0];
    if (!session) throw new Error(`Waiting for session in ${projectKey}: ${JSON.stringify(filters)}`);
    return session;
  });
}

/**
 * What a stopped harness left: its in-memory database and customization repository, to start any
 * number of new harnesses from (`snapshot` option, `snapshotDomainHarness`).
 */
export interface HarnessSnapshot {
  database: Buffer;
  customization: SeedEntry[];
}

/**
 * A domain over an in-memory database, a temp customization repository and fakes for the
 * runner, context pack, memory, worktrees and GitHub; with project "AR" created from the
 * test template. `persistent` keeps the database in a file instead, and `restartDomainHarness`
 * then starts a new domain over it.
 */
export async function createDomainHarness(
  opts: {
    boundaryAdapter?: BoundaryOperationAdapter;
    /** Wraps the configuration store for read-failure injection. */
    configStore?: (inner: ReturnType<typeof createConfigStore>) => ReturnType<typeof createConfigStore>;
    adjust?: (config: ProjectConfig) => void;
    now?: () => Date;
    scheduleTimer?: ScheduleTimer;
    handOffRetryMs?: number;
    memberQueueSweepMs?: number;
    /** True: the Operator screens AI members' questions first (PM-558); default false in tests. */
    screenQuestions?: boolean;
    doneTurnLimitMs?: number;
    /** The database lives in a file, so that a restart can open it again. */
    persistent?: boolean;
    /** Plan usage (percent of the five-hour window) the fake probe reports from the start (default: unknown). */
    planUsagePercent?: number;
    /**
     * The directory of an earlier harness (database file, customization repository, workspace):
     * the domain starts over what that one left, as after a restart. See `restartDomainHarness`.
     */
    directory?: string;
    /**
     * Starts over the state a stopped harness left (`snapshotDomainHarness`) in a directory of its
     * own, with the in-memory database: the project is neither created nor adjusted again, which
     * saves the git commits of doing so. Take it with the same options as this harness gets. The
     * project's configured workspace path stays the one of the harness the snapshot was taken from
     * (gone by then): use it for tests that do not read the workspace through the configuration.
     */
    snapshot?: HarnessSnapshot;
    /** Exercise project creation's automatic Operator greeting; other tests start after onboarding. */
    onboarding?: boolean;
    /** The project manager is on duty from project creation (default: on leave, so it starts no sessions). */
    pmOnDuty?: boolean;
    /** Wraps the real attachment storage (fault injection); default: the storage as it is. */
    attachmentStorage?: (inner: AttachmentStorage) => AttachmentStorage;
    /**
     * Durable member workspaces (PM-138) with the real git-backed manager under `<dir>/workspaces`;
     * the project's repositories must then be real git repositories.
     */
    memberWorkspaces?: boolean;
    /** Wraps the real member workspace manager (fault injection, the VM's hand-overs). */
    wrapMemberWorkspaces?: (inner: MemberWorkspaceManager) => MemberWorkspaceManager;
    /** The process ids the workspace reservation sees as still running (default: none). */
    liveProcesses?: Set<number>;
    /** The user's home and the app home the sessions' sandboxes are computed from (PM-153); default the real home, none. */
    userHome?: string;
    appHome?: string;
    /** How long a session may wait for input before the owners are told (PM-199). */
    inputStallMs?: number;
    /** The free disk bytes (PM-243); absent: not measured, so no start is refused for disk space. */
    freeDiskBytes?: () => Promise<number | null>;
    heavyRunSessions?: () => Promise<string[]>;
    /** The history's embedding (PM-767), usually a fake port; absent, the history search uses the words only. */
    historySemantic?: HistorySemanticPort;
    /** The outgoing e-mail channel (PM-941); absent: the channel is not configured. */
    emailChannel?: { sender: EmailSender; env: EmailChannelEnv };
    /** How long a closed card's worktree stays (default 3 days). */
    closedWorktreeKeepMs?: number;
    /** The server's full test before review (PM-217); absent, the feature is off. */
    fullTestExecutor?: FullTestExecutor;
    /** The server's screenshots for members whose sandbox has no browser (PM-351); absent, the tools are off. */
    screenshotExecutor?: ScreenshotExecutor;
    /**
     * The root of the session folders (PM-268) below the harness directory, or a path of the
     * test's own (an unsafe one); absent, no session folders.
     */
    sessionFolders?: boolean | string;
    /**
     * The root of the Codex sessions' own temporary directories (PM-339): `true` for the real shape
     * `<dir>/projectman-501-tmp/<8 hex>`, or a path of the test's own; absent, Codex gets no folder.
     */
    sessionTmp?: boolean | string;
    /** The temporary roots all Claude Code processes share (PM-353); default: `/tmp/claude-test` and the like. */
    claudeTmpRoots?: readonly string[];
    /** Playwright's browsers directory (PM-268); absent, no browsers variable. */
    browsersDir?: string;
    /** The machine's heavy-run queue folder (PM-332) named in the sandboxes; absent, none. */
    heavyLockDir?: string;
    /** The machines the sessions run on (PM-311); absent: the one local engine, built from the options above. */
    engines?: EngineDirectory;
    machineEngine?: DomainOptions['machineEngine'];
    merger?: BranchMerger | null;
    /** The project and repository that are the instance itself (PM-491); absent: releases are off. */
    releaseTarget?: { projectKey: string; repo: string };
    /** The hybrid release binding and the engines' facts (PM-752); absent: the single-target release only. */
    releaseHybrid?: DomainOptions['releaseHybrid'];
    /** The protected administration adapter (PM-764); absent: the domain has none. */
    administration?: DomainOptions['administration'];
    /** Whether an integrator can take todos (PM-806); absent: none can, so every todo goes to the owners. */
    integratorTodoAccess?: DomainOptions['integratorTodoAccess'];
    /** The commit the server runs (PM-491); default `dev`. */
    appVersion?: string;
    /** The release tag of the running build (PM-542); absent: none. */
    appTag?: () => Promise<string | null>;
    engineName?: (id: string) => string | null;
    /** The attachments of a remote engine (PM-315); absent: the sessions read the stored files themselves. */
    engineAttachments?: EngineAttachments;
  } = {},
) {
  const { snapshot } = opts;
  if (snapshot && (opts.directory !== undefined || opts.persistent))
    throw new Error('A snapshot starts an in-memory harness in a directory of its own');
  const restarted = opts.directory !== undefined;
  const dir = opts.directory ?? mkdtempSync(join(tmpdir(), 'pm-domain-'));
  const workspace = join(dir, 'workspace');
  if (!restarted) {
    mkdirSync(workspace);
    if (snapshot) {
      writeEntries(join(dir, 'customization'), snapshot.customization);
    } else {
      await seedCustomizationRepository(join(dir, 'customization'));
      if (opts.persistent) seedDatabaseFile(join(dir, 'db.sqlite'));
    }
  }
  const repos = createRepositories(
    restarted || opts.persistent
      ? openDatabase(join(dir, 'db.sqlite'))
      : openMigratedMemoryDatabase(snapshot?.database),
  );
  const configStore = (opts.configStore ?? ((inner) => inner))(
    createConfigStore({ rootDir: join(dir, 'customization') }),
  );
  const runnerModule = createFakeRunnerModule();
  if (opts.planUsagePercent !== undefined) runnerModule.planUsage.value = planUsage(opts.planUsagePercent);
  const github = new FakeGithub();
  const contextBuilder = new FakeContextBuilder();
  const memory = new FakeMemoryStore();
  const worktrees = new FakeWorktreeManager(join(dir, 'worktrees'));
  const log = capturingLogger();
  const attachmentStorage = (opts.attachmentStorage ?? ((inner) => inner))(
    createAttachmentStorage(join(dir, 'attachments')),
  );
  const messageAttachmentStorage = createMessageAttachmentStorage(join(dir, 'message-attachments'));
  const liveProcesses = opts.liveProcesses ?? new Set<number>();
  const workspacesDir = join(dir, 'workspaces');
  const sessionFoldersDir =
    typeof opts.sessionFolders === 'string'
      ? opts.sessionFolders
      : opts.sessionFolders
        ? // Canonical, as the real root is (it comes from realpathSync(tmpdir())); on macOS tmpdir() is a link.
          join(realpathSync(dir), 'session-folders', 'root')
        : undefined;

  const sessionTmpDir =
    typeof opts.sessionTmp === 'string'
      ? opts.sessionTmp
      : opts.sessionTmp
        ? join(realpathSync(dir), 'projectman-501-tmp', '0123abcd')
        : undefined;

  const memberWorkspaces = opts.memberWorkspaces
    ? (opts.wrapMemberWorkspaces ?? ((inner) => inner))(
        createMemberWorkspaceManager({ rootDir: workspacesDir, logger: log.logger }),
      )
    : undefined;
  const runningVersion = { value: opts.appVersion ?? 'dev' };
  const auth = new AuthService({ repos, now: opts.now });
  const domain: Domain = createDomain({
    ...(opts.historySemantic ? { historySemantic: opts.historySemantic } : {}),
    ...(opts.emailChannel
      ? {
          emailChannelSender: opts.emailChannel.sender,
          emailChannelEnv: opts.emailChannel.env,
          emailReplyKey: randomBytes(32),
        }
      : {}),
    integratorCredentials: auth,
    operatorGrants: auth.operatorGrantGate,
    ...(opts.engines
      ? { engines: opts.engines }
      : opts.merger !== undefined
        ? {
            engines: new LocalEngineDirectory({
              ...createLocalEngine(
                {
                  worktrees,
                  memberWorkspaces,
                  workspacesRootDir: memberWorkspaces ? workspacesDir : undefined,
                  workspacePath: () => workspace,
                  fullTestExecutor: opts.fullTestExecutor,
                  heavyRunSessions: opts.heavyRunSessions,
                  claudeTmpRoots: opts.claudeTmpRoots ?? sharedClaudeTmpRoots({ uid: 'test' }),
                },
                log.logger,
              ),
              merger: opts.merger ?? undefined,
            }),
          }
        : {}),
    engineName: opts.engineName,
    machineEngine: opts.machineEngine,
    ...(opts.releaseTarget ? { releaseTarget: opts.releaseTarget } : {}),
    ...(opts.releaseHybrid ? { releaseHybrid: opts.releaseHybrid } : {}),
    ...(opts.appTag ? { appTag: opts.appTag } : {}),
    ...(opts.administration ? { administration: opts.administration } : {}),
    // Read when asked, so that a test can restart "the server" on another commit (`setAppVersion`).
    get appVersion() {
      return runningVersion.value;
    },
    outageCheckMs: 3_600_000,
    ...(opts.engineAttachments ? { engineAttachments: opts.engineAttachments } : {}),
    sessionFoldersDir,
    sessionTmpDir,
    // Not this machine's: the harness directory may lie below the Claude Code root the tests run in.
    claudeTmpRoots: opts.claudeTmpRoots ?? sharedClaudeTmpRoots({ uid: 'test' }),
    browsersDir: opts.browsersDir,
    heavyLockDir: opts.heavyLockDir,
    boundaryAdapter: opts.boundaryAdapter,
    repos,
    configStore,
    logger: log.logger,
    publicBaseUrl: 'http://127.0.0.1:4700',
    createRunner: (broker) => runnerModule.createWithBroker(broker),
    github,
    userHome: opts.userHome,
    appHome: opts.appHome,
    inputStallMs: opts.inputStallMs,
    fullTestExecutor: opts.fullTestExecutor,
    screenshotExecutor: opts.screenshotExecutor,
    contextBuilder,
    memory,
    operatorKnowledge: createOperatorKnowledgeStore({ rootDir: join(dir, 'operator-data') }),
    worktrees,
    attachmentStorage,
    feedbackDir: join(dir, 'feedback'),
    messageAttachmentStorage,
    accounts: auth,
    worktreesRootDir: join(dir, 'worktrees'),
    ...(opts.memberWorkspaces
      ? {
          memberWorkspaces,
          workspacesRootDir: workspacesDir,
        }
      : {}),
    processExists: (pid) => liveProcesses.has(pid),
    templates: createTemplateRegistry([opts.pmOnDuty ? testTemplateWithActivePm : testTemplate]),
    planUsageTtlMs: 0,
    now: opts.now,
    scheduleTimer: opts.scheduleTimer,
    doneCleanupDelayMs: 0,
    // Questions go to the people at once, unless a test is about the Operator's screening (PM-558).
    screenQuestions: opts.screenQuestions ?? false,
    doneTurnLimitMs: opts.doneTurnLimitMs,
    handOffRetryMs: opts.handOffRetryMs,
    // Tests call `domain.reviewWatch.check()` themselves: the timer must not fire on its own.
    reviewWatchMs: 3_600_000,
    // Likewise the loop watch's sweep: tests call `domain.loopWatch.sweep()`.
    loopWatchMs: 3_600_000,
    // Tests call `domain.seniorWaits.sweep()` after moving the clock.
    seniorWaitMs: 3_600_000,
    // Likewise the disk check and the worktree sweep: tests call `domain.disk` and `domain.worktreeSweep`.
    diskCheckMs: 3_600_000,
    worktreeSweepMs: 3_600_000,
    // And the idle close sweep: tests call `domain.sessionCloser.sweep()`.
    idleCloseSweepMs: 3_600_000,
    // Tests call `domain.sessions.sweepLive()` themselves.
    liveSessionSweepMs: 3_600_000,
    // And the handoff sweep: tests call `domain.handoffs.sweep()` after moving the clock.
    handoffSweepMs: 3_600_000,
    // And the obligation sweep: tests call `domain.obligations.sweep()` after moving the clock.
    obligationSweepMs: 3_600_000,
    // And the member queue's sweep: tests call `domain.memberQueueDriver.sweep()` after changing a limit.
    memberQueueSweepMs: opts.memberQueueSweepMs ?? 3_600_000,
    ...(opts.integratorTodoAccess ? { integratorTodoAccess: opts.integratorTodoAccess } : {}),
    freeDiskBytes: opts.freeDiskBytes,
    heavyRunSessions: opts.heavyRunSessions,
    closedWorktreeKeepMs: opts.closedWorktreeKeepMs,
  });
  await domain.start();
  if (!restarted && !snapshot) {
    const create = () =>
      domain.projects.create(
        { key: 'AR', name: 'acme', workspacePath: workspace, templateId: 'test' },
        OWNER,
      );
    if (opts.onboarding) await create();
    else await withoutOnboarding(domain, create);
  }
  if (opts.adjust && !restarted && !snapshot) {
    await domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (draft) => {
      opts.adjust!(draft);
      return 'Adjust test configuration';
    });
  }

  return {
    auth,
    dir,
    workspace,
    repos,
    configStore,
    domain,
    runnerModule,
    runner: runnerModule.runner,
    github,
    contextBuilder,
    memory,
    worktrees,
    log,
    liveProcesses,
    workspacesDir,
    sessionFoldersDir,
    sessionTmpDir,
    attachmentsDir: join(dir, 'attachments'),
    attachmentStorage,
    messageAttachmentsDir: join(dir, 'message-attachments'),
    messageAttachmentStorage,
    /** The commit the server runs, from now on (what a restart on a newer build changes). */
    setAppVersion(version: string) {
      runningVersion.value = version;
    },
    /** The Claude Code rules a session of the task gets for the task's attachment directory. */
    async attachmentRules(taskKey: string, projectKey = 'AR') {
      return attachmentToolRules(await attachmentStorage.taskDirectory(projectKey, taskKey));
    },
    /** Closes everything; fails the test if a service logged an error (e.g. a swallowed listener failure). */
    async cleanup() {
      await domain.stop();
      repos.db.close();
      rmSync(dir, { recursive: true, force: true });
      assertNoErrors(log);
    },
  };
}

export type DomainHarness = Awaited<ReturnType<typeof createDomainHarness>>;

function assertNoErrors(log: { errors: unknown[] }): void {
  if (log.errors.length > 0) {
    throw new Error(`errors were logged: ${JSON.stringify(log.errors, errorReplacer, 2)}`);
  }
}

/**
 * Stops the harness and keeps what it left (its database and customization repository) for
 * `createDomainHarness({ snapshot })`; the harness itself is gone afterwards. Set up the state
 * once, snapshot it, and start a harness from it for every test or loop round instead.
 */
export async function snapshotDomainHarness(harness: DomainHarness): Promise<HarnessSnapshot> {
  await harness.domain.stop();
  const snapshot = {
    database: harness.repos.db.serialize(),
    customization: readEntries(join(harness.dir, 'customization')),
  };
  harness.repos.db.close();
  rmSync(harness.dir, { recursive: true, force: true });
  assertNoErrors(harness.log);
  return snapshot;
}

/**
 * A restart of the server: the harness's domain stops and a new one starts over the same database
 * file, customization repository and workspace, with new fakes (nothing runs any more). The
 * harness must be `persistent`. Clean up with the returned harness; `opts` are its options (the
 * configuration is not adjusted again).
 */
export async function restartDomainHarness(
  previous: DomainHarness,
  opts: Parameters<typeof createDomainHarness>[0] = {},
): Promise<DomainHarness> {
  await previous.domain.stop();
  previous.repos.db.close();
  assertNoErrors(previous.log);
  return createDomainHarness({ ...opts, directory: previous.dir });
}
