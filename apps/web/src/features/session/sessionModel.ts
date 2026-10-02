import type { Session, Task } from '@projectman/shared';
import { t } from '../../i18n/t';
import { formatScheduleTime } from '../../lib/schedules';
import { sessionStatus } from '../../lib/sessions';
import type { SessionStatus } from '../../lib/sessions';

/** When a scheduled session's run was due, in the project's time zone. */
export interface ScheduleTime {
  scheduledFor: string | undefined;
  timezone: string | undefined;
}

/** The session's title: its task, its scheduled run, or the member's conversation or meeting. */
export function sessionTitle(
  session: Pick<Session, 'workItem' | 'startedAt'>,
  task: Pick<Task, 'title'> | null,
  memberName: string,
  schedule: ScheduleTime,
): string {
  if (task) return task.title;
  if (session.workItem.type === 'schedule')
    return t('schedules.session', {
      time: formatScheduleTime(schedule.scheduledFor ?? session.startedAt, schedule.timezone ?? 'UTC'),
    });
  if (session.workItem.type === 'general') return t('session.general', { member: memberName });
  return t('session.meeting', { member: memberName });
}

/** The live status in the header: a permission waiting for the viewer comes first. */
export function liveState(
  session: Pick<Session, 'state'>,
  needsYou: boolean,
): { status: SessionStatus; label: string } {
  return {
    status: sessionStatus(session, needsYou),
    label: needsYou ? t('sessionState.needsYou') : t(`sessionState.${session.state}`),
  };
}
