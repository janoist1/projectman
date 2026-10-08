import clsx from 'clsx';
import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router';
import { mentionTokens } from '@projectman/shared';
import { Chip } from './Chip';
import type { TimelineEvent } from '@projectman/shared';
import { formatStamp } from '../i18n/format';
import { t } from '../i18n/t';
import { actorLabel } from '../lib/members';
import { describeStart, describeStop } from '../lib/involvement';
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
  /** Where a row of a team message links to the whole message (null: the row has no link, the viewer may not read it). */
  fullMessageHref?: (event: TimelineEvent) => string | null;
  /** A row's own content in place of its text (null: the plain text), for rows that carry a link. */
  renderText?: (event: TimelineEvent) => ReactNode;
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
export function Timeline({
  events,
  ctx,
  next,
  fullMessageHref,
  renderText,
  emptyText,
  className,
}: TimelineProps) {
  const { hash } = useLocation();
  const reached = useRef('');
  useEffect(() => {
    if (!hash.startsWith('#timeline-') || reached.current === hash) return;
    const row = document.getElementById(hash.slice(1));
    if (!row) return;
    reached.current = hash;
    row.scrollIntoView({ block: 'center' });
    row.focus({ preventScroll: true });
    row.classList.add(styles.highlight!);
    const timer = setTimeout(() => row.classList.remove(styles.highlight!), 1800);
    return () => {
      clearTimeout(timer);
      row.classList.remove(styles.highlight!);
    };
  }, [hash, events]);
  if (events.length === 0 && !next) {
    return <p className={styles.empty}>{emptyText ?? t('task.timelineEmpty')}</p>;
  }
  return (
    <ol className={clsx(styles.list, className)}>
      {events
        .filter(
          (event) =>
            !(
              event.type === 'session_ended' &&
              (event.data.stop as { kind?: string } | undefined)?.kind === 'restart'
            ),
        )
        .map((event) => {
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
              : actorLabel(event.actor, ctx.members, ctx.myHandle);
          const handle = event.actor.handle;
          const member = handle ? ctx.members.get(handle) : undefined;
          const isMe = Boolean(handle && handle === ctx.myHandle && !event.actor.via);
          const involvement =
            event.type === 'session_started'
              ? describeStart(event, ctx)
              : event.type === 'session_ended'
                ? describeStop(event, ctx)
                : null;
          const ref = involvement?.ref;
          const target = ref?.eventId
            ? events.find((item) => item.id === ref.eventId)
            : ref?.messageId
              ? events.find((item) => item.data.messageId === ref.messageId)
              : undefined;
          const fullMessage = fullMessageHref?.(event);
          const referenceHref = target
            ? `#timeline-${target.id}`
            : ref?.inboxItemId
              ? `/p/${event.projectKey}/inbox`
              : ref?.runId
                ? `/p/${event.projectKey}/team/${event.data.member}`
                : ref?.messageId
                  ? `/p/${event.projectKey}/messages`
                  : null;
          return (
            <li key={event.id} id={`timeline-${event.id}`} tabIndex={-1} className={styles.item}>
              <span className={styles.rail}>
                {imported || event.actor.kind === 'system' || !handle ? (
                  <span className={styles.systemIcon} aria-hidden="true">
                    <Icon name="layers" size={15} strokeWidth={2} />
                  </span>
                ) : (
                  <Avatar member={member} handle={handle} isMe={isMe} via={event.actor.via} size="md" />
                )}
                <span className={styles.line} />
              </span>
              <div className={styles.body}>
                <span className={styles.meta}>
                  <span className={styles.actor}>{author}</span>
                  {event.actor.via ? <span> · {t('involvement.behalf')}</span> : null}
                  <span aria-hidden="true"> · </span>
                  <time dateTime={at}>{formatStamp(at)}</time>
                  {imported ? <span> · {t('task.comments.imported')}</span> : null}
                </span>
                <span
                  className={clsx(
                    styles.text,
                    comment && styles.comment,
                    emphasis === 'needs' && styles.needs,
                  )}
                >
                  {comment ? (
                    <CommentText text={text} ctx={ctx} />
                  ) : involvement && ref?.text ? (
                    <>
                      {involvement.verb}
                      {involvement.reason ? ` — ${involvement.reason}` : ''}
                      {ref.text ? ': ' : ''}
                      {referenceHref ? (
                        <Link
                          to={referenceHref}
                          aria-label={t('involvement.jump', { text: ref.text })}
                          onClick={(click) => {
                            if (!target) return;
                            click.preventDefault();
                            const row = document.getElementById(`timeline-${target.id}`);
                            row?.scrollIntoView({
                              behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
                                ? 'instant'
                                : 'smooth',
                              block: 'center',
                            });
                            row?.focus({ preventScroll: true });
                            row?.classList.add(styles.highlight!);
                            setTimeout(() => row?.classList.remove(styles.highlight!), 1800);
                          }}
                        >
                          {ref.text}
                        </Link>
                      ) : (
                        ref.text
                      )}
                      {involvement.by ? ` · ${involvement.by}` : ''}
                    </>
                  ) : (
                    (renderText?.(event) ?? text)
                  )}
                </span>
                {fullMessage ? (
                  <Link to={fullMessage} className={styles.fullMessage}>
                    {t('timeline.fullMessage')}
                  </Link>
                ) : null}
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
