import { z } from 'zod';
import {
  AgentProvider,
  FullTestErrorReason,
  HANDOFF_SUMMARY_MAX,
  HandoffSummary,
  MemoryPressure,
  PausePoint,
  PlanUsage,
  ProjectConfig,
  ProviderProblem,
} from '@projectman/shared';
import type {
  FullTestResult,
  FullTestSpec,
  BranchMerger,
  MachineSnapshot,
  MergeRepoRef,
  PermissionDecision,
  PermissionRequestInfo,
  ProviderStatus,
  QuestionForwardInfo,
  ScreenshotRunEnded,
  ScreenshotRunSpec,
  SourceHead,
  WorktreeInfo,
  WorktreeManager,
  MemberWorkspaceManager,
  SessionRunner,
  TranscriptReader,
  PlanUsageProvider,
  GithubService,
  MachineProbe,
  ProcessRecord,
  EngineHost,
  EngineSessionFolders,
  WorkspaceFileRefusal,
} from '../contracts';
import { EngineStartSpec } from './session-schemas';
import { EngineUploaded, ENGINE_UPLOAD_MAX_BYTES, PullRequest, RunningSession } from './protocol';

const text = z.string();
const texts = z.array(text);
const int = z.number().int().nonnegative();
const empty = z.strictObject({});
const done = z.null(); // Promise<void> crosses JSON as null.
const session = z.strictObject({ sessionId: text });
const pause = z.strictObject({ point: PausePoint, tool: text.nullable() }).nullable();
const checkout = z.strictObject({ branch: text.nullable(), head: text });
const source = z.strictObject({ path: text, ref: text });
const key = z.strictObject({ project: ProjectConfig, repoName: text, member: text });
const workspaceInfo = z.strictObject({ path: text, gitDir: text, cacheDir: text, tempDir: text });
const head: z.ZodType<SourceHead> = z.strictObject({
  commit: text,
  branch: text,
  dirty: z.boolean(),
  changes: int,
  path: text,
  committedAt: text.nullable(),
});
const worktreeInfo: z.ZodType<WorktreeInfo> = z.strictObject({
  gitDir: text.optional(),
  worktreeGitDir: text.optional(),
  path: text,
  branch: text,
  repo: text,
});
const fullSpec: z.ZodType<FullTestSpec> = z.strictObject({
  runId: text,
  cwd: text,
  command: text,
  maxWorkers: int,
  timeoutMs: int,
  sandbox: z.strictObject({ denyRead: texts, allowRead: texts }),
});
const fullResult: z.ZodType<FullTestResult> = z.strictObject({
  outcome: z.enum(['passed', 'failed', 'error']),
  reason: FullTestErrorReason.optional(),
  exitCode: z.number().int().nullable(),
  durationMs: int,
  failedFiles: texts,
  outputTail: text,
});
const screenshotSpec: z.ZodType<ScreenshotRunSpec> = z.strictObject({
  runId: text,
  cwd: text,
  sessionDir: text,
  browsersDir: text.optional(),
  args: texts,
  sandbox: z.strictObject({ allowWrite: texts, denyWrite: texts, denyRead: texts, allowRead: texts }),
  label: text,
  timeoutMs: int,
});
const screenshotEnded: z.ZodType<ScreenshotRunEnded> = z.strictObject({
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  aborted: z.boolean(),
  spawnError: text.optional(),
  output: text,
});
const mergeRef: z.ZodType<MergeRepoRef> = z.strictObject({ projectKey: text.max(10), repo: text.max(100) });
/** A commit id or a branch name as it crosses the wire; the engine's limit checks what they hold. */
const mergeText = text.max(200);
const mergeCall = <T extends z.ZodRawShape>(shape: T) => z.strictObject({ ref: mergeRef, ...shape });
const mergeState = z.strictObject({
  local: mergeText,
  remote: z.strictObject({ name: mergeText, commit: mergeText }).nullable(),
  relation: z.enum(['same', 'local_behind', 'local_ahead', 'diverged']),
  contains: z.strictObject({ local: z.boolean(), remote: z.boolean().nullable() }),
  checkout: text.nullable(),
});
const mergeBuilt = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), mergeCommit: mergeText, changed: z.array(text).max(1000) }),
  z.strictObject({ ok: z.literal(false), conflict: z.array(text).max(50) }),
]);
const mergePushed = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({
    ok: z.literal(false),
    reason: z.enum(['non_fast_forward', 'rejected', 'unreachable']),
    message: text.max(2000),
  }),
]);
const mergeAdvanced = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({
    ok: z.literal(false),
    reason: z.enum(['checkout_in_the_way', 'moved']),
    message: text.max(2000),
    paths: z.array(text).max(50),
  }),
]);
const snapshot: z.ZodType<MachineSnapshot> = z.strictObject({
  cpu: z.strictObject({ busyMs: z.number(), totalMs: z.number() }).nullable(),
  cores: int.nullable(),
  memoryUsedBytes: z.number().nullable(),
  memoryTotalBytes: z.number().nullable(),
  memoryPressure: MemoryPressure.nullable(),
  swapUsedBytes: z.number().nullable(),
  swapTotalBytes: z.number().nullable(),
});
const processRecord: z.ZodType<ProcessRecord> = z.strictObject({
  pid: int,
  ppid: int,
  uid: int,
  rssBytes: z.number(),
  cpuSeconds: z.number(),
  cpuPercent: z.number(),
  startedAt: z.number(),
  args: text,
});
type Callable = (...args: never[]) => unknown;
type JsonResult<T> = T extends void ? null : T;
type ResultBindings<T extends Record<string, Callable>> = {
  [K in keyof T]: { result: z.ZodType<JsonResult<Awaited<ReturnType<T[K]>>>> };
};
type ContractResults = {
  'session.start': SessionRunner['start'];
  'session.send': SessionRunner['sendUserMessage'];
  'session.compact': NonNullable<SessionRunner['compact']>;
  'session.stop': SessionRunner['stop'];
  'session.pause': SessionRunner['pause'];
  'session.force_pause': SessionRunner['forcePause'];
  'session.release': SessionRunner['release'];
  'session.assert_workspace_config': NonNullable<SessionRunner['assertWorkspaceConfig']>;
  'terminal.attach': NonNullable<SessionRunner['attachTerminal']>;
  'terminal.detach': NonNullable<SessionRunner['detachTerminal']>;
  'terminal.input': SessionRunner['writeTerminal'];
  'terminal.resize': SessionRunner['resize'];
  'transcript.has_content': TranscriptReader['hasContent'];
  'transcript.summary': TranscriptReader['summary'];
  'usage.plan': PlanUsageProvider['get'];
  'provider.status': NonNullable<SessionRunner['providerStatus']>;
  'github.is_available': GithubService['isAvailable'];
  'github.get_pull_request': GithubService['getPullRequest'];
  'github.find_pull_requests_for_branch': GithubService['findPullRequestsForBranch'];
  'machine.snapshot': MachineProbe['machine'];
  'machine.processes': MachineProbe['processes'];
  'machine.signal': MachineProbe['signal'];
  'host.free_disk': EngineHost['freeDiskBytes'];
  'host.is_directory': EngineHost['isDirectory'];
  'host.resolve_git_dir': EngineHost['resolveGitDir'];
  'host.realpath': EngineHost['realpath'];
  'host.is_real_directory': EngineHost['isRealDirectory'];
  'host.prepare_member_sandbox_dir': EngineHost['prepareMemberSandboxDir'];
  'host.prepare_portable_paths': EngineHost['preparePortablePaths'];
  'folders.make': EngineSessionFolders['make'];
  'folders.remove': EngineSessionFolders['remove'];
  'folders.sweep': EngineSessionFolders['sweep'];
  'folders.release_tmp_root': EngineSessionFolders['releaseTmpRoot'];
  'files.resolve_scenario': EngineHost['resolveScenario'];
  'files.list_images': EngineHost['listImages'];
  'merge.prepare': BranchMerger['prepare'];
  'merge.is_ancestor': BranchMerger['isAncestor'];
  'merge.build': BranchMerger['build'];
  'merge.checkout_conflicts': BranchMerger['checkoutConflicts'];
  'merge.checkout_for_check': BranchMerger['checkoutForCheck'];
  'merge.release_check': BranchMerger['releaseCheck'];
  'merge.push': BranchMerger['push'];
  'merge.advance': BranchMerger['advance'];
};
/** Named wire parameters are projections of the engine contract's argument tuples. */
type ContractParams = {
  'host.free_disk': Record<string, never>;
  'host.is_directory': { path: Parameters<EngineHost['isDirectory']>[0] };
  'host.resolve_git_dir': { repoPath: Parameters<EngineHost['resolveGitDir']>[0] };
  'host.realpath': { path: Parameters<EngineHost['realpath']>[0] };
  'host.is_real_directory': { dir: Parameters<EngineHost['isRealDirectory']>[0] };
  'host.prepare_member_sandbox_dir': { dir: Parameters<EngineHost['prepareMemberSandboxDir']>[0] };
  'host.prepare_portable_paths': { paths: Parameters<EngineHost['preparePortablePaths']>[0] };
  'folders.make': {
    sessionId: Parameters<EngineSessionFolders['make']>[0];
    dir?: Parameters<EngineSessionFolders['make']>[1];
    tmpDir?: Parameters<EngineSessionFolders['make']>[2];
  };
  'folders.remove': { sessionId: Parameters<EngineSessionFolders['remove']>[0] };
  // The predicate stays on the cloud; the engine receives its selected session IDs.
  'folders.sweep': { keepSessionIds: Parameters<Parameters<EngineSessionFolders['sweep']>[0]>[0][] };
  'folders.release_tmp_root': Record<string, never>;
  'files.resolve_scenario': {
    roots: Parameters<EngineHost['resolveScenario']>[0];
    requested: Parameters<EngineHost['resolveScenario']>[1];
  };
  'files.list_images': {
    dir: Parameters<EngineHost['listImages']>[0];
    sinceMs: Parameters<EngineHost['listImages']>[1];
  };
  // The merge calls (PM-451): the engine finds the repository from its own binding (`ref` names it).
  'merge.prepare': { ref: MergeRepoRef } & Parameters<BranchMerger['prepare']>[1];
  'merge.is_ancestor': { ref: MergeRepoRef } & Parameters<BranchMerger['isAncestor']>[1];
  'merge.build': { ref: MergeRepoRef } & Parameters<BranchMerger['build']>[1];
  'merge.checkout_conflicts': { ref: MergeRepoRef } & Parameters<BranchMerger['checkoutConflicts']>[1];
  'merge.checkout_for_check': { ref: MergeRepoRef } & Parameters<BranchMerger['checkoutForCheck']>[1];
  'merge.release_check': { ref: MergeRepoRef } & Parameters<BranchMerger['releaseCheck']>[1];
  'merge.push': { ref: MergeRepoRef } & Parameters<BranchMerger['push']>[1];
  'merge.advance': { ref: MergeRepoRef } & Parameters<BranchMerger['advance']>[1];
  // Streams and cleanup stay on the engine; only metadata and the upload receipt cross JSON.
  'files.export': {
    sessionId: string;
    root: Parameters<EngineHost['openWorkspaceFile']>[0];
    requested: Parameters<EngineHost['openWorkspaceFile']>[1];
    uploadToken: string;
  } & Parameters<EngineHost['openWorkspaceFile']>[2];
};
type ParamBindings<T> = { [K in keyof T]: { params: z.ZodType<T[K]> } };
type FileExportResult =
  | ({ ok: true; sha256: string } & Pick<
      Awaited<ReturnType<EngineHost['openWorkspaceFile']>>,
      'name' | 'size'
    >)
  | ({ ok: false } & Pick<WorkspaceFileRefusal, 'reason' | 'message'>);
