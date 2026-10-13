import { useId, useLayoutEffect, useRef } from 'react';
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
import { closedText, SignalTitle } from './OperatorSignalCard';
import styles from './OperatorSignalCard.module.css';

/** One summary message, with independent decisions that stay in their original order. */
export function OperatorSignalList({
  signals,
  message,
  operatorHandle,
  readOnly,
}: {
  signals: OperatorSignal[];
  message: TeamMessage;
  operatorHandle: string;
  readOnly: boolean;
}) {
  const titleId = useId();
  const card = useRef<HTMLElement>(null);
  const group = useRef<HTMLHeadingElement>(null);
  const pendingFocus = useRef<string | null>(null);
  const ordered = [...signals].sort(
    (a, b) => Number(b.actionable) - Number(a.actionable) || a.raisedAt.localeCompare(b.raisedAt),
  );
  const count = signals.filter((signal) => signal.state === 'open').length;
  useLayoutEffect(() => {
    const id = pendingFocus.current;
    if (!id || signals.find((signal) => signal.id === id)?.state === 'open') return;
    pendingFocus.current = null;
    const rows = [...(card.current?.querySelectorAll<HTMLElement>('li[data-signal-id]') ?? [])];
    const index = rows.findIndex((row) => row.dataset.signalId === id);
    const next = [...rows.slice(index + 1), ...rows.slice(0, index)].find(
      (row) => row.dataset.state === 'open' && row.querySelector('button:not(:disabled)'),
    );
    (next?.querySelector<HTMLElement>('button:not(:disabled)') ?? group.current)?.focus();
  }, [signals]);
  return (
    <article
      ref={card}
      className={styles.card}
      data-state={count ? 'open' : 'resolved'}
      data-signal-list
      aria-labelledby={titleId}
    >
      <div className={styles.head}>
        <Icon name="bell" size={14} strokeWidth={2.2} />
        <span>{t('operator.signal.raised', { time: formatTime(message.createdAt) })}</span>
      </div>
      <div className={styles.body}>
        <Markdown text={message.body} />
      </div>
      <h3 ref={group} id={titleId} tabIndex={-1} className={styles.group}>
        {t('operator.signal.group')}
        {count ? <span className={styles.count}>· {t('operator.signal.groupCount', { count })}</span> : null}
      </h3>
      <ul className={styles.rows}>
        {ordered.map((signal) => (
          <SignalRow
            key={signal.id}
            signal={signal}
            operatorHandle={operatorHandle}
            readOnly={readOnly}
            onDecide={() => {
              pendingFocus.current = signal.id;
            }}
          />
        ))}
      </ul>
    </article>
  );
}

function SignalRow({
  signal,
  operatorHandle,
  readOnly,
  onDecide,
}: {
  signal: OperatorSignal;
  operatorHandle: string;
  readOnly: boolean;
  onDecide: () => void;
}) {
  const { key } = useProject();
  const titleId = useId();
  const client = useQueryClient();
  const send = useSendTeamMessage(key);
  const dismiss = useDismissOperatorSignal(key);
  const busy = send.isPending || dismiss.isPending;
  const failure = send.error ?? dismiss.error;
  const closed = closedText(signal);
  const accept = () => {
    onDecide();
    dismiss.reset();
    send.mutate(
      {
        to: [operatorHandle],
        text: t('operator.signal.acceptMessage'),
        operatorSignal: signal.id,
        ...(signal.taskKey ? { taskKey: signal.taskKey } : {}),
      },
      {
        onSettled: () => void client.invalidateQueries({ queryKey: queryKeys.operator(key) }),
      },
    );
  };
  return (
    <li className={styles.row} data-signal-id={signal.id} data-state={signal.state}>
      <h4 id={titleId} className={styles.rowTitle}>
        <SignalTitle signal={signal} projectKey={key} />
      </h4>
      {signal.kind === 'outage' && signal.inboxItemId ? (
        <Link to={`/p/${key}/inbox`} className={styles.details}>
          {t('operator.signal.details')} →
        </Link>
      ) : null}
      {signal.state === 'open' && signal.actionable && !readOnly ? (
        <div className={styles.rowActions}>
          <Button
            aria-describedby={titleId}
            variant="primary"
            size="md"
            loading={send.isPending}
            disabled={busy}
            onClick={accept}
          >
            {t('operator.signal.accept')}
          </Button>
          <Button
            aria-describedby={titleId}
            variant="secondary"
            size="md"
            loading={dismiss.isPending}
            disabled={busy}
            onClick={() => {
              onDecide();
              send.reset();
              dismiss.mutate(signal.id);
            }}
          >
            {t('operator.signal.dismiss')}
          </Button>
        </div>
      ) : null}
      {closed ? (
        <p className={styles.rowClosed} role="status">
          {signal.state === 'resolved' ? <Icon name="check" size={14} strokeWidth={2.6} /> : null}
          {closed}
        </p>
      ) : null}
      {failure ? (
        <p className={styles.error} role="alert">
          {isApiError(failure) && failure.code === 'operator_signal_closed'
            ? t('operator.signal.closed')
            : t('operator.signal.failed')}
        </p>
      ) : null}
    </li>
  );
}
