import type {
  Actor,
  OrderMergeQueueRequest,
  StartMergeRequest,
  StartTaskRequest,
  Task,
  UpdateTaskRequest,
} from '@projectman/shared';
import type { InvitationService, InvitationUser, MemberService } from '../../core/members';
import type { Author, ProjectService } from '../../core/projects';
import type { TaskService } from '../../core/tasks';
import type { InboxService } from '../../core/inbox';
import {
  DomainError,
  assertIntegratorAccess,
  authorizeSuperMutation,
  conflict,
  forbidden,
  integratorExecution,
  notFound,
} from '../../kernel';
import type { SuperCommandExecutor, SuperExecutorJob } from './handoffs';

export interface SuperCommandDeps {
  inbox: Pick<InboxService, 'resolve'>;
  tasks: Pick<TaskService, 'create' | 'update' | 'changeLabels' | 'cancel'>;
  members: Pick<MemberService, 'update' | 'hire' | 'retire' | 'sponsorFor'>;
  projects: Pick<ProjectService, 'patch' | 'revert'>;
  invitations: Pick<InvitationService, 'create'>;
  user(id: string): InvitationUser | null;
  revokeCredential?(userId: string, keyId: string): unknown;
  releaseWorkspace?(projectKey: string, scopeId: string, release: { actor: Actor; reason: string }): void;
  starts: {
    start(
      projectKey: string,
      taskKey: string,
      options: StartTaskRequest & {
        actor: Actor;
        author: Author;
        sponsor: string;
        startSetters: boolean;
      },
    ): Promise<unknown>;
  };
  merges: {
    start(projectKey: string, taskKey: string, actor: Actor, request: StartMergeRequest): Promise<unknown>;
    orderQueue(projectKey: string, actor: Actor, request: OrderMergeQueueRequest): Promise<unknown>;
  };
}

/** Uses the live principal's user and the bound actor; no executor takes a key as its authority. */
export function superJobIdentity(job: SuperExecutorJob, deps: Pick<SuperCommandDeps, 'user'>) {
  const scope = integratorExecution();
  const actor = job.access.superActor;
  if (!scope || scope.principal.mode !== 'super' || !actor)
    throw forbidden('integrator_not_allowed', 'a super job needs authenticated execution');
  const owner = assertIntegratorAccess(job.config, 'write', actor);
  const user = deps.user(scope.principal.userId);
  if (!owner || !user) throw forbidden('insufficient_access', 'the principal has no current owner');
  const author: Author = {
    name: user.name,
    email: user.email,
    via: 'integrator',
    superActor: actor,
    authorizedBy: owner.handle,
    superRequestId: scope.requestId,
  };
  return { actor, author, user };
}

/**
 * An update that left the requested stage or assignee as it was (a hand-on request instead of a move, for
 * one) is never a success: the operation fails with the reason, so a caller does not take it as done.
 */
function assertUpdateApplied(
  request: Pick<UpdateTaskRequest, 'stageId' | 'assignee'>,
  task: Pick<Task, 'key' | 'stageId' | 'assignee' | 'handOn'>,
): void {
  if (request.stageId !== undefined && task.stageId !== request.stageId) {
    if (task.handOn?.toStageId === request.stageId)
      throw conflict(
        'hand_on_requested',
        `task ${task.key} was not moved to ${request.stageId}: ${task.handOn.mover} was asked to move it`,
        { mover: task.handOn.mover },
      );
    throw conflict(
      'update_not_applied',
      `task ${task.key} is still in ${task.stageId}, not in ${request.stageId}`,
    );
  }
  if (request.assignee !== undefined && task.assignee !== request.assignee)
    throw conflict(
      'update_not_applied',
      `task ${task.key} still has the assignee ${task.assignee ?? 'none'}, not ${request.assignee ?? 'none'}`,
    );
}

/** The same domain calls and metadata as the REST routes, inside the common audited operation. */
export function createCommandExecutor(deps: SuperCommandDeps): SuperCommandExecutor {
  return async (job) => {
    const { command } = job;
    const { actor, author, user } = superJobIdentity(job, deps);
    const projectKey = job.operation.projectKey;
    switch (command.kind) {
      case 'inbox_resolve':
        await deps.inbox.resolve(projectKey, command.itemId, command.request, job.access);
        return;
      case 'task_create': {
        const task = await deps.tasks.create(projectKey, command.request, actor);
        return { taskKey: task.key };
      }
      case 'task_update': {
        const updated = await deps.tasks.update(projectKey, command.taskKey, command.request, actor);
        assertUpdateApplied(command.request, updated);
        return { taskKey: command.taskKey };
      }
      case 'task_labels':
        await deps.tasks.changeLabels(
          projectKey,
          command.taskKey,
          {
            add: command.request.add,
            remove: command.request.remove,
          },
          actor,
          { comment: command.request.comment },
        );
        return { taskKey: command.taskKey };
      case 'task_start':
        await deps.starts.start(projectKey, command.taskKey, {
          ...command.request,
          actor,
          author,
          startSetters: true,
          sponsor: await deps.members.sponsorFor(job.access),
        });
        return { taskKey: command.taskKey };
      case 'task_cancel':
        await deps.tasks.cancel(projectKey, command.taskKey, command.request, actor);
        return { taskKey: command.taskKey };
      case 'merge':
        await deps.merges.start(projectKey, command.taskKey, actor, command.request);
        return { taskKey: command.taskKey };
      case 'merge_order': {
        const { kind: _kind, ...request } = command;
        await deps.merges.orderQueue(projectKey, actor, request);
        return;
      }
      case 'member_update':
        await deps.members.update(projectKey, command.handle, command.request, { actor, author });
        return;
      case 'invite_create':
        await deps.invitations.create(projectKey, command.request, user);
        return;
      case 'credential_revoke':
        await authorizeSuperMutation({
          projectKey,
          previous: job.config,
          actor,
          command: { kind: 'remove', resource: 'credential', id: command.keyId },
        });
        if (!deps.revokeCredential)
          throw new DomainError('super_operation_unsupported', 'credential revocation is unavailable', {
            status: 422,
          });
        if (!deps.revokeCredential(user.id, command.keyId)) throw notFound('credential', command.keyId);
        return;
      case 'workspace_release':
        if (!deps.releaseWorkspace)
          throw new DomainError('super_operation_unsupported', 'workspace release is unavailable', {
            status: 422,
          });
        deps.releaseWorkspace(projectKey, command.scopeId, { actor, reason: command.reason });
        return;
      default:
        throw new DomainError('super_operation_unsupported', 'this command has no domain executor', {
          status: 422,
        });
    }
  };
}