const providerStatus: z.ZodType<ProviderStatus> = z.strictObject({
  provider: AgentProvider,
  loggedIn: z.boolean().nullable(),
  method: text.nullable(),
  checkedAt: text,
  detail: text.optional(),
  problem: ProviderProblem.optional(),
  cliVersion: text.optional(),
  minCliVersion: text.optional(),
});
const permissionRequest: z.ZodType<PermissionRequestInfo> = z.strictObject({
  sessionId: text,
  toolName: text,
  toolInput: z.unknown(),
  raw: z.unknown(),
});
const permissionDecision: z.ZodType<PermissionDecision> = z.discriminatedUnion('behavior', [
  z.strictObject({
    behavior: z.literal('allow'),
    updatedInput: z.unknown().optional(),
    rememberForSession: z.boolean().optional(),
  }),
  z.strictObject({ behavior: z.literal('deny'), message: text.optional() }),
]);
const question: z.ZodType<QuestionForwardInfo> = z.strictObject({
  sessionId: text,
  toolName: text,
  toolInput: z.unknown(),
});

function method<P, R>(params: z.ZodType<P>, result: z.ZodType<R>, direction: 'engine' | 'cloud' = 'engine') {
  return { params, result, direction };
}
/** Compile-time ties to each existing manager; void has the explicit JSON representation null. */
type ManagerMethods<T> = {
  [K in keyof T]: T[K] extends (...args: infer P) => infer R
    ? {
        params: z.ZodType<P>;
        result: z.ZodType<Awaited<R> extends void ? null : Awaited<R>>;
        direction: 'engine' | 'cloud';
      }
    : never;
};
const worktrees = {
  refreshDependencies: method(
    z.tuple([text]),
    z.discriminatedUnion('status', [
      z.strictObject({
        status: z.enum(['cloned', 'refreshed']),
        reference: text,
        dirs: texts,
        ms: z.number(),
      }),
      z.strictObject({
        status: z.literal('skipped'),
        reason: z.enum([
          'present',
          'disabled',
          'not_worktree',
          'no_lockfile',
          'not_ignored',
          'no_reference',
          'unsupported',
          'reference_changed',
          'target_changed',
          'failed',
        ]),
      }),
    ]),
  ),
  head: method(z.tuple([text]), head.nullable()),
  ensureForTask: method(
    z.tuple([z.strictObject({ project: ProjectConfig, repoName: text, taskKey: text, title: text })]),
    worktreeInfo,
  ),
  find: method(
    z.tuple([z.strictObject({ project: ProjectConfig, repoName: text, taskKey: text })]),
    worktreeInfo.nullable(),
  ),
  status: method(z.tuple([text]), z.strictObject({ dirty: z.boolean(), unpushedCommits: int })),
  remove: method(z.tuple([z.strictObject({ path: text, force: z.boolean().optional() })]), done),
} satisfies ManagerMethods<WorktreeManager>;
const workspaces = {
  location: method(z.tuple([key]), workspaceInfo),
  home: method(z.tuple([z.strictObject({ projectKey: text, member: text })]), text),
  ensure: method(z.tuple([key]), workspaceInfo.extend({ created: z.boolean() })),
  status: method(
    z.tuple([key]),
    z.strictObject({ dirty: z.boolean(), operation: text.nullable(), checkout: checkout.nullable() }),
  ),
  sourceHead: method(z.tuple([key, text]), head.nullable()),
  fetchBase: method(z.tuple([key]), z.strictObject({ branch: text, commit: text })),
  findTaskBranch: method(
    z.tuple([key, text, text.optional()]),
    z.strictObject({ branch: text, source: source.nullable() }).nullable(),
  ),
  resolveSource: method(z.tuple([source]), text.nullable()),
  checkoutTaskBranch: method(
    z.tuple([
      key,
      z.discriminatedUnion('mode', [
        z.strictObject({ mode: z.literal('continue'), branch: text }),
        z.strictObject({ mode: z.literal('create'), branch: text, startPoint: text }),
        z.strictObject({ mode: z.literal('fetch'), branch: text, source }),
      ]),
    ]),
    checkout,
  ),
  checkoutReview: method(z.tuple([key, source, text]), checkout),
} satisfies ManagerMethods<Omit<MemberWorkspaceManager, 'exportBranch'>>;
const transcriptOptions = z.strictObject({
  provider: AgentProvider.optional(),
  self: text.optional(),
  firstUserOrigin: z.enum(['brief', 'human']).optional(),
  cwd: text.nullable().optional(),
  confineTo: text.optional(),
});

