import clsx from 'clsx';
import { Link } from 'react-router';
import { isWorkQueueLongWait } from '@projectman/shared';
import type { WorkQueueItem as Item } from '@projectman/shared';
import { useLabels } from '../../api/queries';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { Icon } from '../../components/Icon';
import { formatDate, formatStamp, formatTime, formatWaitAge } from '../../i18n/format';
import { t, tDynamic } from '../../i18n/t';
import { inboxItemDomId } from '../../lib/inbox';
import { nameOf } from '../../lib/members';
import { workQueueReasonDetail, workQueueReasonText } from './workQueueText';
import styles from './WorkQueueItem.module.css';

/** Where the item's own title leads: its card, else its inbox item; nothing for a source with no page. */
function useItemLink(item: Item): string | null {
  const { key } = useProject();
  if (item.taskKey) return `/p/${key}/tasks/${item.taskKey}`;
  if (item.source.type === 'inbox') return `/p/${key}/inbox#${inboxItemDomId(item.source.inboxItemId)}`;
  return null;
}

/** The kind, the sender and the card (or the general desk) of an item. */
function ItemMeta({ item }: { item: Item }) {
  const { key, myHandle } = useProject();
  const { members } = useProjectIndexes(key);
  const from = item.from === null ? t('workQueues.item.system') : nameOf(item.from, members, myHandle);
  return (
    <div className={styles.meta}>
      <span>{t(`operator.queue.kinds.${item.kind}`)}</span>
      <span aria-hidden="true">·</span>
      <span>{t('workQueues.item.from', { name: from })}</span>
      <span aria-hidden="true">·</span>
      {item.taskKey ? (
        <Link to={`/p/${key}/tasks/${item.taskKey}`} className={styles.cardLink}>
          {item.taskKey}
        </Link>
      ) : (
        <span>{t('workQueues.item.general')}</span>
      )}
    </div>
  );
}

/** One open item of a queue: what it is, why it waits, for how long, and the times behind it. */
export function OpenWorkQueueItem({ item, nowMs }: { item: Item; nowMs: number }) {
  const { key, myHandle } = useProject();
  const { members } = useProjectIndexes(key);
  const labels = useLabels(key);
  const link = useItemLink(item);
  const processing = item.state === 'processing';
  // Thirty minutes of waiting or more, by the minute clock; an item being processed never counts.
  const long = isWorkQueueLongWait(item, nowMs);
  const now = new Date(nowMs);
  const detail = workQueueReasonDetail(item, {
    member: (handle) => nameOf(handle, members, myHandle),
    labels,
  });
  return (
    <li
      className={clsx(styles.item, long && styles.long)}
      tabIndex={-1}
      data-work-queue-item={item.id}
      data-long={long ? 'true' : undefined}
    >
      <div className={styles.main}>
        {link ? (
          <Link to={link} className={styles.title}>
            {item.title}
          </Link>
        ) : (
          <span className={styles.title}>{item.title}</span>
        )}
        <ItemMeta item={item} />
      </div>
      <div className={styles.reason}>
        <span className={clsx(styles.chip, processing && styles.chipLive)}>
          {processing ? t('workQueues.item.processing') : workQueueReasonText(item)}
        </span>
      </div>
      <div className={styles.age}>
        <b>{formatWaitAge(item.queuedAt, now)}</b>
        {long ? (
          <span className={clsx(styles.chip, styles.chipWarn)}>
            <Icon name="alertCircle" size={13} />
            {t('workQueues.item.long')}
          </span>
        ) : (
          <span className={styles.muted}>
            {processing ? t('workQueues.item.processing') : t('workQueues.item.waiting')}
          </span>
        )}
      </div>
      <details className={styles.details}>
        <summary>{t('workQueues.item.details')}</summary>
        <div className={styles.detailBody}>
          {detail ? <span>{detail}</span> : null}
          <span>
            {t('workQueues.item.queuedAt')}:{' '}
            <time dateTime={item.queuedAt}>{formatStamp(item.queuedAt)}</time>
          </span>
          {processing && item.startedAt ? (
            <span>
              {t('workQueues.item.startedAt')}:{' '}
              <time dateTime={item.startedAt}>{formatStamp(item.startedAt)}</time>
            </span>
          ) : null}
          {!processing && item.reasonSince ? (
            <span>
              {t('workQueues.item.reasonSince')}:{' '}
              <time dateTime={item.reasonSince}>{formatStamp(item.reasonSince)}</time>
            </span>
          ) : null}
          {item.waitFacts?.until ? (
            <span>{t('workQueues.item.resumeAt', { time: formatStamp(item.waitFacts.until) })}</span>
          ) : null}
          {item.restartedAt ? (
            <span>{t('workQueues.item.restartedAt', { time: formatStamp(item.restartedAt) })}</span>
          ) : null}
          {item.attempts > 1 ? <span>{t('workQueues.item.attempts', { count: item.attempts })}</span> : null}
          {item.source.type === 'inbox' ? (
            <Link to={`/p/${key}/inbox#${inboxItemDomId(item.source.inboxItemId)}`}>
              {t('workQueues.item.source')}
            </Link>
          ) : null}
        </div>
      </details>
    </li>
  );
}

