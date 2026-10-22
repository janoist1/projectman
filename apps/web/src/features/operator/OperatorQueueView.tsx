import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { MEMBER_QUEUE_CLOSED_LIMIT } from '@projectman/shared';
import type { MemberQueueView, OperatorChannel, OperatorGrantState } from '@projectman/shared';
import { useOperatorQueue } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { ErrorState } from '../../components/States';
import { formatAgo, formatStamp, formatTime } from '../../i18n/format';
import { t } from '../../i18n/t';
import { operatorGrantExpiryText, operatorStripOf } from './operatorChannel';
import { ClosedQueueItem, OpenQueueItem } from './OperatorQueueItem';
import { useOperator } from './useOperator';
import styles from './OperatorQueue.module.css';

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** The local day, seven days back from it: "Korábbiak" reads that far. */
function weekAgo(dayStart: Date): Date {
  return new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate() - 7);
}

/** Whether the Operator works with the owner's grant for machine operations, until when, and where it is managed. */
function GrantLine({ grant, failed }: { grant: OperatorGrantState | undefined; failed: boolean }) {
  const { key } = useProject();
  if (failed) return <p className={styles.grantLine}>{t('operator.queue.grant.unknown')}</p>;
  if (!grant) return null;
  const settings = `/p/${key}/settings/integrator`;
  return (
    <p className={styles.grantLine}>
      {grant.active ? (
        <>
          <span className={styles.superChip}>{t('operator.queue.superChip')}</span>
          <span>{t('operator.queue.grant.on', { expiry: operatorGrantExpiryText(grant) })}</span>
        </>
      ) : (
        <>
          <span className={styles.offDot} aria-hidden="true" />
          <span>{t(grant.canManage ? 'operator.queue.grant.off' : 'operator.queue.grant.offOther')}</span>
        </>
      )}
      {grant.canManage ? (
        <Link to={settings}>
          {t(grant.active ? 'operator.queue.grant.manage' : 'operator.queue.grant.give')}
        </Link>
      ) : null}
    </p>
  );
}

/** How long the oldest open item has waited: minutes while it is recent, then since when. */
function oldestText(items: MemberQueueView['items']): string {
  const oldest = items[0];
  if (!oldest) return '';
  const recent = Date.now() - new Date(oldest.queuedAt).getTime() < 60 * 60_000;
  return recent
    ? t('operator.queue.summary.oldestAgo', { ago: formatAgo(oldest.queuedAt) })
    : t('operator.queue.summary.oldestSince', { since: formatStamp(oldest.queuedAt) });
}

function Summary({ view, channel }: { view: MemberQueueView; channel: OperatorChannel | undefined }) {
  if (view.items.length === 0) {
    return (
      <p className={styles.summaryLine}>
        <b>{t('operator.queue.summary.empty')}</b>
        <span className={styles.muted}>{t('operator.queue.summary.emptyHint')}</span>
      </p>
    );
  }
  const starting = operatorStripOf(channel)?.kind === 'starting';
  return (
    <p className={styles.summaryLine}>
      <b>{t('operator.queue.summary.count', { count: view.items.length })}</b>
      <span className={styles.muted}>
        {starting ? t('operator.queue.summary.starting') : oldestText(view.items)}
      </span>
    </p>
  );
}

/** The strip under the panel's head: what the Operator does now and how many wait; it opens the queue. */
export function OperatorQueueStrip({
  channel,
  onOpen,
}: {
  channel: OperatorChannel | undefined;
  onOpen: () => void;
}) {
  const strip = operatorStripOf(channel);
  if (!strip) return null;
  const text =
    strip.kind === 'now'
      ? t('operator.queue.strip.now', { title: strip.title })
      : strip.kind === 'starting'
        ? t('operator.queue.strip.starting')
        : t('operator.queue.strip.waiting', { status: strip.status, count: strip.open });
  return (
    <button
      type="button"
      className={styles.strip}
      aria-label={t('operator.queue.strip.label')}
      onClick={onOpen}
    >
      <span
        className={clsx(styles.stripDot, strip.kind === 'now' && styles.stripDotLive)}
        aria-hidden="true"
      />
      <span className={styles.stripText}>{text}</span>
      {strip.kind === 'now' && strip.more > 0 ? (
        <span className={styles.stripMore}>{t('operator.queue.strip.more', { count: strip.more })}</span>
      ) : null}
      <Icon name="chevronRight" size={14} />
    </button>
  );
}

