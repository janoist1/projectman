import clsx from 'clsx';
import { Link } from 'react-router';
import type { FeedbackMarkDetail } from '@projectman/shared';
import { Icon } from '../../components/Icon';
import { t } from '../../i18n/t';
import styles from './DecisionRow.module.css';

/** The reason the processor gave when it passed the mark to the owner (only a processor gets it). */
function forwardReason(mark: FeedbackMarkDetail): string | null {
  for (let at = mark.thread.length - 1; at >= 0; at -= 1) {
    const entry = mark.thread[at]!;
    if (entry.type === 'forwarded') return entry.body;
  }
  return null;
}

function CardLink({ projectKey, cardKey, title }: { projectKey: string; cardKey: string; title: string }) {
  return (
    <>
      <Link to={`/p/${projectKey}/tasks/${cardKey}`} className={styles.key}>
        {cardKey}
      </Link>{' '}
      {title}
    </>
  );
}

/** The line under the title that says where the mark stands: a card, or whose decision it waits for. */
export function DecisionRow({
  mark,
  projectKey,
  ownerName,
  isOwner,
}: {
  mark: FeedbackMarkDetail;
  projectKey: string;
  ownerName: string;
  isOwner: boolean;
}) {
  if (mark.status === 'waiting_owner') {
    const reason = forwardReason(mark);
    const text = isOwner
      ? reason
        ? t('feedback.decision.youDecideWith', { reason })
        : t('feedback.decision.youDecide')
      : mark.canProcess && reason
        ? t('feedback.decision.ownerDecidesWith', { owner: ownerName, reason })
        : t('feedback.decision.ownerDecides', { owner: ownerName });
    return (
      <p className={clsx(styles.row, styles.needs)}>
        <Icon name="exclamation" size={16} strokeWidth={2.2} />
        <span>{text}</span>
      </p>
    );
  }
  if (!mark.card || mark.outcome === 'answered' || mark.outcome === null) return null;
  const card = mark.card;
  const link = <CardLink projectKey={projectKey} cardKey={card.key} title={card.title} />;
  if (!mark.canProcess) {
    return (
      <p className={clsx(styles.row, styles.ok)}>
        <Icon name="check" size={16} strokeWidth={2.4} />
        <span>
          {t('feedback.decision.cardPrefix')} {link} · {card.stageName}
        </span>
      </p>
    );
  }
  return (
    <p className={clsx(styles.row, styles.ok)}>
      <Icon name="check" size={16} strokeWidth={2.4} />
      <span>
        {mark.outcome === 'card_created' ? t('feedback.decision.created') : t('feedback.decision.linked')}{' '}
        {link} · {card.stageName}
      </span>
    </p>
  );
}
