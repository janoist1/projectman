import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { EngineId, MemberHandle } from '@projectman/shared';
import type {
  BranchMerger,
  EngineDirectory,
  EngineHost,
  EnginePaths,
  EngineSessionFolders,
  FullTestExecutor,
  FullTestResult,
  MemberWorkspaceManager,
  ScreenshotExecutor,
  WorkspaceFile,
  WorktreeManager,
} from '../../contracts';
import { MERGE_ERROR_CODES, MergeError, WorkspaceFileRefusal } from '../../contracts';
import type { MergeErrorCode } from '../../contracts';
import { conflict } from '../../kernel';
import type { EngineMethod, MethodParams, MethodResult } from '../methods';
import { EngineCallError } from '../rpc';
import type { CallOptions } from '../rpc';
import type { RemoteHub } from './hub';
import type { FileTransfers } from './transfers';

/**
 * The engines of the cloud mode as the domain sees them (PM-315): an `EngineHost` per registered engine
 * whose every operation is a call to that engine. What the domain asks synchronously (`paths`,
 * `workspacePath`, `processExists`, `sessionFolders.of`) is answered from the engine's `hello` and the
 * mirror (`RemoteHub`); everything that touches a disk is a method of the link (`methods.ts`).
 */

const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const FULL_TEST_GRACE_MS = 60_000;
const FULL_TEST_LINK_WAITS = 5;
const SCREENSHOT_GRACE_MS = 60_000;
const CANCEL_TIMEOUT_MS = 10_000;
// A full test's cancel is answered when the run has ended, after its processes were stopped.
const FULL_TEST_CANCEL_WAIT_MS = 60_000;
/** The step report (PM-876) is a lookup in the engine's memory; it never holds the merge back. */
const FULL_TEST_REPORT_TIMEOUT_MS = 10_000;
// One git step of the engine's merger waits up to 120 s. These are the engine's worst cases (steps in a
// row, and the five-minute dependency copy), so the cloud never gives up before the engine has.
const MERGE_WAIT_MS = 600_000; // up to five git steps
const MERGE_NETWORK_WAIT_MS = 900_000; // a fetch or a push, and the git steps around it
const MERGE_CHECKOUT_WAIT_MS = 1_200_000; // clearing a leftover, adding the worktree, the copy, the clean-up

export interface RemoteEngineDirectory extends EngineDirectory {
  /** The host of an engine even when it does not count as available (for the engine's own settings view). */
  host(id: EngineId): EngineHost | null;
}

interface RemoteDirectoryOptions {
  hub: RemoteHub;
  transfers: FileTransfers;
  logger: FastifyBaseLogger;
  now?: () => number;
}

const linkDown = (err: unknown): boolean => err instanceof EngineCallError && err.linkCode === 'link_down';

