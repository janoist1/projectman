import type {
  Actor,
  ProjectManagerAgreementData,
  Session,
  SessionStop,
  TeamMessage,
} from '@projectman/shared';
import { connectedOriginOf, prepareSuperConfigPatch } from '@projectman/shared';
import { DomainError, assertIntegratorAccess, forbidden, integratorExecution, invalid } from '../../kernel';
import type { SuperCommandExecutor } from './handoffs';
import { superJobIdentity } from './commands';
import type { SuperCommandDeps } from './commands';
import type { MemberService } from '../../core/members';
import type { TimelineService } from '../../core/timeline';
import type { SetupNotices, SetupResult } from './setup-notice';

/** Who pauses or resumes: the live principal's request, recorded as the bound connected Claude. */
interface OperatePauseRequester {
  userId: string;
  source: 'app';
  via: 'integrator';
  credential: { id: string; prefix: string };
}

/**
 * The domain services the super-mode `operate` command runs on: the ones the connected Claude's own operations use
 * (Messaging in core/messages, PauseService in runtime/sessions, the session orchestrator), seen through the
 * calls this executor makes; the composition supplies them.
 */
interface OperateExecutorDeps extends Pick<SuperCommandDeps, 'projects' | 'user'> {
  members: SuperCommandDeps['members'] & Pick<MemberService, 'applySetup'>;
  /** The project manager's shared agreement a setup package replaces (PM-1460). */
  knowledge: {
    writeAgreement(
      projectKey: string,
      data: ProjectManagerAgreementData,
      by: { approvedBy: string; operationId: string },
    ): Promise<number>;
  };
  timeline: Pick<TimelineService, 'append'>;
  notices: Pick<SetupNotices, 'applied'>;
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
 * The executor of the `operate` command kind in super mode (PM-831). It runs the connected Claude's operations as the
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
        // The same requester as the pause route in super mode: the entry is the connected Claude's, with the key's data.
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
        if (session.member === superActor.handle)
          throw forbidden('operator_never', 'the acting member cannot stop its own session');
        await deps.sessions.stop(projectKey, op.sessionId, { kind: 'manual', by: superActor });
        return;
      }
      case 'config_patch':
        await deps.projects.patch(
          projectKey,
          prepareSuperConfigPatch(job.config, job.configVersion, op.patch),
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
      case 'setup_apply': {
        const identity = superJobIdentity(job, deps);
        const applied = await deps.members.applySetup(
          projectKey,
          {
            expectedVersion: job.configVersion,
            ...(op.patch ? { patch: prepareSuperConfigPatch(job.config, job.configVersion, op.patch) } : {}),
            hires: op.hires,
            updates: op.updates,
            message: `Apply setup package: ${op.title}`,
          },
          {
            actor: identity.actor,
            author: identity.author,
            sponsor: await deps.members.sponsorFor(job.access),
          },
        );
        // The configuration is committed; the agreement is a separate file, so its failure is reported, not undone.
        let agreement: 'written' | 'not_written' | 'none' = 'none';
        let agreementError: string | undefined;
        if (op.agreement) {
          if (!job.approvedBy) {
            agreement = 'not_written';
            agreementError = 'owner_approval_required';
          } else {
            try {
              await deps.knowledge.writeAgreement(projectKey, op.agreement, {
                approvedBy: job.approvedBy,
                operationId: operation.id,
              });
              agreement = 'written';
            } catch (error) {
              agreement = 'not_written';
              agreementError = error instanceof DomainError ? error.code : 'internal_error';
            }
          }
        }
        const result: SetupResult = { ...applied, agreement, ...(agreementError ? { agreementError } : {}) };
        deps.timeline.append({
          projectKey,
          actor: superActor,
          type: 'setup_applied',
          data: { operationId: operation.id, ...result },
        });
        await deps.notices.applied(operation, op.title, result);
        return;
      }
      case 'member_rename':
        // A handle rename is the owner's own call with their own login (PM-1025): never in super mode.
        throw invalid('super_operation_unsupported', 'a member rename is not run in super mode', {
          op: op.op,
        });
    }
  };
}
