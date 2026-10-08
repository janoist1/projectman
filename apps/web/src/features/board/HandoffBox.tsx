import type { Session, Task } from '@projectman/shared';
import clsx from 'clsx';
import { Link } from 'react-router';
import { useUpdateTask } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Chip } from '../../components/Chip';
import { Icon } from '../../components/Icon';
import { formatDuration } from '../../i18n/format';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import {
  fallbackReasonText,
  handoffEndName,
  handoffLine,
  handoffMsLeft,
  handoffPair,
  providerShift,
} from '../../lib/handoff';
import { nameOf } from '../../lib/members';
import type { MemberIndex } from '../../lib/members';
import { isLiveSession } from '../../lib/sessions';
import { useNow } from '../../lib/useNow';
import styles from './SignalBox.module.css';

/** The old assignee's session on the card: the live one, else the latest. */
function handoffSession(sessions: readonly Session[], from: string): Session | undefined {
  const own = sessions.filter((session) => session.member === from);
  return (
    own.find((session) => isLiveSession(session)) ??
    [...own].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]
  );
}

/**
 * The open handoff of the card at the top of the drawer (PM-342): who hands the work to whom, what
 * step it is in and how long is left, with a way back to the old assignee. The countdown is plain
 * text renewed every minute, not a live region; only the step line is announced.
 */
export function HandoffBox({
  task,
  members,
  sessions = [],
}: {
  task: Task;
  members: MemberIndex;
  sessions?: readonly Session[];
}) {
  const { key, can, myHandle } = useProject();
  const undo = useUpdateTask(key);
  const handoff = task.handoff;
  const now = useNow(Boolean(handoff), 60_000);
  if (!handoff) return null;
  const id = `handoff-${task.key}`;
  const paused = handoff.step === 'paused';
  const left = handoffMsLeft(handoff, now);
  const from = nameOf(handoff.from, members, myHandle);
  const to = handoffEndName(handoff.to, members, myHandle);
  const nobody = handoff.to === null;
  const line = handoffLine(handoff, now);
  const shift = providerShift(handoff.fromProvider, handoff.toProvider);
  const session = handoffSession(sessions, handoff.from);
  const stepText = (() => {
    switch (line) {
      case 'waiting_point':
        return t('handoff.box.step.waiting_point', { from });
      case 'writing':
        return t('handoff.box.step.writing', { from });
      case 'closing_timeout':
        return t(nobody ? 'handoff.box.step.closing_timeout_nobody' : 'handoff.box.step.closing_timeout', {
          to,
        });
      case 'closing_reason': {
        const reason = fallbackReasonText(handoff.fallbackReason, handoff.from, members, myHandle);
        return nobody
          ? t('handoff.box.step.closing_reason_nobody', { reason })
          : t('handoff.box.step.closing_reason', { to, reason });
      }
      default:
        return t(nobody ? 'handoff.box.step.closing_note_nobody' : 'handoff.box.step.closing_note', { to });
    }
  })();
  const timeTitle = nobody ? t('handoff.box.leftTitleNobody') : t('handoff.box.leftTitle', { to });
  return (
    <section className={clsx(styles.box, styles.accent, paused && styles.paused)} aria-labelledby={id}>
      <div className={styles.head}>
        <Icon name={paused ? 'pause' : 'handoff'} size={14} strokeWidth={2.4} />
        <h3 id={id} className={styles.title}>
          {t(paused ? 'handoff.box.pausedTitle' : 'handoff.box.title')}
        </h3>
        {paused ? (
          <span className={styles.age}>{t('handoff.box.pausedLeft')}</span>
        ) : left !== null && left > 0 ? (
          <span className={styles.age} title={timeTitle}>
            {t('handoff.box.left', { time: formatDuration(left) })}
          </span>
        ) : null}
      </div>
      <p className={styles.pair}>{handoffPair(handoff, members, myHandle)}</p>
      {paused ? (
        <p className={styles.text}>{t('handoff.box.pausedText')}</p>
      ) : (
        <p className={styles.text} aria-live="polite">
          {stepText}
        </p>
      )}
      {shift ? (
        <p className={styles.text}>
          <Chip tone="outline">{shift}</Chip> {t('handoff.box.providerSentence')}
        </p>
      ) : null}
      <div className={styles.links}>
        {session ? (
          <Link to={`/p/${key}/sessions/${session.id}`} className={styles.link}>
            {t('handoff.box.session')}
          </Link>
        ) : null}
        {can.manageTeam ? (
          <button
            type="button"
            className={styles.linkButton}
            title={t('handoff.box.undoTitle', { from })}
            disabled={undo.isPending}
            onClick={() => undo.mutate({ taskKey: task.key, body: { assignee: handoff.from } })}
          >
            {t('handoff.box.undo')}
          </button>
        ) : null}
      </div>
      {undo.isError ? (
        <p role="alert" className={styles.error}>
          {errorMessage(undo.error)}
        </p>
      ) : null}
    </section>
  );
}