export function createRemoteEngineDirectory(options: RemoteDirectoryOptions): RemoteEngineDirectory {
  const { hub, transfers, logger } = options;
  const now = options.now ?? Date.now;
  const hosts = new Map<EngineId, EngineHost>();
  /** The runs of the screenshot executors waiting for their `screenshot_started`. */
  const started = new Map<string, () => void>();
  /** The runs of the full-test executors waiting for their `full_test_started`. */
  const fullStarted = new Map<string, () => void>();

  hub.onEvent((_id, event) => {
    if (event.kind === 'screenshot_started') started.get(event.runId)?.();
    if (event.kind === 'full_test_started') fullStarted.get(event.runId)?.();
  });
  // A folder the cloud made for a session that is not in the engine's `hello` is gone with the process.
  hub.onConnect(({ id, hello }) => {
    const mirror = hub.mirror(id);
    const live = new Set(hello.running.map((info) => info.sessionId));
    for (const sessionId of [...mirror.folders.keys()])
      if (!live.has(sessionId)) mirror.folders.delete(sessionId);
  });

  const createHost = (id: EngineId): EngineHost => {
    const call = <M extends EngineMethod>(method: M, params: MethodParams<M>, callOptions?: CallOptions) =>
      hub.call(id, method, params, callOptions);
    const helloOf = () => {
      const hello = hub.mirror(id).hello;
      if (!hello) throw conflict('engine_offline', `engine ${id} has not reported its places yet`);
      return hello;
    };

    const worktrees: WorktreeManager = {
      refreshDependencies: (cwd) => call('worktree.refreshDependencies', [cwd]),
      head: (cwd) => call('worktree.head', [cwd]),
      ensureForTask: (args) => call('worktree.ensureForTask', [args]),
      ensureMergeFix: (args) => call('worktree.ensureMergeFix', [args]),
      findMergeFix: (args) => call('worktree.findMergeFix', [args]),
      removeMergeFix: async (args) => {
        await call('worktree.removeMergeFix', [args]);
      },
      listMergeFixes: (args) => call('worktree.listMergeFixes', [args]),
      find: (args) => call('worktree.find', [args]),
      status: (cwd) => call('worktree.status', [cwd]),
      remove: async (args) => {
        await call('worktree.remove', [args]);
      },
    };

    let warnedWorkspaceSetup = false;
    const memberWorkspaces: MemberWorkspaceManager = {
      location: (key) => call('workspace.location', [key]),
      home: (key) => call('workspace.home', [key]),
      ensure: (key) => call('workspace.ensure', [key]),
      status: (key) => call('workspace.status', [key]),
      sourceHead: (key, branch) => call('workspace.sourceHead', [key, branch]),
      fetchBase: (key) => call('workspace.fetchBase', [key]),
      prepareDependencies: async (key) => {
        try {
          return await call('workspace.prepareDependencies', [key]);
        } catch (err) {
          if (!(err instanceof EngineCallError) || err.linkCode !== 'unknown_method') throw err;
          if (!warnedWorkspaceSetup) {
            warnedWorkspaceSetup = true;
            logger.warn({ engine: id }, 'the engine does not support workspace dependency preparation');
          }
          return { status: 'skipped', reason: 'not_configured' };
        }
      },
      findTaskBranch: (key, taskKey, ref) => call('workspace.findTaskBranch', [key, taskKey, ref]),
      resolveSource: (source) => call('workspace.resolveSource', [source]),
      checkoutTaskBranch: (key, request) => call('workspace.checkoutTaskBranch', [key, request]),
      checkoutReview: (key, source, roundId) => call('workspace.checkoutReview', [key, source, roundId]),
      publishTaskBranch: async (key, taskKey, branch, commit) => {
        try {
          return await call('workspace.publishTaskBranch', [key, taskKey, branch, commit]);
        } catch (err) {
          // An engine from before PM-739 cannot hand the commit over: say so, never skip the check.
          if (err instanceof EngineCallError && err.linkCode === 'unknown_method')
            throw conflict('workspace_source_missing', `engine ${id} must be updated to hand over a commit`, {
              reason: 'engine_update_required',
              method: 'workspace.publishTaskBranch',
            });
          throw err;
        }
      },
    };

    const foldersRoot = () => helloOf().paths.sessionFoldersRoot ?? '';
    const tmpRootOf = () => helloOf().paths.sessionTmpRoot ?? undefined;
    const sessionFolders: EngineSessionFolders = {
      get root() {
        return foldersRoot();
      },
      get tmpRoot() {
        return tmpRootOf();
      },
      allocate(sessionId) {
        if (!SESSION_ID.test(sessionId)) throw new Error(`Not a session id: ${JSON.stringify(sessionId)}`);
        return path.join(foldersRoot(), `${sessionId}.${randomBytes(8).toString('hex')}`);
      },
      allocateTmp(sessionId) {
        const root = tmpRootOf();
        if (!root) return undefined;
        if (!SESSION_ID.test(sessionId)) throw new Error(`Not a session id: ${JSON.stringify(sessionId)}`);
        return path.join(root, randomBytes(6).toString('hex'));
      },
      of: (sessionId) => hub.mirror(id).folders.get(sessionId),
      async make(sessionId, dir, tmpDir) {
        await call('folders.make', {
          sessionId,
          ...(dir === undefined ? {} : { dir }),
          ...(tmpDir === undefined ? {} : { tmpDir }),
        });
        // What the session had before is removed by the engine first; this is the new record.
        if (dir) hub.mirror(id).folders.set(sessionId, dir);
        else hub.mirror(id).folders.delete(sessionId);
      },
      async remove(sessionId) {
        await call('folders.remove', { sessionId });
        hub.mirror(id).folders.delete(sessionId);
      },
      async sweep(keep) {
        const mirror = hub.mirror(id);
        // The engine keeps what the cloud names and removes the rest: the sessions the cloud knows on it.
        const known = new Set([...mirror.folders.keys(), ...mirror.running.keys()]);
        const keepSessionIds = [...known].filter((sessionId) => keep(sessionId));
        const removed = await call('folders.sweep', { keepSessionIds });
        for (const sessionId of removed) mirror.folders.delete(sessionId);
        return removed;
      },
      async releaseTmpRoot() {
        // At the server's stop: an engine that is not there keeps its own folders, nothing to wait for.
        await call('folders.release_tmp_root', {}).catch((err: unknown) => {
          if (!linkDown(err)) throw err;
        });
      },
      async materializeFile(sessionId, { name, source }) {
        // The engine fetches the stored file with a single-use token and checks its size and checksum.
        const downloadToken = transfers.issueDownload(id, source);
        return call('files.materialize_into_session', {
          downloadToken,
          sessionId,
          name,
          sha256: source.sha256,
          size: source.size,
        });
      },
    };

    const runFullTest: FullTestExecutor['run'] = async (spec, signal, onStarted, options) => {
      const startedAt = now();
      const linkWaitMs = options?.linkWaitMs ?? 0;
      // An older engine never sends `full_test_started`: the caller stays at its waiting step.
      if (onStarted) fullStarted.set(spec.runId, onStarted);
      // The engine answers a cancel when the run has ended and cleaned up; one cancel serves both paths.
      let cancelled: Promise<void> | null = null;
      const cancel = (): Promise<void> => {
        cancelled ??= call(
          'full_test.cancel',
          { runId: spec.runId },
          { timeoutMs: FULL_TEST_CANCEL_WAIT_MS },
        ).then(
          () => {},
          () => {},
        );
        return cancelled;
      };
      let waitingForLink = false;
      const onAbort = () => {
        if (!waitingForLink) void cancel();
      };
      const errorResult = (
        reason: NonNullable<FullTestResult['reason']>,
        outputTail = '',
      ): FullTestResult => ({
        outcome: 'error',
        reason,
        outputTail,
        exitCode: null,
        durationMs: now() - startedAt,
        failedFiles: [],
      });
      const follow = async (): Promise<FullTestResult> => {
        for (let losses = 0; losses < FULL_TEST_LINK_WAITS; losses++) {
          waitingForLink = true;
          options?.onLinkWait?.(true);
          logger.info(
            { engineId: id, runId: spec.runId, outcome: 'waiting' },
            'a full test waits for its engine to reconnect',
          );
          const back = await hub.awaitLink(id, linkWaitMs, signal);
          if (back === 'aborted' || signal.aborted) return errorResult('killed');
          if (back === 'timeout')
            return errorResult(
              'engine_offline',
              `engine ${id} did not reconnect within ${linkWaitMs / 60_000} minutes`,
            );
          waitingForLink = false;
          options?.onLinkWait?.(false);
          try {
            const attached = await call(
              'full_test.attach',
              { runId: spec.runId },
              {
                timeoutMs: Math.max(0, spec.timeoutMs - (now() - startedAt)) + FULL_TEST_GRACE_MS,
              },
            );
            logger.info(
              {
                engineId: id,
                runId: spec.runId,
                outcome: attached.state === 'ended' ? attached.result.outcome : attached.state,
              },
              'a full test was followed after a reconnect',
            );
            return attached.state === 'ended'
              ? attached.result
              : errorResult('engine_offline', 'the engine no longer knows the run');
          } catch (err) {
            if (linkDown(err)) continue;
            if (err instanceof EngineCallError && err.linkCode === 'unknown_method') {
              await cancel();
              return errorResult(
                'engine_offline',
                'the engine cannot hand over a run after a reconnect; update it',
              );
            }
            throw err;
          }
        }
        return errorResult('engine_offline', 'the engine kept losing its link');
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
      try {
        try {
          return await call('full_test.run', { spec }, { timeoutMs: spec.timeoutMs + FULL_TEST_GRACE_MS });
        } catch (err) {
          if (linkDown(err) && linkWaitMs > 0) return await follow();
          throw err;
        }
      } catch (err) {
        logger.warn({ err, engineId: id, runId: spec.runId }, 'a full test did not end on its engine');
        // The call timed out or was cut off while the engine may still run it: a dependency installation
        // must not go on unattended (PM-681). The engine ends the run and frees its heavy-run lock; the
        // caller removes the check checkout only after that, so the cancel is waited for.
        if (err instanceof EngineCallError && err.linkCode === 'timeout') {
          await cancel();
          return {
            outcome: 'error',
            reason: signal.aborted ? 'killed' : 'timeout',
            exitCode: null,
            durationMs: now() - startedAt,
            failedFiles: [],
            outputTail: '',
          };
        }
        // An older engine's strict schema refuses `npmCi` before it runs anything (PM-681): the run is
        // blocked, never repeated without the dependency preparation it asked for.
        if (spec.npmCi && err instanceof EngineCallError && err.linkCode === 'invalid_params')
          return {
            outcome: 'error',
            reason: 'dependency_install_failed',
            exitCode: null,
            durationMs: now() - startedAt,
            failedFiles: [],
            outputTail: `engine ${id} refused the request: it does not support the dependency preparation (npmCi). Update the engine to this version of projectman.`,
          };
        // An older engine's strict schema refuses `githubActions` before it runs anything (PM-900): the
        // check is not run anywhere else.
        if (spec.githubActions && err instanceof EngineCallError && err.linkCode === 'invalid_params')
          return {
            outcome: 'error',
            reason: 'github_unavailable',
            exitCode: null,
            durationMs: now() - startedAt,
            failedFiles: [],
            outputTail: `engine ${id} refused the request: it does not support the GitHub Actions merge check (githubActions). Update the engine to this version of projectman.`,
          };
        // An older engine's strict schema refuses `requireHeavyLock` before it runs anything (PM-658):
        // the run is blocked, never repeated without the flag.
        if (spec.requireHeavyLock && err instanceof EngineCallError && err.linkCode === 'invalid_params')
          return {
            outcome: 'error',
            reason: 'heavy_lock_unavailable',
            exitCode: null,
            durationMs: now() - startedAt,
            failedFiles: [],
            outputTail: `engine ${id} refused the request: it does not support the required heavy-run queue (requireHeavyLock). Update the engine to this version of projectman.`,
          };
        if (linkDown(err)) return errorResult('engine_offline');
        // A refusal or a failed handler is not a link loss: merge callers must not restart it.
        // The engine's own words (a refusal's reason) travel with the code: they hold no secret.
        return errorResult(
          'spawn_failed',
          `engine ${id} could not execute the full test request${
            err instanceof EngineCallError ? ` (${err.linkCode}): ${err.message.slice(0, 500)}` : ''
          }`,
        );
      } finally {
        fullStarted.delete(spec.runId);
        signal.removeEventListener('abort', onAbort);
      }
    };

    const fullTestExecutor: FullTestExecutor = {
      async available() {
        // The engine's own sandbox answers at the run; here only whether it can be reached at all.
        return hub.link(id) ? { ok: true } : { ok: false, reason: 'engine_offline' };
      },
      async run(spec, signal, onStarted, options) {
        const result = await runFullTest(spec, signal, onStarted, options);
        // The step measurements (PM-876) come in their own call, so no older engine or hub breaks on
        // them. They are optional: an engine that does not know the method, no link, or any error
        // leaves them out, and the run's result stays as it is.
        // A call to an engine without a link would wait for it to come back: the report is not worth that.
        if (!hub.link(id)) return result;
        try {
          const answer = await call(
            'full_test.report',
            { runId: spec.runId },
            { timeoutMs: FULL_TEST_REPORT_TIMEOUT_MS },
          );
          return answer.state === 'ended' ? { ...result, report: answer.report } : result;
        } catch (err) {
          if (!(err instanceof EngineCallError && err.linkCode === 'unknown_method'))
            logger.info({ err, engineId: id, runId: spec.runId }, 'no step report from the engine');
          return result;
        }
      },
    };

    const screenshotExecutor: ScreenshotExecutor = {
      async run(spec, signal, onStarted) {
        started.set(spec.runId, onStarted);
        const cancel = () => {
          call('screenshots.cancel', { runId: spec.runId }, { timeoutMs: CANCEL_TIMEOUT_MS }).catch(() => {});
        };
        if (signal.aborted) cancel();
        else signal.addEventListener('abort', cancel, { once: true });
        try {
          return await call(
            'screenshots.run',
            { runId: spec.runId, spec },
            { timeoutMs: spec.timeoutMs + SCREENSHOT_GRACE_MS },
          );
        } catch (err) {
          logger.warn({ err, engineId: id, runId: spec.runId }, 'a screenshot run did not end on its engine');
          return {
            exitCode: null,
            timedOut: false,
            aborted: signal.aborted,
            spawnError: linkDown(err) ? 'engine_offline' : 'engine_error',
            output: '',
          };
        } finally {
          started.delete(spec.runId);
          signal.removeEventListener('abort', cancel);
        }
      },
    };

    // The engine's `MergeError` crosses the link as a module error: it comes out here as the same class,
    // so the caller reads a remote merger like a local one. A refusal of the link itself (`merge_not_allowed`,
    // a timeout, link down) stays an `EngineCallError`.
    const merge = async <M extends EngineMethod>(
      method: M,
      params: MethodParams<M>,
      timeoutMs: number,
    ): Promise<MethodResult<M>> => {
      try {
        return await call(method, params, { timeoutMs });
      } catch (error) {
        if (
          error instanceof EngineCallError &&
          error.linkCode === 'module_error' &&
          (MERGE_ERROR_CODES as readonly string[]).includes(error.code)
        )
          throw new MergeError(error.code as MergeErrorCode, error.message);
        throw error;
      }
    };
    // An engine from before `publish_release` (PM-968) does not know the tag methods.
    const releaseTagCall = async <T>(run: () => Promise<T>): Promise<T> => {
      try {
        return await run();
      } catch (error) {
        if (error instanceof EngineCallError && error.linkCode === 'unknown_method')
          throw new MergeError(
            'git_failed',
            `engine ${id} does not support release publishing; update the engine`,
          );
        throw error;
      }
    };
    const merger: BranchMerger = {
      prepare: (ref, input) => merge('merge.prepare', { ref, ...input }, MERGE_NETWORK_WAIT_MS),
      isAncestor: (ref, input) => merge('merge.is_ancestor', { ref, ...input }, MERGE_WAIT_MS),
      build: (ref, input) => merge('merge.build', { ref, ...input }, MERGE_WAIT_MS),
      commitRegenerated: (ref, input) => merge('merge.commit_regenerated', { ref, ...input }, MERGE_WAIT_MS),
      checkoutConflicts: (ref, input) => merge('merge.checkout_conflicts', { ref, ...input }, MERGE_WAIT_MS),
      checkoutForCheck: async (ref, input) => {
        try {
          return await merge('merge.checkout_for_check', { ref, ...input }, MERGE_CHECKOUT_WAIT_MS);
        } catch (error) {
          // An older engine's strict schema refuses `allowDependencyInstall` before it runs anything (PM-681):
          // the merge blocks, it is never asked again without the switch.
          if (
            input.allowDependencyInstall &&
            error instanceof EngineCallError &&
            error.linkCode === 'invalid_params'
          )
            throw new MergeError(
              'git_failed',
              `engine ${id} refused the request: it does not support the dependency preparation (allowDependencyInstall). Update the engine to this version of projectman.`,
            );
          throw error;
        }
      },
      releaseCheck: async (ref, input) => {
        await merge('merge.release_check', { ref, ...input }, MERGE_WAIT_MS);
      },
      push: (ref, input) => merge('merge.push', { ref, ...input }, MERGE_NETWORK_WAIT_MS),
      remoteTags: (ref, input) =>
        releaseTagCall(() => merge('merge.remote_tags', { ref, ...input }, MERGE_NETWORK_WAIT_MS)),
      pushTag: (ref, input) =>
        releaseTagCall(() => merge('merge.push_tag', { ref, ...input }, MERGE_NETWORK_WAIT_MS)),
      advance: (ref, input) => merge('merge.advance', { ref, ...input }, MERGE_WAIT_MS),
      // A read of a base fetches its upstream first.
      readFile: (ref, input) => merge('merge.read_file', { ref, ...input }, MERGE_NETWORK_WAIT_MS),
      commitFiles: (ref, input) => merge('merge.commit_files', { ref, ...input }, MERGE_WAIT_MS),
      // Local reads of the base and of the cards' branches: no fetch, but a big repository takes a while.
      listPaths: (ref, input) => merge('merge.list_paths', { ref, ...input }, MERGE_NETWORK_WAIT_MS),
      changedPaths: (ref, input) => merge('merge.changed_paths', { ref, ...input }, MERGE_NETWORK_WAIT_MS),
    };

    return {
      id,
      get platform() {
        return hub.mirror(id).hello?.platform;
      },
      paths(): EnginePaths {
        const { paths } = helloOf();
        return { ...paths, claudeTmpRoots: [...paths.claudeTmpRoots] };
      },
      worktrees,
      memberWorkspaces,
      fullTestExecutor,
      screenshotExecutor,
      merger,
      get sessionFolders() {
        return helloOf().paths.sessionFoldersRoot ? sessionFolders : undefined;
      },
      async freeDiskBytes() {
        if (!hub.link(id)) return null;
        try {
          return await call('host.free_disk', {});
        } catch {
          return null;
        }
      },
      async heavyRunSessions() {
        if (!hub.link(id)) return [];
        try {
          return await call('host.heavy_run_sessions', {});
        } catch {
          return [];
        }
      },
      processExists(pid) {
        const mirror = hub.mirror(id);
        // Without a link nothing can be said, and a process that may still run counts as running.
        if (!mirror.connected || !mirror.seen) return true;
        return [...mirror.running.values()].some((info) => info.pid === pid);
      },
      workspacePath(projectKey) {
        return (
          hub.mirror(id).hello?.projects.find((item) => item.project === projectKey)?.workspacePath ?? null
        );
      },
      async prepareMemberSandboxDir(dir) {
        await call('host.prepare_member_sandbox_dir', { dir });
      },
      async preparePortablePaths(paths) {
        try {
          await call('host.prepare_portable_paths', { paths: [...paths] });
        } catch (err) {
          logger.warn({ err, engineId: id }, 'could not prepare the portable paths');
        }
      },
      isDirectory: (target) => call('host.is_directory', { path: target }),
      resolveGitDir: (repoPath) => call('host.resolve_git_dir', { repoPath }),
      realpath: (target) => call('host.realpath', { path: target }),
      isRealDirectory: (dir) => call('host.is_real_directory', { dir }),
      async openWorkspaceFile(root, requested, opts): Promise<WorkspaceFile> {
        const ticket = transfers.issueUpload(id, 'file');
        try {
          const { sessionId, ...rest } = opts;
          const result = await call('files.export', {
            sessionId: sessionId ?? '-',
            root,
            requested,
            ...rest,
            uploadToken: ticket.token,
          });
          if (!result.ok) throw new WorkspaceFileRefusal(result.reason, result.message);
          const received = ticket.take(result);
          return {
            name: result.name,
            size: result.size,
            stream: () => createReadStream(received.path),
            // The size and checksum were compared with the engine's receipt, which it made after reading
            // the file to its end and checking that it had not changed.
            async verifyUnchanged() {
              if ((await stat(received.path)).size !== received.size)
                throw new WorkspaceFileRefusal('changed', 'The file changed while it was read');
            },
            async close() {
              ticket.dispose();
            },
          };
        } catch (err) {
          ticket.dispose();
          throw err;
        }
      },
      resolveScenario: (roots, requested) => call('files.resolve_scenario', { roots, requested }),
      listImages: (dir, sinceMs) => call('files.list_images', { dir, sinceMs }),
    };
  };

  const hostOf = (id: EngineId): EngineHost => {
    let host = hosts.get(id);
    if (!host) {
      host = createHost(id);
      hosts.set(id, host);
    }
    return host;
  };
  const usable = (id: EngineId): boolean => hub.available(id) && hub.mirror(id).hello !== null;

  const directory: RemoteEngineDirectory = {
    get: (id) => (usable(id) ? hostOf(id) : null),
    host: (id) => (hub.ids().includes(id) ? hostOf(id) : null),
    ids: () => hub.ids(),
    // The selection only: whether the chosen engine is up is `get` / `hub.available`. A project's engine
    // comes from its binding (PM-1060); `hostEngine` is the machine-wide default, the host owner's machine.
    projectEngine: (projectKey: string) => hub.projectEngine(projectKey),
    hostEngine: () => hub.defaultId(),
    engineFor: (projectKey: string, _member: MemberHandle) => directory.projectEngine(projectKey),
    onChange: (listener) => hub.onChange(listener),
    awaitConnected: (id, waitMs, signal) => hub.awaitLink(id, waitMs, signal),
  };
  return directory;
}
