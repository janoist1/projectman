import { useId, useLayoutEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { OperatorSignal } from '@projectman/shared';
import { api } from '../../api/endpoints';
import { isApiError } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { formatTime } from '../../i18n/format';
import { t } from '../../i18n/t';
import { SignalRow } from './OperatorSignalList';
import styles from './OperatorSignalCard.module.css';

/** Consecutive signals without a presenting message, with decisions scoped to this group. */
export function OperatorSignalGroup({
  signals,
  operatorHandle,
  readOnly,
  onDismiss,
}: {
  signals: OperatorSignal[];
  operatorHandle: string;
  readOnly: boolean;
  onDismiss: (id: string) => void;
}) {
  const { key, myHandle } = useProject();
  const client = useQueryClient();
  const titleId = useId();
  const contentId = useId();
  const section = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const bulkButton = useRef<HTMLButtonElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const retryButton = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<string | null>(null);
  const focus = useRef<'toggle' | 'bulk' | 'confirm' | 'retry' | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failures, setFailures] = useState<string[]>([]);
  const [dismissed, setDismissed] = useState<Record<string, OperatorSignal>>({});
  const ordered = signals.map((signal) => dismissed[signal.id] ?? signal);
  const open = ordered.filter((signal) => signal.state === 'open');
  const busy = progress !== null;
  useLayoutEffect(() => {
    const target = focus.current;
    if (target) {
      focus.current = null;
      (
        ({ toggle, bulk: bulkButton, confirm: confirmButton, retry: retryButton })[target].current ??
        toggle.current
      )?.focus();
    }
    const id = pendingFocus.current;
    if (!id || ordered.find((signal) => signal.id === id)?.state === 'open') return;
    pendingFocus.current = null;
    const rows = [...(section.current?.querySelectorAll<HTMLElement>('li[data-signal-id]') ?? [])];
    const index = rows.findIndex((row) => row.dataset.signalId === id);
    const next = [...rows.slice(index + 1), ...rows.slice(0, index)].find(
      (row) => row.dataset.state === 'open' && row.querySelector('button:not(:disabled)'),
    );
    (next?.querySelector<HTMLElement>('button:not(:disabled)') ?? toggle.current)?.focus();
  });
  const cancel = () => {
    focus.current = 'bulk';
    setConfirm(false);
  };
  const dismissAll = async () => {
    const targets = failures.length ? open.filter((signal) => failures.includes(signal.id)) : open;
    let cursor = 0;
    let done = 0;
    const failed: string[] = [];
    setConfirm(false);
    setFailures([]);
    setProgress({ done, total: targets.length });
    await Promise.all(
      Array.from({ length: Math.min(4, targets.length) }, async () => {
        while (cursor < targets.length) {
          const signal = targets[cursor++]!;
          // Retain feedback before the final refresh, including signals already closed elsewhere.
          onDismiss(signal.id);
          try {
            let result: OperatorSignal;
            try {
              result = await api.dismissOperatorSignal(key, signal.id);
            } catch (error) {
              if (!isApiError(error) || error.code !== 'operator_signal_closed') throw error;
              result = {
                ...signal,
                state: 'dismissed',
                decidedAt: new Date().toISOString(),
                decidedBy: myHandle,
              };
            }
            setDismissed((previous) => ({ ...previous, [signal.id]: result }));
          } catch {
            failed.push(signal.id);
          }
          setProgress({ done: ++done, total: targets.length });
        }
      }),
    );
    await client.invalidateQueries({ queryKey: queryKeys.operator(key) });
    setProgress(null);
    setFailures(failed);
    if (failed.length) focus.current = 'retry';
    else {
      setExpanded(false);
      focus.current = 'toggle';
    }
  };
  const from = formatTime(signals[0]!.raisedAt);
  const to = formatTime(signals.at(-1)!.raisedAt);
  return (
    <section
      ref={section}
      className={`${styles.card} ${styles.signalGroup}`}
      data-state={open.length ? 'open' : 'resolved'}
      aria-labelledby={titleId}
    >
      <h3 id={titleId} className={styles.groupHeading}>
        <button
          ref={toggle}
          type="button"
          className={styles.toggle}
          aria-expanded={expanded}
          aria-controls={contentId}
          disabled={busy}
          onClick={() => setExpanded(!expanded)}
        >
          <Icon name="bell" size={16} />
          <span className={styles.toggleLabel}>
            <strong>
              {t(open.length ? 'operator.signal.pending' : 'operator.signal.pendingNone', {
                count: open.length,
              })}
            </strong>{' '}
            <span className={styles.range}>
              {from === to ? from : t('operator.signal.pendingRange', { from, to })}
            </span>
          </span>
          <span className={styles.toggleHint} aria-hidden="true">
            {t(expanded ? 'operator.signal.hide' : 'operator.signal.show')}{' '}
            <span className={styles.chevron}>⌄</span>
          </span>
        </button>
      </h3>
      <div id={contentId} hidden={!expanded}>
        {!readOnly && (open.length >= 2 || confirm || busy || failures.length > 0) ? (
          <div
            className={styles.bulk}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && confirm) {
                event.stopPropagation();
                cancel();
              }
            }}
          >
            {busy ? (
              <p role="status">{t('operator.signal.dismissAllProgress', progress)}</p>
            ) : failures.length ? (
              <>
                <p className={styles.error} role="alert">
                  {t('operator.signal.dismissAllFailed', { count: failures.length })}
                </p>
                <Button ref={retryButton} size="md" variant="secondary" onClick={() => void dismissAll()}>
                  {t('operator.signal.dismissAllRetry')}
                </Button>
              </>
            ) : confirm ? (
              <>
                <p>{t('operator.signal.dismissAllConfirm', { count: open.length })}</p>
                <Button ref={confirmButton} size="md" variant="danger" onClick={() => void dismissAll()}>
                  {t('operator.signal.dismissAllYes')}
                </Button>
                <Button size="md" variant="secondary" onClick={cancel}>
                  {t('operator.signal.dismissAllCancel')}
                </Button>
              </>
            ) : (
              <Button
                ref={bulkButton}
                size="md"
                variant="secondary"
                onClick={() => {
                  focus.current = 'confirm';
                  setConfirm(true);
                }}
              >
                {t('operator.signal.dismissAll', { count: open.length })}
              </Button>
            )}
          </div>
        ) : null}
        <ul className={`${styles.rows} ${styles.groupRows}`}>
          {ordered.map((signal) => (
            <SignalRow
              key={signal.id}
              signal={signal}
              time={formatTime(signal.raisedAt)}
              operatorHandle={operatorHandle}
              readOnly={readOnly}
              disabled={busy}
              onDecide={() => {
                pendingFocus.current = signal.id;
                onDismiss(signal.id);
              }}
            />
          ))}
        </ul>
        {signals.length > 5 ? (
          <Button
            className={styles.collapse}
            variant="ghost"
            size="md"
            disabled={busy}
            onClick={() => {
              setExpanded(false);
              toggle.current?.focus();
              toggle.current?.scrollIntoView({ block: 'nearest' });
            }}
          >
            {t('operator.signal.hide')}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
