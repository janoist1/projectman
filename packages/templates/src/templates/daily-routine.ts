import type { MemberSchedule } from '@projectman/shared';
import { defineTemplate } from './draft';

/**
 * The daily worker's run: 08:00 on weekdays in the project's time zone. The prompt is
 * English like every prompt text; the member answers in the project's language.
 */
export const DAILY_WORKER_SCHEDULE: MemberSchedule = {
  cron: '0 8 * * 1-5',
  prompt:
    "It is time for your daily maintenance round. Check the project's repositories without changing " +
    'them: outdated dependencies (security fixes first), failing or flaky tests, and small technical ' +
    'debt worth fixing. Create a task with create_task for each finding that needs work, with what you ' +
    'found and a suggested fix. Then send the owner a short summary with send_message: what you ' +
    'checked and what needs attention first.',
};

/**
 * The owner and a daily worker: a maintainer on a weekday-morning schedule for recurring
 * upkeep ("daily worker" is a schedule, not a role). Routine tasks go through ready, work
 * and done.
 */
export const dailyRoutine = defineTemplate('daily-routine', (t) => {
  const worker = t.hire('maintainer', {
    name: 'daily_worker',
    handle: 'daily',
    schedule: DAILY_WORKER_SCHEDULE,
  });

  return t.finish({
    columns: [t.column('ready'), t.column('in_progress'), t.column('done')],
    stages: [
      t.stage('ready', 'queue', 'ready', []),
      t.stage('work', 'work', 'in_progress', [worker]),
      t.stage('done', 'done', 'done', []),
    ],
  });
});
