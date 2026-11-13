import clsx from 'clsx';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, RefObject } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import {
  OWNER_QUESTION_WEEKS_DEFAULT,
  canSeeProjectManagerSessions,
  canReadProjectManagerKnowledge,
  workQueueScopeOf,
} from '@projectman/shared';
import type { UiLocation } from '@projectman/shared';
import { api } from '../../api/endpoints';
import { useBoard, useSendTeamMessage } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Avatar } from '../../components/Avatar';
import { Button, ButtonLink } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { ErrorState } from '../../components/States';
import { t } from '../../i18n/t';
import { useIsMobile } from '../../lib/hooks';
import { dragHasFiles, droppedFiles } from '../../lib/attachmentInput';
import { transferToCardDraft } from '../board/useCardCommentDraft';
import type { DraftFile } from '../board/useCardCommentDraft';
import { Composer } from '../session/Composer';
import { ProjectManagerThread } from './ProjectManagerThread';
import { ProjectManagerChecklist } from './ProjectManagerChecklist';
import { ProjectManagerKnowledgeView } from './ProjectManagerKnowledgeView';
import { ProjectManagerQueueStrip } from './ProjectManagerQueueStrip';
import type { FailedProjectManagerMessage } from './ProjectManagerThread';
import { ProjectManagerWaitBanner } from './ProjectManagerWaitBanner';
import { ProjectManagerWeeklyView } from './ProjectManagerWeeklyView';
import { projectManagerStatusText } from './projectManagerChannel';
import { useProjectManagerUploads } from './projectManagerUploads';
import { placePath, useUiLocation } from './places';
import { useProjectManager } from './useProjectManager';
import styles from './ProjectManagerPanel.module.css';

/** The panel's width on a desktop screen (the same as in OperatorPanel.module.css): an open card makes room for it. */
const PANEL_WIDTH = 440;
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The project manager's conversation (PM-429, PM-447, PM-1042): a panel that slides in from the right (a sheet from
 * the bottom on a phone) beside the page, without hiding it. Not modal: the board stays usable. Every
 * person of the project has their own conversation in it; on a read-only channel (not an owner) the
 * project manager only reads and answers.
 */
