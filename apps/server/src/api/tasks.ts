import type { FastifyInstance } from 'fastify';
import {
  ChangeTaskLabelsRequest,
  CreateTaskCommentRequest,
  CancelTaskRequest,
  CreateTaskRequest,
  ReopenTaskRequest,
  routes,
  StartTaskRequest,
  UpdateTaskRequest,
} from '@projectman/shared';
import type { Task, TaskDetail } from '@projectman/shared';
import type { Domain } from '../domain';
import { notFound } from '../domain';
import { canSeeTask, visibleTaskDetail } from '../domain/visibility';
import { actorOf, authorOf, requireAccess } from './context';
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
    return visibleTaskDetail(access, detail);
  });

  /** A stage move is gated: 409 gate_blocked, or 409 approval_requested when approvers were asked. */
  app.patch<TaskParams>(routes.task(':key', ':taskKey'), async (request): Promise<Task> => {
    const { key, taskKey } = request.params;
    const access = await requireAccess(domain, request, key, { minimum: 'developer' });
    const body = parseBody(UpdateTaskRequest, request.body);
    if (body.assignee !== undefined) await requireAccess(domain, request, key, { minimum: 'admin' });
    return domain.tasks.update(key, taskKey, body, actorOf(access));
  });

  app.post<TaskParams>(routes.taskComments(':key', ':taskKey'), async (request, reply) => {
    const { key, taskKey } = request.params;
    const access = await requireAccess(domain, request, key, { minimum: 'developer' });
    // Imported comments (author and time from elsewhere) are owner-only; the domain enforces it.
    const { text, ...imported } = parseBody(CreateTaskCommentRequest, request.body);
    await domain.tasks.addNote(key, taskKey, text, actorOf(access), null, imported);
    return reply.code(201).send(domain.tasks.detail(key, taskKey));
  });

  app.post<TaskParams>(routes.taskLabels(':key', ':taskKey'), async (request): Promise<TaskDetail> => {
    const { key, taskKey } = request.params;
    const access = await requireAccess(domain, request, key, { minimum: 'developer' });
    const body = parseBody(ChangeTaskLabelsRequest, request.body);
    await domain.tasks.changeLabels(key, taskKey, { add: body.add, remove: body.remove }, actorOf(access), {
      comment: body.comment,
    });
    return domain.tasks.detail(key, taskKey);
  });

  app.post<TaskParams>(routes.cancelTask(':key', ':taskKey'), async (request): Promise<Task> => {
    const { key, taskKey } = request.params;
    const access = await requireAccess(domain, request, key, { minimum: 'admin' });
    const body = parseBody(CancelTaskRequest, request.body);
    return domain.tasks.cancel(key, taskKey, body, actorOf(access));
  });

  app.post<TaskParams>(routes.reopenTask(':key', ':taskKey'), async (request): Promise<Task> => {
    const { key, taskKey } = request.params;
    const access = await requireAccess(domain, request, key, { minimum: 'admin' });
    parseBody(ReopenTaskRequest, request.body);
    return domain.tasks.reopen(key, taskKey, actorOf(access));
  });

  /** Assigns a developer (explicit, current, free or a temp worker), moves to work and starts the session. */
  app.post<TaskParams>(routes.startTask(':key', ':taskKey'), async (request): Promise<TaskDetail> => {
    const { key, taskKey } = request.params;
    const access = await requireAccess(domain, request, key, { minimum: 'developer' });
    const body = parseBody(StartTaskRequest, request.body);
    await domain.taskStarts.start(key, taskKey, {
      assignee: body.assignee,
      actor: actorOf(access),
      author: authorOf(request),
      sponsor: await domain.members.sponsorFor(access),
    });
    return domain.tasks.detail(key, taskKey);
  });
}
