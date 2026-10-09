import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ProjectFocusAddRequest, ProjectFocusMoveRequest, routes } from '@projectman/shared';
import type { ProjectFocusChanges, ProjectFocusView } from '@projectman/shared';
import type { Domain } from '../domain';
import { actorOf, requireAccess } from './context';
import { parseBody } from './validation';

const ChangesQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

/** The project's focus (PM-427): internal members read it; whoever may set it writes. */
export function registerProjectFocusRoutes(app: FastifyInstance, domain: Domain): void {
  const view = (projectKey: string, access: Parameters<typeof actorOf>[0]): Promise<ProjectFocusView> =>
    domain.projectFocus.view(projectKey, actorOf(access));

  app.get<{ Params: { key: string } }>(routes.projectFocus(':key'), async (request) => {
    const key = request.params.key;
    return view(key, await requireAccess(domain, request, key, { internal: true }));
  });

  app.post<{ Params: { key: string } }>(routes.projectFocusItems(':key'), async (request) => {
    const key = request.params.key;
    const access = await requireAccess(domain, request, key, { internal: true });
    const body = parseBody(ProjectFocusAddRequest, request.body);
    await domain.projectFocus.add(key, body.key, actorOf(access), body.position);
    return view(key, access);
  });

  app.patch<{ Params: { key: string; taskKey: string } }>(
    routes.projectFocusItem(':key', ':taskKey'),
    async (request) => {
      const { key, taskKey } = request.params;
      const access = await requireAccess(domain, request, key, { internal: true });
      const body = parseBody(ProjectFocusMoveRequest, request.body);
      await domain.projectFocus.move(key, taskKey, body.position, actorOf(access));
      return view(key, access);
    },
  );

  app.delete<{ Params: { key: string; taskKey: string } }>(
    routes.projectFocusItem(':key', ':taskKey'),
    async (request) => {
      const { key, taskKey } = request.params;
      const access = await requireAccess(domain, request, key, { internal: true });
      await domain.projectFocus.remove(key, taskKey, actorOf(access));
      return view(key, access);
    },
  );

  app.get<{ Params: { key: string } }>(
    routes.projectFocusChanges(':key'),
    async (request): Promise<ProjectFocusChanges> => {
      const key = request.params.key;
      await requireAccess(domain, request, key, { internal: true });
      const { limit } = parseBody(ChangesQuery, request.query);
      return { events: domain.projectFocus.changes(key, limit) };
    },
  );
}
