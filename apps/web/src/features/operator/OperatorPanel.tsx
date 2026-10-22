import clsx from 'clsx';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, RefObject } from 'react';
import { Link, useLocation, useMatch } from 'react-router';
import { canSeeOperatorSessions, canReadOperatorKnowledge, hasAccess } from '@projectman/shared';
import { useBoard, useSendTeamMessage } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Avatar } from '../../components/Avatar';
import { Button, ButtonLink } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { ErrorState } from '../../components/States';
import { t } from '../../i18n/t';
import { useIsMobile } from '../../lib/hooks';
import { dragHasFiles, droppedFiles } from '../../lib/attachmentInput';
import { useMessageAttachmentUploads } from '../messages/useMessageAttachmentUploads';
import { Composer } from '../session/Composer';
import { OperatorThread } from './OperatorThread';
import { OperatorKnowledgeView } from './OperatorKnowledgeView';
import { OperatorQueueStrip, OperatorQueueView } from './OperatorQueueView';
import type { FailedOperatorMessage } from './OperatorThread';
import { OperatorWaitBanner } from './OperatorWaitBanner';
import { operatorStatusText } from './operatorChannel';
import { useOperator } from './useOperator';
import styles from './OperatorPanel.module.css';

/** The panel's width on a desktop screen (the same as in OperatorPanel.module.css): an open card makes room for it. */
const PANEL_WIDTH = 440;

/**
 * The Operator's conversation (PM-429, PM-447): a panel that slides in from the right (a sheet from
 * the bottom on a phone) beside the page, without hiding it. Not modal: the board stays usable. Every
 * person of the project has their own conversation in it; on a read-only channel (not an owner) the
 * Operator only reads and answers.
 */
