import type { FastifyRequest } from 'fastify';
import type { Actor, HumanAccess, Task, TaskDetail } from '@projectman/shared';
import type { AuthUser } from '../auth/auth-service';
import type { Domain, ProjectAccess } from '../domain';
import { DomainError, forbidden, hasAccess, humanActor, notFound } from '../domain';
import type { Author } from '../domain';

export function currentUser(request: FastifyRequest): AuthUser {
  if (!request.user) throw new DomainError('unauthorized', 'login required', { status: 401 });
  return request.user;
}

/**
 * The user's membership in the project, with at least `minimum` access. Clients see only
 * what is shared with them, so `internal` rejects them.
 */
export async function requireAccess(
  domain: Domain,
  request: FastifyRequest,
  projectKey: string,
  opts: { minimum?: HumanAccess; internal?: boolean } = {},
): Promise<ProjectAccess> {
  const user = currentUser(request);
  if (!domain.projects.has(projectKey)) throw notFound('project', projectKey);
  const access = await domain.accessFor(projectKey, user.email);
  if (!access) throw forbidden('not_a_member', 'you are not a member of this project');
  if (opts.internal && access.access === 'client') {
    throw forbidden('insufficient_access', 'not available to client members');
  }
  if (opts.minimum && !hasAccess(access.access, opts.minimum)) {
    throw forbidden('insufficient_access', `requires ${opts.minimum} access`);
  }
  return access;
}

export function actorOf(access: ProjectAccess): Actor {
  return humanActor(access.handle);
}

export function authorOf(request: FastifyRequest): Author {
  const user = currentUser(request);
  return { name: user.name, email: user.email };
}

/** Internal tasks are hidden from client members. */
export function canSeeTask(access: ProjectAccess, task: Task): boolean {
  return access.access !== 'client' || task.visibility === 'shared';
}

const CLIENT_TIMELINE = new Set(['task_created', 'task_stage_changed', 'task_check_changed']);

/** What a client member may see of a task: the task and its main milestones. */
export function detailFor(access: ProjectAccess, detail: TaskDetail): TaskDetail {
  if (access.access !== 'client') return detail;
  return {
    task: detail.task,
    timeline: detail.timeline.filter((e) => CLIENT_TIMELINE.has(e.type)),
    sessions: [],
  };
}
