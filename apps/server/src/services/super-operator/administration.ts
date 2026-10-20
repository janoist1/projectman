import { memberOf } from '@projectman/shared';
import type { EngineId, Release, SuperCommand, Task } from '@projectman/shared';
import type {
  AdministrationJob,
  AdministrationPort,
  AdministrationResult,
  OperatorGrantGate,
} from '../../contracts';
import type { DomainContext } from '../../core/base';
import type { ProjectService } from '../../core/projects';
import type { TimelineService } from '../../core/timeline';
import { DomainError, SYSTEM_ACTOR, conflict, forbidden, integratorExecution, invalid } from '../../kernel';
import type { SuperCommandExecutor, SuperCommandSettler, SuperSettlement } from './handoffs';
import type { SuperRights } from './rights';

type AdministrationRequest = Extract<SuperCommand, { kind: 'administration' }>['request'];

/** What the hub executor needs besides the administration port; the composition supplies each one. */
export interface SuperAdministrationDeps {
  ctx: DomainContext;
  /** The owner's grant for machine operations; checked before every submit. */
  grants: OperatorGrantGate;
  administration: AdministrationPort;
  rights: SuperRights;
  projects: Pick<ProjectService, 'config'>;
  timeline: TimelineService;
  /** Whether the engine is linked to the project (it holds its workspace or one of its members runs on it). */
  engineLinked(projectKey: string, engineId: EngineId): boolean;
  /** The one engine that runs a full test or builds an image; null: none. */
  builderEngine(): EngineId | null;
  /** The release this instance deploys, or throws (`release_not_configured`): the control-socket view of it. */
  release(releaseId: string): Release;
}

/** The commits of a card that a test or a build may be pinned to: its review pin, its merge and its merged commit. */
export function cardCommits(ctx: DomainContext, task: Task): string[] {
  const pin = ctx.repos.reviewPins.get(task.key);
  return [...new Set([pin?.commit, task.merge?.commit, task.merged?.commit].filter(isString))];
}

const isString = (value: string | undefined): value is string => typeof value === 'string' && value !== '';

/** The result kind a finished full test records on the operation: a pass has none. */
const FULL_TEST_RESULT = { passed: null, failed: 'full_test_failed', error: 'full_test_error' } as const;

/**
 * The executor of the `administration` command kind (PM-764). It re-checks everything the request was
 * authorized for directly before it starts anything (the key is still active, its owner still owns every
 * affected project, the engine is linked to the project, the commit is one of the card's, the release is the
 * one a human approved), then hands the validated command to the protected adapter and goes on as a
 * detached operation. It builds no program, path or argument: the command is the closed shape the adapter takes.
 */
export function createAdministrationExecutor(deps: SuperAdministrationDeps): SuperCommandExecutor {
  return async (job) => {
    const { command, operation } = job;
    if (command.kind !== 'administration') throw invalid('invalid_request', 'not an administration command');
    const request = command.request;
    const scope = integratorExecution();
    if (!scope || scope.principal.mode !== 'super')
      throw forbidden(
        'integrator_not_allowed',
        'only the integrator in super mode runs an administration job',
      );
    const projectKey = operation.projectKey;
    // The owner's switch: no grant, no machine operation, however valid the key is (PM-881). The executor runs on
    // every start and on the continuation after the owner's yes, so both stop at once when the grant is gone.
    deps.grants.assertActive();
    await authorize(deps, scope.principal, projectKey, operation.taskKey, request);
    try {
      await deps.administration.submit({
        operationId: operation.id,
        requestId: operation.requestId,
        command: request,
      });
    } catch (error) {
      // Nothing was recorded for the operation: the supervisor never took it, so it is a plain failure.
      if (error instanceof DomainError && error.code === 'administration_unavailable') {
        const known = await deps.administration.inspect(operation.id).then(
          () => true,
          (inspectError: unknown) =>
            !(inspectError instanceof DomainError && inspectError.code === 'not_found'),
        );
        if (!known) throw conflict('administration_unavailable', error.message);
      }
      throw error;
    }
    return { pending: true };
  };
}

