import { Link } from 'react-router';
import type { FeedbackCardRef, FeedbackMarkDetail, FeedbackThreadEntry } from '@projectman/shared';
import { formatAgo } from '../../i18n/format';
import { t } from '../../i18n/t';
import type { MemberIndex } from '../../lib/members';
import { MarkerAvatar } from './MarkerAvatar';
import styles from './MarkThread.module.css';

function cardText(projectKey: string, card: FeedbackCardRef | null) {
  if (!card) return null;
  return (
    <>
      <Link to={`/p/${projectKey}/tasks/${card.key}`} className={styles.cardKey}>
        {card.key}
      </Link>{' '}
      {card.title}
    </>
  );
}

function EventLine({ projectKey, entry }: { projectKey: string; entry: FeedbackThreadEntry }) {
  const who = entry.actor.name;
  let text;
  switch (entry.type) {
    case 'card_created':
      text = (
        <>
          {t('feedback.thread.cardCreated', { name: who })} {cardText(projectKey, entry.card)}
        </>
      );
      break;
    case 'card_linked':
      text = (
        <>
          {t('feedback.thread.cardLinked', { name: who })} {cardText(projectKey, entry.card)}
        </>
      );
      break;
    case 'forwarded':
      text = entry.body
        ? t('feedback.thread.forwardedWith', { name: who, reason: entry.body })
        : t('feedback.thread.forwarded', { name: who });
      break;
    case 'closed':
      text = t('feedback.thread.closed', { name: who });
      break;
    default:
      text = t('feedback.thread.reopened', { name: who });
  }
  return (
    <li className={styles.event}>
      <span>{text}</span>
      <span className={styles.time}>{formatAgo(entry.createdAt)}</span>
    </li>
  );
}

/** The conversation of one mark: comments in the messages' style, and the steps taken as thin lines between them. */
export function MarkThread({
  mark,
  projectKey,
  members,
  myHandle,
}: {
  mark: FeedbackMarkDetail;
  projectKey: string;
  members: MemberIndex;
  myHandle: string | null;
}) {
  const waiting = mark.working && mark.status === 'new';
  return (
    <ol className={styles.thread} aria-label={t('feedback.thread.label')}>
      {mark.thread.map((entry) =>
        entry.type === 'comment' ? (
          <li key={entry.id} className={styles.comment} data-own={entry.actor.handle === myHandle}>
            <MarkerAvatar person={entry.actor} member={members.get(entry.actor.handle)} size="md" />
            <div className={styles.bubble}>
              <p className={styles.head}>
                <span className={styles.name}>
                  {entry.actor.handle === myHandle ? t('common.you') : entry.actor.name}
                </span>
                <span className={styles.time}>{formatAgo(entry.createdAt)}</span>
              </p>
              <p className={styles.text}>{entry.body}</p>
            </div>
          </li>
        ) : (
          <EventLine key={entry.id} projectKey={projectKey} entry={entry} />
        ),
      )}
      {waiting ? (
        <li className={styles.working} role="status">
          {t('feedback.thread.working')}
        </li>
      ) : null}
    </ol>
  );
}
