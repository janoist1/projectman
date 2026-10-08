import type { Session, Task } from '@projectman/shared';
import { Link } from 'react-router';
import { HandoffBox } from './HandoffBox';
import { Icon } from '../../components/Icon';
import { formatAgo } from '../../i18n/format';
import { t } from '../../i18n/t';
import { fixLimitWho, fixRoundParts } from '../../lib/fixLimit';
import { loopWho, pairText } from '../../lib/loop';
import { nameOf } from '../../lib/members';
import type { MemberIndex } from '../../lib/members';
import styles from './SignalBox.module.css';

interface SignalBoxProps {
  task: Task;
  members: MemberIndex;
  myHandle: string | null;
  /** Where the conversation can be read; only for those who may. */
  messagesHref?: string | null;
  /** The viewer has the decision of that signal in their inbox, so the box would say it twice. */
  decidingLoop?: boolean;
  decidingFixLimit?: boolean;
  /** The card's sessions: the handoff box links to the old assignee's. */
  sessions?: readonly Session[];
}

/**
 * What stops or watches the card, at the top of the drawer: a handoff of the assignee (PM-342, first),
 * a loop (PM-261: who wrote to each other, how often, and who has it) and a hold at the fix round limit
 * (PM-262: how many rounds, and who decides). Each is gone when it is over; the viewer who is asked to
 * decide sees the decision instead.
 */
export function SignalBox({
  task,
  members,
  myHandle,
  messagesHref,
  decidingLoop = false,
  decidingFixLimit = false,
  sessions,
}: SignalBoxProps) {
  const loop = decidingLoop ? undefined : task.loop;
  const fixLimit = decidingFixLimit ? undefined : task.fixLimit;
  if (!loop && !fixLimit && !task.handoff) return null;
  return (
    <>
      {task.handoff ? <HandoffBox task={task} members={members} sessions={sessions} /> : null}
      {fixLimit ? (
        <section className={styles.box} aria-labelledby={`fix-limit-${task.key}`}>
          <div className={styles.head}>
            <Icon name="undo" size={14} strokeWidth={2.4} />
            <h3 id={`fix-limit-${task.key}`} className={styles.title}>
              {t('fixLimit.box.title')}
            </h3>
            <span className={styles.age}>
              {t('fixLimit.box.count', { rounds: fixLimit.rounds, limit: fixLimit.limit })}
            </span>
          </div>
          <p className={styles.text}>{t('fixLimit.box.text', { parts: fixRoundParts(fixLimit) })}</p>
          <p className={styles.text}>{fixLimitWho(fixLimit, members, myHandle)}</p>
        </section>
      ) : null}
      {loop ? (
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
              : loopWho(loop, members, myHandle)}
          </p>
          {messagesHref ? (
            <Link to={messagesHref} className={styles.link}>
              {t('loop.box.messages')}
            </Link>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
