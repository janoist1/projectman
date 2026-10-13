import clsx from 'clsx';
import { Link } from 'react-router';
import { routes } from '@projectman/shared';
import type { FeedbackMarkView } from '@projectman/shared';
import { formatAgo } from '../../i18n/format';
import { t } from '../../i18n/t';
import type { MemberIndex } from '../../lib/members';
import { sourceLabel } from './feedbackModel';
import { MarkerAvatar } from './MarkerAvatar';
import { MarkStatusChip } from './MarkStatusChip';
import styles from './MarkList.module.css';

export function MarkList({
  projectKey,
  marks,
  selectedId,
  search,
  canProcess,
  members,
  ownerName,
}: {
  projectKey: string;
  marks: readonly FeedbackMarkView[];
  selectedId: string | null;
  /** The filters in the address, kept when a row is picked. */
  search: string;
  canProcess: boolean;
  members: MemberIndex;
  ownerName: string;
}) {
  return (
    <ul className={styles.list} aria-label={t('feedback.list.label')}>
      {marks.map((mark) => {
        const selected = mark.id === selectedId;
        return (
          <li key={mark.id}>
            <Link
              to={{ pathname: `/p/${projectKey}/feedback/${mark.id}`, search }}
              className={clsx(styles.row, selected && styles.selected)}
              aria-current={selected ? 'true' : undefined}
            >
              <MarkerAvatar person={mark.author} member={members.get(mark.author.handle)} />
              <span className={styles.main}>
                <span className={styles.head}>
                  <span className={styles.name}>{mark.author.name}</span>
                  <span className={styles.dim}>
                    · {t(`feedback.kinds.${mark.kind}`)} · {formatAgo(mark.createdAt)}
                  </span>
                  {mark.unread ? (
                    <span className={styles.unread}>
                      <span className="visually-hidden">{t('feedback.list.unread')}</span>
                    </span>
                  ) : null}
                </span>
                <span className={styles.body}>{mark.body}</span>
                <span className={styles.meta}>
                  <MarkStatusChip mark={mark} ownerName={ownerName} />
                  {mark.card?.visible ? <span className={styles.cardKey}>{mark.card.key}</span> : null}
                  <span className={styles.source}>{sourceLabel(mark)}</span>
                </span>
              </span>
              {canProcess && mark.hasScreenshot ? (
                <img
                  className={styles.thumb}
                  src={`${routes.feedbackScreenshot(projectKey, mark.id)}?thumb=1`}
                  alt=""
                  loading="lazy"
                />
              ) : null}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