export function OperatorPanel({ returnFocusTo }: { returnFocusTo: RefObject<HTMLElement | null> }) {
  const { key, me, closeOperator, operatorPrefill } = useProject();
  const isMobile = useIsMobile();
  const { pathname } = useLocation();
  const openedAt = useRef(pathname);
  const board = useBoard(key);
  const { channel, state, handle, member } = useOperator();
  const send = useSendTeamMessage(key);
  const uploads = useMessageAttachmentUploads(key);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const panel = useRef<HTMLElement>(null);
  const titleId = useId();
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const knowledgeButton = useRef<HTMLButtonElement>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const queueButton = useRef<HTMLButtonElement>(null);
  const access = me.projects.find((project) => project.key === key)?.access;
  // The queue is for a person's own login with developer access (the server's rule), not for an integrator key.
  const queueVisible = !me.via && access !== undefined && hasAccess(access, 'developer');
  const queueLength = state?.queue.open ?? 0;
  const sessionVisible = access !== undefined && canSeeOperatorSessions({ access });
  const readOnly = state?.readOnly ?? false;

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
  useEffect(() => {
    if (!operatorPrefill) return;
    setKnowledgeOpen(false);
    setQueueOpen(false);
    setPrefill((previous) => ({ text: operatorPrefill.text, id: (previous?.id ?? 0) + 1 }));
  }, [operatorPrefill]);

  const [failed, setFailed] = useState<FailedOperatorMessage | null>(null);
  const post = (
    text: string,
    taskKey: string | null,
    attachments: NonNullable<FailedOperatorMessage['attachments']> = [],
  ) =>
    send
      .mutateAsync({
        to: [handle!],
        text,
        ...(taskKey ? { taskKey } : {}),
        ...(attachments.length ? { attachmentIds: attachments.map((file) => file.id) } : {}),
      })
      .then(() => setFailed(null))
      .catch(() => setFailed({ text, taskKey, attachments }));

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
    if (isMobile && pathname !== openedAt.current) closeOperator();
  }, [isMobile, pathname, closeOperator]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.target instanceof Element && event.target.closest('dialog[open]')) return;
    if (event.key === 'Escape') {
      event.stopPropagation();
      closeOperator();
    }
  };

  const name = state?.member?.displayName ?? t('operator.name');
  const status = operatorStatusText(state);
  const missing = state?.state === 'missing';

  return (
    <section
      ref={panel}
      id="operator-panel"
      className={styles.panel}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      onKeyDown={onKeyDown}
      onDragEnter={(event) => {
        if (isMobile || !handle || !dragHasFiles(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(event) => {
        if (isMobile || !handle || !dragHasFiles(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = send.isPending ? 'none' : 'copy';
      }}
      onDragLeave={(event) => {
        if (!dragging) return;
        event.stopPropagation();
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) {
          dragDepth.current = 0;
          setDragging(false);
        }
      }}
      onDrop={(event) => {
        if (isMobile || !handle || !dragHasFiles(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        dragDepth.current = 0;
        setDragging(false);
        if (!send.isPending) uploads.add(droppedFiles(event.dataTransfer));
      }}
    >
      {dragging ? (
        <div className={styles.drop} aria-hidden="true">
          <Icon name="paperclip" size={28} />
          {t('attachments.dropActive')}
        </div>
      ) : null}
      <header className={styles.head}>
        <Avatar member={member} handle={handle ?? 'operator'} size="lg" />
        <div className={styles.who}>
          <h2 id={titleId} className={styles.name}>
            {name}
          </h2>
          <div className={styles.status}>
            {status}
            {status && !readOnly && !missing ? ` · ${t('operator.panel.subline')}` : ''}
          </div>
        </div>
        {state?.sessionId && sessionVisible ? (
          <Link
            to={`/p/${key}/sessions/${state.sessionId}`}
            className={styles.session}
            title={t('operator.panel.fullSessionTitle')}
          >
            <span className={styles.sessionLabel}>{t('operator.panel.fullSession')}</span>
            <Icon name="external" size={13} strokeWidth={2.2} />
          </Link>
        ) : null}
        {queueVisible ? (
          <span className={styles.queueToggle}>
            <Button
              ref={queueButton}
              className={styles.knowledgeButton}
              variant="ghost"
              size="lg"
              iconOnly
              icon="list"
              aria-pressed={queueOpen}
              aria-label={t(queueLength > 0 ? 'operator.queue.toggleCount' : 'operator.queue.toggle', {
                count: queueLength,
              })}
              title={t('operator.queue.toggle')}
              onClick={() => {
                setQueueOpen(!queueOpen);
                setKnowledgeOpen(false);
              }}
            />
            {queueLength > 0 ? (
              <span className={styles.queueCount} aria-hidden="true">
                {queueLength}
              </span>
            ) : null}
          </span>
        ) : null}
        {!me.via ? (
          <Button
            ref={knowledgeButton}
            className={styles.knowledgeButton}
            variant="ghost"
            size="lg"
            iconOnly
            icon="doc"
            aria-pressed={knowledgeOpen}
            aria-label={t(canReadOperatorKnowledge({ access }) ? 'knowledge.title' : 'knowledge.style')}
            title={t(canReadOperatorKnowledge({ access }) ? 'knowledge.title' : 'knowledge.style')}
            onClick={() => {
              setKnowledgeOpen(!knowledgeOpen);
              setQueueOpen(false);
            }}
          />
        ) : null}
        <Button
          variant="ghost"
          size="md"
          iconOnly
          icon="close"
          aria-label={t('operator.panel.close')}
          onClick={closeOperator}
        />
      </header>

      {queueOpen && queueVisible ? (
        <OperatorQueueView
          onBack={() => {
            setQueueOpen(false);
            queueButton.current?.focus();
          }}
        />
      ) : knowledgeOpen ? (
        <OperatorKnowledgeView
          onBack={() => {
            setKnowledgeOpen(false);
            knowledgeButton.current?.focus();
          }}
          onPrefill={(text) => {
            setPrefill({ text, id: (prefill?.id ?? 0) + 1 });
            setKnowledgeOpen(false);
          }}
        />
      ) : channel.isPending ? (
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
            message={t('operator.loadFailed')}
            onRetry={() => void channel.refetch()}
            compact
          />
        </div>
      ) : missing || !state || !handle ? (
        <div className={clsx(styles.body, styles.missing)}>
          <p>{t('operator.missing.title')}</p>
          <ButtonLink to={`/p/${key}/team`} variant="secondary" size="md" onClick={closeOperator}>
            {t('operator.missing.team')} →
          </ButtonLink>
        </div>
      ) : (
        <>
          {queueVisible ? (
            <OperatorQueueStrip
              channel={state}
              onOpen={() => {
                setQueueOpen(true);
                setKnowledgeOpen(false);
              }}
            />
          ) : null}
          <OperatorThread
            handle={handle}
            channel={state}
            failed={failed}
            onRetry={() =>
              failed && !send.isPending && void post(failed.text, failed.taskKey, failed.attachments)
            }
            onExample={(text) => setPrefill({ text, id: (prefill?.id ?? 0) + 1 })}
          />
          <OperatorWaitBanner channel={state} />
          {contextCard ? (
            <div className={styles.context}>
              <span className={styles.contextText}>
                {t('operator.context.label', { key: contextCard, title: contextTitle }).trim()}
              </span>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon="close"
                aria-label={t('operator.context.remove')}
                onClick={() => setDismissedCard(contextCard)}
              />
            </div>
          ) : null}
          <div className={styles.composer}>
            <Composer
              autoFocus
              label={t('operator.composer.label')}
              placeholder={
                readOnly ? t('operator.composer.placeholderOther') : t('operator.composer.placeholder')
              }
              disabled={send.isPending}
              attachments={uploads}
              prefill={prefill}
              onSend={(text) =>
                post(
                  text,
                  contextCard,
                  uploads.items.flatMap((item) => (item.attachment ? [item.attachment] : [])),
                )
              }
            />
          </div>
          {readOnly ? (
            <p className={styles.observers}>
              <Icon name="eye" size={13} />
              <span>{t('operator.panel.observers')}</span>
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
