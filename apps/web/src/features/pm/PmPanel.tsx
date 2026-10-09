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

/**
 * The project manager's conversation (PM-429): a panel that slides in from the right (a sheet from
 * the bottom on a phone) over the page, without hiding it. Not modal: the board stays usable.
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
            {t('pm.panel.fullSession')}
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
              onSend={(text) => post(text, contextCard)}
            />
          </div>
        </>
      )}
    </section>
  );
}
