import { createReadStream } from 'node:fs';
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { FastifyBaseLogger } from 'fastify';
import { routes } from '@projectman/shared';
import type { AgentProvider } from '@projectman/shared';
import type {
  AdministrationPort,
  AdministrationTarget,
  EngineHost,
  FullTestExecutor,
  FullTestResult,
  MachineGithubService,
  MachineProbe,
  PlanUsageProvider,
  ScreenshotExecutor,
  SessionRunner,
  TranscriptReader,
} from '../contracts';
import { mergeCheckPath, WorkspaceFileRefusal } from '../contracts';
import { conflict } from '../kernel';
import { git } from '../worktree';
import type { EngineAudit } from './engine-audit';
import type { EngineLimit } from './engine-limit';
import type { EngineTransfers } from './engine-transfer';
import { methods } from './methods';
import type { EngineMethod, MethodParams, MethodResult } from './methods';
import type { EngineErrorCode, EngineEvent } from './protocol';
import { EngineCallError, EngineRpcError } from './rpc';
import type { EngineRpc } from './rpc';

/** The methods the cloud answers; every other method of the table is the engine's to answer. */
export const CLOUD_METHODS = [
  'permission.decide',
  'permission.cancel',
  'permission.forward_question',
  'mcp.relay',
  'secret.nanogpt_key',
] as const;
type EngineSideMethod = Exclude<EngineMethod, (typeof CLOUD_METHODS)[number]>;

/** The only variables `machine.env_values` returns: the marks of a session and of this instance. */
const ENV_VALUE_NAMES = ['PROJECTMAN_SESSION_ID', 'PROJECTMAN_INSTANCE', 'PROJECTMAN_SCOPE_ID'] as const;
const MAX_ENV_PIDS = 5000;
const MAX_WATCH_TARGETS = 500;
const MAX_WATCHES = 50;
const FULL_TEST_RESULT_KEEP_MS = 60 * 60_000;
const FULL_TEST_RESULTS_KEPT = 32;

interface FullRunRecord {
  cwd: string;
  /** A GitHub Actions run (PM-900): `merge.release_check` of this check id ends it. */
  mergeId?: string;
  ended: Promise<FullTestResult>;
  endedAt: number | null;
}
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const REFUSAL_CODES: ReadonlySet<EngineErrorCode> = new Set([
  'invalid_params',
  'unknown_method',
  'path_outside_roots',
  'permission_mode_too_high',
  'command_not_allowed',
  'terminal_input_disabled',
  'repo_not_registered',
  'signal_not_allowed',
  'secret_not_allowed',
  'merge_not_allowed',
]);

interface EngineHandlerDeps {
  limit: EngineLimit;
  audit: EngineAudit;
  runner: SessionRunner;
  transcripts: TranscriptReader;
  planUsageFor: (provider: AgentProvider) => PlanUsageProvider;
  engine: EngineHost;
  github: MachineGithubService;
  probe: MachineProbe;
  transfers: EngineTransfers;
  fullTest?: FullTestExecutor;
  screenshots?: ScreenshotExecutor;
  now?: () => number;
  logger?: Pick<FastifyBaseLogger, 'info' | 'warn'>;
  /** The engine's own loopback address (`http://127.0.0.1:<port>`) the CLIs reach hooks and team tools at. */
  mcpBase: string;
  emit: (event: EngineEvent) => void;
  /** Sessions whose terminal output the cloud asked for. */
  terminals: Set<string>;
  /** Where the bundle of a branch is made before it is uploaded. */
  exportDir: string;
  /** Runs a NanoGPT session start inside the scope in which the key may be fetched for that session. */
  nanogptStart?: <T>(sessionId: string, start: () => Promise<T>) => Promise<T>;
  /**
   * This machine's administration supervisor over its local socket (PM-763), with the one target this engine
   * answers for. Absent: the `admin.*` methods are unknown here.
   */
  administration?: { port: AdministrationPort; target: AdministrationTarget };
}

type Handlers = {
  [M in EngineSideMethod]: (params: MethodParams<M>) => Promise<MethodResult<M>>;
};

const none = null;

function sessionIdOf(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null) return undefined;
  const value = (params as { sessionId?: unknown }).sessionId;
  return typeof value === 'string' && value.length <= 128 ? value : undefined;
}
function memberOf(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null) return undefined;
  const value = (params as { member?: unknown }).member;
  return typeof value === 'string' && value.length <= 64 ? value : undefined;
}

