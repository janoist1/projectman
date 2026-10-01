import { Link } from 'react-router';
import { useRunSchedule, useSchedules } from '../../api/queries';
import { isApiError } from '../../api/client';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { ErrorState, LoadingState } from '../../components/States';
import { useToast } from '../../components/toastContext';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import { formatScheduleTime, scheduleReason } from '../../lib/schedules';
import styles from './ScheduledRuns.module.css';

export function MemberScheduleControl({ handle }: { handle: string }) {
  const { key, can } = useProject();
  const schedules = useSchedules(key);
  const run = useRunSchedule(key);
  const toast = useToast();
  const member = schedules.data?.members.find((m) => m.member === handle);
  if (!member) return null;
  return (
    <div className={styles.control}>
      <small>
        {t('schedules.next', { time: formatScheduleTime(member.nextRun, schedules.data!.timezone) })}
      </small>
      {can.manageTeam ? (
        <Button
          size="sm"
          disabled={run.isPending}
          onClick={() => run.mutate(handle, { onSuccess: () => toast.show(t('schedules.runStarted')) })}
        >
          {t('schedules.runNow')}
        </Button>
      ) : null}
      {run.error ? (
        <p className={styles.reason} role="alert">
          {isApiError(run.error) && run.error.status === 409
            ? scheduleReason(run.error.code)
            : errorMessage(run.error)}
        </p>
      ) : null}
    </div>
  );
}

export function RecentScheduleRuns() {
  const { key } = useProject();
  const schedules = useSchedules(key);
  return (
    <section className={styles.section} aria-labelledby="schedule-runs">
      <h2 id="schedule-runs">{t('schedules.title')}</h2>
      {schedules.isError ? (
        <ErrorState error={schedules.error} onRetry={() => void schedules.refetch()} />
      ) : !schedules.data ? (
        <LoadingState compact />
      ) : schedules.data.runs.length === 0 ? (
        <p>{t('schedules.empty')}</p>
      ) : (
        <ul className={styles.runs}>
          {schedules.data.runs.map((run) => (
            <li key={run.id}>
              {run.sessionId ? (
                <Link to={`/p/${key}/sessions/${run.sessionId}`}>{run.member}</Link>
              ) : (
                <span>{run.member}</span>
              )}
              {' · '}
              {formatScheduleTime(run.scheduledFor, schedules.data.timezone)}
              {' · '}
              <span>{t(`schedules.statuses.${run.status}`)}</span>
              {run.reason ? <> · {scheduleReason(run.reason)}</> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