async function authorize(
  deps: SuperAdministrationDeps,
  principal: NonNullable<ReturnType<typeof integratorExecution>>['principal'],
  projectKey: string,
  taskKey: string | null,
  request: AdministrationRequest,
): Promise<void> {
  switch (request.kind) {
    case 'restart':
    case 'process_cleanup': {
      if (request.target.kind === 'hub') {
        // The hub serves every project: each one's owner right is needed.
        await deps.rights.assertNow(principal, [projectKey, ...deps.rights.allProjectKeys()], 'write');
        return;
      }
      await deps.rights.assertNow(principal, [projectKey], 'write');
      if (!deps.engineLinked(projectKey, request.target.id))
        throw forbidden('administration_target_mismatch', 'the engine is not linked to this project');
      return;
    }
    case 'full_test':
    case 'image_build': {
      await deps.rights.assertNow(principal, [projectKey], 'write');
      if (!taskKey || taskKey !== request.taskKey)
        throw invalid('invalid_request', 'the command names another card than the operation');
      const task = deps.ctx.repos.tasks.get(taskKey);
      if (!task || task.projectKey !== projectKey)
        throw invalid('invalid_request', 'the card is not in this project');
      if (!cardCommits(deps.ctx, task).includes(request.commit))
        throw invalid('invalid_request', 'the commit is not one of the card’s commits');
      const builder = deps.builderEngine();
      if (!builder || !deps.engineLinked(projectKey, builder))
        throw forbidden('administration_target_mismatch', 'the builder engine is not linked to this project');
      return;
    }
    case 'deploy': {
      // A deployment switches the hub for every project.
      await deps.rights.assertNow(principal, [projectKey, ...deps.rights.allProjectKeys()], 'write');
      const release = deps.release(request.releaseId);
      if (release.projectKey !== projectKey)
        throw conflict('release_target_mismatch', 'the release belongs to another project');
      const config = await deps.projects.config(projectKey);
      const decider = release.decidedBy ? memberOf(config, release.decidedBy) : null;
      if (release.state !== 'approved' || decider?.kind !== 'human' || decider.access !== 'owner')
        throw conflict('release_state_conflict', 'only a release a human owner approved is deployed');
      return;
    }
    default: {
      const unknown: never = request;
      throw invalid(
        'invalid_request',
        `unknown administration command ${String((unknown as { kind?: unknown }).kind)}`,
      );
    }
  }
}

/**
 * Finishes an administration operation from the result the supervisor recorded. It only inspects: it never
 * submits or starts anything, so a retry, a restart or a second reader cannot run the operation twice. A full
 * test also lands on its card as `task_full_test` (no output, no raw error: the result kind only).
 */
export function createAdministrationSettler(deps: SuperAdministrationDeps): SuperCommandSettler {
  return async ({ operation, command }): Promise<SuperSettlement> => {
    if (command.kind !== 'administration') return { state: 'failed', errorCode: 'invalid_request' };
    let record: AdministrationJob;
    try {
      record = await deps.administration.inspect(operation.id);
    } catch (error) {
      // The supervisor never recorded it (a crash before the submit): it may or may not have happened.
      if (error instanceof DomainError && error.code === 'not_found')
        return { state: 'unknown', errorCode: 'operation_unknown' };
      throw error;
    }
    return settlement(deps, operation.projectKey, operation.taskKey, operation.id, command.request, record);
  };
}

function settlement(
  deps: SuperAdministrationDeps,
  projectKey: string,
  taskKey: string | null,
  operationId: string,
  request: AdministrationRequest,
  record: AdministrationJob,
): SuperSettlement {
  if (record.state === 'accepted' || record.state === 'running') return { state: 'running' };
  if (record.state === 'unknown') return { state: 'unknown', errorCode: 'operation_unknown' };
  if (record.state === 'failed')
    return { state: 'failed', errorCode: record.errorCode ?? 'administration_failed' };
  const result = record.result;
  if (request.kind === 'full_test' && result?.kind === 'full_test') {
    const errorCode = FULL_TEST_RESULT[result.outcome];
    return {
      state: errorCode ? 'failed' : 'succeeded',
      errorCode,
      onSettled: () => recordFullTest(deps, projectKey, taskKey, operationId, request, result),
    };
  }
  return { state: 'succeeded', errorCode: null };
}

/** The card's own record of the run (the same event the review's full test writes), without any output text. */
function recordFullTest(
  deps: SuperAdministrationDeps,
  projectKey: string,
  taskKey: string | null,
  operationId: string,
  request: Extract<AdministrationRequest, { kind: 'full_test' }>,
  result: Extract<AdministrationResult, { kind: 'full_test' }>,
): void {
  const task = taskKey ? deps.ctx.repos.tasks.get(taskKey) : null;
  if (!task) return;
  const pin = deps.ctx.repos.reviewPins.get(task.key);
  deps.timeline.append({
    projectKey,
    taskKey: task.key,
    actor: SYSTEM_ACTOR,
    type: 'task_full_test',
    data: {
      outcome: result.outcome,
      runId: operationId,
      repo: task.repo ?? '',
      branch: pin?.branch ?? task.merge?.branch ?? '',
      commit: request.commit,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      ...(result.failedFiles.length > 0 ? { failedFiles: result.failedFiles.slice(0, 20) } : {}),
    },
  });
}
