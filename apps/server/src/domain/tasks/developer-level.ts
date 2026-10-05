import { canSetDeveloperLevel, DEVELOPER_LEVEL_REASON_MAX, isOpenTask, isTheme } from '@projectman/shared';
import type {
  Actor,
  DeveloperLevelRequest,
  ProjectConfig,
  Task,
  TaskDeveloperLevel,
  TimelineEventData,
} from '@projectman/shared';
import { conflict, forbidden, invalid, themeRefused } from '../errors';
import { actorHandle } from '../util';

/** A change of the card's recommended developer that passed the rules: what to store and what to record. */
export interface DeveloperLevelChange {
  next: TaskDeveloperLevel;
  event: TimelineEventData['task_level_changed'];
}

/**
 * Checks a request to set the recommended developer of a card (PM-347) and says what it changes, or
 * null when it changes nothing (same level and reason: no event, nothing written). `task` is null
 * while the card is created. A card without a recommendation counts as `any` with no reason.
 */
export function planDeveloperLevel(
  config: Pick<ProjectConfig, 'team'>,
  task: Pick<Task, 'key' | 'kind' | 'status' | 'developerLevel'> | null,
  request: DeveloperLevelRequest,
  actor: Actor,
  at: string,
): DeveloperLevelChange | null {
  const handle = actorHandle(actor);
  if (!canSetDeveloperLevel(config, handle))
    throw forbidden(
      'developer_level_forbidden',
      'only an owner, or a member who plans tasks or analyses requirements, may set the recommended developer',
    );
  if (task && isTheme(task)) throw themeRefused(task.key, 'have a recommended developer');
  if (task && !isOpenTask(task)) throw conflict('task_closed', `task ${task.key} is ${task.status}`);
  const reason = request.reason?.trim() || null;
  if (reason && reason.length > DEVELOPER_LEVEL_REASON_MAX)
    throw invalid(
      'invalid_request',
      `the reason of the recommended developer is at most ${DEVELOPER_LEVEL_REASON_MAX} characters`,
    );
  if (request.level === 'senior' && !reason)
    throw invalid(
      'developer_level_reason_required',
      'a Senior task needs a reason: say why it suits the Senior',
    );
  const previous = task?.developerLevel
    ? { level: task.developerLevel.level, reason: task.developerLevel.reason }
    : null;
  if ((previous?.level ?? 'any') === request.level && (previous?.reason ?? null) === reason) return null;
  return {
    next: { level: request.level, reason, setBy: handle, setAt: at },
    event: { level: request.level, reason, previous },
  };
}
