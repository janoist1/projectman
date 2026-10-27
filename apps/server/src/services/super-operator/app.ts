import { createHash } from 'node:crypto';
import {
  OPERATOR_APP_CREDENTIAL_PREFIX,
  appRequestOrigin,
  operatorOf,
  coordinationMemberOf,
} from '@projectman/shared';
import type {
  HumanMemberConfig,
  ProjectConfig,
  SuperCommand,
  SuperOperation,
  SuperOperationDetail,
} from '@projectman/shared';
import type {
  IntegratorCredentialAuthority,
  IntegratorPrincipal,
  OperatorAppSessions,
} from '../../contracts';
import type { DomainContext } from '../../core/base';
import { projectAccessFor } from '../../core/members';
import type { ProjectService } from '../../core/projects';
import { forbidden } from '../../kernel';
import type { SuperAdministration } from './facade';
import type { SuperOperator } from './index';

/**
 * The in-app Operator on the shared super-operation path (decision 55, PM-888). It acts as the project's
 * Operator with the owner's rights, through the same checks, audit and executors as a super-mode key, but no
 * stored key stands behind it: its credential is the Operator session itself (`operator-app`, the session's id),
 * and it is valid only while that session answers an owner's open request.
 */

/**
 * The request id of an operation the Operator starts: the same `requestKey` in the same Operator request is the
 * same operation. A UUID v8 (RFC 9562) made of the first 16 bytes of the SHA-256 of both.
 */