/** A full test result as the wire schema has it: the step report travels with `full_test.report`. */
function wireFullResult(result: FullTestResult): FullTestResult {
  const { report: _report, ...wire } = result;
  return wire;
}

export function createEngineHandlers(deps: EngineHandlerDeps) {
  const { limit, audit, runner, engine, github, probe, transfers } = deps;
  const now = deps.now ?? Date.now;
  const memberWorkspaces = () => {
    if (!engine.memberWorkspaces)
      throw new EngineRpcError('unknown_method', 'This engine has no member workspaces');
    return engine.memberWorkspaces;
  };
  const folders = () => {
    if (!engine.sessionFolders)
      throw new EngineRpcError('unknown_method', 'This engine has no session folders');
    return engine.sessionFolders;
  };
  const merger = () => {
    if (!engine.merger) throw new EngineRpcError('merge_not_allowed', 'This engine does not merge');
    return engine.merger;
  };
  const administration = () => {
    if (!deps.administration) throw new EngineRpcError('unknown_method', 'This engine has no administration');
    return deps.administration;
  };
  /** The hub names a target; this engine answers for its own machine only. */
  const ownTarget = (target: AdministrationTarget) => {
    const own = administration().target;
    if (!(target.kind === 'engine' && own.kind === 'engine' && target.id === own.id))
      throw conflict('administration_target_mismatch', 'This engine manages its own machine only');
  };
  const fullRuns = new Map<string, AbortController>();
  /** Settles when the run of a `full_test.run` has ended and its executor has cleaned up. */
  const fullRunEnds = new Map<string, Promise<void>>();
  const fullRunRecords = new Map<string, FullRunRecord>();
  const shotRuns = new Map<string, AbortController>();
  const watches = new Map<string, () => void>();

  const pruneFullRunRecords = () => {
    const at = now();
    const ended = [...fullRunRecords].filter(([, record]) => record.endedAt !== null);
    ended.sort((a, b) => a[1].endedAt! - b[1].endedAt!);
    for (const [index, [runId, record]] of ended.entries()) {
      if (at - record.endedAt! >= FULL_TEST_RESULT_KEEP_MS || index < ended.length - FULL_TEST_RESULTS_KEPT)
        fullRunRecords.delete(runId);
    }
  };

  const endChecksIn = async (mergeId: string) => {
    const { worktreesRoot } = engine.paths();
    // The merger returns a canonical checkout path, even when the configured engine home is a symlink.
    const roots =
      worktreesRoot === null
        ? []
        : [...new Set([worktreesRoot, await realpath(worktreesRoot).catch(() => worktreesRoot)])];
    const checkouts = roots.map((root) => path.resolve(mergeCheckPath(root, mergeId)));
    await Promise.all(
      [...fullRunRecords].map(async ([runId, record]) => {
        if (record.endedAt !== null) return;
        const cwd = path.resolve(record.cwd);
        const inside =
          record.mergeId === mergeId ||
          checkouts.some((checkout) => {
            const relative = path.relative(checkout, cwd);
            return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
          });
        if (!inside) return;
        fullRuns.get(runId)?.abort();
        await fullRunEnds.get(runId);
        fullRunRecords.delete(runId);
        deps.logger?.info(
          { runId, mergeId },
          'engine: stopped a full test still running in a merge check checkout',
        );
      }),
    );
  };

  const upload = (token: string, purpose: 'file' | 'transcript' | 'bundle', body: Buffer) =>
    transfers.upload(limit.token(token), purpose, { size: body.length, stream: () => Readable.from([body]) });

  const handlers: Handlers = {
    async 'session.start'(spec) {
      const { mcpToken, ...rest } = spec;
      // The address is the engine's own; only the token comes from the cloud.
      const mcpUrl = `${deps.mcpBase}${routes.mcp(limit.token(mcpToken))}`;
      const start = () => runner.start({ ...rest, mcpUrl });
      // Only a NanoGPT start may ask the cloud for the key, and only while it runs.
      return deps.nanogptStart && spec.provider === 'nanogpt'
        ? deps.nanogptStart(spec.sessionId, start)
        : start();
    },
    async 'session.send'({ sessionId, message }) {
      await runner.sendUserMessage(sessionId, message);
      return none;
    },
    async 'session.compact'({ sessionId, instruction }) {
      return (await runner.compact?.(sessionId, instruction)) ?? false;
    },
    async 'session.stop'({ sessionId, force }) {
      await runner.stop(sessionId, force === undefined ? undefined : { force });
      return none;
    },
    async 'session.close_scopes'({ scopes }) {
      return (await runner.closeScopes?.(scopes)) ?? [];
    },
    async 'session.pause'({ sessionId, forceAfterMs }) {
      return runner.pause(sessionId, forceAfterMs === undefined ? undefined : { forceAfterMs });
    },
    async 'session.force_pause'({ sessionId }) {
      return runner.forcePause(sessionId);
    },
    async 'session.release'({ sessionId, nudge }) {
      return runner.release(sessionId, nudge === undefined ? undefined : { nudge });
    },
    async 'session.assert_workspace_config'({ provider, cwd }) {
      await runner.assertWorkspaceConfig?.({ provider, cwd });
      return none;
    },
    async 'terminal.attach'({ sessionId }) {
      deps.terminals.add(sessionId);
      return runner.snapshot(sessionId);
    },
    async 'terminal.detach'({ sessionId }) {
      deps.terminals.delete(sessionId);
      return none;
    },
    async 'terminal.input'({ sessionId, data }) {
      runner.writeTerminal(sessionId, data);
      return none;
    },
    async 'terminal.resize'({ sessionId, cols, rows }) {
      runner.resize(sessionId, cols, rows);
      return none;
    },
    async 'transcript.has_content'({ path: file, confineTo }) {
      return deps.transcripts.hasContent(file, confineTo === undefined ? undefined : { confineTo });
    },
    async 'transcript.read'({ path: file, opts, uploadToken }) {
      const items = await deps.transcripts.read(file, opts);
      return upload(uploadToken, 'transcript', Buffer.from(JSON.stringify(items)));
    },
    async 'transcript.summary'({ path: file, provider, confineTo }) {
      return deps.transcripts.summary(file, { provider, ...(confineTo === undefined ? {} : { confineTo }) });
    },
    async 'usage.plan'({ provider }) {
      return deps.planUsageFor(provider).get();
    },
    async 'provider.status'({ provider, refresh, member }) {
      if (!runner.providerStatus)
        throw new EngineRpcError('unknown_method', 'This runner has no provider status');
      return runner.providerStatus(provider, {
        ...(refresh === undefined ? {} : { refresh }),
        ...(member === undefined ? {} : { member }),
      });
    },
    async 'worktree.refreshDependencies'([cwd]) {
      return engine.worktrees.refreshDependencies(cwd);
    },
    async 'worktree.head'([cwd]) {
      return engine.worktrees.head(cwd);
    },
    async 'worktree.ensureForTask'([arg]) {
      return engine.worktrees.ensureForTask(arg);
    },
    async 'worktree.ensureMergeFix'([arg]) {
      return engine.worktrees.ensureMergeFix(arg);
    },
    async 'worktree.findMergeFix'([arg]) {
      return engine.worktrees.findMergeFix(arg);
    },
    async 'worktree.removeMergeFix'([arg]) {
      await engine.worktrees.removeMergeFix(arg);
      return none;
    },
    async 'worktree.listMergeFixes'([arg]) {
      return engine.worktrees.listMergeFixes(arg);
    },
    async 'worktree.find'([arg]) {
      return engine.worktrees.find(arg);
    },
    async 'worktree.status'([cwd]) {
      return engine.worktrees.status(cwd);
    },
    async 'worktree.remove'([arg]) {
      await engine.worktrees.remove(arg);
      return none;
    },
    async 'workspace.location'([key]) {
      return memberWorkspaces().location(key);
    },
    async 'workspace.home'([arg]) {
      return memberWorkspaces().home(arg);
    },
    async 'workspace.ensure'([key]) {
      return memberWorkspaces().ensure(key);
    },
    async 'workspace.status'([key]) {
      return memberWorkspaces().status(key);
    },
    async 'workspace.sourceHead'([key, branch]) {
      return memberWorkspaces().sourceHead(key, branch);
    },
    async 'workspace.fetchBase'([key]) {
      return memberWorkspaces().fetchBase(key);
    },
    async 'workspace.prepareDependencies'([key]) {
      return memberWorkspaces().prepareDependencies(key);
    },
    async 'workspace.findTaskBranch'([key, taskKey, ref]) {
      return memberWorkspaces().findTaskBranch(key, taskKey, ref);
    },
    async 'workspace.resolveSource'([source]) {
      return memberWorkspaces().resolveSource(source);
    },
    async 'workspace.checkoutTaskBranch'([key, checkout]) {
      return memberWorkspaces().checkoutTaskBranch(key, checkout);
    },
    async 'workspace.checkoutReview'([key, source, commit]) {
      return memberWorkspaces().checkoutReview(key, source, commit);
    },
    async 'workspace.publishTaskBranch'([key, taskKey, branch, commit]) {
      return memberWorkspaces().publishTaskBranch(key, taskKey, branch, commit);
    },
    async 'github.is_available'() {
      return github.isAvailable();
    },
    async 'github.get_pull_request'({ repo, number }) {
      return github.getPullRequest(repo, number);
    },
    async 'github.find_pull_requests_for_branch'({ repo, branch }) {
      return github.findPullRequestsForBranch(repo, branch);
    },
    async 'github.publish_release'({ repo, ...input }) {
      return github.publishRelease(repo, input);
    },
    async 'github.watch'({ watchId, targets }) {
      if (targets.length > MAX_WATCH_TARGETS)
        throw new EngineRpcError('invalid_params', 'Too many pull requests');
      if (!watches.has(watchId) && watches.size >= MAX_WATCHES)
        throw new EngineRpcError('invalid_params', 'Too many watches');
      watches.get(watchId)?.();
      watches.set(
        watchId,
        github.watch(targets, (change) => deps.emit({ kind: 'github_changed', watchId, change })),
      );
      return none;
    },
    async 'github.unwatch'({ watchId }) {
      watches.get(watchId)?.();
      watches.delete(watchId);
      return none;
    },
    async 'full_test.run'({ spec }) {
      pruneFullRunRecords();
      if (!engine.fullTestExecutor)
        throw new EngineRpcError('command_not_allowed', 'This engine runs no full test');
      const controller = new AbortController();
      fullRuns.set(spec.runId, controller);
      const running = (async () =>
        engine.fullTestExecutor!.run(spec, controller.signal, () =>
          deps.emit({ kind: 'full_test_started', runId: spec.runId }),
        ))();
      const record: FullRunRecord = {
        cwd: spec.cwd,
        ...(spec.githubActions ? { mergeId: spec.githubActions.mergeId } : {}),
        ended: running,
        endedAt: null,
      };
      fullRunRecords.set(spec.runId, record);
      fullRunEnds.set(
        spec.runId,
        running.then(
          () => {},
          () => {},
        ),
      );
      try {
        return wireFullResult(await running);
      } finally {
        record.endedAt = now();
        fullRuns.delete(spec.runId);
        fullRunEnds.delete(spec.runId);
        pruneFullRunRecords();
      }
    },
    async 'full_test.attach'({ runId }) {
      pruneFullRunRecords();
      const record = fullRunRecords.get(runId);
      if (!record) return { state: 'unknown' };
      return { state: 'ended', result: wireFullResult(await record.ended) };
    },
    // The measurements of an ended run (PM-876): their own call, because the strict result schema of
    // `full_test.run` and `attach` stays as older hubs know it.
    async 'full_test.report'({ runId }) {
      pruneFullRunRecords();
      const record = fullRunRecords.get(runId);
      if (!record) return { state: 'unknown' };
      return { state: 'ended', report: (await record.ended).report ?? null };
    },
    async 'full_test.cancel'({ runId }) {
      fullRuns.get(runId)?.abort();
      // The answer comes when the run has ended: the cloud removes the check checkout after it (PM-681),
      // so a dependency installation must be gone by then.
      await fullRunEnds.get(runId);
      fullRunRecords.delete(runId);
      return none;
    },
    async 'screenshots.run'({ runId, spec }) {
      if (!engine.screenshotExecutor)
        throw new EngineRpcError('command_not_allowed', 'This engine takes no screenshots');
      const controller = new AbortController();
      shotRuns.set(runId, controller);
      try {
        return await engine.screenshotExecutor.run(spec, controller.signal, () =>
          deps.emit({ kind: 'screenshot_started', runId }),
        );
      } finally {
        shotRuns.delete(runId);
      }
    },
    async 'screenshots.cancel'({ runId }) {
      shotRuns.get(runId)?.abort();
      return none;
    },
    async 'host.free_disk'() {
      return engine.freeDiskBytes();
    },
    async 'host.heavy_run_sessions'() {
      const ids = await engine.heavyRunSessions();
      const running = new Set(runner.list().map((session) => session.sessionId));
      return ids.filter((id) => running.has(id));
    },
    async 'host.is_directory'({ path: target }) {
      return engine.isDirectory(target);
    },
    async 'host.resolve_git_dir'({ repoPath }) {
      return engine.resolveGitDir(repoPath);
    },
    async 'host.realpath'({ path: target }) {
      return engine.realpath(target);
    },
    async 'host.is_real_directory'({ dir }) {
      return engine.isRealDirectory(dir);
    },
    async 'host.prepare_member_sandbox_dir'({ dir }) {
      await engine.prepareMemberSandboxDir(dir);
      return none;
    },
    async 'host.prepare_portable_paths'({ paths }) {
      await engine.preparePortablePaths(paths);
      return none;
    },
    async 'folders.make'({ sessionId, dir, tmpDir }) {
      await folders().make(sessionId, dir, tmpDir);
      return none;
    },
    async 'folders.remove'({ sessionId }) {
      await folders().remove(sessionId);
      return none;
    },
    async 'folders.sweep'({ keepSessionIds }) {
      const keep = new Set(keepSessionIds);
      return folders().sweep((sessionId) => keep.has(sessionId));
    },
    async 'folders.release_tmp_root'() {
      await folders().releaseTmpRoot();
      return none;
    },
    async 'files.export'({ root, requested, maxBytes, exactRoot, place, uploadToken }) {
      let file;
      try {
        file = await engine.openWorkspaceFile(root, requested, {
          maxBytes,
          ...(place ? { place } : {}),
          ...(exactRoot === undefined ? {} : { exactRoot }),
        });
      } catch (error) {
        if (error instanceof WorkspaceFileRefusal)
          return { ok: false as const, reason: error.reason, message: error.message };
        throw error;
      }
      try {
        const receipt = await transfers.upload(limit.token(uploadToken), 'file', {
          size: file.size,
          stream: () => file.stream(),
        });
        await file.verifyUnchanged();
        return { ok: true as const, name: file.name, ...receipt };
      } catch (error) {
        if (error instanceof WorkspaceFileRefusal)
          return { ok: false as const, reason: error.reason, message: error.message };
        throw error;
      } finally {
        await file.close();
      }
    },
    async 'files.materialize'({ downloadToken, projectKey, taskKey, name, sha256, size }) {
      const dest = limit.cachePath(projectKey, taskKey, name);
      await transfers.download(limit.token(downloadToken), dest, { size, sha256 });
      return { path: dest };
    },
    async 'files.materialize_into_session'({ downloadToken, sessionId, name, sha256, size }) {
      // Fetched into a folder of the engine's own that no session reaches, then put into the session's
      // folder by the registry, which checks the file again and writes nowhere else.
      const scratch = await mkdtemp(path.join(deps.exportDir, 'session-file-'));
      try {
        const staged = path.join(scratch, 'file');
        await transfers.download(limit.token(downloadToken), staged, { size, sha256 });
        return await folders().materializeFile(sessionId, { name, source: { path: staged, size, sha256 } });
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },
    async 'files.resolve_scenario'({ roots, requested }) {
      return engine.resolveScenario(roots, requested);
    },
    async 'files.list_images'({ dir, sinceMs }) {
      return engine.listImages(dir, sinceMs);
    },
    async 'merge.prepare'({ ref, ...input }) {
      return merger().prepare(ref, input);
    },
    async 'merge.is_ancestor'({ ref, ...input }) {
      return merger().isAncestor(ref, input);
    },
    async 'merge.build'({ ref, ...input }) {
      return merger().build(ref, input);
    },
    async 'merge.commit_regenerated'({ ref, ...input }) {
      return merger().commitRegenerated(ref, input);
    },
    async 'merge.checkout_conflicts'({ ref, ...input }) {
      return merger().checkoutConflicts(ref, input);
    },
    async 'merge.checkout_for_check'({ ref, ...input }) {
      await endChecksIn(input.mergeId);
      return merger().checkoutForCheck(ref, input);
    },
    async 'merge.release_check'({ ref, ...input }) {
      await endChecksIn(input.mergeId);
      await merger().releaseCheck(ref, input);
      return none;
    },
    async 'merge.push'({ ref, ...input }) {
      return merger().push(ref, input);
    },
    async 'merge.remote_tags'({ ref, ...input }) {
      return merger().remoteTags(ref, input);
    },
    async 'merge.push_tag'({ ref, ...input }) {
      return merger().pushTag(ref, input);
    },
    async 'merge.advance'({ ref, ...input }) {
      return merger().advance(ref, input);
    },
    async 'merge.read_file'({ ref, ...input }) {
      return merger().readFile(ref, input);
    },
    async 'merge.commit_files'({ ref, ...input }) {
      return merger().commitFiles(ref, input);
    },
    async 'merge.list_paths'({ ref, ...input }) {
      return merger().listPaths(ref, input);
    },
    async 'merge.changed_paths'({ ref, ...input }) {
      return merger().changedPaths(ref, input);
    },
    async 'machine.snapshot'() {
      return probe.machine();
    },
    async 'machine.processes'() {
      return probe.processes();
    },
    async 'machine.env_values'({ pids }) {
      if (pids.length > MAX_ENV_PIDS) throw new EngineRpcError('invalid_params', 'Too many processes');
      const found = await probe.envValues(pids, [...ENV_VALUE_NAMES]);
      return [...found].map(([pid, values]) => ({
        pid,
        // Only the two marks, whatever else the probe returned.
        values: Object.fromEntries(
          ENV_VALUE_NAMES.flatMap((name) => (values[name] === undefined ? [] : [[name, values[name]]])),
        ),
      }));
    },
    async 'machine.signal'({ pid, signal }) {
      return limit.signal(pid, signal);
    },
    async 'admin.status'({ target }) {
      ownTarget(target);
      return administration().port.status(target);
    },
    async 'admin.logs'({ target, ...options }) {
      ownTarget(target);
      return administration().port.logs(target, options);
    },
    async 'admin.machine'({ target }) {
      ownTarget(target);
      return administration().port.machine(target);
    },
    async 'admin.submit'(input) {
      // Targeted commands name their machine; the deploy of a release is the hub's and never runs
      // on an engine.
      if (
        input.command.kind === 'restart' ||
        input.command.kind === 'process_cleanup' ||
        input.command.kind === 'owner_command'
      )
        ownTarget(input.command.target);
      if (input.command.kind === 'deploy')
        throw conflict('administration_target_mismatch', 'A deployment is not an engine operation');
      return administration().port.submit(input);
    },
    async 'admin.inspect'({ operationId }) {
      return administration().port.inspect(operationId);
    },
  };

  const refusedBeforeHandler = (request: {
    id: string;
    method: string;
    code: 'unknown_method' | 'invalid_params';
  }) =>
    audit.record({
      reqId: request.id,
      method: request.method,
      outcome: 'refused',
      code: request.code,
    });

  /** Registers every handler of the table on a connection's RPC, each behind the limit and the audit log. */
  const register = (rpc: EngineRpc) => {
    for (const method of Object.keys(methods) as EngineMethod[]) {
      if ((CLOUD_METHODS as readonly string[]).includes(method)) continue;
      const name = method as EngineSideMethod;
      const run = handlers[name] as (params: unknown) => Promise<unknown>;
      rpc.handle(name, async (params, context) => {
        const entry = {
          reqId: context.id,
          method: name,
          ...(sessionIdOf(params) ? { sessionId: sessionIdOf(params)! } : {}),
          ...(memberOf(params) ? { member: memberOf(params)! } : {}),
        };
        try {
          const checked = await limit.check(name, params as never);
          const result = await run(checked);
          audit.record({ ...entry, outcome: 'ok' });
          return result as never;
        } catch (error) {
          const code: EngineErrorCode = error instanceof EngineCallError ? error.linkCode : 'internal';
          audit.record({ ...entry, outcome: REFUSAL_CODES.has(code) ? 'refused' : 'error', code });
          // The hub sees only the code (and, for a refusal, its message): the cause stays in this log (PM-915).
          deps.logger?.warn({ err: error, method: name, code }, 'engine link: a request ended with an error');
          throw error;
        }
      });
    }
  };

  return {
    register,
    refusedBeforeHandler,
    /** Stops what runs for the cloud when the link is gone for good or the engine stops. */
    dispose() {
      for (const controller of [...fullRuns.values(), ...shotRuns.values()]) controller.abort();
      fullRunRecords.clear();
      for (const unwatch of watches.values()) unwatch();
      watches.clear();
    },
  };
}
