import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { WorkQueueReason, workQueueScopeOf } from '@projectman/shared';
import type { WorkQueueRef } from '@projectman/shared';
import { useWorkQueues } from '../../api/queries';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { Button } from '../../components/Button';
import { ErrorState } from '../../components/States';
import { formatTime } from '../../i18n/format';
import { t } from '../../i18n/t';
import { errorCode } from '../../lib/errors';
import { nameOf } from '../../lib/members';
import { parseWorkQueueRef, sameWorkQueue, workQueueRefId } from '../../lib/workQueues';
import { useOperator } from '../operator/useOperator';
import { RestrictedWorkQueueGroup, WorkQueueGroup } from './WorkQueueGroup';
import { WorkQueueClosed } from './WorkQueueClosed';
import { useMinuteClock } from './useMinuteClock';
import {
  NO_WORK_QUEUE_FILTER,
  hasStaleWorkQueueParams,
  isWorkQueueFiltered,
  layoutWorkQueues,
  parseWorkQueueFilter,
  workQueueTotals,
  writeWorkQueueFilter,
} from './workQueueFilters';
import type { WorkQueueFilter } from './workQueueFilters';
import styles from './WorkQueuesView.module.css';

/** What the Operator panel hands to the view when it sends the viewer here (`location.state`). */
interface FromOperatorState {
  fromOperator?: { path: string };
}

/** The search debounce before the text goes into the URL. */
const SEARCH_DELAY_MS = 300;

function Notice({ title, lead, action }: { title: string; lead?: string; action?: ReactNode }) {
  return (
    <div className={styles.notice}>
      <h3>{title}</h3>
      {lead ? <p>{lead}</p> : null}
      {action}
    </div>
  );
}

/**
 * Csapat → Munkasorok (PM-1294): what waits for every AI member and for the connected Claude, how long and why.
 * Its filters live in the URL (`queue`, `reason`, `long`, `q`) so a view can be linked.
 */
