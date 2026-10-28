import type { Actor, Session, SessionStop, TeamMessage } from '@projectman/shared';
import { connectedOriginOf, operatorOf, prepareOperatorConfigPatch } from '@projectman/shared';
import { assertIntegratorAccess, forbidden, integratorExecution, invalid } from '../../kernel';
import type { SuperCommandExecutor } from './handoffs';
import { superJobIdentity } from './commands';
import type { SuperCommandDeps } from './commands';

/** Who pauses or resumes: the live principal's request, recorded as the bound Operator. */
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
interface OperateExecutorDeps extends Pick<SuperCommandDeps, 'projects' | 'members' | 'user'> {
  messaging: {
    send(
      projectKey: string,
      from: string,
      input: { to: string[]; text: string; taskKey?: string | null },
      opts: { actor: Actor; workerCheck: boolean },
    ): Promise<TeamMessage>;
  };
  pauses: {
    pause(
      target: { scope: 'project'; projectKey: string },
      by: OperatePauseRequester,
      options?: { reason?: string },
    ): Promise<void>;
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
 * executor runs. Configuration and member writes use the same author provenance as REST.
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
    const origin = connectedOriginOf(superActor);
    if (!origin) throw forbidden('integrator_not_allowed', 'the operate job has no connected origin');
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
          credential: { ...origin.credential },
        };
        const target = { scope: 'project' as const, projectKey };
        if (op.op === 'project_pause')
          await deps.pauses.pause(target, requester, op.reason === undefined ? {} : { reason: op.reason });
        else await deps.pauses.resume(target, requester);
        return;
      }
      case 'session_stop': {
        const session = deps.sessions.get(projectKey, op.sessionId);
        if (session.member === superActor.handle || session.member === operatorOf(job.config)?.handle)
          throw forbidden('operator_never', 'the Operator cannot stop its own session');
        await deps.sessions.stop(projectKey, op.sessionId, { kind: 'manual', by: superActor });
        return;
      }
      case 'config_patch':
        await deps.projects.patch(
          projectKey,
          prepareOperatorConfigPatch(job.config, job.configVersion, op.patch),
          superJobIdentity(job, deps),
        );
        return;
      case 'config_revert':
        await deps.projects.revert(projectKey, op.version, superJobIdentity(job, deps));
        return;
      case 'member_update':
        await deps.members.update(projectKey, op.handle, op.changes, superJobIdentity(job, deps));
        return;
      case 'member_hire':
        await deps.members.hire(projectKey, op.request, {
          ...superJobIdentity(job, deps),
          sponsor: await deps.members.sponsorFor(job.access),
        });
        return;
      case 'member_retire':
        await deps.members.retire(projectKey, op.handle, {}, superJobIdentity(job, deps));
        return;
      case 'member_rename':
        // A handle rename is the owner's own call with their own login (PM-1025): never in super mode.
        throw invalid('super_operation_unsupported', 'a member rename is not run in super mode', {
          op: op.op,
        });
    }
  };
}
