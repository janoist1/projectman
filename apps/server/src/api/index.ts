import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../auth';
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
import { registerProjectFocusRoutes } from './project-focus';
import { registerStructureRoutes } from './structure';
import { registerBoundaryRoutes } from './boundary';
import { registerInvitationRoutes } from './invitations';
import { registerMemberRoutes } from './members';
import { registerOperatorRoutes } from './operator';
import { registerProjectRoutes } from './projects';
import { registerRoleRoutes } from './roles';
import { registerPauseRoutes } from './pause';
import { registerMachineRoutes } from './machine';
import { registerScheduleRoutes } from './schedules';
import { registerSessionRoutes } from './sessions';
import { registerTaskRoutes } from './tasks';
import { registerMergeRoutes } from './merges';

export type { ApiDomain } from './ports';

/** What the routes call: the domain services and the accounts. */
export interface ApiServices {
  engineRegistry?: EngineRegistry;
  domain: ApiDomain;
  auth: AuthService;
  /** The header that names the real client behind a trusted entrance (see clientAddress). */
  clientIpHeader?: string;
  /** The built feedback widget script (PM-509); absent or missing on disk: its route answers 404. */
  feedbackWidgetFile?: string | null;
}

/** Every route of the shared route table except auth (src/auth) and the websocket (src/ws). */
export function registerApiRoutes(app: FastifyInstance, services: ApiServices): void {
  const { domain } = services;
  registerEngineRoutes(app, services);
  registerProviderRoutes(app, domain);
  registerProjectRoutes(app, services);
  registerOperatorRoutes(app, services);
  registerTaskRoutes(app, domain);
  registerMergeRoutes(app, domain);
  registerAttachmentRoutes(app, services);
  registerMessageAttachmentRoutes(app, services);
  registerMemberRoutes(app, domain);
  registerRoleRoutes(app, domain);
  registerSessionRoutes(app, domain);
  registerScheduleRoutes(app, domain);
  registerPauseRoutes(app, domain);
  registerMachineRoutes(app, domain);
  registerInboxRoutes(app, domain);
  registerInvolvementRoutes(app, domain);
  registerProjectFocusRoutes(app, domain);
  registerStructureRoutes(app, domain);
  registerFeedbackRoutes(app, domain);
  registerFeedbackWidgetRoutes(app, {
    domain,
    clientIpHeader: services.clientIpHeader,
    widgetFile: services.feedbackWidgetFile ?? null,
  });
  registerBoundaryRoutes(app, domain);
  registerConfigRoutes(app, domain);
  registerInvitationRoutes(app, services);
}
