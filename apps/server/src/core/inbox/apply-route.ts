import { coordinationMemberOf, itemRouteRecord, routeItem } from '@projectman/shared';
import type {
  ItemRoute,
  ItemRouteKind,
  ItemRouteRecord,
  ItemRouteRequested,
  ItemRouteTopic,
  ProjectConfig,
  QuestionRecipient,
} from '@projectman/shared';
import { conflict, DomainError, invalid } from '../../kernel';

/** What the caller knows of the item it routes; the rest (the integrator, the project manager) is read here. */
export interface RouteRequest {
  kind: ItemRouteKind;
  topic?: ItemRouteTopic | null;
  requested?: ItemRouteRequested;
  /** Whether the member who classified the item as machine work may do that (`machineTodoIssuerAllowed`). */
  issuerMachineAccess?: boolean;
  /** The project's technical decider the item can go to instead (`technicalDeciderOf`), or null. */
  decider?: string | null;
  alertReason?: string;
  outageAffectsPm?: boolean;
  ownerSilentSignal?: boolean;
  /** What a `owner_topic_required` refusal tells the asker (the project's topics and the other ways out). */
  topicGuidance?: string;
}

/** The route as the caller executes it: the item's recipient, the member it is forwarded to, and its trace. */
export interface AppliedRoute {
  route: ItemRoute;
  record: ItemRouteRecord;
  /** `integrator`: it waits in the machine queue; `owner`: it is in the owners' inbox or on their side. */
  recipient: QuestionRecipient;
  forwardTo: string | null;
}

/**
 * The one place a route is decided and turned into what the caller does (PM-1246): it asks the shared
 * `routeItem` with the facts of the project, refuses with the rule's refusal, and leaves the recipient
 * and the forward target. Nothing else in the server chooses a recipient. An integrator is available when an owner
 * has a live super key, but that never decides the owners as a fallback: machine work waits in the queue.
 */
export function applyRoute(
  config: ProjectConfig,
  integratorAvailable: boolean,
  request: RouteRequest,
): AppliedRoute {
  const input = {
    kind: request.kind,
    topic: request.topic ?? null,
    requested: request.requested ?? null,
    issuerMachineAccess: request.issuerMachineAccess ?? true,
    pm: coordinationMemberOf(config) ? ('available' as const) : ('none' as const),
    integrator: integratorAvailable,
    decider: !!request.decider,
    ...(request.alertReason ? { alertReason: request.alertReason } : {}),
    ...(request.outageAffectsPm ? { outageAffectsPm: true } : {}),
    ...(request.ownerSilentSignal ? { ownerSilentSignal: true } : {}),
  };
  const route = routeItem(input);
  if (route.to === 'refuse') {
    if (route.refusal === 'no_machine_access')
      throw conflict(
        'issuer_without_machine_access',
        'the member who classified this as machine work has no machine access, so it cannot go to the integrator',
      );
    if (route.refusal === 'owner_topic_required')
      throw new DomainError(
        'owner_topic_required',
        request.topicGuidance ?? 'an owner decision needs the owner topic it falls under',
      );
    throw invalid('invalid_request', `the route refused the item: ${route.refusal}`);
  }
  return {
    route,
    record: itemRouteRecord(input, route),
    recipient: route.to === 'integrator_queue' ? 'integrator' : 'owner',
    forwardTo: route.to === 'decider' ? (request.decider ?? null) : null,
  };
}
