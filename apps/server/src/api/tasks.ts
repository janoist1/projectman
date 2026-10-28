import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  BoardMoveRequest,
  canCommentOnTask,
  ChangeTaskLabelsRequest,
  MAX_CLOSED_CARDS_DAYS,
  CreateTaskCommentRequest,
  CancelTaskRequest,
  CloseThemeRequest,
  CreateTaskRequest,
  ReopenTaskRequest,
  routes,
  StartTaskRequest,
  TASK_CREATE_MIN_ACCESS,
  UpdateTaskRequest,
} from '@projectman/shared';
import type {
  BoardMoveResult,
  ClosedCardsMeasure,
  Task,
  TaskDetail,
  TaskHandoffRecord,
  UpdateTaskResponse,
} from '@projectman/shared';
import type { ApiDomain } from './ports';
import { forbidden, notFound } from '../kernel';
import type { ProjectAccess } from '../core/members';
import { visibleTaskDetail } from '../core/projects';
import { actorOf, authorOf, requireAccess } from './context';
import { parseBody } from '../http';

type ProjectParams = { Params: { key: string } };
type TaskParams = { Params: { key: string; taskKey: string } };

const ClosedCardsQuery = z.object({
  days: z.coerce.number().int().min(1).max(MAX_CLOSED_CARDS_DAYS).optional(),
});

export function registerTaskRoutes(app: FastifyInstance, domain: ApiDomain): void {
  /** The detail the viewer sees, with why the card stands still (PM-460). */
  const detailFor = async (access: ProjectAccess, key: string, taskKey: string): Promise<TaskDetail> => {
    const detail = visibleTaskDetail(
      access,
      domain.cardMeasure.withRounds(domain.tasks.detail(key, taskKey)),
      (id) => domain.messages.get(id),
    );
    const wait = domain.taskWaits.ofCard(await domain.projects.config(key), detail.task, access.handle);
    return wait ? { ...detail, wait } : detail;
  };
  app.get<ProjectParams>(routes.tasks(':key'), async (request): Promise<Task[]> => {
    const access = await requireAccess(domain, request, request.params.key);
    return domain.tasks.list(request.params.key);
  });

  app.post<ProjectParams>(routes.tasks(':key'), async (request, reply) => {
    const access = await requireAccess(domain, request, request.params.key, {
      minimum: TASK_CREATE_MIN_ACCESS,
    });
    const body = parseBody(CreateTaskRequest, request.body);
    const task = await domain.tasks.create(request.params.key, body, actorOf(access));
    return reply.code(201).send(task);
  });

  app.get<TaskParams>(routes.task(':key', ':taskKey'), async (request): Promise<TaskDetail> => {
    const { key, taskKey } = request.params;
    const access = await requireAccess(domain, request, key);
    return detailFor(access, key, taskKey);
  });

  /** A stage move is gated: 409 gate_blocked, or 409 approval_requested when approvers were asked. */
  app.patch<TaskParams>(routes.task(':key', ':taskKey'), async (request): Promise<UpdateTaskResponse> => {
    const { key, taskKey } = request.params;
    const access = await requireAccess(domain, request, key, { minimum: 'developer' });
    const body = parseBody(UpdateTaskRequest, request.body);
    if (body.assignee !== undefined) await requireAccess(domain, request, key, { minimum: 'admin' });
    return domain.tasks.update(key, taskKey, body, actorOf(access));
  });

  /** A closed handoff of the card with its note or summary (PM-342); an unknown or foreign one is 404. */
  app.get<TaskParams & { Params: { handoffId: string } }>(
    routes.taskHandoff(':key', ':taskKey', ':handoffId'),
    async (request): Promise<TaskHandoffRecord> => {
      const { key, taskKey, handoffId } = request.params;
      await requireAccess(domain, request, key, { minimum: 'developer' });
      if (!domain.tasks.find(key, taskKey)) throw notFound('task', taskKey);
      return domain.handoffs.closedRecord(key, taskKey, handoffId);
    },
  );

  /** A card dropped on the board: a place in a column, with the gates of a stage move (PM-118). */
  app.post<TaskParams>(
    routes.boardMoveTask(':key', ':taskKey'),
    async (request): Promise<BoardMoveResult> => {
      const { key, taskKey } = request.params;
      const access = await requireAccess(domain, request, key, { minimum: 'developer' });
      const body = parseBody(BoardMoveRequest, request.body);
      return domain.tasks.moveOnBoard(key, taskKey, body, actorOf(access));
    },
  );

  app.post<TaskParams>(routes.taskComments(':key', ':taskKey'), async (request, reply) => {
    const { key, taskKey } = request.params;
    // Every member but the read-only viewer comments (PM-985); the domain checks the author again.
    const access = await requireAccess(domain, request, key);
    if (!canCommentOnTask(access.access))
      throw forbidden('insufficient_access', 'read-only members cannot comment');
    // Imported comments (author and time from elsewhere) are owner-only; the domain enforces it.
    const { text, ...imported } = parseBody(CreateTaskCommentRequest, request.body);
    await domain.tasks.addNote(key, taskKey, text, actorOf(access), null, imported);
    return reply.code(201).send(domain.cardMeasure.withRounds(domain.tasks.detail(key, taskKey)));
  });

  app.post<TaskParams>(routes.taskLabels(':key', ':taskKey'), async (request): Promise<TaskDetail> => {
    const { key, taskKey } = request.params;
    const access = await requireAccess(domain, request, key, { minimum: 'developer' });
    const body = parseBody(ChangeTaskLabelsRequest, request.body);
    await domain.tasks.changeLabels(key, taskKey, { add: body.add, remove: body.remove }, actorOf(access), {
      comment: body.comment,
    });
    return detailFor(access, key, taskKey);
  });

  app.post<TaskParams>(routes.cancelTask(':key', ':taskKey'), async (request): Promise<Task> => {
    const { key, taskKey } = request.params;
    const access = await requireAccess(domain, request, key, { minimum: 'admin' });
    const body = parseBody(CancelTaskRequest, request.body);
    return domain.tasks.cancel(key, taskKey, body, actorOf(access));
  });

  /** Closes a theme (PM-192): a person of developer access; 409 task_not_theme for any other card. */
  app.post<TaskParams>(routes.closeTheme(':key', ':taskKey'), async (request): Promise<Task> => {
    const { key, taskKey } = request.params;
    const access = await requireAccess(domain, request, key, { minimum: 'developer' });
    parseBody(CloseThemeRequest, request.body);
    return domain.tasks.closeTheme(key, taskKey, actorOf(access));
  });

  /** An admin reopens a card; a theme is reopened from developer access (the domain checks which). */
  app.post<TaskParams>(routes.reopenTask(':key', ':taskKey'), async (request): Promise<Task> => {
    const { key, taskKey } = request.params;
    const access = await requireAccess(domain, request, key, { minimum: 'developer' });
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
      despitePrerequisites: body.despitePrerequisites,
      startSetters: true,
      actor: actorOf(access),
      author: authorOf(request, access),
      sponsor: await domain.members.sponsorFor(access),
    });
    return detailFor(access, key, taskKey);
  });

  /**
   * The cards closed in the last `days` days (14 by default) with their review rounds, send-backs
   * and weighted tokens per model (PM-222). Every member reads it.
   */
  app.get<ProjectParams>(routes.closedCardsMeasure(':key'), async (request): Promise<ClosedCardsMeasure> => {
    await requireAccess(domain, request, request.params.key);
    const { days } = parseBody(ClosedCardsQuery, request.query);
    return domain.cardMeasure.closedCards(request.params.key, days);
  });
}
