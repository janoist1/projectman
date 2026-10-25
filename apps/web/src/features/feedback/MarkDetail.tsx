import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { routes } from '@projectman/shared';
import type { FeedbackMarkDetail, FeedbackSurfaceView } from '@projectman/shared';
import { isApiError } from '../../api/client';
import { useCommentFeedback, useFeedbackMark, useReadFeedback, useReopenFeedback } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button, ButtonLink } from '../../components/Button';
import { TextAreaField } from '../../components/Field';
import { EmptyState, ErrorState, LoadingState } from '../../components/States';
import { useToast } from '../../components/toastContext';
import { formatAgo } from '../../i18n/format';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import type { MemberIndex } from '../../lib/members';
import { AttachmentImageDialog } from '../board/AttachmentImageDialog';
import { CloseMarkDialog } from './CloseMarkDialog';
import { CreateCardDialog } from './CreateCardDialog';
import { DecisionRow } from './DecisionRow';
import { sourceLabel } from './feedbackModel';
import { useLaunchSurface } from './LaunchButton';
import { LinkCardDialog } from './LinkCardDialog';
import { MarkDetails } from './MarkDetails';
import { MarkerAvatar } from './MarkerAvatar';
import { MarkStatusChip } from './MarkStatusChip';
import { MarkThread } from './MarkThread';
import styles from './MarkDetail.module.css';

type DialogKind = 'create' | 'link' | 'close';

function SourceLink({
  mark,
  surfaces,
  canMark,
}: {
  mark: FeedbackMarkDetail;
  surfaces: readonly FeedbackSurfaceView[];
  canMark: boolean;
}) {
  const launch = useLaunchSurface();
  const label = sourceLabel(mark);
  const known = surfaces.some((surface) => surface.id === mark.surface.id && surface.name !== null);
  // With the marker switched on the page opens at the mark; else it is only the page.
  if (canMark && known) {
    return (
      <button
        type="button"
        className={styles.source}
        disabled={launch.pending}
        onClick={() => launch.open(mark.surface.id, mark.id)}
      >
        {label} ↗
      </button>
    );
  }
  return (
    <a className={styles.source} href={mark.pageUrl} target="_blank" rel="noopener noreferrer">
      {label} ↗
    </a>
  );
}

function Composer({ mark }: { mark: FeedbackMarkDetail }) {
  const { key } = useProject();
  const toast = useToast();
  const comment = useCommentFeedback(key, mark.id);
  const [body, setBody] = useState('');
  const placeholder = mark.canProcess
    ? t('feedback.composer.processor', { name: mark.author.name })
    : t('feedback.composer.member');
  const send = () => {
    const text = body.trim();
    if (!text || comment.isPending) return;
    comment.mutate(
      { body: text },
      {
        onSuccess: () => setBody(''),
        // The text stays in the box: the person can send it again.
        onError: () => toast.show(t('feedback.composer.sendFailed'), 'error'),
      },
    );
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      send();
    }
  };
  return (
    <form
      className={styles.composer}
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <TextAreaField
        hideLabel
        label={placeholder}
        placeholder={placeholder}
        rows={2}
        maxLength={4000}
        value={body}
        disabled={comment.isPending}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className={styles.composerRow}>
        <p className={styles.hint}>
          {mark.canProcess ? t('feedback.composer.processorHint') : t('feedback.composer.memberHint')}
        </p>
        <Button type="submit" size="md" icon="send" loading={comment.isPending} disabled={body.trim() === ''}>
          {t('feedback.composer.send')}
        </Button>
      </div>
    </form>
  );
}

