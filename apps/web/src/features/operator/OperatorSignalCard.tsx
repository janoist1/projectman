import { useId } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { OperatorSignal, TeamMessage } from '@projectman/shared';
import { isApiError } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import { useDismissOperatorSignal, useSendTeamMessage } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { Markdown } from '../../components/Markdown';
import { formatTime } from '../../i18n/format';
import { t } from '../../i18n/t';
import styles from './OperatorSignalCard.module.css';

/** The heading of a signal: its kind, with the card's key as a link where the kind names one. */
function SignalTitle({ signal, projectKey }: { signal: OperatorSignal; projectKey: string }) {
  const marker = '\u0000';
  const text = t(`operator.signal.kinds.${signal.kind}`, { key: marker });
  const [before = '', after = ''] = text.split(marker);
  if (!text.includes(marker) || !signal.taskKey) return <>{text.replace(marker, signal.taskKey ?? '')}</>;
  return (
    <>
      {before}
      <Link to={`/p/${projectKey}/tasks/${signal.taskKey}`} className={styles.key}>
        {signal.taskKey}
      </Link>
      {after}
    </>
  );
}

/** What happened to a signal that is no longer open, with the time. */
function closedText(signal: OperatorSignal): string | null {
  switch (signal.state) {
    case 'accepted':
      return signal.decidedAt
        ? `${t('operator.signal.accepted')} · ${formatTime(signal.decidedAt)}`
        : t('operator.signal.accepted');
    case 'dismissed':
      return signal.decidedAt
        ? `${t('operator.signal.dismissed')} · ${formatTime(signal.decidedAt)}`
        : t('operator.signal.dismissed');
    case 'resolved':
      return signal.resolvedAt
        ? `${t('operator.signal.resolved')} · ${formatTime(signal.resolvedAt)}`
        : t('operator.signal.resolved');
    default:
      return null;
  }
}

/**
 * A signal the Operator raised on its own (PM-447): an outage, a card nobody can carry, a session waiting for
 * input or one that went silent. "Igen, intézd" is a message to the Operator that names the signal; "Most ne" only
 * sets the signal aside.
 */
export function OperatorSignalCard({
  signal,
  message,
  operatorHandle,
  readOnly,
}: {
  signal: OperatorSignal;
  /** The Operator's message that presented the signal, if the thread holds it. */
  message: TeamMessage | null;
  operatorHandle: string;
  readOnly: boolean;
}) {
  const { key } = useProject();
  const client = useQueryClient();
  const send = useSendTeamMessage(key);
  const dismiss = useDismissOperatorSignal(key);
  const titleId = useId();
  const open = signal.state === 'open';
  const busy = send.isPending || dismiss.isPending;
  const failure = send.error ?? dismiss.error;
  const closedByServer = isApiError(failure) && failure.code === 'operator_signal_closed';
  const closed = closedText(signal);

  const accept = () =>
    send.mutate(
      {
        to: [operatorHandle],
        text: t('operator.signal.acceptMessage'),
        operatorSignal: signal.id,
        ...(signal.taskKey ? { taskKey: signal.taskKey } : {}),
      },
      { onSettled: () => void client.invalidateQueries({ queryKey: queryKeys.operator(key) }) },
    );

  return (
    <article
      className={styles.card}
      aria-labelledby={titleId}
      data-signal={signal.kind}
      data-state={signal.state}
    >
      <div className={styles.head}>
        <Icon name="bell" size={14} strokeWidth={2.2} />
        <span className={styles.raised}>
          {message
            ? t('operator.signal.raised', { time: formatTime(message.createdAt) })
            : t('operator.signal.noMessage', { time: formatTime(signal.raisedAt) })}
        </span>
      </div>
      <h3 id={titleId} className={styles.title}>
        <SignalTitle signal={signal} projectKey={key} />
      </h3>
      <div className={styles.body}>
        {message ? <Markdown text={message.body} /> : <p>{t(`operator.signal.bodies.${signal.kind}`)}</p>}
      </div>
      {signal.kind === 'outage' && signal.inboxItemId ? (
        <Link to={`/p/${key}/inbox`} className={styles.details}>
          {t('operator.signal.details')} →
        </Link>
      ) : null}
      {open && !readOnly ? (
        <div className={styles.actions}>
          {signal.actionable ? (
            <Button variant="primary" size="md" disabled={busy} onClick={accept}>
              {t('operator.signal.accept')}
            </Button>
          ) : null}
          <Button variant="secondary" size="md" disabled={busy} onClick={() => dismiss.mutate(signal.id)}>
            {t('operator.signal.dismiss')}
          </Button>
        </div>
      ) : null}
      {!open && closed ? <p className={styles.closed}>{closed}</p> : null}
      {failure ? (
        <p className={styles.error} role="alert">
          {closedByServer ? t('operator.signal.closed') : t('operator.signal.failed')}
        </p>
      ) : null}
    </article>
  );
}
