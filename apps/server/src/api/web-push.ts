import type { FastifyInstance } from 'fastify';
import {
  PushSettings,
  routes,
  SubscribePushRequest,
  UnsubscribePushRequest,
  UpdatePushDeviceRequest,
} from '@projectman/shared';
import { currentUser } from './context';
import type { ApiDomain } from './ports';
import { invalid } from '../kernel';
import { parseBody } from '../http';

export function registerWebPushRoutes(app: FastifyInstance, domain: ApiDomain): void {
  app.get(routes.push(), async (request) => domain.webPush.overview(currentUser(request).id));
  app.put(routes.pushSettings(), async (request) => {
    const user = currentUser(request);
    const parsed = PushSettings.safeParse(request.body);
    if (!parsed.success) throw invalid('web_push_quiet_hours_invalid', 'Invalid push settings');
    return domain.webPush.settings(user.id, parsed.data);
  });
  app.post(routes.pushDevices(), async (request, reply) => {
    const user = currentUser(request);
    const result = domain.webPush.subscribe(
      user.id,
      parseBody(SubscribePushRequest, request.body),
      request.headers['user-agent'] ?? '',
      request.headers.origin,
    );
    return reply.code(result.created ? 201 : 200).send(result.device);
  });
  app.patch<{ Params: { id: string } }>(routes.pushDevice(':id'), async (request) => {
    const user = currentUser(request);
    return domain.webPush.updateDevice(
      user.id,
      request.params.id,
      parseBody(UpdatePushDeviceRequest, request.body).enabled,
    );
  });
  app.delete<{ Params: { id: string } }>(routes.pushDevice(':id'), async (request, reply) => {
    domain.webPush.removeDevice(currentUser(request).id, request.params.id);
    return reply.code(204).send();
  });
  app.post(routes.pushUnsubscribe(), async (request, reply) => {
    const user = currentUser(request);
    domain.webPush.unsubscribe(user.id, parseBody(UnsubscribePushRequest, request.body).endpoint);
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string } }>(routes.pushDeviceTest(':id'), async (request) =>
    domain.webPush.test(currentUser(request).id, request.params.id),
  );
}
