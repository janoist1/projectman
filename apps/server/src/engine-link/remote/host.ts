import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { EngineId, MemberHandle } from '@projectman/shared';
import type {
  EngineDirectory,
  EngineHost,
  EnginePaths,
  EngineSessionFolders,
  FullTestExecutor,
  MemberWorkspaceManager,
  ScreenshotExecutor,
  WorkspaceFile,
  WorktreeManager,
} from '../../contracts';
import { WorkspaceFileRefusal } from '../../contracts';
import { conflict } from '../../domain/errors';
import type { EngineMethod, MethodParams } from '../methods';
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
const SCREENSHOT_GRACE_MS = 60_000;
const CANCEL_TIMEOUT_MS = 10_000;

export interface RemoteEngineDirectory extends EngineDirectory {
  /** The host of an engine even when it does not count as available (for the engine's own settings view). */
  host(id: EngineId): EngineHost | null;
}

export interface RemoteDirectoryOptions {
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

  hub.onEvent((_id, event) => {
    if (event.kind === 'screenshot_started') started.get(event.runId)?.();
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
      find: (args) => call('worktree.find', [args]),
      status: (cwd) => call('worktree.status', [cwd]),
      remove: async (args) => {
        await call('worktree.remove', [args]);
      },
    };

    const memberWorkspaces: MemberWorkspaceManager = {
      location: (key) => call('workspace.location', [key]),
      home: (key) => call('workspace.home', [key]),
      ensure: (key) => call('workspace.ensure', [key]),
      status: (key) => call('workspace.status', [key]),
      sourceHead: (key, branch) => call('workspace.sourceHead', [key, branch]),
      fetchBase: (key) => call('workspace.fetchBase', [key]),
      findTaskBranch: (key, taskKey, ref) => call('workspace.findTaskBranch', [key, taskKey, ref]),
      resolveSource: (source) => call('workspace.resolveSource', [source]),
      checkoutTaskBranch: (key, request) => call('workspace.checkoutTaskBranch', [key, request]),
      checkoutReview: (key, source, roundId) => call('workspace.checkoutReview', [key, source, roundId]),
      async exportBranch(key, branch) {
        // The bundle goes over the file endpoint into the cloud's spool; the cloud reads it from there.
        const ticket = transfers.issueUpload(id, 'bundle');
        try {
          const receipt = await call('workspace.export_branch', { key, branch, uploadToken: ticket.token });
          const received = ticket.take(receipt);
          return { path: received.path, bundle: true, done: async () => ticket.dispose() };
        } catch (err) {
          ticket.dispose();
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
    };

    const fullTestExecutor: FullTestExecutor = {
      async available() {
        // The engine's own sandbox answers at the run; here only whether it can be reached at all.
        return hub.link(id) ? { ok: true } : { ok: false, reason: 'engine_offline' };
      },
      async run(spec, signal) {
        const startedAt = now();
        const cancel = () => {
          call('full_test.cancel', { runId: spec.runId }, { timeoutMs: CANCEL_TIMEOUT_MS }).catch(() => {});
        };
        if (signal.aborted) cancel();
        else signal.addEventListener('abort', cancel, { once: true });
        try {
          return await call('full_test.run', { spec }, { timeoutMs: spec.timeoutMs + FULL_TEST_GRACE_MS });
        } catch (err) {
          logger.warn({ err, engineId: id, runId: spec.runId }, 'a full test did not end on its engine');
          return {
            outcome: 'error',
            reason: 'engine_offline',
            exitCode: null,
            durationMs: now() - startedAt,
            failedFiles: [],
            outputTail: '',
          };
        } finally {
          signal.removeEventListener('abort', cancel);
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

  return {
    get: (id) => (usable(id) ? hostOf(id) : null),
    host: (id) => (hub.ids().includes(id) ? hostOf(id) : null),
    ids: () => hub.ids(),
    engineFor: (_projectKey: string, _member: MemberHandle) => hub.defaultId(),
    onChange: (listener) => hub.onChange(listener),
  };
}
