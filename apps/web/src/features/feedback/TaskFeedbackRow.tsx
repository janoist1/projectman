import clsx from 'clsx';
import { Link } from 'react-router';
import { useFeedbackOfTask } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { t } from '../../i18n/t';
import drawer from '../board/drawer.module.css';
import { titleFromBody } from './feedbackModel';
import styles from './TaskFeedbackRow.module.css';

/**
 * "Jelölésekből": the feedback marks that led to the card, with a link to each in the Jelölések page. The
 * server returns only what the viewer may see (a client sees only the marks they or their colleagues made),
 * so the row is absent when there is nothing to show.
 */
export function TaskFeedbackRow({ taskKey }: { taskKey: string }) {
  const { key } = useProject();
  const marks = useFeedbackOfTask(key, taskKey);
  const list = marks.data?.marks ?? [];
  if (list.length === 0) return null;
  return (
    <section className={drawer.prop} aria-label={t('task.feedback.title')}>
      <h3 className={drawer.propLabel}>{t('task.feedback.title')}</h3>
      <span>{t('task.feedback.count', { count: list.length })}</span>
      <span />
      <ul className={clsx(styles.list, drawer.propWide)}>
        {list.map((mark) => (
          <li key={mark.id}>
            <Link className={styles.link} to={`/p/${key}/feedback/${mark.id}`}>
              <span className={styles.text}>{titleFromBody(mark.body) || mark.pageTitle}</span>
              <span className={styles.who}>{mark.author.name}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
