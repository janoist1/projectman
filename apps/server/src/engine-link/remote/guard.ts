import type { FastifyBaseLogger } from 'fastify';
import type { EngineId } from '@projectman/shared';
import { conflict } from '../../kernel';
import type { EngineMethod, MethodParams } from '../methods';

/**
 * What the hub may send to which engine (PM-1061): the isolation of a hybrid installation with more than
 * one owner. Every method is classified, so a new one does not compile before it has a scope.
 * - `project`: the call names a project; only an engine bound to it gets the call (`engine_not_bound`).
 * - `host`: a machine or administration call; only the host owner's engine gets it (`engine_not_host`).
 * - `open`: the call is about something the engine already holds (a session, a folder it was handed),
 *   or about the engine itself. The engine's own answer to the project is checked where it starts.
 *
 * Methods the engine calls on the hub (`direction: 'cloud'`) never go through here; they are checked in
 * `handlers.ts` and are `open` in the table only for completeness.
 */
type Scope<M extends EngineMethod> =
  'open' | 'host' | { project: (params: MethodParams<M>) => string | undefined };
type Scopes = { [M in EngineMethod]: Scope<M> };

/** The project of a `{ project: ProjectConfig }` argument of the worktree and workspace managers. */
const inConfig = (arg: { project: { project: { key: string } } }) => arg.project.project.key;

const SCOPES: Scopes = {
  'session.start': 'open', // checked by the remote runner, which knows the project of the session
  'session.send': 'open',
  'session.compact': 'open',
  'session.stop': 'open',
  'session.close_scopes': 'open',
  'session.pause': 'open',
  'session.force_pause': 'open',
  'session.release': 'open',
  'session.assert_workspace_config': 'open',
  'terminal.attach': 'open',
  'terminal.detach': 'open',
  'terminal.input': 'open',
  'terminal.resize': 'open',
  'transcript.has_content': 'open',
  'transcript.read': 'open',
  'transcript.summary': 'open',
  'usage.plan': 'open',
  'provider.status': 'open',
  'worktree.refreshDependencies': 'open',
  'worktree.head': 'open',
  'worktree.ensureForTask': { project: ([args]) => inConfig(args) },
  'worktree.ensureMergeFix': { project: ([args]) => inConfig(args) },
  'worktree.findMergeFix': { project: ([args]) => inConfig(args) },
  'worktree.removeMergeFix': { project: ([args]) => inConfig(args) },
  'worktree.listMergeFixes': { project: ([args]) => inConfig(args) },
  'worktree.listTaskWorktrees': { project: ([args]) => inConfig(args) },
  'workspace.listSnapshotTasks': { project: ([args]) => inConfig(args) },
  'workspace.removeTaskSnapshots': { project: ([args]) => inConfig(args) },
  'worktree.find': { project: ([args]) => inConfig(args) },
  'worktree.status': 'open',
  'worktree.remove': 'open',
  'workspace.location': { project: ([key]) => inConfig(key) },
  'workspace.home': { project: ([args]) => args.projectKey },
  'workspace.ensure': { project: ([key]) => inConfig(key) },
  'workspace.status': { project: ([key]) => inConfig(key) },
  'workspace.sourceHead': { project: ([key]) => inConfig(key) },
  'workspace.fetchBase': { project: ([key]) => inConfig(key) },
  'workspace.prepareDependencies': { project: ([key]) => inConfig(key) },
  'workspace.findTaskBranch': { project: ([key]) => inConfig(key) },
  'workspace.resolveSource': 'open',
  'workspace.checkoutTaskBranch': { project: ([key]) => inConfig(key) },
  'workspace.checkoutReview': { project: ([key]) => inConfig(key) },
  'workspace.publishTaskBranch': { project: ([key]) => inConfig(key) },
  'github.is_available': 'open',
  'github.get_pull_request': 'open',
  'github.find_pull_requests_for_branch': 'open',
  'github.publish_release': 'open',
  'github.watch': 'open',
  'github.unwatch': 'open',
  // Only the merge check names its project; a diagnostics run on the host's machine carries no ref.
  'full_test.run': {
    project: ({ spec }) =>
      (spec.npmCi ?? spec.regenerate ?? spec.githubActions ?? spec.githubJob)?.ref.projectKey,
  },
  'full_test.attach': 'open',
  'full_test.report': 'open',
  'full_test.cancel': 'open',
  'screenshots.run': 'open',
  'screenshots.cancel': 'open',
  'host.free_disk': 'open',
  'host.heavy_run_sessions': 'open',
  'host.is_directory': 'open',
  'host.resolve_git_dir': 'open',
  'host.realpath': 'open',
  'host.is_real_directory': 'open',
  'host.prepare_member_sandbox_dir': 'open',
  'host.prepare_portable_paths': 'open',
  'folders.make': 'open',
  'folders.remove': 'open',
  'folders.sweep': 'open',
  'folders.release_tmp_root': 'open',
  'files.export': 'open',
  'files.materialize': { project: (params) => params.projectKey },
  'files.materialize_into_session': 'open',
  'files.resolve_scenario': 'open',
  'files.list_images': 'open',
  'merge.prepare': { project: (params) => params.ref.projectKey },
  'merge.is_ancestor': { project: (params) => params.ref.projectKey },
  'merge.build': { project: (params) => params.ref.projectKey },
  'merge.commit_regenerated': { project: (params) => params.ref.projectKey },
  'merge.checkout_conflicts': { project: (params) => params.ref.projectKey },
  'merge.checkout_for_check': { project: (params) => params.ref.projectKey },
  'merge.release_check': { project: (params) => params.ref.projectKey },
  'merge.push': { project: (params) => params.ref.projectKey },
  'merge.remote_tags': { project: (params) => params.ref.projectKey },
  'merge.push_tag': { project: (params) => params.ref.projectKey },
  'merge.advance': { project: (params) => params.ref.projectKey },
  'merge.read_file': { project: (params) => params.ref.projectKey },
  'merge.commit_files': { project: (params) => params.ref.projectKey },
  'merge.list_paths': { project: (params) => params.ref.projectKey },
  'merge.changed_paths': { project: (params) => params.ref.projectKey },
  'machine.snapshot': 'host',
  'machine.processes': 'host',
  'machine.env_values': 'host',
  'machine.signal': 'host',
  'permission.decide': 'open',
  'permission.cancel': 'open',
  'permission.forward_question': 'open',
  'mcp.relay': 'open',
  'secret.nanogpt_key': 'open',
  'engine.pause_for_shutdown': 'open',
};

