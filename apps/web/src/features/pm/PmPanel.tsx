import clsx from 'clsx';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, RefObject } from 'react';
import { Link, useLocation, useMatch } from 'react-router';
import { useBoard, useSendTeamMessage } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Avatar } from '../../components/Avatar';
import { Button, ButtonLink } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { ErrorState } from '../../components/States';
import { t } from '../../i18n/t';
import { useIsMobile } from '../../lib/hooks';
import { Composer } from '../session/Composer';
import { PmThread } from './PmThread';
import type { FailedPmMessage } from './PmThread';
import { PmWaitBanner } from './PmWaitBanner';
import { pmStatusText } from './pmChannel';
import { usePm } from './usePm';
import styles from './PmPanel.module.css';

/** The panel's width on a desktop screen (the same as in PmPanel.module.css): an open card makes room for it. */
const PANEL_WIDTH = 440;

/**
 * The project manager's conversation (PM-429): a panel that slides in from the right (a sheet from
 * the bottom on a phone) beside the page, without hiding it. Not modal: the board stays usable.
 */
export function PmPanel({ returnFocusTo }: { returnFocusTo: RefObject<HTMLElement | null> }) {
  const { key, closePm } = useProject();
  const isMobile = useIsMobile();
  const { pathname } = useLocation();
  const openedAt = useRef(pathname);
  const board = useBoard(key);
  const { channel, state, handle, member } = usePm();
  const send = useSendTeamMessage(key);
  const panel = useRef<HTMLElement>(null);
  const titleId = useId();

  // The open card is what the message is about, unless the writer takes it off.
  const openCard = useMatch('/p/:projectKey/tasks/:taskKey/*')?.params.taskKey ?? null;
  const [dismissedCard, setDismissedCard] = useState<string | null>(null);
  const contextCard = openCard && openCard !== dismissedCard ? openCard : null;
  const contextTitle = useMemo(
    () => board.data?.tasks.find((task) => task.key === contextCard)?.title ?? '',
    [board.data, contextCard],
  );

  // An example from the introduction goes into the box to be edited and sent.
  const [prefill, setPrefill] = useState<{ text: string; id: number } | null>(null);

  const [failed, setFailed] = useState<FailedPmMessage | null>(null);
  const post = (text: string, taskKey: string | null) =>
    send
      .mutateAsync({ to: [handle!], text, ...(taskKey ? { taskKey } : {}) })
      .then(() => setFailed(null))
      .catch(() => setFailed({ text, taskKey }));

  // The focus goes into the panel on open and back to the button on close.
  useEffect(() => {
    const target = returnFocusTo.current;
    return () => target?.focus();
  }, [returnFocusTo]);

  // Beside the panel an open card moves left and under the top bar, so the two do not overlap.
  useEffect(() => {
    if (isMobile) return;
    const root = document.documentElement.style;
    root.setProperty('--pm-dock-right', `${PANEL_WIDTH}px`);
    root.setProperty('--pm-dock-top', 'var(--topbar-height)');
    return () => {
      root.removeProperty('--pm-dock-right');
      root.removeProperty('--pm-dock-top');
    };
  }, [isMobile]);

  // On a phone the sheet covers the page: following a link (a card, the full session) leaves it.
  useEffect(() => {
    if (isMobile && pathname !== openedAt.current) closePm();
  }, [isMobile, pathname, closePm]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closePm();
    }
  };

  const name = state?.member?.displayName ?? t('pm.name');
  const status = pmStatusText(state);
  const missing = state?.state === 'missing';

  return (
    <section
      ref={panel}
      id="pm-panel"
      className={styles.panel}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      onKeyDown={onKeyDown}
    >
      <header className={styles.head}>
        <Avatar member={member} handle={handle ?? 'pm'} size="lg" />
        <div className={styles.who}>
          <h2 id={titleId} className={styles.name}>
            {name}
          </h2>
          <div className={styles.status}>{status}</div>
        </div>
        {state?.sessionId ? (
          <Link
            to={`/p/${key}/sessions/${state.sessionId}`}
            className={styles.session}
            title={t('pm.panel.fullSessionTitle')}
          >
            <span className={styles.sessionLabel}>{t('pm.panel.fullSession')}</span>
            <Icon name="external" size={13} strokeWidth={2.2} />
          </Link>
        ) : null}
        <Button
          variant="ghost"
          size="md"
          iconOnly
          icon="close"
          aria-label={t('pm.panel.close')}
          onClick={closePm}
        />
      </header>

      {channel.isPending ? (
        <div className={styles.body} role="status" aria-label={t('app.loading')}>
          <div className={styles.skeleton}>
            <span />
            <span />
          </div>
        </div>
      ) : channel.isError ? (
        <div className={styles.body}>
          <ErrorState
            error={channel.error}
            message={t('pm.loadFailed')}
            onRetry={() => void channel.refetch()}
            compact
          />
        </div>
      ) : missing || !state || !handle ? (
        <div className={clsx(styles.body, styles.missing)}>
          <p>{t('pm.missing.title')}</p>
          <ButtonLink to={`/p/${key}/team`} variant="secondary" size="md" onClick={closePm}>
            {t('pm.missing.team')} →
          </ButtonLink>
        </div>
      ) : (
        <>
          <PmThread
            handle={handle}
            channel={state}
            failed={failed}
            onRetry={() => failed && void post(failed.text, failed.taskKey)}
            onExample={(text) => setPrefill({ text, id: (prefill?.id ?? 0) + 1 })}
          />
          <PmWaitBanner channel={state} />
          {contextCard ? (
            <div className={styles.context}>
              <span className={styles.contextText}>
                {t('pm.context.label', { key: contextCard, title: contextTitle }).trim()}
              </span>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon="close"
                aria-label={t('pm.context.remove')}
                onClick={() => setDismissedCard(contextCard)}
              />
            </div>
          ) : null}
          <div className={styles.composer}>
            <Composer
              autoFocus
              label={t('pm.composer.label')}
              placeholder={t('pm.composer.placeholder')}
              disabled={send.isPending}
              prefill={prefill}
              onSend={(text) => post(text, contextCard)}
            />
          </div>
        </>
      )}
    </section>
  );
}