/** What a member did with a closed item: done, handed to the owner, failed and handed over, or left out. */
function Outcome({ item }: { item: Item }) {
  const { key, isOwner } = useProject();
  const { outcome } = item;
  const summary = outcome?.summary ? <span className={styles.summary}>{outcome.summary}</span> : null;
  const inbox =
    outcome?.handoff && outcome.handoff.to !== 'super' && isOwner ? (
      <Link to={`/p/${key}/inbox#${inboxItemDomId(outcome.handoff.inboxItemId)}`} className={styles.inbox}>
        {t('operator.queue.outcome.inbox')} ›
      </Link>
    ) : null;

  if (item.state === 'cancelled') {
    return (
      <div className={clsx(styles.did, styles.didQuiet)}>
        <span>
          {t('operator.queue.outcome.cancelled')} {summary}
        </span>
      </div>
    );
  }
  if (item.state === 'handed_off') {
    const handoff = outcome?.handoff;
    if (handoff?.reason === 'processing_failed') {
      return (
        <div className={clsx(styles.did, styles.didFailed)}>
          <Icon name="alertCircle" size={15} />
          <span>
            {t(
              handoff.to === 'super'
                ? 'operator.queue.outcome.failedSuper'
                : isOwner
                  ? 'operator.queue.outcome.failed'
                  : 'operator.queue.outcome.failedOwner',
            )}{' '}
            {item.attempts > 1 ? `${t('operator.queue.outcome.attempts', { count: item.attempts })} ` : null}
            {inbox}
            {summary}
          </span>
        </div>
      );
    }
    const reasons = isOwner && handoff?.to !== 'super' ? 'reasons' : 'reasonsOther';
    return (
      <div className={clsx(styles.did, styles.didHanded)}>
        <span>
          {handoff
            ? t(
                handoff.to === 'super'
                  ? 'operator.queue.outcome.handedOffSuper'
                  : isOwner
                    ? 'operator.queue.outcome.handedOff'
                    : 'operator.queue.outcome.handedOffOwner',
                {
                  reason: tDynamic(`operator.queue.outcome.${reasons}.${handoff.reason}`, handoff.reason),
                },
              )
            : t(
                isOwner
                  ? 'operator.queue.outcome.handedOffPlain'
                  : 'operator.queue.outcome.handedOffPlainOwner',
              )}{' '}
          {inbox}
          {summary}
        </span>
      </div>
    );
  }
  return (
    <div className={styles.did}>
      {outcome?.summary || t('operator.queue.outcome.done')}
      {outcome?.machine ? ` ${t('operator.queue.outcome.machine')}` : ''}
    </div>
  );
}

/** A closed item, with the box that says how it ended. */
export function ClosedWorkQueueItem({ item }: { item: Item }) {
  const at = item.closedAt ?? item.queuedAt;
  const link = useItemLink(item);
  return (
    <li className={clsx(styles.item, styles.closed)}>
      <div className={styles.main}>
        {link ? (
          <Link to={link} className={styles.title}>
            {item.title}
          </Link>
        ) : (
          <span className={styles.title}>{item.title}</span>
        )}
        <ItemMeta item={item} />
      </div>
      <div className={styles.age}>
        <time dateTime={at} title={`${formatDate(at)} ${formatTime(at)}`}>
          {formatStamp(at)}
        </time>
      </div>
      <div className={styles.outcome}>
        <Outcome item={item} />
      </div>
    </li>
  );
}
