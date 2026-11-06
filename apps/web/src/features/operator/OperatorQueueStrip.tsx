import clsx from 'clsx';
import { useId } from 'react';
import type { ProjectManagerCorner } from '@projectman/shared';
import { Icon } from '../../components/Icon';
import { t } from '../../i18n/t';
import { operatorStripOf } from './operatorChannel';
import styles from './OperatorQueueStrip.module.css';

/** The strip under the panel's head: what the project manager does now and how many wait; it opens the queue view. */
export function OperatorQueueStrip({
  channel,
  onOpen,
}: {
  channel: ProjectManagerCorner | undefined;
  onOpen: () => void;
}) {
  const hintId = useId();
  const strip = operatorStripOf(channel);
  if (!strip) return null;
  const text =
    strip.kind === 'now'
      ? t('operator.queue.strip.now', { title: strip.title })
      : strip.kind === 'starting'
        ? t('operator.queue.strip.starting')
        : t('operator.queue.strip.waiting', { status: strip.status, count: strip.open });
  return (
    <>
      <button
        type="button"
        className={styles.strip}
        aria-describedby={hintId}
        data-testid="operator-queue-strip"
        onClick={onOpen}
      >
        <span
          className={clsx(styles.stripDot, strip.kind === 'now' && styles.stripDotLive)}
          aria-hidden="true"
        />
        <span className={styles.stripText}>{text}</span>
        {strip.kind === 'now' && strip.more > 0 ? (
          <span className={styles.stripMore}>{t('operator.queue.strip.more', { count: strip.more })}</span>
        ) : null}
        <Icon name="chevronRight" size={14} />
      </button>
      {/* The purpose of the button: a description, outside the button so it is not part of its name. */}
      <span id={hintId} className={styles.hidden}>
        {t('operator.queue.strip.label')}
      </span>
    </>
  );
}
