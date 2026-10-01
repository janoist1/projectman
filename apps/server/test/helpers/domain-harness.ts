import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutionProfile, ProjectConfig } from '@projectman/shared';
import { AuthService } from '../../src/auth';
import { createConfigStore } from '../../src/config';
import { createRepositories, openDatabase } from '../../src/db';
import type {
  AttachmentStorage,
  BoundaryOperationAdapter,
  GithubPublisher,
  ManagedVmBoundary,
  MemberWorkspaceManager,
  RuntimeBoundary,
} from '../../src/contracts';
import type { EgressSettings } from '../../src/domain';
import {
  attachmentToolRules,
  createAttachmentStorage,
  createDomain,
  createTemplateRegistry,
  humanActor,
} from '../../src/domain';
import type { ScheduleTimer } from '../../src/domain/schedules';
import { createMemberWorkspaceManager } from '../../src/worktree';
import type { Domain } from '../../src/domain';
import {
  capturingLogger,
  createFakeRunnerModule,
  FakeContextBuilder,
  FakeGithub,
  FakeMemoryStore,
  FakeWorktreeManager,
  planUsage,
} from './fakes';
import { testTemplate } from './test-template';

export const OWNER = { name: 'Owner', email: 'owner@example.com' };

function errorReplacer(_key: string, value: unknown): unknown {
  return value instanceof Error ? { message: value.message, stack: value.stack } : value;
}
export const OWNER_ACTOR = humanActor('owner');

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
    /** The VM boundary (PM-140); default none. */
    runtimeBoundary?: RuntimeBoundary;
    /** The network gate's settings (PM-140). */
    egress?: EgressSettings;
    /** The installation's execution profile (PM-141, default legacy) and the proof of its boundary. */
    executionProfile?: ExecutionProfile;
    managedVm?: ManagedVmBoundary;
    /** The VM's GitHub publishing identity (PM-142); absent, nothing can be published. */
    githubPublisher?: GithubPublisher;
    /** How long a session may wait for input before the owners are told (PM-199). */
    inputStallMs?: number;
  } = {},
) {
  const restarted = opts.directory !== undefined;
  const dir = opts.directory ?? mkdtempSync(join(tmpdir(), 'pm-domain-'));
  const workspace = join(dir, 'workspace');
  if (!restarted) mkdirSync(workspace);
  const repos = createRepositories(
    openDatabase(restarted || opts.persistent ? join(dir, 'db.sqlite') : ':memory:'),
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
  const liveProcesses = opts.liveProcesses ?? new Set<number>();
  const workspacesDir = join(dir, 'workspaces');

  const domain: Domain = createDomain({
    boundaryAdapter: opts.boundaryAdapter,
    runtimeBoundary: opts.runtimeBoundary,
    egress: opts.egress,
    repos,
    configStore,
    logger: log.logger,
    publicBaseUrl: 'http://127.0.0.1:4700',
    createRunner: (broker) => runnerModule.createWithBroker(broker),
    github,
    githubPublisher: opts.githubPublisher,
    inputStallMs: opts.inputStallMs,
    contextBuilder,
    memory,
    worktrees,
    attachmentStorage,
    accounts: new AuthService({ repos, now: opts.now }),
    worktreesRootDir: join(dir, 'worktrees'),
    ...(opts.memberWorkspaces
      ? {
          memberWorkspaces: (opts.wrapMemberWorkspaces ?? ((inner) => inner))(
            createMemberWorkspaceManager({ rootDir: workspacesDir, logger: log.logger }),
          ),
          workspacesRootDir: workspacesDir,
        }
      : {}),
    processExists: (pid) => liveProcesses.has(pid),
    executionProfile: opts.executionProfile,
    managedVm: opts.managedVm,
    templates: createTemplateRegistry([testTemplate]),
    planUsageTtlMs: 0,
    now: opts.now,
    scheduleTimer: opts.scheduleTimer,
    doneCleanupDelayMs: 0,
    doneTurnLimitMs: opts.doneTurnLimitMs,
    handOffRetryMs: opts.handOffRetryMs,
    // Tests call `domain.reviewWatch.check()` themselves: the timer must not fire on its own.
    reviewWatchMs: 3_600_000,
  });
  await domain.start();
  if (!restarted) {
    await domain.projects.create(
      { key: 'AR', name: 'acme', workspacePath: workspace, templateId: 'test' },
      OWNER,
    );
  }
  if (opts.adjust && !restarted) {
    await domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (draft) => {
      opts.adjust!(draft);
      return 'Adjust test configuration';
    });
  }

  return {
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
    attachmentsDir: join(dir, 'attachments'),
    attachmentStorage,
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