export function appRequestId(operatorRequestId: string, requestKey: string): string {
  const bytes = createHash('sha256').update(`${operatorRequestId}:${requestKey}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Whether an operation was started by the in-app Operator: its audit entries carry the `operator-app` prefix. */
export function isAppOperation(ctx: DomainContext, operation: SuperOperation): boolean {
  return ctx.repos.superAudit
    .ofRequest(operation.projectKey, operation.requestId)
    .some((entry) => entry.prefix === OPERATOR_APP_CREDENTIAL_PREFIX);
}

/**
 * The live check of an app principal: the session runs, it is the project's Operator in its own general
 * conversation (not a guest's), and an owner request is open.
 */
export function createOperatorAppSessions(deps: {
  ctx: DomainContext;
  projects: Pick<ProjectService, 'cachedConfig'>;
  hasOpenRequest(sessionId: string): boolean;
}): OperatorAppSessions {
  return {
    active(principal) {
      if (principal.source !== 'app') return false;
      const session = deps.ctx.repos.sessions.get(principal.keyId);
      if (!session || session.state === 'exited' || session.state === 'failed') return false;
      const config = deps.projects.cachedConfig(session.projectKey);
      return (
        !!config &&
        session.member === principal.member &&
        (operatorOf(config)?.handle === session.member ||
          coordinationMemberOf(config)?.handle === session.member) &&
        session.workItem.type === 'general' &&
        !session.workItem.with &&
        deps.hasOpenRequest(session.id)
      );
    },
  };
}

interface OperatorAppCredentials {
  /** What every consumer of the shared path asks: keys go to the stored-key authority, app principals to the sessions. */
  authority: IntegratorCredentialAuthority;
  /** The principal of a live Operator session; null when the project has no owner with an account. */
  issue(config: ProjectConfig, sessionId: string, member: string): IntegratorPrincipal | null;
  /**
   * The principal that continues an operation after the owner's yes: it needs no live session, because the
   * owner's own login approved exactly that operation (the service checks it again before it runs).
   */
  issueApproved(
    config: ProjectConfig,
    sessionId: string,
    ownerHandle: string,
    member: string,
  ): IntegratorPrincipal | null;
}

export function createOperatorAppCredentials(deps: {
  base: IntegratorCredentialAuthority | undefined;
  sessions: OperatorAppSessions;
  /** The session's open request, when there is one: where it came from decides what the session may start. */
  openRequest(sessionId: string): { source: string; fromHandle: string } | null;
  user(id: string): { email: string } | null;
  userByEmail(email: string): { id: string; email: string } | null;
}): OperatorAppCredentials {
  // Only principals made here are app principals: a copy or a forged object is never in the set.
  const live = new WeakSet<IntegratorPrincipal>();
  const approved = new WeakSet<IntegratorPrincipal>();
  const principalOf = (
    config: ProjectConfig,
    sessionId: string,
    owner: string | null,
    sessionMember: string,
    requestOrigin: 'owner' | 'member',
  ): IntegratorPrincipal | null => {
    const owners = config.team.members
      .filter(
        (member): member is HumanMemberConfig =>
          member.kind === 'human' &&
          member.access === 'owner' &&
          !!member.email &&
          (owner === null || member.handle === owner),
      )
      .sort((a, b) => a.handle.localeCompare(b.handle));
    for (const member of owners) {
      const user = deps.userByEmail(member.email!);
      if (user)
        return Object.freeze({
          kind: 'integrator',
          userId: user.id,
          keyId: sessionId,
          prefix: OPERATOR_APP_CREDENTIAL_PREFIX,
          mode: 'super',
          source: 'app',
          member: sessionMember,
          requestOrigin,
        } as const);
    }
    return null;
  };
  return {
    authority: {
      assertActive(principal) {
        if (principal.source === 'app') {
          if (!live.has(principal) || (!approved.has(principal) && !deps.sessions.active(principal)))
            throw forbidden('insufficient_access', 'the Operator has no open owner request to act for');
          return;
        }
        if (!deps.base) throw forbidden('insufficient_access', 'credential verification is unavailable');
        deps.base.assertActive(principal);
      },
      user: (id) => deps.base?.user(id) ?? deps.user(id),
      isHostOwner: (userId) => deps.base?.isHostOwner?.(userId) ?? false,
      ...(deps.base?.reactivate ? { reactivate: (stored) => deps.base!.reactivate!(stored) } : {}),
    },
    issue(config, sessionId, member) {
      // The origin comes from the session's open request, never from the caller (PM-1010).
      const principal = principalOf(
        config,
        sessionId,
        null,
        member,
        appRequestOrigin(config, deps.openRequest(sessionId)),
      );
      if (principal) live.add(principal);
      return principal;
    },
    issueApproved(config, sessionId, ownerHandle, member) {
      // The owner's own yes stands behind the operation, so it runs with the owner's authority.
      const principal = principalOf(config, sessionId, ownerHandle, member, 'owner');
      if (principal) {
        live.add(principal);
        approved.add(principal);
      }
      return principal;
    },
  };
}

/** What the Operator starts, as the shared path takes it. */
interface AppOperationInput {
  requestId: string;
  taskKey?: string | undefined;
  command: SuperCommand;
}

/**
 * Runs the Operator's commands on the shared path, as the project's Operator with the owner's rights: the
 * principal is bound to the owner's access now, the execution is audited like a key's, and `operate` does the
 * rest (K3 effects wait for the owner's yes).
 */
export function createOperatorAppOperations(deps: {
  ctx: DomainContext;
  credentials: OperatorAppCredentials;
  superOperator: Pick<SuperOperator, 'access' | 'execute'>;
  superAdministration: Pick<SuperAdministration, 'operate' | 'operation'>;
  projects: Pick<ProjectService, 'config'>;
}) {
  const run = async (
    principal: IntegratorPrincipal | null,
    projectKey: string,
    input: AppOperationInput,
  ): Promise<SuperOperation> => {
    const email = principal ? deps.credentials.authority.user(principal.userId)?.email : undefined;
    if (!principal || !email) throw forbidden('insufficient_access', 'the project has no owner to act for');
    const config = await deps.projects.config(projectKey);
    const owner = projectAccessFor(config, email);
    if (owner?.access !== 'owner')
      throw forbidden('insufficient_access', 'the credential owner is no longer an owner of the project');
    const context = { principal, email, requestId: input.requestId };
    const access = await deps.superOperator.access(context, owner, 'write');
    return deps.superOperator.execute(
      context,
      { projectKey, ...(input.taskKey ? { taskKey: input.taskKey } : {}), operation: 'execute_operation' },
      () =>
        deps.superAdministration.operate(
          projectKey,
          {
            requestId: input.requestId,
            command: input.command,
            ...(input.taskKey ? { taskKey: input.taskKey } : {}),
          },
          access,
        ),
    );
  };
  return {
    /** Starts a command for the Operator session's open request. */
    async execute(projectKey: string, sessionId: string, input: AppOperationInput): Promise<SuperOperation> {
      const config = await deps.projects.config(projectKey);
      const session = deps.ctx.repos.sessions.get(sessionId);
      if (!session || session.projectKey !== projectKey)
        throw forbidden('insufficient_access', 'the app session belongs to another project');
      return run(deps.credentials.issue(config, sessionId, session.member), projectKey, input);
    },
    /** Goes on with an operation the owner said yes to; the same call as the first one, now under the owner's yes. */
    async resume(operation: SuperOperation, keyId: string, ownerHandle: string): Promise<SuperOperation> {
      const config = await deps.projects.config(operation.projectKey);
      const session = deps.ctx.repos.sessions.get(keyId);
      if (!session || session.projectKey !== operation.projectKey)
        throw forbidden('insufficient_access', 'the app session is no longer available');
      return run(
        deps.credentials.issueApproved(config, keyId, ownerHandle, session.member),
        operation.projectKey,
        {
          requestId: operation.requestId,
          ...(operation.taskKey ? { taskKey: operation.taskKey } : {}),
          command: operation.command,
        },
      );
    },
    /** The operation and its recorded result (a running one is settled first). */
    read(projectKey: string, operationId: string): Promise<SuperOperationDetail> {
      return deps.superAdministration.operation(projectKey, operationId);
    },
  };
}
export type OperatorAppOperations = ReturnType<typeof createOperatorAppOperations>;
