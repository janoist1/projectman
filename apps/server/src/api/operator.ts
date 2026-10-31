import type { FastifyInstance } from 'fastify';
import {
  routes,
  OperatorApprovalWaiverRequest,
  canReadOperatorKnowledge,
  OwnerQuestionsQuery,
  SuperAuditQuery,
  SuperOperateRequest,
} from '@projectman/shared';
import type {
  OwnerQuestionsReport,
  SuperAuditPage,
  SuperOperateResponse,
  SuperOperationDetail,
} from '@projectman/shared';
import type { ApiDomain } from './ports';
import { forbidden } from '../kernel';
import { requireAccess, actorOf, authorOf } from './context';
import { parseBody } from '../http';

type ProjectParams = { Params: { key: string } };

export function registerOperatorRoutes(app: FastifyInstance, deps: { domain: ApiDomain }): void {
  const { domain } = deps;
  app.put<ProjectParams>(routes.operatorApprovalWaiver(':key'), async (request) => {
    const key = request.params.key;
    const access = await requireAccess(domain, request, key);
    if (access.via || access.access !== 'owner')
      throw forbidden('owner_approval_required', 'only an owner using their own login may change the waiver');
    const input = parseBody(OperatorApprovalWaiverRequest, request.body);
    return domain.projects.setOperatorApprovalWaiver(key, input, {
      actor: actorOf(access),
      author: authorOf(request, access),
    });
  });
  /** The super mode's audit (PM-757): the owner's own login reads it by token prefix; never a key. */
  app.get<ProjectParams>(routes.operatorSuperAudit(':key'), async (request): Promise<SuperAuditPage> => {
    const key = request.params.key;
    const access = await requireAccess(domain, request, key, { minimum: 'owner' });
    if (access.via)
      throw forbidden('insufficient_access', 'the audit is for the owner using their own login');
    return domain.superAudit.list(key, parseBody(SuperAuditQuery, request.query));
  });
  /** The weekly owner question measure (PM-1192): like the audit, the owner's own login only. */
  app.get<ProjectParams>(
    routes.operatorOwnerQuestions(':key'),
    async (request): Promise<OwnerQuestionsReport> => {
      const key = request.params.key;
      const access = await requireAccess(domain, request, key, { minimum: 'owner' });
      if (access.via)
        throw forbidden('insufficient_access', 'the measure is for the owner using their own login');
      return domain.inbox.ownerQuestions(key, parseBody(OwnerQuestionsQuery, request.query));
    },
  );
  /** The super mode's direct application operations, bound to the project. */
  app.post<ProjectParams>(
    routes.superOperations(':key'),
    async (request, reply): Promise<SuperOperateResponse> => {
      const key = request.params.key;
      const access = await requireAccess(domain, request, key, { minimum: 'owner' });
      const operation = await domain.superOperations.operate(
        key,
        parseBody(SuperOperateRequest, request.body),
        access,
      );
      reply.code(202);
      return { operation };
    },
  );
  app.get<{ Params: { key: string; operationId: string } }>(
    routes.superOperation(':key', ':operationId'),
    async (request): Promise<SuperOperationDetail> => {
      const { key, operationId } = request.params;
      await requireAccess(domain, request, key, { minimum: 'owner' });
      return domain.superOperations.operation(key, operationId);
    },
  );
  app.get<ProjectParams>(routes.operatorKnowledge(':key'), async (request) => {
    const access = await requireAccess(domain, request, request.params.key);
    if ((access.via && !request.principal) || !canReadOperatorKnowledge({ access: access.access }))
      throw forbidden(
        'operator_owner_only',
        'shared knowledge requires an owner or admin using their own login',
      );
    return domain.sharedOperatorKnowledge.read(request.params.key);
  });
  app.get<ProjectParams>(routes.operatorPreferences(':key'), async (request) => {
    const access = await requireAccess(domain, request, request.params.key, { minimum: 'admin' });
    return domain.operatorPreferences.list(request.params.key);
  });

  app.get<ProjectParams>(routes.operatorPreferenceMe(':key'), async (request) => {
    const access = await requireAccess(domain, request, request.params.key);
    return domain.operatorPreferences.me(request.params.key, access.handle);
  });

  app.post<{ Params: { key: string; signalId: string } }>(
    routes.dismissOperatorSignal(':key', ':signalId'),
    async (request) => {
      const { key, signalId } = request.params;
      const access = await requireAccess(domain, request, key);
      if (access.access !== 'owner' || access.via)
        throw forbidden('operator_owner_only', "only the owner's own login may dismiss a signal");
      return domain.operatorSignals.decision(key, signalId, access.handle, false);
    },
  );

  /**
   * The corner's conversation with the project manager (PM-1042): any person's own login; the owners share one,
   * everyone else has theirs, read only. The integrator key never sees it.
   */
  app.get<ProjectParams>(routes.projectManager(':key'), async (request) => {
    const access = await requireAccess(domain, request, request.params.key);
    if (access.via)
      throw forbidden(
        'operator_owner_only',
        "only a person's own login may see the project manager's conversation",
      );
    return domain.projectManagerChannels.view(request.params.key, access.handle);
  });
}
