import { Link } from 'react-router';
import styles from './TaskChip.module.css';

/** The task a message is about: its key and title, a link to the card. */
export function TaskChip({
  projectKey,
  taskKey,
  title,
}: {
  projectKey: string;
  taskKey: string;
  title: string | undefined;
}) {
  return (
    <Link to={`/p/${projectKey}/tasks/${taskKey}`} className={styles.chip} title={title}>
      <span className={styles.key}>{taskKey}</span>
      {title ? <span className={styles.title}>{title}</span> : null}
    </Link>
  );
}
