import clsx from 'clsx';
import type { ReactNode } from 'react';
import { mentionTokens } from '@projectman/shared';
import { Chip } from './Chip';
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
  /** Next-step row: what happens next and who carries it. */
  next?: ReactNode;
  emptyText?: string;
  className?: string;
}

function CommentText({ text, ctx }: { text: string; ctx: TimelineContext }) {
  let end = 0;
  const parts = mentionTokens(text).flatMap((token) => {
    const member = [...ctx.members.values()].find((member) => member.handle.toLowerCase() === token.handle);
    if (!member) return [];
    const before = text.slice(end, token.start);
    end = token.end;
    return [
      before,
      <Chip key={token.start} tone="accent">
        {member.displayName}
      </Chip>,
    ];
  });
  return (
    <>
      {parts}
      {text.slice(end)}
    </>
  );
}

/** Attributed history: who did what, when. Oldest first, like a log. */
export function Timeline({ events, ctx, next, emptyText, className }: TimelineProps) {
  if (events.length === 0 && !next) {
    return <p className={styles.empty}>{emptyText ?? t('task.timelineEmpty')}</p>;
  }
  return (
    <ol className={clsx(styles.list, className)}>
      {events.map((event) => {
        const { text, emphasis, detail } = describeEvent(event, ctx);
        const comment = event.type === 'task_note';
        const imported =
          comment &&
          (typeof event.data.importedAuthor === 'string' || typeof event.data.importedAt === 'string');
        const at =
          imported && typeof event.data.importedAt === 'string' ? event.data.importedAt : event.createdAt;
        const author =
          imported && typeof event.data.importedAuthor === 'string'
            ? event.data.importedAuthor
            : nameOf(event.actor.handle, ctx.members, ctx.myHandle);
        const handle = event.actor.handle;
        const member = handle ? ctx.members.get(handle) : undefined;
        const isMe = Boolean(handle && handle === ctx.myHandle);
        return (
          <li key={event.id} className={styles.item}>
            <span className={styles.rail}>
              {imported || event.actor.kind === 'system' || !handle ? (
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
                <span className={styles.actor}>{author}</span>
                <span aria-hidden="true"> · </span>
                <time dateTime={at}>{formatStamp(at)}</time>
                {imported ? <span> · {t('task.comments.imported')}</span> : null}
              </span>
              <span
                className={clsx(styles.text, comment && styles.comment, emphasis === 'needs' && styles.needs)}
              >
                {comment ? <CommentText text={text} ctx={ctx} /> : text}
              </span>
              {detail ? (
                <details className={styles.detail}>
                  <summary>{t('timeline.details')}</summary>
                  {detail}
                </details>
              ) : null}
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
