import clsx from 'clsx';
import type { ReactNode } from 'react';
import { useContext, useEffect, useRef } from 'react';
import { ProjectContext } from '../app/contexts';
import { useConfig } from '../api/queries';
import { Link, useLocation } from 'react-router';
import { hasBoundOrigin, mentionTokens } from '@projectman/shared';
import { Chip } from './Chip';
import type { TimelineEvent } from '@projectman/shared';
import { formatStamp } from '../i18n/format';
import { t } from '../i18n/t';
import { actorLabel, isOwnActor } from '../lib/members';
import { describeStart, describeStop } from '../lib/involvement';
import { isListedEvent } from '../lib/cardStory';
import { describeEvent } from '../lib/timeline';
import type { TimelineContext } from '../lib/timeline';
import { Avatar } from './Avatar';
import { ActorName } from './ActorName';
import { SuperTimelineDetail } from './SuperTimelineDetail';
import { Icon } from './Icon';
import { Markdown } from './Markdown';
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

/**
 * Scrolls a row to the middle, focuses it and highlights it for a moment (without the animation when the
 * reader asks for less motion). Returns what undoes the highlight.
 */
export function revealRow(row: HTMLElement | null): (() => void) | undefined {
  if (!row) return undefined;
  row.scrollIntoView?.({
    behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
    block: 'center',
  });
  row.focus({ preventScroll: true });
  row.classList.add(styles.highlight!);
  const timer = setTimeout(() => row.classList.remove(styles.highlight!), 1800);
  return () => {
    clearTimeout(timer);
    row.classList.remove(styles.highlight!);
  };
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
    return revealRow(row);
  }, [hash, events]);
  if (events.length === 0 && !next) {
    return <p className={styles.empty}>{emptyText ?? t('task.timelineEmpty')}</p>;
  }
  return (
    <ol className={clsx(styles.list, className)}>
      {events.filter(isListedEvent).map((event) => (
        <TimelineRow
          key={event.id}
          event={event}
          events={events}
          ctx={ctx}
          fullMessageHref={fullMessageHref}
          renderText={renderText}
        />
      ))}
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

/** One event as a row of the history: its author, time, text and the links and details that belong to it. */
export function TimelineRow({
  event,
  events,
  ctx,
  fullMessageHref,
  renderText,
  badge,
  onJump,
  className,
}: {
  event: TimelineEvent;
  /** The events a row's link may point at. */
  events: readonly TimelineEvent[];
  ctx: TimelineContext;
  fullMessageHref?: TimelineProps['fullMessageHref'];
  renderText?: TimelineProps['renderText'];
  /** Shown after the text: a mark of what the event came to. */
  badge?: ReactNode;
  /** Opens the row of an event this row's link points at (default: the row is on the page, scroll to it). */
  onJump?: (id: string) => void;
  className?: string;
}) {
  const project = useContext(ProjectContext);
  const config = useConfig(
    event.projectKey,
    project?.can.readConfig === true && !ctx.config && typeof event.data.ownerTopic === 'string',
  );
  const { text, emphasis, detail, resolution, note, link } = describeEvent(event, {
    ...ctx,
    config: ctx.config ?? config.data?.config,
  });
  const comment = event.type === 'task_note';
  const imported =
    comment && (typeof event.data.importedAuthor === 'string' || typeof event.data.importedAt === 'string');
  const at = imported && typeof event.data.importedAt === 'string' ? event.data.importedAt : event.createdAt;
  const author =
    imported && typeof event.data.importedAuthor === 'string'
      ? event.data.importedAuthor
      : actorLabel(event.actor, ctx.members, ctx.myHandle);
  const handle = event.actor.handle;
  const member = handle ? ctx.members.get(handle) : undefined;
  const isMe = isOwnActor(event.actor, ctx.myHandle);
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
    <li id={`timeline-${event.id}`} tabIndex={-1} className={clsx(styles.item, className)}>
      <span className={styles.rail}>
        {imported || event.actor.kind === 'system' || !handle ? (
          <span className={styles.systemIcon} aria-hidden="true">
            <Icon
              name={event.type === 'question_recipient_escalated' ? 'handoff' : 'layers'}
              size={15}
              strokeWidth={2}
            />
          </span>
        ) : (
          <Avatar
            actor={event.actor}
            member={member}
            handle={handle}
            isMe={isMe}
            via={event.actor.via}
            size="md"
          />
        )}
        <span className={styles.line} />
      </span>
      <div className={styles.body}>
        <span className={styles.meta}>
          <span className={styles.actor}>
            {imported ? (
              author
            ) : (
              <ActorName
                actor={event.actor}
                members={ctx.members}
                myHandle={ctx.myHandle}
                projectKey={event.projectKey}
                after={
                  <span className={styles.timestamp}>
                    <span aria-hidden="true"> · </span>
                    <time dateTime={at}>{formatStamp(at)}</time>
                  </span>
                }
              />
            )}
          </span>
          {imported ? (
            <>
              <span aria-hidden="true"> · </span>
              <time dateTime={at}>{formatStamp(at)}</time>
              <span> · {t('task.comments.imported')}</span>
            </>
          ) : null}
        </span>
        <span className={clsx(styles.text, comment && styles.comment, emphasis === 'needs' && styles.needs)}>
          {event.type === 'super_handoff_changed' || event.type === 'super_operation_changed' ? (
            <SuperTimelineDetail event={event} events={events} fallback={text} />
          ) : comment ? (
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
                    if (onJump) onJump(target.id);
                    else revealRow(document.getElementById(`timeline-${target.id}`));
                  }}
                >
                  {ref.text}
                </Link>
              ) : (
                ref.text
              )}
              {hasBoundOrigin(involvement.byActor) ? (
                <>
                  {' '}
                  ·{' '}
                  <ActorName
                    actor={involvement.byActor}
                    members={ctx.members}
                    myHandle={ctx.myHandle}
                    projectKey={event.projectKey}
                  />
                </>
              ) : involvement.by ? (
                ` · ${involvement.by}`
              ) : (
                ''
              )}
            </>
          ) : (
            (renderText?.(event) ?? text)
          )}
          {event.type === 'feedback_linked' && typeof event.data.markId === 'string' ? (
            <>
              <span aria-hidden="true"> · </span>
              <Link to={`/p/${event.projectKey}/feedback/${event.data.markId}`}>
                {t('timeline.openMark')}
              </Link>
            </>
          ) : null}
          {link ? (
            <>
              <span aria-hidden="true"> · </span>
              <a
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.external}
                aria-label={`${link.label} ${t('inbox.release.newTab')}`}
              >
                {link.label} <span aria-hidden="true">↗</span>
              </a>
            </>
          ) : null}
          {badge}
        </span>
        {note ? <p className={styles.note}>{note}</p> : null}
        {fullMessage ? (
          <Link to={fullMessage} className={styles.fullMessage}>
            {t('timeline.fullMessage')}
          </Link>
        ) : null}
        {resolution ? (
          <details className={styles.detail}>
            <summary>{t('timeline.events.merged_resolution')}</summary>
            <Markdown text={resolution} />
          </details>
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
}