/** The registry facts the guard needs. */
export interface GuardRegistry {
  /** The host owner's default engine, the machine the host's own operations run on; null when there is none. */
  hostEngine(): EngineId | null;
  /** The engine is the project's: its fallback engine, or a binding that is not revoked. */
  isBound(id: EngineId, projectKey: string): boolean;
}

export interface EngineGuard {
  /** Throws `engine_not_bound` / `engine_not_host` when the call may not go to this engine. */
  check<M extends EngineMethod>(id: EngineId, method: M, params: MethodParams<M>): void;
  /** The same rule for a project-bound call that is not a method call yet (a session start). */
  assertBound(id: EngineId, projectKey: string): void;
}

export function createEngineGuard(registry: GuardRegistry, logger: FastifyBaseLogger): EngineGuard {
  const assertBound = (id: EngineId, projectKey: string, method?: string): void => {
    if (registry.isBound(id, projectKey)) return;
    logger.warn(
      { engineId: id, projectKey, method },
      'a call for a project went to an engine not bound to it',
    );
    throw conflict('engine_not_bound', `Engine ${id} is not bound to project ${projectKey}`);
  };
  return {
    assertBound: (id, projectKey) => assertBound(id, projectKey),
    check(id, method, params) {
      const scope: Scope<typeof method> = SCOPES[method];
      if (scope === 'open') return;
      if (scope === 'host') {
        if (registry.hostEngine() === id) return;
        logger.warn({ engineId: id, method }, 'a host machine call went to an engine that is not the host');
        throw conflict('engine_not_host', `Engine ${id} is not the host's engine`);
      }
      const projectKey = scope.project(params);
      if (projectKey !== undefined) assertBound(id, projectKey, method);
    },
  };
}
