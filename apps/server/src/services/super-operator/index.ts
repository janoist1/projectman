import type {
  IntegratorCredentialAuthority,
  IntegratorExecutionContext,
  IntegratorExecutionScope,
  IntegratorPrincipal,
  SuperMutationAuthorizer,
} from '../../contracts';
import { assertIntegratorAccess, runIntegratorExecution, forbidden } from '../../kernel';
import type { ProjectAccess } from '../../core/members';
import { bindSuperPrincipal } from '../../core/members';
import type { ProjectService } from '../../core/projects';
import type { SuperAuditService } from '../../core/timeline';
import {
  canonical,
  hasSuperOrigin,
  holdsOwnership,
  ownerReservedEffect,
  superAccessVerdict,
  superActorOf,
} from '@projectman/shared';
import type { Actor, HumanMemberConfig, ProjectConfig, SuperMutationInput } from '@projectman/shared';

export { SUPER_OWNER_YES, SuperHandoffService, createSuperHandoffService } from './handoffs';
export type { SuperCommandExecutor, SuperExecutorJob } from './handoffs';
export { createAdministrationExecutor, createAdministrationSettler } from './administration';
export type { SuperAdministrationDeps } from './administration';
export { createOperateExecutor } from './operate';
export { createCommandExecutor } from './commands';
export { createSuperDiagnostics } from './diagnostics';
export {
  appRequestId,
  createOperatorAppCredentials,
  createOperatorAppOperations,
  createOperatorAppSessions,
} from './app';
export type { OperatorAppOperations } from './app';
export { createSuperAdministration } from './facade';
export type { SuperAdministration } from './facade';
export { relayOwnerAnswer } from './relay';
export { resolveIntegratorTodo } from './todo';
export { INTEGRATOR_INBOX_LIMIT, listIntegratorInbox, resolveIntegratorFixLimit } from './fix-limit';
export { updateInstanceKnowledge } from './instance-knowledge';
export { createSuperRights } from './rights';

const principalActor = (config: ProjectConfig, principal: IntegratorPrincipal) =>
  superActorOf(
    config,
    { id: principal.keyId, prefix: principal.prefix },
    principal.source === 'app' ? principal.member : undefined,
  );

