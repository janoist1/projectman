import {
  canSetComplexity,
  COMPLEXITY_REASON_MAX,
  isComplexityPoints,
  isOpenTask,
  isTheme,
} from '@projectman/shared';
import type {
  Actor,
  ComplexityRequest,
  ProjectConfig,
  Task,
  TaskComplexity,
  TimelineEventData,
} from '@projectman/shared';
import { actorHandle, conflict, forbidden, invalid, themeRefused } from '../../kernel';

export interface ComplexityChange {
  next: TaskComplexity | null;
  event: TimelineEventData['task_complexity_changed'];
}

/** Plan the complete change before any task fields are written. */
export function planComplexity(
  config: Pick<ProjectConfig, 'team'>,
  task: Pick<Task, 'key' | 'kind' | 'status' | 'complexity'> | null,
  request: ComplexityRequest,
  actor: Actor,
  at: string,
): ComplexityChange | null {
  const handle = actorHandle(actor);
  if (!canSetComplexity(config, handle))
    throw forbidden('complexity_forbidden', 'only an owner or a planning member may set complexity');
  if (task && isTheme(task)) throw themeRefused(task.key, 'have complexity points');
  if (task && !isOpenTask(task)) throw conflict('task_closed', `task ${task.key} is ${task.status}`);
  const points = request.points;
  if (points !== null && !isComplexityPoints(points))
    throw invalid('complexity_points_invalid', 'complexity must be 1, 2, 3, 5, 8 or 13');
  const reason = points === null ? null : request.reason?.trim() || null;
  if (reason && reason.length > COMPLEXITY_REASON_MAX)
    throw invalid('invalid_request', `complexity reason is at most ${COMPLEXITY_REASON_MAX} characters`);
  const previous = task?.complexity
    ? { points: task.complexity.points, reason: task.complexity.reason }
    : null;
  if ((!previous && points === null) || (previous?.points === points && previous.reason === reason))
    return null;
  return {
    next: points === null ? null : { points, reason, setBy: handle, setAt: at },
    event: { points, reason, previous },
  };
}
