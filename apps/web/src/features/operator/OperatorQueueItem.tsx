import clsx from 'clsx';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { MemberQueueItem, MemberQueueItemKind } from '@projectman/shared';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { Icon } from '../../components/Icon';
import type { IconName } from '../../components/Icon';
import { formatAgo, formatDate, formatTime } from '../../i18n/format';
import { t, tDynamic } from '../../i18n/t';
import { inboxItemDomId } from '../../lib/inbox';
import styles from './OperatorQueue.module.css';

const KIND_ICONS: Record<MemberQueueItemKind, IconName> = {
  todo: 'taskList',
  message: 'mail',
  fix_limit: 'loop',
  permission: 'lock',
  boundary: 'shield',
  screening: 'filter',
  signal: 'bell',
  start: 'play',
  checklist: 'taskList',
};

/** One row of the queue: the kind's icon, the title and who sent it, for which card, and how long ago. */
function ItemRow({
  item,
  at,
  current = false,
  children,
}: {
  item: MemberQueueItem;
  at: string;
  current?: boolean;
  children?: ReactNode;
}) {
  const { key } = useProject();
  const { members } = useProjectIndexes(key);
  const from =
    item.from === null ? t('operator.queue.system') : (members.get(item.from)?.displayName ?? item.from);
  return (
    <li className={clsx(styles.item, current && styles.current)}>
      <span className={styles.icon} aria-hidden="true">
        <Icon name={KIND_ICONS[item.kind]} size={15} />
      </span>
      <span className={styles.title}>
        {current ? <span className={styles.nowChip}>{t('operator.queue.now')}</span> : null}
        {item.title}
      </span>
      <span className={styles.meta}>
        {t(`operator.queue.kinds.${item.kind}`)} · {from}
        {item.taskKey ? (
          <>
            {' · '}
            <Link to={`/p/${key}/tasks/${item.taskKey}`}>{item.taskKey}</Link>
          </>
        ) : null}
        {' · '}
        <time dateTime={at} title={`${formatDate(at)} ${formatTime(at)}`}>
          {formatAgo(at)}
        </time>
      </span>
      {children}
    </li>
  );
}

/** An item that waits or is being worked on; the one in work is marked "Most". */
export function OpenQueueItem({ item }: { item: MemberQueueItem }) {
  const waiting = item.state === 'queued' && item.wait;
  return (
    <ItemRow item={item} at={item.queuedAt} current={item.state === 'processing'}>
      {waiting ? (
        <span className={styles.wait}>
          {tDynamic(`operator.queue.wait.${item.wait!.code}`, t('operator.queue.wait.generic'))}
        </span>
      ) : null}
    </ItemRow>
  );
}

/** What the Operator did with a closed item: done, handed to the owner, failed and handed over, or left out. */
function Outcome({ item }: { item: MemberQueueItem }) {
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
export function ClosedQueueItem({ item }: { item: MemberQueueItem }) {
  return (
    <ItemRow item={item} at={item.closedAt ?? item.queuedAt}>
      <Outcome item={item} />
    </ItemRow>
  );
}
