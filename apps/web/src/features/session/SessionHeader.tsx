import { useState } from 'react';
import type { MouseEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import type { MemberView, PausedSession, Session, Task } from '@projectman/shared';
import { useStopSession } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { Chip, StatusDot } from '../../components/Chip';
import { Dialog } from '../../components/Dialog';
import { ErrorBanner } from '../../components/ErrorBanner';
import { TextField } from '../../components/Field';
import { Icon } from '../../components/Icon';
import { MoreMenu } from '../../components/MoreMenu';
import { StageProgress } from '../../components/StageProgress';
import { useToast } from '../../components/toastContext';
import { formatStamp, formatTokens } from '../../i18n/format';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import { useIsMobile } from '../../lib/hooks';
import { stagePosition } from '../../lib/pipeline';
import type { PipelineIndex } from '../../lib/pipeline';
import { isLiveSession } from '../../lib/sessions';
import type { SessionStatus } from '../../lib/sessions';
import type { TaskPhase } from '../../lib/taskState';
import { prChip } from '../board/cardModel';
import { withCardSize } from '../board/cardSize';
import { pointExplanation, pointText, runningText } from '../pause/pauseView';
import styles from './SessionHeader.module.css';

/**
 * The session's title with the member it belongs to (avatar and name), its live status and stop,
 * and chips for the task's stage, its PR and the token warning (PM-187). Where and how it runs
 * (branch, working directory, agent CLI, model, permission settings, tokens) is in the details
 * panel. On a phone the header is one row: back arrow, title, status, "⋯".
 */
export function SessionHeader({
  session,
  task,
  title,
  memberName,
  member,
  pipeline,
  taskPhase,
  live,
  pauseRow,
}: {
  session: Session;
  task: Task | null;
  title: string;
  memberName: string;
  member: MemberView | undefined;
  pipeline: PipelineIndex | null;
  taskPhase: TaskPhase | null;
  live: { status: SessionStatus | 'paused'; label: string; title?: string };
  /** The row the pause holds this session in: what it still waits for while it stops (PM-220). */
  pauseRow?: PausedSession;
}) {
  const { key } = useProject();
  const stop = useStopSession(key);
  const toast = useToast();
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const location = useLocation();
  const [confirmStop, setConfirmStop] = useState(false);
  const [stopNote, setStopNote] = useState('');
  const stage = task && pipeline ? pipeline.stageById.get(task.stageId) : undefined;
  const column = task && pipeline ? pipeline.columnOfStage.get(task.stageId) : undefined;
  const pr = task ? prChip(task) : null;
  const backTo = task ? `/p/${key}/tasks/${task.key}` : `/p/${key}`;
  // Back goes where the viewer came from; a page opened directly goes up to its task or the board.
  const goBack = (event: MouseEvent) => {
    if (location.key === 'default') return;
    event.preventDefault();
    void navigate(-1);
  };

  const liveStatus = (
    <span className={styles.live} data-status={live.status} role="status" title={live.title}>
      {live.status === 'paused' ? (
        session.pause?.point === null ? (
          <span className={styles.stopping} aria-hidden="true" />
        ) : (
          <Icon name="pause" size={13} strokeWidth={2.4} />
        )
      ) : (
        <StatusDot status={live.status} pulse={live.status === 'working'} size={9} />
      )}
      <span>{live.label}</span>
    </span>
  );
  const stopMenu = isLiveSession(session) ? (
    <MoreMenu>
      {(close) => (
        <Button
          variant="danger"
          icon="stop"
          onClick={() => {
            stop.reset();
            setConfirmStop(true);
            close();
          }}
        >
          {t('session.stop')}
        </Button>
      )}
    </MoreMenu>
  ) : null;
  // A conversation's or meeting's title already names the member; a task's or a schedule's does not.
  const showMember = task !== null || session.workItem.type === 'schedule';
  const memberTag = showMember ? (
    <span className={styles.member}>
      <Avatar member={member} handle={session.member} size={isMobile ? 'xs' : 'sm'} />
      <span className={styles.memberName}>{memberName}</span>
    </span>
  ) : null;
  const stageChip =
    task && pipeline && taskPhase ? (
      <span className={styles.stageChip}>
        <StageProgress pipeline={pipeline} stageId={task.stageId} phase={taskPhase} variant="chip" />
        <span>
          {t('task.stageChip', {
            stage: stage?.name ?? task.stageId,
            index: stagePosition(pipeline, task.stageId).index,
            total: stagePosition(pipeline, task.stageId).total,
          })}
        </span>
      </span>
    ) : null;
  const prBadge = pr ? (
    <Chip tone="outline" size="md" icon={pr.merged ? 'prMerged' : 'prOpen'} className={styles.prChip}>
      {pr.label}
    </Chip>
  ) : null;
  const alertChip = session.usageAlert ? (
    <Chip
      tone="needs"
      size="md"
      icon="exclamation"
      title={t('tokenUsage.alert', {
        time: formatStamp(session.usageAlert.at),
        counted: formatTokens(session.usageAlert.countedTokens),
        limit: formatTokens(session.usageAlert.limitTokens),
      })}
    >
      {t('tokenUsage.alertChip')}
    </Chip>
  ) : null;
  // Where the pause stopped the session (or what it still waits for): the pause holds a live session only.
  const pauseState = session.pause && isLiveSession(session) ? session.pause : null;
  const pointChip = pauseState ? (
    <Chip
      tone="outline"
      size="md"
      icon="pause"
      title={pauseState.point ? (pointExplanation(pauseState.point) ?? undefined) : undefined}
    >
      {pauseState.point
        ? pointText(pauseState.point, pauseState.tool)
        : runningText(pauseRow?.waitingFor ?? null)}
    </Chip>
  ) : null;
  const hasChips = stageChip || prBadge || alertChip || pointChip;
  const heading = task ? (
    <Link to={withCardSize(`/p/${key}/tasks/${task.key}`, 'large')} className={styles.titleLink}>
      {title}
    </Link>
  ) : (
    title
  );

  return (
    <div className={styles.header}>
      {isMobile ? (
        <div className={styles.phoneRow}>
          <Link to={backTo} onClick={goBack} className={styles.back} aria-label={t('session.back')}>
            <Icon name="chevronLeft" size={22} strokeWidth={2.2} />
          </Link>
          <div className={styles.phoneTitle}>
            <h1 className={styles.phoneHeading}>{heading}</h1>
            <div className={styles.phoneSub}>
              {memberTag}
              {liveStatus}
            </div>
          </div>
          {stopMenu}
        </div>
      ) : (
        <>
          <div className={styles.crumbRow}>
            <nav aria-label={t('session.breadcrumb')} className={styles.crumbs}>
              <Link to={`/p/${key}`} className={styles.crumbLink}>
                {t('nav.board')}
              </Link>
              <Icon name="chevronRight" size={14} strokeWidth={2} />
              {task ? (
                <Link to={`/p/${key}/tasks/${task.key}`} className={styles.crumbLink}>
                  {column?.name ?? task.key}
                </Link>
              ) : (
                <span>{memberName}</span>
              )}
            </nav>
            <span className={styles.spacer} />
            {liveStatus}
            {stopMenu}
          </div>
          <h1 className={styles.title}>{heading}</h1>
        </>
      )}
      {hasChips || (!isMobile && memberTag) ? (
        <div className={styles.chips}>
          {isMobile ? null : memberTag}
          {stageChip}
          {prBadge}
          {alertChip}
          {pointChip}
        </div>
      ) : null}
      <Dialog
        open={confirmStop}
        onClose={() => {
          if (!stop.isPending) setConfirmStop(false);
        }}
        title={t('session.stopTitle')}
        description={t('session.stopBody')}
        size="sm"
        footer={
          <>
            <Button
              variant="secondary"
              size="md"
              disabled={stop.isPending}
              onClick={() => setConfirmStop(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="dangerSolid"
              size="md"
              icon="stop"
              loading={stop.isPending}
              onClick={() =>
                stop.mutate(
                  { sessionId: session.id, ...(stopNote.trim() ? { note: stopNote.trim() } : {}) },
                  {
                    onSuccess: () => {
                      toast.show(t('session.stopped'));
                      setConfirmStop(false);
                      setStopNote('');
                    },
                  },
                )
              }
            >
              {t('session.stop')}
            </Button>
          </>
        }
      >
        {stop.isError ? (
          <ErrorBanner>{t('involvement.stopError', { reason: errorMessage(stop.error) })}</ErrorBanner>
        ) : null}
        <TextField
          label={t('involvement.stopNote')}
          hint={
            <>
              {t('involvement.stopHint')}
              {stopNote.length >= 160 ? ` ${stopNote.length}/200` : ''}
            </>
          }
          id="session-stop-note"
          autoFocus
          maxLength={200}
          value={stopNote}
          disabled={stop.isPending}
          placeholder={t('involvement.stopPlaceholder')}
          onChange={(event) => setStopNote(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !stop.isPending) {
              event.preventDefault();
              stop.mutate(
                { sessionId: session.id, ...(stopNote.trim() ? { note: stopNote.trim() } : {}) },
                {
                  onSuccess: () => {
                    toast.show(t('session.stopped'));
                    setConfirmStop(false);
                    setStopNote('');
                  },
                },
              );
            }
          }}
        />
      </Dialog>
    </div>
  );
}
