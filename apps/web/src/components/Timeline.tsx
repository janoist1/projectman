import clsx from 'clsx';
import type { TimelineEvent } from '@projectman/shared';
import { formatStamp } from '../i18n/format';
import { t } from '../i18n/t';
import { nameOf } from '../lib/members';
import { describeEvent } from '../lib/timeline';
import type { TimelineContext } from '../lib/timeline';
import { Avatar } from './Avatar';
import { Icon } from './Icon';
import styles from './Timeline.module.css';

interface TimelineProps {
  events: readonly TimelineEvent[];
  ctx: TimelineContext;
  /** "Következik" row: what happens next and who carries it. */
  next?: string | null;
  emptyText?: string;
  className?: string;
}

/** Attributed history: who did what, when. Oldest first, like a log. */
export function Timeline({ events, ctx, next, emptyText, className }: TimelineProps) {
  if (events.length === 0 && !next) {
    return <p className={styles.empty}>{emptyText ?? t('task.timelineEmpty')}</p>;
  }
  return (
    <ol className={clsx(styles.list, className)}>
      {events.map((event) => {
        const { text, emphasis } = describeEvent(event, ctx);
        const handle = event.actor.handle;
        const member = handle ? ctx.members.get(handle) : undefined;
        const isMe = Boolean(handle && handle === ctx.myHandle);
        return (
          <li key={event.id} className={styles.item}>
            <span className={styles.rail}>
              {event.actor.kind === 'system' || !handle ? (
                <span className={styles.systemIcon} aria-hidden="true">
                  <Icon name="layers" size={15} strokeWidth={2} />
                </span>
              ) : (
                <Avatar member={member} handle={handle} isMe={isMe} size="md" />
              )}
              <span className={styles.line} />
            </span>
            <div className={styles.body}>
              <span className={styles.meta}>
                <span className={styles.actor}>{nameOf(handle, ctx.members, ctx.myHandle)}</span>
                <span aria-hidden="true"> · </span>
                <time dateTime={event.createdAt}>{formatStamp(event.createdAt)}</time>
              </span>
              <span className={clsx(styles.text, emphasis === 'needs' && styles.needs)}>{text}</span>
            </div>
          </li>
        );
      })}
      {next ? (
        <li className={clsx(styles.item, styles.next)}>
          <span className={styles.rail}>
            <span className={styles.nextIcon} aria-hidden="true">
              <Icon name="arrowRight" size={15} strokeWidth={2} />
            </span>
          </span>
          <div className={styles.body}>
            <span className={styles.meta}>
              <span className={styles.actor}>{t('task.next')}</span>
            </span>
            <span className={clsx(styles.text, styles.muted)}>{next}</span>
          </div>
        </li>
      ) : null}
    </ol>
  );
}