export function ProjectManagerPanel({ returnFocusTo }: { returnFocusTo: RefObject<HTMLElement | null> }) {
  const {
    key,
    me,
    can,
    isOwner,
    closeProjectManager,
    projectManagerPrefill,
    projectManagerChecklistRequest,
    projectManagerDraft,
  } = useProject();
  const isMobile = useIsMobile();
  const { pathname, search, hash } = useLocation();
  const navigate = useNavigate();
  const openedAt = useRef(pathname);
  const board = useBoard(key);
  const { channel, state, handle, member } = useProjectManager();
  const send = useSendTeamMessage(key);
  const uploads = useProjectManagerUploads();
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const panel = useRef<HTMLElement>(null);
  const titleId = useId();
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const knowledgeButton = useRef<HTMLButtonElement>(null);
  const [weeklyOpen, setWeeklyOpen] = useState(false);
  const weeklyButton = useRef<HTMLButtonElement>(null);
  const [weeklyLeft, setWeeklyLeft] = useState(0);
  // The message being written outlives the subviews that replace the composer for a while, and the panel itself.
  const [hasText, setHasText] = useState(() => projectManagerDraft.current.trim() !== '');
  const keepDraft = useCallback(
    (text: string) => {
      projectManagerDraft.current = text;
      setHasText(text.trim() !== '');
    },
    [projectManagerDraft],
  );
  // Keep handled checklist requests across the conversation view's unmounts.
  const appliedChecklistRequest = useRef<number | null>(null);
  useEffect(() => {
    if (!projectManagerChecklistRequest) return;
    setKnowledgeOpen(false);
    setWeeklyOpen(false);
  }, [projectManagerChecklistRequest]);
  // Back from the weekly measure the focus returns to its entry, which is drawn again only then; the
  // composer drawn with it does not take the focus (its own effect may run after this one).
  useEffect(() => {
    if (weeklyLeft > 0) weeklyButton.current?.focus();
  }, [weeklyLeft]);
  const access = me.projects.find((project) => project.key === key)?.access;
  // The weekly question measure is the owner's own (PM-1192): never an integrator key, not even an owner's.
  const weeklyVisible = isOwner && !me.via;
  const subviewOpen = knowledgeOpen || (weeklyOpen && weeklyVisible);
  // The queue is for a person's own login with developer access (the server's rule), not for an integrator key.
  const queueVisible = !me.via && access !== undefined && workQueueScopeOf({ access }) !== null;
  const queueLength = state?.queue.open ?? 0;
  // The project manager's queue is a view of the Team page (PM-1297): the panel closes and the page takes over;
  // its "back" link brings the panel and this conversation back.
  const queuePath = handle ? `/p/${key}/team?view=queues&queue=member:${handle}` : null;
  const queueState = { fromProjectManager: { path: pathname + search + hash } };
  const openQueue = () => {
    if (!queuePath) return;
    closeProjectManager();
    void navigate(queuePath, { state: queueState });
  };
  const sessionVisible = access !== undefined && canSeeProjectManagerSessions({ access });
  const readOnly = state?.readOnly ?? false;

  // The open card is what the message is about, unless the writer takes it off; then only the page goes along.
  // Only the card's key stops going along; the place the message was written at stays what it is (PM-1305).
  const [dismissedCard, setDismissedCard] = useState<string | null>(null);
  const location = useUiLocation();
  const openCard = location.taskKey ?? null;
  const contextCard = openCard !== null && openCard !== dismissedCard ? openCard : null;
  const contextTitle = useMemo(
    () => board.data?.tasks.find((task) => task.key === openCard)?.title ?? '',
    [board.data, openCard],
  );

  // An example from the introduction goes into the box to be edited and sent.
  const [prefill, setPrefill] = useState<{ text: string; id: number; quiet?: boolean } | null>(null);
  useEffect(() => {
    if (!projectManagerPrefill) return;
    setKnowledgeOpen(false);
    setWeeklyOpen(false);
    setPrefill((previous) => ({ text: projectManagerPrefill.text, id: (previous?.id ?? 0) + 1 }));
  }, [projectManagerPrefill]);

  const [failed, setFailed] = useState<FailedProjectManagerMessage | null>(null);
  const post = (
    text: string,
    taskKey: string | null,
    attachments: NonNullable<FailedProjectManagerMessage['attachments']> = [],
    sentFrom: UiLocation = location,
    // A new message gets a new id; sending a failed one again keeps its id, so the server keeps one message.
    clientRequestId: string = crypto.randomUUID(),
  ) =>
    send
      .mutateAsync({
        clientRequestId,
        to: [handle!],
        text,
        ...(taskKey ? { taskKey } : {}),
        ...(attachments.length ? { attachmentIds: attachments.map((file) => file.id) } : {}),
        location: sentFrom,
      })
      .then(() => setFailed(null))
      .catch(() => setFailed({ text, taskKey, attachments, location: sentFrom, clientRequestId }));

  // "Írás a kártyára": the unsent text and files go to the open card's comment box, and nothing is sent. The files
  // are uploaded again as the card's own (the panel's belong to a message), then the panel's copies are dropped.
  const [moving, setMoving] = useState(false);
  // Set once a draft moved to the card: the focus is the card's box's then, not the button that opened the panel.
  const movedToCard = useRef(false);
  const [moveFailed, setMoveFailed] = useState(false);
  const writeOnCard = async () => {
    if (!openCard || moving) return;
    setMoving(true);
    setMoveFailed(false);
    const moved: DraftFile[] = [];
    try {
      for (const item of uploads.items) {
        if (!item.file) continue;
        // As an unsent comment file: that is the only kind a comment can be sent with.
        const { attachment } = await api.uploadCommentAttachment(key, openCard, item.file);
        moved.push({
          id: attachment.id,
          fileName: attachment.fileName,
          size: attachment.size,
          mediaType: attachment.mediaType,
          preview: attachment.preview,
        });
      }
    } catch {
      await Promise.allSettled(moved.map((file) => api.deleteAttachment(key, openCard, file.id)));
      setMoveFailed(true);
      setMoving(false);
      return;
    }
    transferToCardDraft(key, openCard, { text: projectManagerDraft.current, attachments: moved });
    await Promise.allSettled(uploads.items.map((item) => uploads.remove(item.id)));
    uploads.clear();
    projectManagerDraft.current = '';
    setHasText(false);
    // The focus goes to the card's box, so the emptied field does not take it.
    setPrefill((previous) => ({ text: '', id: (previous?.id ?? 0) + 1, quiet: true }));
    setMoving(false);
    movedToCard.current = isMobile;
    // The panel stays beside a desktop page; on a phone the sheet covers the card, so it closes (the draft stays).
    void navigate(placePath(key, { page: 'card', taskKey: openCard, view: 'thread' }, location));
    if (isMobile) closeProjectManager();
  };

  // The focus goes into the panel on open and back to the button on close.
  useEffect(() => {
    const target = returnFocusTo.current;
    return () => {
      if (!movedToCard.current) target?.focus();
    };
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
    if (isMobile && pathname !== openedAt.current) closeProjectManager();
  }, [isMobile, pathname, closeProjectManager]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.target instanceof Element && event.target.closest('dialog[open]')) return;
    if (event.key === 'Escape') {
      event.stopPropagation();
      closeProjectManager();
    }
    // On a phone the sheet covers the page and is modal: Tab goes round inside it, never to the card beneath.
    if (event.key === 'Tab' && isMobile && panel.current) {
      const focusable = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => element.offsetParent !== null || element === document.activeElement,
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panel.current.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !panel.current.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  const name = state?.member?.displayName ?? t('operator.name');
  const status = projectManagerStatusText(state);
  const missing = state?.state === 'missing';

  return (
    <section
      ref={panel}
      id="operator-panel"
      className={styles.panel}
      role="dialog"
      aria-modal={isMobile}
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
        <Avatar member={member} handle={handle ?? 'pm'} size="lg" />
        <div className={styles.who}>
          <div className={styles.nameRow}>
            <h2 id={titleId} className={styles.name}>
              {name}
            </h2>
          </div>
          <div className={styles.status}>
            {status}
            {status && isOwner && !missing ? ` · ${t('operator.panel.subline')}` : ''}
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
        {queueVisible && queuePath ? (
          <span className={styles.queueToggle}>
            <ButtonLink
              className={styles.knowledgeButton}
              variant="ghost"
              size="lg"
              iconOnly
              icon="list"
              to={queuePath}
              state={queueState}
              aria-label={t('operator.queue.strip.label')}
              title={t('operator.queue.strip.label')}
              onClick={closeProjectManager}
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
            aria-label={t(canReadProjectManagerKnowledge({ access }) ? 'knowledge.title' : 'knowledge.style')}
            title={t(canReadProjectManagerKnowledge({ access }) ? 'knowledge.title' : 'knowledge.style')}
            onClick={() => {
              setKnowledgeOpen(!knowledgeOpen);
              setWeeklyOpen(false);
            }}
          />
        ) : null}
        <Button
          variant="ghost"
          size="md"
          iconOnly
          icon="close"
          aria-label={t('operator.panel.close')}
          onClick={closeProjectManager}
        />
      </header>

      {!subviewOpen && weeklyVisible ? (
        <button
          ref={weeklyButton}
          type="button"
          className={styles.weeklyEntry}
          onClick={() => {
            setWeeklyOpen(true);
            setKnowledgeOpen(false);
          }}
        >
          <span className={styles.weeklyEntryText}>
            {t('operator.weekly.entry')}
            <small>{t('operator.weekly.entryHint', { weeks: OWNER_QUESTION_WEEKS_DEFAULT })}</small>
          </span>
          <Icon name="chevronRight" size={16} strokeWidth={2.2} />
        </button>
      ) : null}

      {!subviewOpen ? <ProjectManagerChecklist key={key} appliedRequest={appliedChecklistRequest} /> : null}

      {weeklyOpen && weeklyVisible ? (
        <ProjectManagerWeeklyView
          key={key}
          onBack={() => {
            setWeeklyOpen(false);
            setWeeklyLeft((count) => count + 1);
          }}
        />
      ) : knowledgeOpen ? (
        <ProjectManagerKnowledgeView
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
          <p>{t('operator.missing.hint')}</p>
          {can.manageTeam ? (
            <ButtonLink to={`/p/${key}/team`} variant="secondary" size="md" onClick={closeProjectManager}>
              {t('operator.missing.team')} →
            </ButtonLink>
          ) : null}
        </div>
      ) : (
        <>
          {queueVisible ? <ProjectManagerQueueStrip channel={state} onOpen={openQueue} /> : null}
          <ProjectManagerThread
            handle={handle}
            channel={state}
            failed={failed}
            retrying={send.isPending}
            onRetry={() =>
              failed &&
              !send.isPending &&
              void post(
                failed.text,
                failed.taskKey,
                failed.attachments,
                failed.location,
                failed.clientRequestId,
              )
            }
            onExample={(text) => setPrefill({ text, id: (prefill?.id ?? 0) + 1 })}
          />
          <ProjectManagerWaitBanner channel={state} />
          {openCard ? (
            <div className={styles.contextBlock}>
              {contextCard ? (
                <>
                  <div className={styles.context}>
                    <span
                      className={styles.contextText}
                      title={t('operator.context.title', { key: contextCard, title: contextTitle }).trim()}
                    >
                      {t('operator.context.label', { key: contextCard })}
                    </span>
                    <Link className={styles.contextOpen} to={`/p/${key}/tasks/${contextCard}`}>
                      {t('operator.context.open', { key: contextCard })}
                    </Link>
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      icon="close"
                      aria-label={t('operator.context.remove')}
                      onClick={() => setDismissedCard(contextCard)}
                    />
                  </div>
                </>
              ) : null}
              <p className={styles.contextHint}>{t('operator.context.hint')}</p>
              {hasText || uploads.items.length > 0 ? (
                <Button
                  className={styles.writeOnCard}
                  variant="secondary"
                  size="sm"
                  loading={moving}
                  title={t('operator.writeOnCard.title')}
                  onClick={() => void writeOnCard()}
                >
                  {t('operator.writeOnCard.action')}
                </Button>
              ) : null}
              {moveFailed ? (
                <p className={styles.contextError} role="alert">
                  {t('operator.writeOnCard.failed')}
                </p>
              ) : null}
            </div>
          ) : null}
          <div className={styles.composer}>
            <Composer
              autoFocus={!projectManagerChecklistRequest?.focus && weeklyLeft === 0}
              label={t('operator.composer.label')}
              placeholder={
                readOnly ? t('operator.composer.placeholderOther') : t('operator.composer.placeholder')
              }
              disabled={send.isPending}
              attachments={uploads}
              prefill={prefill}
              initialText={projectManagerDraft.current}
              onTextChange={keepDraft}
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
