import type { FastifyInstance } from 'fastify';
import { CreateTaskRequest, routes, StartTaskRequest, UpdateTaskRequest } from '@projectman/shared';
import type { Task, TaskDetail } from '@projectman/shared';
import type { Domain } from '../domain';
import { notFound } from '../domain';
import { actorOf, authorOf, canSeeTask, detailFor, requireAccess } from './context';
import { parseBody } from './validation';

type ProjectParams = { Params: { key: string } };
type TaskParams = { Params: { key: string; taskKey: string } };

export function registerTaskRoutes(app: FastifyInstance, domain: Domain): void {
  app.get<ProjectParams>(routes.tasks(':key'), async (request): Promise<Task[]> => {
    const access = await requireAccess(domain, request, request.params.key);
    return domain.tasks.list(request.params.key).filter((t) => canSeeTask(access, t));
  });

  app.post<ProjectParams>(routes.tasks(':key'), async (request, reply) => {
    const access = await requireAccess(domain, request, request.params.key, { minimum: 'developer' });
    const body = parseBody(CreateTaskRequest, request.body);
    const task = await domain.tasks.create(request.params.key, body, actorOf(access));
    return reply.code(201).send(task);
  });

  app.get<TaskParams>(routes.task(':key', ':taskKey'), async (request): Promise<TaskDetail> => {
    const { key, taskKey } = request.params;
    const access = await requireAccess(domain, request, key);
    const detail = domain.tasks.detail(key, taskKey);
    if (!canSeeTask(access, detail.task)) throw notFound('task', taskKey);
    return detailFor(access, detail);
  });

  /** A stage move is gated: 409 gate_blocked, or 409 approval_requested when approvers were asked. */
  app.patch<TaskParams>(routes.task(':key', ':taskKey'), async (request): Promise<Task> => {
    const { key, taskKey } = request.params;
    const access = await requireAccess(domain, request, key, { minimum: 'developer' });
    const body = parseBody(UpdateTaskRequest, request.body);
    return domain.tasks.update(key, taskKey, body, actorOf(access));
  });

  /** Assigns a developer (explicit, current, free or a temp worker), moves to work and starts the session. */
  app.post<TaskParams>(routes.startTask(':key', ':taskKey'), async (request): Promise<TaskDetail> => {
    const { key, taskKey } = request.params;
    const access = await requireAccess(domain, request, key, { minimum: 'developer' });
    const body = parseBody(StartTaskRequest, request.body);
    await domain.scheduler.startTask(key, taskKey, {
      assignee: body.assignee,
      actor: actorOf(access),
      author: authorOf(request),
      sponsor: access.handle,
    });
    return domain.tasks.detail(key, taskKey);
  });
}