/** Authenticated execution shared by REST and bearer MCP. The composition supplies domain ports. */
export function createSuperOperator(deps: {
  projects: Pick<ProjectService, 'config' | 'cachedConfig' | 'summaries'>;
  audit: SuperAuditService;
  credentials?: IntegratorCredentialAuthority;
}) {
  let authorizer: SuperMutationAuthorizer = {
    async assertAllowed(input) {
      let effect;
      try {
        effect = ownerReservedEffect(input.previous, input.command);
      } catch {
        throw forbidden('integrator_not_allowed', 'unknown mutation projection');
      }
      if (effect)
        throw forbidden('owner_approval_required', 'this effect requires a specific owner authorization', {
          effect,
        });
    },
  };
  const scopeFor = (input: IntegratorExecutionContext): IntegratorExecutionScope => {
    const credentials = deps.credentials;
    if (!credentials) throw forbidden('insufficient_access', 'credential verification is unavailable');
    credentials.assertActive(input.principal);
    const user = credentials.user(input.principal.userId);
    if (!user) throw forbidden('insufficient_access', 'the credential owner does not exist');
    const projectKey = input.projectKey ?? null;
    // An instance-wide scope takes its actor from the first project the key's holder owns and the mode may use,
    // never from a project that merely comes first in the list; without one, an actor-bound mutation stays closed.
    const initial =
      projectKey !== null
        ? deps.projects.cachedConfig(projectKey)
        : deps.projects
            .summaries()
            .map((project) => deps.projects.cachedConfig(project.key))
            .find(
              (config) =>
                config &&
                holdsOwnership(config, user.email) &&
                superAccessVerdict(config, {
                  mode: input.principal.mode,
                  operation: 'read',
                  ownerMembership: true,
                }).allowed,
            );
    const actor =
      initial && input.principal.mode === 'super' ? principalActor(initial, input.principal) : null;
    const authorized = new Set<string>();
    const check = (
      config: ProjectConfig,
      operation: 'read' | 'write' | 'approval' | 'key_management',
      by?: Actor,
    ) => {
      credentials.assertActive(input.principal);
      if (projectKey !== null && config.project.key !== projectKey)
        throw forbidden('insufficient_access', 'the operation is bound to another project');
      const owner = config.team.members.find(
        (member): member is HumanMemberConfig =>
          member.kind === 'human' && member.email?.trim().toLowerCase() === user.email.trim().toLowerCase(),
      );
      const verdict = superAccessVerdict(config, {
        mode: input.principal.mode,
        operation,
        ownerMembership: owner?.access === 'owner',
      });
      if (!verdict.allowed) throw forbidden(verdict.code, 'the credential cannot perform this operation');
      const expected = principalActor(config, input.principal);
      if (
        by &&
        input.principal.mode === 'super' &&
        (!hasSuperOrigin(by) || !expected || canonical(by) !== canonical(expected))
      )
        throw forbidden('insufficient_access', 'the actor does not match the authenticated credential');
      return owner;
    };
    const assertMutation = (mutation: SuperMutationInput) => {
      credentials.assertActive(input.principal);
      if (mutation.previous) {
        if (mutation.projectKey !== mutation.previous.project.key)
          throw forbidden('insufficient_access', 'the mutation belongs to another project');
        check(mutation.previous, 'write', mutation.actor);
      } else {
        if (input.principal.mode === 'read')
          throw forbidden('integrator_read_only', 'a read credential cannot write');
        if (
          mutation.projectKey !== null ||
          projectKey !== null ||
          !(
            (mutation.command.kind === 'routine' &&
              ['engine_create', 'engine_default'].includes(mutation.command.operation)) ||
            (mutation.command.kind === 'remove' && mutation.command.resource === 'engine')
          )
        )
          throw forbidden('integrator_not_allowed', 'this mutation needs its project snapshot');
        if (!actor || canonical(mutation.actor) !== canonical(actor))
          throw forbidden('insufficient_access', 'the host mutation has no bound actor');
      }
      let effect;
      try {
        effect = ownerReservedEffect(mutation.previous, mutation.command);
      } catch {
        throw forbidden('integrator_not_allowed', 'unknown mutation projection');
      }
      if (effect && !authorized.has(canonical(mutation)))
        throw forbidden('owner_approval_required', 'this effect requires a specific owner authorization', {
          effect,
        });
    };
    return {
      active: true,
      context: {
        principal: input.principal,
        projectKey,
        actor: actor ?? { kind: 'human', handle: null },
        requestId: input.requestId,
      },
      actorFor(config) {
        if (config) check(config, 'write');
        const bound =
          config && input.principal.mode === 'super' ? principalActor(config, input.principal) : actor;
        if (!bound) throw forbidden('insufficient_access', 'the mutation has no bound actor');
        return bound;
      },
      assertAccess: check,
      assertMutation,
      async authorizeMutation(mutation) {
        // Validate provenance before invoking a future durable grant authorizer (PM-762).
        if (mutation.previous) check(mutation.previous, 'write', mutation.actor);
        else credentials.assertActive(input.principal);
        await authorizer.assertAllowed(mutation);
        credentials.assertActive(input.principal);
        authorized.add(canonical(mutation));
      },
    };
  };
  return {
    useMutationAuthorizer(port: SuperMutationAuthorizer) {
      authorizer = port;
    },
    run<T>(context: IntegratorExecutionContext, run: () => T): T {
      return runIntegratorExecution(scopeFor(context), run);
    },
    async execute<T>(
      context: IntegratorExecutionContext,
      target: { projectKey: string; taskKey?: string; operation: string },
      run: () => Promise<T>,
    ): Promise<T> {
      await deps.projects.config(target.projectKey);
      return runIntegratorExecution(scopeFor({ ...context, projectKey: target.projectKey }), async () => {
        const config = await deps.projects.config(target.projectKey);
        assertIntegratorAccess(config, 'read');
        // A read key's call is audited too (PM-784): the entry carries the project's Operator and the key's
        // id and prefix, while the principal's mode stays `read`.
        const actor = principalActor(config, context.principal);
        if (!actor) return run();
        return deps.audit.runExternal(
          { projectKey: target.projectKey, actor, requestId: context.requestId },
          target.operation,
          run,
          {
            committed: async () => {
              throw new Error('the operation outcome is unknown');
            },
            ...(target.taskKey ? { taskKey: target.taskKey } : {}),
          },
        );
      });
    },
    async executeInstance<T>(
      context: IntegratorExecutionContext,
      operation: string,
      run: () => Promise<T>,
    ): Promise<T> {
      const configs = await Promise.all(deps.projects.summaries().map((p) => deps.projects.config(p.key)));
      return runIntegratorExecution(scopeFor({ ...context, projectKey: null }), async () => {
        // The operation is one instance action, run exactly once; the access check and the audit belong to the
        // projects the key's holder owns. A project of another owner is left out, and a policy that forbids the
        // key in an own project still refuses the call.
        const email = deps.credentials?.user(context.principal.userId)?.email;
        const projects = configs.filter((config) => holdsOwnership(config, email));
        let work = run;
        for (const config of projects) {
          assertIntegratorAccess(config, 'read');
          const actor = principalActor(config, context.principal);
          if (context.principal.mode !== 'super' || !actor) continue;
          const next = work;
          work = () =>
            deps.audit.runExternal(
              { projectKey: config.project.key, actor, requestId: context.requestId },
              operation,
              next,
              {
                committed: async () => {
                  throw new Error('the operation outcome is unknown');
                },
              },
            );
        }
        return work();
      });
    },
    /**
     * A call that spans the projects whose owner the key's holder is right now (PM-760: `list_projects`). The
     * projects are read again inside the scope, a project the mode cannot use is left out, and a super key's
     * call is audited in each project it names.
     */
    async executeOwned<T>(
      context: IntegratorExecutionContext,
      operation: string,
      run: (projects: { key: string; name: string }[]) => Promise<T>,
    ): Promise<T> {
      const configs = await Promise.all(deps.projects.summaries().map((p) => deps.projects.config(p.key)));
      return runIntegratorExecution(scopeFor({ ...context, projectKey: null }), async () => {
        const email = deps.credentials?.user(context.principal.userId)?.email;
        const owned = configs.filter(
          (config) =>
            holdsOwnership(config, email) &&
            superAccessVerdict(config, {
              mode: context.principal.mode,
              operation: 'read',
              ownerMembership: true,
            }).allowed,
        );
        let work = () => run(owned.map((config) => ({ key: config.project.key, name: config.project.name })));
        if (context.principal.mode === 'super') {
          for (const config of owned) {
            const actor = principalActor(config, context.principal);
            if (!actor) continue;
            const next = work;
            work = () =>
              deps.audit.runExternal(
                { projectKey: config.project.key, actor, requestId: context.requestId },
                operation,
                next,
                {
                  committed: async () => {
                    throw new Error('the operation outcome is unknown');
                  },
                },
              );
          }
        }
        return work();
      });
    },
    async access(
      context: IntegratorExecutionContext,
      access: ProjectAccess,
      operation: 'read' | 'write',
    ): Promise<ProjectAccess> {
      const config = await deps.projects.config(access.projectKey);
      return runIntegratorExecution(scopeFor({ ...context, projectKey: access.projectKey }), () => {
        assertIntegratorAccess(config, operation);
        return context.principal.mode === 'super'
          ? bindSuperPrincipal(config, access, context.principal)
          : { ...access, via: 'integrator' };
      });
    },
  };
}
export type SuperOperator = ReturnType<typeof createSuperOperator>;
