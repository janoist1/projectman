import type { Task } from '@projectman/shared';
import { Link } from 'react-router';
import { Icon } from '../../components/Icon';
import { formatAgo } from '../../i18n/format';
import { t } from '../../i18n/t';
import { loopWho, pairText } from '../../lib/loop';
import { nameOf } from '../../lib/members';
import type { MemberIndex } from '../../lib/members';
import styles from './SignalBox.module.css';

/**
 * A loop on the card (PM-261) at the top of the drawer: who wrote to each other, how often, and who
 * has it. It is gone when the loop is over; the viewer who is asked to decide sees the decision instead.
 */
export function SignalBox({
  task,
  members,
  myHandle,
  messagesHref,
}: {
  task: Task;
  members: MemberIndex;
  myHandle: string | null;
  /** Where the conversation can be read; only for those who may. */
  messagesHref?: string | null;
}) {
  const loop = task.loop;
  if (!loop) return null;
  const who = loopWho(loop, members, myHandle);
  return (
    <section className={styles.box} aria-labelledby={`loop-${task.key}`}>
      <div className={styles.head}>
        <Icon name="loop" size={14} strokeWidth={2.4} />
        <h3 id={`loop-${task.key}`} className={styles.title}>
          {t('loop.box.title')}
        </h3>
        <time className={styles.age} dateTime={loop.startedAt}>
          {formatAgo(loop.startedAt)}
        </time>
      </div>
      <p className={styles.text}>
        {t('loop.box.text', { pair: pairText(loop.members, members, myHandle), count: loop.count })}
      </p>
      <p className={styles.text}>
        {loop.phase === 'let_run'
          ? t('loop.box.let_run', { name: nameOf(loop.letRunBy, members, myHandle) })
          : who}
      </p>
      {messagesHref ? (
        <Link to={messagesHref} className={styles.link}>
          {t('loop.box.messages')}
        </Link>
      ) : null}
    </section>
  );
}
