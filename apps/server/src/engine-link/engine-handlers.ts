import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { routes } from '@projectman/shared';
import type { AgentProvider } from '@projectman/shared';
import type {
  EngineHost,
  FullTestExecutor,
  GithubService,
  MachineProbe,
  PlanUsageProvider,
  ScreenshotExecutor,
  SessionRunner,
  TranscriptReader,
} from '../contracts';
import { WorkspaceFileRefusal } from '../contracts';
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
export type EngineSideMethod = Exclude<EngineMethod, (typeof CLOUD_METHODS)[number]>;

/** The only variables `machine.env_values` returns: the marks of a session and of this instance. */
export const ENV_VALUE_NAMES = ['PROJECTMAN_SESSION_ID', 'PROJECTMAN_INSTANCE'] as const;
const MAX_ENV_PIDS = 5000;
const MAX_WATCH_TARGETS = 500;
const MAX_WATCHES = 50;
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

export interface EngineHandlerDeps {
  limit: EngineLimit;
  audit: EngineAudit;
  runner: SessionRunner;
  transcripts: TranscriptReader;
  planUsageFor: (provider: AgentProvider) => PlanUsageProvider;
  engine: EngineHost;
  github: GithubService;
  probe: MachineProbe;
  transfers: EngineTransfers;
  fullTest?: FullTestExecutor;
  screenshots?: ScreenshotExecutor;
  /** The engine's own loopback address (`http://127.0.0.1:<port>`) the CLIs reach hooks and team tools at. */
  mcpBase: string;
  emit: (event: EngineEvent) => void;
  /** Sessions whose terminal output the cloud asked for. */
  terminals: Set<string>;
  /** Where the bundle of a branch is made before it is uploaded. */
  exportDir: string;
  /** Runs a NanoGPT session start inside the scope in which the key may be fetched for that session. */
  nanogptStart?: <T>(sessionId: string, start: () => Promise<T>) => Promise<T>;
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

export function createEngineHandlers(deps: EngineHandlerDeps) {
  const { limit, audit, runner, engine, github, probe, transfers } = deps;
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
  const fullRuns = new Map<string, AbortController>();
  const shotRuns = new Map<string, AbortController>();
  const watches = new Map<string, () => void>();

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
    async 'workspace.export_branch'({ key, branch, uploadToken }) {
      if (!BRANCH.test(branch) || branch.includes('..') || branch.endsWith('/') || branch.endsWith('.lock'))
        throw new EngineRpcError('invalid_params', 'Invalid branch name');
      limit.token(uploadToken);
      const exported = await memberWorkspaces().exportBranch(key, branch);
      let bundle = exported.path;
      let scratch: string | null = null;
      try {
        if (!exported.bundle) {
          // The workspace is on this disk: the cloud receives a bundle of just that branch.
          scratch = await mkdtemp(path.join(deps.exportDir, 'branch-'));
          bundle = path.join(scratch, 'branch.bundle');
          await git(['-C', exported.path, 'bundle', 'create', bundle, `refs/heads/${branch}`], {
            isolatedConfig: true,
          });
        }
        const size = (await stat(bundle)).size;
        return await transfers.upload(uploadToken, 'bundle', {
          size,
          stream: () => createReadStream(bundle),
        });
      } finally {
        if (scratch) await rm(scratch, { recursive: true, force: true });
        await exported.done();
      }
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
      if (!engine.fullTestExecutor)
        throw new EngineRpcError('command_not_allowed', 'This engine runs no full test');
      const controller = new AbortController();
      fullRuns.set(spec.runId, controller);
      try {
        return await engine.fullTestExecutor.run(spec, controller.signal);
      } finally {
        fullRuns.delete(spec.runId);
      }
    },
    async 'full_test.cancel'({ runId }) {
      fullRuns.get(runId)?.abort();
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
    async 'merge.checkout_conflicts'({ ref, ...input }) {
      return merger().checkoutConflicts(ref, input);
    },
    async 'merge.checkout_for_check'({ ref, ...input }) {
      return merger().checkoutForCheck(ref, input);
    },
    async 'merge.release_check'({ ref, ...input }) {
      await merger().releaseCheck(ref, input);
      return none;
    },
    async 'merge.push'({ ref, ...input }) {
      return merger().push(ref, input);
    },
    async 'merge.advance'({ ref, ...input }) {
      return merger().advance(ref, input);
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
      for (const unwatch of watches.values()) unwatch();
      watches.clear();
    },
  };
}