function Opened({
  mark,
  search,
  surfaces,
  canMark,
  members,
  ownerName,
  isMobile,
}: {
  mark: FeedbackMarkDetail;
  search: string;
  surfaces: readonly FeedbackSurfaceView[];
  canMark: boolean;
  members: MemberIndex;
  ownerName: string;
  isMobile: boolean;
}) {
  const { key, myHandle, isOwner } = useProject();
  const toast = useToast();
  const reopen = useReopenFeedback(key, mark.id);
  const { mutate: markRead } = useReadFeedback(key);
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [shotOpen, setShotOpen] = useState(false);
  const readMarks = useRef(new Set<string>());

  // Opening a mark reads it; a reply that comes in later reads again once the person has it in front of them.
  useEffect(() => {
    const stamp = `${mark.id}:${mark.lastActivityAt}`;
    if (mark.unread && !readMarks.current.has(stamp)) {
      readMarks.current.add(stamp);
      markRead(mark.id);
    }
  }, [mark.id, mark.lastActivityAt, mark.unread, markRead]);

  const clientAuthor = members.get(mark.author.handle)?.role === 'client';
  const canProcess = mark.canProcess;
  const closed = mark.status === 'closed';
  const screenshot = routes.feedbackScreenshot(key, mark.id);

  return (
    <section className={styles.detail} aria-label={t('feedback.detail.label')}>
      <div className={styles.scroll}>
        {isMobile ? (
          <ButtonLink
            to={{ pathname: `/p/${key}/feedback`, search }}
            variant="ghost"
            size="md"
            icon="chevronLeft"
            className={styles.back}
          >
            {t('feedback.detail.back')}
          </ButtonLink>
        ) : null}
        <header className={styles.head}>
          <h2 className={styles.title}>{mark.body}</h2>
          <div className={styles.status}>
            <MarkStatusChip mark={mark} ownerName={ownerName} />
          </div>
        </header>
        <p className={styles.meta}>
          <MarkerAvatar person={mark.author} member={members.get(mark.author.handle)} size="sm" />
          <span>
            <strong>{mark.author.name}</strong>
            {clientAuthor ? ` · ${t('feedback.detail.client')}` : ''} · {formatAgo(mark.createdAt)} ·{' '}
            {t(`feedback.kinds.${mark.kind}`)} ·{' '}
          </span>
          <SourceLink mark={mark} surfaces={surfaces} canMark={canMark} />
        </p>
        <DecisionRow mark={mark} projectKey={key} ownerName={ownerName} isOwner={isOwner} />
        {canProcess ? (
          <div className={styles.actions}>
            {closed ? (
              <Button
                variant="secondary"
                size="md"
                loading={reopen.isPending}
                onClick={() =>
                  reopen.mutate(undefined, {
                    onSuccess: () => toast.show(t('feedback.actions.reopened')),
                    onError: (error) => toast.show(errorMessage(error), 'error'),
                  })
                }
              >
                {t('feedback.actions.reopen')}
              </Button>
            ) : (
              <>
                {mark.card === null ? (
                  <Button variant="primary" size="md" icon="plus" onClick={() => setDialog('create')}>
                    {t('feedback.actions.create')}
                  </Button>
                ) : null}
                <Button variant="secondary" size="md" onClick={() => setDialog('link')}>
                  {mark.card === null ? t('feedback.actions.link') : t('feedback.actions.linkAnother')}
                </Button>
                <Button variant="ghost" size="md" onClick={() => setDialog('close')}>
                  {t('feedback.actions.close')}
                </Button>
              </>
            )}
          </div>
        ) : null}
        {canProcess && mark.screenshot ? (
          <button
            type="button"
            className={styles.shot}
            aria-label={t('feedback.detail.shotOpen')}
            onClick={() => setShotOpen(true)}
          >
            <img src={`${screenshot}?thumb=1`} alt={t('feedback.detail.shotAlt')} />
          </button>
        ) : canProcess ? (
          <p className={styles.noShot}>{t('feedback.detail.noShot')}</p>
        ) : null}
        {canProcess ? <MarkDetails mark={mark} /> : null}
        <MarkThread mark={mark} projectKey={key} members={members} myHandle={myHandle} />
      </div>
      {mark.canComment ? (
        <Composer mark={mark} />
      ) : closed ? (
        <p className={styles.closedNote}>{t('feedback.composer.closed')}</p>
      ) : !closed ? (
        <p className={styles.closedNote}>{t('feedback.composer.viewer')}</p>
      ) : null}
      <CreateCardDialog open={dialog === 'create'} mark={mark} onClose={() => setDialog(null)} />
      <LinkCardDialog open={dialog === 'link'} mark={mark} onClose={() => setDialog(null)} />
      <CloseMarkDialog open={dialog === 'close'} mark={mark} onClose={() => setDialog(null)} />
      <AttachmentImageDialog
        image={
          shotOpen && mark.screenshot
            ? { fileName: t('feedback.detail.shotName'), size: mark.screenshot.size, src: screenshot }
            : null
        }
        onClose={() => setShotOpen(false)}
      />
    </section>
  );
}

/** The mark picked in the list: what it is, what is to be done with it, and its conversation. */
export function MarkDetail({
  markId,
  search,
  surfaces,
  canMark,
  members,
  ownerName,
  isMobile,
}: {
  markId: string;
  search: string;
  surfaces: readonly FeedbackSurfaceView[];
  canMark: boolean;
  members: MemberIndex;
  ownerName: string;
  isMobile: boolean;
}) {
  const { key } = useProject();
  const detail = useFeedbackMark(key, markId);
  if (detail.isPending) {
    return (
      <div className={styles.state}>
        <LoadingState />
      </div>
    );
  }
  if (detail.isError) {
    const missing = isApiError(detail.error) && detail.error.status === 404;
    return (
      <div className={styles.state}>
        {missing ? (
          <EmptyState icon="pin" title={t('feedback.detail.notFound')} />
        ) : (
          <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
        )}
        {missing || isMobile ? (
          <ButtonLink to={{ pathname: `/p/${key}/feedback`, search }} variant="secondary" size="md">
            {missing ? t('feedback.detail.backToList') : t('feedback.detail.back')}
          </ButtonLink>
        ) : null}
      </div>
    );
  }
  return (
    <Opened
      mark={detail.data}
      search={search}
      surfaces={surfaces}
      canMark={canMark}
      members={members}
      ownerName={ownerName}
      isMobile={isMobile}
    />
  );
}