/** The only method gateway. Receivers validate both parameters and results. */
export const methods = {
  'session.start': method(EngineStartSpec, RunningSession),
  'session.send': method(session.extend({ message: text }), done),
  'session.compact': method(session.extend({ instruction: text }), z.boolean()),
  'session.stop': method(session.extend({ force: z.boolean().optional() }), done),
  'session.pause': method(session.extend({ forceAfterMs: int.optional() }), pause),
  'session.force_pause': method(session, pause),
  'session.release': method(session.extend({ nudge: text.optional() }), z.boolean()),
  'session.assert_workspace_config': method(z.strictObject({ provider: AgentProvider, cwd: text }), done),
  'terminal.attach': method(session, z.strictObject({ data: text, cols: int, rows: int }).nullable()),
  'terminal.detach': method(session, done),
  'terminal.input': method(session.extend({ data: text }), done),
  'terminal.resize': method(session.extend({ cols: int.min(1), rows: int.min(1) }), done),
  'transcript.has_content': method(z.strictObject({ path: text, confineTo: text.optional() }), z.boolean()),
  'transcript.read': method(
    z.strictObject({ path: text, opts: transcriptOptions.optional(), uploadToken: text }),
    EngineUploaded,
  ),
  'transcript.summary': method(
    z.strictObject({ path: text, provider: AgentProvider, confineTo: text.optional() }),
    HandoffSummary.extend({ text: text.max(HANDOFF_SUMMARY_MAX) }).nullable(),
  ),
  'usage.plan': method(z.strictObject({ provider: AgentProvider }), PlanUsage.nullable()),
  'provider.status': method(
    z.strictObject({ provider: AgentProvider, refresh: z.boolean().optional(), member: text.optional() }),
    providerStatus,
  ),
  'worktree.refreshDependencies': worktrees.refreshDependencies,
  'worktree.head': worktrees.head,
  'worktree.ensureForTask': worktrees.ensureForTask,
  'worktree.find': worktrees.find,
  'worktree.status': worktrees.status,
  'worktree.remove': worktrees.remove,
  'workspace.location': workspaces.location,
  'workspace.home': workspaces.home,
  'workspace.ensure': workspaces.ensure,
  'workspace.status': workspaces.status,
  'workspace.sourceHead': workspaces.sourceHead,
  'workspace.fetchBase': workspaces.fetchBase,
  'workspace.findTaskBranch': workspaces.findTaskBranch,
  'workspace.resolveSource': workspaces.resolveSource,
  'workspace.checkoutTaskBranch': workspaces.checkoutTaskBranch,
  'workspace.checkoutReview': workspaces.checkoutReview,
  'workspace.export_branch': method(z.strictObject({ key, branch: text, uploadToken: text }), EngineUploaded),
  'github.is_available': method(empty, z.boolean()),
  'github.get_pull_request': method(z.strictObject({ repo: text, number: int.min(1) }), PullRequest),
  'github.find_pull_requests_for_branch': method(
    z.strictObject({ repo: text, branch: text }),
    z.array(PullRequest),
  ),
  'github.watch': method(
    z.strictObject({ watchId: text, targets: z.array(z.strictObject({ repo: text, number: int.min(1) })) }),
    done,
  ),
  'github.unwatch': method(z.strictObject({ watchId: text }), done),
  'full_test.run': method(z.strictObject({ spec: fullSpec }), fullResult),
  'full_test.cancel': method(z.strictObject({ runId: text }), done),
  'screenshots.run': method(z.strictObject({ runId: text, spec: screenshotSpec }), screenshotEnded),
  'screenshots.cancel': method(z.strictObject({ runId: text }), done),
  'host.free_disk': method(empty, z.number().nonnegative().nullable()),
  'host.is_directory': method(z.strictObject({ path: text }), z.boolean()),
  'host.resolve_git_dir': method(z.strictObject({ repoPath: text }), text.nullable()),
  'host.realpath': method(z.strictObject({ path: text }), text.nullable()),
  'host.is_real_directory': method(z.strictObject({ dir: text }), z.boolean()),
  'host.prepare_member_sandbox_dir': method(z.strictObject({ dir: text }), done),
  'host.prepare_portable_paths': method(z.strictObject({ paths: texts }), done),
  'folders.make': method(session.extend({ dir: text.optional(), tmpDir: text.optional() }), done),
  'folders.remove': method(session, done),
  'folders.sweep': method(z.strictObject({ keepSessionIds: texts }), texts),
  'folders.release_tmp_root': method(empty, done),
  'files.export': method(
    session.extend({
      root: text,
      requested: text,
      maxBytes: int.max(ENGINE_UPLOAD_MAX_BYTES.file),
      exactRoot: z.boolean().optional(),
      place: z
        .strictObject({ name: text, other: z.strictObject({ name: text, path: text }).optional() })
        .optional(),
      uploadToken: text,
    }),
    z.discriminatedUnion('ok', [
      EngineUploaded.extend({ ok: z.literal(true), name: text }),
      z.strictObject({
        ok: z.literal(false),
        message: text,
        reason: z.enum([
          'invalid',
          'outside',
          'missing',
          'link',
          'not_a_file',
          'too_large',
          'changed',
          'unreadable',
        ]),
      }),
    ]),
  ),
  'files.materialize': method(
    z.strictObject({
      downloadToken: text,
      projectKey: text,
      taskKey: text,
      name: text,
      sha256: text.regex(/^[a-f0-9]{64}$/),
      size: int.max(ENGINE_UPLOAD_MAX_BYTES.file),
    }),
    z.strictObject({ path: text }),
  ),
  'files.resolve_scenario': method(
    z.strictObject({ roots: z.strictObject({ cwd: text, sessionDir: text }), requested: text }),
    z.union([
      z.strictObject({ path: text }),
      z.strictObject({ refused: z.enum(['missing', 'outside', 'not_file']) }),
    ]),
  ),
  'files.list_images': method(z.strictObject({ dir: text, sinceMs: z.number() }), texts),
  'merge.prepare': method(mergeCall({ base: mergeText, commit: mergeText }), mergeState),
  'merge.is_ancestor': method(mergeCall({ ancestor: mergeText, commit: mergeText }), z.boolean().nullable()),
  'merge.build': method(
    mergeCall({ onto: mergeText, commit: mergeText, message: text.max(2000) }),
    mergeBuilt,
  ),
  'merge.checkout_conflicts': method(
    mergeCall({ base: mergeText, changed: z.array(text).max(1000) }),
    z.array(text).max(50),
  ),
  'merge.checkout_for_check': method(
    mergeCall({ mergeId: mergeText, mergeCommit: mergeText, depsFrom: text.nullable() }),
    z.strictObject({ path: text, gitDir: text }),
  ),
  'merge.release_check': method(mergeCall({ mergeId: mergeText }), done),
  'merge.push': method(mergeCall({ base: mergeText, mergeCommit: mergeText }), mergePushed),
  'merge.advance': method(mergeCall({ base: mergeText, from: mergeText, to: mergeText }), mergeAdvanced),
  'machine.snapshot': method(empty, snapshot),
  'machine.processes': method(empty, z.array(processRecord).nullable()),
  'machine.env_values': method(
    z.strictObject({ pids: z.array(int) }),
    z.array(
      z.strictObject({
        pid: int,
        values: z.strictObject({
          PROJECTMAN_SESSION_ID: text.optional(),
          PROJECTMAN_INSTANCE: text.optional(),
        }),
      }),
    ),
  ),
  'machine.signal': method(
    z.strictObject({ pid: int.min(2), signal: z.enum(['SIGTERM', 'SIGKILL']) }),
    z.enum(['sent', 'gone', 'denied']),
  ),
  'permission.decide': method(z.strictObject({ request: permissionRequest }), permissionDecision, 'cloud'),
  'permission.cancel': method(z.strictObject({ reqId: text }), done, 'cloud'),
  'permission.forward_question': method(z.strictObject({ info: question }), z.boolean(), 'cloud'),
  'mcp.relay': method(
    z.strictObject({ token: text, contentType: text, accept: text, body: text }),
    z.strictObject({ status: int, contentType: text, body: text }),
    'cloud',
  ),
  'secret.nanogpt_key': method(session, z.strictObject({ key: text }), 'cloud'),
} as const satisfies ResultBindings<ContractResults> &
  ParamBindings<ContractParams> & {
    'files.export': { result: z.ZodType<FileExportResult> };
  } & Record<string, unknown>;

export type EngineMethod = keyof typeof methods;
export type MethodParams<M extends EngineMethod> = z.output<(typeof methods)[M]['params']>;
export type MethodResult<M extends EngineMethod> = z.output<(typeof methods)[M]['result']>;
export function methodOf(name: string) {
  return Object.hasOwn(methods, name) ? methods[name as EngineMethod] : null;
}
