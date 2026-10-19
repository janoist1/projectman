import type { Actor, Session, SessionStop, TeamMessage } from '@projectman/shared';
import { DomainError, assertIntegratorAccess, forbidden, integratorExecution, invalid } from '../../kernel';
import type { SuperCommandExecutor } from './handoffs';

/** Who pauses or resumes: the key owner's request, recorded as the Operator with the key's data. */
interface OperatePauseRequester {
  userId: string;
  source: 'app';
  via: 'integrator';
  credential: { id: string; prefix: string };
}

/**
 * The domain services the super-mode `operate` command runs on: the ones the Operator's own operations use
 * (Messaging in core/messages, PauseService in runtime/sessions, the session orchestrator), seen through the
 * calls this executor makes; the composition supplies them.
 */
export interface OperateExecutorDeps {
  messaging: {
    send(
      projectKey: string,
      from: string,
      input: { to: string[]; text: string; taskKey?: string | null },
      opts: { actor: Actor; workerCheck: boolean },
    ): Promise<TeamMessage>;
  };
  pauses: {
    pause(target: { scope: 'project'; projectKey: string }, by: OperatePauseRequester): Promise<void>;
    resume(target: { scope: 'project'; projectKey: string }, by: OperatePauseRequester): Promise<void>;
  };
  sessions: {
    get(projectKey: string, sessionId: string): Session;
    stop(projectKey: string, sessionId: string, stop: SessionStop): Promise<Session>;
  };
}

/**
 * The executor of the `operate` command kind in super mode (PM-831). It runs the Operator's operations as the
 * key's super actor, on the authority of the key (its owner is checked again at the domain entry), without the
 * one-click approval of the base Operator: the owner-reserved effects were already classified before the
 * executor runs. Operations that change the configuration or the members are not executed yet (PM-832).
 */
export function createOperateExecutor(deps: OperateExecutorDeps): SuperCommandExecutor {
  return async (job) => {
    const { command, operation } = job;
    if (command.kind !== 'operate') throw invalid('invalid_request', 'not an operate command');
    const actor = job.access.superActor;
    const scope = integratorExecution();
    if (!actor || !scope || scope.principal.mode !== 'super')
      throw forbidden('integrator_not_allowed', 'only the integrator in super mode runs an operate job');
    const superActor = actor;
    const projectKey = job.config.project.key;
    assertIntegratorAccess(job.config, 'write', superActor);
    const op = command.operation;
    switch (op.op) {
      case 'message_send':
        if (operation.taskKey && op.taskKey && operation.taskKey !== op.taskKey)
          throw invalid('invalid_request', 'the message names another task than the operation', {
            field: 'taskKey',
          });
        await deps.messaging.send(
          projectKey,
          superActor.handle,
          { to: op.to, text: op.text, taskKey: op.taskKey ?? operation.taskKey ?? null },
          { actor: superActor, workerCheck: true },
        );
        return;
      case 'project_pause':
      case 'project_resume': {
        // The same requester as the pause route in super mode: the entry is the Operator's, with the key's data.
        const requester = {
          userId: scope.principal.userId,
          source: 'app' as const,
          via: 'integrator' as const,
          credential: { id: scope.principal.keyId, prefix: scope.principal.prefix },
        };
        const target = { scope: 'project' as const, projectKey };
        if (op.op === 'project_pause') await deps.pauses.pause(target, requester);
        else await deps.pauses.resume(target, requester);
        return;
      }
      case 'session_stop': {
        const session = deps.sessions.get(projectKey, op.sessionId);
        if (session.member === superActor.handle)
          throw forbidden('operator_never', 'the Operator cannot stop its own session');
        await deps.sessions.stop(projectKey, op.sessionId, { kind: 'manual', by: superActor });
        return;
      }
      case 'config_patch':
      case 'config_revert':
      case 'member_update':
      case 'member_hire':
      case 'member_retire':
        throw new DomainError(
          'super_operation_unsupported',
          'this operation is not executed in super mode yet',
          { status: 422 },
        );
    }
  };
}