export function WorkQueuesView() {
  const { key, me, myHandle } = useProject();
  const { members } = useProjectIndexes(key);
  const access = me.projects.find((project) => project.key === key)?.access;
  const scope = access ? workQueueScopeOf({ access }) : null;
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const nowMs = useMinuteClock();
  const operator = useOperator();
  const query = useWorkQueues(key, scope !== null);
  const heading = useRef<HTMLHeadingElement>(null);
  const filter = parseWorkQueueFilter(params);
  const fromOperator = (location.state as FromOperatorState | null)?.fromOperator;
  const [text, setText] = useState(filter.q);

  // The filters go into the URL with `replace`; the state of the page (the way back to the panel) stays.
  const update = (change: Partial<WorkQueueFilter>) =>
    setParams(
      (previous) => writeWorkQueueFilter(previous, { ...parseWorkQueueFilter(previous), ...change }),
      { replace: true, state: location.state },
    );

  // A value the view does not know is dropped from the URL, silently.
  useEffect(() => {
    if (hasStaleWorkQueueParams(params)) update({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  // The text field follows the URL (clearing the filters empties it) and writes it back after a pause.
  useEffect(() => setText(filter.q), [filter.q]);
  useEffect(() => {
    if (text === filter.q) return;
    const timer = setTimeout(() => update({ q: text }), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  // Arriving from the panel puts the focus on the title.
  useEffect(() => {
    if (fromOperator) heading.current?.focus();
  }, [fromOperator]);

  const forbidden = scope === null || errorCode(query.error) === 'work_queues_forbidden';
  const view = forbidden ? undefined : query.data;
  const clear = () => update(NO_WORK_QUEUE_FILTER);
  const lastUpdate = query.dataUpdatedAt ? formatTime(new Date(query.dataUpdatedAt)) : '';

  let body: ReactNode;
  if (forbidden) {
    body = (
      <div className={styles.notice} role="alert">
        {t('workQueues.forbidden')}
      </div>
    );
  } else if (!view) {
    body = query.isError ? (
      <ErrorState
        error={query.error}
        message={t('workQueues.loadFailed')}
        onRetry={() => void query.refetch()}
      />
    ) : (
      <div role="status" aria-label={t('app.loading')}>
        <p>{t('app.loading')}…</p>
        <div className={styles.skeleton} />
        <div className={styles.skeleton} />
        <div className={styles.skeleton} />
      </div>
    );
  } else {
    const layout = layoutWorkQueues(view, filter, nowMs);
    // The tiles follow the queue filter; the other filters do not narrow them.
    const pickedQueue = filter.queue;
    const totals = workQueueTotals(
      pickedQueue ? view.groups.filter((group) => sameWorkQueue(group.queue, pickedQueue)) : view.groups,
      nowMs,
    );
    // A picked queue the viewer may not read has no numbers to show, and no items to filter.
    const pickedRestricted = pickedQueue !== null && layout.restricted !== null;
    const filtered = isWorkQueueFiltered(filter);
    const pmQueue: WorkQueueRef | null = operator.handle ? { type: 'member', member: operator.handle } : null;
    const reasonOptions = WorkQueueReason.options;
    const stale = query.isError;
    body = (
      <>
        {stale ? (
          <div className={styles.stale} role="alert">
            <span>{t('workQueues.stale', { time: lastUpdate })}</span>
            <Button variant="ghost" size="sm" onClick={() => void query.refetch()}>
              {t('workQueues.retry')}
            </Button>
          </div>
        ) : null}
        {pickedRestricted ? null : (
          <div className={styles.metrics} role="group" aria-label={t('workQueues.tiles.label')}>
            <div className={styles.metric}>
              <b>{totals.queued}</b>
              <span>{t('workQueues.tiles.queued')}</span>
            </div>
            <div className={styles.metric}>
              <b>{totals.processing}</b>
              <span>{t('workQueues.tiles.processing')}</span>
            </div>
            <button
              type="button"
              className={clsx(styles.metric, styles.metricWarn)}
              aria-pressed={filter.long}
              onClick={() => update({ long: !filter.long })}
            >
              <b>{totals.longAtLeast ? `≥ ${totals.long}` : totals.long}</b>
              <span>{t('workQueues.tiles.long')}</span>
            </button>
          </div>
        )}
        <div className={styles.tools} role="group" aria-label={t('workQueues.filtersLabel')}>
          <input
            type="search"
            className={styles.search}
            value={text}
            placeholder={t('workQueues.search')}
            aria-label={t('workQueues.search')}
            onChange={(event) => setText(event.target.value)}
          />
          {scope === 'all' ? (
            <select
              className={styles.select}
              aria-label={t('workQueues.queueFilter')}
              value={filter.queue ? workQueueRefId(filter.queue) : ''}
              onChange={(event) => update({ queue: parseWorkQueueRef(event.target.value) })}
            >
              <option value="">{t('workQueues.allQueues')}</option>
              {view.groups.map((group) => (
                <option key={workQueueRefId(group.queue)} value={workQueueRefId(group.queue)}>
                  {group.queue.type === 'integrator'
                    ? t('workQueues.integrator.name')
                    : nameOf(group.queue.member, members, myHandle)}
                </option>
              ))}
            </select>
          ) : null}
          <select
            className={styles.select}
            aria-label={t('workQueues.reasonFilter')}
            value={filter.reason ?? ''}
            onChange={(event) =>
              update({ reason: WorkQueueReason.safeParse(event.target.value).data ?? null })
            }
          >
            <option value="">{t('workQueues.allReasons')}</option>
            {reasonOptions.map((reason) => (
              <option key={reason} value={reason}>
                {t(`workQueues.reasons.${reason}`)}
              </option>
            ))}
          </select>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={filter.long}
              onChange={(event) => update({ long: event.target.checked })}
            />
            {t('workQueues.onlyLong')}
          </label>
        </div>
        <div className={styles.statusLine}>
          <span>{t('workQueues.status.updated', { time: lastUpdate })}</span>
          {stale ? null : <span>{`✓ ${t('workQueues.status.live')}`}</span>}
        </div>

        {layout.missingQueue ? (
          <Notice
            title={t('workQueues.missing')}
            action={
              <Button variant="secondary" size="md" onClick={clear}>
                {t('workQueues.clear')}
              </Button>
            }
          />
        ) : layout.openCount === 0 && !filtered ? (
          <Notice
            title={t(layout.everQueued ? 'workQueues.empty.title' : 'workQueues.first.title')}
            lead={t(layout.everQueued ? 'workQueues.empty.lead' : 'workQueues.first.lead')}
          />
        ) : layout.itemized.length === 0 && filtered && !pickedRestricted ? (
          <Notice
            title={t('workQueues.noMatch')}
            action={
              <Button variant="secondary" size="md" onClick={clear}>
                {t('workQueues.clear')}
              </Button>
            }
          />
        ) : null}

        {layout.itemized.map((entry) => (
          <WorkQueueGroup
            key={workQueueRefId(entry.group.queue)}
            group={entry.group}
            filter={filter}
            nowMs={nowMs}
          />
        ))}
        {layout.restricted ? <RestrictedWorkQueueGroup group={layout.restricted} nowMs={nowMs} /> : null}
        {layout.bare.map((group) => (
          <WorkQueueGroup
            key={workQueueRefId(group.queue)}
            group={group}
            filter={filter}
            nowMs={nowMs}
            emptyText={
              scope === 'project_manager' && group.queue.type === 'member' && group.items.length === 0
                ? t('workQueues.group.pmEmpty')
                : undefined
            }
          />
        ))}
        {layout.empty.length > 0 ? (
          <details className={styles.rest}>
            <summary>{t('workQueues.emptyQueues', { count: layout.empty.length })}</summary>
            <div className={styles.restGrid}>
              {layout.empty.map((group) => (
                <button
                  key={workQueueRefId(group.queue)}
                  type="button"
                  className={styles.restButton}
                  onClick={() => update({ ...NO_WORK_QUEUE_FILTER, queue: group.queue })}
                >
                  <span>
                    {group.queue.type === 'member' ? nameOf(group.queue.member, members, myHandle) : null}
                  </span>
                  <span className={styles.muted}>0</span>
                </button>
              ))}
            </div>
          </details>
        ) : null}

        <p className={styles.hint}>
          {t('workQueues.hint')} {t('workQueues.readOnly')}
        </p>
        <WorkQueueClosed groups={view.groups} fixed={filter.queue} fallback={pmQueue} />
      </>
    );
  }

  return (
    <div className={styles.view}>
      {fromOperator ? (
        <Link to={fromOperator.path} state={{ operatorOpen: true }} className={styles.back}>
          {t('workQueues.back')}
        </Link>
      ) : null}
      <h2 ref={heading} tabIndex={-1} className={styles.title}>
        {t('workQueues.title')}
      </h2>
      <p className={styles.lead}>{t('workQueues.lead')}</p>
      {body}
    </div>
  );
}