/**
 * The Operator's queue (PM-890): what it works on and what waits, and the items it closed today (the earlier days
 * on request) with what it did. It reads the queue and the grant again by itself when they change, without a flash.
 */
export function OperatorQueueView({ onBack }: { onBack: () => void }) {
  const { key } = useProject();
  const { state, grant, grantFailed } = useOperator();
  const [dayStart] = useState(() => startOfDay(new Date()));
  const [earlier, setEarlier] = useState(false);
  const closedSince = (earlier ? weekAgo(dayStart) : dayStart).toISOString();
  const queue = useOperatorQueue(key, closedSince, true);
  const closedHeading = useRef<HTMLHeadingElement>(null);
  const earlierShown = useRef(false);

  // "Korábbiak" replaces itself with the longer list: the focus goes to its title.
  useEffect(() => {
    if (earlier && !earlierShown.current) closedHeading.current?.focus();
    earlierShown.current = earlier;
  }, [earlier]);

  const view = queue.data;
  // A reload that failed keeps the old list on screen, with one line above it.
  const refreshFailed = queue.isRefetchError && view !== undefined;

  // The restart bar: an item that was restarted since the viewer's day began (the closed ones of that day too).
  const restartedAt = view
    ? [...view.items, ...view.closed]
        .map((item) => item.restartedAt)
        .filter((at): at is string => at !== null && new Date(at).getTime() >= dayStart.getTime())
        .sort()
        .at(-1)
    : undefined;

  return (
    <div className={styles.view}>
      <Button variant="ghost" size="lg" icon="chevronLeft" className={styles.back} onClick={onBack}>
        {t('operator.queue.back')}
      </Button>
      <h3 className={styles.heading}>{t('operator.queue.title')}</h3>
      {queue.isPending ? (
        <div className={styles.skeleton} role="status" aria-label={t('app.loading')}>
          <span />
          <span />
          <span />
        </div>
      ) : !view ? (
        <ErrorState
          compact
          error={queue.error}
          message={t('operator.queue.loadFailed')}
          onRetry={() => void queue.refetch()}
        />
      ) : (
        <>
          {refreshFailed ? (
            <div className={styles.refreshFailed} role="alert">
              <span>{t('operator.queue.refreshFailed')}</span>
              <Button variant="ghost" size="sm" onClick={() => void queue.refetch()}>
                {t('operator.queue.retry')}
              </Button>
            </div>
          ) : null}
          <GrantLine grant={grant} failed={grantFailed} />
          {!view.everQueued ? (
            <div className={styles.empty}>
              <Icon name="list" size={28} />
              <h4>{t('operator.queue.first.title')}</h4>
              <p>{t('operator.queue.first.lead')}</p>
            </div>
          ) : (
            <>
              {restartedAt ? (
                <p className={styles.restarted} role="status">
                  <Icon name="alertCircle" size={15} />
                  <span>{t('operator.queue.restarted', { time: formatTime(restartedAt) })}</span>
                </p>
              ) : null}
              <Summary view={view} channel={state} />
              {view.items.length > 0 ? (
                <ul className={styles.list} aria-label={t('operator.queue.openList')}>
                  {view.items.map((item) => (
                    <OpenQueueItem key={item.id} item={item} />
                  ))}
                </ul>
              ) : null}
              <h4 ref={closedHeading} tabIndex={-1} className={styles.section}>
                {t(earlier ? 'operator.queue.closedWeek' : 'operator.queue.closedToday', {
                  count: view.closed.length,
                })}
              </h4>
              {view.closed.length > 0 ? (
                <ul className={styles.list} aria-label={t('operator.queue.closedList')}>
                  {view.closed.map((item) => (
                    <ClosedQueueItem key={item.id} item={item} />
                  ))}
                </ul>
              ) : (
                <p className={styles.muted}>{t('operator.queue.closedEmpty')}</p>
              )}
              {view.closed.length >= MEMBER_QUEUE_CLOSED_LIMIT ? (
                <p className={styles.muted}>
                  {t('operator.queue.limit', { count: MEMBER_QUEUE_CLOSED_LIMIT })}
                </p>
              ) : null}
              {!earlier ? (
                <Button variant="ghost" size="md" className={styles.earlier} onClick={() => setEarlier(true)}>
                  {t('operator.queue.earlier')}
                </Button>
              ) : null}
            </>
          )}
        </>
      )}
    </div>
  );
}
