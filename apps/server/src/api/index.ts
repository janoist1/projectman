import type { FastifyInstance } from 'fastify';
import { registerWebPushRoutes } from './web-push';
import type { AuthService, OwnerAccountService } from '../auth';
import type { ApiDomain } from './ports';
import type { EngineRegistry } from '../runtime/sessions';
import { registerEngineRoutes } from './engines';
import { registerAttachmentRoutes } from './attachments';
import { registerMessageAttachmentRoutes } from './message-attachments';
import { registerProviderRoutes } from './providers';
import { registerConfigRoutes } from './config';
import { registerInboxRoutes } from './inbox';
import { registerInvolvementRoutes } from './involvements';
import { registerFeedbackRoutes } from './feedback';
import { registerFeedbackWidgetRoutes } from './feedback-widget';
import { registerProjectEventRoutes } from './project-events';
import { registerStructureRoutes } from './structure';
import { registerInvitationRoutes } from './invitations';
import { registerOwnerAccountRoutes } from './owner-accounts';
import { registerMemberRoutes } from './members';
import { registerEmailChannelRoutes } from './email-channel';
import { registerHostRequestRoutes } from './host-requests';
import { registerOperatorRoutes } from './operator';
import { registerMemberQueueRoutes } from './member-queue';
import { registerProjectRoutes } from './projects';
import { registerRoleRoutes } from './roles';
import { registerPauseRoutes } from './pause';
import { registerMachineRoutes } from './machine';
import { registerScheduleRoutes } from './schedules';
import { registerSessionRoutes } from './sessions';
import { registerTaskRoutes } from './tasks';
import { registerMergeRoutes } from './merges';
import { registerVersionRoutes } from './version';
import { forbidden } from '../kernel';

export type { ApiDomain } from './ports';

/** What the routes call: the domain services and the accounts. */
export interface ApiServices {
  engineRegistry?: EngineRegistry;
  domain: ApiDomain;
  auth: AuthService;
  ownerAccounts: OwnerAccountService;
  /** The header that names the real client behind a trusted entrance (see clientAddress). */
  clientIpHeader?: string;
  /** The built feedback widget script (PM-509); absent or missing on disk: its route answers 404. */
  feedbackWidgetFile?: string | null;
}

/** Every route of the shared route table except auth (src/auth) and the websocket (src/ws). */
export function registerApiRoutes(app: FastifyInstance, services: ApiServices): void {
  const { domain } = services;
  app.addHook('onRoute', (route) => {
    if (!route.url.startsWith('/api/')) return;
    const handler = route.handler;
    // A closed operation identifier from the registered route, never the caller's raw URL.
    const targetName = route.url
      .replace('/api/', '')
      .replace(/:[A-Za-z]+/g, '')
      .replace(/[^a-z0-9]+/g, '_');
    route.handler = function (request, reply) {
      if (route.url.startsWith('/api/me/push') && (request.via === 'integrator' || request.principal))
        throw forbidden('web_push_integrator_refused', 'Web push requires a personal login');
      if (!request.principal) return handler.call(this, request, reply);
      services.auth.assertActive(request.principal);
      if (request.principal.mode === 'read' && request.method !== 'GET' && request.method !== 'HEAD')
        throw forbidden('integrator_read_only', 'a read-only credential cannot change anything');
      const context = { principal: request.principal, email: request.user!.email, requestId: request.id };
      const params = request.params as { key?: string; taskKey?: string };
      const run = async () => handler.call(this, request, reply);
      if (params.key)
        return domain.superOperator.execute(
          context,
          {
            projectKey: params.key,
            taskKey: params.taskKey,
            operation: `rest_${request.method.toLowerCase()}_${targetName}`.slice(0, 64),
          },
          run,
        );
      return domain.superOperator.executeInstance(
        context,
        `rest_${request.method.toLowerCase()}_${targetName}`.slice(0, 64),
        run,
      );
    };
  });
  registerEngineRoutes(app, services);
  registerVersionRoutes(app, domain);
  registerWebPushRoutes(app, domain);
  registerProviderRoutes(app, services);
  registerProjectRoutes(app, services);
  registerOperatorRoutes(app, services);
  registerMemberQueueRoutes(app, services);
  registerTaskRoutes(app, domain);
  registerMergeRoutes(app, domain);
  registerAttachmentRoutes(app, services);
  registerMessageAttachmentRoutes(app, services);
  registerMemberRoutes(app, domain);
  registerEmailChannelRoutes(app, domain);
  registerHostRequestRoutes(app, domain);
  registerRoleRoutes(app, domain);
  registerSessionRoutes(app, domain);
  registerScheduleRoutes(app, domain);
  registerPauseRoutes(app, domain);
  registerMachineRoutes(app, domain);
  registerInboxRoutes(app, domain);
  registerInvolvementRoutes(app, domain);
  registerProjectEventRoutes(app, services);
  registerStructureRoutes(app, domain);
  registerFeedbackRoutes(app, domain);
  registerFeedbackWidgetRoutes(app, {
    domain,
    clientIpHeader: services.clientIpHeader,
    widgetFile: services.feedbackWidgetFile ?? null,
  });
  registerConfigRoutes(app, domain);
  registerInvitationRoutes(app, services);
  registerOwnerAccountRoutes(app, services);
}
