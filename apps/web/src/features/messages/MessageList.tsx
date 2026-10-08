import clsx from 'clsx';
import { Fragment } from 'react';
import { Link } from 'react-router';
import type { MessageReceipt, TeamMessage } from '@projectman/shared';
import { Button } from '../../components/Button';
import { Avatar } from '../../components/Avatar';
import { Icon } from '../../components/Icon';
import { formatDayHeading, formatStamp } from '../../i18n/format';
import { joinNames, t } from '../../i18n/t';
import { nameOf, namesOf } from '../../lib/members';
import type { MemberIndex } from '../../lib/members';
import styles from './MessageList.module.css';

interface MessageListProps {
  messages: readonly TeamMessage[];
  members: MemberIndex;
  myHandle: string | null;
  projectKey: string;
  taskTitles: ReadonlyMap<string, string>;
  /** Group by day with headings (full page). */
  groupByDay?: boolean;
  compact?: boolean;
  onReply?: (message: TeamMessage) => void;
  onRead?: (id: string) => void;
  readPending?: boolean;
}

function dayKey(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** Newest-first list of team messages: sender → recipients, the task, the text. */
export function MessageList({
  messages,
  members,
  myHandle,
  projectKey,
  taskTitles,
  groupByDay = false,
  compact = false,
  onReply,
  onRead,
  readPending,
}: MessageListProps) {
  const sorted = [...messages].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  let lastDay = '';
  return (
    <ol className={clsx(styles.list, compact && styles.compact)}>
      {sorted.map((message) => {
        const day = dayKey(message.createdAt);
        const heading = groupByDay && day !== lastDay ? formatDayHeading(message.createdAt) : null;
        lastDay = day;
        const from = message.via ? t('involvement.integratorFull') : nameOf(message.from, members, myHandle);
        const to = joinNames(namesOf(message.to, members, myHandle));
        const toMe = myHandle !== null && message.to.includes(myHandle);
        return (
          <Fragment key={message.id}>
            {heading ? (
              <li className={styles.day} aria-hidden="true">
                {heading}
              </li>
            ) : null}
            <li className={clsx(styles.item, toMe && styles.toMe)}>
              <div className={styles.head}>
                <Avatar
                  member={members.get(message.from)}
                  handle={message.from}
                  isMe={message.from === myHandle && !message.via}
                  via={message.via}
                  size="sm"
                />
                <Icon name="arrowRight" size={13} strokeWidth={2} className={styles.arrow} />
                <span className={styles.recipients} aria-hidden="true">
                  {message.to.slice(0, 3).map((handle) => (
                    <Avatar
                      key={handle}
                      member={members.get(handle)}
                      handle={handle}
                      isMe={handle === myHandle}
                      size="xs"
                      variant="initials"
                      ring
                    />
                  ))}
                </span>
                <span className={styles.names}>{t('messages.fromTo', { from, to })}</span>
                <time className={styles.time} dateTime={message.createdAt}>
                  {formatStamp(message.createdAt)}
                </time>
              </div>
              <p className={styles.body}>{message.body}</p>
              <div className={styles.foot}>
                {message.taskKey ? (
                  <Link to={`/p/${projectKey}/tasks/${message.taskKey}`} className={styles.task}>
                    <span className={styles.taskKey}>{message.taskKey}</span>
                    <span className={styles.taskTitle}>{taskTitles.get(message.taskKey) ?? ''}</span>
                  </Link>
                ) : null}
                {(
                  message.receipts ??
                  message.to.map((handle): MessageReceipt => ({
                    handle,
                    kind: members.get(handle)?.kind ?? 'human',
                    deliveredAt: message.deliveredAt,
                    readAt: null,
                  }))
                ).map((receipt) => (
                  <span key={receipt.handle} className={styles.pending}>
                    {nameOf(receipt.handle, members, myHandle)} ·{' '}
                    {receipt.kind === 'ai'
                      ? receipt.deliveredAt
                        ? t('messages.typed')
                        : t('messages.queued')
                      : receipt.readAt
                        ? t('messages.humanRead')
                        : t('messages.humanUnread')}
                    {receipt.route?.type === 'general' ? ` · ${t('messages.routeGeneral')}` : null}
                    {receipt.route?.type === 'task'
                      ? ` · ${t('messages.routeTask', { taskKey: receipt.route.taskKey })}`
                      : null}
                  </span>
                ))}
                {onReply ? (
                  <Button size="sm" variant="ghost" onClick={() => onReply(message)}>
                    {t('messages.reply')}
                  </Button>
                ) : null}
                {onRead && toMe && !message.receipts?.find((r) => r.handle === myHandle)?.readAt ? (
                  <Button size="sm" variant="ghost" disabled={readPending} onClick={() => onRead(message.id)}>
                    {t('messages.read')}
                  </Button>
                ) : null}
              </div>
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}
