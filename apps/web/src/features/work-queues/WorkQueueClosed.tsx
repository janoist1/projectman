import { useMemo, useState } from 'react';
import { MEMBER_QUEUE_CLOSED_LIMIT } from '@projectman/shared';
import type { WorkQueueGroup, WorkQueueRef } from '@projectman/shared';
import { useWorkQueue } from '../../api/queries';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { SegmentedControl } from '../../components/SegmentedControl';
import { ErrorState, LoadingState } from '../../components/States';
import { t } from '../../i18n/t';
import { nameOf } from '../../lib/members';
import { parseWorkQueueRef, workQueueRefId } from '../../lib/workQueues';
import { ClosedWorkQueueItem } from './WorkQueueItem';
import styles from './WorkQueueClosed.module.css';

type Range = 'today' | 'week';

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * "Lezárt tételek": the newest closed items of one queue, today or the last seven days. It reads only while it is
 * open. The queue is the one the filter names; without one the project manager's, with a picker.
 */
export function WorkQueueClosed({
  groups,
  fixed,
  fallback,
}: {
  groups: readonly WorkQueueGroup[];
  /** The queue the filter names. */
  fixed: WorkQueueRef | null;
  /** The queue shown when none is named: the project manager's. */
  fallback: WorkQueueRef | null;
}) {
  const { key, myHandle } = useProject();
  const { members } = useProjectIndexes(key);
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState<Range>('today');
  const [picked, setPicked] = useState<string | null>(null);
  const [dayStart] = useState(() => startOfDay(new Date()));
  const closedSince = useMemo(() => {
    const since = range === 'today' ? dayStart : new Date(dayStart.getTime() - 7 * 86_400_000);
    return since.toISOString();
  }, [dayStart, range]);

  const choices = groups.filter((group) => group.queue.type === 'member' || !group.restricted);
  const firstChoice = choices[0]?.queue ?? null;
  const queue: WorkQueueRef | null = fixed ?? parseWorkQueueRef(picked) ?? fallback ?? firstChoice;
  const group = queue ? groups.find((g) => workQueueRefId(g.queue) === workQueueRefId(queue)) : undefined;
  const restricted = group?.restricted === true;
  const detail = useWorkQueue(
    key,
    queue ?? { type: 'integrator' },
    closedSince,
    open && queue !== null && !restricted,
  );
  const closed = detail.data?.closed ?? [];
  const nameOfQueue = (ref: WorkQueueRef) =>
    ref.type === 'integrator' ? t('workQueues.integrator.name') : nameOf(ref.member, members, myHandle);

  return (
    <details className={styles.closed} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{t('workQueues.closed.title')}</summary>
      <div className={styles.tools}>
        {fixed === null && choices.length > 1 ? (
          <label className={styles.field}>
            <span>{t('workQueues.closed.queue')}</span>
            <select
              className={styles.select}
              value={queue ? workQueueRefId(queue) : ''}
              onChange={(event) => setPicked(event.target.value)}
            >
              {choices.map((choice) => (
                <option key={workQueueRefId(choice.queue)} value={workQueueRefId(choice.queue)}>
                  {nameOfQueue(choice.queue)}
                </option>
              ))}
            </select>
          </label>
        ) : queue ? (
          <span className={styles.queueName}>{nameOfQueue(queue)}</span>
        ) : null}
        <SegmentedControl<Range>
          label={t('workQueues.closed.range')}
          size="sm"
          value={range}
          onChange={setRange}
          options={[
            { value: 'today', label: t('workQueues.closed.today') },
            { value: 'week', label: t('workQueues.closed.week') },
          ]}
        />
      </div>
      {!open ? null : restricted ? (
        <p className={styles.note}>{t('workQueues.closed.integratorNone')}</p>
      ) : detail.isPending && detail.fetchStatus !== 'idle' ? (
        <LoadingState compact />
      ) : detail.isError && !detail.data ? (
        <ErrorState compact error={detail.error} onRetry={() => void detail.refetch()} />
      ) : closed.length > 0 ? (
        <ul className={styles.list} aria-label={t('workQueues.closed.title')}>
          {closed.map((item) => (
            <ClosedWorkQueueItem key={item.id} item={item} />
          ))}
        </ul>
      ) : (
        <p className={styles.note}>
          {t(
            queue?.type === 'integrator'
              ? 'workQueues.closed.integratorNone'
              : range === 'today'
                ? 'workQueues.closed.emptyToday'
                : 'workQueues.closed.emptyWeek',
          )}
        </p>
      )}
      {open && closed.length >= MEMBER_QUEUE_CLOSED_LIMIT ? (
        <p className={styles.note}>{t('workQueues.closed.limit', { count: MEMBER_QUEUE_CLOSED_LIMIT })}</p>
      ) : null}
    </details>
  );
}
